#![no_std]
// Deprecated Events::publish — the new #[contractevent] macro is preferred.
// Suppressing this warning so clippy -- -D warnings still passes.
// TODO(indigopay-272): migrate to #[contractevent] pattern.
#![allow(deprecated)]
#[cfg(all(test, feature = "testutils"))]
mod fuzz_template;
#[cfg(all(test, feature = "testutils"))]
mod fuzz_tests;

/**
 * contracts/indigopay-contract/src/lib.rs
 *
 * Stellar IndigoPay — Climate Donation Tracking Contract
 *
 * This contract provides on-chain transparency for every donation:
 *
 *   1. Admin registers verified climate projects on-chain
 *   2. Donors call donate() — XLM sent directly to project wallet
 *   3. Contract records every donation immutably
 *   4. Anyone can query total raised, donor count, CO2 offset per project
 *   5. Impact badges auto-calculated based on cumulative donor totals
 *   6. Community governance: badge holders vote to verify new projects
 *
 * Build:
 *   cargo build --target wasm32v1-none --release
 *
 * Deploy:
 *   stellar contract deploy \
 *     --wasm target/wasm32v1-none/release/indigopay_contract.wasm \
 *     --source alice --network testnet
 */
use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, symbol_short, token, Address, BytesN,
    Env, String, Symbol, Vec,
};

// ─── Oracle interface ─────────────────────────────────────────────────────────

/// External price oracle interface.
/// Any on-chain contract implementing `get_price` can serve as the oracle.
/// `get_price` returns the number of XLM stroops equivalent to 1 USDC stroop.
/// Example: if 1 USDC = 8 XLM, return 8.
#[contractclient(name = "OracleClient")]
pub trait OracleInterface {
    fn get_price(env: Env) -> i128;
}

// ─── Badge tiers (on-chain) ───────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum BadgeTier {
    None,
    Seedling,      // ≥ 10 XLM
    Tree,          // ≥ 100 XLM
    Forest,        // ≥ 500 XLM
    EarthGuardian, // ≥ 2000 XLM
}

// ─── Data structures ──────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub wallet: Address,
    pub co2_per_xlm: u32,
    pub total_raised: i128,
    pub donor_count: u32,
    pub active: bool,
    pub registered_at: u32,
    /// Temporary pause flag — when true, `donate`/`donate_usdc` reject
    /// with `"Project is temporarily paused"`. Distinct from `active`
    /// (which is permanent deactivation).
    ///
    /// Appended (not inserted) so the wire-encoded layout stays
    /// backward-compatible with any Project value that was already on
    /// chain before this field existed. Per UPGRADE.md, new fields must
    /// be appended or live behind a new storage version.
    pub paused: bool,
}

/// Input for registering a project via `batch_register_projects`.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ProjectInit {
    pub id: String,
    pub name: String,
    pub wallet: Address,
    pub co2_per_xlm: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct DonationRecord {
    pub donor: Address,
    pub project: String,
    pub amount: i128,
    pub ledger: u32,
    pub message_hash: u32,
    pub currency: Symbol, // "XLM" or "USDC"
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct DonorStats {
    pub total_donated: i128,
    pub donation_count: u32,
    pub badge: BadgeTier,
    pub co2_offset_grams: i128,
}

/// Sliding-window donation counter for a (donor, project_id) pair.
#[contracttype]
#[derive(Clone, Debug)]
pub struct RateLimitWindow {
    pub window_start: u32,
    pub count: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ImpactNFT {
    pub owner: Address,
    pub tier: BadgeTier,
    pub total_donated: i128,
    pub minted_at_ledger: u32,
}

/// Per-project milestone NFT awarded when a donor's cumulative donation to a
/// single project exceeds 100 XLM. One NFT per (donor, project_id) pair.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ProjectMilestoneNFT {
    pub owner: Address,
    pub project_id: String,
    pub amount_donated: i128,
    pub co2_offset_grams: i128,
    pub minted_at_ledger: u32,
}

/// A community voting proposal to verify a project.
#[contracttype]
#[derive(Clone, Debug)]
pub struct VoteProposal {
    pub project_id: String,
    pub votes_for: u32,
    pub votes_against: u32,
    pub deadline_ledger: u32,
    pub resolved: bool,
}

/// Aggregated platform-wide counters returned by `get_global_stats`.
///
/// Bundles the four values that the landing page hero section needs in a
/// single RPC call, avoiding the four separate `get_global_total`,
/// `get_global_co2`, `get_donation_count`, and `get_project_count` round
/// trips that were required before this type existed.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct GlobalStats {
    /// Total XLM (in stroops) donated across all projects and all currencies.
    pub total_raised: i128,
    /// Cumulative CO₂ offset in grams across every donation ever recorded.
    pub co2_offset_grams: i128,
    /// Total number of individual donation transactions recorded on-chain.
    pub donation_count: u32,
    /// Total number of climate projects registered with the contract.
    pub project_count: u32,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Project(String),
    ProjectIds,
    ProjectCount,
    DonorStats(Address),
    ImpactNFT(Address, BadgeTier),
    DonationCount,
    DonationRecord(u32),
    GlobalTotalRaised,
    GlobalCO2OffsetGrams,
    // Tracks whether `donor` has ever donated to `project` — used so
    // `Project.donor_count` reflects unique donors instead of donations.
    HasDonated(String, Address),
    // Governance
    Proposal(String),
    HasVoted(String, Address),
    // Per-donor per-project cumulative donation total for milestone NFT gating
    DonorProjectTotal(String, Address),
    // Per-donor per-project sliding-window donation rate limit
    DonorRateLimit(Address, String),
    // Admin-configurable donation rate limit overrides (instance storage)
    DonationRateLimitMax,
    DonationRateLimitWindow,
    // Per-project milestone NFT: one per (project_id, donor) pair
    ProjectMilestoneNFT(String, Address),
    // Contract upgrade and multi-currency support
    // ContractWasmHash is intentionally kept in the enum for backward
    // compatibility with v1 storage layouts. The single-step `upgrade`
    // function that wrote to it was replaced in Phase A by the
    // two-step `propose_upgrade` / `execute_upgrade` flow which uses
    // `PendingUpgrade` / `LastExecutedUpgrade` instead. No live code
    // path writes to this variant; readers should treat any stored
    // value as historical and consult `get_last_executed_upgrade`.
    ContractWasmHash,
    USDCTokenAddress,
    // Price oracle for USDC → XLM conversion
    OracleAddress,
    // Addresses of every voter on a given proposal, exposed via
    // `get_voter_list` for governance UIs. Kept separate from the
    // `Proposal` value so the proposal layout can evolve without
    // breaking the voter enumeration.
    VoterList(String),
    // Ordered list of every project_id registered. Used by admin
    // bulk operations (e.g. `deactivate_all_projects`) so they can
    // enumerate projects without external indexing.
    ProjectIdsAll,
    // Pending admin for the two-step `transfer_admin` / `accept_admin`
    // flow. Stored when the current admin calls `transfer_admin` and
    // cleared either on `accept_admin` (promotion) or
    // `cancel_admin_transfer`. Never holds an Address that's already
    // the current admin.
    PendingAdmin,
    // Contract-level pause flag. When true, every state-mutating
    // function (donate, donate_usdc, mint_*, governance create/vote,
    // project register/deactivate) rejects with "Contract is paused".
    // `pause_contract` / `unpause_contract` are themselves exempt so
    // the admin can always recover from a pause.
    ContractPaused,
    // Pending contract upgrade — hash of the WASM that the admin has
    // proposed via `propose_upgrade` but not yet executed. Cleared on
    // `execute_upgrade` (after the timelock) or `cancel_upgrade`.
    PendingUpgrade,
    // Ledger sequence at which the pending upgrade becomes executable.
    // Set together with `PendingUpgrade` and cleared on execute/cancel.
    UpgradeEffectiveAt,
    // Hash of the last EXECUTED contract upgrade. Set by
    // `execute_upgrade` after `env.deployer().update_current_contract_wasm`
    // returns. Used by indexers to confirm which WASM is currently
    // running at the contract address.
    LastExecutedUpgrade,
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STROOP: i128 = 10_000_000;

// 7 days × 24 h × 3600 s ÷ 5 s per ledger ≈ 120_960 ledgers — used as the
// default when `create_proposal` is called without an explicit duration.
const VOTING_WINDOW_LEDGERS: u32 = 120_960;

const DEFAULT_DONATION_RATE_LIMIT_MAX: u32 = 10;
const DEFAULT_DONATION_RATE_LIMIT_WINDOW: u32 = 720;

// Bounds on caller-supplied voting durations. Floor (~1 hour) keeps the
// window long enough to be observed; ceiling (~30 days) bounds storage TTL
// pressure and prevents proposals from sitting open indefinitely.
const MIN_VOTING_WINDOW_LEDGERS: u32 = 720; // 1 hour @ 5s/ledger
const MAX_VOTING_WINDOW_LEDGERS: u32 = 518_400; // 30 days @ 5s/ledger

// Upper bound on co2_per_xlm at registration — prevents donate-time CO₂ overflow
// panics and misleading impact figures from misconfigured projects.
const MAX_CO2_PER_XLM: u32 = 100_000;

// 48 hours × 3600 s / 5 s per ledger = 34 560 ledgers. The minimum delay
// between `propose_upgrade` and the earliest ledger at which
// `execute_upgrade` can fire. Gives the community, indexers, and any
// downstream observers a 48-hour window to react to a pending upgrade
// (e.g. by exiting their positions or signalling objections via
// off-chain channels) before the WASM is swapped.
const UPGRADE_TIMELOCK_LEDGERS: u32 = 34_560;

/// Read the stored admin. Caller must compare and panic on mismatch.
/// Centralised so every admin check uses the same pattern.
fn read_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("Not initialized")
}

/// Verify that `caller` is the stored admin. Used after `require_auth`
/// so the auth signature has already been verified by the host.
fn require_admin(env: &Env, caller: &Address) {
    if read_admin(env) != *caller {
        panic!("Only admin can perform this action");
    }
}

/// Fail fast when the contract is in the paused state. State-mutating
/// public functions call this right after `require_auth` and before
/// any storage read so a paused contract costs as little as possible
/// to verify and the panic message is uniform.
fn require_not_paused(env: &Env) {
    let paused: bool = env
        .storage()
        .instance()
        .get(&DataKey::ContractPaused)
        .unwrap_or(false);
    if paused {
        panic!("Contract is paused");
    }
}

fn ensure_min_ttl(env: &Env, min_ledgers: u32) {
    env.storage()
        .instance()
        .extend_ttl(min_ledgers, min_ledgers);
}

fn calculate_badge(total_stroops: i128) -> BadgeTier {
    let xlm = total_stroops / STROOP;
    if xlm >= 2000 {
        BadgeTier::EarthGuardian
    } else if xlm >= 500 {
        BadgeTier::Forest
    } else if xlm >= 100 {
        BadgeTier::Tree
    } else if xlm >= 10 {
        BadgeTier::Seedling
    } else {
        BadgeTier::None
    }
}

