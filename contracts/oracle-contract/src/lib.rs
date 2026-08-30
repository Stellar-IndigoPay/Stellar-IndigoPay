#![no_std]
// WS2: forbid `.unwrap()` / `.expect()` in production code.
#![deny(clippy::unwrap_used)]
#![deny(clippy::expect_used)]
#![allow(deprecated)]
#[allow(unused_imports)]
//use soroban_sdk::xdr::ContractEventBody;
//use soroban_sdk::xdr::ScVal;
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, token, Address, Env, InvokeError, String, Symbol, Vec,
};

/// Maximum number of price observations retained in the circular buffer.
/// At ~5 seconds per ledger, this covers approximately 100 seconds of history.
const MAX_OBSERVATIONS: u32 = 20;
const MAX_SOURCE_ORACLES: u32 = 7;
/// Default TWAP window (in observations). Must not exceed MAX_OBSERVATIONS.
const DEFAULT_TWAP_WINDOW: u32 = 10;
/// Default staleness threshold (in ledger sequences). Aligned with MAX_OBSERVATIONS
/// to ensure the staleness check does not accept data older than the maximum TWAP
/// window could cover. At ~5s/ledger, 120 ledgers ≈ 600 seconds.
const DEFAULT_STALENESS_THRESHOLD: u32 = 120;
const PRICE_SCALE: i128 = 10_000_000;
pub const DEFAULT_UNSTAKE_COOLDOWN: u32 = 120_960;
/// Default consecutive failure threshold for source health.
const DEFAULT_FAILURE_THRESHOLD: u32 = 3;

// ─── Contract error codes ───────────────────────────────────────────────────
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum OracleError {
    // ── Initialization & admin (1–5) ────────────────────────────────────────
    ContractAlreadyInitialized = 1,
    OnlyAdminCanPerformThisAction = 2,
    OracleNotInitialized = 3,
    UnauthorizedReporterManagement = 4,
    UnauthorizedStakingConfig = 5,
    // ── Staking (6–16) ──────────────────────────────────────────────────────
    MinimumStakeMustBePositive = 6,
    UnstakeCooldownMustBePositive = 7,
    StakeAmountMustBePositive = 8,
    NotAnAuthorisedReporter = 9,
    StakingNotConfigured = 10,
    NoReporterStake = 11,
    UnstakeCooldownNotReached = 12,
    StakeCooldownNotSet = 13,
    SlashAmountMustBePositive = 14,
    SlashAmountExceedsReporterStake = 15,
    StakeTreasuryNotConfigured = 16,
    // ── Price reporting (17–25) ─────────────────────────────────────────────
    ReporterStakeBelowMinimum = 17,
    PriceMustBePositive = 18,
    FallbackPriceMustBePositive = 19,
    OracleHasNoObservationsAndNoFallback = 20,
    OraclePriceStaleAndNoFallbackConfigured = 21,
    ZeroWeightTwapFallbackRequired = 22,
    PriceDeviationExceedsThreshold = 23,
    InvalidPriceObservation = 24,
    ObservationStorageFailed = 25,
    // ── Configuration (26–32) ───────────────────────────────────────────────
    TwapWindowMustBeAtLeastOne = 26,
    TwapWindowExceedsMaximum = 27,
    TwapWindowExceedsStalenessThreshold = 28,
    StalenessThresholdMustBeAtLeastTwapWindow = 29,
    InvalidConfiguration = 30,
    ConfigurationStorageFailed = 31,
    FallbackPriceNotConfigured = 32,
    // ── Source oracles (33–42) ──────────────────────────────────────────────
    CannotRegisterOracleAsItsOwnSource = 33,
    SourceOracleLimitExceeded = 34,
    SourceOracleNotRegistered = 35,
    SourceOracleAlreadyRegistered = 36,
    InvalidSourceOracleAddress = 37,
    SourceOracleAggregationFailed = 38,
    NoSourceOraclesConfigured = 39,
    SourceOracleUnresponsive = 40,
    SourceOracleReturnedInvalidPrice = 41,
    SourceOracleReturnedUnexpectedType = 42,
    // ── Aggregation & computation (43–50) ────────────────────────────────────
    AggregationOverflow = 43,
    TwapMultiplicationOverflow = 44,
    TwapAdditionOverflow = 45,
    TotalWeightOverflow = 46,
    ObservationMissing = 47,
    UnauthorizedAggregationAccess = 48,
    MedianCalculationFailed = 49,
    AggregationResultInvalid = 50,
    // ── Health & per-token configuration (51–55) ────────────────────────────
    SourceHealthNotConfigured = 51,
    TokenNotConfigured = 52,
    DefaultTokenNotSet = 53,
    InvalidTokenAddress = 54,
    TokenDeviationExceedsMax = 55,
    // ── WS2: storage integrity (56) ─────────────────────────────────────────
    StorageMissing = 56,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceObservation {
    pub price: i128,
    pub reporter: Address,
    /// Ledger sequence when the price was recorded, used as the timestamp for TWAP.
    pub ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SlashEvent {
    pub amount: i128,
    pub reason: String,
    pub ledger: u32,
}

/// Maximum number of slash events retained per reporter.
/// Older entries are evicted in a ring-buffer fashion.
pub const MAX_SLASH_HISTORY: u32 = 20;

/// Ring-buffer pointer for per-reporter slash history.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SlashHistoryMeta {
    /// Index of the *next* write slot (wraps at MAX_SLASH_HISTORY).
    pub next_index: u32,
    /// Total events written so far (capped at MAX_SLASH_HISTORY once full).
    pub count: u32,
}

/// Health data for a source oracle.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SourceHealthData {
    pub consecutive_failures: u32,
    pub healthy: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    // Per-token observation storage
    Observations(Address, u32),
    ObservationCount(Address),
    ObservationIndex(Address),
    // Global (legacy) observation storage kept for backward compatibility during migration.
    // New contracts should use per-token variants.
    // These are kept for testing; they will be read if per-token data is missing.
    // We will not write to them in new code.
    // They are kept only for migration; we can remove them in a future version.
    #[deprecated]
    ObservationsLegacy(u32),
    #[deprecated]
    ObservationCountLegacy,
    #[deprecated]
    ObservationIndexLegacy,
    Reporter(Address),
    FallbackPrice,
    MaxPriceDeviationBps,
    TwapWindow,
    StalenessThreshold,
    SourceOracle(Address),
    SourceOracleList,
    StakeToken,
    MinStake,
    StakeTreasury,
    UnstakeCooldown,
    ReporterStake(Address),
    StakeAvailableAt(Address),
    SlashHistory(Address),
    SlashHistoryMeta(Address),
    SlashEv(Address, u32),
    // Part A – source health
    SourceHealth(Address),
    SourceFailureThreshold,
    // Part B – per-token deviation
    TokenDeviation(Address),
    // Default token for fallback when no token is specified
    DefaultToken,
}

#[contract]
pub struct SimpleOracle;

// ─── WS7: typed contract events ─────────────────────────────────────────────
// Migrated from `env.events().publish(...)` to `#[contractevent]` structs. The
// emitted topic list and data payload are byte-for-byte identical to the legacy
// emit sites they replace, so indexers observe an unchanged stream.

#[contractevent(topics = ["rep_add"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepAdded {
    #[topic]
    pub admin: Address,
    pub reporter: Address,
}

#[contractevent(topics = ["rep_rem"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepRemoved {
    #[topic]
    pub admin: Address,
    pub reporter: Address,
}

#[contractevent(topics = ["stake_dep"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakeDeposited {
    #[topic]
    pub reporter: Address,
    pub amount: i128,
    pub updated: i128,
    pub available_at: u32,
}

#[contractevent(topics = ["stake_wdr"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakeWithdrawn {
    #[topic]
    pub reporter: Address,
    pub amount: i128,
}

#[contractevent(topics = ["stake_slash"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakeSlashed {
    #[topic]
    pub reporter: Address,
    pub amount: i128,
    pub remaining: i128,
    pub reason: String,
}

#[contractevent(topics = ["price_rejected"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceRejected {
    #[topic]
    pub reporter: Address,
    pub price: i128,
    pub current_price: i128,
    pub deviation_bps: u32,
}

#[contractevent(topics = ["price_upd"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceUpdated {
    #[topic]
    pub reporter: Address,
    pub price: i128,
    pub ledger: u32,
    pub token: Address,
}

#[contractevent(topics = ["twap_win"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TwapWindowSet {
    #[topic]
    pub admin: Address,
    pub window: u32,
}

#[contractevent(topics = ["stale_th"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StalenessThresholdSet {
    #[topic]
    pub admin: Address,
    pub threshold: u32,
}

#[contractevent(topics = ["src_unhealthy"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceUnhealthy {
    #[topic]
    pub source: Address,
    pub consecutive_failures: u32,
}

#[contractevent(topics = ["src_recover"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceRecovered {
    #[topic]
    pub source: Address,
}

fn require_admin(env: &Env, admin: &Address) {
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing));
    if stored_admin != *admin {
        panic_with_error!(env, OracleError::OnlyAdminCanPerformThisAction);
    }
}

/// Computes the absolute deviation between `new_price` and `current_price`
/// in basis points (1 bps = 0.01%): `|new_price - current_price| * 10_000
/// / current_price`.
///
/// Pure integer arithmetic, panic-free for any `i128` input pair — every
/// overflow or non-positive-baseline case saturates to `u32::MAX` ("treat
/// as exceeding any configured threshold") rather than panicking, since
/// this helper also backs the deviation check inside `report_price`, where
/// a malformed comparison must never itself become a way to brick the
/// contract.
fn calculate_deviation_bps(new_price: i128, current_price: i128) -> u32 {
    if current_price <= 0 {
        return u32::MAX;
    }
    let diff = new_price
        .checked_sub(current_price)
        .and_then(i128::checked_abs)
        .unwrap_or(i128::MAX);
    match diff
        .checked_mul(10_000)
        .and_then(|scaled| scaled.checked_div(current_price))
    {
        Some(bps) => u32::try_from(bps).unwrap_or(u32::MAX),
        None => u32::MAX,
    }
}

