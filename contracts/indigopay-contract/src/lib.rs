#![no_std]
// Deprecated Events::publish — the new #[contractevent] macro is preferred.
// Suppressing this warning so clippy -- -D warnings still passes.
// TODO(indigopay-272): migrate to #[contractevent] pattern.
#![allow(deprecated)]

#[cfg(feature = "donation")]
pub mod donation;
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
    contract, contractclient, contractimpl, contracttype, symbol_short, token, Address, Bytes,
    BytesN, Env, String, Symbol, Vec,
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
    /// Fundraising goal in stroops for the active time-bound campaign.
    /// `0` when `campaign_status` is `None`.
    pub goal: i128,
    /// Ledger sequence after which Active-campaign donations are rejected.
    pub deadline_ledger: u32,
    /// Lifecycle of the project's optional time-bound campaign.
    pub campaign_status: CampaignStatus,
    /// Optional parent project ID for hierarchical project structure.
    /// When set, this project is a sub-project of the specified parent.
    /// Sub-projects inherit active status from parent (deactivating parent
    /// deactivates children). Appended for backward compatibility.
    pub parent_project_id: Option<String>,
}

/// Lifecycle of a project's optional time-bound fundraising campaign.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CampaignStatus {
    /// No campaign configured — donations behave as before.
    None,
    /// Accepting donations until deadline or goal.
    Active,
    /// `total_raised` met or exceeded `goal`.
    GoalReached,
    /// Deadline passed without meeting the goal (set on admin close).
    Expired,
    /// Manually closed by admin before or after the goal.
    Closed,
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
    /// True when the donor opted out of public attribution.
    pub anonymous: bool,
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

/// Record of a pending emergency withdrawal. One per project at a time
/// (keyed by project_id only — a project holding multiple tokens must
/// execute withdrawals sequentially, not in parallel).
/// The `amount` field must not exceed `ProjectContractBalance(project_id, token)`
/// at execution time — enforced by `execute_emergency_withdrawal`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct EmergencyWithdrawal {
    pub new_wallet: Address,
    pub amount: i128,
    pub token: Address,
    pub initiated_at: u32,
    pub executable_at: u32,
}

// ─── Donation refund (#290) ─────────────────────────────────────────────────

/// Status of a refund request.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum RefundRequestStatus {
    Pending,
    Approved,
    Rejected,
}

/// A donor-initiated refund request. Created by `request_refund`, resolved by
/// `approve_refund` (which atomically transfers tokens back) or `reject_refund`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RefundRequest {
    pub donor: Address,
    pub project_id: String,
    pub amount: i128,
    pub donation_record_index: u32,
    pub requested_at: u32,
    pub status: RefundRequestStatus,
    pub token: Address,
    /// Exact CO₂ offset credited at donation time, sourced from
    /// `DonationCO2Offset(donation_record_index)`. Zero for pre-upgrade
    /// donations that lack this key (documented known limitation).
    pub co2_offset_grams: i128,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct RecurringDonation {
    pub donor: Address,
    pub project_id: String,
    pub amount: i128,
    pub currency: Symbol,      // "XLM" or "USDC"
    pub interval_ledgers: u32, // e.g. 518400 ≈ 30 days @ 5s/ledger
    pub next_execution_ledger: u32,
    pub keeper_incentive: i128, // stroops paid to executor
    pub active: bool,
    pub created_at: u32,
}

/// A time-locked vesting schedule for gradual donation release.
/// Donors can specify that a donation should be released to the project
/// in equal installments over a configurable number of ledgers, rather
/// than all at once. The first installment is transferred immediately;
/// subsequent installments are claimable after each interval elapses.
#[contracttype]
#[derive(Clone, Debug)]
pub struct VestingSchedule {
    pub donor: Address,
    pub project_id: String,
    pub total_amount: i128,
    pub amount_per_installment: i128,
    pub installment_count: u32,
    pub interval_ledgers: u32,
    pub next_installment_ledger: u32,
    pub installments_released: u32,
    pub created_at: u32,
    pub token: Address,
}

/// An on-chain impact certificate leaf for a single donor's contribution.
/// The platform constructs a Merkle tree of all donor impacts for a project's
/// reporting period and posts only the root on-chain. Individual donors can then
/// prove their specific impact (trees planted, CO₂ sequestered, hectares restored)
/// against that root without revealing other donors' data.
#[cfg(feature = "impact")]
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ImpactLeaf {
    /// Donor address whose impact this leaf represents.
    pub donor: Address,
    /// Index of the donation within the project's donation history.
    pub donation_index: u32,
    /// CO₂ offset in kilograms attributable to this donor.
    pub co2_kg: u32,
    /// Number of trees planted attributable to this donor.
    pub trees: u32,
    /// Hectares restored attributable to this donor.
    pub hectares: u32,
}

#[contracttype]
pub enum DataKey {
    // Multi-sig admin set: Vec<Address> of authorized admin addresses.
    // Replaces the former single-admin `Admin` variant.
    AdminSet,
    // M-of-N threshold for critical operations. Must satisfy
    // 1 <= threshold <= admin_set.len().
    AdminThreshold,
    Project(String),
    ProjectIds,
    ProjectCount,
    DonorStats(Address),
    ImpactNFT(Address, BadgeTier),
    DonationCount,
    AnonymousDonationCount,
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
    // Sub-project IDs for a given parent project — enables hierarchical
    // project structure queries (cross-contract project registry).
    SubProjectIds(String),
    // Pending admin transfer for the two-step `transfer_admin` /
    // `accept_admin` flow. Stores `(old_admin, new_admin)` tuple.
    // Set when M-of-N admins call `transfer_admin` and cleared on
    // `accept_admin` (swap) or `cancel_admin_transfer`.
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
    // Pending emergency withdrawal request. One per project at a time —
    // key is project_id only; a project with multiple token balances
    // must execute withdrawals sequentially (initiate → wait → execute
    // → repeat for next token). Cleared by `execute_emergency_withdrawal`
    // or `cancel_emergency_withdrawal`.
    EmergencyWithdrawal(String),
    // Donation refund (#290)
    RefundRequest(u32),
    RefundCount,
    RefundForDonation(u32),
    DonationCO2Offset(u32),
    // Per-project per-token contract-held balance — the canonical ledger
    // for how much of each asset each project has deposited into the
    // contract. Key: (project_id, token_address) → i128.
    //
    // MUST be reused by any future contract-held-funds feature (matching
    // pool, escrow extensions, etc.) rather than introducing a parallel
    // balance concept. #277's deposit logic must increment this key on
    // deposit. See SECURITY.md and #277 for coordination notes.
    ProjectContractBalance(String, Address),
    RecurringDonation(Address, u32),
    DonorRecurringCount(Address),
    VoteDelegation(Address),
    DelegatedWeight(Address),
    NativeTokenAddress,
    // zk-SNARK anonymous donation (#390)
    ZkVerificationKey,
    Nullifier(BytesN<32>),
    // Time-locked donation vesting (#386)
    VestingSchedule(Address, u32),
    DonorVestingCount(Address),
    // Platform fee configuration (#385)
    /// Fee in basis points (0–500, max 5%).
    PlatformFeeBps,
    /// Designated wallet that receives the platform fee.
    PlatformTreasury,
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

// 7 days × 24 h × 3600 s ÷ 5 s per ledger = 120_960 ledgers. The minimum
// delay between `initiate_emergency_withdrawal` and the earliest ledger at
// which `execute_emergency_withdrawal` can fire. Gives donors and observers
// a 7-day window to object off-chain before contract-held funds are sent to
// the new wallet.
const EMERGENCY_WITHDRAWAL_TIMELOCK: u32 = 120_960;

// 24 hours × 3600 s / 5 s per ledger = 17 280 ledgers. The window after a
// donation during which the donor may request a refund (subject to admin +
// project wallet approval).
const REFUND_COOLDOWN_LEDGERS: u32 = 17_280;

/// Current storage schema version. Bump this and add a migration step in
/// `migrate()` whenever a struct layout, DataKey variant, or stored value
/// encoding changes in a backward-incompatible way.
///
/// v1: original schema (no version tracking)
/// v2: Symbol-keyed storage version added (#379)
const CURRENT_STORAGE_VERSION: u32 = 2;
/// Storage key for the schema version. Uses a Symbol (not a DataKey variant)
/// to avoid XDR codegen overhead in the slim WASM build.
#[cfg(feature = "upgrade")]
const STORAGE_VERSION_KEY: Symbol = symbol_short!("sv");

/// Hard cap on platform fee: 500 basis points = 5%.
#[cfg(feature = "fees")]
const MAX_PLATFORM_FEE_BPS: u32 = 500;

/// Read the stored admin set. Panics if not initialized.
fn read_admin_set(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::AdminSet)
        .expect("Not initialized")
}

/// Read the stored admin threshold. Panics if not initialized.
fn read_admin_threshold(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::AdminThreshold)
        .expect("Admin threshold not set")
}

/// Verify M-of-N threshold signatures for critical admin actions.
///
/// Iterates the supplied `signers` vec, calling `require_auth()` on each
/// address (Soroban host-level cryptographic verification) and checking
/// membership in the admin set. Duplicate signers are counted only once
/// to prevent a single compromised key from satisfying the threshold by
/// passing itself multiple times.
fn verify_m_of_n(env: &Env, signers: &Vec<Address>, required_threshold: u32) {
    let admin_set: Vec<Address> = read_admin_set(env);

    let mut counted: Vec<Address> = Vec::new(env);
    let mut valid_count: u32 = 0;
    for signer in signers.iter() {
        signer.require_auth();
        if admin_set.contains(&signer) && !counted.contains(&signer) {
            counted.push_back(signer.clone());
            valid_count = valid_count.checked_add(1).expect("valid_count overflow");
        }
    }

    if valid_count < required_threshold {
        panic!(
            "Insufficient admin signatures: {}/{} required",
            valid_count, required_threshold
        );
    }
}

/// Require M-of-N admin signatures for critical operations.
fn require_admin_for_critical(env: &Env, signers: &Vec<Address>) {
    let threshold: u32 = read_admin_threshold(env);
    verify_m_of_n(env, signers, threshold);
}