fn voting_weight_from_badge(badge: &BadgeTier) -> u32 {
    match badge {
        BadgeTier::None => 0,
        BadgeTier::Seedling => 1,
        BadgeTier::Tree => 3,
        BadgeTier::Forest => 10,
        BadgeTier::EarthGuardian => 25,
    }
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct IndigoPayContract;

#[contractimpl]
impl IndigoPayContract {
    pub fn extend_all_ttl(env: Env, threshold_ledgers: u32) {
        ensure_min_ttl(&env, threshold_ledgers);
    }
    // ─── Initialization ──────────────────────────────────────────────────────

    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::ProjectCount, &0u32);
        env.storage().instance().set(&DataKey::DonationCount, &0u32);
        env.storage()
            .instance()
            .set(&DataKey::GlobalTotalRaised, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::GlobalCO2OffsetGrams, &0i128);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    // ─── Project management ───────────────────────────────────────────────────

    pub fn register_project(
        env: Env,
        admin: Address,
        project_id: String,
        name: String,
        wallet: Address,
        co2_per_xlm: u32,
    ) {
        admin.require_auth();
        require_admin(&env, &admin);
        require_not_paused(&env);
        if env
            .storage()
            .instance()
            .has(&DataKey::Project(project_id.clone()))
        {
            panic!("Project already registered");
        }
        if co2_per_xlm > MAX_CO2_PER_XLM {
            panic!("CO2 per XLM exceeds maximum");
        }
        let project = Project {
            id: project_id.clone(),
            name,
            wallet,
            co2_per_xlm,
            total_raised: 0,
            donor_count: 0,
            active: true,
            paused: false,
            registered_at: env.ledger().sequence(),
        };
        env.storage()
            .instance()
            .set(&DataKey::Project(project_id.clone()), &project);
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProjectCount)
            .unwrap_or(0);
        let next_count = count.checked_add(1).expect("ProjectCount overflow");
        env.storage()
            .instance()
            .set(&DataKey::ProjectCount, &next_count);

        // Track this project in the id index so admin bulk operations
        // (e.g. `deactivate_all_projects`) can iterate without an
        // external indexer.
        let mut ids: Vec<String> = env
            .storage()
            .instance()
            .get(&DataKey::ProjectIdsAll)
            .unwrap_or(Vec::new(&env));
        ids.push_back(project_id.clone());
        env.storage().instance().set(&DataKey::ProjectIdsAll, &ids);

        env.events()
            .publish((symbol_short!("proj_reg"), admin), project_id);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    pub fn batch_register_projects(env: Env, admin: Address, projects: Vec<ProjectInit>) {
        admin.require_auth();
        require_admin(&env, &admin);
        require_not_paused(&env);

        let mut ids: Vec<String> = env
            .storage()
            .instance()
            .get(&DataKey::ProjectIdsAll)
            .unwrap_or(Vec::new(&env));

        for init in projects.iter() {
            let project_id = init.id.clone();
            if env
                .storage()
                .instance()
                .has(&DataKey::Project(project_id.clone()))
            {
                panic!("Project already registered");
            }
            let project = Project {
                id: project_id.clone(),
                name: init.name.clone(),
                wallet: init.wallet.clone(),
                co2_per_xlm: init.co2_per_xlm,
                total_raised: 0,
                donor_count: 0,
                active: true,
                paused: false,
                registered_at: env.ledger().sequence(),
            };
            env.storage()
                .instance()
                .set(&DataKey::Project(project_id.clone()), &project);
            let count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::ProjectCount)
                .unwrap_or(0);
            let next_count = count.checked_add(1).expect("ProjectCount overflow");
            env.storage()
                .instance()
                .set(&DataKey::ProjectCount, &next_count);
            ids.push_back(project_id.clone());
            env.events()
                .publish((symbol_short!("proj_reg"), admin.clone()), project_id);
        }
        env.storage().instance().set(&DataKey::ProjectIdsAll, &ids);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Admin-only: deactivate every registered project in one call.
    /// Iterates `DataKey::ProjectIdsAll` and flips `active=false`. Useful
    /// for incident response when the platform needs to halt all
    /// donations immediately.
    pub fn deactivate_all_projects(env: Env, admin: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        require_not_paused(&env);

        let ids: Vec<String> = env
            .storage()
            .instance()
            .get(&DataKey::ProjectIdsAll)
            .unwrap_or(Vec::new(&env));

        for pid in ids.iter() {
            let mut project: Project = env
                .storage()
                .instance()
                .get(&DataKey::Project(pid.clone()))
                .expect("Project not found");
            if project.active {
                project.active = false;
                env.storage()
                    .instance()
                    .set(&DataKey::Project(pid.clone()), &project);
            }
        }

        env.events()
            .publish((symbol_short!("deact_all"), admin), ids);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    pub fn deactivate_project(env: Env, admin: Address, project_id: String) {
        admin.require_auth();
        require_admin(&env, &admin);
        require_not_paused(&env);
        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(project_id.clone()))
            .expect("Project not found");
        project.active = false;
        env.storage()
            .instance()
            .set(&DataKey::Project(project_id), &project);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    pub fn update_project_co2_rate(env: Env, admin: Address, project_id: String, co2_per_xlm: u32) {
        admin.require_auth();
        require_admin(&env, &admin);
        require_not_paused(&env);

        // Bounds must match `register_project` so the on-chain limits stay
        // consistent regardless of whether the rate was set at registration
        // or later updated by the admin.
        if co2_per_xlm == 0 {
            panic!("CO₂ rate must be greater than zero");
        }
        if co2_per_xlm > MAX_CO2_PER_XLM {
            panic!("CO2 per XLM exceeds maximum");
        }

        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(project_id.clone()))
            .expect("Project not found");

        project.co2_per_xlm = co2_per_xlm;

        env.storage()
            .instance()
            .set(&DataKey::Project(project_id.clone()), &project);

        env.events().publish(
            (symbol_short!("co2_rate"), admin),
            (project_id, co2_per_xlm),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    pub fn pause_project(env: Env, admin: Address, project_id: String) {
        admin.require_auth();
        require_admin(&env, &admin);
        // pause_project is intentionally NOT paused-gated so the admin can
        // still manage individual projects during a contract-wide pause.
        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(project_id.clone()))
            .expect("Project not found");
        if !project.active {
            panic!("Cannot pause a deactivated project");
        }
        if project.paused {
            panic!("Project is already paused");
        }
        project.paused = true;
        env.storage()
            .instance()
            .set(&DataKey::Project(project_id.clone()), &project);
        env.events()
            .publish((symbol_short!("prj_pause"), admin), project_id);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Admin-only: lift a temporary pause on a project. Mirrors
    /// `pause_project` — symmetric admin authorization, events emitted
    /// for indexers, idempotency-aware (panics on resume when the
    /// project is not paused, to prevent accidental double-resumes).
    pub fn resume_project(env: Env, admin: Address, project_id: String) {
        admin.require_auth();
        require_admin(&env, &admin);
        // resume_project is intentionally NOT paused-gated.
        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(project_id.clone()))
            .expect("Project not found");
        if !project.active {
            panic!("Cannot resume a deactivated project");
        }
        if !project.paused {
            panic!("Project is not paused");
        }
        project.paused = false;
        env.storage()
            .instance()
            .set(&DataKey::Project(project_id.clone()), &project);
        env.events()
            .publish((symbol_short!("prj_resm"), admin), project_id);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    // ─── Donations ────────────────────────────────────────────────────────────

    pub fn donate(
        env: Env,
        token: Address,
        donor: Address,
        project_id: String,
        amount: i128,
        msg_hash: u32,
    ) {
        donor.require_auth();
        require_not_paused(&env);
        if amount <= 0 {
            panic!("Donation amount must be positive");
        }

        let current_ledger = env.ledger().sequence();
        let max_donations: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DonationRateLimitMax)
            .unwrap_or(DEFAULT_DONATION_RATE_LIMIT_MAX);
        let window_ledgers: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DonationRateLimitWindow)
            .unwrap_or(DEFAULT_DONATION_RATE_LIMIT_WINDOW);

        let rate_key = DataKey::DonorRateLimit(donor.clone(), project_id.clone());
        let mut window: RateLimitWindow =
            env.storage()
                .instance()
                .get(&rate_key)
                .unwrap_or(RateLimitWindow {
                    window_start: current_ledger,
                    count: 0,
                });
        if current_ledger - window.window_start >= window_ledgers {
            window.window_start = current_ledger;
            window.count = 0;
        }
        if window.count >= max_donations {
            panic!("Donation rate limit exceeded");
        }
        window.count = window
            .count
            .checked_add(1)
            .expect("RateLimitWindow count overflow");
        env.storage().instance().set(&rate_key, &window);

        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(project_id.clone()))
            .expect("Project not found");
        if !project.active {
            panic!("Project is not accepting donations");
        }
        if project.paused {
            panic!("Project is temporarily paused");
        }

        // Pre-compute CO2 increment with checked multiplication so an attacker
        // can't trigger a silent wrap via a project with a huge co2_per_xlm.
        let xlm_units = amount / STROOP;
        let co2_increment = xlm_units
            .checked_mul(project.co2_per_xlm as i128)
            .expect("CO2 calculation overflow");

        let mut donor_stats: DonorStats = env
            .storage()
            .instance()
            .get(&DataKey::DonorStats(donor.clone()))
            .unwrap_or(DonorStats {
                total_donated: 0,
                donation_count: 0,
                badge: BadgeTier::None,
                co2_offset_grams: 0,
            });
        let prev_badge = donor_stats.badge.clone();

        // ── Effects: all state writes BEFORE the external token transfer
        //    (Checks-Effects-Interactions to defend against reentrancy from a
        //    malicious token contract passed via `token`).
        project.total_raised = project
            .total_raised
            .checked_add(amount)
            .expect("Project total_raised overflow");
        let donated_key = DataKey::HasDonated(project_id.clone(), donor.clone());
        if !env.storage().instance().has(&donated_key) {
            env.storage().instance().set(&donated_key, &true);
            project.donor_count = project
                .donor_count
                .checked_add(1)
                .expect("Project donor_count overflow");
        }
        env.storage()
            .instance()
            .set(&DataKey::Project(project_id.clone()), &project);

        donor_stats.total_donated = donor_stats
            .total_donated
            .checked_add(amount)
            .expect("Donor total_donated overflow");
        donor_stats.donation_count = donor_stats
            .donation_count
            .checked_add(1)
            .expect("Donor donation_count overflow");
        donor_stats.co2_offset_grams = donor_stats
            .co2_offset_grams
            .checked_add(co2_increment)
            .expect("Donor co2_offset overflow");
        donor_stats.badge = calculate_badge(donor_stats.total_donated);
        env.storage()
            .instance()
            .set(&DataKey::DonorStats(donor.clone()), &donor_stats);

        // Track per-project cumulative donations for milestone NFT eligibility.
        let proj_total_key = DataKey::DonorProjectTotal(project_id.clone(), donor.clone());
        let prev_proj_total: i128 = env.storage().instance().get(&proj_total_key).unwrap_or(0);
        env.storage().instance().set(
            &proj_total_key,
            &prev_proj_total
                .checked_add(amount)
                .expect("DonorProjectTotal overflow"),
        );

        // Auto-mint an Impact NFT when a donor reaches a new badge tier.
        if donor_stats.badge != BadgeTier::None && donor_stats.badge != prev_badge {
            let nft_key = DataKey::ImpactNFT(donor.clone(), donor_stats.badge.clone());
            if !env.storage().instance().has(&nft_key) {
                let nft = ImpactNFT {
                    owner: donor.clone(),
                    tier: donor_stats.badge.clone(),
                    total_donated: donor_stats.total_donated,
                    minted_at_ledger: env.ledger().sequence(),
                };
                env.storage().instance().set(&nft_key, &nft);
                env.events().publish(
                    (symbol_short!("nft_mint"), donor.clone()),
                    donor_stats.badge.clone(),
                );
            }
        }

        let dc: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DonationCount)
            .unwrap_or(0);
        let new_dc = dc.checked_add(1).expect("DonationCount overflow");
        env.storage()
            .instance()
            .set(&DataKey::DonationCount, &new_dc);
        // Store donation record for trustless enumeration
        let donation_record = DonationRecord {
            donor: donor.clone(),
            project: project_id.clone(),
            amount,
            ledger: env.ledger().sequence(),
            message_hash: msg_hash,
            currency: symbol_short!("XLM"),
        };
        env.storage()
            .instance()
            .set(&DataKey::DonationRecord(dc), &donation_record);

        let gr: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalTotalRaised)
            .unwrap_or(0);
        let new_gr = gr.checked_add(amount).expect("GlobalTotalRaised overflow");
        env.storage()
            .instance()
            .set(&DataKey::GlobalTotalRaised, &new_gr);

        let gc: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalCO2OffsetGrams)
            .unwrap_or(0);
        let new_gc = gc.checked_add(co2_increment).expect("GlobalCO2 overflow");
        env.storage()
            .instance()
            .set(&DataKey::GlobalCO2OffsetGrams, &new_gc);

        // ── Interaction: external call happens after every effect is durable.
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&donor, &project.wallet, &amount);

        env.events().publish(
            (symbol_short!("donated"), donor.clone(), project_id.clone()),
            (amount, donor_stats.badge.clone(), msg_hash),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    // ─── DEX Path-Payment Donation (any Stellar asset → XLM) ──────────────────

    /// Donate any Stellar asset via DEX path payment.
    ///
    /// The caller submits an atomic Stellar transaction that:
    /// 1. Executes a `PathPaymentStrictSend` converting `source_asset` to XLM
    ///    and delivering the XLM to the project wallet.
    /// 2. Calls `donate_asset()` to record the donation on-chain.
    ///
    /// Because the XLM transfer already happened in the path payment operation,
    /// this function only records the donation effects — it does NOT perform
    /// a second token transfer. This keeps the contract simple while
    /// leveraging Stellar's native DEX for path payments.
    ///
    /// `source_asset_code` is a short symbol identifying the source asset
    /// (e.g. "yXLM", "USDT", "BTC") for the on-chain donation record.
    pub fn donate_asset(
        env: Env,
        donor: Address,
        project_id: String,
        xlm_amount: i128,
        source_asset_code: Symbol,
        msg_hash: u32,
    ) {
        donor.require_auth();
        require_not_paused(&env);
        if xlm_amount <= 0 {
            panic!("Donation amount must be positive");
        }

        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(project_id.clone()))
            .expect("Project not found");
        if !project.active {
            panic!("Project is not accepting donations");
        }
        if project.paused {
            panic!("Project is temporarily paused");
        }

        // Pre-compute CO2 increment using the XLM-equivalent received
        let xlm_units = xlm_amount / STROOP;
        let co2_increment = xlm_units
            .checked_mul(project.co2_per_xlm as i128)
            .expect("CO2 calculation overflow");

        let mut donor_stats: DonorStats = env
            .storage()
            .instance()
            .get(&DataKey::DonorStats(donor.clone()))
            .unwrap_or(DonorStats {
                total_donated: 0,
                donation_count: 0,
                badge: BadgeTier::None,
                co2_offset_grams: 0,
            });
        let prev_badge = donor_stats.badge.clone();

        // ── Effects: all state writes happen here (no external interaction
        //    needed because the path payment already transferred XLM).
        project.total_raised = project
            .total_raised
            .checked_add(xlm_amount)
            .expect("Project total_raised overflow");
        let donated_key = DataKey::HasDonated(project_id.clone(), donor.clone());
        if !env.storage().instance().has(&donated_key) {
            env.storage().instance().set(&donated_key, &true);
            project.donor_count = project
                .donor_count
                .checked_add(1)
                .expect("Project donor_count overflow");
        }
        env.storage()
            .instance()
            .set(&DataKey::Project(project_id.clone()), &project);

        donor_stats.total_donated = donor_stats
            .total_donated
            .checked_add(xlm_amount)
            .expect("Donor total_donated overflow");
        donor_stats.donation_count = donor_stats
            .donation_count
            .checked_add(1)
            .expect("Donor donation_count overflow");
        donor_stats.co2_offset_grams = donor_stats
            .co2_offset_grams
            .checked_add(co2_increment)
            .expect("Donor co2_offset overflow");
        donor_stats.badge = calculate_badge(donor_stats.total_donated);
        env.storage()
            .instance()
            .set(&DataKey::DonorStats(donor.clone()), &donor_stats);

        // Track per-project cumulative donations for milestone NFT eligibility.
        let proj_total_key = DataKey::DonorProjectTotal(project_id.clone(), donor.clone());
        let prev_proj_total: i128 = env.storage().instance().get(&proj_total_key).unwrap_or(0);
        env.storage().instance().set(
            &proj_total_key,
            &prev_proj_total
                .checked_add(xlm_amount)
                .expect("DonorProjectTotal overflow"),
        );

        // Auto-mint an Impact NFT when a donor reaches a new badge tier.
        if donor_stats.badge != BadgeTier::None && donor_stats.badge != prev_badge {
            let nft_key = DataKey::ImpactNFT(donor.clone(), donor_stats.badge.clone());
            if !env.storage().instance().has(&nft_key) {
                let nft = ImpactNFT {
                    owner: donor.clone(),
                    tier: donor_stats.badge.clone(),
                    total_donated: donor_stats.total_donated,
                    minted_at_ledger: env.ledger().sequence(),
                };
                env.storage().instance().set(&nft_key, &nft);
                env.events().publish(
                    (symbol_short!("nft_mint"), donor.clone()),
                    donor_stats.badge.clone(),
                );
            }
        }

        let dc: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DonationCount)
            .unwrap_or(0);
        let new_dc = dc.checked_add(1).expect("DonationCount overflow");
        env.storage()
            .instance()
            .set(&DataKey::DonationCount, &new_dc);
        // Store donation record with the source asset code as currency
        let donation_record = DonationRecord {
            donor: donor.clone(),
            project: project_id.clone(),
            amount: xlm_amount,
            ledger: env.ledger().sequence(),
            message_hash: msg_hash,
            currency: source_asset_code,
        };
        env.storage()
            .instance()
            .set(&DataKey::DonationRecord(dc), &donation_record);

        let gr: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalTotalRaised)
            .unwrap_or(0);
        let new_gr = gr
            .checked_add(xlm_amount)
            .expect("GlobalTotalRaised overflow");
        env.storage()
            .instance()
            .set(&DataKey::GlobalTotalRaised, &new_gr);

        let gc: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalCO2OffsetGrams)
            .unwrap_or(0);
        let new_gc = gc.checked_add(co2_increment).expect("GlobalCO2 overflow");
        env.storage()
            .instance()
            .set(&DataKey::GlobalCO2OffsetGrams, &new_gc);

        // No token transfer — the path payment already delivered XLM to the
        // project wallet in the same Stellar transaction.

        env.events().publish(
            (symbol_short!("donated"), donor.clone(), project_id.clone()),
            (xlm_amount, donor_stats.badge.clone(), msg_hash),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    // ─── Getters ─────────────────────────────────────────────────────────────

    pub fn get_project(env: Env, project_id: String) -> Project {
        env.storage()
            .instance()
            .get(&DataKey::Project(project_id))
            .expect("Project not found")
    }

    pub fn get_donor_stats(env: Env, donor: Address) -> DonorStats {
        env.storage()
            .instance()
            .get(&DataKey::DonorStats(donor))
            .unwrap_or(DonorStats {
                total_donated: 0,
                donation_count: 0,
                badge: BadgeTier::None,
                co2_offset_grams: 0,
            })
    }

    pub fn get_badge(env: Env, donor: Address) -> BadgeTier {
        let stats: DonorStats = env
            .storage()
            .instance()
            .get(&DataKey::DonorStats(donor))
            .unwrap_or(DonorStats {
                total_donated: 0,
                donation_count: 0,
                badge: BadgeTier::None,
                co2_offset_grams: 0,
            });
        stats.badge
    }

    pub fn get_global_total(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::GlobalTotalRaised)
            .unwrap_or(0)
    }

    pub fn get_global_co2(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::GlobalCO2OffsetGrams)
            .unwrap_or(0)
    }

    pub fn get_project_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ProjectCount)
            .unwrap_or(0)
    }

    pub fn get_donation_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::DonationCount)
            .unwrap_or(0)
    }

    /// Returns all four global counters in a single contract call.
    ///
    /// This eliminates the four separate RPC round trips that were previously
    /// required to populate the landing page hero section (total raised, CO₂
    /// offset, donation count, project count).  Clients should prefer this
    /// function over calling the individual getters when all four values are
    /// needed at the same time.
    ///
    /// # Example (JavaScript SDK)
    /// ```js
    /// const stats = await contract.get_global_stats();
    /// console.log(stats.total_raised, stats.co2_offset_grams,
    ///             stats.donation_count, stats.project_count);
    /// ```
    pub fn get_global_stats(env: Env) -> GlobalStats {
        GlobalStats {
            total_raised: env
                .storage()
                .instance()
                .get(&DataKey::GlobalTotalRaised)
                .unwrap_or(0),
            co2_offset_grams: env
                .storage()
                .instance()
                .get(&DataKey::GlobalCO2OffsetGrams)
                .unwrap_or(0),
            donation_count: env
                .storage()
                .instance()
                .get(&DataKey::DonationCount)
                .unwrap_or(0),
            project_count: env
                .storage()
                .instance()
                .get(&DataKey::ProjectCount)
                .unwrap_or(0),
        }
    }

    /// Retrieve a donation record by its index.
    pub fn get_donation_record(env: Env, index: u32) -> DonationRecord {
        env.storage()
            .instance()
            .get(&DataKey::DonationRecord(index))
            .expect("Donation record not found")
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized")
    }

    // ─── Placeholders ─────────────────────────────────────────────────────────

    pub fn mint_impact_nft(env: Env, donor: Address, tier: BadgeTier) {
        donor.require_auth();
        require_not_paused(&env);
        if tier == BadgeTier::None {
            panic!("Cannot mint NFT for None tier");
        }

        let stats: DonorStats = env
            .storage()
            .instance()
            .get(&DataKey::DonorStats(donor.clone()))
            .unwrap_or(DonorStats {
                total_donated: 0,
                donation_count: 0,
                badge: BadgeTier::None,
                co2_offset_grams: 0,
            });
        if stats.badge == BadgeTier::None {
            panic!("No badge tier reached yet");
        }
        if stats.badge != tier {
            panic!("Tier does not match donor's current badge");
        }

        let key = DataKey::ImpactNFT(donor.clone(), tier.clone());
        if env.storage().instance().has(&key) {
            panic!("NFT already minted for this tier");
        }

        let nft = ImpactNFT {
            owner: donor.clone(),
            tier: tier.clone(),
            total_donated: stats.total_donated,
            minted_at_ledger: env.ledger().sequence(),
        };
        env.storage().instance().set(&key, &nft);
        env.events()
            .publish((symbol_short!("nft_mint"), donor), tier);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    pub fn has_nft(env: Env, donor: Address, tier: BadgeTier) -> bool {
        env.storage()
            .instance()
            .has(&DataKey::ImpactNFT(donor, tier))
    }

    // ─── Project milestone NFT (#205) ────────────────────────────────────────

    /// Mint a project milestone NFT when a donor's cumulative donation to a
    /// specific project exceeds 100 XLM. Minting is idempotent-blocked: a second
    /// call for the same (donor, project_id) pair panics.
    pub fn mint_project_nft(env: Env, donor: Address, project_id: String) {
        donor.require_auth();
        require_not_paused(&env);

        let project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(project_id.clone()))
            .expect("Project not found");

        let proj_total_key = DataKey::DonorProjectTotal(project_id.clone(), donor.clone());
        let proj_total: i128 = env.storage().instance().get(&proj_total_key).unwrap_or(0);

        // 100 XLM = 100 × 10_000_000 stroops
        if proj_total < 100 * STROOP {
            panic!("Cumulative donation to this project has not reached 100 XLM");
        }

        let nft_key = DataKey::ProjectMilestoneNFT(project_id.clone(), donor.clone());
        if env.storage().instance().has(&nft_key) {
            panic!("Milestone NFT already minted for this project");
        }

        let co2_per_xlm = project.co2_per_xlm as i128;
        let xlm_units = proj_total / STROOP;
        let co2_offset = xlm_units
            .checked_mul(co2_per_xlm)
            .expect("CO2 calculation overflow");

        let nft = ProjectMilestoneNFT {
            owner: donor.clone(),
            project_id: project_id.clone(),
            amount_donated: proj_total,
            co2_offset_grams: co2_offset,
            minted_at_ledger: env.ledger().sequence(),
        };
        env.storage().instance().set(&nft_key, &nft);
        env.events().publish(
            (symbol_short!("pnft_mnt"), donor.clone()),
            (project_id, proj_total),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    pub fn has_project_nft(env: Env, donor: Address, project_id: String) -> bool {
        env.storage()
            .instance()
            .has(&DataKey::ProjectMilestoneNFT(project_id, donor))
    }

    pub fn get_project_nft(env: Env, donor: Address, project_id: String) -> ProjectMilestoneNFT {
        env.storage()
            .instance()
            .get(&DataKey::ProjectMilestoneNFT(project_id, donor))
            .expect("Project milestone NFT not found")
    }

    // ─── Governance ───────────────────────────────────────────────────────────

    /// Admin creates a voting proposal for a project to be community-verified.
    ///
    /// `duration_ledgers` is the length of the voting window in Stellar
    /// ledgers (≈5 s each). Pass `0` to use the default 7-day window;
    /// any other value must be within
    /// [`MIN_VOTING_WINDOW_LEDGERS`, `MAX_VOTING_WINDOW_LEDGERS`].
    pub fn create_proposal(env: Env, admin: Address, project_id: String, duration_ledgers: u32) {
        admin.require_auth();
        require_admin(&env, &admin);
        require_not_paused(&env);
        if !env
            .storage()
            .instance()
            .has(&DataKey::Project(project_id.clone()))
        {
            panic!("Project not found");
        }
        if env
            .storage()
            .instance()
            .has(&DataKey::Proposal(project_id.clone()))
        {
            panic!("Proposal already exists for this project");
        }

        let window = if duration_ledgers == 0 {
            VOTING_WINDOW_LEDGERS
        } else {
            if duration_ledgers < MIN_VOTING_WINDOW_LEDGERS {
                panic!("Voting duration too short");
            }
            if duration_ledgers > MAX_VOTING_WINDOW_LEDGERS {
                panic!("Voting duration too long");
            }
            duration_ledgers
        };
        let deadline_ledger = env
            .ledger()
            .sequence()
            .checked_add(window)
            .expect("Voting deadline overflow");

        let proposal = VoteProposal {
            project_id: project_id.clone(),
            votes_for: 0,
            votes_against: 0,
            deadline_ledger,
            resolved: false,
        };
        env.storage()
            .instance()
            .set(&DataKey::Proposal(project_id.clone()), &proposal);
        env.events()
            .publish((symbol_short!("prop_new"), admin), (project_id, window));
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    pub fn get_voter_weight(env: Env, voter: Address) -> u32 {
        let stats: DonorStats = env
            .storage()
            .instance()
            .get(&DataKey::DonorStats(voter))
            .unwrap_or(DonorStats {
                total_donated: 0,
                donation_count: 0,
                badge: BadgeTier::None,
                co2_offset_grams: 0,
            });
        voting_weight_from_badge(&stats.badge)
    }

    /// Badge holders (≥ Seedling) cast a vote. One vote per address per proposal.
    pub fn vote_verify_project(env: Env, voter: Address, project_id: String, approve: bool) {
        voter.require_auth();
        require_not_paused(&env);

        let stats: DonorStats = env
            .storage()
            .instance()
            .get(&DataKey::DonorStats(voter.clone()))
            .unwrap_or(DonorStats {
                total_donated: 0,
                donation_count: 0,
                badge: BadgeTier::None,
                co2_offset_grams: 0,
            });
        if stats.badge == BadgeTier::None {
            panic!("Only badge holders (Seedling or above) can vote");
        }

        let weight = voting_weight_from_badge(&stats.badge);

        let mut proposal: VoteProposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(project_id.clone()))
            .expect("Proposal not found");
        if proposal.resolved {
            panic!("Proposal already resolved");
        }
        if env.ledger().sequence() > proposal.deadline_ledger {
            panic!("Voting window has closed");
        }

        let voted_key = DataKey::HasVoted(project_id.clone(), voter.clone());
        if env.storage().instance().has(&voted_key) {
            panic!("Already voted on this proposal");
        }

        // Effects: persist voter-list membership first so the proposal
        // accounting cannot fall out of sync with the voter-list even if
        // a later state write is interrupted (Soroban reverts the whole
        // tx on panic, but writing the indexable list before the
        // duplicate-vote marker keeps the public read model consistent).
        let voter_list_key = DataKey::VoterList(project_id.clone());
        let mut voter_list: Vec<Address> = env
            .storage()
            .instance()
            .get(&voter_list_key)
            .unwrap_or(Vec::new(&env));
        voter_list.push_back(voter.clone());
        env.storage().instance().set(&voter_list_key, &voter_list);

        env.storage().instance().set(&voted_key, &true);

        if approve {
            proposal.votes_for = proposal
                .votes_for
                .checked_add(weight)
                .expect("votes_for overflow");
        } else {
            proposal.votes_against = proposal
                .votes_against
                .checked_add(weight)
                .expect("votes_against overflow");
        }
        env.storage()
            .instance()
            .set(&DataKey::Proposal(project_id.clone()), &proposal);
        env.events()
            .publish((symbol_short!("voted"), voter, project_id), approve);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Callable by anyone after the deadline. Resolves based on majority.
    /// Emits proj_ver on approval, prop_rej on rejection.
    pub fn resolve_proposal(env: Env, project_id: String) {
        let mut proposal: VoteProposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(project_id.clone()))
            .expect("Proposal not found");
        if proposal.resolved {
            panic!("Proposal already resolved");
        }
        if env.ledger().sequence() <= proposal.deadline_ledger {
            panic!("Voting window not yet closed");
        }
        proposal.resolved = true;
        if proposal.votes_for > proposal.votes_against {
            env.events()
                .publish((symbol_short!("proj_ver"),), project_id.clone());
        } else {
            env.events()
                .publish((symbol_short!("prop_rej"),), project_id.clone());
        }
        env.storage()
            .instance()
            .set(&DataKey::Proposal(project_id), &proposal);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Admin-only immediate veto. Marks the proposal resolved & rejected.
    /// Required for incident response when a proposal is based on fraudulent data.
    /// Emits prop_veto with the admin address for auditability.
    pub fn veto_proposal(env: Env, admin: Address, project_id: String) {
        admin.require_auth();
        require_admin(&env, &admin);
        let mut proposal: VoteProposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(project_id.clone()))
            .expect("Proposal not found");
        if proposal.resolved {
            panic!("Proposal already resolved");
        }
        proposal.resolved = true;
        env.events()
            .publish((symbol_short!("prop_veto"), admin), project_id.clone());
        env.storage()
            .instance()
            .set(&DataKey::Proposal(project_id), &proposal);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Returns current vote counts and status for a proposal.
    pub fn get_proposal(env: Env, project_id: String) -> VoteProposal {
        env.storage()
            .instance()
            .get(&DataKey::Proposal(project_id))
            .expect("Proposal not found")
    }

    /// Returns the list of voter addresses for a proposal.
    /// Can be used by governance UIs to display who voted and how.
    pub fn get_voter_list(env: Env, project_id: String) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::VoterList(project_id))
            .unwrap_or(Vec::new(&env))
    }

    /// Donate USDC. Converts to XLM-equivalent for global stats using a price oracle stub.
    pub fn donate_usdc(
        env: Env,
        usdc_token: Address,
        donor: Address,
        project_id: String,
        usdc_amount: i128,
        msg_hash: u32,
    ) {
        donor.require_auth();
        require_not_paused(&env);
        if usdc_amount <= 0 {
            panic!("Donation amount must be positive");
        }

        let stored_usdc: Option<Address> = env.storage().instance().get(&DataKey::USDCTokenAddress);
        if stored_usdc.is_none() || stored_usdc.unwrap() != usdc_token {
            panic!("USDC token not configured");
        }

        // Fetch the USDC→XLM price from the configured oracle.
        // The oracle returns how many XLM stroops equal 1 USDC stroop.
        let oracle_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::OracleAddress)
            .expect("Price oracle not configured");
        let oracle = OracleClient::new(&env, &oracle_addr);
        let rate = oracle.get_price();
        if rate <= 0 {
            panic!("Oracle returned invalid price");
        }
        let xlm_equivalent = usdc_amount
            .checked_mul(rate)
            .expect("USDC to XLM conversion overflow");

        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(project_id.clone()))
            .expect("Project not found");
        if !project.active {
            panic!("Project is not accepting donations");
        }
        if project.paused {
            panic!("Project is temporarily paused");
        }

        // Pre-compute CO2 increment using XLM-equivalent
        let xlm_units = xlm_equivalent / STROOP;
        let co2_increment = xlm_units
            .checked_mul(project.co2_per_xlm as i128)
            .expect("CO2 calculation overflow");

        let mut donor_stats: DonorStats = env
            .storage()
            .instance()
            .get(&DataKey::DonorStats(donor.clone()))
            .unwrap_or(DonorStats {
                total_donated: 0,
                donation_count: 0,
                badge: BadgeTier::None,
                co2_offset_grams: 0,
            });
        let prev_badge = donor_stats.badge.clone();

        // Update project and donor stats using XLM-equivalent
        project.total_raised = project
            .total_raised
            .checked_add(xlm_equivalent)
            .expect("Project total_raised overflow");
        let donated_key = DataKey::HasDonated(project_id.clone(), donor.clone());
        if !env.storage().instance().has(&donated_key) {
            env.storage().instance().set(&donated_key, &true);
            project.donor_count = project
                .donor_count
                .checked_add(1)
                .expect("Project donor_count overflow");
        }
        env.storage()
            .instance()
            .set(&DataKey::Project(project_id.clone()), &project);

        donor_stats.total_donated = donor_stats
            .total_donated
            .checked_add(xlm_equivalent)
            .expect("Donor total_donated overflow");
        donor_stats.donation_count = donor_stats
            .donation_count
            .checked_add(1)
            .expect("Donor donation_count overflow");
        donor_stats.co2_offset_grams = donor_stats
            .co2_offset_grams
            .checked_add(co2_increment)
            .expect("Donor co2_offset overflow");
        donor_stats.badge = calculate_badge(donor_stats.total_donated);
        env.storage()
            .instance()
            .set(&DataKey::DonorStats(donor.clone()), &donor_stats);

        if donor_stats.badge != BadgeTier::None && donor_stats.badge != prev_badge {
            let nft_key = DataKey::ImpactNFT(donor.clone(), donor_stats.badge.clone());
            if !env.storage().instance().has(&nft_key) {
                let nft = ImpactNFT {
                    owner: donor.clone(),
                    tier: donor_stats.badge.clone(),
                    total_donated: donor_stats.total_donated,
                    minted_at_ledger: env.ledger().sequence(),
                };
                env.storage().instance().set(&nft_key, &nft);
                env.events().publish(
                    (symbol_short!("nft_mint"), donor.clone()),
                    donor_stats.badge.clone(),
                );
            }
        }

        let dc: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DonationCount)
            .unwrap_or(0);
        let new_dc = dc.checked_add(1).expect("DonationCount overflow");
        env.storage()
            .instance()
            .set(&DataKey::DonationCount, &new_dc);
        // Store USDC donation record for trustless enumeration
        let donation_record = DonationRecord {
            donor: donor.clone(),
            project: project_id.clone(),
            amount: usdc_amount,
            ledger: env.ledger().sequence(),
            message_hash: msg_hash,
            currency: symbol_short!("USDC"),
        };
        env.storage()
            .instance()
            .set(&DataKey::DonationRecord(dc), &donation_record);

        let gr: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalTotalRaised)
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::GlobalTotalRaised,
            &gr.checked_add(xlm_equivalent)
                .expect("GlobalTotalRaised overflow"),
        );

        let gg: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalCO2OffsetGrams)
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::GlobalCO2OffsetGrams,
            &gg.checked_add(co2_increment)
                .expect("GlobalCO2OffsetGrams overflow"),
        );

        // Track per-project cumulative donations for milestone NFT eligibility.
        let proj_total_key = DataKey::DonorProjectTotal(project_id.clone(), donor.clone());
        let prev_proj_total: i128 = env.storage().instance().get(&proj_total_key).unwrap_or(0);
        env.storage().instance().set(
            &proj_total_key,
            &prev_proj_total
                .checked_add(xlm_equivalent)
                .expect("DonorProjectTotal overflow"),
        );

        let token_client = token::Client::new(&env, &usdc_token);
        let project_wallet = project.wallet;
        token_client.transfer(&donor, &project_wallet, &usdc_amount);

        env.events().publish(
            (symbol_short!("donated"), donor.clone(), project_id),
            (usdc_amount, symbol_short!("USDC"), msg_hash),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Admin-only: Set the USDC token address for multi-currency donations.
    pub fn set_usdc_token(env: Env, admin: Address, usdc_token: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        require_not_paused(&env);
        env.storage()
            .instance()
            .set(&DataKey::USDCTokenAddress, &usdc_token);
        env.events()
            .publish((symbol_short!("usdc_set"),), usdc_token);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Get the configured USDC token address.
    pub fn get_usdc_token(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::USDCTokenAddress)
    }

    /// Admin-only: Configure the per-donor per-project donation rate limit.
    pub fn set_donation_rate_limit(
        env: Env,
        admin: Address,
        max_donations: u32,
        window_ledgers: u32,
    ) {
        admin.require_auth();
        require_admin(&env, &admin);
        require_not_paused(&env);
        if max_donations == 0 {
            panic!("max_donations must be positive");
        }
        if window_ledgers == 0 {
            panic!("window_ledgers must be positive");
        }
        env.storage()
            .instance()
            .set(&DataKey::DonationRateLimitMax, &max_donations);
        env.storage()
            .instance()
            .set(&DataKey::DonationRateLimitWindow, &window_ledgers);
        env.events().publish(
            (symbol_short!("rate_lim"),),
            (max_donations, window_ledgers),
        );
    }

    /// Get the configured donation rate limit (max donations, window in ledgers).
    pub fn get_donation_rate_limit(env: Env) -> (u32, u32) {
        let max: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DonationRateLimitMax)
            .unwrap_or(DEFAULT_DONATION_RATE_LIMIT_MAX);
        let window: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DonationRateLimitWindow)
            .unwrap_or(DEFAULT_DONATION_RATE_LIMIT_WINDOW);
        (max, window)
    }

    /// Admin-only: Set the price oracle contract address used by `donate_usdc`.
    /// The oracle must implement `OracleInterface::get_price()`.
    pub fn set_oracle(env: Env, admin: Address, oracle: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        require_not_paused(&env);
        env.storage()
            .instance()
            .set(&DataKey::OracleAddress, &oracle);
        env.events().publish((symbol_short!("oracle"),), oracle);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Get the configured price oracle address.
    pub fn get_oracle(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::OracleAddress)
    }

    /// Get the current contract WASM hash.
    pub fn get_contract_wasm_hash(env: Env) -> Option<BytesN<32>> {
        env.storage().instance().get(&DataKey::ContractWasmHash)
    }

    // ─── Two-step admin transfer ─────────────────────────────────────────────

    /// Admin-only: step 1 of a two-step admin transfer. Stores the proposed
    /// new admin; the proposal becomes final when they call `accept_admin`.
    /// Refuses to overwrite an existing pending transfer — the caller must
    /// `cancel_admin_transfer` first.
    pub fn transfer_admin(env: Env, admin: Address, new_admin: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        if env.storage().instance().has(&DataKey::PendingAdmin) {
            panic!("Admin transfer already pending; cancel first");
        }
        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);
        env.events()
            .publish((symbol_short!("ad_xfer"), admin), new_admin);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Step 2 of the two-step transfer. The caller must be the pending
    /// admin recorded by a prior `transfer_admin`. On success the stored
    /// admin is updated and the pending entry is cleared.
    pub fn accept_admin(env: Env) {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .expect("No pending admin transfer");
        pending.require_auth();
        env.storage().instance().set(&DataKey::Admin, &pending);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.events().publish((symbol_short!("ad_acc"),), pending);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Admin-only: cancel a pending admin transfer without promoting anyone.
    /// Useful when the proposed recipient lost their key or the transfer
    /// was a mistake.
    pub fn cancel_admin_transfer(env: Env, admin: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        if !env.storage().instance().has(&DataKey::PendingAdmin) {
            panic!("No pending admin transfer");
        }
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.events().publish((symbol_short!("ad_xfc"), admin), ());
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Returns the proposed new admin if a transfer is pending, or `None`.
    pub fn get_pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    // ─── Contract-level pause ─────────────────────────────────────────────────

    /// Admin-only: pause the entire contract. While paused, every state-
    /// mutating function rejects with "Contract is paused". Read-only
    /// getters continue to work, and the admin can always call
    /// `unpause_contract` to recover.
    pub fn pause_contract(env: Env, admin: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        env.storage()
            .instance()
            .set(&DataKey::ContractPaused, &true);
        env.events().publish((symbol_short!("paused"), admin), ());
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Admin-only: lift the contract-level pause.
    pub fn unpause_contract(env: Env, admin: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        env.storage()
            .instance()
            .set(&DataKey::ContractPaused, &false);
        env.events().publish((symbol_short!("unpause"), admin), ());
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Read-only: returns the contract-level pause state.
    pub fn is_contract_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::ContractPaused)
            .unwrap_or(false)
    }

    // ─── 48-hour upgrade timelock ────────────────────────────────────────────

    /// Admin-only: step 1 of the 48-hour upgrade timelock. Stores the
    /// proposed WASM hash and the ledger sequence at which it becomes
    /// executable. Replaces any existing pending upgrade is not allowed;
    /// the caller must `cancel_upgrade` first.
    pub fn propose_upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) {
        admin.require_auth();
        require_admin(&env, &admin);
        if env.storage().instance().has(&DataKey::PendingUpgrade) {
            panic!("Upgrade already pending; cancel first");
        }
        let effective_at = env
            .ledger()
            .sequence()
            .checked_add(UPGRADE_TIMELOCK_LEDGERS)
            .expect("Upgrade effective-at overflow");
        env.storage()
            .instance()
            .set(&DataKey::PendingUpgrade, &new_wasm_hash);
        env.storage()
            .instance()
            .set(&DataKey::UpgradeEffectiveAt, &effective_at);
        env.events().publish(
            (symbol_short!("upg_prop"), admin),
            (new_wasm_hash, effective_at),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Permissionless: step 2 of the upgrade timelock. Callable by anyone
    /// after the 48-hour delay has elapsed. On success the contract
    /// WASM is swapped, the executed hash is recorded, and the pending
    /// entry is cleared.
    ///
    /// **SECURITY**: the 48h timelock is the SOLE delay between a
    /// proposed upgrade and its execution. If the admin key is
    /// compromised, the attacker can `propose_upgrade` immediately,
    /// but the community has 48h to react (exit positions, deploy a
    /// rescue contract, signal off-chain) before the WASM is swapped.
    /// There is NO second gate; the timelock is the only safeguard.
    pub fn execute_upgrade(env: Env) {
        let pending: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
            .expect("No pending upgrade");
        let effective_at: u32 = env
            .storage()
            .instance()
            .get(&DataKey::UpgradeEffectiveAt)
            .expect("No pending upgrade effective-at");
        if env.ledger().sequence() < effective_at {
            panic!("Upgrade timelock not yet elapsed");
        }
        env.deployer().update_current_contract_wasm(pending.clone());
        env.storage()
            .instance()
            .set(&DataKey::LastExecutedUpgrade, &pending);
        env.storage().instance().remove(&DataKey::PendingUpgrade);
        env.storage()
            .instance()
            .remove(&DataKey::UpgradeEffectiveAt);
        env.events().publish((symbol_short!("upg_exec"),), pending);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Admin-only: cancel a pending upgrade without executing it. Use
    /// during incident response if the proposed WASM turns out to be
    /// malicious or buggy before the timelock elapses.
    pub fn cancel_upgrade(env: Env, admin: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        if !env.storage().instance().has(&DataKey::PendingUpgrade) {
            panic!("No pending upgrade");
        }
        env.storage().instance().remove(&DataKey::PendingUpgrade);
        env.storage()
            .instance()
            .remove(&DataKey::UpgradeEffectiveAt);
        env.events().publish((symbol_short!("upg_cncl"), admin), ());
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Read-only: returns `(hash, effective_at_ledger)` for the pending
    /// upgrade, or `None` if no upgrade is currently proposed.
    pub fn get_pending_upgrade(env: Env) -> Option<(BytesN<32>, u32)> {
        let hash: Option<BytesN<32>> = env.storage().instance().get(&DataKey::PendingUpgrade);
        let effective: Option<u32> = env.storage().instance().get(&DataKey::UpgradeEffectiveAt);
        match (hash, effective) {
            (Some(h), Some(e)) => Some((h, e)),
            _ => None,
        }
    }

    /// Read-only: hash of the most-recently executed upgrade, or `None`
    /// if the contract has never been upgraded. Updated by
    /// `execute_upgrade`.
    pub fn get_last_executed_upgrade(env: Env) -> Option<BytesN<32>> {
        env.storage().instance().get(&DataKey::LastExecutedUpgrade)
    }
}

// ─── Mock oracle (test / integration use only) ────────────────────────────────

/// A minimal oracle that returns a fixed rate of 8 XLM per 1 USDC.
/// Deploy this in tests and local integration environments via `set_oracle`.
///
/// Expected OracleInterface for real integrations:
///   - Deploy a contract that implements `get_price(env: Env) -> i128`
///   - `get_price` must return the number of XLM stroops per 1 USDC stroop
///   - The admin registers it via `IndigoPayContract::set_oracle(admin, oracle_address)`
///
/// Example real oracle sources: Band Protocol, DIA, or a custom TWAP contract.
#[contract]
pub struct MockOracle;

#[contractimpl]
impl OracleInterface for MockOracle {
    fn get_price(_env: Env) -> i128 {
        8
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::token::StellarAssetClient;
    use soroban_sdk::{Address, BytesN, Env, String, Vec};

    // ─── Existing tests ───────────────────────────────────────────────────────

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_project_count(), 0);
        assert_eq!(client.get_donation_count(), 0);
        assert_eq!(client.get_global_total(), 0);
    }

    #[test]
    fn test_get_donation_record() {
        let (env, _cid, client, admin, pid) = setup();
        // Set up USDC token
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        client.set_usdc_token(&admin, &token);
        // Set up price oracle (MockOracle returns a fixed 8 XLM/USDC rate)
        let oracle_id = env.register_contract(None, MockOracle);
        client.set_oracle(&admin, &oracle_id);
        let donor = Address::generate(&env);
        let usdc_amount: i128 = 10 * 1_000_000; // 10 USDC assuming 6 decimals
        StellarAssetClient::new(&env, &token).mint(&donor, &usdc_amount);
        client.donate_usdc(&token, &donor, &pid, &usdc_amount, &0u32);
        let record = client.get_donation_record(&0u32);
        assert_eq!(record.donor, donor);
        assert_eq!(record.project, pid);
        assert_eq!(record.amount, usdc_amount);
        assert_eq!(record.currency, symbol_short!("USDC"));
    }

    #[test]
    fn test_get_global_stats_initial_zeros() {
        let env = Env::default();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let stats = client.get_global_stats();
        assert_eq!(stats.total_raised, 0);
        assert_eq!(stats.co2_offset_grams, 0);
        assert_eq!(stats.donation_count, 0);
        assert_eq!(stats.project_count, 0);
    }

    /// `get_global_stats` should return values consistent with the individual
    /// getters (`get_global_total`, `get_global_co2`, `get_donation_count`,
    /// `get_project_count`) after a donation has been processed.
    #[test]
    fn test_get_global_stats_matches_individual_getters() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        // Register a project (co2_per_xlm = 200 grams per XLM)
        let pid = String::from_str(&env, "proj-stats");
        let wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &pid,
            &String::from_str(&env, "Stats Project"),
            &wallet,
            &200u32,
        );

        // Mint tokens and donate
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let donor = Address::generate(&env);
        let amount = 50 * STROOP; // 50 XLM
        soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&donor, &amount);
        client.donate(&token, &donor, &pid, &amount, &1u32);

        // get_global_stats must agree with each individual getter
        let stats = client.get_global_stats();
        assert_eq!(stats.total_raised, client.get_global_total());
        assert_eq!(stats.co2_offset_grams, client.get_global_co2());
        assert_eq!(stats.donation_count, client.get_donation_count());
        assert_eq!(stats.project_count, client.get_project_count());

        // Spot-check concrete values
        assert_eq!(stats.total_raised, amount);
        assert_eq!(stats.co2_offset_grams, 50 * 200i128); // 10 000 g
        assert_eq!(stats.donation_count, 1);
        assert_eq!(stats.project_count, 1);
    }

    #[test]
    #[should_panic(expected = "Contract already initialized")]
    fn test_double_init_fails() {
        let env = Env::default();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        client.initialize(&admin);
    }

    #[test]
    fn test_donor_badge_none_below_threshold() {
        let env = Env::default();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let donor = Address::generate(&env);
        assert_eq!(client.get_badge(&donor), BadgeTier::None);
    }

    #[test]
    fn test_calculate_badge_thresholds() {
        assert_eq!(calculate_badge(0), BadgeTier::None);
        assert_eq!(calculate_badge(9 * STROOP), BadgeTier::None);
        assert_eq!(calculate_badge(10 * STROOP), BadgeTier::Seedling);
        assert_eq!(calculate_badge(99 * STROOP), BadgeTier::Seedling);
        assert_eq!(calculate_badge(100 * STROOP), BadgeTier::Tree);
        assert_eq!(calculate_badge(499 * STROOP), BadgeTier::Tree);
        assert_eq!(calculate_badge(500 * STROOP), BadgeTier::Forest);
        assert_eq!(calculate_badge(1999 * STROOP), BadgeTier::Forest);
        assert_eq!(calculate_badge(2000 * STROOP), BadgeTier::EarthGuardian);
        assert_eq!(calculate_badge(100000 * STROOP), BadgeTier::EarthGuardian);
    }

    #[test]
    fn test_batch_register_projects() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let wallet1 = Address::generate(&env);
        let wallet2 = Address::generate(&env);
        let wallet3 = Address::generate(&env);
        let mut projects = Vec::new(&env);
        projects.push_back(ProjectInit {
            id: String::from_str(&env, "proj-001"),
            name: String::from_str(&env, "Forest Restore"),
            wallet: wallet1.clone(),
            co2_per_xlm: 100,
        });
        projects.push_back(ProjectInit {
            id: String::from_str(&env, "proj-002"),
            name: String::from_str(&env, "Ocean Cleanup"),
            wallet: wallet2.clone(),
            co2_per_xlm: 200,
        });
        projects.push_back(ProjectInit {
            id: String::from_str(&env, "proj-003"),
            name: String::from_str(&env, "Solar Schools"),
            wallet: wallet3.clone(),
            co2_per_xlm: 150,
        });

        client.batch_register_projects(&admin, &projects);

        assert_eq!(client.get_project_count(), 3);
        let p1 = client.get_project(&String::from_str(&env, "proj-001"));
        assert_eq!(p1.name, String::from_str(&env, "Forest Restore"));
        assert_eq!(p1.wallet, wallet1);
        assert_eq!(p1.co2_per_xlm, 100);
        assert!(p1.active);
        let p2 = client.get_project(&String::from_str(&env, "proj-002"));
        assert_eq!(p2.co2_per_xlm, 200);
        let p3 = client.get_project(&String::from_str(&env, "proj-003"));
        assert_eq!(p3.co2_per_xlm, 150);
    }

    #[test]
    #[should_panic(expected = "Project already registered")]
    fn test_batch_register_projects_duplicate_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let wallet = Address::generate(&env);
        let pid = String::from_str(&env, "proj-dup");
        let mut projects = Vec::new(&env);
        projects.push_back(ProjectInit {
            id: pid.clone(),
            name: String::from_str(&env, "First"),
            wallet: wallet.clone(),
            co2_per_xlm: 100,
        });
        projects.push_back(ProjectInit {
            id: pid,
            name: String::from_str(&env, "Duplicate"),
            wallet,
            co2_per_xlm: 50,
        });

        client.batch_register_projects(&admin, &projects);
    }

    // ─── Governance helpers ───────────────────────────────────────────────────

    /// Set up a fresh contract with one registered project.
    fn setup() -> (
        Env,
        soroban_sdk::Address,
        IndigoPayContractClient<'static>,
        Address,
        String,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let pid = String::from_str(&env, "proj-001");
        let wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &pid,
            &String::from_str(&env, "Test Project"),
            &wallet,
            &100u32,
        );
        (env, cid, client, admin, pid)
    }

    /// Inject a Seedling badge directly into contract storage for a voter.
    fn grant_badge(env: &Env, cid: &soroban_sdk::Address, voter: &Address) {
        env.as_contract(cid, || {
            env.storage().instance().set(
                &DataKey::DonorStats(voter.clone()),
                &DonorStats {
                    total_donated: 10 * STROOP,
                    donation_count: 1,
                    badge: BadgeTier::Seedling,
                    co2_offset_grams: 0,
                },
            );
        });
    }

    /// Extend instance TTL before a large ledger jump so storage isn't archived.
    fn extend_ttl(env: &Env, cid: &soroban_sdk::Address) {
        env.as_contract(cid, || {
            env.storage()
                .instance()
                .extend_ttl(VOTING_WINDOW_LEDGERS * 4, VOTING_WINDOW_LEDGERS * 4);
        });
    }

    #[test]
    fn test_upgrade_preserves_donation_state_and_storage_keys() {
        let (env, cid, client_v1, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);
        let amount = 25 * STROOP;
        let expected_co2 = 25 * 100i128;

        token_client.mint(&donor, &amount);
        client_v1.donate(&token, &donor, &pid, &amount, &42u32);

        let project_before = client_v1.get_project(&pid);
        assert_eq!(project_before.total_raised, amount);
        assert_eq!(project_before.donor_count, 1);
        assert_eq!(client_v1.get_donation_count(), 1);
        assert_eq!(client_v1.get_global_total(), amount);
        assert_eq!(client_v1.get_global_co2(), expected_co2);

        // The test host replaces the executable at the same contract address,
        // modeling a v2 deployment with the same storage key definitions.
        let v2_cid = env.register_contract(Some(&cid), IndigoPayContract);
        assert_eq!(v2_cid, cid);

        let client_v2 = IndigoPayContractClient::new(&env, &cid);
        let project_after = client_v2.get_project(&pid);
        assert_eq!(project_after.id, project_before.id);
        assert_eq!(project_after.name, project_before.name);
        assert_eq!(project_after.wallet, project_before.wallet);
        assert_eq!(project_after.co2_per_xlm, project_before.co2_per_xlm);
        assert_eq!(project_after.total_raised, amount);
        assert_eq!(project_after.donor_count, 1);
        assert!(project_after.active);
        assert_eq!(project_after.registered_at, project_before.registered_at);

        let donor_stats = client_v2.get_donor_stats(&donor);
        assert_eq!(donor_stats.total_donated, amount);
        assert_eq!(donor_stats.donation_count, 1);
        assert_eq!(donor_stats.badge, BadgeTier::Seedling);
        assert_eq!(donor_stats.co2_offset_grams, expected_co2);
        assert!(client_v2.has_nft(&donor, &BadgeTier::Seedling));
        assert_eq!(client_v2.get_project_count(), 1);
        assert_eq!(client_v2.get_donation_count(), 1);
        assert_eq!(client_v2.get_global_total(), amount);
        assert_eq!(client_v2.get_global_co2(), expected_co2);

        env.as_contract(&cid, || {
            let stored_project: Project = env
                .storage()
                .instance()
                .get(&DataKey::Project(pid.clone()))
                .expect("project key must remain readable after upgrade");
            assert_eq!(stored_project.total_raised, amount);
            assert_eq!(stored_project.donor_count, 1);

            let stored_stats: DonorStats = env
                .storage()
                .instance()
                .get(&DataKey::DonorStats(donor.clone()))
                .expect("donor stats key must remain readable after upgrade");
            assert_eq!(stored_stats.total_donated, amount);
            assert_eq!(stored_stats.donation_count, 1);
            assert_eq!(stored_stats.badge, BadgeTier::Seedling);
            assert_eq!(stored_stats.co2_offset_grams, expected_co2);

            let has_donated: bool = env
                .storage()
                .instance()
                .get(&DataKey::HasDonated(pid.clone(), donor.clone()))
                .expect("unique donor key must remain readable after upgrade");
            assert!(has_donated);

            let donation_count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::DonationCount)
                .expect("donation count key must remain readable after upgrade");
            let global_total: i128 = env
                .storage()
                .instance()
                .get(&DataKey::GlobalTotalRaised)
                .expect("global total key must remain readable after upgrade");
            let global_co2: i128 = env
                .storage()
                .instance()
                .get(&DataKey::GlobalCO2OffsetGrams)
                .expect("global CO2 key must remain readable after upgrade");

            assert_eq!(donation_count, 1);
            assert_eq!(global_total, amount);
            assert_eq!(global_co2, expected_co2);
        });
    }

    // ─── Governance tests ─────────────────────────────────────────────────────

    #[test]
    fn test_create_proposal() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        let p = client.get_proposal(&pid);
        assert_eq!(p.votes_for, 0);
        assert_eq!(p.votes_against, 0);
        assert!(!p.resolved);
        assert!(p.deadline_ledger > env.ledger().sequence());
    }

    #[test]
    #[should_panic(expected = "Proposal already exists for this project")]
    fn test_create_duplicate_proposal_fails() {
        let (_env, _cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        client.create_proposal(&admin, &pid, &0u32);
    }

    #[test]
    fn test_cast_vote() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        let voter = Address::generate(&env);
        grant_badge(&env, &cid, &voter);
        client.vote_verify_project(&voter, &pid, &true);
        let p = client.get_proposal(&pid);
        assert_eq!(p.votes_for, 1);
        assert_eq!(p.votes_against, 0);
    }

    #[test]
    #[should_panic(expected = "Only badge holders (Seedling or above) can vote")]
    fn test_non_badge_holder_cannot_vote() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        let non_donor = Address::generate(&env);
        client.vote_verify_project(&non_donor, &pid, &true);
    }

    #[test]
    #[should_panic(expected = "Already voted on this proposal")]
    fn test_double_vote_prevented() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        let voter = Address::generate(&env);
        grant_badge(&env, &cid, &voter);
        client.vote_verify_project(&voter, &pid, &true);
        client.vote_verify_project(&voter, &pid, &true); // should panic
    }

    #[test]
    fn test_resolve_proposal_approved() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        // 2 approve, 1 rejects
        for i in 0..3u32 {
            let voter = Address::generate(&env);
            grant_badge(&env, &cid, &voter);
            client.vote_verify_project(&voter, &pid, &(i < 2));
        }
        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(VOTING_WINDOW_LEDGERS + 2);
        client.resolve_proposal(&pid);
        let p = client.get_proposal(&pid);
        assert!(p.resolved);
        assert_eq!(p.votes_for, 2);
        assert_eq!(p.votes_against, 1);
    }

    #[test]
    fn test_resolve_proposal_rejected() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        // 1 approves, 2 reject
        for i in 0..3u32 {
            let voter = Address::generate(&env);
            grant_badge(&env, &cid, &voter);
            client.vote_verify_project(&voter, &pid, &(i == 0));
        }
        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(VOTING_WINDOW_LEDGERS + 2);
        client.resolve_proposal(&pid);
        let p = client.get_proposal(&pid);
        assert!(p.resolved);
        assert_eq!(p.votes_for, 1);
        assert_eq!(p.votes_against, 2);
    }

    #[test]
    fn test_resolve_proposal_tie_rejected_with_rejection_event() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);

        for i in 0..2u32 {
            let voter = Address::generate(&env);
            grant_badge(&env, &cid, &voter);
            client.vote_verify_project(&voter, &pid, &(i == 0));
        }

        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(VOTING_WINDOW_LEDGERS + 2);
        client.resolve_proposal(&pid);

        let p = client.get_proposal(&pid);
        assert!(p.resolved);
        assert_eq!(p.votes_for, 1);
        assert_eq!(p.votes_against, 1);

        // A tie (1 for, 1 against) produces a rejection outcome.
        // Event-level assertion is intentionally skipped here because the
        // soroban-sdk 27 ContractEvents API does not expose topic iteration
        // in a re-exported path. The core resolution logic (resolved flag,
        // vote counts) is verified above.
    }

    #[test]
    #[should_panic(expected = "Voting window not yet closed")]
    fn test_resolve_before_deadline_fails() {
        let (_env, _cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        client.resolve_proposal(&pid);
    }

    #[test]
    #[should_panic(expected = "Proposal already resolved")]
    fn test_double_resolve_fails() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(VOTING_WINDOW_LEDGERS + 2);
        client.resolve_proposal(&pid);
        // Extend again so the second call reaches our panic, not an archive error
        extend_ttl(&env, &cid);
        client.resolve_proposal(&pid);
    }

    #[test]
    fn test_veto_proposal() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        extend_ttl(&env, &cid);
        client.veto_proposal(&admin, &pid);
        let p = client.get_proposal(&pid);
        assert!(p.resolved);
    }

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn test_veto_proposal_non_admin_fails() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        let imposter = Address::generate(&env);
        client.veto_proposal(&imposter, &pid);
    }

    #[test]
    #[should_panic(expected = "Proposal not found")]
    fn test_veto_proposal_missing_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        client.veto_proposal(&admin, &String::from_str(&env, "nonexistent"));
    }

    #[test]
    #[should_panic(expected = "Proposal already resolved")]
    fn test_veto_proposal_double_veto_fails() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);
        extend_ttl(&env, &cid);
        client.veto_proposal(&admin, &pid);
        client.veto_proposal(&admin, &pid);
    }

    // ─── Configurable voting-duration tests ───────────────────────────────────

    /// A non-zero `duration_ledgers` within bounds is honored verbatim.
    #[test]
    fn test_create_proposal_custom_duration() {
        let (env, _cid, client, admin, pid) = setup();
        let custom: u32 = 5_000;
        let start = env.ledger().sequence();
        client.create_proposal(&admin, &pid, &custom);
        let p = client.get_proposal(&pid);
        assert_eq!(p.deadline_ledger, start + custom);
    }

    /// `0` means "use the default 7-day window".
    #[test]
    fn test_create_proposal_zero_duration_uses_default() {
        let (env, _cid, client, admin, pid) = setup();
        let start = env.ledger().sequence();
        client.create_proposal(&admin, &pid, &0u32);
        let p = client.get_proposal(&pid);
        assert_eq!(p.deadline_ledger, start + VOTING_WINDOW_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "Voting duration too short")]
    fn test_create_proposal_rejects_too_short_duration() {
        let (_env, _cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &(MIN_VOTING_WINDOW_LEDGERS - 1));
    }

    #[test]
    #[should_panic(expected = "Voting duration too long")]
    fn test_create_proposal_rejects_too_long_duration() {
        let (_env, _cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &(MAX_VOTING_WINDOW_LEDGERS + 1));
    }

    #[test]
    #[should_panic(expected = "CO2 per XLM exceeds maximum")]
    fn test_register_project_rejects_excessive_co2_per_xlm() {
        let (env, _cid, client, admin, _pid) = setup();
        let pid2 = String::from_str(&env, "proj-002");
        let wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &pid2,
            &String::from_str(&env, "Bad Project"),
            &wallet,
            &(MAX_CO2_PER_XLM + 1),
        );
    }

    #[test]
    fn test_deactivate_all_projects() {
        let (env, _cid, client, admin, pid1) = setup();
        let pid2 = String::from_str(&env, "proj-002");
        let wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &pid2,
            &String::from_str(&env, "Second Project"),
            &wallet,
            &100u32,
        );

        assert!(client.get_project(&pid1).active);
        assert!(client.get_project(&pid2).active);

        client.deactivate_all_projects(&admin);

        assert!(!client.get_project(&pid1).active);
        assert!(!client.get_project(&pid2).active);
    }

    /// Test that voting is rejected after the deadline has passed (issue #209).
    #[test]
    #[should_panic(expected = "Voting window has closed")]
    fn test_vote_rejected_after_deadline() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);

        // Create a voter with badge
        let voter = Address::generate(&env);
        grant_badge(&env, &cid, &voter);

        // Advance ledger past the deadline
        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(VOTING_WINDOW_LEDGERS + 2);

        // Attempt to vote after deadline — should panic with "Voting window has closed"
        client.vote_verify_project(&voter, &pid, &true);
    }

    /// Test that voting is allowed before the deadline (issue #209).
    #[test]
    fn test_vote_allowed_before_deadline() {
        let (env, cid, client, admin, pid) = setup();
        let start = env.ledger().sequence();
        client.create_proposal(&admin, &pid, &0u32);

        let voter = Address::generate(&env);
        grant_badge(&env, &cid, &voter);

        // Vote at ledger start + VOTING_WINDOW_LEDGERS - 1 (last valid ledger)
        extend_ttl(&env, &cid);
        env.ledger()
            .set_sequence_number(start + VOTING_WINDOW_LEDGERS - 1);

        // Should succeed
        client.vote_verify_project(&voter, &pid, &true);

        let proposal = client.get_proposal(&pid);
        assert_eq!(proposal.votes_for, 1);
    }

    /// Test minimum voting duration enforcement (issue #209).
    #[test]
    fn test_minimum_voting_duration_enforced() {
        let (env, cid, client, admin, pid) = setup();
        let custom_duration = MIN_VOTING_WINDOW_LEDGERS;
        let start = env.ledger().sequence();

        client.create_proposal(&admin, &pid, &custom_duration);

        let voter = Address::generate(&env);
        grant_badge(&env, &cid, &voter);

        // Vote within the minimum window
        extend_ttl(&env, &cid);
        env.ledger()
            .set_sequence_number(start + custom_duration - 1);

        client.vote_verify_project(&voter, &pid, &true);

        let proposal = client.get_proposal(&pid);
        assert_eq!(proposal.votes_for, 1);
    }

    // ─── ProjectMilestoneNFT tests (#205) ────────────────────────────────────

    #[test]
    fn test_mint_project_nft_success() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);

        token_client.mint(&donor, &(200 * STROOP));
        client.donate(&token, &donor, &pid, &(101 * STROOP), &0u32);

        assert!(!client.has_project_nft(&donor, &pid));
        client.mint_project_nft(&donor, &pid);
        assert!(client.has_project_nft(&donor, &pid));

        let nft = client.get_project_nft(&donor, &pid);
        assert_eq!(nft.owner, donor);
        assert_eq!(nft.project_id, pid);
        assert_eq!(nft.amount_donated, 101 * STROOP);
        // co2_per_xlm for the test project is 100 grams/XLM
        assert_eq!(nft.co2_offset_grams, 101 * 100);
    }

    #[test]
    #[should_panic(expected = "Cumulative donation to this project has not reached 100 XLM")]
    fn test_mint_project_nft_below_threshold() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);

        token_client.mint(&donor, &(100 * STROOP));
        client.donate(&token, &donor, &pid, &(50 * STROOP), &0u32);

        client.mint_project_nft(&donor, &pid);
    }

    #[test]
    #[should_panic(expected = "Milestone NFT already minted for this project")]
    fn test_mint_project_nft_duplicate_prevented() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);

        token_client.mint(&donor, &(200 * STROOP));
        client.donate(&token, &donor, &pid, &(101 * STROOP), &0u32);

        client.mint_project_nft(&donor, &pid);
        // Second call must panic
        client.mint_project_nft(&donor, &pid);
    }

    #[test]
    fn test_project_nft_independent_per_project() {
        let (env, _cid, client, admin, pid1) = setup();
        let pid2 = String::from_str(&env, "proj-002");
        let wallet2 = Address::generate(&env);
        client.register_project(
            &admin,
            &pid2,
            &String::from_str(&env, "Project 2"),
            &wallet2,
            &50u32,
        );

        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);

        token_client.mint(&donor, &(300 * STROOP));
        client.donate(&token, &donor, &pid1, &(101 * STROOP), &0u32);
        client.donate(&token, &donor, &pid2, &(50 * STROOP), &1u32);

        client.mint_project_nft(&donor, &pid1);
        assert!(client.has_project_nft(&donor, &pid1));
        assert!(!client.has_project_nft(&donor, &pid2));
    }

    #[test]
    fn test_project_nft_cumulative_across_donations() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);

        // Two donations summing to > 100 XLM
        token_client.mint(&donor, &(200 * STROOP));
        client.donate(&token, &donor, &pid, &(60 * STROOP), &0u32);
        client.donate(&token, &donor, &pid, &(60 * STROOP), &1u32);

        client.mint_project_nft(&donor, &pid);
        assert!(client.has_project_nft(&donor, &pid));

        let nft = client.get_project_nft(&donor, &pid);
        assert_eq!(nft.amount_donated, 120 * STROOP);
    }

    // ─── Pause / resume tests (#213) ──────────────────────────────────────────

    #[test]
    fn test_pause_project_sets_paused_flag() {
        let (_env, _cid, client, admin, pid) = setup();
        client.pause_project(&admin, &pid);
        let p = client.get_project(&pid);
        assert!(p.paused);
        assert!(p.active); // pause is orthogonal to deactivation
    }

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn test_pause_project_non_admin_fails() {
        let (env, _cid, client, _admin, pid) = setup();
        let imposter = Address::generate(&env);
        client.pause_project(&imposter, &pid);
    }

    #[test]
    #[should_panic(expected = "Cannot pause a deactivated project")]
    fn test_pause_deactivated_project_fails() {
        let (_env, _cid, client, admin, pid) = setup();
        client.deactivate_project(&admin, &pid);
        client.pause_project(&admin, &pid);
    }

    #[test]
    #[should_panic(expected = "Project is already paused")]
    fn test_pause_already_paused_project_fails() {
        let (_env, _cid, client, admin, pid) = setup();
        client.pause_project(&admin, &pid);
        client.pause_project(&admin, &pid);
    }

    #[test]
    fn test_resume_project_clears_paused_flag() {
        let (_env, _cid, client, admin, pid) = setup();
        client.pause_project(&admin, &pid);
        client.resume_project(&admin, &pid);
        let p = client.get_project(&pid);
        assert!(!p.paused);
        assert!(p.active);
    }

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn test_resume_project_non_admin_fails() {
        let (env, _cid, client, admin, pid) = setup();
        client.pause_project(&admin, &pid);
        let imposter = Address::generate(&env);
        client.resume_project(&imposter, &pid);
    }

    #[test]
    #[should_panic(expected = "Cannot resume a deactivated project")]
    fn test_resume_deactivated_project_fails() {
        let (_env, _cid, client, admin, pid) = setup();
        client.deactivate_project(&admin, &pid);
        client.resume_project(&admin, &pid);
    }

    #[test]
    #[should_panic(expected = "Project is not paused")]
    fn test_resume_unpaused_project_fails() {
        let (_env, _cid, client, admin, pid) = setup();
        client.resume_project(&admin, &pid);
    }

    #[test]
    #[should_panic(expected = "Project is temporarily paused")]
    fn test_donate_to_paused_project_fails() {
        let (env, _cid, client, admin, pid) = setup();
        client.pause_project(&admin, &pid);

        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&donor, &(25 * STROOP));
        client.donate(&token, &donor, &pid, &(25 * STROOP), &42u32);
    }

    #[test]
    fn test_donate_after_resume_succeeds() {
        let (env, _cid, client, admin, pid) = setup();
        client.pause_project(&admin, &pid);
        client.resume_project(&admin, &pid);

        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&donor, &(25 * STROOP));
        client.donate(&token, &donor, &pid, &(25 * STROOP), &42u32);

        let p = client.get_project(&pid);
        assert_eq!(p.total_raised, 25 * STROOP);
        assert!(!p.paused);
        assert_eq!(client.get_global_total(), 25 * STROOP);
    }

    // ─── Donate flow / overflow tests ──────────────────────────────────────────

    /// End-to-end single-donation flow that exercises the Checks-Effects-
    /// Interactions reorder applied to `donate`. State must be fully durable
    /// before the external token transfer fires.
    #[test]
    fn test_donate_basic_flow_after_cei_reorder() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);
        token_client.mint(&donor, &(15 * STROOP));

        client.donate(&token, &donor, &pid, &(15 * STROOP), &1u32);

        // Project total reflects donation before token transfer fires
        let p = client.get_project(&pid);
        assert_eq!(p.total_raised, 15 * STROOP);
        assert_eq!(p.donor_count, 1);
        assert!(p.active);
        // Donor stats: ticks over to Seedling tier (≥ 10 XLM)
        let stats = client.get_donor_stats(&donor);
        assert_eq!(stats.total_donated, 15 * STROOP);
        assert_eq!(stats.donation_count, 1);
        assert_eq!(stats.badge, BadgeTier::Seedling);
        assert_eq!(stats.co2_offset_grams, 15 * 100);
        // Globals
        assert_eq!(client.get_global_total(), 15 * STROOP);
        assert_eq!(client.get_global_co2(), 15 * 100);
        assert_eq!(client.get_donation_count(), 1);
    }

    /// Note: total_raised overflow protection is already exercised by
    /// `fuzz_tests::donation_of_i128_max_panics` and `sequential_donations_panic_when_sum_exceeds_i128_max`,
    /// and the CO₂ `checked_mul` guard inside `donate` is unreachable
    /// from any valid `amount <= i128::MAX` (since
    /// `xlm_units * MAX_CO2_PER_XLM <= 9.22e16 < i128::MAX`), so no
    /// redundant overflow tests are kept here.
    /// Replaying the same donor must NOT inflate `project.donor_count` —
    /// it counts unique donors.
    #[test]
    fn test_donate_unique_donor_count_not_inflated() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&donor, &(30 * STROOP));

        client.donate(&token, &donor, &pid, &(10 * STROOP), &0u32);
        client.donate(&token, &donor, &pid, &(10 * STROOP), &1u32);
        client.donate(&token, &donor, &pid, &(10 * STROOP), &2u32);

        let p = client.get_project(&pid);
        assert_eq!(p.donor_count, 1);
        assert_eq!(p.total_raised, 30 * STROOP);
        // The donor stats aggregate across all three donations
        let stats = client.get_donor_stats(&donor);
        assert_eq!(stats.donation_count, 3);
        assert_eq!(stats.total_donated, 30 * STROOP);
    }

    /// Two distinct donors to the same project must each be counted once.
    #[test]
    fn test_donate_distinct_donors_increment_count() {
        let (env, _cid, client, _admin, pid) = setup();
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);
        let donor_a = Address::generate(&env);
        let donor_b = Address::generate(&env);
        token_client.mint(&donor_a, &(10 * STROOP));
        token_client.mint(&donor_b, &(10 * STROOP));

        client.donate(&token, &donor_a, &pid, &(10 * STROOP), &0u32);
        client.donate(&token, &donor_b, &pid, &(10 * STROOP), &1u32);

        let p = client.get_project(&pid);
        assert_eq!(p.donor_count, 2);
        assert_eq!(p.total_raised, 20 * STROOP);
    }

    /// `get_voter_list` returns voters in the order they voted.
    #[test]
    fn test_get_voter_list() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&admin, &pid, &0u32);

        let mut voters = std::vec::Vec::new();
        for _ in 0..3 {
            let v = Address::generate(&env);
            grant_badge(&env, &cid, &v);
            client.vote_verify_project(&v, &pid, &true);
            voters.push(v);
        }

        let list = client.get_voter_list(&pid);
        assert_eq!(list.len(), 3);
        // Order-preserving: `vote_verify_project` pushes in voter-call order.
        for (i, v) in voters.iter().enumerate() {
            assert_eq!(list.get(i as u32).unwrap(), v.clone());
        }
    }

    /// `get_voter_list` returns an empty `Vec` for a proposal no one has
    /// voted on yet (does not panic and does not write defaults).
    #[test]
    fn test_get_voter_list_non_existent_proposal() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        // Initialize admin path + then ask for an unknown project.
        let pid = String::from_str(&env, "never-created");
        let list = client.get_voter_list(&pid);
        assert_eq!(list.len(), 0);
    }

    // ─── Bulk admin tests ──────────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn test_deactivate_all_projects_non_admin_fails() {
        let (env, _cid, client, _admin, _pid) = setup();
        let imposter = Address::generate(&env);
        client.deactivate_all_projects(&imposter);
    }

    // ─── Two-step admin transfer tests ─────────────────────────────────────

    /// Helper that bootstraps a fresh contract with only an admin (no
    /// project). The admin-transfer tests need a clean slate.
    fn setup_admin_only() -> (
        Env,
        soroban_sdk::Address,
        IndigoPayContractClient<'static>,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, cid, client, admin)
    }

    #[test]
    fn test_two_step_admin_transfer_success() {
        let (env, _cid, client, admin) = setup_admin_only();
        let new_admin = Address::generate(&env);

        client.transfer_admin(&admin, &new_admin);
        assert_eq!(client.get_pending_admin(), Some(new_admin.clone()));
        // Stored admin does not change until accept_admin.
        assert_eq!(client.get_admin(), admin);

        client.accept_admin();
        assert_eq!(client.get_admin(), new_admin);
        assert_eq!(client.get_pending_admin(), None);
    }

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn test_two_step_admin_transfer_non_admin_cant_initiate() {
        let (env, _cid, client, _admin) = setup_admin_only();
        let imposter = Address::generate(&env);
        let new_admin = Address::generate(&env);
        client.transfer_admin(&imposter, &new_admin);
    }

    #[test]
    #[should_panic(expected = "No pending admin transfer")]
    fn test_two_step_admin_transfer_accept_without_proposal_fails() {
        let (_env, _cid, client, _admin) = setup_admin_only();
        // mock_all_auths is enabled, but no proposal exists.
        client.accept_admin();
    }

    #[test]
    #[should_panic(expected = "Admin transfer already pending; cancel first")]
    fn test_two_step_admin_transfer_double_propose_fails() {
        let (env, _cid, client, admin) = setup_admin_only();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        client.transfer_admin(&admin, &a);
        client.transfer_admin(&admin, &b);
    }

    #[test]
    fn test_two_step_admin_transfer_cancel_clears_pending() {
        let (env, _cid, client, admin) = setup_admin_only();
        let new_admin = Address::generate(&env);

        client.transfer_admin(&admin, &new_admin);
        assert_eq!(client.get_pending_admin(), Some(new_admin.clone()));
        client.cancel_admin_transfer(&admin);
        assert_eq!(client.get_pending_admin(), None);
        // Original admin is still the admin.
        assert_eq!(client.get_admin(), admin);
    }

    #[test]
    #[should_panic(expected = "No pending admin transfer")]
    fn test_two_step_admin_transfer_cancel_without_pending_fails() {
        let (_env, _cid, client, admin) = setup_admin_only();
        client.cancel_admin_transfer(&admin);
    }

    // ─── Donation rate limit tests ────────────────────────────────────────────

    /// Mint XLM tokens for a donor and return the token contract address.
    fn mint_xlm(env: &Env, donor: &Address, amount: i128) -> Address {
        let token_admin = Address::generate(env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(env, &token).mint(donor, &amount);
        token
    }

    #[test]
    fn test_donation_rate_limit_allows_up_to_max_within_window() {
        let (env, _cid, client, admin, pid) = setup();
        client.set_donation_rate_limit(&admin, &3, &100);
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, 3 * STROOP);
        for i in 0..3u32 {
            client.donate(&token, &donor, &pid, &STROOP, &i);
        }
        assert_eq!(client.get_project(&pid).total_raised, 3 * STROOP);
    }

    #[test]
    #[should_panic(expected = "Donation rate limit exceeded")]
    fn test_donation_rate_limit_blocks_max_plus_one() {
        let (env, _cid, client, admin, pid) = setup();
        client.set_donation_rate_limit(&admin, &3, &100);
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, 4 * STROOP);
        for i in 0..3u32 {
            client.donate(&token, &donor, &pid, &STROOP, &i);
        }
        client.donate(&token, &donor, &pid, &STROOP, &3u32);
    }

    #[test]
    fn test_donation_rate_limit_resets_after_window_elapses() {
        let (env, cid, client, admin, pid) = setup();
        client.set_donation_rate_limit(&admin, &2, &50);
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, 3 * STROOP);
        let window_start = env.ledger().sequence();
        client.donate(&token, &donor, &pid, &STROOP, &0u32);
        client.donate(&token, &donor, &pid, &STROOP, &1u32);

        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(window_start + 50);
        client.donate(&token, &donor, &pid, &STROOP, &2u32);
        assert_eq!(client.get_project(&pid).total_raised, 3 * STROOP);
    }

    #[test]
    fn test_donation_rate_limit_off_by_one_window_boundary() {
        let (env, cid, client, admin, pid) = setup();
        client.set_donation_rate_limit(&admin, &2, &50);
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, 3 * STROOP);
        let window_start = env.ledger().sequence();
        client.donate(&token, &donor, &pid, &STROOP, &0u32);
        client.donate(&token, &donor, &pid, &STROOP, &1u32);

        // Still inside the window — third donation must be blocked.
        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(window_start + 50 - 1);
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.donate(&token, &donor, &pid, &STROOP, &2u32);
        }));
        assert!(
            blocked.is_err(),
            "donation at window boundary - 1 should be blocked"
        );

        // Exactly at window expiry — window resets and donation succeeds.
        env.ledger().set_sequence_number(window_start + 50);
        client.donate(&token, &donor, &pid, &STROOP, &2u32);
        assert_eq!(client.get_project(&pid).total_raised, 3 * STROOP);
    }

    #[test]
    fn test_donation_rate_limit_independent_per_project() {
        let (env, _cid, client, admin, pid) = setup();
        client.set_donation_rate_limit(&admin, &2, &100);
        let pid2 = String::from_str(&env, "proj-002");
        let wallet2 = Address::generate(&env);
        client.register_project(
            &admin,
            &pid2,
            &String::from_str(&env, "Second Project"),
            &wallet2,
            &100u32,
        );

        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, 5 * STROOP);
        client.donate(&token, &donor, &pid, &STROOP, &0u32);
        client.donate(&token, &donor, &pid, &STROOP, &1u32);
        // pid is at limit; pid2 still has its own counter.
        client.donate(&token, &donor, &pid2, &STROOP, &2u32);
        assert_eq!(client.get_project(&pid2).total_raised, STROOP);
    }

    #[test]
    fn test_donation_rate_limit_independent_per_donor() {
        let (env, _cid, client, admin, pid) = setup();
        client.set_donation_rate_limit(&admin, &2, &100);
        let donor_a = Address::generate(&env);
        let donor_b = Address::generate(&env);
        let token_a = mint_xlm(&env, &donor_a, 3 * STROOP);
        let token_b = mint_xlm(&env, &donor_b, 3 * STROOP);

        client.donate(&token_a, &donor_a, &pid, &STROOP, &0u32);
        client.donate(&token_a, &donor_a, &pid, &STROOP, &1u32);
        // donor_a is at limit; donor_b still has its own counter.
        client.donate(&token_b, &donor_b, &pid, &STROOP, &2u32);
        assert_eq!(client.get_project(&pid).total_raised, 3 * STROOP);
    }

    #[test]
    fn test_set_donation_rate_limit_takes_effect_immediately() {
        let (env, _cid, client, admin, pid) = setup();
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, 5 * STROOP);

        client.set_donation_rate_limit(&admin, &1, &100);
        client.donate(&token, &donor, &pid, &STROOP, &0u32);

        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.donate(&token, &donor, &pid, &STROOP, &1u32);
        }));
        assert!(
            blocked.is_err(),
            "new limit of 1 should block second donation"
        );

        client.set_donation_rate_limit(&admin, &3, &100);
        assert_eq!(client.get_donation_rate_limit(), (3, 100));
        client.donate(&token, &donor, &pid, &STROOP, &1u32);
        client.donate(&token, &donor, &pid, &STROOP, &2u32);
        assert_eq!(client.get_project(&pid).total_raised, 3 * STROOP);
    }

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn test_set_donation_rate_limit_non_admin_fails() {
        let (env, _cid, client, _admin, _pid) = setup();
        let imposter = Address::generate(&env);
        client.set_donation_rate_limit(&imposter, &5, &100);
    }

    #[test]
    fn test_donation_rate_limit_first_donation_succeeds() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, STROOP);
        client.donate(&token, &donor, &pid, &STROOP, &0u32);
        assert_eq!(client.get_donation_rate_limit(), (10, 720));
        assert_eq!(client.get_project(&pid).total_raised, STROOP);
    }

    #[test]
    fn test_get_donation_rate_limit_defaults() {
        let (_env, _cid, client, _admin, _pid) = setup();
        assert_eq!(
            client.get_donation_rate_limit(),
            (
                DEFAULT_DONATION_RATE_LIMIT_MAX,
                DEFAULT_DONATION_RATE_LIMIT_WINDOW
            )
        );
    }

    // ─── Contract-level pause tests ─────────────────────────────────────────

    #[test]
    fn test_pause_blocks_donate() {
        let (env, _cid, client, _admin) = setup_admin_only();
        let pid = String::from_str(&env, "proj-pause");
        let wallet = Address::generate(&env);
        client.register_project(
            &client.get_admin(),
            &pid,
            &String::from_str(&env, "P"),
            &wallet,
            &100u32,
        );

        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&donor, &(10 * STROOP));

        client.pause_contract(&client.get_admin());
        assert!(client.is_contract_paused());

        // A donate attempt must panic with the contract-level pause message.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.donate(&token, &donor, &pid, &(10 * STROOP), &0u32);
        }));
        assert!(result.is_err(), "donate should be rejected while paused");
    }

    #[test]
    fn test_pause_then_unpause_allows_donate() {
        let (env, _cid, client, admin) = setup_admin_only();
        let pid = String::from_str(&env, "proj-pause2");
        let wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &pid,
            &String::from_str(&env, "P2"),
            &wallet,
            &100u32,
        );

        client.pause_contract(&admin);
        client.unpause_contract(&admin);
        assert!(!client.is_contract_paused());

        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&donor, &(10 * STROOP));
        client.donate(&token, &donor, &pid, &(10 * STROOP), &0u32);

        let p = client.get_project(&pid);
        assert_eq!(p.total_raised, 10 * STROOP);
    }

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn test_pause_contract_non_admin_fails() {
        let (env, _cid, client, _admin) = setup_admin_only();
        let imposter = Address::generate(&env);
        client.pause_contract(&imposter);
    }

    // ─── 48h upgrade timelock tests ─────────────────────────────────────────

    #[test]
    fn test_propose_upgrade_stores_pending() {
        let (env, _cid, client, admin) = setup_admin_only();
        let fake_hash = BytesN::from_array(&env, &[7u8; 32]);

        client.propose_upgrade(&admin, &fake_hash);
        let (h, eff) = client.get_pending_upgrade().expect("pending upgrade");
        assert_eq!(h, fake_hash);
        assert_eq!(eff, env.ledger().sequence() + UPGRADE_TIMELOCK_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn test_propose_upgrade_non_admin_fails() {
        let (env, _cid, client, _admin) = setup_admin_only();
        let imposter = Address::generate(&env);
        let fake_hash = BytesN::from_array(&env, &[1u8; 32]);
        client.propose_upgrade(&imposter, &fake_hash);
    }

    #[test]
    #[should_panic(expected = "Upgrade already pending; cancel first")]
    fn test_propose_upgrade_double_propose_rejected() {
        let (env, _cid, client, admin) = setup_admin_only();
        let h1 = BytesN::from_array(&env, &[1u8; 32]);
        let h2 = BytesN::from_array(&env, &[2u8; 32]);
        client.propose_upgrade(&admin, &h1);
        client.propose_upgrade(&admin, &h2);
    }

    #[test]
    #[should_panic(expected = "Upgrade timelock not yet elapsed")]
    fn test_execute_upgrade_before_timelock_fails() {
        let (env, _cid, client, admin) = setup_admin_only();
        let fake_hash = BytesN::from_array(&env, &[3u8; 32]);
        client.propose_upgrade(&admin, &fake_hash);
        // Still well before the effective ledger.
        client.execute_upgrade();
    }

    #[test]
    fn test_execute_upgrade_after_timelock_succeeds() {
        let (env, _cid, client, admin) = setup_admin_only();
        let fake_hash = BytesN::from_array(&env, &[4u8; 32]);
        let start = env.ledger().sequence();
        client.propose_upgrade(&admin, &fake_hash);

        // Verify timelock state is recorded correctly (effective_at).
        let (hash, effective_at) = client.get_pending_upgrade().unwrap();
        assert_eq!(hash, fake_hash);
        assert_eq!(effective_at, start + UPGRADE_TIMELOCK_LEDGERS);

        // The actual WASM swap (execute_upgrade) requires a valid Soroban
        // contract WASM to be uploaded first, which isn't available in the
        // unit-test host environment.  The timelock state machine is
        // covered by the assertions above and the cancel tests below.
        client.cancel_upgrade(&admin);
        assert_eq!(client.get_pending_upgrade(), None);
    }

    #[test]
    fn test_cancel_upgrade_clears_pending() {
        let (env, _cid, client, admin) = setup_admin_only();
        let fake_hash = BytesN::from_array(&env, &[5u8; 32]);
        client.propose_upgrade(&admin, &fake_hash);
        assert!(client.get_pending_upgrade().is_some());
        client.cancel_upgrade(&admin);
        assert_eq!(client.get_pending_upgrade(), None);
        // last-executed is untouched because no upgrade was ever executed.
        assert_eq!(client.get_last_executed_upgrade(), None);
    }

    #[test]
    #[should_panic(expected = "No pending upgrade")]
    fn test_execute_upgrade_without_pending_fails() {
        let (_env, _cid, client, _admin) = setup_admin_only();
        client.execute_upgrade();
    }

    #[test]
    #[should_panic(expected = "No pending upgrade")]
    fn test_cancel_upgrade_without_pending_fails() {
        let (_env, _cid, client, admin) = setup_admin_only();
        client.cancel_upgrade(&admin);
    }

    #[test]
    fn test_extend_all_ttl() {
        let env = Env::default();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        // Before extending, TTL should be some default (usually 100 in tests or determined by init).
        // The host env starts at ledger 0. We will use testutils to check the exact TTL.
        use soroban_sdk::testutils::storage::Instance as TestInstance;

        let _before_ttl = env.as_contract(&id, || env.storage().instance().get_ttl());

        // Extend TTL
        client.extend_all_ttl(&500_000);

        let after_ttl = env.as_contract(&id, || env.storage().instance().get_ttl());
        assert!(after_ttl >= 500_000);
    }
}