fn read_twap_window(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::TwapWindow)
        .unwrap_or(DEFAULT_TWAP_WINDOW)
}

fn read_staleness_threshold(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::StalenessThreshold)
        .unwrap_or(DEFAULT_STALENESS_THRESHOLD)
}

// ─── Per-token observation helpers ──────────────────────────────────────────

fn read_observation_count(env: &Env, token: &Address) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::ObservationCount(token.clone()))
        .unwrap_or(0)
}

fn write_observation_count(env: &Env, token: &Address, count: u32) {
    env.storage()
        .instance()
        .set(&DataKey::ObservationCount(token.clone()), &count);
}

fn read_observation_index(env: &Env, token: &Address) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::ObservationIndex(token.clone()))
        .unwrap_or(0)
}

fn write_observation_index(env: &Env, token: &Address, index: u32) {
    env.storage()
        .instance()
        .set(&DataKey::ObservationIndex(token.clone()), &index);
}

fn read_observation(env: &Env, token: &Address, index: u32) -> PriceObservation {
    env.storage()
        .instance()
        .get(&DataKey::Observations(token.clone(), index))
        .unwrap_or_else(|| panic_with_error!(env, OracleError::ObservationMissing))
}

fn write_observation(env: &Env, token: &Address, index: u32, obs: &PriceObservation) {
    env.storage()
        .instance()
        .set(&DataKey::Observations(token.clone(), index), obs);
}

/// Get the default token address for fallback.
fn default_token(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::DefaultToken)
        .unwrap_or_else(|| panic_with_error!(env, OracleError::DefaultTokenNotSet))
}

/// Legacy helpers to read from global storage if per-token is absent.
/// Used only for backward compatibility in tests.
#[cfg(test)]
#[allow(deprecated)]
fn read_observation_count_legacy(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::ObservationCountLegacy)
        .unwrap_or(0)
}

#[cfg(test)]
#[allow(deprecated)]
fn read_observation_index_legacy(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::ObservationIndexLegacy)
        .unwrap_or(0)
}

#[cfg(test)]
#[allow(deprecated)]
fn read_observation_legacy(env: &Env, index: u32) -> PriceObservation {
    env.storage()
        .instance()
        .get(&DataKey::ObservationsLegacy(index))
        .expect("Oracle observation missing")
}

/// Time-weighted current price for a given token. Returns `None` if no
/// reliable baseline exists (no observations, stale, or zero weight).
fn current_price_raw(env: &Env, token: &Address) -> Option<i128> {
    let count = read_observation_count(env, token);
    if count == 0 {
        return None;
    }

    let next_index = read_observation_index(env, token);
    let current_ledger = env.ledger().sequence();

    let latest_index = (next_index + MAX_OBSERVATIONS - 1) % MAX_OBSERVATIONS;
    let latest = read_observation(env, token, latest_index);

    if current_ledger.saturating_sub(latest.ledger) > read_staleness_threshold(env) {
        return None;
    }

    let window = read_twap_window(env).min(count);
    let mut observations = Vec::new(env);
    let start_offset = (next_index + MAX_OBSERVATIONS - window) % MAX_OBSERVATIONS;
    for i in 0..window {
        let index = (start_offset + i) % MAX_OBSERVATIONS;
        let obs = read_observation(env, token, index);
        observations.push_back(obs);
    }

    let mut weighted_sum = 0_i128;
    let mut total_weight = 0_i128;
    for i in 0..window {
        let obs = observations
            .get(i)
            .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing));
        let next_ledger = if i + 1 < window {
            observations
                .get(i + 1)
                .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing))
                .ledger
        } else {
            current_ledger
        };
        let mut weight = next_ledger.saturating_sub(obs.ledger) as i128;
        if weight == 0 {
            weight = 1;
        }
        weighted_sum = weighted_sum
            .checked_add(
                obs.price
                    .checked_mul(weight)
                    .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing)),
            )
            .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing));
        total_weight = total_weight
            .checked_add(weight)
            .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing));
    }

    if total_weight == 0 {
        return None;
    }

    Some(weighted_sum / total_weight)
}

/// Computes the TWAP price for a given token, falling back to fallback price
/// if stale or no observations.
fn internal_price(env: &Env, token: &Address) -> i128 {
    let count = read_observation_count(env, token);
    if count == 0 {
        return env
            .storage()
            .instance()
            .get(&DataKey::FallbackPrice)
            .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing));
    }

    let next_index = read_observation_index(env, token);
    let current_ledger = env.ledger().sequence();

    let latest_index = (next_index + MAX_OBSERVATIONS - 1) % MAX_OBSERVATIONS;
    let latest = read_observation(env, token, latest_index);

    if current_ledger.saturating_sub(latest.ledger) > read_staleness_threshold(env) {
        return env
            .storage()
            .instance()
            .get(&DataKey::FallbackPrice)
            .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing));
    }

    let window = read_twap_window(env).min(count);
    let mut observations = Vec::new(env);
    let start_offset = (next_index + MAX_OBSERVATIONS - window) % MAX_OBSERVATIONS;
    for i in 0..window {
        let index = (start_offset + i) % MAX_OBSERVATIONS;
        let obs = read_observation(env, token, index);
        observations.push_back(obs);
    }

    let mut weighted_sum = 0_i128;
    let mut total_weight = 0_i128;

    for i in 0..window {
        let obs = observations
            .get(i)
            .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing));
        let next_ledger = if i + 1 < window {
            observations
                .get(i + 1)
                .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing))
                .ledger
        } else {
            current_ledger
        };
        let mut weight = next_ledger.saturating_sub(obs.ledger) as i128;
        if weight == 0 {
            weight = 1;
        }
        weighted_sum = weighted_sum
            .checked_add(
                obs.price
                    .checked_mul(weight)
                    .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing)),
            )
            .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing));
        total_weight = total_weight
            .checked_add(weight)
            .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing));
    }

    if total_weight == 0 {
        return env
            .storage()
            .instance()
            .get(&DataKey::FallbackPrice)
            .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing));
    }

    weighted_sum / (total_weight * PRICE_SCALE)
}

// ─── Source health helpers ──────────────────────────────────────────────────

fn read_source_health(env: &Env, source: &Address) -> SourceHealthData {
    env.storage()
        .instance()
        .get(&DataKey::SourceHealth(source.clone()))
        .unwrap_or(SourceHealthData {
            consecutive_failures: 0,
            healthy: true,
        })
}

fn write_source_health(env: &Env, source: &Address, data: &SourceHealthData) {
    env.storage()
        .instance()
        .set(&DataKey::SourceHealth(source.clone()), data);
}

fn read_failure_threshold(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::SourceFailureThreshold)
        .unwrap_or(DEFAULT_FAILURE_THRESHOLD)
}

// ─── Per-token deviation threshold ─────────────────────────────────────────

fn read_token_deviation(env: &Env, token: &Address) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::TokenDeviation(token.clone()))
        .unwrap_or(0)
}