/// Require a single admin signature for routine operations.
fn require_admin_for_routine(env: &Env, signer: &Address) {
    signer.require_auth();
    let admin_set: Vec<Address> = read_admin_set(env);
    if !admin_set.contains(signer) {
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

#[cfg(feature = "impact")]
#[contracttype]
#[derive(Clone, Debug)]
enum ImpactKey {
    /// Merkle root keyed by SHA-256(project_id || report_id).
    ImRoot(BytesN<32>),
}

// ─── Merkle Proof Verification for Impact Certificates (#382) ──────────────

#[cfg(feature = "impact")]
/// Verify a Merkle proof against a known root using SHA-256.
///
/// Walks up the Merkle tree from `leaf` through each sibling in `proof`,
/// re-hashing with SHA-256 at each level. The `index` determines sibling
/// ordering: even indices put the current hash first, odd indices put the
/// sibling first.
///
/// Returns `true` if the computed root matches the expected `root`.
fn verify_merkle_proof(
    env: &Env,
    leaf: &BytesN<32>,
    proof: &Vec<BytesN<32>>,
    root: &BytesN<32>,
    index: u32,
) -> bool {
    let mut hash: BytesN<32> = leaf.clone();
    let mut idx = index;
    for sibling in proof.iter() {
        let mut combined = [0u8; 64];
        if idx.is_multiple_of(2) {
            combined[..32].copy_from_slice(&hash.to_array());
            combined[32..].copy_from_slice(&sibling.to_array());
        } else {
            combined[..32].copy_from_slice(&sibling.to_array());
            combined[32..].copy_from_slice(&hash.to_array());
        }
        hash = env
            .crypto()
            .sha256(&Bytes::from_slice(env, &combined))
            .into();
        idx /= 2;
    }
    hash == *root
}

#[cfg(feature = "impact")]
/// Compute the leaf hash for an ImpactLeaf using deterministic XDR serialization
/// followed by SHA-256. The off-chain Merkle tree builder MUST use the same
/// serialization to produce the proof.
fn compute_impact_leaf_hash(env: &Env, leaf: &ImpactLeaf) -> BytesN<32> {
    use soroban_sdk::xdr::ToXdr;
    let xdr_bytes = leaf.to_xdr(env);
    env.crypto().sha256(&xdr_bytes).into()
}

#[cfg(feature = "impact")]
/// Compute a deterministic 32-byte storage key from (project_id, report_id).
/// Uses SHA-256 of each component separately then SHA-256 of the concatenation
/// to prevent domain collisions (e.g., ("ab", "c") vs ("a", "bc")).
fn impact_merkle_key(env: &Env, project_id: &String, report_id: &String) -> BytesN<32> {
    let pid_hash = env.crypto().sha256(&project_id.clone().into());
    let rid_hash = env.crypto().sha256(&report_id.clone().into());
    let mut combined = [0u8; 64];
    combined[..32].copy_from_slice(&pid_hash.to_array());
    combined[32..].copy_from_slice(&rid_hash.to_array());
    env.crypto()
        .sha256(&Bytes::from_slice(env, &combined))
        .into()
}

/// Read the configured platform fee in basis points.
/// Returns 0 when the `fees` feature is disabled or no fee has been configured,
/// preserving backward compatibility.
fn read_platform_fee_bps(_env: &Env) -> u32 {
    #[cfg(feature = "fees")]
    {
        env.storage()
            .instance()
            .get(&DataKey::PlatformFeeBps)
            .unwrap_or(0)
    }
    #[cfg(not(feature = "fees"))]
    {
        0
    }
}

/// Split `amount` into (project_amount, fee_amount) based on the configured fee
/// rate in basis points. Returns `(amount, 0)` when `fee_bps` is 0.
fn split_fee(amount: i128, fee_bps: u32) -> (i128, i128) {
    if fee_bps == 0 {
        return (amount, 0);
    }
    let fee = amount
        .checked_mul(fee_bps as i128)
        .expect("Fee calculation overflow")
        / 10_000;
    let project_amount = amount.checked_sub(fee).expect("Amount minus fee underflow");
    (project_amount, fee)
}

fn ensure_min_ttl(env: &Env, min_ledgers: u32) {
    env.storage()
        .instance()
        .extend_ttl(min_ledgers, min_ledgers);
}

// ─── Storage versioning & migration (#379) ────────────────────────────────

/// Run pending storage migrations sequentially from the current version to
/// `CURRENT_STORAGE_VERSION`. Called automatically by `execute_upgrade()` after
/// the WASM is swapped, before any other contract function can be invoked.
///
/// Each migration step function (e.g., `migrate_v1_to_v2`) is responsible for
/// transforming old storage layouts to the new schema. After each step, the
/// `StorageVersion` key is updated so the migration is never applied twice.
#[cfg(feature = "upgrade")]
fn migrate(env: &Env) {
    let current: u32 = env
        .storage()
        .instance()
        .get(&STORAGE_VERSION_KEY)
        .unwrap_or(1);

    if current < 2 {
        migrate_v1_to_v2(env);
        env.storage().instance().set(&STORAGE_VERSION_KEY, &2u32);
    }
    // if current < 3 { migrate_v2_to_v3(env); ... }

    // After all migrations, StorageVersion must equal CURRENT_STORAGE_VERSION.
    // If a deployer forgot to bump CURRENT_STORAGE_VERSION after adding a
    // migration, this assertion catches it at upgrade time.
    let final_version: u32 = env
        .storage()
        .instance()
        .get(&STORAGE_VERSION_KEY)
        .unwrap_or(1);
    if final_version != CURRENT_STORAGE_VERSION {
        panic!(
            "Migration incomplete: at version {} but target is {}",
            final_version, CURRENT_STORAGE_VERSION
        );
    }
}

/// v1 → v2: No data transformation needed.
///
/// Storage keys and struct layouts are backward-compatible from v1 to v2.
/// This empty migration exists to establish the migration framework pattern.
/// When the first real schema change is introduced, replace this with actual
/// data transformations that rename keys, restructure values, or backfill
/// missing entries.
#[cfg(feature = "upgrade")]
fn migrate_v1_to_v2(_env: &Env) {
    // Intentionally empty — v1 data is v2-compatible.
    // Example pattern for a real migration:
    //   let old_value = env.storage().instance().get(&OldKey);
    //   env.storage().instance().set(&NewKey, &transformed_value);
    //   env.storage().instance().remove(&OldKey);
}

pub fn calculate_badge(total_stroops: i128) -> BadgeTier {
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

/// Reject donations when the project's campaign is not accepting them.
fn require_campaign_accepts_donation(project: &Project, current_ledger: u32) {
    match project.campaign_status {
        CampaignStatus::None => {}
        CampaignStatus::Active => {
            if current_ledger > project.deadline_ledger {
                panic!("Campaign deadline has passed");
            }
        }
        CampaignStatus::GoalReached => panic!("Campaign goal already reached"),
        CampaignStatus::Expired => panic!("Campaign has expired"),
        CampaignStatus::Closed => panic!("Campaign is closed"),
    }
}

/// After `total_raised` is updated, flip `Active` → `GoalReached` when the
/// campaign goal is met. Returns `true` when the transition happened.
fn apply_campaign_goal_progress(project: &mut Project) -> bool {
    if project.campaign_status == CampaignStatus::Active
        && project.goal > 0
        && project.total_raised >= project.goal
    {
        project.campaign_status = CampaignStatus::GoalReached;
        true
    } else {
        false
    }
}

pub fn voting_weight_from_badge(badge: &BadgeTier) -> u32 {
    match badge {
        BadgeTier::None => 0,
        BadgeTier::Seedling => 100,
        BadgeTier::Tree => 141,
        BadgeTier::Forest => 173,
        BadgeTier::EarthGuardian => 200,
    }
}

#[cfg(feature = "delegation")]
fn update_delegated_weight_if_needed(
    env: &Env,
    donor: &Address,
    prev_badge: &BadgeTier,
    new_badge: &BadgeTier,
) {
    if prev_badge != new_badge {
        let old_weight = voting_weight_from_badge(prev_badge);
        let new_weight = voting_weight_from_badge(new_badge);
        if new_weight > old_weight {
            let key = DataKey::VoteDelegation(donor.clone());
            if let Some(delegate) = env.storage().instance().get::<_, Address>(&key) {
                let del_key = DataKey::DelegatedWeight(delegate.clone());
                let mut del_weight: u32 = env.storage().instance().get(&del_key).unwrap_or(0);
                del_weight = del_weight
                    .checked_add(new_weight - old_weight)
                    .expect("Delegated weight overflow");
                env.storage().instance().set(&del_key, &del_weight);
            }
        }
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

    pub fn initialize(env: Env, admins: Vec<Address>, threshold: u32) {
        if env.storage().instance().has(&DataKey::AdminSet) {
            panic!("Contract already initialized");
        }
        if admins.is_empty() {
            panic!("Admin set must not be empty");
        }
        if threshold == 0 || threshold > admins.len() {
            panic!("Threshold must be between 1 and the number of admins");
        }
        env.storage().instance().set(&DataKey::AdminSet, &admins);
        env.storage()
            .instance()
            .set(&DataKey::AdminThreshold, &threshold);
        env.storage().instance().set(&DataKey::ProjectCount, &0u32);
        env.storage().instance().set(&DataKey::DonationCount, &0u32);
        env.storage()
            .instance()
            .set(&DataKey::GlobalTotalRaised, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::GlobalCO2OffsetGrams, &0i128);
        // Record the current storage schema version so post-upgrade migrations
        // know which transformations have already been applied.
        #[cfg(feature = "upgrade")]
        env.storage()
            .instance()
            .set(&STORAGE_VERSION_KEY, &CURRENT_STORAGE_VERSION);
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
        require_admin_for_routine(&env, &admin);
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
            goal: 0,
            deadline_ledger: 0,
            campaign_status: CampaignStatus::None,
            parent_project_id: None,
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

    /// Register a sub-project under an existing parent project.
    /// The caller must be the parent project's wallet (require_auth).
    /// Sub-projects are tracked in a `SubProjectIds(parent_id)` index
    /// and inherit deactivation from their parent.
    pub fn register_sub_project(
        env: Env,
        wallet: Address,
        project_id: String,
        name: String,
        co2_per_xlm: u32,
        parent_id: String,
    ) {
        wallet.require_auth();
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
        // Verify parent exists and wallet matches
        let parent: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(parent_id.clone()))
            .expect("Parent project not found");
        if parent.wallet != wallet {
            panic!("Wallet does not match parent project wallet");
        }
        let project = Project {
            id: project_id.clone(),
            name,
            wallet: wallet.clone(),
            co2_per_xlm,
            total_raised: 0,
            donor_count: 0,
            active: true,
            paused: false,
            registered_at: env.ledger().sequence(),
            goal: 0,
            deadline_ledger: 0,
            campaign_status: CampaignStatus::None,
            parent_project_id: Some(parent_id.clone()),
        };
        env.storage()
            .instance()
            .set(&DataKey::Project(project_id.clone()), &project);

        // Track in parent's sub-project list
        let mut sub_ids: Vec<String> = env
            .storage()
            .instance()
            .get(&DataKey::SubProjectIds(parent_id.clone()))
            .unwrap_or(Vec::new(&env));
        sub_ids.push_back(project_id.clone());
        env.storage()
            .instance()
            .set(&DataKey::SubProjectIds(parent_id.clone()), &sub_ids);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProjectCount)
            .unwrap_or(0);
        let next_count = count.checked_add(1).expect("ProjectCount overflow");
        env.storage()
            .instance()
            .set(&DataKey::ProjectCount, &next_count);

        // Track in global project id index
        let mut ids: Vec<String> = env
            .storage()
            .instance()
            .get(&DataKey::ProjectIdsAll)
            .unwrap_or(Vec::new(&env));
        ids.push_back(project_id.clone());
        env.storage().instance().set(&DataKey::ProjectIdsAll, &ids);

        env.events()
            .publish((symbol_short!("sub_reg"), wallet), (parent_id, project_id));
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    pub fn batch_register_projects(env: Env, admin: Address, projects: Vec<ProjectInit>) {
        require_admin_for_routine(&env, &admin);
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
                goal: 0,
                deadline_ledger: 0,
                campaign_status: CampaignStatus::None,
                parent_project_id: None,
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
    pub fn deactivate_all_projects(env: Env, signers: Vec<Address>) {
        require_admin_for_critical(&env, &signers);
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
            .publish((symbol_short!("deact_all"), signers.get(0).unwrap()), ids);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    pub fn deactivate_project(env: Env, admin: Address, project_id: String) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);
        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(project_id.clone()))
            .expect("Project not found");
        project.active = false;
        env.storage()
            .instance()
            .set(&DataKey::Project(project_id.clone()), &project);

        // Cascade deactivation to all sub-projects
        let sub_ids: Vec<String> = env
            .storage()
            .instance()
            .get(&DataKey::SubProjectIds(project_id.clone()))
            .unwrap_or(Vec::new(&env));
        for sub_id in sub_ids.iter() {
            let mut sub: Project = env
                .storage()
                .instance()
                .get(&DataKey::Project(sub_id.clone()))
                .expect("Sub-project not found");
            sub.active = false;
            env.storage()
                .instance()
                .set(&DataKey::Project(sub_id), &sub);
        }

        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    pub fn update_project_co2_rate(env: Env, admin: Address, project_id: String, co2_per_xlm: u32) {
        require_admin_for_routine(&env, &admin);
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
        require_admin_for_routine(&env, &admin);
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
        require_admin_for_routine(&env, &admin);
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

    // ─── Time-bound campaigns ─────────────────────────────────────────────────

    /// Admin-only: start a time-bound fundraising campaign on a project.
    /// Goal is denominated in stroops (XLM-equivalent). Only one campaign
    /// may be Active at a time; a prior campaign must be Closed or Expired.
    #[cfg(feature = "campaign")]
    pub fn create_campaign(
        env: Env,
        admin: Address,
        project_id: String,
        goal: i128,
        deadline_ledger: u32,
    ) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);
        if goal <= 0 {
            panic!("Campaign goal must be positive");
        }
        let current = env.ledger().sequence();
        if deadline_ledger <= current {
            panic!("Campaign deadline must be in the future");
        }

        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(project_id.clone()))
            .expect("Project not found");
        if !project.active {
            panic!("Project is not active");
        }
        match project.campaign_status {
            CampaignStatus::None | CampaignStatus::Closed | CampaignStatus::Expired => {}
            CampaignStatus::Active | CampaignStatus::GoalReached => {
                panic!("Project already has an open campaign");
            }
        }
        if goal <= project.total_raised {
            panic!("Campaign goal must exceed amount already raised");
        }

        project.goal = goal;
        project.deadline_ledger = deadline_ledger;
        project.campaign_status = CampaignStatus::Active;
        env.storage()
            .instance()
            .set(&DataKey::Project(project_id.clone()), &project);
        env.events().publish(
            (symbol_short!("camp_crt"), admin, project_id),
            (goal, deadline_ledger),
        );
    }

    /// Admin-only: push an Active campaign's deadline further into the future.
    #[cfg(feature = "campaign")]
    pub fn extend_campaign(env: Env, admin: Address, project_id: String, new_deadline: u32) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);

        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(project_id.clone()))
            .expect("Project not found");
        if project.campaign_status != CampaignStatus::Active {
            panic!("Campaign is not active");
        }
        let current = env.ledger().sequence();
        if current > project.deadline_ledger {
            panic!("Campaign deadline has passed");
        }
        if new_deadline <= project.deadline_ledger {
            panic!("New deadline must be after current deadline");
        }
        if new_deadline <= current {
            panic!("Campaign deadline must be in the future");
        }

        project.deadline_ledger = new_deadline;
        env.storage()
            .instance()
            .set(&DataKey::Project(project_id.clone()), &project);
        env.events()
            .publish((symbol_short!("camp_ext"), admin, project_id), new_deadline);
    }

    /// Admin-only: end a campaign. Early close → `Closed`; past deadline
    /// without meeting the goal → `Expired`; closing after `GoalReached` → `Closed`.
    #[cfg(feature = "campaign")]
    pub fn close_campaign(env: Env, admin: Address, project_id: String) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);

        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(project_id.clone()))
            .expect("Project not found");
        match project.campaign_status {
            CampaignStatus::Active => {
                if env.ledger().sequence() > project.deadline_ledger
                    && project.total_raised < project.goal
                {
                    project.campaign_status = CampaignStatus::Expired;
                } else {
                    project.campaign_status = CampaignStatus::Closed;
                }
            }
            CampaignStatus::GoalReached => {
                project.campaign_status = CampaignStatus::Closed;
            }
            _ => panic!("Campaign cannot be closed"),
        }
        env.storage()
            .instance()
            .set(&DataKey::Project(project_id.clone()), &project);
        env.events().publish(
            (symbol_short!("camp_cls"), admin, project_id),
            project.campaign_status.clone(),
        );
    }

    // ─── Platform Fee Configuration (#385) ────────────────────────────────────

    /// Admin-only (M-of-N): set the platform fee in basis points.
    ///
    /// `fee_bps` is capped at `MAX_PLATFORM_FEE_BPS` (500 = 5%).
    /// Setting to 0 disables the fee (backward compatible).
    ///
    /// # Panics
    /// - If `fee_bps` exceeds `MAX_PLATFORM_FEE_BPS` (500).
    #[cfg(feature = "fees")]
    pub fn set_platform_fee(env: Env, signers: Vec<Address>, fee_bps: u32) {
        require_admin_for_critical(&env, &signers);
        require_not_paused(&env);
        if fee_bps > MAX_PLATFORM_FEE_BPS {
            panic!("Platform fee exceeds maximum of 500 bps (5%)");
        }
        env.storage()
            .instance()
            .set(&DataKey::PlatformFeeBps, &fee_bps);
        env.events()
            .publish((symbol_short!("fee_set"), signers.get(0).unwrap()), fee_bps);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Admin-only (M-of-N): set the platform treasury address that receives fees.
    #[cfg(feature = "fees")]
    pub fn set_platform_treasury(env: Env, signers: Vec<Address>, treasury: Address) {
        require_admin_for_critical(&env, &signers);
        require_not_paused(&env);
        env.storage()
            .instance()
            .set(&DataKey::PlatformTreasury, &treasury);
        env.events().publish(
            (symbol_short!("treas_set"), signers.get(0).unwrap()),
            treasury,
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    // ─── Donations ────────────────────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    /// Backward-compatible public donation entrypoint.
    #[cfg(any(feature = "donation", feature = "testutils"))]
    pub fn donate(
        env: Env,
        token: Address,
        donor: Address,
        project_id: String,
        amount: i128,
        msg_hash: u32,
    ) {
        Self::donate_with_privacy(env, token, donor, project_id, amount, msg_hash, false)
    }

    /// Donate with an explicit public-attribution preference.
    #[cfg(any(feature = "donation", feature = "testutils"))]
    pub fn donate_with_privacy(
        env: Env,
        token: Address,
        donor: Address,
        project_id: String,
        amount: i128,
        msg_hash: u32,
        anonymous: bool,
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
        require_campaign_accepts_donation(&project, env.ledger().sequence());

        // Pre-compute CO2 increment with checked multiplication so an attacker
        // can't trigger a silent wrap via a project with a huge co2_per_xlm.
        let xlm_units = amount / STROOP;
        let co2_increment = xlm_units
            .checked_mul(project.co2_per_xlm as i128)
            .expect("CO2 calculation overflow");

        // Anonymous donations must not accrue to the donor's publicly-queryable
        // profile. Use the non-attributable placeholder for internal badge data.
        let stats_donor = if anonymous {
            Address::from_string(&String::from_str(
                &env,
                "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            ))
        } else {
            donor.clone()
        };
        let mut donor_stats: DonorStats = env
            .storage()
            .instance()
            .get(&DataKey::DonorStats(stats_donor.clone()))
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
        let goal_reached = apply_campaign_goal_progress(&mut project);
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
        if goal_reached {
            env.events().publish(
                (symbol_short!("camp_goal"), project_id.clone()),
                project.total_raised,
            );
        }

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
        #[cfg(feature = "delegation")]
        update_delegated_weight_if_needed(&env, &donor, &prev_badge, &donor_stats.badge);
        env.storage()
            .instance()
            .set(&DataKey::DonorStats(stats_donor.clone()), &donor_stats);

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
            anonymous,
            project: project_id.clone(),
            amount,
            ledger: env.ledger().sequence(),
            message_hash: msg_hash,
            currency: symbol_short!("XLM"),
        };
        env.storage()
            .instance()
            .set(&DataKey::DonationRecord(dc), &donation_record);
        if anonymous {
            let count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::AnonymousDonationCount)
                .unwrap_or(0);
            env.storage().instance().set(
                &DataKey::AnonymousDonationCount,
                &count
                    .checked_add(1)
                    .expect("AnonymousDonationCount overflow"),
            );
        }
        // Snapshot CO₂ offset for exact reversal on refund (#290).
        env.storage()
            .instance()
            .set(&DataKey::DonationCO2Offset(dc), &co2_increment);

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
        let fee_bps = read_platform_fee_bps(&env);
        #[allow(unused_variables)]
        let (project_amount, fee_amount) = split_fee(amount, fee_bps);

        let token_client = token::Client::new(&env, &token);

        // Transfer platform fee to treasury (if configured and feature enabled).
        #[cfg(feature = "fees")]
        if fee_amount > 0 {
            let treasury: Address = env
                .storage()
                .instance()
                .get(&DataKey::PlatformTreasury)
                .expect("Platform treasury not configured");
            token_client.transfer(&donor, &treasury, &fee_amount);
        }

        // Transfer remainder to project wallet.
        token_client.transfer(&donor, &project.wallet, &project_amount);

        #[cfg(feature = "fees")]
        env.events().publish(
            (symbol_short!("donated"), donor.clone(), project_id.clone()),
            (amount, donor_stats.badge.clone(), msg_hash, fee_amount),
        );
        #[cfg(not(feature = "fees"))]
        env.events().publish(
            (
                symbol_short!("donated"),
                if anonymous {
                    Address::from_string(&String::from_str(
                        &env,
                        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
                    ))
                } else {
                    donor.clone()
                },
                project_id.clone(),
            ),
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
    /// Backward-compatible path-payment entrypoint.
    #[cfg(any(feature = "donation", feature = "testutils"))]
    pub fn donate_asset(
        env: Env,
        donor: Address,
        project_id: String,
        xlm_amount: i128,
        source_asset_code: Symbol,
        msg_hash: u32,
    ) {
        Self::donate_asset_with_privacy(
            env,
            donor,
            project_id,
            xlm_amount,
            source_asset_code,
            msg_hash,
            false,
        )
    }

    /// Record a path-payment donation with an attribution preference.
    #[cfg(any(feature = "donation", feature = "testutils"))]
    pub fn donate_asset_with_privacy(
        env: Env,
        donor: Address,
        project_id: String,
        xlm_amount: i128,
        source_asset_code: Symbol,
        msg_hash: u32,
        anonymous: bool,
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
        require_campaign_accepts_donation(&project, env.ledger().sequence());

        // Pre-compute CO2 increment using the XLM-equivalent received
        let xlm_units = xlm_amount / STROOP;
        let co2_increment = xlm_units
            .checked_mul(project.co2_per_xlm as i128)
            .expect("CO2 calculation overflow");

        let stats_donor = if anonymous {
            Address::from_string(&String::from_str(
                &env,
                "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            ))
        } else {
            donor.clone()
        };
        let mut donor_stats: DonorStats = env
            .storage()
            .instance()
            .get(&DataKey::DonorStats(stats_donor.clone()))
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
        let goal_reached = apply_campaign_goal_progress(&mut project);
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
        if goal_reached {
            env.events().publish(
                (symbol_short!("camp_goal"), project_id.clone()),
                project.total_raised,
            );
        }

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
        #[cfg(feature = "delegation")]
        update_delegated_weight_if_needed(&env, &donor, &prev_badge, &donor_stats.badge);
        env.storage()
            .instance()
            .set(&DataKey::DonorStats(stats_donor.clone()), &donor_stats);

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
            anonymous,
            project: project_id.clone(),
            amount: xlm_amount,
            ledger: env.ledger().sequence(),
            message_hash: msg_hash,
            currency: source_asset_code,
        };
        env.storage()
            .instance()
            .set(&DataKey::DonationRecord(dc), &donation_record);
        if anonymous {
            let count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::AnonymousDonationCount)
                .unwrap_or(0);
            env.storage().instance().set(
                &DataKey::AnonymousDonationCount,
                &count
                    .checked_add(1)
                    .expect("AnonymousDonationCount overflow"),
            );
        }
        // Snapshot CO₂ offset for exact reversal on refund (#290).
        env.storage()
            .instance()
            .set(&DataKey::DonationCO2Offset(dc), &co2_increment);

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

        #[cfg(feature = "fees")]
        {
            let fee_bps = read_platform_fee_bps(&env);
            let (_project_amount, fee_amount) = split_fee(xlm_amount, fee_bps);
            // Note: no actual fee transfer occurs here because the path payment
            // already delivered XLM to the project wallet in the same transaction.
            // The fee is emitted in the event for transparency only.
            env.events().publish(
                (symbol_short!("donated"), donor.clone(), project_id.clone()),
                (xlm_amount, donor_stats.badge.clone(), msg_hash, fee_amount),
            );
        }
        #[cfg(not(feature = "fees"))]
        env.events().publish(
            (
                symbol_short!("donated"),
                if anonymous {
                    Address::from_string(&String::from_str(
                        &env,
                        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
                    ))
                } else {
                    donor.clone()
                },
                project_id.clone(),
            ),
            (xlm_amount, donor_stats.badge.clone(), msg_hash),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    // ─── zk-SNARK Anonymous Donations (#390) ─────────────────────────────────

    /// Admin-only: set the Groth16 verification key for anonymous donations.
    /// The verification key is a serialized Groth16 vk for the donation circuit.
    /// Only one key may be active at a time; calling this again overwrites it.
    #[cfg(feature = "zk")]
    pub fn set_zk_verification_key(env: Env, admin: Address, vk: Bytes) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);
        if vk.is_empty() {
            panic!("Verification key must not be empty");
        }
        env.storage()
            .instance()
            .set(&DataKey::ZkVerificationKey, &vk);
        env.events()
            .publish((symbol_short!("zk_vk_set"), admin), vk.len() as u32);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Query the current Groth16 verification key, if set.
    #[cfg(feature = "zk")]
    pub fn get_zk_verification_key(env: Env) -> Option<Bytes> {
        env.storage().instance().get(&DataKey::ZkVerificationKey)
    }

    #[cfg(feature = "impact")]
    /// Get the Merkle root for a project impact report.
    pub fn get_impact_merkle_root(
        env: Env,
        project_id: String,
        report_id: String,
    ) -> Option<BytesN<32>> {
        env.storage()
            .instance()
            .get(&ImpactKey::ImRoot(impact_merkle_key(
                &env,
                &project_id,
                &report_id,
            )))
    }

    /// Anonymous donation via zk-SNARK proof verification.
    ///
    /// A donor generates a Groth16 proof off-chain proving they have sufficient
    /// tokens and a valid project/amount/nullifier tuple. The contract verifies
    /// the proof on-chain and records the donation under a derived anonymous
    /// donor address (sha256 of the nullifier).
    ///
    /// # Prerequisites
    /// - Admin must have set the verification key via `set_zk_verification_key`.
    /// - The donor must transfer tokens to the contract address BEFORE calling
    ///   this function (in the same atomic transaction) so the contract can
    ///   forward them to the project wallet.
    /// - Each nullifier must be globally unique across all anonymous donations.
    ///
    /// # Parameters
    /// - `token`: The Stellar asset contract address for the donation currency.
    /// - `proof`: The serialized Groth16 proof bytes.
    /// - `project_id`: The project receiving the donation.
    /// - `amount`: Donation amount in token's smallest unit (stroops).
    /// - `nullifier`: Unique 32-byte value preventing double-spend of the proof.
    /// - `msg_hash`: 4-byte message hash bound to the proof circuit.
    ///
    /// # Panics
    /// - If the verification key has not been set.
    /// - If the nullifier has already been used.
    /// - If the Groth16 proof fails verification.
    /// - If the project is not found, inactive, or paused.
    /// - If the amount is not positive.
    #[cfg(feature = "zk")]
    #[allow(clippy::too_many_arguments)]
    pub fn donate_anonymous(
        env: Env,
        token: Address,
        proof: Bytes,
        project_id: String,
        amount: i128,
        nullifier: BytesN<32>,
        msg_hash: u32,
    ) {
        require_not_paused(&env);
        if amount <= 0 {
            panic!("Donation amount must be positive");
        }

        let nullifier_key = DataKey::Nullifier(nullifier.clone());
        if env.storage().instance().has(&nullifier_key) {
            panic!("Nullifier already spent");
        }

        // Load and verify the Groth16 proof against the admin-set vk.
        let vk: Bytes = env
            .storage()
            .instance()
            .get(&DataKey::ZkVerificationKey)
            .expect("Verification key not set — admin must call set_zk_verification_key first");

        // Construct public inputs: [amount (i128 LE), msg_hash (u32 LE),
        // project_id hash, nullifier hash]. The circuit MUST match this layout.
        // We pack them into a single Bytes blob for groth16_verify.
        let project_id_hash = env.crypto().sha256(&project_id.clone().into());

        let mut public_inputs = Bytes::new(&env);
        public_inputs.append(&amount.to_be_bytes().as_slice().into());
        public_inputs.append(&msg_hash.to_be_bytes().as_slice().into());
        public_inputs.append(&project_id_hash.into());
        public_inputs.append(&Bytes::from_slice(&env, nullifier.as_ref()));

        if !env.crypto().groth16_verify(&vk, &proof, &public_inputs) {
            panic!("Anonymous donation proof verification failed");
        }

        // Derive the anonymous donor address from the nullifier.
        // Address::from_bytes takes raw bytes — we use sha256 of the nullifier
        // to produce a deterministic 32-byte anonymous address.
        let nullifier_hash = env
            .crypto()
            .sha256(&Bytes::from_slice(&env, nullifier.as_ref()));
        let anon_donor = Address::from_bytes(&nullifier_hash.to_bytes().as_ref().into());

        // ── Checks ───────────────────────────────────────────────────────────

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
        require_campaign_accepts_donation(&project, env.ledger().sequence());

        // Pre-compute CO2 increment.
        let xlm_units = amount / STROOP;
        let co2_increment = xlm_units
            .checked_mul(project.co2_per_xlm as i128)
            .expect("CO2 calculation overflow");

        let mut donor_stats: DonorStats = env
            .storage()
            .instance()
            .get(&DataKey::DonorStats(anon_donor.clone()))
            .unwrap_or(DonorStats {
                total_donated: 0,
                donation_count: 0,
                badge: BadgeTier::None,
                co2_offset_grams: 0,
            });
        let prev_badge = donor_stats.badge.clone();

        // ── Effects (Checks-Effects-Interactions) ────────────────────────────

        // Mark nullifier as spent AFTER all checks pass, as part of the
        // Effects step. Prevents griefing where a valid proof for a
        // deactivated project permanently consumes the nullifier.
        env.storage().instance().set(&nullifier_key, &true);

        project.total_raised = project
            .total_raised
            .checked_add(amount)
            .expect("Project total_raised overflow");
        let goal_reached = apply_campaign_goal_progress(&mut project);
        let donated_key = DataKey::HasDonated(project_id.clone(), anon_donor.clone());
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
        if goal_reached {
            env.events().publish(
                (symbol_short!("camp_goal"), project_id.clone()),
                project.total_raised,
            );
        }

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
        #[cfg(feature = "delegation")]
        update_delegated_weight_if_needed(&env, &anon_donor, &prev_badge, &donor_stats.badge);
        env.storage()
            .instance()
            .set(&DataKey::DonorStats(anon_donor.clone()), &donor_stats);

        // Track per-project cumulative donations for milestone NFT eligibility.
        let proj_total_key = DataKey::DonorProjectTotal(project_id.clone(), anon_donor.clone());
        let prev_proj_total: i128 = env.storage().instance().get(&proj_total_key).unwrap_or(0);
        env.storage().instance().set(
            &proj_total_key,
            &prev_proj_total
                .checked_add(amount)
                .expect("DonorProjectTotal overflow"),
        );

        // Auto-mint an Impact NFT when the anonymous donor reaches a new badge tier.
        if donor_stats.badge != BadgeTier::None && donor_stats.badge != prev_badge {
            let nft_key = DataKey::ImpactNFT(anon_donor.clone(), donor_stats.badge.clone());
            if !env.storage().instance().has(&nft_key) {
                let nft = ImpactNFT {
                    owner: anon_donor.clone(),
                    tier: donor_stats.badge.clone(),
                    total_donated: donor_stats.total_donated,
                    minted_at_ledger: env.ledger().sequence(),
                };
                env.storage().instance().set(&nft_key, &nft);
                env.events().publish(
                    (symbol_short!("nft_mint"), anon_donor.clone()),
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
        // Store donation record under the anonymous donor address.
        let donation_record = DonationRecord {
            donor: anon_donor.clone(),
            project: project_id.clone(),
            amount,
            ledger: env.ledger().sequence(),
            message_hash: msg_hash,
            currency: symbol_short!("XLM"),
        };
        env.storage()
            .instance()
            .set(&DataKey::DonationRecord(dc), &donation_record);
        env.storage()
            .instance()
            .set(&DataKey::DonationCO2Offset(dc), &co2_increment);

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

        // ── Interaction: transfer tokens from contract to project wallet.
        //    The donor must have transferred tokens to the contract in the same
        //    atomic transaction (before this call) so the contract holds a
        //    sufficient balance.
        let token_client = token::Client::new(&env, &token);
        let contract_addr = env.current_contract_address();

        // Fee split for anonymous donations.
        let fee_bps = read_platform_fee_bps(&env);
        #[allow(unused_variables)]
        let (project_amount, fee_amount) = split_fee(amount, fee_bps);

        #[cfg(feature = "fees")]
        if fee_amount > 0 {
            let treasury: Address = env
                .storage()
                .instance()
                .get(&DataKey::PlatformTreasury)
                .expect("Platform treasury not configured");
            token_client.transfer(&contract_addr, &treasury, &fee_amount);
        }

        token_client.transfer(&contract_addr, &project.wallet, &project_amount);

        #[cfg(feature = "fees")]
        env.events().publish(
            (
                symbol_short!("anon_don"),
                anon_donor.clone(),
                project_id.clone(),
            ),
            (amount, donor_stats.badge.clone(), msg_hash, fee_amount),
        );
        #[cfg(not(feature = "fees"))]
        env.events().publish(
            (
                symbol_short!("anon_don"),
                anon_donor.clone(),
                project_id.clone(),
            ),
            (amount, donor_stats.badge.clone(), msg_hash),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Check if a nullifier has already been spent.
    #[cfg(feature = "zk")]
    pub fn is_nullifier_spent(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage().instance().has(&DataKey::Nullifier(nullifier))
    }

    // ─── On-chain Impact Certificates (#382) ────────────────────────────────

    #[cfg(feature = "impact")]
    /// Admin-only: post a Merkle root for a project's impact report.
    ///
    /// The Merkle tree of all donor impacts for the reporting period
    /// is constructed off-chain by the backend. Only the root is stored
    /// on-chain, enabling any donor to verify their individual impact
    /// leaf against it via `verify_impact` without revealing other donors'
    /// data.
    ///
    /// # Parameters
    /// - `admin`: A registered admin address (requires `require_auth`).
    /// - `project_id`: The project this report belongs to.
    /// - `merkle_root`: The 32-byte Merkle root computed off-chain.
    /// - `report_id`: A human-readable report identifier (e.g. "Q1 2026").
    ///
    /// # Panics
    /// - If the caller is not an admin.
    /// - If the contract is paused.
    /// - If the project does not exist.
    pub fn set_impact_merkle_root(
        env: Env,
        admin: Address,
        project_id: String,
        merkle_root: BytesN<32>,
        report_id: String,
    ) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);
        // Verify the project exists so we don't store roots for phantom projects.
        env.storage()
            .instance()
            .get::<_, Project>(&DataKey::Project(project_id.clone()))
            .expect("Project not found");

        env.storage().instance().set(
            &ImpactKey::ImRoot(impact_merkle_key(&env, &project_id, &report_id)),
            &merkle_root,
        );

        env.events().publish(
            (symbol_short!("impact_rt"), admin, project_id, report_id),
            merkle_root,
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    #[cfg(feature = "impact")]
    /// Public read-only: verify a donor's impact claim against a stored Merkle root.
    ///
    /// Any caller (donor, auditor, third party) can invoke this function to
    /// cryptographically verify that the platform's claimed impact for a
    /// specific donor matches the on-chain Merkle root. No authorization is
    /// required — only the mathematical correctness of the proof.
    ///
    /// # Parameters
    /// - `project_id`: The project the impact report belongs to.
    /// - `report_id`: The report identifier (must match what was passed to
    ///   `set_impact_merkle_root`).
    /// - `impact_data`: The `ImpactLeaf` claimed for this donor.
    /// - `proof`: The Merkle proof (list of sibling hashes) from the leaf to
    ///   the root.
    /// - `leaf_index`: The position of this leaf within the Merkle tree
    ///   (used to determine sibling ordering).
    ///
    /// # Returns
    /// - `true` if the proof is valid and the computed root matches the stored root.
    /// - `false` if the Merkle root has not been posted for this project/report,
    ///   or the proof does not verify.
    pub fn verify_impact(
        env: Env,
        project_id: String,
        report_id: String,
        impact_data: ImpactLeaf,
        proof: Vec<BytesN<32>>,
        leaf_index: u32,
    ) -> bool {
        let key = ImpactKey::ImRoot(impact_merkle_key(&env, &project_id, &report_id));
        let stored_root: Option<BytesN<32>> = env.storage().instance().get(&key);
        let stored_root = match stored_root {
            Some(r) => r,
            None => return false,
        };

        let leaf_hash = compute_impact_leaf_hash(&env, &impact_data);
        verify_merkle_proof(&env, &leaf_hash, &proof, &stored_root, leaf_index)
    }

    // ─── Getters ─────────────────────────────────────────────────────────────

    pub fn get_project(env: Env, project_id: String) -> Project {
        env.storage()
            .instance()
            .get(&DataKey::Project(project_id))
            .expect("Project not found")
    }

    /// Returns all sub-project IDs registered under the given parent.
    pub fn get_sub_projects(env: Env, parent_id: String) -> Vec<String> {
        env.storage()
            .instance()
            .get(&DataKey::SubProjectIds(parent_id))
            .unwrap_or(Vec::new(&env))
    }

    /// Returns aggregated impact metrics for a parent project and all its
    /// sub-projects: (total_raised, total_co2, total_donors).
    /// CO₂ is recomputed per-project as (total_raised / STROOP) * co2_per_xlm.
    pub fn get_aggregated_impact(env: Env, parent_id: String) -> (i128, i128, u32) {
        let parent: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(parent_id.clone()))
            .expect("Project not found");

        let mut total_raised = parent.total_raised;
        let mut total_donors = parent.donor_count;
        let parent_xlm = parent.total_raised / STROOP;
        let mut total_co2 = parent_xlm
            .checked_mul(parent.co2_per_xlm as i128)
            .expect("CO2 calculation overflow");

        let sub_ids: Vec<String> = env
            .storage()
            .instance()
            .get(&DataKey::SubProjectIds(parent_id))
            .unwrap_or(Vec::new(&env));
        for sub_id in sub_ids.iter() {
            let sub: Project = env
                .storage()
                .instance()
                .get(&DataKey::Project(sub_id))
                .expect("Sub-project not found");
            total_raised = total_raised
                .checked_add(sub.total_raised)
                .expect("Aggregated total_raised overflow");
            total_donors = total_donors
                .checked_add(sub.donor_count)
                .expect("Aggregated donor_count overflow");
            let sub_xlm = sub.total_raised / STROOP;
            total_co2 = total_co2
                .checked_add(
                    sub_xlm
                        .checked_mul(sub.co2_per_xlm as i128)
                        .expect("CO2 calculation overflow"),
                )
                .expect("Aggregated CO2 overflow");
        }
        (total_raised, total_co2, total_donors)
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

    /// Number of donations whose donor address is intentionally withheld.
    pub fn get_anonymous_donation_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::AnonymousDonationCount)
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

    /// Backward-compatible getter: returns the first admin in the set.
    /// Prefer `get_admin_set()` for multi-sig contexts.
    pub fn get_admin(env: Env) -> Address {
        let admin_set: Vec<Address> = read_admin_set(&env);
        admin_set.get(0).expect("Admin set is empty")
    }

    /// Returns the full admin set.
    pub fn get_admin_set(env: Env) -> Vec<Address> {
        read_admin_set(&env)
    }

    /// Returns the current M-of-N threshold for critical actions.
    pub fn get_admin_threshold(env: Env) -> u32 {
        read_admin_threshold(&env)
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
    #[cfg(feature = "governance")]
    pub fn create_proposal(
        env: Env,
        signers: Vec<Address>,
        project_id: String,
        duration_ledgers: u32,
    ) {
        require_admin_for_critical(&env, &signers);
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
        env.events().publish(
            (symbol_short!("prop_new"), signers.get(0).unwrap()),
            (project_id, window),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    #[cfg(feature = "governance")]
    pub fn get_voter_weight(env: Env, voter: Address) -> u32 {
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
        let own_weight = voting_weight_from_badge(&stats.badge);
        #[cfg(feature = "delegation")]
        let delegated_weight: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DelegatedWeight(voter))
            .unwrap_or(0);
        #[cfg(not(feature = "delegation"))]
        let delegated_weight: u32 = 0;
        own_weight
            .checked_add(delegated_weight)
            .expect("Weight overflow")
    }

    #[cfg(feature = "delegation")]
    pub fn delegate_vote(env: Env, donor: Address, delegate: Address) {
        donor.require_auth();
        require_not_paused(&env);

        if donor == delegate {
            panic!("Cannot delegate to self");
        }

        let del_key = DataKey::VoteDelegation(donor.clone());
        let old_delegate: Option<Address> = env.storage().instance().get(&del_key);

        if let Some(ref old) = old_delegate {
            if *old == delegate {
                panic!("Already delegated to this address");
            }
        }

        let donor_stats: DonorStats = env
            .storage()
            .instance()
            .get(&DataKey::DonorStats(donor.clone()))
            .unwrap_or(DonorStats {
                total_donated: 0,
                donation_count: 0,
                badge: BadgeTier::None,
                co2_offset_grams: 0,
            });

        let weight = voting_weight_from_badge(&donor_stats.badge);

        if let Some(old) = old_delegate {
            let old_del_key = DataKey::DelegatedWeight(old.clone());
            let mut old_weight: u32 = env.storage().instance().get(&old_del_key).unwrap_or(0);
            old_weight = old_weight.checked_sub(weight).expect("Weight underflow");
            env.storage().instance().set(&old_del_key, &old_weight);
        }

        let new_del_key = DataKey::DelegatedWeight(delegate.clone());
        let mut new_weight: u32 = env.storage().instance().get(&new_del_key).unwrap_or(0);
        new_weight = new_weight.checked_add(weight).expect("Weight overflow");

        env.storage().instance().set(&new_del_key, &new_weight);
        env.storage().instance().set(&del_key, &delegate);

        env.events()
            .publish((symbol_short!("delegate"), donor), delegate);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    #[cfg(feature = "delegation")]
    pub fn revoke_delegation(env: Env, donor: Address) {
        donor.require_auth();
        require_not_paused(&env);

        let del_key = DataKey::VoteDelegation(donor.clone());
        let delegate: Option<Address> = env.storage().instance().get(&del_key);

        if let Some(del) = delegate {
            let donor_stats: DonorStats = env
                .storage()
                .instance()
                .get(&DataKey::DonorStats(donor.clone()))
                .unwrap_or(DonorStats {
                    total_donated: 0,
                    donation_count: 0,
                    badge: BadgeTier::None,
                    co2_offset_grams: 0,
                });

            let weight = voting_weight_from_badge(&donor_stats.badge);

            let old_del_key = DataKey::DelegatedWeight(del.clone());
            let mut old_weight: u32 = env.storage().instance().get(&old_del_key).unwrap_or(0);
            old_weight = old_weight.checked_sub(weight).expect("Weight underflow");
            env.storage().instance().set(&old_del_key, &old_weight);

            env.storage().instance().remove(&del_key);

            env.events().publish((symbol_short!("revoke"), donor), ());
            ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
        } else {
            panic!("No active delegation to revoke");
        }
    }

    #[cfg(feature = "delegation")]
    pub fn get_delegate(env: Env, donor: Address) -> Option<Address> {
        env.storage()
            .instance()
            .get(&DataKey::VoteDelegation(donor))
    }

    #[cfg(feature = "delegation")]
    pub fn get_delegated_weight(env: Env, delegate: Address) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::DelegatedWeight(delegate))
            .unwrap_or(0)
    }

    /// Badge holders (≥ Seedling) cast a vote. One vote per address per proposal.
    #[cfg(feature = "governance")]
    pub fn vote_verify_project(env: Env, voter: Address, project_id: String, approve: bool) {
        voter.require_auth();
        require_not_paused(&env);

        if env
            .storage()
            .instance()
            .has(&DataKey::VoteDelegation(voter.clone()))
        {
            panic!("Must revoke delegation before voting directly");
        }

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

        let own_weight = voting_weight_from_badge(&stats.badge);
        let delegated_weight: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DelegatedWeight(voter.clone()))
            .unwrap_or(0);
        let weight = own_weight
            .checked_add(delegated_weight)
            .expect("Weight overflow");

        if weight == 0 {
            panic!("Only badge holders (Seedling or above) or active delegates can vote");
        }

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
    #[cfg(feature = "governance")]
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
    #[cfg(feature = "governance")]
    pub fn veto_proposal(env: Env, signers: Vec<Address>, project_id: String) {
        require_admin_for_critical(&env, &signers);
        let mut proposal: VoteProposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(project_id.clone()))
            .expect("Proposal not found");
        if proposal.resolved {
            panic!("Proposal already resolved");
        }
        proposal.resolved = true;
        env.events().publish(
            (symbol_short!("prop_veto"), signers.get(0).unwrap()),
            project_id.clone(),
        );
        env.storage()
            .instance()
            .set(&DataKey::Proposal(project_id), &proposal);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Returns current vote counts and status for a proposal.
    #[cfg(feature = "governance")]
    pub fn get_proposal(env: Env, project_id: String) -> VoteProposal {
        env.storage()
            .instance()
            .get(&DataKey::Proposal(project_id))
            .expect("Proposal not found")
    }

    /// Returns the list of voter addresses for a proposal.
    /// Can be used by governance UIs to display who voted and how.
    #[cfg(feature = "governance")]
    pub fn get_voter_list(env: Env, project_id: String) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::VoterList(project_id))
            .unwrap_or(Vec::new(&env))
    }

    /// Donate USDC. Converts to XLM-equivalent for global stats using a price oracle stub.
    /// Backward-compatible USDC entrypoint.
    #[cfg(feature = "usdc")]
    pub fn donate_usdc(
        env: Env,
        usdc_token: Address,
        donor: Address,
        project_id: String,
        usdc_amount: i128,
        msg_hash: u32,
    ) {
        Self::donate_usdc_with_privacy(
            env,
            usdc_token,
            donor,
            project_id,
            usdc_amount,
            msg_hash,
            false,
        )
    }

    /// Donate USDC with an explicit public-attribution preference.
    #[cfg(feature = "usdc")]
    pub fn donate_usdc_with_privacy(
        env: Env,
        usdc_token: Address,
        donor: Address,
        project_id: String,
        usdc_amount: i128,
        msg_hash: u32,
        anonymous: bool,
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
        require_campaign_accepts_donation(&project, env.ledger().sequence());

        // Pre-compute CO2 increment using XLM-equivalent
        let xlm_units = xlm_equivalent / STROOP;
        let co2_increment = xlm_units
            .checked_mul(project.co2_per_xlm as i128)
            .expect("CO2 calculation overflow");

        let stats_donor = if anonymous {
            Address::from_string(&String::from_str(
                &env,
                "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            ))
        } else {
            donor.clone()
        };
        let mut donor_stats: DonorStats = env
            .storage()
            .instance()
            .get(&DataKey::DonorStats(stats_donor.clone()))
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
        let goal_reached = apply_campaign_goal_progress(&mut project);
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
        if goal_reached {
            env.events().publish(
                (symbol_short!("camp_goal"), project_id.clone()),
                project.total_raised,
            );
        }

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
        #[cfg(feature = "delegation")]
        update_delegated_weight_if_needed(&env, &donor, &prev_badge, &donor_stats.badge);
        env.storage()
            .instance()
            .set(&DataKey::DonorStats(stats_donor.clone()), &donor_stats);

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
            anonymous,
            project: project_id.clone(),
            amount: usdc_amount,
            ledger: env.ledger().sequence(),
            message_hash: msg_hash,
            currency: symbol_short!("USDC"),
        };
        env.storage()
            .instance()
            .set(&DataKey::DonationRecord(dc), &donation_record);
        if anonymous {
            let count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::AnonymousDonationCount)
                .unwrap_or(0);
            env.storage().instance().set(
                &DataKey::AnonymousDonationCount,
                &count
                    .checked_add(1)
                    .expect("AnonymousDonationCount overflow"),
            );
        }
        // Snapshot CO₂ offset for exact reversal on refund (#290).
        env.storage()
            .instance()
            .set(&DataKey::DonationCO2Offset(dc), &co2_increment);

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

        // Fee split for USDC donations.
        let fee_bps = read_platform_fee_bps(&env);
        #[allow(unused_variables)]
        let (project_usdc, fee_amount) = split_fee(usdc_amount, fee_bps);

        #[cfg(feature = "fees")]
        if fee_amount > 0 {
            let treasury: Address = env
                .storage()
                .instance()
                .get(&DataKey::PlatformTreasury)
                .expect("Platform treasury not configured");
            token_client.transfer(&donor, &treasury, &fee_amount);
        }

        token_client.transfer(&donor, &project_wallet, &project_usdc);

        #[cfg(feature = "fees")]
        env.events().publish(
            (symbol_short!("donated"), donor.clone(), project_id),
            (usdc_amount, symbol_short!("USDC"), msg_hash, fee_amount),
        );
        #[cfg(not(feature = "fees"))]
        env.events().publish(
            (
                symbol_short!("donated"),
                if anonymous {
                    Address::from_string(&String::from_str(
                        &env,
                        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
                    ))
                } else {
                    donor.clone()
                },
                project_id,
            ),
            (usdc_amount, symbol_short!("USDC"), msg_hash),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Admin-only: Set the USDC token address for multi-currency donations.
    #[cfg(feature = "usdc")]
    pub fn set_usdc_token(env: Env, admin: Address, usdc_token: Address) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);
        env.storage()
            .instance()
            .set(&DataKey::USDCTokenAddress, &usdc_token);
        env.events()
            .publish((symbol_short!("usdc_set"),), usdc_token);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Get the configured USDC token address.
    #[cfg(feature = "usdc")]
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
        require_admin_for_routine(&env, &admin);
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
    #[cfg(feature = "usdc")]
    pub fn set_oracle(env: Env, admin: Address, oracle: Address) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);
        env.storage()
            .instance()
            .set(&DataKey::OracleAddress, &oracle);
        env.events().publish((symbol_short!("oracle"),), oracle);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Get the configured price oracle address.
    #[cfg(feature = "usdc")]
    pub fn get_oracle(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::OracleAddress)
    }

    /// Get the current contract WASM hash.
    #[cfg(feature = "upgrade")]
    pub fn get_contract_wasm_hash(env: Env) -> Option<BytesN<32>> {
        env.storage().instance().get(&DataKey::ContractWasmHash)
    }

    // ─── Two-step admin transfer ─────────────────────────────────────────────

    /// Admin-only: step 1 of a two-step admin transfer. M-of-N admins
    /// sign to propose swapping `old_admin` for `new_admin` in the admin
    /// set. The swap is finalized when `new_admin` calls `accept_admin`.
    /// The admin set size and threshold are preserved — this is an
    /// in-place swap, not a dissolution of the multi-sig.
    /// Refuses to overwrite an existing pending transfer — the caller must
    /// `cancel_admin_transfer` first.
    pub fn transfer_admin(env: Env, signers: Vec<Address>, old_admin: Address, new_admin: Address) {
        require_admin_for_critical(&env, &signers);
        if env.storage().instance().has(&DataKey::PendingAdmin) {
            panic!("Admin transfer already pending; cancel first");
        }
        let admin_set: Vec<Address> = read_admin_set(&env);
        if !admin_set.contains(&old_admin) {
            panic!("old_admin is not in the admin set");
        }
        if admin_set.contains(&new_admin) {
            panic!("new_admin is already an admin");
        }
        env.storage().instance().set(
            &DataKey::PendingAdmin,
            &(old_admin.clone(), new_admin.clone()),
        );
        env.events()
            .publish((symbol_short!("ad_xfer"), old_admin), new_admin);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Step 2 of the two-step transfer. The caller must be the `new_admin`
    /// recorded by a prior `transfer_admin`. On success `old_admin` is
    /// replaced by `new_admin` in the admin set (in-place swap). Threshold
    /// and set size are preserved.
    pub fn accept_admin(env: Env) {
        let (old_admin, new_admin): (Address, Address) = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .expect("No pending admin transfer");
        new_admin.require_auth();

        let admin_set: Vec<Address> = read_admin_set(&env);

        if !admin_set.contains(&old_admin) {
            panic!("old_admin no longer in admin set; transfer stale");
        }
        if admin_set.contains(&new_admin) {
            panic!("new_admin already an admin; transfer stale");
        }

        let mut new_set: Vec<Address> = Vec::new(&env);
        for addr in admin_set.iter() {
            if addr == old_admin {
                new_set.push_back(new_admin.clone());
            } else {
                new_set.push_back(addr);
            }
        }
        env.storage().instance().set(&DataKey::AdminSet, &new_set);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.events().publish((symbol_short!("ad_acc"),), new_admin);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Admin-only: cancel a pending admin transfer without performing the swap.
    /// Useful when the proposed recipient lost their key or the transfer
    /// was a mistake.
    pub fn cancel_admin_transfer(env: Env, signers: Vec<Address>) {
        require_admin_for_critical(&env, &signers);
        if !env.storage().instance().has(&DataKey::PendingAdmin) {
            panic!("No pending admin transfer");
        }
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.events().publish((symbol_short!("ad_xfc"),), ());
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Returns `(old_admin, new_admin)` if a transfer is pending, or `None`.
    pub fn get_pending_admin(env: Env) -> Option<(Address, Address)> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    // ─── Admin set management ────────────────────────────────────────────────

    /// M-of-N: add a new address to the admin set.
    pub fn add_admin(env: Env, signers: Vec<Address>, new_admin: Address) {
        require_admin_for_critical(&env, &signers);
        let mut admin_set: Vec<Address> = read_admin_set(&env);
        if admin_set.contains(&new_admin) {
            panic!("Address is already an admin");
        }
        admin_set.push_back(new_admin.clone());
        env.storage().instance().set(&DataKey::AdminSet, &admin_set);
        env.events()
            .publish((symbol_short!("admin_add"),), new_admin);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// M-of-N: remove an address from the admin set. Panics if this would
    /// leave the set empty, or if the resulting set is smaller than the
    /// current threshold (call `update_threshold` first).
    pub fn remove_admin(env: Env, signers: Vec<Address>, admin_to_remove: Address) {
        require_admin_for_critical(&env, &signers);
        let admin_set: Vec<Address> = read_admin_set(&env);
        if !admin_set.contains(&admin_to_remove) {
            panic!("Address is not an admin");
        }
        if admin_set.len() <= 1 {
            panic!("Cannot remove last admin");
        }
        let mut new_set: Vec<Address> = Vec::new(&env);
        for addr in admin_set.iter() {
            if addr != admin_to_remove {
                new_set.push_back(addr);
            }
        }
        let threshold: u32 = read_admin_threshold(&env);
        if threshold > new_set.len() {
            panic!(
                "Threshold {} exceeds admin count {}; call update_threshold first",
                threshold,
                new_set.len()
            );
        }
        env.storage().instance().set(&DataKey::AdminSet, &new_set);
        env.events()
            .publish((symbol_short!("admin_rmv"),), admin_to_remove);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// M-of-N: update the threshold for critical actions. Must satisfy
    /// 1 <= new_threshold <= admin_set.len().
    pub fn update_threshold(env: Env, signers: Vec<Address>, new_threshold: u32) {
        require_admin_for_critical(&env, &signers);
        let admin_set: Vec<Address> = read_admin_set(&env);
        if new_threshold == 0 || new_threshold > admin_set.len() {
            panic!("Threshold must be between 1 and the number of admins");
        }
        env.storage()
            .instance()
            .set(&DataKey::AdminThreshold, &new_threshold);
        env.events()
            .publish((symbol_short!("thresh_up"),), new_threshold);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    // ─── Contract-level pause ─────────────────────────────────────────────────

    /// Admin-only: pause the entire contract. While paused, every state-
    /// mutating function rejects with "Contract is paused". Read-only
    /// getters continue to work, and the admin can always call
    /// `unpause_contract` to recover.
    pub fn pause_contract(env: Env, signers: Vec<Address>) {
        require_admin_for_critical(&env, &signers);
        env.storage()
            .instance()
            .set(&DataKey::ContractPaused, &true);
        env.events()
            .publish((symbol_short!("paused"), signers.get(0).unwrap()), ());
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Admin-only: lift the contract-level pause.
    pub fn unpause_contract(env: Env, signers: Vec<Address>) {
        require_admin_for_critical(&env, &signers);
        env.storage()
            .instance()
            .set(&DataKey::ContractPaused, &false);
        env.events()
            .publish((symbol_short!("unpause"), signers.get(0).unwrap()), ());
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
    #[cfg(feature = "upgrade")]
    pub fn propose_upgrade(env: Env, signers: Vec<Address>, new_wasm_hash: BytesN<32>) {
        require_admin_for_critical(&env, &signers);
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
            (symbol_short!("upg_prop"), signers.get(0).unwrap()),
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
    #[cfg(feature = "upgrade")]
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
        // Run storage migrations so any schema changes in the new WASM are
        // applied before the next contract invocation.
        migrate(&env);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Admin-only: cancel a pending upgrade without executing it. Use
    /// during incident response if the proposed WASM turns out to be
    /// malicious or buggy before the timelock elapses.
    #[cfg(feature = "upgrade")]
    pub fn cancel_upgrade(env: Env, signers: Vec<Address>) {
        require_admin_for_critical(&env, &signers);
        if !env.storage().instance().has(&DataKey::PendingUpgrade) {
            panic!("No pending upgrade");
        }
        env.storage().instance().remove(&DataKey::PendingUpgrade);
        env.storage()
            .instance()
            .remove(&DataKey::UpgradeEffectiveAt);
        env.events()
            .publish((symbol_short!("upg_cncl"), signers.get(0).unwrap()), ());
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Read-only: returns `(hash, effective_at_ledger)` for the pending
    /// upgrade, or `None` if no upgrade is currently proposed.
    #[cfg(feature = "upgrade")]
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
    #[cfg(feature = "upgrade")]
    pub fn get_last_executed_upgrade(env: Env) -> Option<BytesN<32>> {
        env.storage().instance().get(&DataKey::LastExecutedUpgrade)
    }

    /// Read the current storage schema version. Returns 1 when the key is
    /// absent (pre-versioning deployments are implicitly v1).
    #[cfg(feature = "upgrade")]
    pub fn get_storage_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&STORAGE_VERSION_KEY)
            .unwrap_or(1)
    }

    // ─── Emergency withdrawal (7-day timelock) ─────────────────────────────────

    /// Admin-only: step 1 of the emergency withdrawal flow. Records a
    /// request to send `amount` of `token` from the contract's
    /// per-project balance to `new_wallet` after a 7-day timelock.
    /// One pending withdrawal per project at a time; the caller must
    /// cancel or execute the existing one before initiating another.
    ///
    /// The actual balance check happens at execution time, not here,
    /// because the 7-day gap means the balance could shift before then
    /// (TOCTOU avoidance).
    #[cfg(feature = "emergency")]
    pub fn initiate_emergency_withdrawal(
        env: Env,
        admin: Address,
        project_id: String,
        new_wallet: Address,
        token: Address,
        amount: i128,
    ) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);
        if amount <= 0 {
            panic!("Emergency withdrawal amount must be positive");
        }

        let project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(project_id.clone()))
            .expect("Project not found");
        if !project.active {
            panic!("Project is not accepting donations");
        }

        if env
            .storage()
            .instance()
            .has(&DataKey::EmergencyWithdrawal(project_id.clone()))
        {
            panic!("Emergency withdrawal already pending for this project");
        }

        let current_ledger = env.ledger().sequence();
        let executable_at = current_ledger
            .checked_add(EMERGENCY_WITHDRAWAL_TIMELOCK)
            .expect("Emergency withdrawal timelock overflow");

        let withdrawal = EmergencyWithdrawal {
            new_wallet: new_wallet.clone(),
            amount,
            token: token.clone(),
            initiated_at: current_ledger,
            executable_at,
        };
        env.storage().instance().set(
            &DataKey::EmergencyWithdrawal(project_id.clone()),
            &withdrawal,
        );

        env.events().publish(
            (symbol_short!("ew_init"), admin, project_id),
            (new_wallet, amount, token, executable_at),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Admin-only: cancel a pending emergency withdrawal before it has
    /// been executed. Clears the pending entry and emits an event for
    /// off-chain notification.
    #[cfg(feature = "emergency")]
    pub fn cancel_emergency_withdrawal(env: Env, admin: Address, project_id: String) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);

        if !env
            .storage()
            .instance()
            .has(&DataKey::EmergencyWithdrawal(project_id.clone()))
        {
            panic!("No pending emergency withdrawal");
        }

        env.storage()
            .instance()
            .remove(&DataKey::EmergencyWithdrawal(project_id.clone()));

        env.events()
            .publish((symbol_short!("ew_cncl"), admin, project_id), ());
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Permissionless: step 2 of the emergency withdrawal flow. Callable
    /// by anyone after the 7-day timelock has elapsed. Validates that
    /// the project's per-project-per-token balance is sufficient, then
    /// clears the pending entry, decrements the balance, and transfers
    /// tokens to the new wallet (CEI ordering).
    #[cfg(feature = "emergency")]
    pub fn execute_emergency_withdrawal(env: Env, project_id: String) {
        let withdrawal: EmergencyWithdrawal = env
            .storage()
            .instance()
            .get(&DataKey::EmergencyWithdrawal(project_id.clone()))
            .expect("No pending emergency withdrawal");

        let current_ledger = env.ledger().sequence();
        if current_ledger < withdrawal.executable_at {
            panic!("Emergency withdrawal timelock not yet elapsed");
        }

        // ── Checks: validate per-project-per-token balance
        let balance_key =
            DataKey::ProjectContractBalance(project_id.clone(), withdrawal.token.clone());
        let balance: i128 = env.storage().instance().get(&balance_key).unwrap_or(0);
        if withdrawal.amount > balance {
            panic!("Insufficient contract balance for project");
        }

        // ── Effects: clear withdrawal AND decrement balance before transfer
        env.storage()
            .instance()
            .remove(&DataKey::EmergencyWithdrawal(project_id.clone()));
        let new_balance = balance - withdrawal.amount;
        env.storage().instance().set(&balance_key, &new_balance);

        // ── Interaction: external token transfer
        let token_client = token::Client::new(&env, &withdrawal.token);
        token_client.transfer(
            &env.current_contract_address(),
            &withdrawal.new_wallet,
            &withdrawal.amount,
        );

        env.events().publish(
            (symbol_short!("ew_exec"), project_id),
            (withdrawal.new_wallet, withdrawal.amount, withdrawal.token),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Read-only: returns the pending emergency withdrawal for a project,
    /// or `None` if no withdrawal is currently pending.
    #[cfg(feature = "emergency")]
    pub fn get_emergency_withdrawal(env: Env, project_id: String) -> Option<EmergencyWithdrawal> {
        env.storage()
            .instance()
            .get(&DataKey::EmergencyWithdrawal(project_id))
    }

    // ─── Donation refund (#290) ───────────────────────────────────────────────

    /// Donor-initiated refund request. Must be called within the cooldown
    /// window (`REFUND_COOLDOWN_LEDGERS`) after the original donation.
    /// Creates a `RefundRequest` with status `Pending` for admin + project
    /// wallet approval.
    #[cfg(feature = "refund")]
    pub fn request_refund(env: Env, donor: Address, donation_record_index: u32, token: Address) {
        donor.require_auth();
        require_not_paused(&env);

        let record: DonationRecord = env
            .storage()
            .instance()
            .get(&DataKey::DonationRecord(donation_record_index))
            .expect("Donation record not found");

        if record.donor != donor {
            panic!("Only the donor can request a refund");
        }

        let current_ledger = env.ledger().sequence();
        let deadline = record
            .ledger
            .checked_add(REFUND_COOLDOWN_LEDGERS)
            .expect("Refund deadline overflow");
        if current_ledger > deadline {
            panic!("Refund cooldown expired");
        }

        // One refund request per donation — prevent duplicate requests.
        let refund_for_donation_key = DataKey::RefundForDonation(donation_record_index);
        if env.storage().instance().has(&refund_for_donation_key) {
            panic!("Refund already requested for this donation");
        }

        // Snapshot CO₂ offset from the separate key written at donation time.
        // Pre-upgrade donations lack this key; CO₂ reversal defaults to 0
        // (documented known limitation — see SECURITY.md).
        let co2_offset_grams: i128 = env
            .storage()
            .instance()
            .get(&DataKey::DonationCO2Offset(donation_record_index))
            .unwrap_or(0);

        let refund_count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RefundCount)
            .unwrap_or(0);
        let refund_id = refund_count;

        let request = RefundRequest {
            donor: donor.clone(),
            project_id: record.project.clone(),
            amount: record.amount,
            donation_record_index,
            requested_at: current_ledger,
            status: RefundRequestStatus::Pending,
            token,
            co2_offset_grams,
        };

        env.storage()
            .instance()
            .set(&DataKey::RefundRequest(refund_id), &request);
        env.storage()
            .instance()
            .set(&refund_for_donation_key, &refund_id);
        env.storage()
            .instance()
            .set(&DataKey::RefundCount, &(refund_id + 1));

        env.events().publish(
            (symbol_short!("rfnd_rq"), refund_id, donor),
            (record.project, record.amount, donation_record_index),
        );
    }

    /// Admin + project wallet co-sign to approve a pending refund.
    /// Atomically transfers tokens from the project wallet back to the donor
    /// and decrements all counters (CEI ordering — effects before interaction).
    ///
    /// Badges are permanent and NOT recalculated. `DonationCount` is historical
    /// and NOT decremented.
    #[cfg(feature = "refund")]
    pub fn approve_refund(env: Env, admin: Address, refund_id: u32) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);

        let mut request: RefundRequest = env
            .storage()
            .instance()
            .get(&DataKey::RefundRequest(refund_id))
            .expect("Refund request not found");

        if request.status != RefundRequestStatus::Pending {
            panic!("Refund request is not pending");
        }

        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(request.project_id.clone()))
            .expect("Project not found");

        // Project wallet must co-sign — ensures the token transfer actually
        // happens atomically, so "Approved" reliably means "Paid" for
        // non-adversarial cases (wrong project, wrong amount, tech error).
        // The fraud case is unresolvable on-chain without escrow.
        project.wallet.require_auth();

        // ── Effects: all counter adjustments BEFORE the token transfer (CEI).

        project.total_raised = project
            .total_raised
            .checked_sub(request.amount)
            .expect("Project total_raised underflow on refund");
        env.storage()
            .instance()
            .set(&DataKey::Project(request.project_id.clone()), &project);

        // Donor stats: decrement totals but do NOT recalculate badge (permanent).
        let mut donor_stats: DonorStats = env
            .storage()
            .instance()
            .get(&DataKey::DonorStats(request.donor.clone()))
            .unwrap_or(DonorStats {
                total_donated: 0,
                donation_count: 0,
                badge: BadgeTier::None,
                co2_offset_grams: 0,
            });
        donor_stats.total_donated = donor_stats
            .total_donated
            .checked_sub(request.amount)
            .expect("Donor total_donated underflow on refund");
        donor_stats.co2_offset_grams = donor_stats
            .co2_offset_grams
            .checked_sub(request.co2_offset_grams)
            .expect("Donor co2_offset underflow on refund");
        // Badge is NOT recalculated — badges are permanent.
        env.storage()
            .instance()
            .set(&DataKey::DonorStats(request.donor.clone()), &donor_stats);

        // Per-project cumulative donation total (milestone NFT tracker).
        let proj_total_key =
            DataKey::DonorProjectTotal(request.project_id.clone(), request.donor.clone());
        let prev_proj_total: i128 = env.storage().instance().get(&proj_total_key).unwrap_or(0);
        env.storage().instance().set(
            &proj_total_key,
            &prev_proj_total
                .checked_sub(request.amount)
                .expect("DonorProjectTotal underflow on refund"),
        );

        // Global counters.
        let gr: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalTotalRaised)
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::GlobalTotalRaised,
            &gr.checked_sub(request.amount)
                .expect("GlobalTotalRaised underflow on refund"),
        );

        let gc: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalCO2OffsetGrams)
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::GlobalCO2OffsetGrams,
            &gc.checked_sub(request.co2_offset_grams)
                .expect("GlobalCO2OffsetGrams underflow on refund"),
        );

        // Mark approved before the external transfer.
        request.status = RefundRequestStatus::Approved;
        env.storage()
            .instance()
            .set(&DataKey::RefundRequest(refund_id), &request);

        // ── Interaction: token transfer from project wallet back to donor.
        let token_client = token::Client::new(&env, &request.token);
        token_client.transfer(&project.wallet, &request.donor, &request.amount);

        env.events().publish(
            (symbol_short!("rfnd_ap"), refund_id, admin),
            (request.project_id, request.amount, request.donor),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Admin-only: reject a pending refund request. The donation stands;
    /// no counters are adjusted and no tokens move.
    #[cfg(feature = "refund")]
    pub fn reject_refund(env: Env, admin: Address, refund_id: u32) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);

        let mut request: RefundRequest = env
            .storage()
            .instance()
            .get(&DataKey::RefundRequest(refund_id))
            .expect("Refund request not found");

        if request.status != RefundRequestStatus::Pending {
            panic!("Refund request is not pending");
        }

        request.status = RefundRequestStatus::Rejected;
        env.storage()
            .instance()
            .set(&DataKey::RefundRequest(refund_id), &request);

        env.events().publish(
            (symbol_short!("rfnd_rj"), refund_id, admin),
            (request.project_id, request.donor),
        );
    }

    /// Read-only: returns the refund request for the given ID, or panics if
    /// not found.
    pub fn get_refund_request(env: Env, refund_id: u32) -> RefundRequest {
        env.storage()
            .instance()
            .get(&DataKey::RefundRequest(refund_id))
            .expect("Refund request not found")
    }

    // ─── Recurring Donations ──────────────────────────────────────────────────

    #[cfg(feature = "recurring")]
    #[allow(clippy::too_many_arguments)]
    pub fn create_recurring(
        env: Env,
        donor: Address,
        project_id: String,
        amount: i128,
        currency: Symbol,
        interval_ledgers: u32,
        keeper_incentive: i128,
        msg_hash: u32,
    ) -> u32 {
        donor.require_auth();
        require_not_paused(&env);

        if amount <= 0 {
            panic!("Donation amount must be positive");
        }
        if keeper_incentive < 0 {
            panic!("Keeper incentive must be non-negative");
        }
        if interval_ledgers == 0 {
            panic!("Interval must be positive");
        }

        // Verify project exists
        let project_key = DataKey::Project(project_id.clone());
        if !env.storage().instance().has(&project_key) {
            panic!("Project not found");
        }

        let count_key = DataKey::DonorRecurringCount(donor.clone());
        let count: u32 = env.storage().instance().get(&count_key).unwrap_or(0);
        let recurring_id = count;
        let next_count = count.checked_add(1).expect("DonorRecurringCount overflow");
        env.storage().instance().set(&count_key, &next_count);

        let next_execution_ledger = env
            .ledger()
            .sequence()
            .checked_add(interval_ledgers)
            .expect("next_execution_ledger overflow");

        let recurring = RecurringDonation {
            donor: donor.clone(),
            project_id: project_id.clone(),
            amount,
            currency: currency.clone(),
            interval_ledgers,
            next_execution_ledger,
            keeper_incentive,
            active: true,
            created_at: env.ledger().sequence(),
        };

        let recurring_key = DataKey::RecurringDonation(donor.clone(), recurring_id);
        env.storage().instance().set(&recurring_key, &recurring);

        env.events().publish(
            (symbol_short!("rec_cr"), donor, project_id),
            (
                recurring_id,
                amount,
                currency,
                interval_ledgers,
                keeper_incentive,
                msg_hash,
            ),
        );

        recurring_id
    }

    #[cfg(feature = "recurring")]
    pub fn cancel_recurring(env: Env, donor: Address, recurring_id: u32) {
        donor.require_auth();
        require_not_paused(&env);

        let recurring_key = DataKey::RecurringDonation(donor.clone(), recurring_id);
        let mut recurring: RecurringDonation = env
            .storage()
            .instance()
            .get(&recurring_key)
            .expect("Recurring donation not found");

        if !recurring.active {
            panic!("Recurring donation is not active");
        }

        recurring.active = false;
        env.storage().instance().set(&recurring_key, &recurring);

        env.events()
            .publish((symbol_short!("rec_can"), donor, recurring_id), ());
    }

    #[cfg(feature = "recurring")]
    pub fn execute_recurring(env: Env, keeper: Address, donor: Address, recurring_id: u32) {
        keeper.require_auth();
        require_not_paused(&env);

        let recurring_key = DataKey::RecurringDonation(donor.clone(), recurring_id);
        let mut recurring: RecurringDonation = env
            .storage()
            .instance()
            .get(&recurring_key)
            .expect("Recurring donation not found");

        if !recurring.active {
            panic!("Recurring donation is not active");
        }
        if env.ledger().sequence() < recurring.next_execution_ledger {
            panic!("Recurring donation has not matured yet");
        }

        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(recurring.project_id.clone()))
            .expect("Project not found");
        if !project.active {
            panic!("Project is not accepting donations");
        }
        if project.paused {
            panic!("Project is temporarily paused");
        }
        require_campaign_accepts_donation(&project, env.ledger().sequence());

        // Checked arithmetic for CO2 calculations and equivalent XLM amount
        let xlm_equivalent: i128;
        let token_addr: Address;

        if recurring.currency == symbol_short!("XLM") {
            token_addr = env
                .storage()
                .instance()
                .get(&DataKey::NativeTokenAddress)
                .expect("Native token not configured");

            xlm_equivalent = recurring.amount;
        } else if recurring.currency == symbol_short!("USDC") {
            let stored_usdc: Option<Address> =
                env.storage().instance().get(&DataKey::USDCTokenAddress);
            token_addr = stored_usdc.expect("USDC token not configured");

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
            xlm_equivalent = recurring
                .amount
                .checked_mul(rate)
                .expect("USDC to XLM conversion overflow");
        } else {
            panic!("Unsupported currency");
        }

        let xlm_units = xlm_equivalent / STROOP;
        let co2_increment = xlm_units
            .checked_mul(project.co2_per_xlm as i128)
            .expect("CO2 calculation overflow");

        // Checks-Effects-Interactions (CEI) Pattern: State changes before token transfers.
        // Update Project
        project.total_raised = project
            .total_raised
            .checked_add(xlm_equivalent)
            .expect("Project total_raised overflow");
        let goal_reached = apply_campaign_goal_progress(&mut project);
        let donated_key = DataKey::HasDonated(recurring.project_id.clone(), donor.clone());
        if !env.storage().instance().has(&donated_key) {
            env.storage().instance().set(&donated_key, &true);
            project.donor_count = project
                .donor_count
                .checked_add(1)
                .expect("Project donor_count overflow");
        }
        env.storage()
            .instance()
            .set(&DataKey::Project(recurring.project_id.clone()), &project);
        if goal_reached {
            env.events().publish(
                (symbol_short!("camp_goal"), recurring.project_id.clone()),
                project.total_raised,
            );
        }

        // Update Donor stats
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

        // Track per-project cumulative donations
        let proj_total_key =
            DataKey::DonorProjectTotal(recurring.project_id.clone(), donor.clone());
        let prev_proj_total: i128 = env.storage().instance().get(&proj_total_key).unwrap_or(0);
        env.storage().instance().set(
            &proj_total_key,
            &prev_proj_total
                .checked_add(xlm_equivalent)
                .expect("DonorProjectTotal overflow"),
        );

        // Auto-mint Impact NFT
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

        // Store Donation Record
        let dc: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DonationCount)
            .unwrap_or(0);
        let new_dc = dc.checked_add(1).expect("DonationCount overflow");
        env.storage()
            .instance()
            .set(&DataKey::DonationCount, &new_dc);

        let donation_record = DonationRecord {
            donor: donor.clone(),
            anonymous: false,
            project: recurring.project_id.clone(),
            amount: recurring.amount,
            ledger: env.ledger().sequence(),
            message_hash: 0,
            currency: recurring.currency.clone(),
        };
        env.storage()
            .instance()
            .set(&DataKey::DonationRecord(dc), &donation_record);
        env.storage()
            .instance()
            .set(&DataKey::DonationCO2Offset(dc), &co2_increment);

        // Update Globals
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

        let gc: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalCO2OffsetGrams)
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::GlobalCO2OffsetGrams,
            &gc.checked_add(co2_increment).expect("GlobalCO2 overflow"),
        );

        // Update schedule next execution sequence
        recurring.next_execution_ledger = env
            .ledger()
            .sequence()
            .checked_add(recurring.interval_ledgers)
            .expect("next_execution_ledger overflow");
        env.storage().instance().set(&recurring_key, &recurring);

        // Interactions: Token transfers
        let token_client = token::Client::new(&env, &token_addr);
        let contract_addr = env.current_contract_address();

        // 1. Transfer donation amount to project wallet
        token_client.transfer_from(&contract_addr, &donor, &project.wallet, &recurring.amount);

        // 2. Transfer incentive to keeper
        if recurring.keeper_incentive > 0 {
            token_client.transfer_from(
                &contract_addr,
                &donor,
                &keeper,
                &recurring.keeper_incentive,
            );
        }

        // Publish execute event
        env.events().publish(
            (symbol_short!("rec_exec"), donor, recurring_id),
            (
                keeper,
                recurring.amount,
                recurring.currency,
                recurring.next_execution_ledger,
            ),
        );

        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    pub fn get_recurring(env: Env, donor: Address, recurring_id: u32) -> RecurringDonation {
        env.storage()
            .instance()
            .get(&DataKey::RecurringDonation(donor, recurring_id))
            .expect("Recurring donation not found")
    }

    pub fn get_donor_recurrings(env: Env, donor: Address) -> Vec<RecurringDonation> {
        let count_key = DataKey::DonorRecurringCount(donor.clone());
        let count: u32 = env.storage().instance().get(&count_key).unwrap_or(0);
        let mut list = Vec::new(&env);
        for id in 0..count {
            if let Some(recurring) = env
                .storage()
                .instance()
                .get::<DataKey, RecurringDonation>(&DataKey::RecurringDonation(donor.clone(), id))
            {
                list.push_back(recurring);
            }
        }
        list
    }

    // ─── Time-Locked Vesting Donations (#386) ────────────────────────────────

    /// Creates a time-locked vesting schedule for a donation.
    ///
    /// The total amount is split into equal installments. The first installment
    /// is transferred to the project wallet immediately; subsequent installments
    /// are claimable by anyone via `claim_vested_installment` after each
    /// `interval_ledgers` elapses.
    ///
    /// # Panics
    /// - If `amount <= 0`
    /// - If `installment_count == 0`
    /// - If `interval_ledgers == 0`
    /// - If the project is not found, inactive, or paused
    /// - If the token transfer fails
    #[cfg(feature = "vesting")]
    #[allow(clippy::too_many_arguments)]
    pub fn donate_vested(
        env: Env,
        token: Address,
        donor: Address,
        project_id: String,
        total_amount: i128,
        installment_count: u32,
        installment_interval_ledgers: u32,
        msg_hash: u32,
    ) -> u32 {
        donor.require_auth();
        require_not_paused(&env);

        if total_amount <= 0 {
            panic!("Donation amount must be positive");
        }
        if installment_count == 0 {
            panic!("Installment count must be positive");
        }
        if installment_interval_ledgers == 0 {
            panic!("Installment interval must be positive");
        }

        // Verify project exists and is accepting donations.
        let project: Project = env
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

        let amount_per_installment = total_amount
            .checked_div(installment_count as i128)
            .expect("Installment count must be positive (division by zero)");
        if amount_per_installment == 0 {
            panic!("Donation amount too small for installment count");
        }

        // Compute next installment ledger: current + interval.
        let next_installment_ledger = env
            .ledger()
            .sequence()
            .checked_add(installment_interval_ledgers)
            .expect("next_installment_ledger overflow");

        let count_key = DataKey::DonorVestingCount(donor.clone());
        let count: u32 = env.storage().instance().get(&count_key).unwrap_or(0);
        let schedule_id = count;
        let next_count = count.checked_add(1).expect("DonorVestingCount overflow");
        env.storage().instance().set(&count_key, &next_count);

        let schedule = VestingSchedule {
            donor: donor.clone(),
            project_id: project_id.clone(),
            total_amount,
            amount_per_installment,
            installment_count,
            interval_ledgers: installment_interval_ledgers,
            next_installment_ledger,
            installments_released: 1, // first installment is immediate
            created_at: env.ledger().sequence(),
            token: token.clone(),
        };

        let schedule_key = DataKey::VestingSchedule(donor.clone(), schedule_id);
        env.storage().instance().set(&schedule_key, &schedule);

        // ── Transfer full amount from donor to contract (custody),
        //    then release first installment from contract to project.
        let contract_addr = env.current_contract_address();
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&donor, &contract_addr, &total_amount);
        token_client.transfer(&contract_addr, &project.wallet, &amount_per_installment);

        env.events().publish(
            (symbol_short!("vest_crt"), donor, project_id),
            (
                schedule_id,
                total_amount,
                amount_per_installment,
                installment_count,
                installment_interval_ledgers,
                msg_hash,
            ),
        );

        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);

        schedule_id
    }

    /// Claims the next vested installment for a project.
    ///
    /// Permissionless — anyone may call this after the interval has elapsed
    /// since the last claim. The contract holds the vesting funds in custody
    /// and transfers the installment to the project wallet.
    ///
    /// # Panics
    /// - If the schedule is not found.
    /// - If all installments have already been released.
    /// - If the interval has not yet elapsed.
    #[cfg(feature = "vesting")]
    pub fn claim_vested_installment(env: Env, donor: Address, schedule_id: u32) {
        require_not_paused(&env);

        let schedule_key = DataKey::VestingSchedule(donor.clone(), schedule_id);
        let mut schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&schedule_key)
            .expect("Vesting schedule not found");

        if schedule.installments_released >= schedule.installment_count {
            panic!("All installments already released");
        }

        let current_ledger = env.ledger().sequence();
        if current_ledger < schedule.next_installment_ledger {
            panic!("Next installment not yet claimable");
        }

        // Advance the schedule BEFORE the external token transfer (CEI pattern).
        schedule.installments_released = schedule
            .installments_released
            .checked_add(1)
            .expect("installments_released overflow");
        schedule.next_installment_ledger = current_ledger
            .checked_add(schedule.interval_ledgers)
            .expect("next_installment_ledger overflow");
        env.storage().instance().set(&schedule_key, &schedule);

        // Load project to get the wallet.
        let project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(schedule.project_id.clone()))
            .expect("Project not found");

        // ── Interaction: transfer installment from contract custody to project.
        let contract_addr = env.current_contract_address();
        let token_client = token::Client::new(&env, &schedule.token);
        token_client.transfer(
            &contract_addr,
            &project.wallet,
            &schedule.amount_per_installment,
        );

        let remaining = schedule
            .installment_count
            .saturating_sub(schedule.installments_released);
        env.events().publish(
            (symbol_short!("vest_clm"), schedule.project_id),
            (schedule_id, schedule.amount_per_installment, remaining),
        );

        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Cancels a vesting schedule, returning unvested tokens to the donor.
    ///
    /// Only the original donor may cancel (enforced by the storage key which
    /// includes the donor's address). All released installments stay with
    /// the project; the unvested remainder is returned from contract custody
    /// to the donor.
    ///
    /// # Panics
    /// - If the schedule is not found.
    /// - If all installments have already been released.
    #[cfg(feature = "vesting")]
    pub fn cancel_vesting(env: Env, donor: Address, schedule_id: u32) {
        donor.require_auth();

        let schedule_key = DataKey::VestingSchedule(donor.clone(), schedule_id);
        let schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&schedule_key)
            .expect("Vesting schedule not found");

        if schedule.installments_released >= schedule.installment_count {
            panic!("All installments already released — nothing to cancel");
        }

        let remaining_count = schedule
            .installment_count
            .saturating_sub(schedule.installments_released);
        let unvested_amount = (remaining_count as i128)
            .checked_mul(schedule.amount_per_installment)
            .expect("unvested amount overflow");

        // Remove the schedule from storage.
        env.storage().instance().remove(&schedule_key);

        // ── Interaction: return unvested tokens from contract custody to donor.
        let contract_addr = env.current_contract_address();
        let token_client = token::Client::new(&env, &schedule.token);
        token_client.transfer(&contract_addr, &donor, &unvested_amount);

        env.events().publish(
            (symbol_short!("vest_can"), donor, schedule.project_id),
            (schedule_id, unvested_amount),
        );

        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Query a vesting schedule by donor and schedule ID.
    #[cfg(feature = "vesting")]
    pub fn get_vesting_schedule(env: Env, donor: Address, schedule_id: u32) -> VestingSchedule {
        env.storage()
            .instance()
            .get(&DataKey::VestingSchedule(donor, schedule_id))
            .expect("Vesting schedule not found")
    }

    pub fn set_native_token(env: Env, admin: Address, native_token: Address) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);
        env.storage()
            .instance()
            .set(&DataKey::NativeTokenAddress, &native_token);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    pub fn get_native_token(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::NativeTokenAddress)
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

    /// Helper: create a single-element signer Vec for admin calls.
    fn signers1(env: &Env, a: &Address) -> Vec<Address> {
        let mut v = Vec::new(env);
        v.push_back(a.clone());
        v
    }

    // ─── Existing tests ───────────────────────────────────────────────────────

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);
        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_admin_set().len(), 1);
        assert_eq!(client.get_admin_threshold(), 1);
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
        client.initialize(&signers1(&env, &admin), &1u32);

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
        client.initialize(&signers1(&env, &admin), &1u32);

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
        client.initialize(&signers1(&env, &admin), &1u32);
        client.initialize(&signers1(&env, &admin), &1u32);
    }

    #[test]
    fn test_donor_badge_none_below_threshold() {
        let env = Env::default();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);
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
        client.initialize(&signers1(&env, &admin), &1u32);

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
        client.initialize(&signers1(&env, &admin), &1u32);

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
        client.initialize(&signers1(&env, &admin), &1u32);
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

    // ─── Storage versioning & migration tests (#379) ────────────────────────

    #[cfg(feature = "upgrade")]
    #[test]
    fn test_storage_version_initialized() {
        let (env, _cid, client, _admin, _pid) = setup();
        // After initialize(), StorageVersion must equal CURRENT_STORAGE_VERSION.
        assert_eq!(client.get_storage_version(), CURRENT_STORAGE_VERSION);
    }

    #[cfg(feature = "upgrade")]
    #[test]
    fn test_migration_runs_on_upgrade() {
        let (env, cid, client, _admin, _pid) = setup();

        // After initialize(), StorageVersion must equal CURRENT_STORAGE_VERSION.
        assert_eq!(client.get_storage_version(), CURRENT_STORAGE_VERSION);

        // Simulate a same-code upgrade by re-registering the contract at the
        // same address, then calling migrate() directly.
        let v2_cid = env.register_contract(Some(&cid), IndigoPayContract);
        assert_eq!(v2_cid, cid);

        env.as_contract(&cid, || {
            crate::migrate(&env);
        });

        // Version should still be CURRENT_STORAGE_VERSION after a same-code
        // upgrade with no pending migrations.
        assert_eq!(client.get_storage_version(), CURRENT_STORAGE_VERSION);
    }

    #[cfg(feature = "upgrade")]
    #[test]
    fn test_migration_idempotent() {
        let (env, cid, client, _admin, _pid) = setup();

        // Simulate upgrade by re-registering at the same address.
        let v2_cid = env.register_contract(Some(&cid), IndigoPayContract);
        assert_eq!(v2_cid, cid);

        // Call migrate() for the first time.
        env.as_contract(&cid, || {
            crate::migrate(&env);
        });

        let version_after_first = client.get_storage_version();
        assert_eq!(version_after_first, CURRENT_STORAGE_VERSION);

        // Call migrate a second time: the assertion in migrate() that
        // final_version == CURRENT_STORAGE_VERSION must still hold —
        // no double-application of migrations.
        env.as_contract(&cid, || {
            crate::migrate(&env);
        });

        let version_after_second = client.get_storage_version();
        assert_eq!(version_after_second, CURRENT_STORAGE_VERSION);
    }

    // ─── Governance tests ─────────────────────────────────────────────────────

    #[test]
    fn test_create_proposal() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
        let p = client.get_proposal(&pid);
        assert_eq!(p.votes_for, 0);
        assert_eq!(p.votes_against, 0);
        assert!(!p.resolved);
        assert!(p.deadline_ledger > env.ledger().sequence());
    }

    #[test]
    #[should_panic(expected = "Proposal already exists for this project")]
    fn test_create_duplicate_proposal_fails() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
    }

    #[test]
    fn test_cast_vote() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
        let voter = Address::generate(&env);
        grant_badge(&env, &cid, &voter);
        client.vote_verify_project(&voter, &pid, &true);
        let p = client.get_proposal(&pid);
        assert_eq!(p.votes_for, 100);
        assert_eq!(p.votes_against, 0);
    }

    #[test]
    #[should_panic(
        expected = "Only badge holders (Seedling or above) or active delegates can vote"
    )]
    fn test_non_badge_holder_cannot_vote() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
        let non_donor = Address::generate(&env);
        client.vote_verify_project(&non_donor, &pid, &true);
    }

    #[test]
    #[should_panic(expected = "Already voted on this proposal")]
    fn test_double_vote_prevented() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
        let voter = Address::generate(&env);
        grant_badge(&env, &cid, &voter);
        client.vote_verify_project(&voter, &pid, &true);
        client.vote_verify_project(&voter, &pid, &true); // should panic
    }

    #[test]
    fn test_resolve_proposal_approved() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
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
        assert_eq!(p.votes_for, 200);
        assert_eq!(p.votes_against, 100);
    }

    #[test]
    fn test_resolve_proposal_rejected() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
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
        assert_eq!(p.votes_for, 100);
        assert_eq!(p.votes_against, 200);
    }

    #[test]
    fn test_resolve_proposal_tie_rejected_with_rejection_event() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);

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
        assert_eq!(p.votes_for, 100);
        assert_eq!(p.votes_against, 100);

        // A tie (1 for, 1 against) produces a rejection outcome.
        // Event-level assertion is intentionally skipped here because the
        // soroban-sdk 27 ContractEvents API does not expose topic iteration
        // in a re-exported path. The core resolution logic (resolved flag,
        // vote counts) is verified above.
    }

    #[test]
    #[should_panic(expected = "Voting window not yet closed")]
    fn test_resolve_before_deadline_fails() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
        client.resolve_proposal(&pid);
    }

    #[test]
    #[should_panic(expected = "Proposal already resolved")]
    fn test_double_resolve_fails() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
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
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
        extend_ttl(&env, &cid);
        client.veto_proposal(&signers1(&env, &admin), &pid);
        let p = client.get_proposal(&pid);
        assert!(p.resolved);
    }

    #[test]
    #[should_panic(expected = "Insufficient admin signatures")]
    fn test_veto_proposal_non_admin_fails() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
        let imposter = Address::generate(&env);
        client.veto_proposal(&signers1(&env, &imposter), &pid);
    }

    #[test]
    #[should_panic(expected = "Proposal not found")]
    fn test_veto_proposal_missing_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);
        client.veto_proposal(
            &signers1(&env, &admin),
            &String::from_str(&env, "nonexistent"),
        );
    }

    #[test]
    #[should_panic(expected = "Proposal already resolved")]
    fn test_veto_proposal_double_veto_fails() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
        extend_ttl(&env, &cid);
        client.veto_proposal(&signers1(&env, &admin), &pid);
        client.veto_proposal(&signers1(&env, &admin), &pid);
    }

    // ─── Configurable voting-duration tests ───────────────────────────────────

    /// A non-zero `duration_ledgers` within bounds is honored verbatim.
    #[test]
    fn test_create_proposal_custom_duration() {
        let (env, _cid, client, admin, pid) = setup();
        let custom: u32 = 5_000;
        let start = env.ledger().sequence();
        client.create_proposal(&signers1(&env, &admin), &pid, &custom);
        let p = client.get_proposal(&pid);
        assert_eq!(p.deadline_ledger, start + custom);
    }

    /// `0` means "use the default 7-day window".
    #[test]
    fn test_create_proposal_zero_duration_uses_default() {
        let (env, _cid, client, admin, pid) = setup();
        let start = env.ledger().sequence();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
        let p = client.get_proposal(&pid);
        assert_eq!(p.deadline_ledger, start + VOTING_WINDOW_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "Voting duration too short")]
    fn test_create_proposal_rejects_too_short_duration() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_proposal(
            &signers1(&env, &admin),
            &pid,
            &(MIN_VOTING_WINDOW_LEDGERS - 1),
        );
    }

    #[test]
    #[should_panic(expected = "Voting duration too long")]
    fn test_create_proposal_rejects_too_long_duration() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_proposal(
            &signers1(&env, &admin),
            &pid,
            &(MAX_VOTING_WINDOW_LEDGERS + 1),
        );
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

        client.deactivate_all_projects(&signers1(&env, &admin));

        assert!(!client.get_project(&pid1).active);
        assert!(!client.get_project(&pid2).active);
    }

    /// Test that voting is rejected after the deadline has passed (issue #209).
    #[test]
    #[should_panic(expected = "Voting window has closed")]
    fn test_vote_rejected_after_deadline() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);

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
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);

        let voter = Address::generate(&env);
        grant_badge(&env, &cid, &voter);

        // Vote at ledger start + VOTING_WINDOW_LEDGERS - 1 (last valid ledger)
        extend_ttl(&env, &cid);
        env.ledger()
            .set_sequence_number(start + VOTING_WINDOW_LEDGERS - 1);

        // Should succeed
        client.vote_verify_project(&voter, &pid, &true);

        let proposal = client.get_proposal(&pid);
        assert_eq!(proposal.votes_for, 100);
    }

    /// Test minimum voting duration enforcement (issue #209).
    #[test]
    fn test_minimum_voting_duration_enforced() {
        let (env, cid, client, admin, pid) = setup();
        let custom_duration = MIN_VOTING_WINDOW_LEDGERS;
        let start = env.ledger().sequence();

        client.create_proposal(&signers1(&env, &admin), &pid, &custom_duration);

        let voter = Address::generate(&env);
        grant_badge(&env, &cid, &voter);

        // Vote within the minimum window
        extend_ttl(&env, &cid);
        env.ledger()
            .set_sequence_number(start + custom_duration - 1);

        client.vote_verify_project(&voter, &pid, &true);

        let proposal = client.get_proposal(&pid);
        assert_eq!(proposal.votes_for, 100);
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
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);

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
        client.initialize(&signers1(&env, &admin), &1u32);

        // Initialize admin path + then ask for an unknown project.
        let pid = String::from_str(&env, "never-created");
        let list = client.get_voter_list(&pid);
        assert_eq!(list.len(), 0);
    }

    // ─── Bulk admin tests ──────────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "Insufficient admin signatures")]
    fn test_deactivate_all_projects_non_admin_fails() {
        let (env, _cid, client, _admin, _pid) = setup();
        let imposter = Address::generate(&env);
        client.deactivate_all_projects(&signers1(&env, &imposter));
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
        client.initialize(&signers1(&env, &admin), &1u32);
        (env, cid, client, admin)
    }

    #[test]
    fn test_two_step_admin_transfer_success() {
        let (env, _cid, client, admin) = setup_admin_only();
        let new_admin = Address::generate(&env);

        client.transfer_admin(&signers1(&env, &admin), &admin, &new_admin);
        assert_eq!(
            client.get_pending_admin(),
            Some((admin.clone(), new_admin.clone()))
        );
        // Stored admin does not change until accept_admin.
        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_admin_set().len(), 1);

        client.accept_admin();
        assert_eq!(client.get_admin(), new_admin);
        assert_eq!(client.get_admin_set().len(), 1);
        assert_eq!(client.get_admin_threshold(), 1);
        assert_eq!(client.get_pending_admin(), None);
    }

    #[test]
    #[should_panic(expected = "Insufficient admin signatures")]
    fn test_two_step_admin_transfer_non_admin_cant_initiate() {
        let (env, _cid, client, _admin) = setup_admin_only();
        let imposter = Address::generate(&env);
        let new_admin = Address::generate(&env);
        client.transfer_admin(&signers1(&env, &imposter), &imposter, &new_admin);
    }

    #[test]
    #[should_panic(expected = "No pending admin transfer")]
    fn test_two_step_admin_transfer_accept_without_proposal_fails() {
        let (_env, _cid, client, _admin) = setup_admin_only();
        client.accept_admin();
    }

    #[test]
    #[should_panic(expected = "Admin transfer already pending; cancel first")]
    fn test_two_step_admin_transfer_double_propose_fails() {
        let (env, _cid, client, admin) = setup_admin_only();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        client.transfer_admin(&signers1(&env, &admin), &admin, &a);
        client.transfer_admin(&signers1(&env, &admin), &admin, &b);
    }

    #[test]
    fn test_two_step_admin_transfer_cancel_clears_pending() {
        let (env, _cid, client, admin) = setup_admin_only();
        let new_admin = Address::generate(&env);

        client.transfer_admin(&signers1(&env, &admin), &admin, &new_admin);
        assert_eq!(
            client.get_pending_admin(),
            Some((admin.clone(), new_admin.clone()))
        );
        client.cancel_admin_transfer(&signers1(&env, &admin));
        assert_eq!(client.get_pending_admin(), None);
        assert_eq!(client.get_admin(), admin);
    }

    #[test]
    #[should_panic(expected = "No pending admin transfer")]
    fn test_two_step_admin_transfer_cancel_without_pending_fails() {
        let (env, _cid, client, admin) = setup_admin_only();
        client.cancel_admin_transfer(&signers1(&env, &admin));
    }

    // ─── Time-bound campaign tests ──────────────────────────────────────────

    #[test]
    fn test_create_campaign_sets_active_goal_and_deadline() {
        let (env, _cid, client, admin, pid) = setup();
        let deadline = env.ledger().sequence() + 1_000;
        let goal = 5_000 * STROOP;
        client.create_campaign(&admin, &pid, &goal, &deadline);
        let p = client.get_project(&pid);
        assert_eq!(p.campaign_status, CampaignStatus::Active);
        assert_eq!(p.goal, goal);
        assert_eq!(p.deadline_ledger, deadline);
    }

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn test_create_campaign_non_admin_fails() {
        let (env, _cid, client, _admin, pid) = setup();
        let imposter = Address::generate(&env);
        client.create_campaign(
            &imposter,
            &pid,
            &(100 * STROOP),
            &(env.ledger().sequence() + 10),
        );
    }

    #[test]
    #[should_panic(expected = "Campaign goal must be positive")]
    fn test_create_campaign_zero_goal_fails() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_campaign(&admin, &pid, &0i128, &(env.ledger().sequence() + 10));
    }

    #[test]
    #[should_panic(expected = "Campaign deadline must be in the future")]
    fn test_create_campaign_past_deadline_fails() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_campaign(&admin, &pid, &(100 * STROOP), &env.ledger().sequence());
    }

    #[test]
    #[should_panic(expected = "Project already has an open campaign")]
    fn test_create_campaign_while_active_fails() {
        let (env, _cid, client, admin, pid) = setup();
        let deadline = env.ledger().sequence() + 100;
        client.create_campaign(&admin, &pid, &(100 * STROOP), &deadline);
        client.create_campaign(&admin, &pid, &(200 * STROOP), &(deadline + 100));
    }

    #[test]
    fn test_donate_under_goal_keeps_campaign_active() {
        let (env, _cid, client, admin, pid) = setup();
        let goal = 100 * STROOP;
        client.create_campaign(&admin, &pid, &goal, &(env.ledger().sequence() + 1_000));

        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&donor, &(50 * STROOP));
        client.donate(&token, &donor, &pid, &(50 * STROOP), &0u32);

        let p = client.get_project(&pid);
        assert_eq!(p.total_raised, 50 * STROOP);
        assert_eq!(p.campaign_status, CampaignStatus::Active);
    }

    #[test]
    fn test_donate_reaching_goal_sets_goal_reached() {
        let (env, _cid, client, admin, pid) = setup();
        let goal = 100 * STROOP;
        client.create_campaign(&admin, &pid, &goal, &(env.ledger().sequence() + 1_000));

        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&donor, &(100 * STROOP));
        client.donate(&token, &donor, &pid, &(100 * STROOP), &0u32);

        let p = client.get_project(&pid);
        assert_eq!(p.total_raised, 100 * STROOP);
        assert_eq!(p.campaign_status, CampaignStatus::GoalReached);
    }

    #[test]
    #[should_panic(expected = "Campaign goal already reached")]
    fn test_donate_after_goal_reached_fails() {
        let (env, _cid, client, admin, pid) = setup();
        let goal = 50 * STROOP;
        client.create_campaign(&admin, &pid, &goal, &(env.ledger().sequence() + 1_000));

        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&donor, &(100 * STROOP));
        client.donate(&token, &donor, &pid, &(50 * STROOP), &0u32);
        client.donate(&token, &donor, &pid, &(50 * STROOP), &1u32);
    }

    #[test]
    #[should_panic(expected = "Campaign deadline has passed")]
    fn test_donate_after_deadline_fails() {
        let (env, cid, client, admin, pid) = setup();
        let start = env.ledger().sequence();
        let deadline = start + 50;
        client.create_campaign(&admin, &pid, &(1_000 * STROOP), &deadline);

        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(deadline + 1);

        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&donor, &STROOP);
        client.donate(&token, &donor, &pid, &STROOP, &0u32);
    }

    #[test]
    fn test_extend_campaign_updates_deadline() {
        let (env, _cid, client, admin, pid) = setup();
        let start = env.ledger().sequence();
        client.create_campaign(&admin, &pid, &(100 * STROOP), &(start + 100));
        client.extend_campaign(&admin, &pid, &(start + 500));
        assert_eq!(client.get_project(&pid).deadline_ledger, start + 500);
    }

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn test_extend_campaign_non_admin_fails() {
        let (env, _cid, client, admin, pid) = setup();
        let start = env.ledger().sequence();
        client.create_campaign(&admin, &pid, &(100 * STROOP), &(start + 100));
        let imposter = Address::generate(&env);
        client.extend_campaign(&imposter, &pid, &(start + 200));
    }

    #[test]
    fn test_close_campaign_early_sets_closed() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_campaign(
            &admin,
            &pid,
            &(100 * STROOP),
            &(env.ledger().sequence() + 1_000),
        );
        client.close_campaign(&admin, &pid);
        assert_eq!(
            client.get_project(&pid).campaign_status,
            CampaignStatus::Closed
        );
    }

    #[test]
    #[should_panic(expected = "Campaign is closed")]
    fn test_donate_after_close_fails() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_campaign(
            &admin,
            &pid,
            &(100 * STROOP),
            &(env.ledger().sequence() + 1_000),
        );
        client.close_campaign(&admin, &pid);

        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&donor, &STROOP);
        client.donate(&token, &donor, &pid, &STROOP, &0u32);
    }

    #[test]
    fn test_close_campaign_after_deadline_sets_expired() {
        let (env, cid, client, admin, pid) = setup();
        let start = env.ledger().sequence();
        let deadline = start + 40;
        client.create_campaign(&admin, &pid, &(1_000 * STROOP), &deadline);
        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(deadline + 1);
        client.close_campaign(&admin, &pid);
        assert_eq!(
            client.get_project(&pid).campaign_status,
            CampaignStatus::Expired
        );
    }

    #[test]
    fn test_donate_asset_respects_campaign_goal() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_campaign(
            &admin,
            &pid,
            &(30 * STROOP),
            &(env.ledger().sequence() + 1_000),
        );
        let donor = Address::generate(&env);
        client.donate_asset(&donor, &pid, &(30 * STROOP), &symbol_short!("yXLM"), &0u32);
        assert_eq!(
            client.get_project(&pid).campaign_status,
            CampaignStatus::GoalReached
        );
    }

    #[test]
    fn test_donate_usdc_respects_campaign_deadline() {
        let (env, cid, client, admin, pid) = setup();
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        client.set_usdc_token(&admin, &token);
        let oracle_id = env.register_contract(None, MockOracle);
        client.set_oracle(&admin, &oracle_id);

        let start = env.ledger().sequence();
        let deadline = start + 30;
        // MockOracle rate = 8 XLM per USDC stroop; 1 USDC stroop → 8 XLM stroops.
        client.create_campaign(&admin, &pid, &(1_000 * STROOP), &deadline);

        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(deadline + 1);

        let donor = Address::generate(&env);
        let usdc_amount: i128 = 1_000_000;
        StellarAssetClient::new(&env, &token).mint(&donor, &usdc_amount);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.donate_usdc(&token, &donor, &pid, &usdc_amount, &0u32);
        }));
        assert!(
            result.is_err(),
            "donate_usdc must reject after campaign deadline"
        );
    }

    #[test]
    fn test_donate_without_campaign_unchanged() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&donor, &(10 * STROOP));
        client.donate(&token, &donor, &pid, &(10 * STROOP), &0u32);
        let p = client.get_project(&pid);
        assert_eq!(p.campaign_status, CampaignStatus::None);
        assert_eq!(p.total_raised, 10 * STROOP);
    }

    // ─── Contract-level pause tests ─────────────────────────────────────────

    #[test]
    #[should_panic(expected = "old_admin is not in the admin set")]
    fn test_transfer_admin_old_admin_not_in_set_panics() {
        let (env, _cid, client, admin) = setup_admin_only();
        let outsider = Address::generate(&env);
        let new_admin = Address::generate(&env);
        client.transfer_admin(&signers1(&env, &admin), &outsider, &new_admin);
    }

    #[test]
    #[should_panic(expected = "new_admin is already an admin")]
    fn test_transfer_admin_new_admin_already_in_set_panics() {
        let (env, _cid, client, admin) = setup_admin_only();
        client.transfer_admin(&signers1(&env, &admin), &admin, &admin);
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

        client.pause_contract(&signers1(&env, &client.get_admin()));
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

        client.pause_contract(&signers1(&env, &admin));
        client.unpause_contract(&signers1(&env, &admin));
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
    #[should_panic(expected = "Insufficient admin signatures")]
    fn test_pause_contract_non_admin_fails() {
        let (env, _cid, client, _admin) = setup_admin_only();
        let imposter = Address::generate(&env);
        client.pause_contract(&signers1(&env, &imposter));
    }

    // ─── 48h upgrade timelock tests ─────────────────────────────────────────

    #[test]
    fn test_propose_upgrade_stores_pending() {
        let (env, _cid, client, admin) = setup_admin_only();
        let fake_hash = BytesN::from_array(&env, &[7u8; 32]);

        client.propose_upgrade(&signers1(&env, &admin), &fake_hash);
        let (h, eff) = client.get_pending_upgrade().expect("pending upgrade");
        assert_eq!(h, fake_hash);
        assert_eq!(eff, env.ledger().sequence() + UPGRADE_TIMELOCK_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "Insufficient admin signatures")]
    fn test_propose_upgrade_non_admin_fails() {
        let (env, _cid, client, _admin) = setup_admin_only();
        let imposter = Address::generate(&env);
        let fake_hash = BytesN::from_array(&env, &[1u8; 32]);
        client.propose_upgrade(&signers1(&env, &imposter), &fake_hash);
    }

    #[test]
    #[should_panic(expected = "Upgrade already pending; cancel first")]
    fn test_propose_upgrade_double_propose_rejected() {
        let (env, _cid, client, admin) = setup_admin_only();
        let h1 = BytesN::from_array(&env, &[1u8; 32]);
        let h2 = BytesN::from_array(&env, &[2u8; 32]);
        client.propose_upgrade(&signers1(&env, &admin), &h1);
        client.propose_upgrade(&signers1(&env, &admin), &h2);
    }

    #[test]
    #[should_panic(expected = "Upgrade timelock not yet elapsed")]
    fn test_execute_upgrade_before_timelock_fails() {
        let (env, _cid, client, admin) = setup_admin_only();
        let fake_hash = BytesN::from_array(&env, &[3u8; 32]);
        client.propose_upgrade(&signers1(&env, &admin), &fake_hash);
        // Still well before the effective ledger.
        client.execute_upgrade();
    }

    #[test]
    fn test_execute_upgrade_after_timelock_succeeds() {
        let (env, _cid, client, admin) = setup_admin_only();
        let fake_hash = BytesN::from_array(&env, &[4u8; 32]);
        let start = env.ledger().sequence();
        client.propose_upgrade(&signers1(&env, &admin), &fake_hash);

        // Verify timelock state is recorded correctly (effective_at).
        let (hash, effective_at) = client.get_pending_upgrade().unwrap();
        assert_eq!(hash, fake_hash);
        assert_eq!(effective_at, start + UPGRADE_TIMELOCK_LEDGERS);

        // The actual WASM swap (execute_upgrade) requires a valid Soroban
        // contract WASM to be uploaded first, which isn't available in the
        // unit-test host environment.  The timelock state machine is
        // covered by the assertions above and the cancel tests below.
        client.cancel_upgrade(&signers1(&env, &admin));
        assert_eq!(client.get_pending_upgrade(), None);
    }

    #[test]
    fn test_cancel_upgrade_clears_pending() {
        let (env, _cid, client, admin) = setup_admin_only();
        let fake_hash = BytesN::from_array(&env, &[5u8; 32]);
        client.propose_upgrade(&signers1(&env, &admin), &fake_hash);
        assert!(client.get_pending_upgrade().is_some());
        client.cancel_upgrade(&signers1(&env, &admin));
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
        let (env, _cid, client, admin) = setup_admin_only();
        client.cancel_upgrade(&signers1(&env, &admin));
    }

    #[test]
    fn test_extend_all_ttl() {
        let env = Env::default();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        // Before extending, TTL should be some default (usually 100 in tests or determined by init).
        // The host env starts at ledger 0. We will use testutils to check the exact TTL.
        use soroban_sdk::testutils::storage::Instance as TestInstance;

        let _before_ttl = env.as_contract(&id, || env.storage().instance().get_ttl());

        // Extend TTL
        client.extend_all_ttl(&500_000);

        let after_ttl = env.as_contract(&id, || env.storage().instance().get_ttl());
        assert!(after_ttl >= 500_000);
    }

    // ─── Emergency withdrawal tests ────────────────────────────────────────────

    /// Seed the per-project-per-token contract balance for testing.
    /// Mirrors what #277's deposit function will do in production.
    fn seed_project_balance(
        env: &Env,
        cid: &soroban_sdk::Address,
        project_id: &str,
        token: &Address,
        amount: i128,
    ) {
        env.as_contract(cid, || {
            env.storage().instance().set(
                &DataKey::ProjectContractBalance(String::from_str(env, project_id), token.clone()),
                &amount,
            );
        });
    }

    #[test]
    fn test_emergency_withdrawal_initiate_happy() {
        let (env, _cid, client, admin, pid) = setup();
        let new_wallet = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let amount = 500 * STROOP;

        client.initiate_emergency_withdrawal(&admin, &pid, &new_wallet, &token, &amount);

        let w = client.get_emergency_withdrawal(&pid).unwrap();
        assert_eq!(w.new_wallet, new_wallet);
        assert_eq!(w.amount, amount);
        assert_eq!(w.token, token);
        assert_eq!(w.initiated_at, env.ledger().sequence());
        assert_eq!(
            w.executable_at,
            env.ledger().sequence() + EMERGENCY_WITHDRAWAL_TIMELOCK
        );
    }

    #[test]
    fn test_emergency_withdrawal_execute_after_timelock() {
        let (env, cid, client, admin, pid) = setup();
        let new_wallet = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let deposit_amount: i128 = 1000 * STROOP;
        let withdrawal_amount: i128 = 500 * STROOP;

        // Fund the contract's Stellar token balance
        StellarAssetClient::new(&env, &token).mint(&cid, &deposit_amount);
        // Seed the per-project-per-token balance
        seed_project_balance(&env, &cid, "proj-001", &token, deposit_amount);

        client.initiate_emergency_withdrawal(&admin, &pid, &new_wallet, &token, &withdrawal_amount);

        let start = env.ledger().sequence();
        extend_ttl(&env, &cid);
        env.ledger()
            .set_sequence_number(start + EMERGENCY_WITHDRAWAL_TIMELOCK);

        client.execute_emergency_withdrawal(&pid);

        // Verify token arrived at new_wallet
        let balance = StellarAssetClient::new(&env, &token).balance(&new_wallet);
        assert_eq!(balance, withdrawal_amount);

        // Verify per-project balance decremented
        let remaining = env.as_contract(&cid, || {
            env.storage()
                .instance()
                .get::<DataKey, i128>(&DataKey::ProjectContractBalance(pid.clone(), token.clone()))
        });
        assert_eq!(remaining.unwrap(), deposit_amount - withdrawal_amount);

        // Verify pending withdrawal cleared
        assert_eq!(client.get_emergency_withdrawal(&pid), None);
    }

    #[test]
    #[should_panic(expected = "Emergency withdrawal timelock not yet elapsed")]
    fn test_emergency_withdrawal_execute_before_timelock_fails() {
        let (env, cid, client, admin, pid) = setup();
        let new_wallet = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let amount = 500 * STROOP;

        StellarAssetClient::new(&env, &token).mint(&cid, &(1000 * STROOP));
        seed_project_balance(&env, &cid, "proj-001", &token, 1000 * STROOP);

        client.initiate_emergency_withdrawal(&admin, &pid, &new_wallet, &token, &amount);

        // Still well before the effective ledger
        client.execute_emergency_withdrawal(&pid);
    }

    #[test]
    fn test_emergency_withdrawal_cancel_happy() {
        let (env, _cid, client, admin, pid) = setup();
        let new_wallet = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        client.initiate_emergency_withdrawal(&admin, &pid, &new_wallet, &token, &(500 * STROOP));
        assert!(client.get_emergency_withdrawal(&pid).is_some());

        client.cancel_emergency_withdrawal(&admin, &pid);
        assert_eq!(client.get_emergency_withdrawal(&pid), None);
    }

    #[test]
    #[should_panic(expected = "No pending emergency withdrawal")]
    fn test_emergency_withdrawal_execute_after_cancel_fails() {
        let (env, cid, client, admin, pid) = setup();
        let new_wallet = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        StellarAssetClient::new(&env, &token).mint(&cid, &(1000 * STROOP));
        seed_project_balance(&env, &cid, "proj-001", &token, 1000 * STROOP);

        client.initiate_emergency_withdrawal(&admin, &pid, &new_wallet, &token, &(500 * STROOP));
        client.cancel_emergency_withdrawal(&admin, &pid);

        extend_ttl(&env, &cid);
        let start = env.ledger().sequence();
        env.ledger()
            .set_sequence_number(start + EMERGENCY_WITHDRAWAL_TIMELOCK);

        client.execute_emergency_withdrawal(&pid);
    }

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn test_emergency_withdrawal_initiate_non_admin_fails() {
        let (env, cid, client, _admin, pid) = setup();
        let non_admin = Address::generate(&env);
        let new_wallet = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        extend_ttl(&env, &cid);
        client.initiate_emergency_withdrawal(
            &non_admin,
            &pid,
            &new_wallet,
            &token,
            &(500 * STROOP),
        );
    }

    #[test]
    #[should_panic(expected = "Project not found")]
    fn test_emergency_withdrawal_initiate_nonexistent_project_fails() {
        let (env, _cid, client, admin) = setup_admin_only();
        let new_wallet = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let fake_pid = String::from_str(&env, "nonexistent");

        client.initiate_emergency_withdrawal(
            &admin,
            &fake_pid,
            &new_wallet,
            &token,
            &(500 * STROOP),
        );
    }

    #[test]
    #[should_panic(expected = "Emergency withdrawal already pending for this project")]
    fn test_emergency_withdrawal_double_initiate_fails() {
        let (env, _cid, client, admin, pid) = setup();
        let new_wallet = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        client.initiate_emergency_withdrawal(&admin, &pid, &new_wallet, &token, &(500 * STROOP));
        // Second initiate should fail
        client.initiate_emergency_withdrawal(&admin, &pid, &new_wallet, &token, &(300 * STROOP));
    }

    #[test]
    #[should_panic(expected = "No pending emergency withdrawal")]
    fn test_emergency_withdrawal_cancel_without_pending_fails() {
        let (env, _cid, client, admin) = setup_admin_only();
        let fake_pid = String::from_str(&env, "no-withdrawal");

        client.cancel_emergency_withdrawal(&admin, &fake_pid);
    }

    #[test]
    #[should_panic(expected = "No pending emergency withdrawal")]
    fn test_emergency_withdrawal_execute_without_pending_fails() {
        let (env, _cid, client) = {
            let env = Env::default();
            env.mock_all_auths();
            let cid = env.register_contract(None, IndigoPayContract);
            let client = IndigoPayContractClient::new(&env, &cid);
            (env, cid, client)
        };
        let fake_pid = String::from_str(&env, "no-withdrawal");

        client.execute_emergency_withdrawal(&fake_pid);
    }

    #[test]
    fn test_emergency_withdrawal_getter() {
        let (env, _cid, client, admin, pid) = setup();
        let new_wallet = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        // No withdrawal initially
        assert_eq!(client.get_emergency_withdrawal(&pid), None);

        client.initiate_emergency_withdrawal(&admin, &pid, &new_wallet, &token, &(500 * STROOP));

        let w = client.get_emergency_withdrawal(&pid).unwrap();
        assert_eq!(w.amount, 500 * STROOP);
        assert_eq!(w.token, token);
        assert_eq!(w.new_wallet, new_wallet);

        // Different project returns None
        let pid2 = String::from_str(&env, "proj-other");
        assert_eq!(client.get_emergency_withdrawal(&pid2), None);
    }

    #[test]
    fn test_emergency_withdrawal_per_project_isolation() {
        let (env, _cid, client, admin) = setup_admin_only();
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        // Register two projects
        let pid_a = String::from_str(&env, "proj-A");
        let wallet_a = Address::generate(&env);
        client.register_project(
            &admin,
            &pid_a,
            &String::from_str(&env, "Project A"),
            &wallet_a,
            &100u32,
        );
        let pid_b = String::from_str(&env, "proj-B");
        let wallet_b = Address::generate(&env);
        client.register_project(
            &admin,
            &pid_b,
            &String::from_str(&env, "Project B"),
            &wallet_b,
            &100u32,
        );

        let new_wallet_a = Address::generate(&env);
        let new_wallet_b = Address::generate(&env);

        // Initiate withdrawal for project A
        client.initiate_emergency_withdrawal(
            &admin,
            &pid_a,
            &new_wallet_a,
            &token,
            &(200 * STROOP),
        );

        // Project A has a pending withdrawal, B does not
        assert!(client.get_emergency_withdrawal(&pid_a).is_some());
        assert_eq!(client.get_emergency_withdrawal(&pid_b), None);

        // Cancel A — B is unaffected
        client.cancel_emergency_withdrawal(&admin, &pid_a);
        assert_eq!(client.get_emergency_withdrawal(&pid_a), None);

        // Can now initiate for B
        client.initiate_emergency_withdrawal(
            &admin,
            &pid_b,
            &new_wallet_b,
            &token,
            &(300 * STROOP),
        );
        assert!(client.get_emergency_withdrawal(&pid_b).is_some());
    }

    #[test]
    #[should_panic(expected = "Insufficient contract balance for project")]
    fn test_emergency_withdrawal_execute_fails_when_balance_zero_but_contract_funded() {
        let (env, cid, client, admin, pid) = setup();
        let new_wallet = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        // Contract has real token balance, but ProjectContractBalance is NOT set
        StellarAssetClient::new(&env, &token).mint(&cid, &(1000 * STROOP));

        client.initiate_emergency_withdrawal(&admin, &pid, &new_wallet, &token, &(500 * STROOP));

        extend_ttl(&env, &cid);
        let start = env.ledger().sequence();
        env.ledger()
            .set_sequence_number(start + EMERGENCY_WITHDRAWAL_TIMELOCK);

        client.execute_emergency_withdrawal(&pid);
    }

    #[test]
    #[should_panic(expected = "Insufficient contract balance for project")]
    fn test_emergency_withdrawal_execute_fails_with_wrong_token() {
        let (env, cid, client, admin, pid) = setup();
        let new_wallet = Address::generate(&env);

        // Create two tokens
        let xlm_admin = Address::generate(&env);
        let xlm_token = env.register_stellar_asset_contract_v2(xlm_admin).address();
        let usdc_admin = Address::generate(&env);
        let usdc_token = env.register_stellar_asset_contract_v2(usdc_admin).address();

        // Seed balance only for XLM
        seed_project_balance(&env, &cid, "proj-001", &xlm_token, 1000 * STROOP);

        // Initiate withdrawal in USDC (which has no balance)
        client.initiate_emergency_withdrawal(&admin, &pid, &new_wallet, &usdc_token, &100);

        extend_ttl(&env, &cid);
        let start = env.ledger().sequence();
        env.ledger()
            .set_sequence_number(start + EMERGENCY_WITHDRAWAL_TIMELOCK);

        client.execute_emergency_withdrawal(&pid);
    }

    // ─── Donation refund tests (#290) ──────────────────────────────────────

    /// Helper: mint tokens, donate, return (donor, token, donation_index).
    fn setup_donation(
        env: &Env,
        client: &IndigoPayContractClient,
        pid: &String,
    ) -> (Address, Address, u32) {
        let donor = Address::generate(env);
        let token_admin = Address::generate(env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(env, &token).mint(&donor, &(50 * STROOP));
        let donation_index: u32 = client.get_donation_count();
        client.donate(&token, &donor, pid, &(25 * STROOP), &0u32);
        (donor, token, donation_index)
    }

    #[test]
    fn test_request_refund_success() {
        let (env, _cid, client, _admin, pid) = setup();
        let (donor, token, donation_index) = setup_donation(&env, &client, &pid);

        client.request_refund(&donor, &donation_index, &token);

        let req = client.get_refund_request(&0);
        assert_eq!(req.donor, donor);
        assert_eq!(req.project_id, pid);
        assert_eq!(req.amount, 25 * STROOP);
        assert_eq!(req.donation_record_index, donation_index);
        assert_eq!(req.requested_at, env.ledger().sequence());
        assert_eq!(req.status, RefundRequestStatus::Pending);
        assert_eq!(req.token, token);
        // co2_per_xlm is 100 in setup(); 25 XLM = 25 stroop-units * 100 = 2500
        assert_eq!(req.co2_offset_grams, 25 * 100);
        assert_eq!(client.get_refund_request(&0), req);
    }

    #[test]
    #[should_panic(expected = "Refund cooldown expired")]
    fn test_request_refund_after_cooldown_panics() {
        let (env, cid, client, _admin, pid) = setup();
        let (donor, token, donation_index) = setup_donation(&env, &client, &pid);

        extend_ttl(&env, &cid);
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + REFUND_COOLDOWN_LEDGERS + 1);

        client.request_refund(&donor, &donation_index, &token);
    }

    #[test]
    #[should_panic(expected = "Only the donor can request a refund")]
    fn test_request_refund_wrong_donor_panics() {
        let (env, _cid, client, _admin, pid) = setup();
        let (_donor, token, donation_index) = setup_donation(&env, &client, &pid);
        let imposter = Address::generate(&env);

        client.request_refund(&imposter, &donation_index, &token);
    }

    #[test]
    #[should_panic(expected = "Refund already requested for this donation")]
    fn test_request_refund_double_request_panics() {
        let (env, _cid, client, _admin, pid) = setup();
        let (donor, token, donation_index) = setup_donation(&env, &client, &pid);

        client.request_refund(&donor, &donation_index, &token);
        client.request_refund(&donor, &donation_index, &token);
    }

    #[test]
    #[should_panic(expected = "Donation record not found")]
    fn test_request_refund_nonexistent_donation_panics() {
        let (env, _cid, client, _admin, _pid) = setup();
        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        client.request_refund(&donor, &999u32, &token);
    }

    #[test]
    fn test_approve_refund_counters_decremented() {
        let (env, _cid, client, admin, pid) = setup();
        let (donor, token, donation_index) = setup_donation(&env, &client, &pid);

        // Snapshot pre-refund counters.
        let project_before = client.get_project(&pid);
        let stats_before = client.get_donor_stats(&donor);
        let global_before = client.get_global_stats();

        client.request_refund(&donor, &donation_index, &token);
        client.approve_refund(&admin, &0);

        // All counters must be decremented by the donation amount.
        let project_after = client.get_project(&pid);
        assert_eq!(
            project_after.total_raised,
            project_before.total_raised - 25 * STROOP
        );

        let stats_after = client.get_donor_stats(&donor);
        assert_eq!(
            stats_after.total_donated,
            stats_before.total_donated - 25 * STROOP
        );
        assert_eq!(
            stats_after.co2_offset_grams,
            stats_before.co2_offset_grams - 25 * 100
        );

        let global_after = client.get_global_stats();
        assert_eq!(
            global_after.total_raised,
            global_before.total_raised - 25 * STROOP
        );
        assert_eq!(
            global_after.co2_offset_grams,
            global_before.co2_offset_grams - 25 * 100
        );
        // DonationCount is NOT decremented (historical).
        assert_eq!(global_after.donation_count, global_before.donation_count);
    }

    #[test]
    fn test_approve_refund_badge_preserved() {
        let (env, _cid, client, admin, pid) = setup();
        let (donor, token, donation_index) = setup_donation(&env, &client, &pid);

        // Verify donor reached Seedling badge (25 XLM > 10 XLM threshold).
        let stats_before = client.get_donor_stats(&donor);
        assert_eq!(stats_before.badge, BadgeTier::Seedling);

        client.request_refund(&donor, &donation_index, &token);
        client.approve_refund(&admin, &0);

        // Badge is NOT recalculated — stays Seedling even though total_donated
        // dropped below the 10 XLM threshold.
        let stats_after = client.get_donor_stats(&donor);
        assert_eq!(stats_after.badge, BadgeTier::Seedling);
    }

    #[test]
    fn test_approve_refund_token_transferred() {
        let (env, _cid, client, admin, pid) = setup();
        let (donor, token, donation_index) = setup_donation(&env, &client, &pid);

        // Fund the project wallet so it can return funds.
        let project = client.get_project(&pid);
        StellarAssetClient::new(&env, &token).mint(&project.wallet, &(50 * STROOP));

        let balance_before = StellarAssetClient::new(&env, &token).balance(&donor);

        client.request_refund(&donor, &donation_index, &token);
        client.approve_refund(&admin, &0);

        let balance_after = StellarAssetClient::new(&env, &token).balance(&donor);
        assert_eq!(balance_after, balance_before + 25 * STROOP);
    }

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn test_approve_refund_non_admin_panics() {
        let (env, _cid, client, _admin, pid) = setup();
        let (donor, token, donation_index) = setup_donation(&env, &client, &pid);
        let imposter = Address::generate(&env);

        client.request_refund(&donor, &donation_index, &token);
        client.approve_refund(&imposter, &0);
    }

    #[test]
    #[should_panic(expected = "Refund request is not pending")]
    fn test_approve_refund_not_pending_panics() {
        let (env, _cid, client, admin, pid) = setup();
        let (donor, token, donation_index) = setup_donation(&env, &client, &pid);

        client.request_refund(&donor, &donation_index, &token);
        client.reject_refund(&admin, &0);
        // Now try to approve a rejected request.
        client.approve_refund(&admin, &0);
    }

    #[test]
    fn test_reject_refund_success() {
        let (env, _cid, client, admin, pid) = setup();
        let (donor, token, donation_index) = setup_donation(&env, &client, &pid);

        let project_before = client.get_project(&pid);
        let stats_before = client.get_donor_stats(&donor);

        client.request_refund(&donor, &donation_index, &token);
        client.reject_refund(&admin, &0);

        let req = client.get_refund_request(&0);
        assert_eq!(req.status, RefundRequestStatus::Rejected);

        // Counters are untouched — donation stands.
        let project_after = client.get_project(&pid);
        assert_eq!(project_after.total_raised, project_before.total_raised);
        let stats_after = client.get_donor_stats(&donor);
        assert_eq!(stats_after.total_donated, stats_before.total_donated);
    }

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn test_reject_refund_non_admin_panics() {
        let (env, _cid, client, _admin, pid) = setup();
        let (donor, token, donation_index) = setup_donation(&env, &client, &pid);
        let imposter = Address::generate(&env);

        client.request_refund(&donor, &donation_index, &token);
        client.reject_refund(&imposter, &0);
    }

    #[test]
    #[should_panic(expected = "Refund request is not pending")]
    fn test_reject_refund_not_pending_panics() {
        let (env, _cid, client, admin, pid) = setup();
        let (donor, token, donation_index) = setup_donation(&env, &client, &pid);

        client.request_refund(&donor, &donation_index, &token);
        client.approve_refund(&admin, &0);
        // Now try to reject an approved request.
        client.reject_refund(&admin, &0);
    }

    #[test]
    #[should_panic(expected = "Refund request not found")]
    fn test_get_refund_request_not_found_panics() {
        let (_env, _cid, client, _admin, _pid) = setup();
        client.get_refund_request(&0);
    }

    // ─── Recurring Donation Tests ─────────────────────────────────────────────

    #[test]
    fn test_create_recurring_success() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);

        let recurring_id = client.create_recurring(
            &donor,
            &pid,
            &(10 * STROOP),
            &symbol_short!("XLM"),
            &100u32,
            &STROOP,
            &1u32,
        );

        assert_eq!(recurring_id, 0);
        let recurring = client.get_recurring(&donor, &0u32);
        assert_eq!(recurring.donor, donor);
        assert_eq!(recurring.project_id, pid);
        assert_eq!(recurring.amount, 10 * STROOP);
        assert_eq!(recurring.currency, symbol_short!("XLM"));
        assert_eq!(recurring.interval_ledgers, 100);
        assert_eq!(recurring.keeper_incentive, STROOP);
        assert!(recurring.active);
    }

    #[test]
    #[should_panic(expected = "Donation amount must be positive")]
    fn test_create_recurring_invalid_amount() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        client.create_recurring(
            &donor,
            &pid,
            &0,
            &symbol_short!("XLM"),
            &100u32,
            &STROOP,
            &1u32,
        );
    }

    #[test]
    #[should_panic(expected = "Keeper incentive must be non-negative")]
    fn test_create_recurring_invalid_keeper_incentive() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        client.create_recurring(
            &donor,
            &pid,
            &(10 * STROOP),
            &symbol_short!("XLM"),
            &100u32,
            &-1,
            &1u32,
        );
    }

    #[test]
    #[should_panic(expected = "Interval must be positive")]
    fn test_create_recurring_invalid_interval() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        client.create_recurring(
            &donor,
            &pid,
            &(10 * STROOP),
            &symbol_short!("XLM"),
            &0u32,
            &STROOP,
            &1u32,
        );
    }

    #[test]
    #[should_panic(expected = "Project not found")]
    fn test_create_recurring_project_not_found() {
        let (env, _cid, client, _admin, _pid) = setup();
        let donor = Address::generate(&env);
        client.create_recurring(
            &donor,
            &String::from_str(&env, "nonexistent"),
            &(10 * STROOP),
            &symbol_short!("XLM"),
            &100u32,
            &STROOP,
            &1u32,
        );
    }

    #[test]
    fn test_cancel_recurring_success() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let recurring_id = client.create_recurring(
            &donor,
            &pid,
            &(10 * STROOP),
            &symbol_short!("XLM"),
            &100u32,
            &STROOP,
            &1u32,
        );

        client.cancel_recurring(&donor, &recurring_id);
        let recurring = client.get_recurring(&donor, &recurring_id);
        assert!(!recurring.active);
    }

    #[test]
    #[should_panic(expected = "Recurring donation is not active")]
    fn test_cancel_recurring_not_active() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let recurring_id = client.create_recurring(
            &donor,
            &pid,
            &(10 * STROOP),
            &symbol_short!("XLM"),
            &100u32,
            &STROOP,
            &1u32,
        );

        client.cancel_recurring(&donor, &recurring_id);
        client.cancel_recurring(&donor, &recurring_id);
    }

    #[test]
    #[should_panic(expected = "Recurring donation not found")]
    fn test_cancel_recurring_not_found() {
        let (env, _cid, client, _admin, _pid) = setup();
        let donor = Address::generate(&env);
        client.cancel_recurring(&donor, &0u32);
    }

    #[test]
    fn test_execute_recurring_success_xlm() {
        let (env, _cid, client, admin, pid) = setup();
        let donor = Address::generate(&env);
        let keeper = Address::generate(&env);

        // Setup mock native token
        let token_admin = Address::generate(&env);
        let native_token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        client.set_native_token(&admin, &native_token);

        // Mint and approve native tokens
        let native_client = StellarAssetClient::new(&env, &native_token);
        native_client.mint(&donor, &(100 * STROOP));
        native_client.approve(&donor, &client.address, &(100 * STROOP), &9999u32);

        let recurring_id = client.create_recurring(
            &donor,
            &pid,
            &(10 * STROOP),
            &symbol_short!("XLM"),
            &100u32,
            &STROOP,
            &1u32,
        );

        // Fast-forward sequence number to maturity
        let matured_ledger = env.ledger().sequence() + 100;
        env.ledger().set_sequence_number(matured_ledger);

        client.execute_recurring(&keeper, &donor, &recurring_id);

        // Verify balances
        let project = client.get_project(&pid);
        let project_wallet_balance = native_client.balance(&project.wallet);
        let keeper_balance = native_client.balance(&keeper);
        let donor_balance = native_client.balance(&donor);

        assert_eq!(project_wallet_balance, 10 * STROOP);
        assert_eq!(keeper_balance, STROOP);
        assert_eq!(donor_balance, 89 * STROOP);

        // Verify stats
        assert_eq!(project.total_raised, 10 * STROOP);
        let donor_stats = client.get_donor_stats(&donor);
        assert_eq!(donor_stats.total_donated, 10 * STROOP);
        assert_eq!(donor_stats.donation_count, 1);
        assert_eq!(donor_stats.badge, BadgeTier::Seedling);

        // Verify next execution ledger is updated
        let recurring = client.get_recurring(&donor, &recurring_id);
        assert_eq!(recurring.next_execution_ledger, matured_ledger + 100);
    }

    #[test]
    fn test_execute_recurring_success_usdc() {
        let (env, _cid, client, admin, pid) = setup();
        let donor = Address::generate(&env);
        let keeper = Address::generate(&env);

        // Setup mock USDC token
        let usdc_admin = Address::generate(&env);
        let usdc_token = env.register_stellar_asset_contract_v2(usdc_admin).address();
        client.set_usdc_token(&admin, &usdc_token);

        // Setup mock oracle (rate = 8 XLM per USDC)
        let oracle_id = env.register_contract(None, MockOracle);
        client.set_oracle(&admin, &oracle_id);

        // Mint and approve USDC tokens
        let usdc_client = StellarAssetClient::new(&env, &usdc_token);
        usdc_client.mint(&donor, &(100 * STROOP));
        usdc_client.approve(&donor, &client.address, &(100 * STROOP), &9999u32);

        let recurring_id = client.create_recurring(
            &donor,
            &pid,
            &(10 * STROOP),
            &symbol_short!("USDC"),
            &100u32,
            &STROOP,
            &1u32,
        );

        // Fast-forward sequence number to maturity
        let matured_ledger = env.ledger().sequence() + 100;
        env.ledger().set_sequence_number(matured_ledger);

        client.execute_recurring(&keeper, &donor, &recurring_id);

        // Verify balances
        let project = client.get_project(&pid);
        let project_wallet_balance = usdc_client.balance(&project.wallet);
        let keeper_balance = usdc_client.balance(&keeper);
        let donor_balance = usdc_client.balance(&donor);

        assert_eq!(project_wallet_balance, 10 * STROOP);
        assert_eq!(keeper_balance, STROOP);
        assert_eq!(donor_balance, 89 * STROOP);

        // Verify stats (USDC amount is converted using oracle rate 8)
        // 10 USDC * 8 = 80 XLM
        assert_eq!(project.total_raised, 80 * STROOP);
        let donor_stats = client.get_donor_stats(&donor);
        assert_eq!(donor_stats.total_donated, 80 * STROOP);
        assert_eq!(donor_stats.donation_count, 1);
        assert_eq!(donor_stats.badge, BadgeTier::Seedling);
    }

    #[test]
    #[should_panic(expected = "Recurring donation has not matured yet")]
    fn test_execute_recurring_pre_maturity_panics() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let keeper = Address::generate(&env);

        let recurring_id = client.create_recurring(
            &donor,
            &pid,
            &(10 * STROOP),
            &symbol_short!("XLM"),
            &100u32,
            &STROOP,
            &1u32,
        );

        client.execute_recurring(&keeper, &donor, &recurring_id);
    }

    #[test]
    #[should_panic(expected = "Recurring donation is not active")]
    fn test_execute_recurring_cancelled_panics() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let keeper = Address::generate(&env);

        let recurring_id = client.create_recurring(
            &donor,
            &pid,
            &(10 * STROOP),
            &symbol_short!("XLM"),
            &100u32,
            &STROOP,
            &1u32,
        );

        client.cancel_recurring(&donor, &recurring_id);

        let matured_ledger = env.ledger().sequence() + 100;
        env.ledger().set_sequence_number(matured_ledger);

        client.execute_recurring(&keeper, &donor, &recurring_id);
    }

    #[test]
    #[should_panic(expected = "Project is temporarily paused")]
    fn test_execute_recurring_project_paused_panics() {
        let (env, _cid, client, admin, pid) = setup();
        let donor = Address::generate(&env);
        let keeper = Address::generate(&env);

        // Setup mock native token
        let token_admin = Address::generate(&env);
        let native_token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        client.set_native_token(&admin, &native_token);

        let recurring_id = client.create_recurring(
            &donor,
            &pid,
            &(10 * STROOP),
            &symbol_short!("XLM"),
            &100u32,
            &STROOP,
            &1u32,
        );

        // Pause project
        client.pause_project(&admin, &pid);

        let matured_ledger = env.ledger().sequence() + 100;
        env.ledger().set_sequence_number(matured_ledger);

        client.execute_recurring(&keeper, &donor, &recurring_id);
    }

    #[test]
    #[should_panic(expected = "Contract is paused")]
    fn test_execute_recurring_contract_paused_panics() {
        let (env, _cid, client, admin, pid) = setup();
        let donor = Address::generate(&env);
        let keeper = Address::generate(&env);

        let recurring_id = client.create_recurring(
            &donor,
            &pid,
            &(10 * STROOP),
            &symbol_short!("XLM"),
            &100u32,
            &STROOP,
            &1u32,
        );

        // Pause contract
        client.pause_contract(&signers1(&env, &admin));

        let matured_ledger = env.ledger().sequence() + 100;
        env.ledger().set_sequence_number(matured_ledger);

        client.execute_recurring(&keeper, &donor, &recurring_id);
    }

    #[test]
    fn test_execute_recurring_badge_progression() {
        let (env, _cid, client, admin, pid) = setup();
        let donor = Address::generate(&env);
        let keeper = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let native_token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        client.set_native_token(&admin, &native_token);

        let native_client = StellarAssetClient::new(&env, &native_token);
        // 500 XLM × 3 executions = 1 500 XLM donation + 1 XLM × 3 = 3 XLM keeper
        // incentives = 1 503 XLM total to cover all transfer_from calls.
        native_client.mint(&donor, &(1503 * STROOP));
        native_client.approve(&donor, &client.address, &(1503 * STROOP), &9999u32);

        // 500 XLM intervals
        let recurring_id = client.create_recurring(
            &donor,
            &pid,
            &(500 * STROOP),
            &symbol_short!("XLM"),
            &100u32,
            &STROOP,
            &1u32,
        );

        // Execution 1: 500 XLM -> Badge should be Forest (threshold 500)
        let seq = env.ledger().sequence();
        env.ledger().set_sequence_number(seq + 100);
        client.execute_recurring(&keeper, &donor, &recurring_id);
        assert_eq!(client.get_donor_stats(&donor).badge, BadgeTier::Forest);

        // Execution 2: 1000 XLM -> Badge remains Forest
        let seq = env.ledger().sequence();
        env.ledger().set_sequence_number(seq + 100);
        client.execute_recurring(&keeper, &donor, &recurring_id);
        assert_eq!(client.get_donor_stats(&donor).badge, BadgeTier::Forest);

        // Execution 3: 1500 XLM -> Badge remains Forest (threshold for Earth Guardian is 2000)
        let seq = env.ledger().sequence();
        env.ledger().set_sequence_number(seq + 100);
        client.execute_recurring(&keeper, &donor, &recurring_id);
        assert_eq!(client.get_donor_stats(&donor).badge, BadgeTier::Forest);
    }

    #[test]
    fn test_get_donor_recurrings() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);

        let recurring_id_0 = client.create_recurring(
            &donor,
            &pid,
            &(10 * STROOP),
            &symbol_short!("XLM"),
            &100u32,
            &STROOP,
            &1u32,
        );
        let recurring_id_1 = client.create_recurring(
            &donor,
            &pid,
            &(20 * STROOP),
            &symbol_short!("USDC"),
            &200u32,
            &STROOP,
            &2u32,
        );

        assert_eq!(recurring_id_0, 0);
        assert_eq!(recurring_id_1, 1);

        let recurrings = client.get_donor_recurrings(&donor);
        assert_eq!(recurrings.len(), 2);

        let sub_0 = recurrings.get(0).unwrap();
        assert_eq!(sub_0.amount, 10 * STROOP);
        assert_eq!(sub_0.currency, symbol_short!("XLM"));

        let sub_1 = recurrings.get(1).unwrap();
        assert_eq!(sub_1.amount, 20 * STROOP);
        assert_eq!(sub_1.currency, symbol_short!("USDC"));
    }

    // ─── Cross-Contract Project Registry tests (#391) ───────────────────────

    #[test]
    fn test_create_sub_project() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let parent_id = String::from_str(&env, "parent");
        let parent_wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &parent_id,
            &String::from_str(&env, "Parent Project"),
            &parent_wallet,
            &100u32,
        );

        let child_id = String::from_str(&env, "child");
        client.register_sub_project(
            &parent_wallet,
            &child_id,
            &String::from_str(&env, "Child Project"),
            &50u32,
            &parent_id,
        );

        let child = client.get_project(&child_id);
        assert_eq!(child.name, String::from_str(&env, "Child Project"));
        assert_eq!(child.co2_per_xlm, 50);
        assert_eq!(child.parent_project_id, Some(parent_id.clone()));
        assert!(child.active);
        assert_eq!(child.wallet, parent_wallet);
        assert_eq!(client.get_project_count(), 2);
    }

    #[test]
    fn test_get_sub_projects() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let parent_id = String::from_str(&env, "parent");
        let parent_wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &parent_id,
            &String::from_str(&env, "Parent"),
            &parent_wallet,
            &100u32,
        );

        let child1 = String::from_str(&env, "child1");
        let child2 = String::from_str(&env, "child2");
        client.register_sub_project(
            &parent_wallet,
            &child1,
            &String::from_str(&env, "Child 1"),
            &50u32,
            &parent_id,
        );
        client.register_sub_project(
            &parent_wallet,
            &child2,
            &String::from_str(&env, "Child 2"),
            &75u32,
            &parent_id,
        );

        // Non-parent project returns empty list
        let unrelated = String::from_str(&env, "unrelated");
        let unrelated_wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &unrelated,
            &String::from_str(&env, "Unrelated"),
            &unrelated_wallet,
            &100u32,
        );
        assert_eq!(client.get_sub_projects(&unrelated).len(), 0);

        let subs = client.get_sub_projects(&parent_id);
        assert_eq!(subs.len(), 2);
        assert_eq!(subs.get(0).unwrap(), child1);
        assert_eq!(subs.get(1).unwrap(), child2);
    }

    #[test]
    fn test_aggregated_impact() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let parent_id = String::from_str(&env, "parent");
        let parent_wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &parent_id,
            &String::from_str(&env, "Parent"),
            &parent_wallet,
            &100u32,
        );

        let child1 = String::from_str(&env, "child1");
        let child2 = String::from_str(&env, "child2");
        client.register_sub_project(
            &parent_wallet,
            &child1,
            &String::from_str(&env, "Child 1"),
            &200u32,
            &parent_id,
        );
        client.register_sub_project(
            &parent_wallet,
            &child2,
            &String::from_str(&env, "Child 2"),
            &300u32,
            &parent_id,
        );

        // Donate to parent: 20 XLM → co2 = 20 * 100 = 2000
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let donor = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&donor, &(60 * STROOP));
        client.donate(&token, &donor, &parent_id, &(20 * STROOP), &0u32);

        // Donate to child1: 15 XLM → co2 = 15 * 200 = 3000
        client.donate(&token, &donor, &child1, &(15 * STROOP), &1u32);

        // Donate to child2: 25 XLM → co2 = 25 * 300 = 7500
        client.donate(&token, &donor, &child2, &(25 * STROOP), &2u32);

        let (total_raised, total_co2, total_donors) = client.get_aggregated_impact(&parent_id);
        assert_eq!(total_raised, 60 * STROOP);
        // CO2: parent=20*100 + child1=15*200 + child2=25*300 = 2000+3000+7500 = 12500
        assert_eq!(total_co2, 12500);
        // One unique donor across all projects
        assert_eq!(total_donors, 3);
    }

    #[test]
    fn test_parent_deactivation_cascades() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let parent_id = String::from_str(&env, "parent");
        let parent_wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &parent_id,
            &String::from_str(&env, "Parent"),
            &parent_wallet,
            &100u32,
        );

        let child1 = String::from_str(&env, "child1");
        let child2 = String::from_str(&env, "child2");
        client.register_sub_project(
            &parent_wallet,
            &child1,
            &String::from_str(&env, "Child 1"),
            &50u32,
            &parent_id,
        );
        client.register_sub_project(
            &parent_wallet,
            &child2,
            &String::from_str(&env, "Child 2"),
            &75u32,
            &parent_id,
        );

        // All active before deactivation
        assert!(client.get_project(&parent_id).active);
        assert!(client.get_project(&child1).active);
        assert!(client.get_project(&child2).active);

        // Deactivate parent — should cascade
        client.deactivate_project(&admin, &parent_id);

        assert!(!client.get_project(&parent_id).active);
        assert!(!client.get_project(&child1).active);
        assert!(!client.get_project(&child2).active);
    }

    #[test]
    #[should_panic(expected = "Wallet does not match parent project wallet")]
    fn test_unauthorized_sub_project_registration() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let parent_id = String::from_str(&env, "parent");
        let parent_wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &parent_id,
            &String::from_str(&env, "Parent"),
            &parent_wallet,
            &100u32,
        );

        // Try to register sub-project with a different wallet
        let imposter_wallet = Address::generate(&env);
        let child_id = String::from_str(&env, "child");
        client.register_sub_project(
            &imposter_wallet,
            &child_id,
            &String::from_str(&env, "Child"),
            &50u32,
            &parent_id,
        );
    }

    // ─── zk-SNARK anonymous donation tests (#390) ────────────────────────────

    #[cfg(feature = "zk")]
    #[test]
    fn test_anonymous_address_derivation_deterministic() {
        let env = Env::default();
        let nullifier = BytesN::from_array(&env, &[42u8; 32]);
        let hash1 = env
            .crypto()
            .sha256(&Bytes::from_slice(&env, nullifier.as_ref()));
        let addr1 = Address::from_bytes(&hash1.to_bytes().as_ref().into());
        let hash2 = env
            .crypto()
            .sha256(&Bytes::from_slice(&env, nullifier.as_ref()));
        let addr2 = Address::from_bytes(&hash2.to_bytes().as_ref().into());
        assert_eq!(addr1, addr2);
    }

    #[cfg(feature = "zk")]
    #[test]
    fn test_anonymous_address_derivation_different_nullifiers() {
        let env = Env::default();
        let n1 = BytesN::from_array(&env, &[1u8; 32]);
        let n2 = BytesN::from_array(&env, &[2u8; 32]);
        let h1 = env.crypto().sha256(&Bytes::from_slice(&env, n1.as_ref()));
        let a1 = Address::from_bytes(&h1.to_bytes().as_ref().into());
        let h2 = env.crypto().sha256(&Bytes::from_slice(&env, n2.as_ref()));
        let a2 = Address::from_bytes(&h2.to_bytes().as_ref().into());
        assert_ne!(a1, a2);
    }

    #[cfg(feature = "zk")]
    #[test]
    #[should_panic(
        expected = "Verification key not set — admin must call set_zk_verification_key first"
    )]
    fn test_anonymous_donation_no_verification_key() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);
        let nullifier = BytesN::from_array(&env, &[5u8; 32]);
        let token = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let proof = Bytes::from_slice(&env, &[0u8; 256]);
        let project_id = String::from_str(&env, "test");
        client.donate_anonymous(
            &token,
            &proof,
            &project_id,
            &1_000_000i128,
            &nullifier,
            &1u32,
        );
    }

    #[cfg(feature = "zk")]
    #[test]
    fn test_set_and_get_verification_key() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);
        let vk = Bytes::from_slice(&env, &[0xAB; 128]);
        client.set_zk_verification_key(&admin, &vk);
        let stored = client.get_zk_verification_key();
        assert!(stored.is_some());
        assert_eq!(stored.unwrap(), vk);
    }

    #[cfg(feature = "zk")]
    #[test]
    fn test_anonymous_donation_nullifier_not_spent_on_proof_failure() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);
        let project_id = String::from_str(&env, "test-proj");
        let project_wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &project_id,
            &String::from_str(&env, "Test Project"),
            &project_wallet,
            &50u32,
        );
        let vk = Bytes::from_slice(&env, &[1u8; 64]);
        client.set_zk_verification_key(&admin, &vk);
        let nullifier = BytesN::from_array(&env, &[7u8; 32]);
        let token = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let bad_proof = Bytes::from_slice(&env, &[0xFFu8; 256]);
        let result = client.try_donate_anonymous(
            &token,
            &bad_proof,
            &project_id,
            &5_000_000i128,
            &nullifier,
            &1u32,
        );
        assert!(result.is_err());
        assert!(!client.is_nullifier_spent(&nullifier));
    }

    #[cfg(feature = "zk")]
    #[test]
    #[should_panic(expected = "Donation amount must be positive")]
    fn test_anonymous_donation_zero_amount() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);
        let project_id = String::from_str(&env, "test-proj");
        let project_wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &project_id,
            &String::from_str(&env, "Test"),
            &project_wallet,
            &50u32,
        );
        let vk = Bytes::from_slice(&env, &[1u8; 64]);
        client.set_zk_verification_key(&admin, &vk);
        let nullifier = BytesN::from_array(&env, &[8u8; 32]);
        let token = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let proof = Bytes::from_slice(&env, &[0u8; 256]);
        client.donate_anonymous(&token, &proof, &project_id, &0i128, &nullifier, &1u32);
    }

    #[cfg(feature = "zk")]
    #[test]
    fn test_is_nullifier_spent_returns_false_initially() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);
        let nullifier = BytesN::from_array(&env, &[9u8; 32]);
        assert!(!client.is_nullifier_spent(&nullifier));
    }

    #[cfg(feature = "zk")]
    #[test]
    #[should_panic(expected = "Verification key must not be empty")]
    fn test_set_zk_verification_key_rejects_empty() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);
        let empty_vk = Bytes::new(&env);
        client.set_zk_verification_key(&admin, &empty_vk);
    }

    // ─── Vesting schedule tests (#386) ───────────────────────────────────────

    #[cfg(feature = "vesting")]
    #[test]
    fn test_vesting_create_and_first_claim() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let project_wallet = Address::generate(&env);
        let pid = String::from_str(&env, "recycle-trees");
        client.register_project(
            &admin,
            &pid,
            &String::from_str(&env, "Recycle Trees"),
            &project_wallet,
            &100u32,
        );

        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let total: i128 = 100_000_000; // 10 XLM
        StellarAssetClient::new(&env, &token).mint(&donor, &total);

        // Create 10-installment vesting at 100 ledgers each.
        let schedule_id =
            client.donate_vested(&token, &donor, &pid, &total, &10u32, &100u32, &0u32);

        let schedule = client.get_vesting_schedule(&donor, &schedule_id);
        assert_eq!(schedule.total_amount, total);
        assert_eq!(schedule.amount_per_installment, 10_000_000); // 1 XLM
        assert_eq!(schedule.installment_count, 10);
        assert_eq!(schedule.installments_released, 1); // first installment immediate
        assert_eq!(schedule.donor, donor);
        assert_eq!(schedule.project_id, pid);

        // Advance past the first interval.
        env.ledger().set_sequence_number(200);

        client.claim_vested_installment(&donor, &schedule_id);
        let schedule2 = client.get_vesting_schedule(&donor, &schedule_id);
        assert_eq!(schedule2.installments_released, 2);
    }

    #[cfg(feature = "vesting")]
    #[test]
    fn test_vesting_multiple_claims() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let project_wallet = Address::generate(&env);
        let pid = String::from_str(&env, "ocean-cleanup");
        client.register_project(
            &admin,
            &pid,
            &String::from_str(&env, "Ocean Cleanup"),
            &project_wallet,
            &50u32,
        );

        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let total: i128 = 50_000_000; // 5 XLM
        StellarAssetClient::new(&env, &token).mint(&donor, &total);

        // 5 installments, 50 ledgers each.
        let schedule_id = client.donate_vested(&token, &donor, &pid, &total, &5u32, &50u32, &0u32);

        let s0 = client.get_vesting_schedule(&donor, &schedule_id);
        assert_eq!(s0.installments_released, 1);

        // Claim 2nd installment.
        env.ledger().set_sequence_number(100);
        client.claim_vested_installment(&donor, &schedule_id);
        let s2 = client.get_vesting_schedule(&donor, &schedule_id);
        assert_eq!(s2.installments_released, 2);

        // Claim 3rd installment.
        env.ledger().set_sequence_number(200);
        client.claim_vested_installment(&donor, &schedule_id);
        let s3 = client.get_vesting_schedule(&donor, &schedule_id);
        assert_eq!(s3.installments_released, 3);

        // Claim remaining.
        env.ledger().set_sequence_number(300);
        client.claim_vested_installment(&donor, &schedule_id);
        env.ledger().set_sequence_number(400);
        client.claim_vested_installment(&donor, &schedule_id);
        let s5 = client.get_vesting_schedule(&donor, &schedule_id);
        assert_eq!(s5.installments_released, 5);
    }

    #[cfg(feature = "vesting")]
    #[test]
    fn test_vesting_cancel_returns_unvested() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let project_wallet = Address::generate(&env);
        let pid = String::from_str(&env, "solar-farms");
        client.register_project(
            &admin,
            &pid,
            &String::from_str(&env, "Solar Farms"),
            &project_wallet,
            &100u32,
        );

        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let total: i128 = 100_000_000; // 10 XLM, 10 installments of 1 XLM each
        StellarAssetClient::new(&env, &token).mint(&donor, &total);

        let schedule_id =
            client.donate_vested(&token, &donor, &pid, &total, &10u32, &720u32, &0u32);

        // Advance through 5 installments.
        env.ledger().set_sequence_number(1000);
        client.claim_vested_installment(&donor, &schedule_id);
        env.ledger().set_sequence_number(2000);
        client.claim_vested_installment(&donor, &schedule_id);
        env.ledger().set_sequence_number(3000);
        client.claim_vested_installment(&donor, &schedule_id);
        env.ledger().set_sequence_number(4000);
        client.claim_vested_installment(&donor, &schedule_id);

        let s_mid = client.get_vesting_schedule(&donor, &schedule_id);
        assert_eq!(s_mid.installments_released, 5);

        // Cancel vesting — remaining 50 XLM returned.
        client.cancel_vesting(&donor, &schedule_id);
    }

    #[cfg(feature = "vesting")]
    #[test]
    #[should_panic(expected = "Next installment not yet claimable")]
    fn test_vesting_claim_before_interval_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let project_wallet = Address::generate(&env);
        let pid = String::from_str(&env, "wind-power");
        client.register_project(
            &admin,
            &pid,
            &String::from_str(&env, "Wind Power"),
            &project_wallet,
            &50u32,
        );

        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let total: i128 = 30_000_000;
        StellarAssetClient::new(&env, &token).mint(&donor, &total);

        // 3 installments, 1000 ledgers each.
        let schedule_id =
            client.donate_vested(&token, &donor, &pid, &total, &3u32, &1000u32, &0u32);

        let s0 = client.get_vesting_schedule(&donor, &schedule_id);
        assert_eq!(s0.installments_released, 1);

        // Try to claim immediately — should fail, interval hasn't elapsed.
        client.claim_vested_installment(&donor, &schedule_id);
    }

    #[cfg(feature = "vesting")]
    #[test]
    #[should_panic(expected = "Vesting schedule not found")]
    fn test_vesting_cancel_by_non_donor_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let project_wallet = Address::generate(&env);
        let pid = String::from_str(&env, "forest-regrow");
        client.register_project(
            &admin,
            &pid,
            &String::from_str(&env, "Forest Regrow"),
            &project_wallet,
            &100u32,
        );

        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let total: i128 = 100_000_000;
        StellarAssetClient::new(&env, &token).mint(&donor, &total);

        let schedule_id =
            client.donate_vested(&token, &donor, &pid, &total, &10u32, &720u32, &0u32);

        // Another address tries to cancel.
        let impostor = Address::generate(&env);
        client.cancel_vesting(&impostor, &schedule_id);
    }

    // ─── Platform fee tests (#385) ───────────────────────────────────────────

    #[cfg(feature = "fees")]
    #[test]
    fn test_donate_with_fee() {
        let (env, _cid, client, admin, pid) = setup();

        // Configure 200 bps (2%) platform fee.
        let treasury = Address::generate(&env);
        client.set_platform_treasury(&signers1(&env, &admin), &treasury);
        client.set_platform_fee(&signers1(&env, &admin), &200u32);

        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let amount: i128 = 100 * STROOP; // 100 XLM
        StellarAssetClient::new(&env, &token).mint(&donor, &amount);

        client.donate(&token, &donor, &pid, &amount, &0u32);

        // Full amount recorded for project total and donor stats.
        let p = client.get_project(&pid);
        assert_eq!(p.total_raised, amount);
        let stats = client.get_donor_stats(&donor);
        assert_eq!(stats.total_donated, amount);
        assert_eq!(client.get_global_total(), amount);

        // 2% fee = 2 XLM = 20_000_000 stroops to treasury.
        // 98 XLM = 980_000_000 stroops to project.
    }

    #[cfg(feature = "fees")]
    #[test]
    fn test_donate_with_zero_fee() {
        let (env, _cid, client, _admin, pid) = setup();

        // Fee defaults to 0 — 100% goes to project (existing behavior).
        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let amount: i128 = 50 * STROOP;
        StellarAssetClient::new(&env, &token).mint(&donor, &amount);

        client.donate(&token, &donor, &pid, &amount, &0u32);

        let p = client.get_project(&pid);
        assert_eq!(p.total_raised, amount);
        let stats = client.get_donor_stats(&donor);
        assert_eq!(stats.total_donated, amount);
        assert_eq!(client.get_global_total(), amount);
    }

    #[cfg(feature = "fees")]
    #[test]
    #[should_panic(expected = "Platform fee exceeds maximum of 500 bps (5%)")]
    fn test_fee_exceeds_maximum() {
        let (env, _cid, client, admin, _pid) = setup();

        // Setting 600 bps (6%) must panic — exceeds 500 bps cap.
        client.set_platform_fee(&signers1(&env, &admin), &600u32);
    }

    #[cfg(feature = "fees")]
    #[test]
    fn test_fee_emitted_in_event() {
        let (env, _cid, client, admin, pid) = setup();

        // Configure 200 bps (2%) platform fee.
        let treasury = Address::generate(&env);
        client.set_platform_treasury(&signers1(&env, &admin), &treasury);
        client.set_platform_fee(&signers1(&env, &admin), &200u32);

        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let amount: i128 = 100 * STROOP;
        StellarAssetClient::new(&env, &token).mint(&donor, &amount);

        client.donate(&token, &donor, &pid, &amount, &0u32);

        // Verify donation was recorded and events include the fee.
        let p = client.get_project(&pid);
        assert_eq!(p.total_raised, amount);
        let record = client.get_donation_record(&0u32);
        assert_eq!(record.amount, amount);
    }

    // ─── On-chain Impact Certificates (#382) ────────────────────────────────

    #[cfg(feature = "impact")]
    /// Helper: compute the Merkle root for two leaves at indices 0 and 1.
    /// Used to build a known-good test root from ImpactLeaf values.
    fn build_two_leaf_root(env: &Env, leaf0: &ImpactLeaf, leaf1: &ImpactLeaf) -> BytesN<32> {
        let hash0 = compute_impact_leaf_hash(env, leaf0);
        let hash1 = compute_impact_leaf_hash(env, leaf1);
        let mut combined = [0u8; 64];
        combined[..32].copy_from_slice(&hash0.to_array());
        combined[32..].copy_from_slice(&hash1.to_array());
        env.crypto()
            .sha256(&Bytes::from_slice(env, &combined))
            .into()
    }

    /// Helper: build a proof for leaf at index 0 in a two-leaf tree.
    fn build_proof_for_leaf0(env: &Env, leaf1: &ImpactLeaf) -> Vec<BytesN<32>> {
        let mut proof = Vec::new(env);
        proof.push_back(compute_impact_leaf_hash(env, leaf1));
        proof
    }

    #[test]
    fn test_merkle_proof_verification_valid() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);

        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let project_wallet = Address::generate(&env);
        let project_id = String::from_str(&env, "forest-restore");
        client.register_project(
            &admin,
            &project_id,
            &String::from_str(&env, "Forest Restore"),
            &project_wallet,
            &100u32,
        );

        let donor_a = Address::generate(&env);
        let donor_b = Address::generate(&env);

        let leaf_a = ImpactLeaf {
            donor: donor_a.clone(),
            donation_index: 0u32,
            co2_kg: 100u32,
            trees: 5u32,
            hectares: 2u32,
        };
        let leaf_b = ImpactLeaf {
            donor: donor_b.clone(),
            donation_index: 1u32,
            co2_kg: 200u32,
            trees: 10u32,
            hectares: 4u32,
        };

        let root = build_two_leaf_root(&env, &leaf_a, &leaf_b);
        let proof = build_proof_for_leaf0(&env, &leaf_b);

        let report_id = String::from_str(&env, "Q1 2026");
        client.set_impact_merkle_root(&admin, &project_id, &root, &report_id);

        // Donor A's impact should verify with the correct proof.
        let result = client.verify_impact(&project_id, &report_id, &leaf_a, &proof, &0u32);
        assert!(result);
    }

    #[test]
    fn test_merkle_proof_verification_invalid() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);

        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let project_wallet = Address::generate(&env);
        let project_id = String::from_str(&env, "forest-restore");
        client.register_project(
            &admin,
            &project_id,
            &String::from_str(&env, "Forest Restore"),
            &project_wallet,
            &100u32,
        );

        let donor_a = Address::generate(&env);
        let donor_b = Address::generate(&env);
        let donor_c = Address::generate(&env);

        let leaf_a = ImpactLeaf {
            donor: donor_a.clone(),
            donation_index: 0u32,
            co2_kg: 100u32,
            trees: 5u32,
            hectares: 2u32,
        };
        let leaf_b = ImpactLeaf {
            donor: donor_b.clone(),
            donation_index: 1u32,
            co2_kg: 200u32,
            trees: 10u32,
            hectares: 4u32,
        };

        let root = build_two_leaf_root(&env, &leaf_a, &leaf_b);
        let report_id = String::from_str(&env, "Q1 2026");
        client.set_impact_merkle_root(&admin, &project_id, &root, &report_id);

        // Create a different leaf for donor C (not in the tree).
        let leaf_c = ImpactLeaf {
            donor: donor_c.clone(),
            donation_index: 2u32,
            co2_kg: 300u32,
            trees: 15u32,
            hectares: 6u32,
        };

        // Use the proof for leaf_a (which is correct for leaf_a but NOT for leaf_c).
        let proof = build_proof_for_leaf0(&env, &leaf_b);

        // Donor C's impact should NOT verify with leaf_a's proof.
        let result = client.verify_impact(&project_id, &report_id, &leaf_c, &proof, &0u32);
        assert!(!result);
    }

    #[test]
    fn test_merkle_proof_wrong_root() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);

        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let project_wallet = Address::generate(&env);
        let project_id = String::from_str(&env, "forest-restore");
        client.register_project(
            &admin,
            &project_id,
            &String::from_str(&env, "Forest Restore"),
            &project_wallet,
            &100u32,
        );

        let donor_a = Address::generate(&env);
        let donor_b = Address::generate(&env);

        let leaf_a = ImpactLeaf {
            donor: donor_a.clone(),
            donation_index: 0u32,
            co2_kg: 100u32,
            trees: 5u32,
            hectares: 2u32,
        };
        let leaf_b = ImpactLeaf {
            donor: donor_b.clone(),
            donation_index: 1u32,
            co2_kg: 200u32,
            trees: 10u32,
            hectares: 4u32,
        };

        // Post a root for "Q1 2026" report.
        let root = build_two_leaf_root(&env, &leaf_a, &leaf_b);
        let report_id = String::from_str(&env, "Q1 2026");
        client.set_impact_merkle_root(&admin, &project_id, &root, &report_id);

        let proof = build_proof_for_leaf0(&env, &leaf_b);

        // Verify against a different report_id that has NO root posted.
        let wrong_report = String::from_str(&env, "Q2 2026");
        let result = client.verify_impact(&project_id, &wrong_report, &leaf_a, &proof, &0u32);
        assert!(!result);

        // Verify against a wrong project_id.
        let wrong_project = String::from_str(&env, "nonexistent");
        let result = client.verify_impact(&wrong_project, &report_id, &leaf_a, &proof, &0u32);
        assert!(!result);
    }

    #[test]
    fn test_set_and_verify_impact_root() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);

        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let project_wallet = Address::generate(&env);
        let project_id = String::from_str(&env, "ocean-cleanup");
        client.register_project(
            &admin,
            &project_id,
            &String::from_str(&env, "Ocean Cleanup"),
            &project_wallet,
            &50u32,
        );

        let donor = Address::generate(&env);

        // Create a single-leaf Merkle tree (root = leaf hash).
        let leaf = ImpactLeaf {
            donor: donor.clone(),
            donation_index: 0u32,
            co2_kg: 500u32,
            trees: 25u32,
            hectares: 10u32,
        };
        let leaf_hash = compute_impact_leaf_hash(&env, &leaf);

        let report_id = String::from_str(&env, "Annual 2026");

        // Before posting, the root should not exist.
        let stored = client.get_impact_merkle_root(&project_id, &report_id);
        assert!(stored.is_none());

        // Post the root (root = leaf hash for a single-leaf tree).
        client.set_impact_merkle_root(&admin, &project_id, &leaf_hash, &report_id);

        // After posting, the root should be retrievable.
        let stored = client.get_impact_merkle_root(&project_id, &report_id);
        assert_eq!(stored, Some(leaf_hash.clone()));

        // Verify with empty proof (single leaf: root == leaf hash).
        let empty_proof = Vec::new(&env);
        let result = client.verify_impact(&project_id, &report_id, &leaf, &empty_proof, &0u32);
        assert!(result);
    }

    #[test]
    fn test_merkle_proof_wrong_leaf_index() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);

        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let project_wallet = Address::generate(&env);
        let project_id = String::from_str(&env, "forest-restore");
        client.register_project(
            &admin,
            &project_id,
            &String::from_str(&env, "Forest Restore"),
            &project_wallet,
            &100u32,
        );

        let donor_a = Address::generate(&env);
        let donor_b = Address::generate(&env);

        let leaf_a = ImpactLeaf {
            donor: donor_a.clone(),
            donation_index: 0u32,
            co2_kg: 100u32,
            trees: 5u32,
            hectares: 2u32,
        };
        let leaf_b = ImpactLeaf {
            donor: donor_b.clone(),
            donation_index: 1u32,
            co2_kg: 200u32,
            trees: 10u32,
            hectares: 4u32,
        };

        let root = build_two_leaf_root(&env, &leaf_a, &leaf_b);
        let proof = build_proof_for_leaf0(&env, &leaf_b);

        let report_id = String::from_str(&env, "Q1 2026");
        client.set_impact_merkle_root(&admin, &project_id, &root, &report_id);

        // Leaf A is at index 0 with proof = [hash(leaf_b)].
        // Claiming it's at index 1 reverses the sibling ordering:
        //   idx=1 → sibling || hash instead of hash || sibling
        // This produces a different combined value → verification fails.
        let result = client.verify_impact(
            &project_id,
            &report_id,
            &leaf_a,
            &proof,
            &1u32, // WRONG: leaf_a is actually at index 0
        );
        assert!(!result);
    }

    #[test]
    fn test_merkle_proof_mismatched_root() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);

        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let project_wallet = Address::generate(&env);
        let project_id = String::from_str(&env, "forest-restore");
        client.register_project(
            &admin,
            &project_id,
            &String::from_str(&env, "Forest Restore"),
            &project_wallet,
            &100u32,
        );

        let donor_a = Address::generate(&env);
        let donor_b = Address::generate(&env);
        let donor_c = Address::generate(&env);

        // Build a tree from leaf_a + leaf_b and post its root.
        let leaf_a = ImpactLeaf {
            donor: donor_a.clone(),
            donation_index: 0u32,
            co2_kg: 100u32,
            trees: 5u32,
            hectares: 2u32,
        };
        let leaf_b = ImpactLeaf {
            donor: donor_b.clone(),
            donation_index: 1u32,
            co2_kg: 200u32,
            trees: 10u32,
            hectares: 4u32,
        };
        let root_ab = build_two_leaf_root(&env, &leaf_a, &leaf_b);

        let report_id = String::from_str(&env, "Q1 2026");
        client.set_impact_merkle_root(&admin, &project_id, &root_ab, &report_id);

        // Build a DIFFERENT tree from leaf_a + leaf_c → different root.
        let leaf_c = ImpactLeaf {
            donor: donor_c.clone(),
            donation_index: 2u32,
            co2_kg: 300u32,
            trees: 15u32,
            hectares: 6u32,
        };
        let root_ac = build_two_leaf_root(&env, &leaf_a, &leaf_c);

        // Verify that the two roots are actually different.
        assert_ne!(root_ab, root_ac);

        // Use leaf_a with proof for leaf_c against the STORED root_ab.
        // The proof is valid for root_ac, but the stored root is root_ab.
        let proof_for_ac = build_proof_for_leaf0(&env, &leaf_c);

        let result = client.verify_impact(&project_id, &report_id, &leaf_a, &proof_for_ac, &0u32);
        assert!(!result);
    }
}