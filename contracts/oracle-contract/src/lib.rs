#![no_std]
#![allow(deprecated)]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Env, InvokeError, String,
    Symbol, Vec,
};

const MAX_OBSERVATIONS: u32 = 20;
const MAX_SOURCE_ORACLES: u32 = 7;
const DEFAULT_TWAP_WINDOW: u32 = 10;
const DEFAULT_STALENESS_THRESHOLD: u32 = 720;
const PRICE_SCALE: i128 = 10_000_000;
pub const DEFAULT_UNSTAKE_COOLDOWN: u32 = 120_960;

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

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Observations(u32),
    ObservationCount,
    ObservationIndex,
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
}

#[contract]
pub struct SimpleOracle;

fn require_admin(env: &Env, admin: &Address) {
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("Oracle not initialized");
    if stored_admin != *admin {
        panic!("Only admin can perform this action");
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

/// Time-weighted current price in the same raw scale as `PriceObservation
/// ::price` / `report_price`'s `price` argument (i.e. *not* divided by
/// `PRICE_SCALE`, unlike the public `get_price`). Used exclusively as the
/// deviation-check baseline in `report_price`.
///
/// Returns `None` when there is no observation history to weight (no
/// observations, the latest one is stale, or the weighted window sums to
/// zero) — in every such case there is no reliable baseline, so the
/// deviation check is skipped rather than falling back to a configured
/// fallback price (a fallback price is a display/consumption concern for
/// `get_price`, not a valid deviation baseline for a fresh report).
fn current_price_raw(env: &Env) -> Option<i128> {
    let count: u32 = env
        .storage()
        .instance()
        .get(&DataKey::ObservationCount)
        .unwrap_or(0);
    if count == 0 {
        return None;
    }

    let next_index: u32 = env
        .storage()
        .instance()
        .get(&DataKey::ObservationIndex)
        .unwrap_or(0);
    let current_ledger = env.ledger().sequence();

    let latest_index = (next_index + MAX_OBSERVATIONS - 1) % MAX_OBSERVATIONS;
    let latest: PriceObservation = env
        .storage()
        .instance()
        .get(&DataKey::Observations(latest_index))
        .expect("Oracle observation missing");

    if current_ledger.saturating_sub(latest.ledger) > read_staleness_threshold(env) {
        return None;
    }

    let window = read_twap_window(env).min(count);
    let mut observations = Vec::new(env);
    let start_offset = (next_index + MAX_OBSERVATIONS - window) % MAX_OBSERVATIONS;
    for i in 0..window {
        let index = (start_offset + i) % MAX_OBSERVATIONS;
        let obs: PriceObservation = env
            .storage()
            .instance()
            .get(&DataKey::Observations(index))
            .expect("Oracle observation missing");
        observations.push_back(obs);
    }

    let mut weighted_sum = 0_i128;
    let mut total_weight = 0_i128;
    for i in 0..window {
        let obs = observations.get(i).unwrap();
        let next_ledger = if i + 1 < window {
            observations.get(i + 1).unwrap().ledger
        } else {
            current_ledger
        };
        let mut weight = next_ledger.saturating_sub(obs.ledger) as i128;
        if weight == 0 {
            weight = 1;
        }
        weighted_sum = weighted_sum
            .checked_add(obs.price.checked_mul(weight).expect("TWAP mul overflow"))
            .expect("TWAP overflow");
        total_weight = total_weight
            .checked_add(weight)
            .expect("Total weight overflow");
    }

    if total_weight == 0 {
        return None;
    }

    Some(weighted_sum / total_weight)
}

/// Computes this contract's own configured TWAP price.
///
/// This is kept separate from external-source aggregation so the public
/// `get_price` entry point remains backward compatible and aggregation can
/// fall back to the exact same internal calculation.
fn internal_price(env: &Env) -> i128 {
    let count: u32 = env
        .storage()
        .instance()
        .get(&DataKey::ObservationCount)
        .unwrap_or(0);
    if count == 0 {
        return env
            .storage()
            .instance()
            .get(&DataKey::FallbackPrice)
            .expect("Oracle has no observations and no fallback");
    }

    let next_index: u32 = env
        .storage()
        .instance()
        .get(&DataKey::ObservationIndex)
        .unwrap_or(0);
    let current_ledger = env.ledger().sequence();

    // Check freshness of the newest observation.
    let latest_index = (next_index + MAX_OBSERVATIONS - 1) % MAX_OBSERVATIONS;
    let latest: PriceObservation = env
        .storage()
        .instance()
        .get(&DataKey::Observations(latest_index))
        .expect("Oracle observation missing");

    if current_ledger.saturating_sub(latest.ledger) > read_staleness_threshold(env) {
        return env
            .storage()
            .instance()
            .get(&DataKey::FallbackPrice)
            .expect("Oracle price is stale and no fallback configured");
    }

    let window = read_twap_window(env).min(count);

    // Collect observations from oldest to newest.
    let mut observations = Vec::new(env);
    let start_offset = (next_index + MAX_OBSERVATIONS - window) % MAX_OBSERVATIONS;
    for i in 0..window {
        let index = (start_offset + i) % MAX_OBSERVATIONS;
        let obs: PriceObservation = env
            .storage()
            .instance()
            .get(&DataKey::Observations(index))
            .expect("Oracle observation missing");
        observations.push_back(obs);
    }

    // TWAP: Σ(price_i × weight_i) / Σ(weight_i × PRICE_SCALE)
    let mut weighted_sum = 0_i128;
    let mut total_weight = 0_i128;

    for i in 0..window {
        let obs = observations.get(i).unwrap();
        let next_ledger = if i + 1 < window {
            observations.get(i + 1).unwrap().ledger
        } else {
            current_ledger
        };
        let mut weight = next_ledger.saturating_sub(obs.ledger) as i128;
        // When all observations fall on the same ledger (common in tests),
        // each observation gets a minimum weight of 1 to avoid division by
        // zero while preserving the ordering of price contributions.
        if weight == 0 {
            weight = 1;
        }
        weighted_sum = weighted_sum
            .checked_add(obs.price.checked_mul(weight).expect("TWAP mul overflow"))
            .expect("TWAP overflow");
        total_weight = total_weight
            .checked_add(weight)
            .expect("Total weight overflow");
    }

    if total_weight == 0 {
        return env
            .storage()
            .instance()
            .get(&DataKey::FallbackPrice)
            .expect("Zero-weight TWAP — fallback required");
    }

    weighted_sum / (total_weight * PRICE_SCALE)
}

#[contractimpl]
impl SimpleOracle {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::ObservationCount, &0_u32);
        env.storage()
            .instance()
            .set(&DataKey::ObservationIndex, &0_u32);
        env.storage()
            .instance()
            .set(&DataKey::TwapWindow, &DEFAULT_TWAP_WINDOW);
        env.storage()
            .instance()
            .set(&DataKey::StalenessThreshold, &DEFAULT_STALENESS_THRESHOLD);
    }

    pub fn add_reporter(env: Env, admin: Address, reporter: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Reporter(reporter.clone()), &true);
        env.events()
            .publish((symbol_short!("rep_add"), admin), reporter);
    }

    pub fn remove_reporter(env: Env, admin: Address, reporter: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        env.storage()
            .instance()
            .remove(&DataKey::Reporter(reporter.clone()));
        env.events()
            .publish((symbol_short!("rep_rem"), admin), reporter);
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
            panic!("Minimum stake must be positive");
        }
        if unstake_cooldown == 0 {
            panic!("Unstake cooldown must be positive");
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
            panic!("Stake amount must be positive");
        }
        let is_reporter: bool = env
            .storage()
            .instance()
            .get(&DataKey::Reporter(reporter.clone()))
            .unwrap_or(false);
        if !is_reporter {
            panic!("Not an authorised reporter");
        }
        let stake_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::StakeToken)
            .expect("Staking not configured");
        let current: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ReporterStake(reporter.clone()))
            .unwrap_or(0);
        let updated = current
            .checked_add(amount)
            .expect("Reporter stake overflow");
        let cooldown: u32 = env
            .storage()
            .instance()
            .get(&DataKey::UnstakeCooldown)
            .unwrap_or(DEFAULT_UNSTAKE_COOLDOWN);
        let available_at = env
            .ledger()
            .sequence()
            .checked_add(cooldown)
            .expect("Stake cooldown overflow");

        env.storage()
            .instance()
            .set(&DataKey::ReporterStake(reporter.clone()), &updated);
        env.storage()
            .instance()
            .set(&DataKey::StakeAvailableAt(reporter.clone()), &available_at);
        env.events().publish(
            (symbol_short!("stake_dep"), reporter.clone()),
            (amount, updated, available_at),
        );

        token::Client::new(&env, &stake_token).transfer(
            &reporter,
            &env.current_contract_address(),
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
            panic!("No reporter stake");
        }
        let available_at: u32 = env
            .storage()
            .instance()
            .get(&DataKey::StakeAvailableAt(reporter.clone()))
            .expect("Stake cooldown not set");
        if env.ledger().sequence() < available_at {
            panic!("Unstake cooldown not reached");
        }
        let stake_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::StakeToken)
            .expect("Staking not configured");

        env.storage()
            .instance()
            .set(&DataKey::ReporterStake(reporter.clone()), &0_i128);
        env.storage()
            .instance()
            .remove(&DataKey::StakeAvailableAt(reporter.clone()));
        env.events()
            .publish((symbol_short!("stake_wdr"), reporter.clone()), amount);

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
            panic!("Slash amount must be positive");
        }
        let current: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ReporterStake(reporter.clone()))
            .unwrap_or(0);
        if amount > current {
            panic!("Slash amount exceeds reporter stake");
        }
        let remaining = current
            .checked_sub(amount)
            .expect("Reporter stake underflow");
        let stake_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::StakeToken)
            .expect("Staking not configured");
        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::StakeTreasury)
            .expect("Stake treasury not configured");
        let mut history: Vec<SlashEvent> = env
            .storage()
            .instance()
            .get(&DataKey::SlashHistory(reporter.clone()))
            .unwrap_or(Vec::new(&env));
        history.push_back(SlashEvent {
            amount,
            reason: reason.clone(),
            ledger: env.ledger().sequence(),
        });

        env.storage()
            .instance()
            .set(&DataKey::ReporterStake(reporter.clone()), &remaining);
        env.storage()
            .instance()
            .set(&DataKey::SlashHistory(reporter.clone()), &history);
        env.events().publish(
            (Symbol::new(&env, "stake_slash"), reporter.clone()),
            (amount, remaining, reason),
        );

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
        env.storage()
            .instance()
            .get(&DataKey::SlashHistory(reporter))
            .unwrap_or(Vec::new(&env))
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
            panic!("Cannot register oracle as its own source");
        }

        let mut sources: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::SourceOracleList)
            .unwrap_or(Vec::new(&env));
        if sources.len() >= MAX_SOURCE_ORACLES {
            panic!("Source oracle limit exceeded");
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

    pub fn report_price(env: Env, reporter: Address, price: i128) {
        reporter.require_auth();

        let is_reporter: bool = env
            .storage()
            .instance()
            .get(&DataKey::Reporter(reporter.clone()))
            .unwrap_or(false);
        if !is_reporter {
            panic!("Not an authorised reporter");
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
            panic!("Reporter stake below minimum");
        }
        if price <= 0 {
            panic!("Price must be positive");
        }

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ObservationCount)
            .unwrap_or(0);

        // Price deviation circuit breaker: reject a new observation that
        // deviates too far from the current TWAP, capping the per-report
        // impact a compromised reporter can have even before TWAP
        // averaging kicks in. Disabled when the threshold is 0 (backward
        // compatible) or when there are fewer than 2 prior observations
        // (no reliable baseline yet).
        let max_deviation_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxPriceDeviationBps)
            .unwrap_or(0);
        if max_deviation_bps > 0 && count >= 2 {
            if let Some(current_price) = current_price_raw(&env) {
                let deviation_bps = calculate_deviation_bps(price, current_price);
                if deviation_bps > max_deviation_bps {
                    // Reject by dropping the observation rather than panicking:
                    // Soroban reverts *all* effects of an invocation — storage
                    // writes and published events alike — when it traps, so a
                    // panic here would also erase the `price_rejected` event
                    // this check exists to leave behind. Returning normally
                    // (without recording the observation) is what lets the
                    // event actually reach an indexer/monitor.
                    env.events().publish(
                        (Symbol::new(&env, "price_rejected"), reporter.clone()),
                        (price, current_price, deviation_bps),
                    );
                    return;
                }
            }
        }

        let index: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ObservationIndex)
            .unwrap_or(0);
        let observation = PriceObservation {
            price,
            reporter: reporter.clone(),
            ledger: env.ledger().sequence(),
        };

        env.storage()
            .instance()
            .set(&DataKey::Observations(index), &observation);
        env.storage().instance().set(
            &DataKey::ObservationCount,
            &(count + 1).min(MAX_OBSERVATIONS),
        );
        env.storage().instance().set(
            &DataKey::ObservationIndex,
            &((index + 1) % MAX_OBSERVATIONS),
        );
        env.events().publish(
            (symbol_short!("price_upd"), reporter),
            (price, env.ledger().sequence()),
        );
    }

    pub fn set_fallback_price(env: Env, admin: Address, price: i128) {
        admin.require_auth();
        require_admin(&env, &admin);
        if price <= 0 {
            panic!("Fallback price must be positive");
        }
        env.storage()
            .instance()
            .set(&DataKey::FallbackPrice, &price);
    }

    /// Configures the price deviation circuit breaker threshold, in basis
    /// points (e.g. 500 = 5%). A value of 0 disables the check entirely,
    /// preserving the pre-circuit-breaker behaviour.
    pub fn set_max_price_deviation(env: Env, admin: Address, deviation_bps: u32) {
        admin.require_auth();
        require_admin(&env, &admin);
        env.storage()
            .instance()
            .set(&DataKey::MaxPriceDeviationBps, &deviation_bps);
    }

    pub fn set_twap_window(env: Env, admin: Address, window: u32) {
        admin.require_auth();
        require_admin(&env, &admin);
        if window == 0 {
            panic!("TWAP window must be at least 1");
        }
        if window > MAX_OBSERVATIONS {
            panic!("TWAP window exceeds maximum");
        }
        if window > read_staleness_threshold(&env) {
            panic!("TWAP window exceeds staleness threshold");
        }
        env.storage().instance().set(&DataKey::TwapWindow, &window);
        env.events()
            .publish((symbol_short!("twap_win"), admin), window);
    }

    pub fn set_staleness_threshold(env: Env, admin: Address, threshold: u32) {
        admin.require_auth();
        require_admin(&env, &admin);
        if threshold < read_twap_window(&env) {
            panic!("Staleness threshold must be at least TWAP window");
        }
        env.storage()
            .instance()
            .set(&DataKey::StalenessThreshold, &threshold);
        env.events()
            .publish((symbol_short!("stale_th"), admin), threshold);
    }

    pub fn get_twap_window(env: Env) -> u32 {
        read_twap_window(&env)
    }

    pub fn get_staleness_threshold(env: Env) -> u32 {
        read_staleness_threshold(&env)
    }

    /// Compute the Time-Weighted Average Price (TWAP) from recent observations.
    ///
    /// Each observation is weighted by the number of ledgers it persisted before
    /// the next observation or the current ledger. This makes flash-loan and
    /// single-block price manipulation economically infeasible: an extreme value
    /// submitted at the current ledger has weight ≈ 1, so its effect on the TWAP
    /// is negligible.
    ///
    /// Falls back to the configured `FallbackPrice` when there are no
    /// observations or the newest observation exceeds the configured staleness
    /// threshold.
    pub fn get_price(env: Env) -> i128 {
        internal_price(&env)
    }

    pub fn get_aggregated_price(env: Env) -> i128 {
        let sources: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::SourceOracleList)
            .unwrap_or(Vec::new(&env));
        if sources.is_empty() {
            return internal_price(&env);
        }

        let mut prices: Vec<i128> = Vec::new(&env);
        for source in sources.iter() {
            let result = env.try_invoke_contract::<i128, InvokeError>(
                &source,
                &symbol_short!("get_price"),
                Vec::new(&env),
            );
            if let Ok(Ok(price)) = result {
                if price > 0 {
                    prices.push_back(price);
                }
            }
        }

        if prices.is_empty() {
            return internal_price(&env);
        }

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
    extern crate std;

    use super::*;
    use soroban_sdk::{
        contracterror, panic_with_error,
        testutils::{Address as _, Events as _, Ledger},
        token::StellarAssetClient,
        Env, IntoVal,
    };

    const TEST_PRICE_KEY: Symbol = symbol_short!("price");

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
        SimpleOracleClient::new(&env, &contract_id).initialize(&admin);
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

        env.ledger().set_sequence_number(100);
        client.report_price(&reporter, &100_000_000);
        env.ledger().set_sequence_number(200);
        client.report_price(&reporter, &200_000_000);
        env.ledger().set_sequence_number(300);
        assert_eq!(client.get_aggregated_price(), 15);

        client.set_twap_window(&admin, &1);
        assert_eq!(client.get_aggregated_price(), 20);
        assert_eq!(client.get_price(), 20);
    }

    #[test]
    fn aggregation_fallback_preserves_staleness_and_fallback_price() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.add_source_oracle(&admin, &Address::generate(&env));
        client.set_fallback_price(&admin, &6);
        client.set_staleness_threshold(&admin, &DEFAULT_TWAP_WINDOW);

        env.ledger().set_sequence_number(100);
        client.report_price(&reporter, &80_000_000);
        env.ledger().set_sequence_number(110);
        assert_eq!(client.get_aggregated_price(), 8);
        env.ledger().set_sequence_number(111);
        assert_eq!(client.get_aggregated_price(), 6);
        assert_eq!(client.get_price(), 6);
    }

    #[test]
    #[should_panic(expected = "Oracle has no observations and no fallback")]
    fn no_observations_without_fallback_panics() {
        let (env, contract_id, _, _) = setup();
        SimpleOracleClient::new(&env, &contract_id).get_price();
    }

    #[test]
    fn no_observations_uses_fallback() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        client.set_fallback_price(&admin, &8);
        assert_eq!(client.get_price(), 8);
    }

    #[test]
    #[should_panic(expected = "Contract already initialized")]
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
            .try_set_staleness_threshold(&admin, &(DEFAULT_TWAP_WINDOW - 1))
            .is_err());
        client.set_staleness_threshold(&admin, &DEFAULT_TWAP_WINDOW);
        assert_eq!(client.get_staleness_threshold(), DEFAULT_TWAP_WINDOW);
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

        env.ledger().set_sequence_number(100);
        client.report_price(&reporter, &100_000_000);
        env.ledger().set_sequence_number(200);
        client.report_price(&reporter, &200_000_000);
        env.ledger().set_sequence_number(300);
        assert_eq!(client.get_price(), 15);

        client.set_twap_window(&admin, &1);
        assert_eq!(client.get_price(), 20);
    }

    #[test]
    fn changing_staleness_threshold_applies_immediately() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.set_fallback_price(&admin, &5);

        env.ledger().set_sequence_number(100);
        client.report_price(&reporter, &80_000_000);
        env.ledger().set_sequence_number(111);
        assert_eq!(client.get_price(), 8);

        client.set_staleness_threshold(&admin, &DEFAULT_TWAP_WINDOW);
        assert_eq!(client.get_price(), 5);
    }

    #[test]
    fn missing_configuration_keys_use_legacy_defaults() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.set_fallback_price(&admin, &7);

        client.report_price(&reporter, &1_000_000_000);
        for _ in 0..DEFAULT_TWAP_WINDOW {
            client.report_price(&reporter, &100_000_000);
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
        assert_eq!(client.get_price(), 10);
        env.ledger()
            .set_sequence_number(DEFAULT_STALENESS_THRESHOLD + 1);
        assert_eq!(client.get_price(), 7);
    }

    #[test]
    fn twap_window_cannot_exceed_staleness_threshold() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);

        client.set_staleness_threshold(&admin, &DEFAULT_TWAP_WINDOW);
        assert!(client
            .try_set_twap_window(&admin, &(DEFAULT_TWAP_WINDOW + 1))
            .is_err());
        assert_eq!(client.get_twap_window(), DEFAULT_TWAP_WINDOW);
    }

    #[test]
    fn one_observation_is_returned() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.report_price(&reporter, &80_000_000);
        assert_eq!(client.get_price(), 8);
    }

    #[test]
    fn averages_fewer_than_ten_observations() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        for price in [60_000_000_i128, 90_000_000, 120_000_000] {
            client.report_price(&reporter, &price);
        }
        assert_eq!(client.get_price(), 9);
    }

    #[test]
    fn averages_only_latest_ten_observations() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        for price in 1_i128..=15 {
            client.report_price(&reporter, &(price * PRICE_SCALE));
        }
        assert_eq!(client.get_price(), 10);
    }

    #[test]
    fn multiple_reporters_contribute_to_twap() {
        let (env, contract_id, admin, reporter_one) = setup();
        let reporter_two = Address::generate(&env);
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter_one);
        add_reporter(&env, &contract_id, &admin, &reporter_two);
        client.report_price(&reporter_one, &80_000_000);
        client.report_price(&reporter_two, &120_000_000);
        assert_eq!(client.get_price(), 10);
    }

    #[test]
    #[should_panic(expected = "Not an authorised reporter")]
    fn non_reporter_cannot_report() {
        let (env, contract_id, _, reporter) = setup();
        SimpleOracleClient::new(&env, &contract_id).report_price(&reporter, &80_000_000);
    }

    #[test]
    #[should_panic(expected = "Not an authorised reporter")]
    fn removed_reporter_cannot_report() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.remove_reporter(&admin, &reporter);
        client.report_price(&reporter, &80_000_000);
    }

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn only_admin_can_add_reporter() {
        let (env, contract_id, _, reporter) = setup();
        let non_admin = Address::generate(&env);
        SimpleOracleClient::new(&env, &contract_id).add_reporter(&non_admin, &reporter);
    }

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn only_admin_can_remove_reporter() {
        let (env, contract_id, admin, reporter) = setup();
        add_reporter(&env, &contract_id, &admin, &reporter);
        let non_admin = Address::generate(&env);
        SimpleOracleClient::new(&env, &contract_id).remove_reporter(&non_admin, &reporter);
    }

    #[test]
    #[should_panic(expected = "Price must be positive")]
    fn zero_price_is_rejected() {
        let (env, contract_id, admin, reporter) = setup();
        add_reporter(&env, &contract_id, &admin, &reporter);
        SimpleOracleClient::new(&env, &contract_id).report_price(&reporter, &0);
    }

    #[test]
    #[should_panic(expected = "Price must be positive")]
    fn negative_price_is_rejected() {
        let (env, contract_id, admin, reporter) = setup();
        add_reporter(&env, &contract_id, &admin, &reporter);
        SimpleOracleClient::new(&env, &contract_id).report_price(&reporter, &-1);
    }

    #[test]
    #[should_panic(expected = "Fallback price must be positive")]
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
        client.report_price(&reporter, &80_000_000);
        env.ledger()
            .set_sequence_number(100 + DEFAULT_STALENESS_THRESHOLD);
        assert_eq!(client.get_price(), 8);
    }

    #[test]
    #[should_panic(expected = "Oracle price is stale and no fallback configured")]
    fn stale_observation_without_fallback_panics() {
        let (env, contract_id, admin, reporter) = setup();
        env.ledger().set_sequence_number(100);
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.report_price(&reporter, &80_000_000);
        env.ledger()
            .set_sequence_number(101 + DEFAULT_STALENESS_THRESHOLD);
        client.get_price();
    }

    #[test]
    fn stale_observation_uses_fallback() {
        let (env, contract_id, admin, reporter) = setup();
        env.ledger().set_sequence_number(100);
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.set_fallback_price(&admin, &7);
        client.report_price(&reporter, &80_000_000);
        env.ledger()
            .set_sequence_number(101 + DEFAULT_STALENESS_THRESHOLD);
        assert_eq!(client.get_price(), 7);
    }

    #[test]
    fn newest_observation_controls_freshness() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        env.ledger().set_sequence_number(1);
        client.report_price(&reporter, &20_000_000);
        env.ledger().set_sequence_number(1_000);
        client.report_price(&reporter, &100_000_000);
        // TWAP: price 2 at ledger 1 (weight 999) + price 10 at ledger 1000
        // (weight 1). TWAP ≈ (2×999 + 10×1) / 1000 = 2008/1000 ≈ 2.
        assert_eq!(client.get_price(), 2);
    }

    #[test]
    fn circular_buffer_overwrites_after_twenty_entries() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        for price in 1_i128..=25 {
            client.report_price(&reporter, &(price * PRICE_SCALE));
        }
        assert_eq!(client.get_price(), 20);
        env.as_contract(&contract_id, || {
            let count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::ObservationCount)
                .unwrap();
            let next_index: u32 = env
                .storage()
                .instance()
                .get(&DataKey::ObservationIndex)
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
        client.report_price(&reporter, &i128::MAX);
        client.report_price(&reporter, &i128::MAX);
        assert!(client.try_get_price().is_err());
    }

    #[test]
    fn random_sequences_stay_within_recent_min_and_max() {
        let mut state = 0x5eed_u64;
        for _ in 0..32 {
            let (env, contract_id, admin, reporter) = setup();
            let client = SimpleOracleClient::new(&env, &contract_id);
            add_reporter(&env, &contract_id, &admin, &reporter);
            let mut recent = [0_i128; DEFAULT_TWAP_WINDOW as usize];
            for index in 0..25_usize {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1);
                let price = i128::from((state % 1_000) + 1);
                client.report_price(&reporter, &(price * PRICE_SCALE));
                if index >= 15 {
                    recent[index - 15] = price;
                }
            }
            let twap = client.get_price();
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

        // Report one observation at price 10 XLM/USDC.
        env.ledger().set_sequence_number(0);
        client.report_price(&reporter, &100_000_000);

        // Advance 100 ledgers — weight = 100, TWAP = (10×100) / 100 = 10.
        env.ledger().set_sequence_number(100);
        assert_eq!(client.get_price(), 10);
    }

    #[test]
    fn test_twap_multiple_observations() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);

        // Two observations spread across ledgers.
        env.ledger().set_sequence_number(100);
        client.report_price(&reporter, &100_000_000); // price 10

        env.ledger().set_sequence_number(150);
        client.report_price(&reporter, &200_000_000); // price 20

        // Current ledger 200.
        //  weight_100 = 150 - 100 = 50
        //  weight_150 = 200 - 150 = 50
        //  TWAP = (10×50 + 20×50) / 100 = 15
        env.ledger().set_sequence_number(200);
        assert_eq!(client.get_price(), 15);
    }

    #[test]
    fn test_twap_freshness_expiry() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);

        env.ledger().set_sequence_number(100);
        client.report_price(&reporter, &80_000_000);

        // Set a fallback so stale observations don't panic.
        client.set_fallback_price(&admin, &5);

        // Advance past staleness threshold (720 ledgers).
        env.ledger()
            .set_sequence_number(100 + DEFAULT_STALENESS_THRESHOLD + 1);
        assert_eq!(client.get_price(), 5);
    }

    #[test]
    fn test_twap_flash_loan_resistance() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);

        // Normal price at ledger 100.
        env.ledger().set_sequence_number(100);
        client.report_price(&reporter, &100_000_000); // price 10

        // Attacker submits extreme price at ledger 200.
        env.ledger().set_sequence_number(200);
        client.report_price(&reporter, &10_000_000_000); // price 1000

        // Advance 1 ledger — attacker's price has weight ≈ 1.
        //  weight_normal = 200 - 100 = 100
        //  weight_attack = 201 - 200 = 1
        //  TWAP ≈ (10×100 + 1000×1) / 101 = 2000/101 ≈ 19
        env.ledger().set_sequence_number(201);
        let twap = client.get_price();
        // (10×100 + 1000×1) / 101 = 2000 / 101 = 19 — attack negligible.
        assert_eq!(twap, 19);
    }

    // ─── Price deviation circuit breaker (#464) ────────────────────────────

    /// Seeds two same-ledger observations at `base_price`, giving a clean,
    /// exactly-computable TWAP baseline of `base_price` (see `current_price_raw`
    /// doc comment: same-ledger observations each get weight 1).
    fn seed_baseline(
        env: &Env,
        contract_id: &Address,
        admin: &Address,
        reporter: &Address,
        base_price: i128,
    ) {
        let client = SimpleOracleClient::new(env, contract_id);
        add_reporter(env, contract_id, admin, reporter);
        client.report_price(reporter, &base_price);
        client.report_price(reporter, &base_price);
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
    #[should_panic(expected = "Only admin can perform this action")]
    fn only_admin_can_set_deviation_threshold() {
        let (env, contract_id, _, _) = setup();
        let non_admin = Address::generate(&env);
        SimpleOracleClient::new(&env, &contract_id).set_max_price_deviation(&non_admin, &500);
    }

    #[test]
    fn test_deviation_accept_within_bounds() {
        let (env, contract_id, admin, reporter) = setup();
        seed_baseline(&env, &contract_id, &admin, &reporter, 80_000_000);
        let client = SimpleOracleClient::new(&env, &contract_id);
        client.set_max_price_deviation(&admin, &500); // 5%

        // 82_000_000 vs baseline 80_000_000 → 2.5% deviation, within 5%.
        client.report_price(&reporter, &82_000_000);

        env.as_contract(&contract_id, || {
            let count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::ObservationCount)
                .unwrap();
            assert_eq!(count, 3);
        });
    }

    #[test]
    fn test_deviation_reject() {
        let (env, contract_id, admin, reporter) = setup();
        seed_baseline(&env, &contract_id, &admin, &reporter, 80_000_000);
        let client = SimpleOracleClient::new(&env, &contract_id);
        client.set_max_price_deviation(&admin, &500); // 5%

        // 90_000_000 vs baseline 80_000_000 → 12.5% deviation, exceeds 5%.
        // Rejected observations are dropped, not panicked (see comment in
        // report_price: a panic would also erase the price_rejected event).
        client.report_price(&reporter, &90_000_000);

        env.as_contract(&contract_id, || {
            let count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::ObservationCount)
                .unwrap();
            assert_eq!(count, 2, "rejected observation must not be stored");
        });
    }

    #[test]
    fn test_deviation_reject_emits_price_rejected_event() {
        use std::format;

        let (env, contract_id, admin, reporter) = setup();
        seed_baseline(&env, &contract_id, &admin, &reporter, 80_000_000);
        let client = SimpleOracleClient::new(&env, &contract_id);
        client.set_max_price_deviation(&admin, &500);

        let events_before = env.events().all().events().len();
        client.report_price(&reporter, &90_000_000);

        let events_after = env.events().all();
        assert_eq!(
            events_after.events().len(),
            events_before + 1,
            "expected exactly one additional event to have been published on rejection"
        );

        let latest = format!("{:?}", events_after.events().last().unwrap());
        assert!(
            latest.contains("price_rejected"),
            "expected the new event to reference price_rejected, got: {}",
            latest
        );
    }

    #[test]
    fn test_deviation_disabled_zero() {
        let (env, contract_id, admin, reporter) = setup();
        // max_price_deviation_bps defaults to 0 (never configured) — the
        // circuit breaker must be fully bypassed regardless of magnitude.
        seed_baseline(&env, &contract_id, &admin, &reporter, 80_000_000);
        let client = SimpleOracleClient::new(&env, &contract_id);

        client.report_price(&reporter, &800_000_000); // 10x the baseline

        env.as_contract(&contract_id, || {
            let count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::ObservationCount)
                .unwrap();
            assert_eq!(count, 3);
        });
    }

    #[test]
    fn test_deviation_skip_few_observations() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.set_max_price_deviation(&admin, &500);

        // First observation: 0 prior observations — check must be skipped.
        client.report_price(&reporter, &80_000_000);
        // Second observation: only 1 prior observation — check must still
        // be skipped, even though this "deviates" wildly from the first.
        client.report_price(&reporter, &8_000_000_000);

        env.as_contract(&contract_id, || {
            let count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::ObservationCount)
                .unwrap();
            assert_eq!(count, 2);
        });
    }

    #[test]
    fn configured_twap_window_affects_deviation_baseline() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);

        client.report_price(&reporter, &100);
        client.report_price(&reporter, &200);
        client.set_twap_window(&admin, &1);
        client.set_max_price_deviation(&admin, &3_000);
        client.report_price(&reporter, &260);

        assert_eq!(
            env.events().all().filter_by_contract(&contract_id),
            soroban_sdk::vec![
                &env,
                (
                    contract_id.clone(),
                    (symbol_short!("price_upd"), reporter).into_val(&env),
                    (260_i128, env.ledger().sequence()).into_val(&env),
                )
            ]
        );
        env.as_contract(&contract_id, || {
            assert_eq!(
                env.storage()
                    .instance()
                    .get::<_, u32>(&DataKey::ObservationCount),
                Some(3)
            );
            assert_eq!(
                env.storage()
                    .instance()
                    .get::<_, PriceObservation>(&DataKey::Observations(2))
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

        env.ledger().set_sequence_number(100);
        client.report_price(&reporter, &100);
        client.report_price(&reporter, &100);
        client.set_staleness_threshold(&admin, &10);
        client.set_max_price_deviation(&admin, &500);
        env.ledger().set_sequence_number(111);
        client.report_price(&reporter, &1_000);

        assert_eq!(
            env.events().all().filter_by_contract(&contract_id),
            soroban_sdk::vec![
                &env,
                (
                    contract_id.clone(),
                    (symbol_short!("price_upd"), reporter).into_val(&env),
                    (1_000_i128, 111_u32).into_val(&env),
                )
            ]
        );
        env.as_contract(&contract_id, || {
            assert_eq!(
                env.storage()
                    .instance()
                    .get::<_, u32>(&DataKey::ObservationCount),
                Some(3)
            );
            assert_eq!(
                env.storage()
                    .instance()
                    .get::<_, PriceObservation>(&DataKey::Observations(2))
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
        client.report_price(&reporter, &100_000_000);
    }

    #[test]
    #[should_panic(expected = "Reporter stake below minimum")]
    fn test_report_without_stake_panics() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        setup_staking(&env, &contract_id, &admin, &reporter, 1_000, 10);
        client.report_price(&reporter, &100_000_000);
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
        assert!(client.try_report_price(&reporter, &100_000_000).is_err());
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
        assert!(client.try_report_price(&reporter, &100_000_000).is_err());
    }

    #[test]
    #[should_panic(expected = "Unstake cooldown not reached")]
    fn test_unstake_before_cooldown_panics() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        setup_staking(&env, &contract_id, &admin, &reporter, 1_000, 10);
        client.stake(&reporter, &1_000);
        client.unstake(&reporter);
    }

    #[test]
    fn test_slash_event() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        setup_staking(&env, &contract_id, &admin, &reporter, 1_000, 10);
        client.stake(&reporter, &1_000);
        let before = env
            .events()
            .all()
            .filter_by_contract(&contract_id)
            .events()
            .len();

        client.slash(
            &admin,
            &reporter,
            &100,
            &String::from_str(&env, "deviation"),
        );

        let events = env.events().all().filter_by_contract(&contract_id);
        assert_eq!(events.events().len(), before + 1);
        let latest = std::format!("{:?}", events.events().last().unwrap());
        assert!(latest.contains("stake_slash"));
    }
}

#[cfg(test)]
mod deviation_fuzz {
    extern crate std;

    use super::calculate_deviation_bps;
    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2048))]

        /// `calculate_deviation_bps` must match an independently-derived
        /// reference computation (via `u128::abs_diff` instead of the
        /// implementation's `i128` checked-arithmetic path) for any pair of
        /// positive prices within a range that does not overflow either path.
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

        /// Identical prices must always report zero deviation.
        #[test]
        fn prop_deviation_is_zero_when_prices_match(price in 1_i128..1_000_000_000_000_i128) {
            prop_assert_eq!(calculate_deviation_bps(price, price), 0);
        }

        /// The helper must never panic, for any `i128` input pair — it backs
        /// a security check inside `report_price` and must degrade to
        /// "treat as exceeding any threshold" rather than trap the contract.
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