#[contractimpl]
impl SimpleOracle {
    /// Number of distinct semantic event topics this contract can emit (WS7).
    /// Keep in sync with the `event_catalog.json` golden file.
    pub fn event_count(_env: Env) -> u32 {
        11
    }

    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, OracleError::ContractAlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        // Set default token to a placeholder; must be overridden by admin.
        // For backward compatibility, we also set legacy keys.
        #[allow(deprecated)]
        {
            env.storage()
                .instance()
                .set(&DataKey::ObservationCountLegacy, &0_u32);
            env.storage()
                .instance()
                .set(&DataKey::ObservationIndexLegacy, &0_u32);
        }
        env.storage()
            .instance()
            .set(&DataKey::TwapWindow, &DEFAULT_TWAP_WINDOW);
        env.storage()
            .instance()
            .set(&DataKey::StalenessThreshold, &DEFAULT_STALENESS_THRESHOLD);
    }

    pub fn set_default_token(env: Env, admin: Address, token: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        env.storage().instance().set(&DataKey::DefaultToken, &token);
    }

    pub fn get_default_token(env: Env) -> Address {
        default_token(&env)
    }

    pub fn add_reporter(env: Env, admin: Address, reporter: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Reporter(reporter.clone()), &true);
        RepAdded { admin, reporter }.publish(&env);
    }

    pub fn remove_reporter(env: Env, admin: Address, reporter: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        env.storage()
            .instance()
            .remove(&DataKey::Reporter(reporter.clone()));
        RepRemoved { admin, reporter }.publish(&env);
    }

    /// Configure the asset, minimum stake, slash treasury, and unstake
    /// cooldown. Existing stake balances are never modified by reconfiguration.
    pub fn configure_staking(
        env: Env,
        admin: Address,
        stake_token: Address,
        min_stake: i128,
        treasury: Address,
        unstake_cooldown: u32,
    ) {
        admin.require_auth();
        require_admin(&env, &admin);
        if min_stake <= 0 {
            panic_with_error!(&env, OracleError::MinimumStakeMustBePositive);
        }
        if unstake_cooldown == 0 {
            panic_with_error!(&env, OracleError::UnstakeCooldownMustBePositive);
        }
        env.storage()
            .instance()
            .set(&DataKey::StakeToken, &stake_token);
        env.storage().instance().set(&DataKey::MinStake, &min_stake);
        env.storage()
            .instance()
            .set(&DataKey::StakeTreasury, &treasury);
        env.storage()
            .instance()
            .set(&DataKey::UnstakeCooldown, &unstake_cooldown);
    }

    /// Deposit reporter stake. Effects are persisted before the token transfer;
    /// a failed transfer reverts the entire Soroban invocation.
    pub fn stake(env: Env, reporter: Address, amount: i128) {
        reporter.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, OracleError::StakeAmountMustBePositive);
        }
        let is_reporter: bool = env
            .storage()
            .instance()
            .get(&DataKey::Reporter(reporter.clone()))
            .unwrap_or(false);
        if !is_reporter {
            panic_with_error!(&env, OracleError::NotAnAuthorisedReporter);
        }
        let stake_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::StakeToken)
            .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing));
        let current: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ReporterStake(reporter.clone()))
            .unwrap_or(0);
        let updated = current
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(&env, OracleError::AggregationOverflow));
        let available_at = if current == 0 {
            let cooldown: u32 = env
                .storage()
                .instance()
                .get(&DataKey::UnstakeCooldown)
                .unwrap_or(DEFAULT_UNSTAKE_COOLDOWN);
            env.ledger()
                .sequence()
                .checked_add(cooldown)
                .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing))
        } else {
            env.storage()
                .instance()
                .get(&DataKey::StakeAvailableAt(reporter.clone()))
                .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing))
        };

        env.storage()
            .instance()
            .set(&DataKey::ReporterStake(reporter.clone()), &updated);
        env.storage()
            .instance()
            .set(&DataKey::StakeAvailableAt(reporter.clone()), &available_at);
        StakeDeposited {
            reporter: reporter.clone(),
            amount,
            updated,
            available_at,
        }
        .publish(&env);

        token::Client::new(&env, &stake_token).transfer(
            &reporter,
            env.current_contract_address(),
            &amount,
        );
    }

    /// Withdraw the reporter's entire remaining stake after its cooldown.
    pub fn unstake(env: Env, reporter: Address) {
        reporter.require_auth();
        let amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ReporterStake(reporter.clone()))
            .unwrap_or(0);
        if amount <= 0 {
            panic_with_error!(&env, OracleError::NoReporterStake);
        }
        let available_at: u32 = env
            .storage()
            .instance()
            .get(&DataKey::StakeAvailableAt(reporter.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing));
        if env.ledger().sequence() < available_at {
            panic_with_error!(&env, OracleError::UnstakeCooldownNotReached);
        }
        let stake_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::StakeToken)
            .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing));

        env.storage()
            .instance()
            .set(&DataKey::ReporterStake(reporter.clone()), &0_i128);
        env.storage()
            .instance()
            .remove(&DataKey::StakeAvailableAt(reporter.clone()));
        StakeWithdrawn {
            reporter: reporter.clone(),
            amount,
        }
        .publish(&env);

        token::Client::new(&env, &stake_token).transfer(
            &env.current_contract_address(),
            &reporter,
            &amount,
        );
    }

    /// Slash reporter stake and transfer the slashed amount to the configured
    /// treasury. Slash history is append-only and publicly queryable.
    pub fn slash(env: Env, admin: Address, reporter: Address, amount: i128, reason: String) {
        admin.require_auth();
        require_admin(&env, &admin);
        if amount <= 0 {
            panic_with_error!(&env, OracleError::SlashAmountMustBePositive);
        }
        let current: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ReporterStake(reporter.clone()))
            .unwrap_or(0);
        if amount > current {
            panic_with_error!(&env, OracleError::SlashAmountExceedsReporterStake);
        }
        let remaining = current
            .checked_sub(amount)
            .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing));
        let stake_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::StakeToken)
            .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing));
        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::StakeTreasury)
            .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing));
        let meta_key = DataKey::SlashHistoryMeta(reporter.clone());
        let mut meta: SlashHistoryMeta =
            env.storage()
                .instance()
                .get(&meta_key)
                .unwrap_or(SlashHistoryMeta {
                    next_index: 0,
                    count: 0,
                });

        let slot = meta.next_index;
        let event = SlashEvent {
            amount,
            reason: reason.clone(),
            ledger: env.ledger().sequence(),
        };

        env.storage()
            .instance()
            .set(&DataKey::SlashEv(reporter.clone(), slot), &event);
        meta.count = (meta.count + 1).min(MAX_SLASH_HISTORY);
        meta.next_index = (slot + 1) % MAX_SLASH_HISTORY;
        env.storage().instance().set(&meta_key, &meta);

        env.storage()
            .instance()
            .set(&DataKey::ReporterStake(reporter.clone()), &remaining);
        StakeSlashed {
            reporter,
            amount,
            remaining,
            reason,
        }
        .publish(&env);

        token::Client::new(&env, &stake_token).transfer(
            &env.current_contract_address(),
            &treasury,
            &amount,
        );
    }

    pub fn get_reporter_stake(env: Env, reporter: Address) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::ReporterStake(reporter))
            .unwrap_or(0)
    }

    pub fn get_slash_history(env: Env, reporter: Address) -> Vec<SlashEvent> {
        let meta: SlashHistoryMeta = env
            .storage()
            .instance()
            .get(&DataKey::SlashHistoryMeta(reporter.clone()))
            .unwrap_or(SlashHistoryMeta {
                next_index: 0,
                count: 0,
            });
        if meta.count == 0 {
            return Vec::new(&env);
        }
        let mut result = Vec::new(&env);
        let start = if meta.count < MAX_SLASH_HISTORY {
            0
        } else {
            meta.next_index
        };
        for i in 0..meta.count {
            let slot = (start + i) % MAX_SLASH_HISTORY;
            if let Some(event) = env
                .storage()
                .instance()
                .get::<DataKey, SlashEvent>(&DataKey::SlashEv(reporter.clone(), slot))
            {
                result.push_back(event);
            }
        }
        result
    }

    /// Returns the number of slash events currently stored for a reporter.
    /// Capped at [`MAX_SLASH_HISTORY`].
    pub fn get_slash_count(env: Env, reporter: Address) -> u32 {
        let meta: SlashHistoryMeta = env
            .storage()
            .instance()
            .get(&DataKey::SlashHistoryMeta(reporter))
            .unwrap_or(SlashHistoryMeta {
                next_index: 0,
                count: 0,
            });
        meta.count
    }

    /// Returns the slash event stored at a specific ring-buffer slot for a reporter.
    /// Panics if the slot has never been written.
    pub fn get_slash_event_at(env: Env, reporter: Address, index: u32) -> SlashEvent {
        assert!(index < MAX_SLASH_HISTORY, "Slash event index out of bounds");
        env.storage()
            .instance()
            .get(&DataKey::SlashEv(reporter, index))
            .unwrap_or_else(|| panic_with_error!(&env, OracleError::StorageMissing))
    }

    pub fn add_source_oracle(env: Env, admin: Address, oracle_address: Address) {
        admin.require_auth();
        require_admin(&env, &admin);

        let source_key = DataKey::SourceOracle(oracle_address.clone());
        let is_registered: bool = env.storage().instance().get(&source_key).unwrap_or(false);
        if is_registered {
            return;
        }
        if oracle_address == env.current_contract_address() {
            panic_with_error!(&env, OracleError::CannotRegisterOracleAsItsOwnSource);
        }

        let mut sources: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::SourceOracleList)
            .unwrap_or(Vec::new(&env));
        if sources.len() >= MAX_SOURCE_ORACLES {
            panic_with_error!(&env, OracleError::SourceOracleLimitExceeded);
        }

        env.storage().instance().set(&source_key, &true);
        sources.push_back(oracle_address);
        env.storage()
            .instance()
            .set(&DataKey::SourceOracleList, &sources);
    }

    pub fn remove_source_oracle(env: Env, admin: Address, oracle_address: Address) {
        admin.require_auth();
        require_admin(&env, &admin);

        let source_key = DataKey::SourceOracle(oracle_address.clone());
        let is_registered: bool = env.storage().instance().get(&source_key).unwrap_or(false);
        if !is_registered {
            return;
        }

        env.storage().instance().remove(&source_key);
        let mut sources: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::SourceOracleList)
            .unwrap_or(Vec::new(&env));
        if let Some(index) = sources.first_index_of(&oracle_address) {
            sources.remove(index);
        }
        env.storage()
            .instance()
            .set(&DataKey::SourceOracleList, &sources);
    }

    // ─── Report price (per token) ───────────────────────────────────────────

    pub fn report_price(env: Env, reporter: Address, token: Address, price: i128) {
        reporter.require_auth();

        let is_reporter: bool = env
            .storage()
            .instance()
            .get(&DataKey::Reporter(reporter.clone()))
            .unwrap_or(false);
        if !is_reporter {
            panic_with_error!(&env, OracleError::NotAnAuthorisedReporter);
        }
        let min_stake: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MinStake)
            .unwrap_or(0);
        let reporter_stake: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ReporterStake(reporter.clone()))
            .unwrap_or(0);
        if reporter_stake < min_stake {
            panic_with_error!(&env, OracleError::ReporterStakeBelowMinimum);
        }
        if price <= 0 {
            panic_with_error!(&env, OracleError::PriceMustBePositive);
        }

        let count = read_observation_count(&env, &token);

        // Price deviation circuit breaker with per-token threshold.
        let token_deviation = read_token_deviation(&env, &token);
        let global_deviation: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxPriceDeviationBps)
            .unwrap_or(0);
        let max_deviation_bps = if token_deviation > 0 {
            token_deviation
        } else {
            global_deviation
        };

        if max_deviation_bps > 0 && count >= 2 {
            if let Some(current_price) = current_price_raw(&env, &token) {
                let deviation_bps = calculate_deviation_bps(price, current_price);
                if deviation_bps > max_deviation_bps {
                    PriceRejected {
                        reporter: reporter.clone(),
                        price,
                        current_price,
                        deviation_bps,
                    }
                    .publish(&env);
                    return;
                }
            }
        }

        let index = read_observation_index(&env, &token);
        let observation = PriceObservation {
            price,
            reporter: reporter.clone(),
            ledger: env.ledger().sequence(),
        };

        write_observation(&env, &token, index, &observation);
        write_observation_count(&env, &token, (count + 1).min(MAX_OBSERVATIONS));
        write_observation_index(&env, &token, (index + 1) % MAX_OBSERVATIONS);
        PriceUpdated {
            reporter,
            price,
            ledger: env.ledger().sequence(),
            token,
        }
        .publish(&env);
    }

    pub fn set_fallback_price(env: Env, admin: Address, price: i128) {
        admin.require_auth();
        require_admin(&env, &admin);
        if price <= 0 {
            panic_with_error!(&env, OracleError::FallbackPriceMustBePositive);
        }
        env.storage()
            .instance()
            .set(&DataKey::FallbackPrice, &price);
    }

    /// Configures the global price deviation circuit breaker threshold, in basis
    /// points (e.g. 500 = 5%). A value of 0 disables the check entirely,
    /// preserving the pre-circuit-breaker behaviour.
    pub fn set_max_price_deviation(env: Env, admin: Address, deviation_bps: u32) {
        admin.require_auth();
        require_admin(&env, &admin);
        env.storage()
            .instance()
            .set(&DataKey::MaxPriceDeviationBps, &deviation_bps);
    }

    /// Part B – set per-token deviation threshold.
    pub fn set_token_deviation(env: Env, admin: Address, token: Address, deviation_bps: u32) {
        admin.require_auth();
        require_admin(&env, &admin);
        if deviation_bps > 10_000 {
            panic_with_error!(&env, OracleError::TokenDeviationExceedsMax);
        }
        env.storage()
            .instance()
            .set(&DataKey::TokenDeviation(token), &deviation_bps);
    }

    /// Part B – get per-token deviation threshold (0 if unset).
    pub fn get_token_deviation(env: Env, token: Address) -> u32 {
        read_token_deviation(&env, &token)
    }

    pub fn set_twap_window(env: Env, admin: Address, window: u32) {
        admin.require_auth();
        require_admin(&env, &admin);
        if window == 0 {
            panic_with_error!(&env, OracleError::TwapWindowMustBeAtLeastOne);
        }
        if window > MAX_OBSERVATIONS {
            panic_with_error!(&env, OracleError::TwapWindowExceedsMaximum);
        }
        if window > read_staleness_threshold(&env) {
            panic_with_error!(&env, OracleError::TwapWindowExceedsStalenessThreshold);
        }
        env.storage().instance().set(&DataKey::TwapWindow, &window);
        TwapWindowSet { admin, window }.publish(&env);
    }

    pub fn set_staleness_threshold(env: Env, admin: Address, threshold: u32) {
        admin.require_auth();
        require_admin(&env, &admin);
        if threshold < read_twap_window(&env) {
            panic_with_error!(&env, OracleError::StalenessThresholdMustBeAtLeastTwapWindow);
        }
        if threshold < MAX_OBSERVATIONS {
            panic_with_error!(&env, OracleError::InvalidConfiguration);
        }
        env.storage()
            .instance()
            .set(&DataKey::StalenessThreshold, &threshold);
        StalenessThresholdSet { admin, threshold }.publish(&env);
    }

    pub fn get_twap_window(env: Env) -> u32 {
        read_twap_window(&env)
    }

    pub fn get_staleness_threshold(env: Env) -> u32 {
        read_staleness_threshold(&env)
    }

    /// Compute the Time-Weighted Average Price (TWAP) for a given token.
    pub fn get_price(env: Env, token: Address) -> i128 {
        internal_price(&env, &token)
    }

    /// Backward-compatible get_price that uses the default token.
    pub fn get_price_default(env: Env) -> i128 {
        let token = default_token(&env);
        internal_price(&env, &token)
    }

    /// Part A – set source failure threshold.
    pub fn set_source_failure_threshold(env: Env, admin: Address, threshold: u32) {
        admin.require_auth();
        require_admin(&env, &admin);
        env.storage()
            .instance()
            .set(&DataKey::SourceFailureThreshold, &threshold);
    }

    /// Part A – get source health.
    pub fn get_source_health(env: Env, source: Address) -> SourceHealthData {
        read_source_health(&env, &source)
    }

    /// Aggregated price with source health tracking.
    pub fn get_aggregated_price(env: Env) -> i128 {
        let sources: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::SourceOracleList)
            .unwrap_or(Vec::new(&env));
        if sources.is_empty() {
            let token = default_token(&env);
            return internal_price(&env, &token);
        }

        let threshold = read_failure_threshold(&env);
        let mut prices: Vec<i128> = Vec::new(&env);

        for source in sources.iter() {
            let mut health = read_source_health(&env, &source);

            // Query every source, including unhealthy ones, so they can recover.
            let result = env.try_invoke_contract::<i128, InvokeError>(
                &source,
                &symbol_short!("get_price"),
                Vec::new(&env),
            );

            match result {
                Ok(Ok(price)) => {
                    if price > 0 {
                        prices.push_back(price);
                        // Recovery: reset failures and mark healthy.
                        if !health.healthy || health.consecutive_failures > 0 {
                            health.consecutive_failures = 0;
                            health.healthy = true;
                            write_source_health(&env, &source, &health);
                            SourceRecovered {
                                source: source.clone(),
                            }
                            .publish(&env);
                        }
                    } else {
                        // Zero or negative price counts as failure
                        health.consecutive_failures += 1;
                        if health.consecutive_failures >= threshold && health.healthy {
                            health.healthy = false;
                            SourceUnhealthy {
                                source: source.clone(),
                                consecutive_failures: health.consecutive_failures,
                            }
                            .publish(&env);
                        }
                        write_source_health(&env, &source, &health);
                    }
                }
                Ok(Err(_)) | Err(_) => {
                    // Failure
                    health.consecutive_failures += 1;
                    if health.consecutive_failures >= threshold && health.healthy {
                        health.healthy = false;
                        SourceUnhealthy {
                            source: source.clone(),
                            consecutive_failures: health.consecutive_failures,
                        }
                        .publish(&env);
                    }
                    write_source_health(&env, &source, &health);
                }
            }
        }

        if prices.is_empty() {
            let token = default_token(&env);
            return internal_price(&env, &token);
        }

        // Sort (insertion sort for small lists)
        for i in 1..prices.len() {
            let price = prices.get_unchecked(i);
            let mut j = i;
            while j > 0 && prices.get_unchecked(j - 1) > price {
                let previous = prices.get_unchecked(j - 1);
                prices.set(j, previous);
                j -= 1;
            }
            prices.set(j, price);
        }

        let middle = prices.len() / 2;
        if prices.len().is_multiple_of(2) {
            let lower = prices.get_unchecked(middle - 1);
            let upper = prices.get_unchecked(middle);
            lower + (upper - lower) / 2
        } else {
            prices.get_unchecked(middle)
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    extern crate std;

    use super::*;
    use soroban_sdk::{
        contracterror,
        panic_with_error,
        testutils::{Address as _, Events as _, Ledger},
        token::StellarAssetClient,
        //xdr::{ContractEvent, ContractEventBody, ScVal},
        Env,
        IntoVal,
    };

    const TEST_PRICE_KEY: Symbol = symbol_short!("price");

    fn event_with_topic_exists(env: &Env, topic_symbol: &str) -> bool {
        use soroban_sdk::testutils::Events;
        use soroban_sdk::xdr::{ContractEventBody, ScVal};

        for event in env.events().all().events() {
            if let ContractEventBody::V0(body) = &event.body {
                for topic in body.topics.iter() {
                    if let ScVal::Symbol(sym) = topic {
                        if sym.0.as_slice() == topic_symbol.as_bytes() {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    // Generate a deterministic "default" token for tests.
    fn default_test_token(env: &Env) -> Address {
        Address::from_string(&String::from_str(
            env,
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        ))
    }

    #[contract]
    struct TestPriceSource;

    #[contractimpl]
    impl TestPriceSource {
        pub fn set_price(env: Env, price: i128) {
            env.storage().instance().set(&TEST_PRICE_KEY, &price);
        }

        pub fn get_price(env: Env) -> i128 {
            env.storage().instance().get(&TEST_PRICE_KEY).unwrap()
        }
    }

    #[contract]
    struct PanickingPriceSource;

    #[contractimpl]
    impl PanickingPriceSource {
        pub fn get_price(_env: Env) -> i128 {
            panic!("source unavailable");
        }
    }

    #[contracterror]
    #[derive(Copy, Clone, Debug, Eq, PartialEq)]
    enum TestSourceError {
        Unavailable = 1,
    }

    #[contract]
    struct ErrorPriceSource;

    #[contractimpl]
    impl ErrorPriceSource {
        pub fn get_price(env: Env) -> i128 {
            panic_with_error!(&env, TestSourceError::Unavailable);
        }
    }

    #[contract]
    struct IncompatiblePriceSource;

    #[contractimpl]
    impl IncompatiblePriceSource {
        pub fn get_price(_env: Env) -> u32 {
            42
        }
    }

    fn setup() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(SimpleOracle, ());
        let admin = Address::generate(&env);
        let reporter = Address::generate(&env);
        let client = SimpleOracleClient::new(&env, &contract_id);
        client.initialize(&admin);
        // Set default token for tests.
        let default_token = default_test_token(&env);
        client.set_default_token(&admin, &default_token);
        (env, contract_id, admin, reporter)
    }

    fn add_reporter(env: &Env, contract_id: &Address, admin: &Address, reporter: &Address) {
        SimpleOracleClient::new(env, contract_id).add_reporter(admin, reporter);
    }

    fn setup_staking(
        env: &Env,
        contract_id: &Address,
        admin: &Address,
        reporter: &Address,
        min_stake: i128,
        cooldown: u32,
    ) -> (Address, Address) {
        let token_admin = Address::generate(env);
        let stake_token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let treasury = Address::generate(env);
        StellarAssetClient::new(env, &stake_token).mint(reporter, &(min_stake * 3));
        let client = SimpleOracleClient::new(env, contract_id);
        client.add_reporter(admin, reporter);
        client.configure_staking(admin, &stake_token, &min_stake, &treasury, &cooldown);
        (stake_token, treasury)
    }

    fn register_price_source(env: &Env, price: i128) -> Address {
        let source = env.register(TestPriceSource, ());
        TestPriceSourceClient::new(env, &source).set_price(&price);
        source
    }

    fn source_list(env: &Env, contract_id: &Address) -> Vec<Address> {
        env.as_contract(contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::SourceOracleList)
                .unwrap_or(Vec::new(env))
        })
    }

    fn is_source_registered(env: &Env, contract_id: &Address, source: &Address) -> bool {
        env.as_contract(contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::SourceOracle(source.clone()))
                .unwrap_or(false)
        })
    }

    #[test]
    fn test_add_remove_source() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        let first = Address::generate(&env);
        let second = Address::generate(&env);

        client.add_source_oracle(&admin, &first);
        client.add_source_oracle(&admin, &second);
        client.add_source_oracle(&admin, &first);

        assert_eq!(
            source_list(&env, &contract_id),
            soroban_sdk::vec![&env, first.clone(), second.clone()]
        );
        assert!(is_source_registered(&env, &contract_id, &first));
        assert!(is_source_registered(&env, &contract_id, &second));

        client.remove_source_oracle(&admin, &first);
        client.remove_source_oracle(&admin, &first);
        client.remove_source_oracle(&admin, &Address::generate(&env));

        assert_eq!(
            source_list(&env, &contract_id),
            soroban_sdk::vec![&env, second.clone()]
        );
        assert!(!is_source_registered(&env, &contract_id, &first));
        assert!(is_source_registered(&env, &contract_id, &second));
    }

    #[test]
    fn test_source_limit_enforced() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        let mut sources = Vec::new(&env);

        for _ in 0..MAX_SOURCE_ORACLES {
            let source = Address::generate(&env);
            client.add_source_oracle(&admin, &source);
            sources.push_back(source);
        }
        assert_eq!(source_list(&env, &contract_id).len(), MAX_SOURCE_ORACLES);

        let existing = sources.first().unwrap();
        assert!(client.try_add_source_oracle(&admin, &existing).is_ok());
        assert_eq!(source_list(&env, &contract_id).len(), MAX_SOURCE_ORACLES);

        let eighth = Address::generate(&env);
        assert!(client.try_add_source_oracle(&admin, &eighth).is_err());
        assert!(!is_source_registered(&env, &contract_id, &eighth));
        assert_eq!(source_list(&env, &contract_id).len(), MAX_SOURCE_ORACLES);

        client.remove_source_oracle(&admin, &existing);
        client.add_source_oracle(&admin, &eighth);
        assert_eq!(source_list(&env, &contract_id).len(), MAX_SOURCE_ORACLES);
        assert!(is_source_registered(&env, &contract_id, &eighth));
    }

    #[test]
    fn unauthorized_source_management_does_not_mutate_state() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        let non_admin = Address::generate(&env);
        let source = Address::generate(&env);

        assert!(client.try_add_source_oracle(&non_admin, &source).is_err());
        assert!(source_list(&env, &contract_id).is_empty());
        assert!(!is_source_registered(&env, &contract_id, &source));

        client.add_source_oracle(&admin, &source);
        assert!(client
            .try_remove_source_oracle(&non_admin, &source)
            .is_err());
        assert_eq!(
            source_list(&env, &contract_id),
            soroban_sdk::vec![&env, source.clone()]
        );
        assert!(is_source_registered(&env, &contract_id, &source));
    }

    #[test]
    fn direct_self_registration_is_rejected() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);

        assert!(client.try_add_source_oracle(&admin, &contract_id).is_err());
        assert!(source_list(&env, &contract_id).is_empty());
        assert!(!is_source_registered(&env, &contract_id, &contract_id));
    }

    #[test]
    fn test_aggregate_single_source() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        let source = register_price_source(&env, 17);
        client.add_source_oracle(&admin, &source);

        assert_eq!(client.get_aggregated_price(), 17);
    }

    #[test]
    fn test_aggregate_multiple_sources_median() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        let high = register_price_source(&env, 30);
        let low = register_price_source(&env, 10);
        let middle = register_price_source(&env, 20);

        client.add_source_oracle(&admin, &high);
        client.add_source_oracle(&admin, &low);
        client.add_source_oracle(&admin, &middle);

        assert_eq!(client.get_aggregated_price(), 20);
    }

    #[test]
    fn even_source_median_is_overflow_safe() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        let lower = register_price_source(&env, i128::MAX - 2);
        let upper = register_price_source(&env, i128::MAX);
        client.add_source_oracle(&admin, &upper);
        client.add_source_oracle(&admin, &lower);

        assert_eq!(client.get_aggregated_price(), i128::MAX - 1);
    }

    #[test]
    fn duplicate_values_are_retained_in_median() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        for price in [9_i128, 100, 9] {
            let source = register_price_source(&env, price);
            client.add_source_oracle(&admin, &source);
        }

        assert_eq!(client.get_aggregated_price(), 9);
    }

    #[test]
    fn invalid_prices_and_failed_sources_are_skipped() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        let zero = register_price_source(&env, 0);
        let negative = register_price_source(&env, -5);
        let valid = register_price_source(&env, 25);
        let panicking = env.register(PanickingPriceSource, ());

        for source in [zero, negative, panicking, valid] {
            client.add_source_oracle(&admin, &source);
        }

        assert_eq!(client.get_aggregated_price(), 25);
    }

    #[test]
    fn test_aggregate_fallback() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        client.set_fallback_price(&admin, &7);

        assert_eq!(client.get_aggregated_price(), 7);

        let error_source = env.register(ErrorPriceSource, ());
        let incompatible_source = env.register(IncompatiblePriceSource, ());
        let missing_source = Address::generate(&env);
        client.add_source_oracle(&admin, &error_source);
        client.add_source_oracle(&admin, &incompatible_source);
        client.add_source_oracle(&admin, &missing_source);

        assert_eq!(client.get_aggregated_price(), 7);
    }

    #[test]
    fn aggregation_fallback_preserves_configured_twap_window() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.add_source_oracle(&admin, &Address::generate(&env));
        let token = default_test_token(&env);

        env.ledger().set_sequence_number(100);
        client.report_price(&reporter, &token, &100_000_000);
        env.ledger().set_sequence_number(200);
        client.report_price(&reporter, &token, &200_000_000);
        env.ledger().set_sequence_number(300);
        assert_eq!(client.get_aggregated_price(), 15);

        client.set_twap_window(&admin, &1);
        assert_eq!(client.get_aggregated_price(), 20);
        assert_eq!(client.get_price(&token), 20);
    }

    #[test]
    fn aggregation_fallback_preserves_staleness_and_fallback_price() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.add_source_oracle(&admin, &Address::generate(&env));
        client.set_fallback_price(&admin, &6);
        client.set_staleness_threshold(&admin, &MAX_OBSERVATIONS);
        let token = default_test_token(&env);

        env.ledger().set_sequence_number(100);
        client.report_price(&reporter, &token, &80_000_000);
        env.ledger().set_sequence_number(110);
        assert_eq!(client.get_aggregated_price(), 8);
        env.ledger().set_sequence_number(100 + MAX_OBSERVATIONS + 1);
        assert_eq!(client.get_aggregated_price(), 6);
        assert_eq!(client.get_price(&token), 6);
    }

    #[test]
    #[should_panic]
    fn no_observations_without_fallback_panics() {
        let (env, contract_id, _, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        let token = default_test_token(&env);
        client.get_price(&token);
    }

    #[test]
    fn no_observations_uses_fallback() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        client.set_fallback_price(&admin, &8);
        let token = default_test_token(&env);
        assert_eq!(client.get_price(&token), 8);
    }

    #[test]
    #[should_panic]
    fn initialize_only_once() {
        let (env, contract_id, admin, _) = setup();
        SimpleOracleClient::new(&env, &contract_id).initialize(&admin);
    }

    #[test]
    fn configuration_defaults_are_stored_and_returned() {
        let (env, contract_id, _, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);

        assert_eq!(client.get_twap_window(), DEFAULT_TWAP_WINDOW);
        assert_eq!(
            client.get_staleness_threshold(),
            DEFAULT_STALENESS_THRESHOLD
        );
        env.as_contract(&contract_id, || {
            assert_eq!(
                env.storage().instance().get::<_, u32>(&DataKey::TwapWindow),
                Some(DEFAULT_TWAP_WINDOW)
            );
            assert_eq!(
                env.storage()
                    .instance()
                    .get::<_, u32>(&DataKey::StalenessThreshold),
                Some(DEFAULT_STALENESS_THRESHOLD)
            );
        });
    }

    #[test]
    fn default_staleness_threshold_respects_max_observations_invariant() {
        let (env, contract_id, _, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);

        assert!(
            client.get_staleness_threshold() >= MAX_OBSERVATIONS,
            "DEFAULT_STALENESS_THRESHOLD must be >= MAX_OBSERVATIONS (invariant)"
        );
        assert!(
            client.get_twap_window() <= MAX_OBSERVATIONS,
            "DEFAULT_TWAP_WINDOW must be <= MAX_OBSERVATIONS"
        );
        assert!(
            client.get_staleness_threshold() >= client.get_twap_window(),
            "Staleness threshold must be >= TWAP window"
        );
    }

    #[test]
    fn admin_can_set_configuration() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);

        client.set_twap_window(&admin, &5);
        client.set_staleness_threshold(&admin, &100);

        assert_eq!(client.get_twap_window(), 5);
        assert_eq!(client.get_staleness_threshold(), 100);
    }

    #[test]
    fn twap_window_bounds_are_enforced() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);

        assert!(client.try_set_twap_window(&admin, &0).is_err());
        client.set_twap_window(&admin, &1);
        assert_eq!(client.get_twap_window(), 1);
        client.set_twap_window(&admin, &MAX_OBSERVATIONS);
        assert_eq!(client.get_twap_window(), MAX_OBSERVATIONS);
        assert!(client
            .try_set_twap_window(&admin, &(MAX_OBSERVATIONS + 1))
            .is_err());
    }

    #[test]
    fn staleness_threshold_bounds_are_enforced() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);

        assert!(client
            .try_set_staleness_threshold(&admin, &(MAX_OBSERVATIONS - 1))
            .is_err());
        client.set_staleness_threshold(&admin, &MAX_OBSERVATIONS);
        assert_eq!(client.get_staleness_threshold(), MAX_OBSERVATIONS);
        client.set_staleness_threshold(&admin, &u32::MAX);
        assert_eq!(client.get_staleness_threshold(), u32::MAX);
    }

    #[test]
    fn non_admin_cannot_set_configuration() {
        let (env, contract_id, _, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        let non_admin = Address::generate(&env);

        assert!(client.try_set_twap_window(&non_admin, &5).is_err());
        assert!(client
            .try_set_staleness_threshold(&non_admin, &100)
            .is_err());
        assert_eq!(client.get_twap_window(), DEFAULT_TWAP_WINDOW);
        assert_eq!(
            client.get_staleness_threshold(),
            DEFAULT_STALENESS_THRESHOLD
        );
    }

    #[test]
    fn configuration_setters_emit_events() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);

        client.set_twap_window(&admin, &5);
        assert_eq!(
            env.events().all().filter_by_contract(&contract_id),
            soroban_sdk::vec![
                &env,
                (
                    contract_id.clone(),
                    (symbol_short!("twap_win"), admin.clone()).into_val(&env),
                    5_u32.into_val(&env),
                )
            ]
        );

        client.set_staleness_threshold(&admin, &100);
        assert_eq!(
            env.events().all().filter_by_contract(&contract_id),
            soroban_sdk::vec![
                &env,
                (
                    contract_id.clone(),
                    (symbol_short!("stale_th"), admin).into_val(&env),
                    100_u32.into_val(&env),
                )
            ]
        );
    }

    #[test]
    fn changing_twap_window_applies_to_existing_observations() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = default_test_token(&env);

        env.ledger().set_sequence_number(100);
        client.report_price(&reporter, &token, &100_000_000);
        env.ledger().set_sequence_number(200);
        client.report_price(&reporter, &token, &200_000_000);
        env.ledger().set_sequence_number(300);
        assert_eq!(client.get_price(&token), 15);

        client.set_twap_window(&admin, &1);
        assert_eq!(client.get_price(&token), 20);
    }

    #[test]
    fn changing_staleness_threshold_applies_immediately() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.set_fallback_price(&admin, &5);
        let token = default_test_token(&env);

        env.ledger().set_sequence_number(100);
        client.report_price(&reporter, &token, &80_000_000);
        env.ledger().set_sequence_number(111);
        assert_eq!(client.get_price(&token), 8);

        client.set_staleness_threshold(&admin, &MAX_OBSERVATIONS);
        env.ledger().set_sequence_number(100 + MAX_OBSERVATIONS + 1);
        assert_eq!(client.get_price(&token), 5);
    }

    #[test]
    fn missing_configuration_keys_use_legacy_defaults() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.set_fallback_price(&admin, &7);
        let token = default_test_token(&env);

        client.report_price(&reporter, &token, &1_000_000_000);
        for _ in 0..DEFAULT_TWAP_WINDOW {
            client.report_price(&reporter, &token, &100_000_000);
        }
        env.as_contract(&contract_id, || {
            env.storage().instance().remove(&DataKey::TwapWindow);
            env.storage()
                .instance()
                .remove(&DataKey::StalenessThreshold);
        });

        assert_eq!(client.get_twap_window(), DEFAULT_TWAP_WINDOW);
        assert_eq!(
            client.get_staleness_threshold(),
            DEFAULT_STALENESS_THRESHOLD
        );
        env.ledger()
            .set_sequence_number(DEFAULT_STALENESS_THRESHOLD);
        assert_eq!(client.get_price(&token), 10);
        env.ledger()
            .set_sequence_number(DEFAULT_STALENESS_THRESHOLD + 1);
        assert_eq!(client.get_price(&token), 7);
    }

    #[test]
    fn twap_window_cannot_exceed_staleness_threshold() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);

        client.set_staleness_threshold(&admin, &MAX_OBSERVATIONS);
        assert!(client
            .try_set_twap_window(&admin, &(MAX_OBSERVATIONS + 1))
            .is_err());
        assert_eq!(client.get_twap_window(), DEFAULT_TWAP_WINDOW);
    }

    #[test]
    fn one_observation_is_returned() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = default_test_token(&env);
        client.report_price(&reporter, &token, &80_000_000);
        assert_eq!(client.get_price(&token), 8);
    }

    #[test]
    fn averages_fewer_than_ten_observations() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = default_test_token(&env);
        for price in [60_000_000_i128, 90_000_000, 120_000_000] {
            client.report_price(&reporter, &token, &price);
        }
        assert_eq!(client.get_price(&token), 9);
    }

    #[test]
    fn averages_only_latest_ten_observations() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = default_test_token(&env);
        for price in 1_i128..=15 {
            client.report_price(&reporter, &token, &(price * PRICE_SCALE));
        }
        assert_eq!(client.get_price(&token), 10);
    }

    #[test]
    fn multiple_reporters_contribute_to_twap() {
        let (env, contract_id, admin, reporter_one) = setup();
        let reporter_two = Address::generate(&env);
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter_one);
        add_reporter(&env, &contract_id, &admin, &reporter_two);
        let token = default_test_token(&env);
        client.report_price(&reporter_one, &token, &80_000_000);
        client.report_price(&reporter_two, &token, &120_000_000);
        assert_eq!(client.get_price(&token), 10);
    }

    #[test]
    #[should_panic]
    fn non_reporter_cannot_report() {
        let (env, contract_id, _, reporter) = setup();
        let token = default_test_token(&env);
        SimpleOracleClient::new(&env, &contract_id).report_price(&reporter, &token, &80_000_000);
    }

    #[test]
    #[should_panic]
    fn removed_reporter_cannot_report() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.remove_reporter(&admin, &reporter);
        let token = default_test_token(&env);
        client.report_price(&reporter, &token, &80_000_000);
    }

    #[test]
    #[should_panic]
    fn only_admin_can_add_reporter() {
        let (env, contract_id, _, reporter) = setup();
        let non_admin = Address::generate(&env);
        SimpleOracleClient::new(&env, &contract_id).add_reporter(&non_admin, &reporter);
    }

    #[test]
    #[should_panic]
    fn only_admin_can_remove_reporter() {
        let (env, contract_id, admin, reporter) = setup();
        add_reporter(&env, &contract_id, &admin, &reporter);
        let non_admin = Address::generate(&env);
        SimpleOracleClient::new(&env, &contract_id).remove_reporter(&non_admin, &reporter);
    }

    #[test]
    #[should_panic]
    fn zero_price_is_rejected() {
        let (env, contract_id, admin, reporter) = setup();
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = default_test_token(&env);
        SimpleOracleClient::new(&env, &contract_id).report_price(&reporter, &token, &0);
    }

    #[test]
    #[should_panic]
    fn negative_price_is_rejected() {
        let (env, contract_id, admin, reporter) = setup();
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = default_test_token(&env);
        SimpleOracleClient::new(&env, &contract_id).report_price(&reporter, &token, &-1);
    }

    #[test]
    #[should_panic]
    fn zero_fallback_is_rejected() {
        let (env, contract_id, admin, _) = setup();
        SimpleOracleClient::new(&env, &contract_id).set_fallback_price(&admin, &0);
    }

    #[test]
    fn observation_at_staleness_threshold_is_fresh() {
        let (env, contract_id, admin, reporter) = setup();
        env.ledger().set_sequence_number(100);
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = default_test_token(&env);
        client.report_price(&reporter, &token, &80_000_000);
        env.ledger()
            .set_sequence_number(100 + DEFAULT_STALENESS_THRESHOLD);
        assert_eq!(client.get_price(&token), 8);
    }

    #[test]
    #[should_panic]
    fn stale_observation_without_fallback_panics() {
        let (env, contract_id, admin, reporter) = setup();
        env.ledger().set_sequence_number(100);
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = default_test_token(&env);
        client.report_price(&reporter, &token, &80_000_000);
        env.ledger()
            .set_sequence_number(101 + DEFAULT_STALENESS_THRESHOLD);
        client.get_price(&token);
    }

    #[test]
    fn stale_observation_uses_fallback() {
        let (env, contract_id, admin, reporter) = setup();
        env.ledger().set_sequence_number(100);
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.set_fallback_price(&admin, &7);
        let token = default_test_token(&env);
        client.report_price(&reporter, &token, &80_000_000);
        env.ledger()
            .set_sequence_number(101 + DEFAULT_STALENESS_THRESHOLD);
        assert_eq!(client.get_price(&token), 7);
    }

    #[test]
    fn newest_observation_controls_freshness() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = default_test_token(&env);
        env.ledger().set_sequence_number(1);
        client.report_price(&reporter, &token, &20_000_000);
        env.ledger().set_sequence_number(1_000);
        client.report_price(&reporter, &token, &100_000_000);
        assert_eq!(client.get_price(&token), 2);
    }

    #[test]
    fn circular_buffer_overwrites_after_twenty_entries() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = default_test_token(&env);
        for price in 1_i128..=25 {
            client.report_price(&reporter, &token, &(price * PRICE_SCALE));
        }
        assert_eq!(client.get_price(&token), 20);
        env.as_contract(&contract_id, || {
            let count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::ObservationCount(token.clone()))
                .unwrap();
            let next_index: u32 = env
                .storage()
                .instance()
                .get(&DataKey::ObservationIndex(token.clone()))
                .unwrap();
            assert_eq!(count, MAX_OBSERVATIONS);
            assert_eq!(next_index, 5);
        });
    }

    #[test]
    fn twap_addition_overflow_panics() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = default_test_token(&env);
        client.report_price(&reporter, &token, &i128::MAX);
        client.report_price(&reporter, &token, &i128::MAX);
        assert!(client.try_get_price(&token).is_err());
    }

    #[test]
    fn random_sequences_stay_within_recent_min_and_max() {
        let mut state = 0x5eed_u64;
        for _ in 0..32 {
            let (env, contract_id, admin, reporter) = setup();
            let client = SimpleOracleClient::new(&env, &contract_id);
            add_reporter(&env, &contract_id, &admin, &reporter);
            let token = default_test_token(&env);
            let mut recent = [0_i128; DEFAULT_TWAP_WINDOW as usize];
            for index in 0..25_usize {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1);
                let price = i128::from((state % 1_000) + 1);
                client.report_price(&reporter, &token, &(price * PRICE_SCALE));
                if index >= 15 {
                    recent[index - 15] = price;
                }
            }
            let twap = client.get_price(&token);
            let min = recent.iter().copied().min().unwrap();
            let max = recent.iter().copied().max().unwrap();
            assert!(twap >= min && twap <= max);
        }
    }

    // ─── TWAP-specific tests (#377) ─────────────────────────────────────────

    #[test]
    fn test_twap_single_observation() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = default_test_token(&env);

        env.ledger().set_sequence_number(0);
        client.report_price(&reporter, &token, &100_000_000);

        env.ledger().set_sequence_number(100);
        assert_eq!(client.get_price(&token), 10);
    }

    #[test]
    fn test_twap_multiple_observations() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = default_test_token(&env);

        env.ledger().set_sequence_number(100);
        client.report_price(&reporter, &token, &100_000_000);

        env.ledger().set_sequence_number(150);
        client.report_price(&reporter, &token, &200_000_000);

        env.ledger().set_sequence_number(200);
        assert_eq!(client.get_price(&token), 15);
    }

    #[test]
    fn test_twap_freshness_expiry() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = default_test_token(&env);

        env.ledger().set_sequence_number(100);
        client.report_price(&reporter, &token, &80_000_000);

        client.set_fallback_price(&admin, &5);

        env.ledger()
            .set_sequence_number(100 + DEFAULT_STALENESS_THRESHOLD + 1);
        assert_eq!(client.get_price(&token), 5);
    }

    #[test]
    fn test_twap_flash_loan_resistance() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = default_test_token(&env);

        env.ledger().set_sequence_number(100);
        client.report_price(&reporter, &token, &100_000_000);

        env.ledger().set_sequence_number(200);
        client.report_price(&reporter, &token, &10_000_000_000);

        env.ledger().set_sequence_number(201);
        let twap = client.get_price(&token);
        assert_eq!(twap, 19);
    }

    // ─── Price deviation circuit breaker (#464) ────────────────────────────

    fn seed_baseline(
        env: &Env,
        contract_id: &Address,
        admin: &Address,
        reporter: &Address,
        token: &Address,
        base_price: i128,
    ) {
        let client = SimpleOracleClient::new(env, contract_id);
        add_reporter(env, contract_id, admin, reporter);
        client.report_price(reporter, token, &base_price);
        client.report_price(reporter, token, &base_price);
    }

    #[test]
    fn test_set_deviation_threshold() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        client.set_max_price_deviation(&admin, &500);
        env.as_contract(&contract_id, || {
            let stored: u32 = env
                .storage()
                .instance()
                .get(&DataKey::MaxPriceDeviationBps)
                .unwrap();
            assert_eq!(stored, 500);
        });
    }

    #[test]
    #[should_panic]
    fn only_admin_can_set_deviation_threshold() {
        let (env, contract_id, _, _) = setup();
        let non_admin = Address::generate(&env);
        SimpleOracleClient::new(&env, &contract_id).set_max_price_deviation(&non_admin, &500);
    }

    #[test]
    fn test_deviation_accept_within_bounds() {
        let (env, contract_id, admin, reporter) = setup();
        let token = default_test_token(&env);
        seed_baseline(&env, &contract_id, &admin, &reporter, &token, 80_000_000);
        let client = SimpleOracleClient::new(&env, &contract_id);
        client.set_max_price_deviation(&admin, &500);

        client.report_price(&reporter, &token, &82_000_000);

        env.as_contract(&contract_id, || {
            let count = read_observation_count(&env, &token);
            assert_eq!(count, 3);
        });
    }

    #[test]
    fn test_deviation_reject() {
        let (env, contract_id, admin, reporter) = setup();
        let token = default_test_token(&env);
        seed_baseline(&env, &contract_id, &admin, &reporter, &token, 80_000_000);
        let client = SimpleOracleClient::new(&env, &contract_id);
        client.set_max_price_deviation(&admin, &500);

        client.report_price(&reporter, &token, &90_000_000);

        env.as_contract(&contract_id, || {
            let count = read_observation_count(&env, &token);
            assert_eq!(count, 2);
        });
    }

    #[test]
    fn test_deviation_reject_emits_price_rejected_event() {
        use std::format;

        let (env, contract_id, admin, reporter) = setup();
        let token = default_test_token(&env);
        seed_baseline(&env, &contract_id, &admin, &reporter, &token, 80_000_000);
        let client = SimpleOracleClient::new(&env, &contract_id);
        client.set_max_price_deviation(&admin, &500);

        let events_before = env.events().all().events().len();
        client.report_price(&reporter, &token, &90_000_000);

        let events_after = env.events().all();
        assert_eq!(
            events_after.events().len(),
            events_before + 1,
            "expected exactly one additional event"
        );

        let latest = format!("{:?}", events_after.events().last().unwrap());
        assert!(
            latest.contains("price_rejected"),
            "expected price_rejected event, got: {}",
            latest
        );
    }

    #[test]
    fn test_deviation_disabled_zero() {
        let (env, contract_id, admin, reporter) = setup();
        let token = default_test_token(&env);
        seed_baseline(&env, &contract_id, &admin, &reporter, &token, 80_000_000);
        let client = SimpleOracleClient::new(&env, &contract_id);

        client.report_price(&reporter, &token, &800_000_000);

        env.as_contract(&contract_id, || {
            let count = read_observation_count(&env, &token);
            assert_eq!(count, 3);
        });
    }

    #[test]
    fn test_deviation_skip_few_observations() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = default_test_token(&env);
        client.set_max_price_deviation(&admin, &500);

        client.report_price(&reporter, &token, &80_000_000);
        client.report_price(&reporter, &token, &8_000_000_000);

        env.as_contract(&contract_id, || {
            let count = read_observation_count(&env, &token);
            assert_eq!(count, 2);
        });
    }

    #[test]
    fn configured_twap_window_affects_deviation_baseline() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = default_test_token(&env);

        client.report_price(&reporter, &token, &100);
        client.report_price(&reporter, &token, &200);
        client.set_twap_window(&admin, &1);
        client.set_max_price_deviation(&admin, &3_000);
        client.report_price(&reporter, &token, &260);

        assert_eq!(
            env.events().all().filter_by_contract(&contract_id),
            soroban_sdk::vec![
                &env,
                (
                    contract_id.clone(),
                    (symbol_short!("price_upd"), reporter).into_val(&env),
                    (260_i128, env.ledger().sequence(), token.clone()).into_val(&env),
                )
            ]
        );
        env.as_contract(&contract_id, || {
            assert_eq!(
                env.storage()
                    .instance()
                    .get::<_, u32>(&DataKey::ObservationCount(token.clone())),
                Some(3)
            );
            assert_eq!(
                env.storage()
                    .instance()
                    .get::<_, PriceObservation>(&DataKey::Observations(token.clone(), 2))
                    .unwrap()
                    .price,
                260
            );
        });
    }

    #[test]
    fn configured_staleness_affects_deviation_baseline_availability() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = default_test_token(&env);

        env.ledger().set_sequence_number(100);
        client.report_price(&reporter, &token, &100);
        client.report_price(&reporter, &token, &100);
        client.set_staleness_threshold(&admin, &MAX_OBSERVATIONS);
        client.set_max_price_deviation(&admin, &500);
        env.ledger().set_sequence_number(100 + MAX_OBSERVATIONS + 1);
        client.report_price(&reporter, &token, &1_000);

        assert_eq!(
            env.events().all().filter_by_contract(&contract_id),
            soroban_sdk::vec![
                &env,
                (
                    contract_id.clone(),
                    (symbol_short!("price_upd"), reporter).into_val(&env),
                    (1_000_i128, (100 + MAX_OBSERVATIONS + 1), token.clone()).into_val(&env),
                )
            ]
        );
        env.as_contract(&contract_id, || {
            assert_eq!(
                env.storage()
                    .instance()
                    .get::<_, u32>(&DataKey::ObservationCount(token.clone())),
                Some(3)
            );
            assert_eq!(
                env.storage()
                    .instance()
                    .get::<_, PriceObservation>(&DataKey::Observations(token.clone(), 2))
                    .unwrap()
                    .price,
                1_000
            );
        });
    }

    #[test]
    fn test_stake() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        let (stake_token, _) = setup_staking(&env, &contract_id, &admin, &reporter, 1_000, 10);

        client.stake(&reporter, &1_000);

        assert_eq!(client.get_reporter_stake(&reporter), 1_000);
        assert_eq!(
            token::Client::new(&env, &stake_token).balance(&contract_id),
            1_000
        );
        let token = default_test_token(&env);
        client.report_price(&reporter, &token, &100_000_000);
    }

    #[test]
    #[should_panic]
    fn test_report_without_stake_panics() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        setup_staking(&env, &contract_id, &admin, &reporter, 1_000, 10);
        let token = default_test_token(&env);
        client.report_price(&reporter, &token, &100_000_000);
    }

    #[test]
    fn test_slash_reduces_stake() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        let (stake_token, treasury) =
            setup_staking(&env, &contract_id, &admin, &reporter, 1_000, 10);
        client.stake(&reporter, &1_500);

        client.slash(
            &admin,
            &reporter,
            &600,
            &String::from_str(&env, "bad price"),
        );

        assert_eq!(client.get_reporter_stake(&reporter), 900);
        assert_eq!(
            token::Client::new(&env, &stake_token).balance(&treasury),
            600
        );
        assert_eq!(client.get_slash_history(&reporter).len(), 1);
        let token = default_test_token(&env);
        assert!(client
            .try_report_price(&reporter, &token, &100_000_000)
            .is_err());
    }

    #[test]
    fn test_unstake_after_cooldown() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        let (stake_token, _) = setup_staking(&env, &contract_id, &admin, &reporter, 1_000, 10);
        let starting_balance = token::Client::new(&env, &stake_token).balance(&reporter);
        client.stake(&reporter, &1_000);
        env.ledger().set_sequence_number(10);

        client.unstake(&reporter);

        assert_eq!(client.get_reporter_stake(&reporter), 0);
        assert_eq!(
            token::Client::new(&env, &stake_token).balance(&reporter),
            starting_balance
        );
        let token = default_test_token(&env);
        assert!(client
            .try_report_price(&reporter, &token, &100_000_000)
            .is_err());
    }

    #[test]
    #[should_panic]
    fn test_unstake_before_cooldown_panics() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        setup_staking(&env, &contract_id, &admin, &reporter, 1_000, 10);
        client.stake(&reporter, &1_000);
        client.unstake(&reporter);
    }

    #[test]
    fn test_stake_top_up_preserves_existing_cooldown() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        let (stake_token, _) = setup_staking(&env, &contract_id, &admin, &reporter, 1_000, 10);
        let starting_balance = token::Client::new(&env, &stake_token).balance(&reporter);

        client.stake(&reporter, &1_000);
        env.ledger().set_sequence_number(5);
        client.stake(&reporter, &500);

        env.ledger().set_sequence_number(9);
        assert!(client.try_unstake(&reporter).is_err());

        env.ledger().set_sequence_number(10);
        client.unstake(&reporter);

        assert_eq!(client.get_reporter_stake(&reporter), 0);
        assert_eq!(
            token::Client::new(&env, &stake_token).balance(&reporter),
            starting_balance
        );
    }

    #[test]
    fn test_slash_event() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        setup_staking(&env, &contract_id, &admin, &reporter, 1_000, 10);
        client.stake(&reporter, &1_000);
        client.slash(
            &admin,
            &reporter,
            &100,
            &String::from_str(&env, "deviation"),
        );

        let events = env.events().all().filter_by_contract(&contract_id);
        let latest = std::format!("{:?}", events.events().last().unwrap());
        assert!(latest.contains("stake_slash"));
    }

    #[test]
    fn test_slash_history_is_bounded() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        setup_staking(&env, &contract_id, &admin, &reporter, 1_000, 10);
        client.stake(&reporter, &1_500);

        for i in 1..=MAX_SLASH_HISTORY + 5 {
            env.ledger().set_sequence_number(i);
            client.slash(&admin, &reporter, &10, &String::from_str(&env, "slash"));
        }

        assert_eq!(client.get_slash_count(&reporter), MAX_SLASH_HISTORY);
        assert_eq!(client.get_slash_history(&reporter).len(), MAX_SLASH_HISTORY);

        env.as_contract(&contract_id, || {
            let meta: SlashHistoryMeta = env
                .storage()
                .instance()
                .get(&DataKey::SlashHistoryMeta(reporter.clone()))
                .unwrap();
            assert_eq!(meta.count, MAX_SLASH_HISTORY);
            assert_eq!(meta.next_index, 5 % MAX_SLASH_HISTORY);
        });
    }

    #[test]
    fn test_slash_eviction_overwrites_oldest() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        setup_staking(&env, &contract_id, &admin, &reporter, 1_000, 10);
        client.stake(&reporter, &1_500);

        for i in 1..=MAX_SLASH_HISTORY {
            env.ledger().set_sequence_number(i);
            client.slash(&admin, &reporter, &10, &String::from_str(&env, "fill"));
        }

        let first = client.get_slash_event_at(&reporter, &0);
        assert_eq!(first.ledger, 1);

        env.ledger().set_sequence_number(MAX_SLASH_HISTORY + 1);
        client.slash(&admin, &reporter, &10, &String::from_str(&env, "over"));
        let overwritten = client.get_slash_event_at(&reporter, &0);
        assert_eq!(overwritten.ledger, MAX_SLASH_HISTORY + 1);
    }

    // ─── Part A: Source health tests ─────────────────────────────────────────

    #[test]
    fn test_source_health_failure_threshold() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        let source = register_price_source(&env, 100);
        client.set_fallback_price(&admin, &1000);
        // Make source fail
        env.as_contract(&source, || {
            env.storage().instance().remove(&TEST_PRICE_KEY);
        });

        client.add_source_oracle(&admin, &source);
        client.set_source_failure_threshold(&admin, &3);

        // First two calls: should still be healthy (threshold 3)
        for _ in 0..2 {
            let _ = client.get_aggregated_price(); // fallback to internal
        }
        let health = client.get_source_health(&source);
        assert!(health.healthy);
        assert_eq!(health.consecutive_failures, 2);

        // Third call: should mark unhealthy
        let _ = client.get_aggregated_price();
        let health = client.get_source_health(&source);
        std::println!("After third failure: health={:?}", health);
        assert!(!health.healthy);
        assert_eq!(health.consecutive_failures, 3);
    }

    #[test]
    fn test_source_health_recovery() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        let source = register_price_source(&env, 100);
        client.set_fallback_price(&admin, &1000);
        // Make source fail
        env.as_contract(&source, || {
            env.storage().instance().remove(&TEST_PRICE_KEY);
        });

        client.add_source_oracle(&admin, &source);
        client.set_source_failure_threshold(&admin, &3);

        // Drive to unhealthy
        for _ in 0..4 {
            let _ = client.get_aggregated_price();
        }
        let health = client.get_source_health(&source);
        std::println!("Before restore: health={:?}", health);
        assert!(!health.healthy);

        // Restore source using the client
        TestPriceSourceClient::new(&env, &source).set_price(&100);

        // Verify the price is restored
        let restored = TestPriceSourceClient::new(&env, &source).get_price();
        std::println!("Restored price: {}", restored);
        assert_eq!(restored, 100);

        // Ensure the source is in the list
        let sources = source_list(&env, &contract_id);
        assert!(sources.contains(&source), "Source not in list");

        // Call aggregation twice: first to recover, second to confirm stability.
        let _ = client.get_aggregated_price();
        std::println!("After first recovery call");

        // Call aggregation – should recover
        let _ = client.get_aggregated_price();
        let health = client.get_source_health(&source);
        std::println!("After restore: health={:?}", health);
        assert!(health.healthy);
        assert_eq!(health.consecutive_failures, 0);
    }

    // ─── Part B: Per-token deviation tests ──────────────────────────────────

    #[test]
    fn test_token_deviation_override() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token_a = Address::generate(&env);
        let token_b = Address::generate(&env);

        // Set global deviation to 500 bps
        client.set_max_price_deviation(&admin, &500);

        // Seed baseline for both tokens
        seed_baseline(&env, &contract_id, &admin, &reporter, &token_a, 100);
        seed_baseline(&env, &contract_id, &admin, &reporter, &token_b, 100);

        // Set token-specific: token_a = 100 bps (1%), token_b = 1000 bps (10%)
        client.set_token_deviation(&admin, &token_a, &100);
        client.set_token_deviation(&admin, &token_b, &1000);

        // Report price that deviates 2% from baseline
        let count_a_before =
            env.as_contract(&contract_id, || read_observation_count(&env, &token_a));
        let count_b_before =
            env.as_contract(&contract_id, || read_observation_count(&env, &token_b));

        client.report_price(&reporter, &token_a, &102);
        client.report_price(&reporter, &token_b, &102);

        let count_a_after =
            env.as_contract(&contract_id, || read_observation_count(&env, &token_a));
        std::println!(
            "count_a_before={}, count_a_after={}",
            count_a_before,
            count_a_after
        );
        let count_b_after =
            env.as_contract(&contract_id, || read_observation_count(&env, &token_b));

        // token_a should have rejected (count unchanged)
        assert_eq!(count_a_after, count_a_before);
        // token_b should have accepted (count increased)
        assert_eq!(count_b_after, count_b_before + 1);
    }

    #[test]
    fn test_token_deviation_fallback_to_global() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        let token = Address::generate(&env);

        // No per-token set, global = 100 bps
        client.set_max_price_deviation(&admin, &100);
        seed_baseline(&env, &contract_id, &admin, &reporter, &token, 100);

        // Report 2% deviation (102) -> should be rejected because global 100 bps
        let count_before = env.as_contract(&contract_id, || read_observation_count(&env, &token));
        client.report_price(&reporter, &token, &102);
        let count_after = env.as_contract(&contract_id, || read_observation_count(&env, &token));
        assert_eq!(count_after, count_before);
    }

    #[test]
    fn test_get_token_deviation() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        let token = Address::generate(&env);

        assert_eq!(client.get_token_deviation(&token), 0);
        client.set_token_deviation(&admin, &token, &250);
        assert_eq!(client.get_token_deviation(&token), 250);
    }

    #[test]
    #[should_panic]
    fn test_set_token_deviation_exceeds_max() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        let token = Address::generate(&env);
        client.set_token_deviation(&admin, &token, &10001);
    }
}

#[cfg(test)]
mod deviation_fuzz {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    extern crate std;

    use super::calculate_deviation_bps;
    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2048))]

        #[test]
        fn prop_deviation_calculation_correct(
            current in 1_i128..1_000_000_000_000_i128,
            new in 1_i128..1_000_000_000_000_i128,
        ) {
            let bps = calculate_deviation_bps(new, current);

            let diff = new.abs_diff(current);
            let expected = diff
                .checked_mul(10_000)
                .map(|scaled| scaled / (current as u128))
                .and_then(|v| u32::try_from(v).ok())
                .unwrap_or(u32::MAX);

            prop_assert_eq!(bps, expected);
        }

        #[test]
        fn prop_deviation_is_zero_when_prices_match(price in 1_i128..1_000_000_000_000_i128) {
            prop_assert_eq!(calculate_deviation_bps(price, price), 0);
        }

        #[test]
        fn prop_deviation_never_panics(new in any::<i128>(), current in any::<i128>()) {
            let _ = calculate_deviation_bps(new, current);
        }

        #[test]
        fn prop_stake_never_negative(
            deposits in proptest::collection::vec(1_i128..1_000_000, 0..100),
            slash_requests in proptest::collection::vec(1_i128..1_000_000, 0..100),
        ) {
            let mut stake = deposits
                .into_iter()
                .try_fold(0_i128, i128::checked_add)
                .unwrap_or(i128::MAX);
            for requested in slash_requests {
                let slash = requested.min(stake);
                stake = stake.checked_sub(slash).unwrap();
                prop_assert!(stake >= 0);
            }
        }
    }
}
