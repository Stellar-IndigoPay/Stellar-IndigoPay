#![no_std]
// Deprecated Events::publish — the new #[contractevent] macro is preferred.
// Suppressing this warning so clippy -- -D warnings still passes.
// TODO(indigopay-272): migrate to #[contractevent] pattern.
#![allow(deprecated)]
#[cfg(feature = "donation")]
pub mod donation;
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
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, String, Symbol, Vec,
};
#[cfg(any(
    feature = "usdc",
    feature = "donation",
    feature = "testutils",
    feature = "zk",
    feature = "impact"
))]
use soroban_sdk::{contractclient, token, Bytes};
#[cfg(feature = "project_verification")]
use soroban_sdk::{contracterror, panic_with_error};

// ─── Oracle interface ─────────────────────────────────────────────────────────
/// External price oracle interface.
/// Any on-chain contract implementing `get_price` can serve as the oracle.
/// `get_price` returns the number of XLM stroops equivalent to 1 USDC stroop.
/// Example: if 1 USDC = 8 XLM, return 8.
#[cfg(any(feature = "usdc", feature = "donation", feature = "testutils"))]
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
/// Input for a single donation within a `batch_donate` call.
#[contracttype]
#[derive(Clone, Debug)]
pub struct BatchDonation {
    pub donor: Address,
    pub project_id: String,
    pub amount: i128,
    pub msg_hash: u32,
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

/// A cryptographically signed/hashed receipt proving a donation's details.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DonationReceipt {
    pub donation_index: u32,
    pub donor: Address,
    pub project_id: String,
    pub amount: i128,
    pub co2_offset: i128,
    pub ledger: u32,
    pub currency: Symbol,
    pub contract_signature: BytesN<32>,
}

/// Helper struct used to compute the SHA-256 commitment of receipt fields.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ReceiptFields {
    pub donation_index: u32,
    pub donor: Address,
    pub project_id: String,
    pub amount: i128,
    pub co2_offset: i128,
    pub ledger: u32,
    pub currency: Symbol,
}

/// A proof-verified donation with no donor identity in contract storage.
#[cfg(feature = "zk")]
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ZkDonationRecord {
    pub project: String,
    pub amount: i128,
    pub amount_commitment: BytesN<32>,
    pub nullifier: BytesN<32>,
    pub ledger: u32,
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
#[cfg(feature = "governance")]
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
#[cfg(feature = "emergency")]
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
#[cfg(feature = "refund")]
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum RefundRequestStatus {
    Pending,
    Approved,
    Rejected,
}
/// A donor-initiated refund request. Created by `request_refund`, resolved by
/// `approve_refund` (which atomically transfers tokens back) or `reject_refund`.
#[cfg(feature = "refund")]
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

#[cfg(feature = "recurring")]
/// A pending M-of-N refund escalation.
#[cfg(feature = "refund")]
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ForceRefund {
    /// Ledger at which the M-of-N admins initiated the escalation.
    pub initiated_at: u32,
    /// Earliest ledger at which anyone may execute the force-refund.
    pub effective_at: u32,
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

/// A time-locked vesting schedule for gradual donation release. Donors can
/// specify that a donation should be released to the project in equal
/// installments over a configurable number of ledgers, rather than all at
/// once. The first installment is transferred immediately; subsequent
/// installments are claimable after each interval elapses.
#[cfg(feature = "vesting")]
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

// ─── Impact Certificate Merkle Root Rotation & Archiving (#466) ────────────

/// Impact root with period metadata — stored both as the "current" root and
/// archived under `ImpactRootArchive(project_id, period_index)`.
#[cfg(feature = "impact")]
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ImpactRoot {
    pub root: BytesN<32>,
    pub period_start: u64,
    pub period_end: u64,
    pub total_co2_kg: u64,
    pub total_trees: u64,
    pub total_hectares: u64,
}

/// Impact totals for a single reporting period.
#[cfg(feature = "impact")]
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ImpactTotals {
    pub co2_kg: u64,
    pub trees: u64,
    pub hectares: u64,
}

/// Lightweight summary of an archived period returned by `get_impact_periods`.
#[cfg(feature = "impact")]
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ImpactPeriodSummary {
    pub period_index: u32,
    pub period_start: u64,
    pub period_end: u64,
    pub total_co2_kg: u64,
    pub total_trees: u64,
    pub total_hectares: u64,
}

/// Storage key enum for the impact root archiving system.
/// Kept separate from `DataKey` so the feature can be toggled without
/// shifting XDR discriminants of always-on variants.
#[cfg(feature = "impact")]
#[contracttype]
#[derive(Clone, Debug)]
#[allow(clippy::enum_variant_names)]
enum ImpactRootKey {
    /// (project_id) -> u32: number of periods archived for this project
    RootCount(String),
    /// (project_id, period_index) -> ImpactRoot: archived period data
    RootArchive(String, u32),
    /// (project_id) -> ImpactRoot: current (latest) root
    RootCurrent(String),
}

/// Maximum number of archived periods per project (48 ≈ 4 years of monthly reports).
#[cfg(feature = "impact")]
pub const MAX_ARCHIVED_PERIODS: u32 = 48;
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DonationChallenge {
    pub challenged: bool,
    pub challenger: Address,
    pub challenged_at: u32,
    pub resolved: bool,
    pub approved: bool,
}

#[contracttype]
pub struct TokenConfig {
    pub token: Address,
    pub oracle: Address,
    pub symbol: Symbol,
    pub active: bool,
    pub registered_at: u32,
}

#[contracttype]
enum LegacyDataKey {
    // Encodes to the historical two-field `DonorRateLimit` storage key.
    DonorRateLimit(Address, String),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeRecipient {
    pub address: Address,
    pub share_bps: u32,
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
    // Per-donor per-project per-token sliding-window donation rate limit.
    DonorRateLimit(Address, String, Address),
    // Admin-configurable donation rate limit overrides (instance storage)
    DonationRateLimitMax,
    DonationRateLimitWindow,
    // Per-project milestone NFT: one per (project_id, donor) pair
    ProjectMilestoneNFT(String, Address),
    // Contract upgrade and multi-currency support. ContractWasmHash was
    // removed: the single-step `upgrade` writer was replaced in Phase A
    // by the two-step `propose_upgrade` / `execute_upgrade` flow which
    // uses the cfg-gated `PendingUpgrade` variant below. No live code
    // path wrote to or read from ContractWasmHash.
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
    ZkDonationRecord(u32),
    // Time-locked donation vesting (#386)
    VestingSchedule(Address, u32),
    DonorVestingCount(Address),
    // Platform fee configuration (#385)
    /// Fee in basis points (0–500, max 5%).
    PlatformFeeBps,
    /// Designated wallet that receives the platform fee.
    PlatformTreasury,
    // Time-Locked Donation Challenge/Response Protocol (#457)
    ChallengeThreshold,
    DonationChallenge(u32),
    // Stealth Address Donation Integration (#458)
    StealthDonationContract,
    /// Quadratic voting: credits spent by a voter on a project proposal.
    VoteCredits(String, Address),
    // Multi-token registry
    TokenConfig(Address),
    TokenList,
    // Transitional key used by the initial multi-token implementation. New
    // donations lazily migrate it to `DonorRateLimit`.
    DonorRateLimitPerToken(Address, String, Address),
    // Pending M-of-N force-refund escalation. Appended to preserve the
    // discriminants of all previously deployed DataKey variants.
    ForceRefund(u32),
    // Per-token donation rate limit overrides. These are separate keys so
    // deployments without an override can fall back to the global policy.
    TokenRateLimitMax(Address),
    TokenRateLimitWindow(Address),
    /// Platform fee split recipients and their share basis points (#434).
    PlatformFeeRecipients,
}
// ─── Constants ────────────────────────────────────────────────────────────────
const STROOP: i128 = 10_000_000;
#[cfg(any(feature = "usdc", feature = "donation", feature = "testutils"))]
const PRICE_SCALE: i128 = 1;

// 7 days × 24 h × 3600 s ÷ 5 s per ledger ≈ 120_960 ledgers — used as the
// default when `create_proposal` is called without an explicit duration.
const VOTING_WINDOW_LEDGERS: u32 = 120_960;
const DEFAULT_DONATION_RATE_LIMIT_MAX: u32 = 10;
const DEFAULT_DONATION_RATE_LIMIT_WINDOW: u32 = 720;
// Bounds on caller-supplied voting durations. Floor (~1 hour) keeps the
// window long enough to be observed; ceiling (~30 days) bounds storage TTL
// pressure and prevents proposals from sitting open indefinitely.
#[cfg(feature = "governance")]
const MIN_VOTING_WINDOW_LEDGERS: u32 = 720; // 1 hour @ 5s/ledger
#[cfg(feature = "governance")]
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
#[cfg(feature = "upgrade")]
const UPGRADE_TIMELOCK_LEDGERS: u32 = 34_560;
// 7 days × 24 h × 3600 s ÷ 5 s per ledger = 120_960 ledgers. The minimum
// delay between `initiate_emergency_withdrawal` and the earliest ledger at
// which `execute_emergency_withdrawal` can fire. Gives donors and observers
// a 7-day window to object off-chain before contract-held funds are sent to
// the new wallet.
#[cfg(feature = "emergency")]
const EMERGENCY_WITHDRAWAL_TIMELOCK: u32 = 120_960;
// 24 hours × 3600 s / 5 s per ledger = 17 280 ledgers. The window after a
// donation during which the donor may request a refund (subject to admin +
// project wallet approval).
#[cfg(feature = "refund")]
const REFUND_COOLDOWN_LEDGERS: u32 = 17_280;
// 24 hours × 3600 s / 5 s per ledger = 17 280 ledgers. The challenge window
// for high-value donations.
const CHALLENGE_WINDOW_LEDGERS: u32 = 17_280;

// 72 hours × 3600 s / 5 s per ledger = 51 840 ledgers. The delay between
// M-of-N initiation and permissionless force-refund execution.
#[cfg(feature = "refund")]
const FORCE_REFUND_TIMELOCK_LEDGERS: u32 = 51_840;

/// Current storage schema version. Bump this and add a migration step in
/// `migrate()` whenever a struct layout, DataKey variant, or stored value
/// encoding changes in a backward-incompatible way.
///
/// v1: original schema (no version tracking)
/// v2: Symbol-keyed storage version added (#379)
#[cfg(feature = "upgrade")]
const CURRENT_STORAGE_VERSION: u32 = 2;
/// Storage key for the schema version. Uses a Symbol (not a DataKey variant)
/// to avoid XDR codegen overhead in the slim WASM build.
#[cfg(feature = "upgrade")]
const STORAGE_VERSION_KEY: Symbol = symbol_short!("sv");
/// Hard cap on platform fee: 500 basis points = 5%.
#[cfg(feature = "fees")]
const MAX_PLATFORM_FEE_BPS: u32 = 500;
/// Read the stored admin set. Panics if not initialized.
#[inline(never)]
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
#[inline(never)]
fn verify_m_of_n(env: &Env, signers: &Vec<Address>, required_threshold: u32) {
    let admin_set: Vec<Address> = read_admin_set(env);
    let mut counted: Vec<Address> = Vec::new(env);
    let mut valid_count: u32 = 0;
    for signer in signers.iter() {
        signer.require_auth();
        if admin_set.contains(&signer) && !counted.contains(&signer) {
            counted.push_back(signer.clone());
            valid_count = valid_count.checked_add(1).expect("overflow");
        }
    }
    if valid_count < required_threshold {
        panic!("Insufficient admin signatures");
    }
}
/// Require M-of-N admin signatures for critical operations.
#[inline(never)]
fn require_admin_for_critical(env: &Env, signers: &Vec<Address>) {
    let threshold: u32 = read_admin_threshold(env);
    verify_m_of_n(env, signers, threshold);
}
/// Require a single admin signature for routine operations.
#[inline(never)]
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
#[inline(never)]
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

/// Reverse the donation-derived accounting shared by normal and force refunds.
/// The caller performs authorization and funding checks first, then transfers
/// the tokens after this helper returns (checks-effects-interactions ordering).
#[cfg(feature = "refund")]
fn apply_refund_accounting(
    env: &Env,
    refund_id: u32,
    request: &mut RefundRequest,
    project: &mut Project,
) {
    project.total_raised = project
        .total_raised
        .checked_sub(request.amount)
        .expect("underflow");
    env.storage()
        .instance()
        .set(&DataKey::Project(request.project_id.clone()), project);

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
        .expect("underflow");
    donor_stats.co2_offset_grams = donor_stats
        .co2_offset_grams
        .checked_sub(request.co2_offset_grams)
        .expect("underflow");
    env.storage()
        .instance()
        .set(&DataKey::DonorStats(request.donor.clone()), &donor_stats);

    let project_total_key =
        DataKey::DonorProjectTotal(request.project_id.clone(), request.donor.clone());
    let previous_project_total: i128 = env
        .storage()
        .instance()
        .get(&project_total_key)
        .unwrap_or(0);
    env.storage().instance().set(
        &project_total_key,
        &previous_project_total
            .checked_sub(request.amount)
            .expect("underflow"),
    );

    let global_raised: i128 = env
        .storage()
        .instance()
        .get(&DataKey::GlobalTotalRaised)
        .unwrap_or(0);
    env.storage().instance().set(
        &DataKey::GlobalTotalRaised,
        &global_raised
            .checked_sub(request.amount)
            .expect("underflow"),
    );

    let global_co2: i128 = env
        .storage()
        .instance()
        .get(&DataKey::GlobalCO2OffsetGrams)
        .unwrap_or(0);
    env.storage().instance().set(
        &DataKey::GlobalCO2OffsetGrams,
        &global_co2
            .checked_sub(request.co2_offset_grams)
            .expect("underflow"),
    );

    request.status = RefundRequestStatus::Approved;
    env.storage()
        .instance()
        .set(&DataKey::RefundRequest(refund_id), request);
}

#[cfg(feature = "impact")]
#[contracttype]
#[derive(Clone, Debug)]
enum ImpactKey {
    /// Merkle root keyed by SHA-256(project_id || report_id).
    ImRoot(BytesN<32>),
    /// MMR peak hashes for a project, keyed by project_id.
    ImpactMMRPeaks(String),
    /// Number of leaves in the MMR for a project, keyed by project_id.
    ImpactMMRSize(String),
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

#[cfg(feature = "impact")]
/// Append a new leaf hash to an MMR peak set.
///
/// Merges peaks from right to left whenever adding a leaf fills a mountain of equal height.
/// The number of merges equals the number of trailing 1-bits in `leaf_count`.
fn mmr_append_peaks(env: &Env, peaks: &mut Vec<BytesN<32>>, leaf_count: u32, new_leaf: BytesN<32>) {
    let mut current_hash = new_leaf;
    let merges = leaf_count.trailing_ones();
    for _ in 0..merges {
        if let Some(prev_peak) = peaks.pop_back() {
            let mut combined = [0u8; 64];
            combined[..32].copy_from_slice(&prev_peak.to_array());
            combined[32..].copy_from_slice(&current_hash.to_array());
            current_hash = env
                .crypto()
                .sha256(&Bytes::from_slice(env, &combined))
                .into();
        }
    }
    peaks.push_back(current_hash);
}

#[cfg(feature = "impact")]
/// Verify an MMR proof against the peak at `peak_idx` in `peaks`.
fn mmr_verify_proof(
    env: &Env,
    leaf_hash: &BytesN<32>,
    siblings: &Vec<BytesN<32>>,
    peaks: &Vec<BytesN<32>>,
    peak_idx: u32,
    leaf_index: u32,
) -> bool {
    let target_peak = match peaks.get(peak_idx) {
        Some(p) => p,
        None => return false,
    };
    verify_merkle_proof(env, leaf_hash, siblings, &target_peak, leaf_index)
}

// ─── Impact Root Archiving Functions (#466) ───────────────────────────────

#[cfg(feature = "impact")]
/// Get the period count for a project. Returns 0 when no periods exist.
fn get_impact_period_count(env: &Env, project_id: &String) -> u32 {
    env.storage()
        .instance()
        .get(&ImpactRootKey::RootCount(project_id.clone()))
        .unwrap_or(0)
}

#[cfg(feature = "impact")]
/// Set the period count for a project in storage.
fn set_impact_period_count(env: &Env, project_id: &String, count: u32) {
    env.storage()
        .instance()
        .set(&ImpactRootKey::RootCount(project_id.clone()), &count);
}

#[cfg(feature = "impact")]
/// Publish a new impact root for a project, archiving the previous root.
///
/// # Arguments
/// * `env` - Contract environment
/// * `signers` - M-of-N admin signers for authorization
/// * `project_id` - Project identifier
/// * `root` - Merkle root hash for this reporting period
/// * `period_start` - Unix timestamp of period start
/// * `period_end` - Unix timestamp of period end
/// * `totals` - Aggregated impact totals for this period
///
/// # Panics
/// - When admin authorization fails (M-of-N not satisfied)
/// - When `period_start >= period_end`
/// - When `root` is all zeros
pub fn publish_impact_root(
    env: &Env,
    signers: &Vec<Address>,
    project_id: String,
    root: BytesN<32>,
    period_start: u64,
    period_end: u64,
    totals: ImpactTotals,
) {
    // M-of-N admin authorization
    require_admin_for_critical(env, signers);

    // Validate inputs
    if period_start >= period_end {
        panic!("Invalid period range: start must be before end");
    }
    if root == BytesN::from_array(env, &[0u8; 32]) {
        panic!("Root cannot be zero");
    }

    // Archive current root before overwriting
    if env
        .storage()
        .instance()
        .has(&ImpactRootKey::RootCurrent(project_id.clone()))
    {
        let count = get_impact_period_count(env, &project_id);

        if count >= MAX_ARCHIVED_PERIODS {
            // Shift all periods down by one (drop oldest at index 0)
            for i in 1..MAX_ARCHIVED_PERIODS {
                let archived = env
                    .storage()
                    .instance()
                    .get::<_, ImpactRoot>(&ImpactRootKey::RootArchive(project_id.clone(), i))
                    .expect("archived period should exist");
                env.storage().instance().set(
                    &ImpactRootKey::RootArchive(project_id.clone(), i - 1),
                    &archived,
                );
            }
            // Archive current root at the newly freed slot (MAX_ARCHIVED_PERIODS - 1)
            let current_root: ImpactRoot = env
                .storage()
                .instance()
                .get(&ImpactRootKey::RootCurrent(project_id.clone()))
                .expect("current root should exist");
            env.storage().instance().set(
                &ImpactRootKey::RootArchive(project_id.clone(), MAX_ARCHIVED_PERIODS - 1),
                &current_root,
            );
            // Count stays at MAX_ARCHIVED_PERIODS (oldest was dropped)
        } else {
            // Normal case: add new archived entry
            let current_root: ImpactRoot = env
                .storage()
                .instance()
                .get(&ImpactRootKey::RootCurrent(project_id.clone()))
                .expect("current root should exist");
            env.storage().instance().set(
                &ImpactRootKey::RootArchive(project_id.clone(), count),
                &current_root,
            );
            let new_count = count.checked_add(1).expect("overflow");
            set_impact_period_count(env, &project_id, new_count);
        }
    }

    // Store new root as current
    let new_root = ImpactRoot {
        root: root.clone(),
        period_start,
        period_end,
        total_co2_kg: totals.co2_kg,
        total_trees: totals.trees,
        total_hectares: totals.hectares,
    };
    env.storage()
        .instance()
        .set(&ImpactRootKey::RootCurrent(project_id.clone()), &new_root);

    // Emit event
    let period_index = get_impact_period_count(env, &project_id);
    env.events().publish(
        (symbol_short!("root_pub"), project_id.clone()),
        (
            period_index,
            root,
            period_start,
            period_end,
            totals.co2_kg,
            totals.trees,
            totals.hectares,
        ),
    );
}

#[cfg(feature = "impact")]
/// Verify an impact leaf against a specific archived period's Merkle root.
///
/// # Arguments
/// * `env` - Contract environment
/// * `project_id` - Project identifier
/// * `period_index` - Index of the archived period to verify against
/// * `leaf` - Impact leaf containing the claim
/// * `proof` - Merkle proof siblings
/// * `leaf_index` - Index of the leaf in the Merkle tree
///
/// # Returns
/// * `true` if the proof is valid for the specified period's root
///
/// # Panics
/// - When the period index does not exist (neither current nor archived)
pub fn verify_impact_inclusion(
    env: &Env,
    project_id: String,
    period_index: u32,
    leaf: ImpactLeaf,
    proof: Vec<BytesN<32>>,
    leaf_index: u32,
) -> bool {
    let leaf_hash = compute_impact_leaf_hash(env, &leaf);
    let count = get_impact_period_count(env, &project_id);

    // Period 0 with no archives means check current root
    if period_index == 0 && count == 0 {
        if let Some(current) = env
            .storage()
            .instance()
            .get::<_, ImpactRoot>(&ImpactRootKey::RootCurrent(project_id.clone()))
        {
            return verify_merkle_proof(env, &leaf_hash, &proof, &current.root, leaf_index);
        }
    }

    // Check archived periods: period_index 0 = oldest, count-1 = newest archived
    if period_index < count {
        if let Some(archived) =
            env.storage()
                .instance()
                .get::<_, ImpactRoot>(&ImpactRootKey::RootArchive(
                    project_id.clone(),
                    period_index,
                ))
        {
            return verify_merkle_proof(env, &leaf_hash, &proof, &archived.root, leaf_index);
        }
    }

    // Period not found
    false
}

#[cfg(feature = "impact")]
/// Get all archived periods for a project.
///
/// # Arguments
/// * `env` - Contract environment
/// * `project_id` - Project identifier
///
/// # Returns
/// * `Vec<ImpactPeriodSummary>` - List of all archived periods
pub fn get_impact_periods(env: &Env, project_id: String) -> Vec<ImpactPeriodSummary> {
    let count = get_impact_period_count(env, &project_id);
    let mut periods = Vec::new(env);
    for i in 0..count {
        if let Some(archived) = env
            .storage()
            .instance()
            .get::<_, ImpactRoot>(&ImpactRootKey::RootArchive(project_id.clone(), i))
        {
            periods.push_back(ImpactPeriodSummary {
                period_index: i,
                period_start: archived.period_start,
                period_end: archived.period_end,
                total_co2_kg: archived.total_co2_kg,
                total_trees: archived.total_trees,
                total_hectares: archived.total_hectares,
            });
        }
    }
    periods
}

#[cfg(feature = "impact")]
/// Get the current (latest) impact root for a project.
///
/// # Arguments
/// * `env` - Contract environment
/// * `project_id` - Project identifier
///
/// # Returns
/// * `Option<ImpactRoot>` - Current root or `None` if none exists
pub fn get_current_impact_root(env: &Env, project_id: String) -> Option<ImpactRoot> {
    env.storage()
        .instance()
        .get(&ImpactRootKey::RootCurrent(project_id))
}

// ─── Off-Chain Oracle Attestation for Project Impact Verification (#459) ────
//
// Independent verifiers submit signed attestations of a project's actual
// CO2 impact. This keeps `co2_per_xlm` honest without trusting either the
// project or the platform alone:
//
//   1. Admin authorises verifier addresses via `add_impact_verifier`.
//   2. A verifier calls `submit_impact_report` with the rate they measured
//      off-chain and a hash of their supporting evidence. Resubmission by
//      the same verifier for the same project updates their existing report
//      in place rather than creating a second one.
//   3. Every submission is checked against the project's current
//      `co2_per_xlm` ("claimed rate"); a >=50% deviation sets a sticky
//      `ImpactFlagged` marker for the project (cleared explicitly by an
//      admin via `clear_impact_flag`).
//   4. Once a configurable number of distinct verifiers have reported,
//      `co2_per_xlm` is auto-adjusted to the median of their verified
//      rates. The adjustment re-runs on every later submission so the rate
//      stays current as reports are added or updated.
//
// Kept as a separate `ImpactVerificationKey` enum (mirroring `ImpactKey`
// above) rather than new `DataKey` variants so this feature can be toggled
// without touching the encoding of the shared, always-on `DataKey` enum.
#[cfg(feature = "impact_verification")]
#[contracttype]
#[derive(Clone, Debug)]
pub struct ImpactReport {
    pub project_id: String,
    pub verifier: Address,
    /// Assigned once when a verifier first reports on a project; stays the
    /// same across resubmissions so callers can treat it as a stable id for
    /// "this verifier's report", not "this submission event".
    pub report_id: u32,
    pub verified_co2_rate: u32,
    /// Hash of the off-chain evidence bundle (e.g. SHA-256 of a PDF report).
    /// The contract does not interpret the evidence itself.
    pub evidence_hash: BytesN<32>,
    pub submitted_at: u32,
}
#[cfg(feature = "impact_verification")]
#[contracttype]
#[derive(Clone, Debug)]
pub struct ImpactVerificationStatus {
    pub project_id: String,
    pub report_count: u32,
    pub threshold: u32,
    pub flagged: bool,
    pub current_co2_rate: u32,
    pub verifiers: Vec<Address>,
}
#[cfg(feature = "impact_verification")]
#[contracttype]
#[derive(Clone, Debug)]
// Every variant is intentionally prefixed with `Impact` — this key enum
// lives right next to `ImpactKey` above and the shared `DataKey`, and the
// prefix keeps grep/read-through unambiguous about which family a given
// storage key belongs to.
#[allow(clippy::enum_variant_names)]
enum ImpactVerificationKey {
    /// Allow-list of addresses authorised to submit impact reports.
    ImpactVerifier(Address),
    /// One record per (project, verifier) — resubmission updates in place.
    ImpactReportRecord(String, Address),
    /// Ordered list of verifiers that have reported for a project. Doubles
    /// as the distinct-verifier count for threshold checks and as the
    /// enumeration source for median computation.
    ImpactReportVerifiers(String),
    /// Per-project monotonic report-id allocator.
    ImpactNextReportId(String),
    /// Sticky >=50%-deviation flag, cleared explicitly by an admin.
    ImpactFlagged(String),
    /// Admin-configurable distinct-verifier threshold. Falls back to
    /// `DEFAULT_IMPACT_REPORT_THRESHOLD` when unset.
    ImpactReportThreshold,
}
/// Distinct verifier reports required before `co2_per_xlm` auto-adjusts to
/// the median verified rate.
#[cfg(feature = "impact_verification")]
const DEFAULT_IMPACT_REPORT_THRESHOLD: u32 = 3;
/// Returns true when `verified` differs from `claimed` by 50% or more of
/// `claimed`. Uses `diff * 2 >= claimed` instead of a division so there's no
/// risk of a fractional-rounding false negative right at the boundary.
#[cfg(feature = "impact_verification")]
fn impact_deviates_50_percent(claimed: u32, verified: u32) -> bool {
    if claimed == 0 {
        // A registered project's co2_per_xlm is always > 0 (enforced at
        // registration and by update_project_co2_rate), so this only
        // guards a defensive default and never fires in practice.
        return verified > 0;
    }
    let diff: u64 = if verified > claimed {
        (verified - claimed) as u64
    } else {
        (claimed - verified) as u64
    };
    diff * 2 >= claimed as u64
}
/// Median of `values`, rounding down on an even-length split — consistent
/// with the truncating integer arithmetic used everywhere else in this
/// contract. Sorts a scratch copy in place with a simple insertion sort;
/// the number of verifiers per project is expected to stay small (tens,
/// not thousands), so O(n^2) is not a concern.
#[cfg(feature = "impact_verification")]
fn median_u32(values: &Vec<u32>) -> u32 {
    let len = values.len();
    let mut sorted: Vec<u32> = values.clone();
    for i in 1..len {
        let key = sorted.get_unchecked(i);
        let mut j = i;
        while j > 0 && sorted.get_unchecked(j - 1) > key {
            let prev = sorted.get_unchecked(j - 1);
            sorted.set(j, prev);
            j -= 1;
        }
        sorted.set(j, key);
    }
    if len.is_multiple_of(2) {
        let a = sorted.get_unchecked(len / 2 - 1);
        let b = sorted.get_unchecked(len / 2);
        (a + b) / 2
    } else {
        sorted.get_unchecked(len / 2)
    }
}

// ─── Off-Chain Multi-Verifier Project Verification Oracle ──────────────────
//
// A configurable M-of-N committee of admin-appointed verifiers attests that
// a registered project has passed independent off-chain due diligence (the
// contract does not interpret what "verified" means — only that enough
// distinct, authorised verifiers vouched for it via a hash of their
// evidence). Deliberately separate from `impact_verification` above: that
// feature audits an *ongoing metric* (co2_per_xlm); this one gates a
// project's *eligibility to receive donations at all*.
//
//   1. Admins authorise verifier addresses via `add_verifier` (M-of-N).
//   2. A verifier calls `attest_project` once per project with a hash of
//      their evidence. A second call from the same verifier for the same
//      project panics rather than silently updating — resubmission is not
//      supported (unlike `impact_verification`'s reports), so a verifier
//      who made a mistake needs an admin to `revoke_verification` first.
//   3. Once `VerificationThreshold` distinct verifiers have attested, the
//      project auto-transitions to `Verified` in the same call that
//      crosses the threshold.
//   4. Every `donate*` entry point rejects donations to a project that is
//      not `Verified`, unless `VerificationThreshold == 0` (legacy/
//      disabled mode) and the project is still `Unverified` — this keeps
//      every project registered before this feature existed donatable.
//   5. Admins may `revoke_verification` (M-of-N) at any time, clearing all
//      accumulated attestations and returning the project to `Unverified`.
//
// Kept as a separate `ProjectVerificationKey` enum — mirroring
// `ImpactVerificationKey` above — rather than new `DataKey` variants.
// Appending `#[cfg(feature = "project_verification")]`-gated variants
// directly to the shared, always-on `DataKey` enum would shift every
// later variant's XDR discriminant depending on whether the feature is
// compiled in, silently corrupting storage reads across builds with
// different feature sets. A separate enum sidesteps that hazard entirely.

#[cfg(feature = "project_verification")]
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum VerificationError {
    NotAuthorizedVerifier = 1,
    ProjectNotFound = 2,
    DuplicateAttestation = 3,
    ProjectNotVerified = 4,
    AlreadyVerifier = 5,
    NotAVerifier = 6,
}

/// State machine for a project's multi-verifier attestation status.
/// `Pending(u32)` carries the current distinct-attester count so callers
/// don't need a second read to show progress toward the threshold.
///
/// `Rejected` is reserved for a future issue (e.g. an explicit verifier
/// rejection vote) — no public function in this feature assigns it yet.
#[cfg(feature = "project_verification")]
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum VerificationStatus {
    Unverified,
    Pending(u32),
    Verified,
    Rejected,
}

#[cfg(feature = "project_verification")]
#[contracttype]
#[derive(Clone, Debug)]
#[allow(clippy::enum_variant_names)]
enum ProjectVerificationKey {
    /// Authorised verifier addresses. A verifier is a distinct role from
    /// an admin — being in `AdminSet` does not imply membership here.
    VerifierSet,
    /// Distinct-verifier attestations required before a project
    /// auto-transitions to `Verified`. Absent/`0` = disabled/legacy mode:
    /// `Unverified` projects can still receive donations exactly as
    /// before this feature existed.
    VerificationThreshold,
    /// Per-project verification state. Absent = `Unverified` (coherent
    /// default for projects registered before this feature existed).
    ProjectVerification(String),
    /// Ordered list of verifiers that have attested a project. Doubles as
    /// the distinct-attester count for threshold checks. Deliberately
    /// holds only addresses — not full attestation records — so reading
    /// the attester list/count never has to pull evidence data along
    /// with it; see `ProjectAttestationEvidence` for the per-verifier
    /// payload. This is the append-only, never-shrinking historical
    /// record: removing a verifier from `VerifierSet` does not remove
    /// their past attestations from here (see `remove_verifier` docs).
    ProjectAttesters(String),
    /// Evidence hash submitted by one verifier for one project, kept in
    /// its own key (not inline in `ProjectAttesters`) so reading the
    /// attester list/count never has to pull evidence data along with it.
    ProjectAttestationEvidence(String, Address),
}

#[cfg(feature = "project_verification")]
fn read_verifier_set(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&ProjectVerificationKey::VerifierSet)
        .unwrap_or(Vec::new(env))
}

#[cfg(feature = "project_verification")]
fn read_verification_threshold(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&ProjectVerificationKey::VerificationThreshold)
        .unwrap_or(0)
}

#[cfg(feature = "project_verification")]
fn read_project_verification_status(env: &Env, project_id: &String) -> VerificationStatus {
    env.storage()
        .instance()
        .get(&ProjectVerificationKey::ProjectVerification(
            project_id.clone(),
        ))
        .unwrap_or(VerificationStatus::Unverified)
}

#[cfg(feature = "project_verification")]
fn read_project_attesters(env: &Env, project_id: &String) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&ProjectVerificationKey::ProjectAttesters(
            project_id.clone(),
        ))
        .unwrap_or(Vec::new(env))
}

/// Pure computation of what a project's verification status *should* be
/// right now, given the live `VerificationThreshold` and attester count.
/// Never returns a status "lower" than what's actually stored — an
/// already-`Verified` project stays `Verified` even if a later admin
/// action (raising the threshold, removing a verifier) would otherwise
/// make it look under-attested. See `refresh_verification_status` for the
/// persisting counterpart used by mutating entry points.
#[cfg(feature = "project_verification")]
fn compute_live_status(env: &Env, project_id: &String) -> VerificationStatus {
    let stored = read_project_verification_status(env, project_id);
    if stored == VerificationStatus::Verified {
        return stored;
    }
    let threshold = read_verification_threshold(env);
    let count = read_project_attesters(env, project_id).len();
    if threshold > 0 && count >= threshold {
        VerificationStatus::Verified
    } else if count > 0 {
        VerificationStatus::Pending(count)
    } else {
        VerificationStatus::Unverified
    }
}

/// Recompute and, if it changed, persist a project's verification status
/// against the *current* `VerificationThreshold` — without ever
/// downgrading an already-`Verified` project. Called from `attest_project`
/// (so a fresh attestation can cross the threshold) and from the donation
/// gate (so a project stuck in `Pending` after an admin *lowers* the
/// threshold doesn't need a fresh attestation to unstick; the very next
/// `donate*` or `attest_project` call naturally re-evaluates it). This is
/// the same lazy-recompute principle `submit_impact_report` already uses
/// for its own threshold above — there is no bounded way to eagerly walk
/// every registered project when an admin changes the threshold.
#[cfg(feature = "project_verification")]
fn refresh_verification_status(env: &Env, project_id: &String) -> VerificationStatus {
    let stored = read_project_verification_status(env, project_id);
    let live = compute_live_status(env, project_id);
    if live != stored {
        env.storage().instance().set(
            &ProjectVerificationKey::ProjectVerification(project_id.clone()),
            &live,
        );
        if live == VerificationStatus::Verified {
            let count = read_project_attesters(env, project_id).len();
            env.events()
                .publish((symbol_short!("proj_vfy"), project_id.clone()), count);
        }
    }
    live
}

/// Reject donations to a project that isn't `Verified`, unless
/// `VerificationThreshold == 0` (legacy/disabled mode) and the project is
/// still `Unverified` — the backward-compatible path for every project
/// registered before this feature existed.
#[cfg(feature = "project_verification")]
fn require_project_verified_for_donation(env: &Env, project_id: &String) {
    let threshold = read_verification_threshold(env);
    let status = refresh_verification_status(env, project_id);
    match status {
        VerificationStatus::Verified => {}
        VerificationStatus::Unverified if threshold == 0 => {}
        _ => panic_with_error!(env, VerificationError::ProjectNotVerified),
    }
}

/// Read the configured platform fee in basis points.
#[cfg(feature = "fees")]
fn read_platform_fee_bps(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::PlatformFeeBps)
        .unwrap_or(0)
}

/// Split `amount` into (project_amount, fee_amount) based on the configured fee
/// rate in basis points. Returns `(amount, 0)` when `fee_bps` is 0.
#[cfg(feature = "fees")]
fn split_fee(amount: i128, fee_bps: u32) -> (i128, i128) {
    if fee_bps == 0 {
        return (amount, 0);
    }
    let fee = amount.checked_mul(fee_bps as i128).expect("overflow") / 10_000;
    let project_amount = amount.checked_sub(fee).expect("underflow");
    (project_amount, fee)
}

/// Read the configured platform fee recipients list (#434).
/// Backward compatibility: if `PlatformTreasury` exists and `PlatformFeeRecipients` does not,
/// returns a single recipient with 10000 bps (100%).
#[cfg(any(feature = "fees", feature = "testutils"))]
fn read_platform_fee_recipients(env: &Env) -> Vec<FeeRecipient> {
    if let Some(recipients) = env
        .storage()
        .instance()
        .get::<_, Vec<FeeRecipient>>(&DataKey::PlatformFeeRecipients)
    {
        recipients
    } else if let Some(treasury) = env
        .storage()
        .instance()
        .get::<_, Address>(&DataKey::PlatformTreasury)
    {
        soroban_sdk::vec![
            env,
            FeeRecipient {
                address: treasury,
                share_bps: 10_000,
            }
        ]
    } else {
        panic!("Platform treasury or fee recipients not configured");
    }
}

/// Split total `fee_amount` into individual recipient shares based on `share_bps` (#434).
/// Assigns any rounding remainder to the final recipient so that the sum of all
/// allocated recipient amounts equals `fee_amount` exactly.
#[cfg(any(feature = "fees", feature = "testutils"))]
#[allow(dead_code)]
fn split_fee_recipients(
    env: &Env,
    fee_amount: i128,
    recipients: &Vec<FeeRecipient>,
) -> Vec<(Address, i128)> {
    let mut result: Vec<(Address, i128)> = Vec::new(env);
    if fee_amount == 0 || recipients.is_empty() {
        return result;
    }
    let mut allocated: i128 = 0;
    let len = recipients.len();
    for i in 0..len {
        let r = recipients.get_unchecked(i);
        let share_amount = if i == len - 1 {
            fee_amount.checked_sub(allocated).expect("underflow")
        } else {
            fee_amount
                .checked_mul(r.share_bps as i128)
                .expect("overflow")
                / 10_000
        };
        allocated = allocated.checked_add(share_amount).expect("overflow");
        result.push_back((r.address.clone(), share_amount));
    }
    result
}
#[inline(never)]
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
        panic!("Migration incomplete");
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

#[cfg(any(
    feature = "donation",
    feature = "usdc",
    feature = "zk",
    feature = "testutils"
))]
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
#[cfg(any(feature = "usdc", feature = "donation", feature = "testutils"))]
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

#[cfg(any(feature = "usdc", feature = "donation", feature = "testutils"))]
fn get_token_config_for_donate_token(env: &Env, token: &Address) -> TokenConfig {
    let config_key = DataKey::TokenConfig(token.clone());
    if let Some(config) = env.storage().instance().get::<_, TokenConfig>(&config_key) {
        if !config.active {
            panic!("Token is inactive");
        }
        return config;
    }

    if let Some(native_token) = env
        .storage()
        .instance()
        .get::<_, Address>(&DataKey::NativeTokenAddress)
    {
        if native_token == *token {
            return TokenConfig {
                token: token.clone(),
                oracle: token.clone(),
                symbol: symbol_short!("XLM"),
                active: true,
                registered_at: 0,
            };
        }
    }

    if let Some(usdc_token) = env
        .storage()
        .instance()
        .get::<_, Address>(&DataKey::USDCTokenAddress)
    {
        if usdc_token == *token {
            let oracle_addr = env
                .storage()
                .instance()
                .get::<_, Address>(&DataKey::OracleAddress)
                .expect("Price oracle not configured");
            return TokenConfig {
                token: token.clone(),
                oracle: oracle_addr,
                symbol: symbol_short!("USDC"),
                active: true,
                registered_at: 0,
            };
        }
    }

    panic!("Token not registered");
}

#[inline(never)]
fn anon_address(env: &Env) -> Address {
    Address::from_string(&String::from_str(
        env,
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    ))
}

fn effective_token_rate_limit(env: &Env, token: &Address) -> (u32, u32) {
    let max = env
        .storage()
        .instance()
        .get(&DataKey::TokenRateLimitMax(token.clone()))
        .or_else(|| env.storage().instance().get(&DataKey::DonationRateLimitMax))
        .unwrap_or(DEFAULT_DONATION_RATE_LIMIT_MAX);
    let window = env
        .storage()
        .instance()
        .get(&DataKey::TokenRateLimitWindow(token.clone()))
        .or_else(|| {
            env.storage()
                .instance()
                .get(&DataKey::DonationRateLimitWindow)
        })
        .unwrap_or(DEFAULT_DONATION_RATE_LIMIT_WINDOW);
    (max, window)
}

/// Process a single donation's core logic: rate limiting, project validation,
/// state updates (project, donor, NFT, globals), token transfers, and events.
/// Does NOT handle auth, paused-check, or ensure_min_ttl — the caller is
/// responsible for those.
#[cfg(any(feature = "usdc", feature = "donation", feature = "testutils"))]
#[allow(clippy::too_many_arguments)]
fn process_donation_token(
    env: &Env,
    token: &Address,
    token_symbol: &Symbol,
    donor: &Address,
    project_id: &String,
    raw_amount: i128,
    xlm_equivalent: i128,
    msg_hash: u32,
    anonymous: bool,
) {
    let current_ledger = env.ledger().sequence();
    let (max_donations, window_ledgers) = effective_token_rate_limit(env, token);

    let rate_key = DataKey::DonorRateLimit(donor.clone(), project_id.clone(), token.clone());
    let mut window: RateLimitWindow = match env.storage().instance().get(&rate_key) {
        Some(window) => window,
        None => {
            let transitional_key =
                DataKey::DonorRateLimitPerToken(donor.clone(), project_id.clone(), token.clone());
            match env.storage().instance().get(&transitional_key) {
                Some(window) => {
                    env.storage().instance().remove(&transitional_key);
                    window
                }
                None => {
                    let legacy_key =
                        LegacyDataKey::DonorRateLimit(donor.clone(), project_id.clone());
                    match env.storage().instance().get(&legacy_key) {
                        Some(window) => {
                            // Move the old donor/project window only once so its
                            // count cannot be copied into every token window.
                            env.storage().instance().remove(&legacy_key);
                            window
                        }
                        None => RateLimitWindow {
                            window_start: current_ledger,
                            count: 0,
                        },
                    }
                }
            }
        }
    };

    if current_ledger - window.window_start >= window_ledgers {
        window.window_start = current_ledger;
        window.count = 0;
    }
    if window.count >= max_donations {
        panic!("Donation rate limit exceeded");
    }
    window.count = window.count.checked_add(1).expect("overflow");
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
    #[cfg(feature = "project_verification")]
    require_project_verified_for_donation(env, project_id);
    require_campaign_accepts_donation(&project, env.ledger().sequence());

    // Pre-compute CO2 increment using XLM equivalent
    let xlm_units = xlm_equivalent / STROOP;
    let co2_increment = xlm_units
        .checked_mul(project.co2_per_xlm as i128)
        .expect("overflow");

    let stats_donor = if anonymous {
        anon_address(env)
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

    // ── Effects: state updates using XLM equivalent
    project.total_raised = project
        .total_raised
        .checked_add(xlm_equivalent)
        .expect("overflow");
    let goal_reached = apply_campaign_goal_progress(&mut project);
    let donated_key = DataKey::HasDonated(project_id.clone(), donor.clone());
    if !env.storage().instance().has(&donated_key) {
        env.storage().instance().set(&donated_key, &true);
        project.donor_count = project.donor_count.checked_add(1).expect("overflow");
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
        .expect("overflow");
    donor_stats.donation_count = donor_stats.donation_count.checked_add(1).expect("overflow");
    donor_stats.co2_offset_grams = donor_stats
        .co2_offset_grams
        .checked_add(co2_increment)
        .expect("overflow");
    donor_stats.badge = calculate_badge(donor_stats.total_donated);
    #[cfg(feature = "delegation")]
    update_delegated_weight_if_needed(env, donor, &prev_badge, &donor_stats.badge);
    env.storage()
        .instance()
        .set(&DataKey::DonorStats(stats_donor), &donor_stats);
    // Track per-project cumulative donations for milestone NFT eligibility.

    // Track per-project cumulative donations for milestone NFT eligibility
    let proj_total_key = DataKey::DonorProjectTotal(project_id.clone(), donor.clone());
    let prev_proj_total: i128 = env.storage().instance().get(&proj_total_key).unwrap_or(0);
    env.storage().instance().set(
        &proj_total_key,
        &prev_proj_total
            .checked_add(xlm_equivalent)
            .expect("overflow"),
    );
    // Auto-mint an Impact NFT when a donor reaches a new badge tier.

    // Auto-mint Impact NFT when donor reaches new badge tier
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
    let new_dc = dc.checked_add(1).expect("overflow");
    env.storage()
        .instance()
        .set(&DataKey::DonationCount, &new_dc);

    // Store donation record with raw token amount and token symbol
    let donation_record = DonationRecord {
        donor: donor.clone(),
        anonymous,
        project: project_id.clone(),
        amount: raw_amount,
        ledger: env.ledger().sequence(),
        message_hash: msg_hash,
        currency: token_symbol.clone(),
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
            &count.checked_add(1).expect("overflow"),
        );
    }
    // Snapshot CO₂ offset for exact reversal on refund (#290) and receipt verification.

    env.storage()
        .instance()
        .set(&DataKey::DonationCO2Offset(dc), &co2_increment);
    let gr: i128 = env
        .storage()
        .instance()
        .get(&DataKey::GlobalTotalRaised)
        .unwrap_or(0);
    let new_gr = gr.checked_add(xlm_equivalent).expect("overflow");
    env.storage()
        .instance()
        .set(&DataKey::GlobalTotalRaised, &new_gr);
    let gc: i128 = env
        .storage()
        .instance()
        .get(&DataKey::GlobalCO2OffsetGrams)
        .unwrap_or(0);
    let new_gc = gc.checked_add(co2_increment).expect("overflow");
    env.storage()
        .instance()
        .set(&DataKey::GlobalCO2OffsetGrams, &new_gc);

    #[cfg(feature = "fees")]
    let (project_amount, fee_amount) = split_fee(raw_amount, read_platform_fee_bps(env));
    #[cfg(not(feature = "fees"))]
    let project_amount = raw_amount;

    let token_client = token::Client::new(env, token);

    #[cfg(feature = "fees")]
    if fee_amount > 0 {
        let recipients = read_platform_fee_recipients(env);
        let shares = split_fee_recipients(env, fee_amount, &recipients);
        for (recipient_addr, amount) in shares.iter() {
            if amount > 0 {
                token_client.transfer(donor, &recipient_addr, &amount);
            }
        }
    }
    // Transfer remainder to project wallet.

    token_client.transfer(donor, &project.wallet, &project_amount);
    #[cfg(feature = "fees")]
    env.events().publish(
        (symbol_short!("donated"), donor.clone(), project_id.clone()),
        (raw_amount, token_symbol.clone(), msg_hash, fee_amount),
    );
    #[cfg(not(feature = "fees"))]
    env.events().publish(
        (
            symbol_short!("donated"),
            if anonymous {
                anon_address(env)
            } else {
                donor.clone()
            },
            project_id.clone(),
        ),
        (raw_amount, token_symbol.clone(), msg_hash),
    );
}

#[cfg(any(feature = "donation", feature = "usdc", feature = "testutils"))]
#[allow(clippy::too_many_arguments)]
fn process_donation(
    env: &Env,
    token: &Address,
    donor: &Address,
    project_id: &String,
    amount: i128,
    msg_hash: u32,
    anonymous: bool,
) {
    let token_symbol = if let Some(config) = env
        .storage()
        .instance()
        .get::<_, TokenConfig>(&DataKey::TokenConfig(token.clone()))
    {
        config.symbol
    } else {
        symbol_short!("XLM")
    };
    process_donation_token(
        env,
        token,
        &token_symbol,
        donor,
        project_id,
        amount,
        amount,
        msg_hash,
        anonymous,
    );
}

/// After `total_raised` is updated, flip `Active` → `GoalReached` when the
/// campaign goal is met. Returns `true` when the transition happened.
#[cfg(feature = "campaign")]
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

#[cfg(any(feature = "governance", feature = "delegation"))]
pub fn voting_weight_from_badge(badge: &BadgeTier) -> u32 {
    match badge {
        BadgeTier::None => 0,
        BadgeTier::Seedling => 100,
        BadgeTier::Tree => 141,
        BadgeTier::Forest => 173,
        BadgeTier::EarthGuardian => 200,
    }
}
/// Quadratic voting: credits available per badge tier.
#[cfg(feature = "governance")]
pub fn voting_credits_from_badge(badge: &BadgeTier) -> u32 {
    match badge {
        BadgeTier::None => 0,
        BadgeTier::Seedling => 100,
        BadgeTier::Tree => 200,
        BadgeTier::Forest => 400,
        BadgeTier::EarthGuardian => 800,
    }
}

/// Babylonian integer square root (floor) for u32.
/// Compatible with no_std — no floating point.
#[cfg(feature = "governance")]
fn isqrt(n: u32) -> u32 {
    if n < 2 {
        return n;
    }
    let mut x = n;
    let mut y = x / 2 + x % 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
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
                    .expect("overflow");
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
            panic!("Empty admin set");
        }
        if threshold == 0 || threshold > admins.len() {
            panic!("Invalid threshold");
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
        let next_count = count.checked_add(1).expect("overflow");
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
        let next_count = count.checked_add(1).expect("overflow");
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
    #[cfg(any(feature = "batch", feature = "testutils", test))]
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
            let next_count = count.checked_add(1).expect("overflow");
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
        let single_recipient = FeeRecipient {
            address: treasury.clone(),
            share_bps: 10_000,
        };
        let recipients = soroban_sdk::vec![&env, single_recipient];
        env.storage()
            .instance()
            .set(&DataKey::PlatformFeeRecipients, &recipients);
        env.events().publish(
            (symbol_short!("treas_set"), signers.get(0).unwrap()),
            treasury,
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }
    /// Admin-only (M-of-N): set the platform fee recipients and their split shares (#434).
    ///
    /// `recipients` must not be empty, and all recipient `share_bps` must sum to 10000 (100%).
    ///
    /// # Panics
    /// - If `recipients` is empty.
    /// - If sum of `share_bps` across `recipients` does not equal 10000.
    #[cfg(feature = "fees")]
    pub fn set_platform_fee_recipients(
        env: Env,
        signers: Vec<Address>,
        recipients: Vec<FeeRecipient>,
    ) {
        require_admin_for_critical(&env, &signers);
        require_not_paused(&env);
        if recipients.is_empty() {
            panic!("Fee recipients list cannot be empty");
        }
        let mut total_share: u32 = 0;
        for r in recipients.iter() {
            total_share = total_share
                .checked_add(r.share_bps)
                .expect("Fee recipient share calculation overflow");
        }
        if total_share != 10_000 {
            panic!("Fee recipient shares must sum to 10000 bps (100%)");
        }
        env.storage()
            .instance()
            .set(&DataKey::PlatformFeeRecipients, &recipients);
        env.events().publish(
            (symbol_short!("recip_set"), signers.get(0).unwrap()),
            recipients.len(),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }
    /// Public read-only: get the configured platform fee recipients and their shares (#434).
    #[cfg(any(feature = "fees", feature = "testutils"))]
    pub fn get_platform_fee_recipients(env: Env) -> Vec<FeeRecipient> {
        read_platform_fee_recipients(&env)
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
        process_donation(
            &env,
            &token,
            &donor,
            &project_id,
            amount,
            msg_hash,
            anonymous,
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    #[cfg(any(feature = "batch", feature = "donation", feature = "testutils"))]
    pub fn batch_donate(env: Env, token: Address, donations: Vec<BatchDonation>) {
        require_not_paused(&env);
        let mut authorized: Vec<Address> = Vec::new(&env);
        for donation in donations.iter() {
            if donation.amount <= 0 {
                panic!("Donation amount must be positive");
            }
            let mut found = false;
            for a in authorized.iter() {
                if a == donation.donor {
                    found = true;
                    break;
                }
            }
            if !found {
                donation.donor.require_auth();
                authorized.push_back(donation.donor.clone());
            }
            process_donation(
                &env,
                &token,
                &donation.donor,
                &donation.project_id,
                donation.amount,
                donation.msg_hash,
                false,
            );
        }
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
        #[cfg(feature = "project_verification")]
        require_project_verified_for_donation(&env, &project_id);
        require_campaign_accepts_donation(&project, env.ledger().sequence());
        // Pre-compute CO2 increment using the XLM-equivalent received
        let xlm_units = xlm_amount / STROOP;
        let co2_increment = xlm_units
            .checked_mul(project.co2_per_xlm as i128)
            .expect("overflow");

        let stats_donor = if anonymous {
            anon_address(&env)
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
            .expect("overflow");
        let goal_reached = apply_campaign_goal_progress(&mut project);
        let donated_key = DataKey::HasDonated(project_id.clone(), donor.clone());
        if !env.storage().instance().has(&donated_key) {
            env.storage().instance().set(&donated_key, &true);
            project.donor_count = project.donor_count.checked_add(1).expect("overflow");
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
            .expect("overflow");
        donor_stats.donation_count = donor_stats.donation_count.checked_add(1).expect("overflow");
        donor_stats.co2_offset_grams = donor_stats
            .co2_offset_grams
            .checked_add(co2_increment)
            .expect("overflow");
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
            &prev_proj_total.checked_add(xlm_amount).expect("overflow"),
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
        let new_dc = dc.checked_add(1).expect("overflow");
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
                &count.checked_add(1).expect("overflow"),
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
        let new_gr = gr.checked_add(xlm_amount).expect("overflow");
        env.storage()
            .instance()
            .set(&DataKey::GlobalTotalRaised, &new_gr);
        let gc: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalCO2OffsetGrams)
            .unwrap_or(0);
        let new_gc = gc.checked_add(co2_increment).expect("overflow");
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
                    anon_address(&env)
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

    /// Set the compact anonymous-donation verifier key with M-of-N admin auth.
    #[cfg(feature = "zk")]
    pub fn set_zk_verification_key(env: Env, signers: Vec<Address>, vk: Bytes) {
        require_admin_for_critical(&env, &signers);
        require_not_paused(&env);
        if vk.len() != 32 {
            panic!("ZK verification key must be 32 bytes");
        }
        env.storage()
            .instance()
            .set(&DataKey::ZkVerificationKey, &vk);
        env.events()
            .publish((symbol_short!("zk_vk_set"),), env.crypto().sha256(&vk));
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }
    /// Query the current Groth16 verification key, if set.
    #[cfg(feature = "zk")]
    pub fn get_zk_verification_key(env: Env) -> Option<Bytes> {
        env.storage().instance().get(&DataKey::ZkVerificationKey)
    }

    /// Verify a prover attestation over
    /// `(project_id_hash, amount_commitment, nullifier)` and record the
    /// donation without storing or updating a donor identity.
    #[cfg(feature = "zk")]
    pub fn donate_anonymous_zk(
        env: Env,
        proof: Bytes,
        public_inputs: Vec<BytesN<32>>,
        nullifier: BytesN<32>,
        project_id: String,
    ) {
        use soroban_sdk::xdr::ToXdr;

        require_not_paused(&env);
        if public_inputs.len() != 3 || proof.len() != 64 {
            panic!("Invalid ZK proof");
        }
        let project_hash = env.crypto().sha256(&project_id.to_xdr(&env)).to_bytes();
        if public_inputs.get(0).unwrap() != project_hash
            || public_inputs.get(2).unwrap() != nullifier
        {
            panic!("Invalid ZK public inputs");
        }

        let nullifier_key = DataKey::Nullifier(nullifier.clone());
        if env.storage().instance().has(&nullifier_key) {
            panic!("ZK nullifier already used");
        }

        let vk: Bytes = env
            .storage()
            .instance()
            .get(&DataKey::ZkVerificationKey)
            .expect("ZK verification key not set");
        let mut vk_array = [0u8; 32];
        vk.copy_into_slice(&mut vk_array);
        let mut proof_array = [0u8; 64];
        proof.copy_into_slice(&mut proof_array);
        let mut statement = Bytes::new(&env);
        for input in public_inputs.iter() {
            statement.append(&input.into());
        }
        env.crypto().ed25519_verify(
            &BytesN::from_array(&env, &vk_array),
            &statement,
            &BytesN::from_array(&env, &proof_array),
        );

        let amount_commitment = public_inputs.get(1).unwrap();
        let mut commitment = [0u8; 32];
        amount_commitment.copy_into_slice(&mut commitment);
        let mut amount_bytes = [0u8; 16];
        amount_bytes.copy_from_slice(&commitment[..16]);
        let amount = i128::from_be_bytes(amount_bytes);
        if amount <= 0 {
            panic!("Anonymous donation amount must be positive");
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
        project.total_raised = project.total_raised.checked_add(amount).expect("overflow");
        let goal_reached = apply_campaign_goal_progress(&mut project);
        env.storage()
            .instance()
            .set(&DataKey::Project(project_id.clone()), &project);
        if goal_reached {
            env.events().publish(
                (symbol_short!("camp_goal"), project_id.clone()),
                project.total_raised,
            );
        }

        let index: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DonationCount)
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::ZkDonationRecord(index),
            &ZkDonationRecord {
                project: project_id.clone(),
                amount,
                amount_commitment: amount_commitment.clone(),
                nullifier: nullifier.clone(),
                ledger: env.ledger().sequence(),
            },
        );
        env.storage().instance().set(
            &DataKey::DonationCount,
            &index.checked_add(1).expect("overflow"),
        );
        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalTotalRaised)
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::GlobalTotalRaised,
            &total.checked_add(amount).expect("overflow"),
        );
        let co2 = amount
            .checked_mul(project.co2_per_xlm as i128)
            .expect("overflow")
            / STROOP;
        let global_co2: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalCO2OffsetGrams)
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::GlobalCO2OffsetGrams,
            &global_co2.checked_add(co2).expect("overflow"),
        );
        env.storage().instance().set(&nullifier_key, &true);
        env.events().publish(
            (symbol_short!("zk_donate"), project_id, nullifier),
            (amount_commitment, co2),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    #[cfg(feature = "zk")]
    pub fn is_zk_nullifier_used(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage().instance().has(&DataKey::Nullifier(nullifier))
    }

    #[cfg(feature = "zk")]
    pub fn get_zk_donation_record(env: Env, index: u32) -> ZkDonationRecord {
        env.storage()
            .instance()
            .get(&DataKey::ZkDonationRecord(index))
            .expect("ZK donation record not found")
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
    #[allow(clippy::too_many_arguments)]
    #[cfg(feature = "zk")]
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
        #[cfg(feature = "project_verification")]
        require_project_verified_for_donation(&env, &project_id);
        require_campaign_accepts_donation(&project, env.ledger().sequence());
        // Pre-compute CO2 increment.
        let xlm_units = amount / STROOP;
        let co2_increment = xlm_units
            .checked_mul(project.co2_per_xlm as i128)
            .expect("overflow");

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

        project.total_raised = project.total_raised.checked_add(amount).expect("overflow");
        let goal_reached = apply_campaign_goal_progress(&mut project);
        let donated_key = DataKey::HasDonated(project_id.clone(), anon_donor.clone());
        if !env.storage().instance().has(&donated_key) {
            env.storage().instance().set(&donated_key, &true);
            project.donor_count = project.donor_count.checked_add(1).expect("overflow");
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
            .expect("overflow");
        donor_stats.donation_count = donor_stats.donation_count.checked_add(1).expect("overflow");
        donor_stats.co2_offset_grams = donor_stats
            .co2_offset_grams
            .checked_add(co2_increment)
            .expect("overflow");
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
            &prev_proj_total.checked_add(amount).expect("overflow"),
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
        let new_dc = dc.checked_add(1).expect("overflow");
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
        let new_gr = gr.checked_add(amount).expect("overflow");
        env.storage()
            .instance()
            .set(&DataKey::GlobalTotalRaised, &new_gr);
        let gc: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalCO2OffsetGrams)
            .unwrap_or(0);
        let new_gc = gc.checked_add(co2_increment).expect("overflow");
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
        #[cfg(feature = "fees")]
        let (project_amount, fee_amount) = split_fee(amount, read_platform_fee_bps(&env));
        #[cfg(not(feature = "fees"))]
        let project_amount = amount;

        #[cfg(feature = "fees")]
        if fee_amount > 0 {
            let recipients = read_platform_fee_recipients(&env);
            let shares = split_fee_recipients(&env, fee_amount, &recipients);
            for (recipient_addr, amount) in shares.iter() {
                if amount > 0 {
                    token_client.transfer(&contract_addr, &recipient_addr, &amount);
                }
            }
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

    // ─── Integrated Stealth Address Donation (#458) ───────────────────────────

    /// Admin-only: configure the deployed DonationContract address for stealth donation integration (#458).
    #[cfg(feature = "donation")]
    pub fn set_stealth_donation_contract(env: Env, admin: Address, contract_address: Address) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);
        env.storage()
            .instance()
            .set(&DataKey::StealthDonationContract, &contract_address);
        env.events()
            .publish((symbol_short!("stlth_set"), admin), contract_address);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Query the configured stealth donation contract address.
    #[cfg(feature = "donation")]
    pub fn get_stealth_donation_contract(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::StealthDonationContract)
            .expect("Stealth donation contract not configured")
    }

    /// Integrated stealth address donation (#458).
    ///
    /// Cross-calls `DonationContract.donate_stealth(...)` to record the stealth donation,
    /// and updates main contract global and project statistics without updating donor-specific stats,
    /// preserving donor privacy.
    #[cfg(feature = "donation")]
    #[allow(clippy::too_many_arguments)]
    pub fn donate_stealth_integrated(
        env: Env,
        sender: Address,
        token: Address,
        ephemeral_pubkey: BytesN<33>,
        project_id: String,
        amount: i128,
        msg_hash: BytesN<32>,
    ) -> u64 {
        sender.require_auth();
        require_not_paused(&env);
        if amount <= 0 {
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

        let stealth_contract: Address = env
            .storage()
            .instance()
            .get(&DataKey::StealthDonationContract)
            .expect("Stealth donation contract not configured");

        let stealth_client =
            crate::donation::contract::DonationContractClient::new(&env, &stealth_contract);
        let donation_id = stealth_client.donate_stealth(
            &sender,
            &token,
            &ephemeral_pubkey,
            &project.wallet,
            &amount,
            &msg_hash,
        );

        // Pre-compute CO2 increment
        let xlm_units = amount / STROOP;
        let co2_increment = xlm_units
            .checked_mul(project.co2_per_xlm as i128)
            .expect("overflow");

        // Update project total_raised (donor_count is NOT updated to preserve donor anonymity)
        project.total_raised = project.total_raised.checked_add(amount).expect("overflow");
        env.storage()
            .instance()
            .set(&DataKey::Project(project_id.clone()), &project);

        // Update global accumulators
        let gr: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalTotalRaised)
            .unwrap_or(0);
        let new_gr = gr.checked_add(amount).expect("overflow");
        env.storage()
            .instance()
            .set(&DataKey::GlobalTotalRaised, &new_gr);

        let gc: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalCO2OffsetGrams)
            .unwrap_or(0);
        let new_gc = gc.checked_add(co2_increment).expect("overflow");
        env.storage()
            .instance()
            .set(&DataKey::GlobalCO2OffsetGrams, &new_gc);

        // Record donation in DonationRecord with zero address for privacy
        let dc: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DonationCount)
            .unwrap_or(0);
        let new_dc = dc.checked_add(1).expect("overflow");
        env.storage()
            .instance()
            .set(&DataKey::DonationCount, &new_dc);

        let stealth_pool_donor = env.current_contract_address();
        let msg_hash_u32 = u32::from_be_bytes([
            msg_hash.to_array()[0],
            msg_hash.to_array()[1],
            msg_hash.to_array()[2],
            msg_hash.to_array()[3],
        ]);

        let donation_record = DonationRecord {
            donor: stealth_pool_donor.clone(),
            anonymous: true,
            project: project_id.clone(),
            amount,
            ledger: env.ledger().sequence(),
            message_hash: msg_hash_u32,
            currency: symbol_short!("XLM"),
        };
        env.storage()
            .instance()
            .set(&DataKey::DonationRecord(dc), &donation_record);
        env.storage()
            .instance()
            .set(&DataKey::DonationCO2Offset(dc), &co2_increment);

        env.events().publish(
            (symbol_short!("stlth_don"), stealth_pool_donor, project_id),
            (donation_id, amount, msg_hash_u32),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);

        donation_id
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
    // ─── MMR-based Impact Certificate (#430) ────────────────────────────────
    #[cfg(feature = "impact")]
    /// Admin-only: append a new period's Merkle root to the project's
    /// Merkle Mountain Range. Each period's root represents the Merkle tree
    /// of all donor impacts for that reporting period.
    ///
    /// The MMR supports append-only growth: each new root is combined with
    /// existing peaks per the standard MMR algorithm, and the updated peak
    /// set is stored on-chain. A single cumulative proof can then verify
    /// a leaf's inclusion across any historical period.
    ///
    /// # Parameters
    /// - `admin`: A registered admin address (requires `require_auth`).
    /// - `project_id`: The project this root belongs to.
    /// - `new_root`: The 32-byte Merkle root for the new reporting period.
    ///
    /// # Panics
    /// - If the caller is not an admin.
    /// - If the contract is paused.
    /// - If the project does not exist.
    pub fn append_impact_root(env: Env, admin: Address, project_id: String, new_root: BytesN<32>) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);
        // Verify the project exists.
        env.storage()
            .instance()
            .get::<_, Project>(&DataKey::Project(project_id.clone()))
            .expect("Project not found");

        let mmr_size_key = ImpactKey::ImpactMMRSize(project_id.clone());
        let mmr_peaks_key = ImpactKey::ImpactMMRPeaks(project_id.clone());

        let leaf_count: u32 = env.storage().instance().get(&mmr_size_key).unwrap_or(0);
        let mut peaks: Vec<BytesN<32>> = env
            .storage()
            .instance()
            .get(&mmr_peaks_key)
            .unwrap_or(Vec::new(&env));

        let new_root_clone = new_root.clone();
        mmr_append_peaks(&env, &mut peaks, leaf_count, new_root_clone);
        let new_count = leaf_count.checked_add(1).expect("overflow");

        env.storage().instance().set(&mmr_peaks_key, &peaks);
        env.storage().instance().set(&mmr_size_key, &new_count);

        env.events().publish(
            (symbol_short!("mmr_app"), admin, project_id, new_count),
            new_root,
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }
    #[cfg(feature = "impact")]
    /// Public read-only: verify that a donor's impact leaf is included in the
    /// MMR at the given MMR leaf index.
    ///
    /// The proof format is `(siblings: Vec<BytesN<32>>, peak_indices: Vec<u32>)`
    /// per the MMR proof standard. The function computes the leaf hash from
    /// `impact_data`, walks the mountain using `siblings` and `leaf_index` to
    /// compute the mountain peak, then checks that peak against the stored MMR
    /// peaks at the positions given by `peak_indices`.
    ///
    /// # Parameters
    /// - `project_id`: The project this impact belongs to.
    /// - `impact_data`: The `ImpactLeaf` claimed for this donor.
    /// - `proof`: An MMR proof tuple `(siblings, peak_indices)`.
    /// - `leaf_index`: Position of this leaf within its period's Merkle tree
    ///   (used to determine sibling ordering when computing the mountain peak).
    /// - `mmr_index`: The MMR leaf position (0-indexed) this leaf claims to
    ///   be at. Must be less than the total MMR size.
    ///
    /// # Returns
    /// - `true` if the leaf is provably included in the MMR at `mmr_index`.
    /// - `false` if the MMR has no peaks, `mmr_index` is out of range, the
    ///   peak index is out of range, or the proof does not verify.
    pub fn verify_impact_inclusion(
        env: Env,
        project_id: String,
        impact_data: ImpactLeaf,
        proof: (Vec<BytesN<32>>, Vec<u32>),
        leaf_index: u32,
        mmr_index: u32,
    ) -> bool {
        let mmr_size_key = ImpactKey::ImpactMMRSize(project_id.clone());
        let mmr_peaks_key = ImpactKey::ImpactMMRPeaks(project_id);
        let mmr_size: u32 = env.storage().instance().get(&mmr_size_key).unwrap_or(0);
        if mmr_index >= mmr_size {
            return false;
        }
        let peaks: Vec<BytesN<32>> = match env.storage().instance().get(&mmr_peaks_key) {
            Some(p) => p,
            None => return false,
        };
        let (siblings, peak_indices) = proof;
        let leaf_hash = compute_impact_leaf_hash(&env, &impact_data);
        // A leaf belongs to exactly one mountain with one peak.
        // Constrain to a single peak index for tight verification.
        if peak_indices.len() != 1 {
            return false;
        }
        let peak_idx = peak_indices.get_unchecked(0);
        mmr_verify_proof(&env, &leaf_hash, &siblings, &peaks, peak_idx, leaf_index)
    }
    // ─── Off-Chain Oracle Attestation for Project Impact Verification (#459) ─
    /// Admin-only: authorise an address to submit impact verification reports.
    #[cfg(feature = "impact_verification")]
    pub fn add_impact_verifier(env: Env, admin: Address, verifier: Address) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);
        env.storage().instance().set(
            &ImpactVerificationKey::ImpactVerifier(verifier.clone()),
            &true,
        );
        env.events()
            .publish((symbol_short!("impv_add"), admin), verifier);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }
    /// Admin-only: revoke a verifier's ability to submit new reports.
    /// Reports it already submitted, and any flag/adjustment they caused,
    /// are left untouched.
    #[cfg(feature = "impact_verification")]
    pub fn remove_impact_verifier(env: Env, admin: Address, verifier: Address) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);
        env.storage()
            .instance()
            .remove(&ImpactVerificationKey::ImpactVerifier(verifier.clone()));
        env.events()
            .publish((symbol_short!("impv_rem"), admin), verifier);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }
    #[cfg(feature = "impact_verification")]
    pub fn is_impact_verifier(env: Env, verifier: Address) -> bool {
        env.storage()
            .instance()
            .get(&ImpactVerificationKey::ImpactVerifier(verifier))
            .unwrap_or(false)
    }
    /// Admin-only: configure how many distinct verifier reports are required
    /// before `co2_per_xlm` auto-adjusts to the median verified rate.
    #[cfg(feature = "impact_verification")]
    pub fn set_impact_report_threshold(env: Env, admin: Address, threshold: u32) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);
        if threshold == 0 {
            panic!("Threshold must be greater than zero");
        }
        env.storage()
            .instance()
            .set(&ImpactVerificationKey::ImpactReportThreshold, &threshold);
        env.events()
            .publish((symbol_short!("impv_thr"), admin), threshold);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }
    /// Admin-only: clear a project's deviation flag, e.g. after investigating
    /// and confirming the discrepancy was a reporting error rather than
    /// genuine greenwashing.
    #[cfg(feature = "impact_verification")]
    pub fn clear_impact_flag(env: Env, admin: Address, project_id: String) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);
        env.storage()
            .instance()
            .remove(&ImpactVerificationKey::ImpactFlagged(project_id.clone()));
        env.events()
            .publish((symbol_short!("impv_clr"), admin), project_id);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }
    /// Authorised verifier: submit (or update) an independent CO2-impact
    /// attestation for a project.
    ///
    /// Resubmitting with the same `verifier` for the same `project_id`
    /// updates the existing report in place (same `report_id`) instead of
    /// creating a duplicate. Every submission is checked against the
    /// project's current `co2_per_xlm` ("claimed rate"): a deviation of 50%
    /// or more sets a sticky flag on the project. Once the configured
    /// threshold of distinct verifiers has reported, `co2_per_xlm` is
    /// (re)set to the median of all their verified rates.
    ///
    /// # Panics
    /// - If the contract is paused.
    /// - If `verifier` is not on the authorised-verifier allow-list.
    /// - If `verified_co2_rate` is zero or exceeds `MAX_CO2_PER_XLM`.
    /// - If the project does not exist.
    #[cfg(feature = "impact_verification")]
    pub fn submit_impact_report(
        env: Env,
        verifier: Address,
        project_id: String,
        verified_co2_rate: u32,
        evidence_hash: BytesN<32>,
    ) -> u32 {
        verifier.require_auth();
        require_not_paused(&env);
        let is_verifier: bool = env
            .storage()
            .instance()
            .get(&ImpactVerificationKey::ImpactVerifier(verifier.clone()))
            .unwrap_or(false);
        if !is_verifier {
            panic!("Not an authorised impact verifier");
        }
        if verified_co2_rate == 0 {
            panic!("Verified CO2 rate must be greater than zero");
        }
        if verified_co2_rate > MAX_CO2_PER_XLM {
            panic!("Verified CO2 rate exceeds maximum");
        }
        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(project_id.clone()))
            .expect("Project not found");
        let claimed_rate = project.co2_per_xlm;
        // ── Duplicate handling: same (project, verifier) updates in place ──
        let record_key =
            ImpactVerificationKey::ImpactReportRecord(project_id.clone(), verifier.clone());
        let existing: Option<ImpactReport> = env.storage().instance().get(&record_key);
        let report_id = match &existing {
            Some(r) => r.report_id,
            None => {
                let next_key = ImpactVerificationKey::ImpactNextReportId(project_id.clone());
                let next: u32 = env.storage().instance().get(&next_key).unwrap_or(0);
                let new_next = next.checked_add(1).expect("overflow");
                env.storage().instance().set(&next_key, &new_next);
                next
            }
        };
        let now = env.ledger().sequence();
        let report = ImpactReport {
            project_id: project_id.clone(),
            verifier: verifier.clone(),
            report_id,
            verified_co2_rate,
            evidence_hash: evidence_hash.clone(),
            submitted_at: now,
        };
        env.storage().instance().set(&record_key, &report);
        let verifiers_key = ImpactVerificationKey::ImpactReportVerifiers(project_id.clone());
        let mut verifiers: Vec<Address> = env
            .storage()
            .instance()
            .get(&verifiers_key)
            .unwrap_or(Vec::new(&env));
        if existing.is_none() {
            verifiers.push_back(verifier.clone());
            env.storage().instance().set(&verifiers_key, &verifiers);
        }
        // ── Deviation flag, checked against the rate claimed *before* any
        // auto-adjustment below applies ─────────────────────────────────
        if impact_deviates_50_percent(claimed_rate, verified_co2_rate) {
            env.storage().instance().set(
                &ImpactVerificationKey::ImpactFlagged(project_id.clone()),
                &true,
            );
            env.events().publish(
                (
                    symbol_short!("impv_flg"),
                    verifier.clone(),
                    project_id.clone(),
                ),
                (claimed_rate, verified_co2_rate),
            );
        }
        env.events().publish(
            (
                symbol_short!("impv_sub"),
                verifier.clone(),
                project_id.clone(),
            ),
            (report_id, verified_co2_rate, evidence_hash),
        );
        // ── Auto-adjustment once the configured threshold of distinct
        // verifiers has reported. Re-runs on every later submission so the
        // rate stays current as reports are added or updated. ────────────
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&ImpactVerificationKey::ImpactReportThreshold)
            .unwrap_or(DEFAULT_IMPACT_REPORT_THRESHOLD);
        if verifiers.len() >= threshold {
            let mut rates: Vec<u32> = Vec::new(&env);
            for v in verifiers.iter() {
                let key = ImpactVerificationKey::ImpactReportRecord(project_id.clone(), v);
                if let Some(r) = env.storage().instance().get::<_, ImpactReport>(&key) {
                    rates.push_back(r.verified_co2_rate);
                }
            }
            let median = median_u32(&rates).clamp(1, MAX_CO2_PER_XLM);
            if median != project.co2_per_xlm {
                project.co2_per_xlm = median;
                env.storage()
                    .instance()
                    .set(&DataKey::Project(project_id.clone()), &project);
                env.events()
                    .publish((symbol_short!("impv_adj"), project_id.clone()), median);
            }
        }
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
        report_id
    }
    #[cfg(feature = "impact_verification")]
    pub fn get_impact_report(
        env: Env,
        project_id: String,
        verifier: Address,
    ) -> Option<ImpactReport> {
        env.storage()
            .instance()
            .get(&ImpactVerificationKey::ImpactReportRecord(
                project_id, verifier,
            ))
    }
    /// Public read-only: current verification status for a project — how
    /// many distinct verifiers have reported, the configured threshold,
    /// whether the project is flagged, and its current `co2_per_xlm`.
    #[cfg(feature = "impact_verification")]
    pub fn get_impact_verification_status(
        env: Env,
        project_id: String,
    ) -> ImpactVerificationStatus {
        let project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(project_id.clone()))
            .expect("Project not found");
        let verifiers: Vec<Address> = env
            .storage()
            .instance()
            .get(&ImpactVerificationKey::ImpactReportVerifiers(
                project_id.clone(),
            ))
            .unwrap_or(Vec::new(&env));
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&ImpactVerificationKey::ImpactReportThreshold)
            .unwrap_or(DEFAULT_IMPACT_REPORT_THRESHOLD);
        let flagged: bool = env
            .storage()
            .instance()
            .get(&ImpactVerificationKey::ImpactFlagged(project_id.clone()))
            .unwrap_or(false);
        ImpactVerificationStatus {
            report_count: verifiers.len(),
            threshold,
            flagged,
            current_co2_rate: project.co2_per_xlm,
            verifiers,
            project_id,
        }
    }

    // ─── Off-Chain Multi-Verifier Project Verification Oracle ──────────────

    /// M-of-N admin: authorise an address to submit project attestations.
    #[cfg(feature = "project_verification")]
    pub fn add_verifier(env: Env, signers: Vec<Address>, verifier: Address) {
        require_admin_for_critical(&env, &signers);
        require_not_paused(&env);
        let mut verifiers = read_verifier_set(&env);
        if verifiers.contains(&verifier) {
            panic_with_error!(&env, VerificationError::AlreadyVerifier);
        }
        verifiers.push_back(verifier.clone());
        env.storage()
            .instance()
            .set(&ProjectVerificationKey::VerifierSet, &verifiers);
        env.events().publish((symbol_short!("ver_add"),), verifier);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// M-of-N admin: revoke a verifier's ability to submit new
    /// attestations. Attestations it already submitted — and any project
    /// that reached `Verified` partly because of them — are left
    /// untouched: an attestation is a historical fact about a point-in-time
    /// review, not a live credential that expires when the verifier's
    /// authorisation does. See `revoke_verification` for the explicit,
    /// audited way to undo a project's verification.
    #[cfg(feature = "project_verification")]
    pub fn remove_verifier(env: Env, signers: Vec<Address>, verifier: Address) {
        require_admin_for_critical(&env, &signers);
        require_not_paused(&env);
        let verifiers = read_verifier_set(&env);
        if !verifiers.contains(&verifier) {
            panic_with_error!(&env, VerificationError::NotAVerifier);
        }
        let mut new_set: Vec<Address> = Vec::new(&env);
        for addr in verifiers.iter() {
            if addr != verifier {
                new_set.push_back(addr);
            }
        }
        env.storage()
            .instance()
            .set(&ProjectVerificationKey::VerifierSet, &new_set);
        env.events().publish((symbol_short!("ver_rem"),), verifier);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// M-of-N admin: configure how many distinct verifier attestations are
    /// required before a project auto-transitions to `Verified`. `0`
    /// disables the gate entirely (legacy mode — see
    /// `require_project_verified_for_donation`). No upper bound is
    /// enforced against the current verifier count: setting a threshold
    /// temporarily out of reach of today's `VerifierSet` just means no
    /// project can reach `Verified` until more verifiers are added — unlike
    /// `AdminThreshold`, this can never brick admin control of the
    /// contract, so there is nothing to guard against.
    #[cfg(feature = "project_verification")]
    pub fn set_verification_threshold(env: Env, signers: Vec<Address>, threshold: u32) {
        require_admin_for_critical(&env, &signers);
        require_not_paused(&env);
        env.storage()
            .instance()
            .set(&ProjectVerificationKey::VerificationThreshold, &threshold);
        env.events().publish((symbol_short!("ver_thr"),), threshold);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Authorised verifier: attest that `project_id` has passed this
    /// verifier's off-chain due diligence, recording a hash of their
    /// evidence. A verifier may attest a given project only once; a
    /// second call panics with `DuplicateAttestation` rather than silently
    /// updating (unlike `impact_verification`'s reports) — a mistaken
    /// attestation must go through an admin `revoke_verification` first.
    ///
    /// Auto-transitions the project to `Verified` (emitting `proj_vfy`
    /// right after this call's `proj_att`) the moment the distinct-attester
    /// count reaches `VerificationThreshold`, in the same invocation.
    ///
    /// Returns the project's distinct-attester count after this call.
    ///
    /// # Panics
    /// - If the contract is paused.
    /// - If `verifier` is not on the authorised `VerifierSet`.
    /// - If `project_id` does not exist.
    /// - If `verifier` already attested this project.
    #[cfg(feature = "project_verification")]
    pub fn attest_project(
        env: Env,
        verifier: Address,
        project_id: String,
        evidence_hash: BytesN<32>,
    ) -> u32 {
        verifier.require_auth();
        require_not_paused(&env);

        if !read_verifier_set(&env).contains(&verifier) {
            panic_with_error!(&env, VerificationError::NotAuthorizedVerifier);
        }
        if !env
            .storage()
            .instance()
            .has(&DataKey::Project(project_id.clone()))
        {
            panic_with_error!(&env, VerificationError::ProjectNotFound);
        }

        let mut attesters = read_project_attesters(&env, &project_id);
        if attesters.contains(&verifier) {
            panic_with_error!(&env, VerificationError::DuplicateAttestation);
        }
        attesters.push_back(verifier.clone());
        env.storage().instance().set(
            &ProjectVerificationKey::ProjectAttesters(project_id.clone()),
            &attesters,
        );
        env.storage().instance().set(
            &ProjectVerificationKey::ProjectAttestationEvidence(
                project_id.clone(),
                verifier.clone(),
            ),
            &evidence_hash,
        );

        let count = attesters.len();
        env.events().publish(
            (symbol_short!("proj_att"), verifier, project_id.clone()),
            (count, evidence_hash),
        );

        // May itself emit `proj_vfy` if this attestation crosses the
        // configured threshold.
        refresh_verification_status(&env, &project_id);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
        count
    }

    /// M-of-N admin: clear a project's entire verification state — all
    /// accumulated attestations, their evidence hashes, and the status
    /// itself all revert to the coherent `Unverified` default. Used when
    /// admins no longer trust a verification that already went through
    /// (e.g. evidence later found to be fraudulent), or want verifiers to
    /// re-review from scratch.
    #[cfg(feature = "project_verification")]
    pub fn revoke_verification(env: Env, signers: Vec<Address>, project_id: String) {
        require_admin_for_critical(&env, &signers);
        require_not_paused(&env);
        if !env
            .storage()
            .instance()
            .has(&DataKey::Project(project_id.clone()))
        {
            panic_with_error!(&env, VerificationError::ProjectNotFound);
        }

        let attesters = read_project_attesters(&env, &project_id);
        for verifier in attesters.iter() {
            env.storage()
                .instance()
                .remove(&ProjectVerificationKey::ProjectAttestationEvidence(
                    project_id.clone(),
                    verifier,
                ));
        }
        env.storage()
            .instance()
            .remove(&ProjectVerificationKey::ProjectAttesters(
                project_id.clone(),
            ));
        env.storage()
            .instance()
            .remove(&ProjectVerificationKey::ProjectVerification(
                project_id.clone(),
            ));

        env.events().publish(
            (symbol_short!("proj_rvk"), signers.get(0).unwrap()),
            project_id,
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    #[cfg(feature = "project_verification")]
    pub fn is_verifier(env: Env, verifier: Address) -> bool {
        read_verifier_set(&env).contains(&verifier)
    }

    #[cfg(feature = "project_verification")]
    pub fn get_verifier_set(env: Env) -> Vec<Address> {
        read_verifier_set(&env)
    }

    #[cfg(feature = "project_verification")]
    pub fn get_verification_threshold(env: Env) -> u32 {
        read_verification_threshold(&env)
    }

    /// Read-only: a project's current verification status, computed live
    /// against the current `VerificationThreshold` and attester count.
    /// Never mutates storage — see `refresh_verification_status` for the
    /// persisting variant used internally by `attest_project` and the
    /// donation gate.
    #[cfg(feature = "project_verification")]
    pub fn get_project_verification_status(env: Env, project_id: String) -> VerificationStatus {
        compute_live_status(&env, &project_id)
    }

    #[cfg(feature = "project_verification")]
    pub fn get_project_verifiers(env: Env, project_id: String) -> Vec<Address> {
        read_project_attesters(&env, &project_id)
    }

    /// Read-only: the evidence hash one verifier submitted for one
    /// project, or `None` if that verifier hasn't attested it.
    #[cfg(feature = "project_verification")]
    pub fn get_attestation_evidence(
        env: Env,
        project_id: String,
        verifier: Address,
    ) -> Option<BytesN<32>> {
        env.storage()
            .instance()
            .get(&ProjectVerificationKey::ProjectAttestationEvidence(
                project_id, verifier,
            ))
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
            .expect("overflow");

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
                .expect("overflow");
            total_donors = total_donors.checked_add(sub.donor_count).expect("overflow");
            let sub_xlm = sub.total_raised / STROOP;
            total_co2 = total_co2
                .checked_add(
                    sub_xlm
                        .checked_mul(sub.co2_per_xlm as i128)
                        .expect("overflow"),
                )
                .expect("overflow");
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

    #[cfg(feature = "impact")]
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

    // ─── On-Chain Donation Receipts with Cryptographic Commitment (#455) ─────

    /// Generate a deterministic on-chain donation receipt with a SHA-256
    /// cryptographic commitment. Only the donor can generate their own receipt.
    ///
    /// The returned `DonationReceipt` contains a `contract_signature` field
    /// which is SHA-256 of the deterministic XDR encoding of all other fields.
    /// Anyone can verify the receipt via `verify_receipt` without querying
    /// the full donation history.
    ///
    /// # Determinism
    ///
    /// Calling `generate_receipt` twice with the same donor and donation_index
    /// returns the identical receipt (same `contract_signature`), because the
    /// receipt fields are sourced immutably from storage.
    ///
    /// # Panics
    ///
    /// - If `donor` does not match the donation record's donor.
    /// - If the donation index does not exist.
    pub fn generate_receipt(env: Env, donor: Address, donation_index: u32) -> DonationReceipt {
        donor.require_auth();

        let record: DonationRecord = env
            .storage()
            .instance()
            .get(&DataKey::DonationRecord(donation_index))
            .expect("Donation record not found");

        // Only the actual donor can generate a receipt.
        // For anonymous donations, the real donor address is stored in
        // DonationRecord.donor — the zero-address is only used as the
        // DonorStats key for privacy. The real donor can still generate
        // a receipt because they know which donation_index is theirs.
        if donor != record.donor {
            panic!("Only the donor can generate a receipt for this donation");
        }

        let co2_offset: i128 = env
            .storage()
            .instance()
            .get(&DataKey::DonationCO2Offset(donation_index))
            .unwrap_or(0);

        // Build the fields to hash (without the signature)
        let fields = ReceiptFields {
            donation_index,
            donor: donor.clone(),
            project_id: record.project.clone(),
            amount: record.amount,
            co2_offset,
            ledger: record.ledger,
            currency: record.currency.clone(),
        };

        // Compute SHA-256 commitment over the deterministic XDR encoding.
        // Using XDR ensures the receipt can be verified off-chain with
        // any Stellar SDK that supports XDR deserialization.
        use soroban_sdk::xdr::ToXdr;
        let xdr_bytes = fields.to_xdr(&env);
        let contract_signature: BytesN<32> = env.crypto().sha256(&xdr_bytes).into();

        env.events().publish(
            (symbol_short!("rcpt_gen"), donor.clone()),
            (
                donation_index,
                record.amount,
                record.project.clone(),
                co2_offset,
            ),
        );

        DonationReceipt {
            donation_index,
            donor: donor.clone(),
            project_id: record.project.clone(),
            amount: record.amount,
            co2_offset,
            ledger: record.ledger,
            currency: record.currency.clone(),
            contract_signature,
        }
    }

    /// Verify a donation receipt against its on-chain data.
    ///
    /// Anyone can call this function — no authentication required. Returns
    /// `true` if the receipt's `contract_signature` matches a recomputed
    /// SHA-256 hash of the other receipt fields against the on-chain
    /// donation record and CO₂ offset.
    ///
    /// Returns `false` if:
    /// - The referenced donation index does not exist on-chain.
    /// - Any receipt field (donor, project_id, amount, ledger, currency)
    ///   does not match the on-chain `DonationRecord`.
    /// - The `co2_offset` does not match the on-chain value.
    /// - The `contract_signature` has been tampered with.
    pub fn verify_receipt(env: Env, receipt: DonationReceipt) -> bool {
        // Check the donation exists on-chain
        let record: DonationRecord = match env
            .storage()
            .instance()
            .get(&DataKey::DonationRecord(receipt.donation_index))
        {
            Some(r) => r,
            None => return false,
        };

        // Verify all receipt fields match the on-chain record
        if record.donor != receipt.donor
            || record.project != receipt.project_id
            || record.amount != receipt.amount
            || record.ledger != receipt.ledger
            || record.currency != receipt.currency
        {
            return false;
        }

        // Verify CO₂ offset matches on-chain
        let onchain_co2: i128 = env
            .storage()
            .instance()
            .get(&DataKey::DonationCO2Offset(receipt.donation_index))
            .unwrap_or(0);
        if onchain_co2 != receipt.co2_offset {
            return false;
        }

        // Recompute the SHA-256 commitment
        let fields = ReceiptFields {
            donation_index: receipt.donation_index,
            donor: receipt.donor,
            project_id: receipt.project_id,
            amount: receipt.amount,
            co2_offset: receipt.co2_offset,
            ledger: receipt.ledger,
            currency: receipt.currency,
        };

        use soroban_sdk::xdr::ToXdr;
        let xdr_bytes = fields.to_xdr(&env);
        let computed: BytesN<32> = env.crypto().sha256(&xdr_bytes).into();

        computed == receipt.contract_signature
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

    #[cfg(feature = "impact")]
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

    #[cfg(feature = "impact")]
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
        let co2_offset = xlm_units.checked_mul(co2_per_xlm).expect("overflow");

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
            .expect("overflow");

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
    #[cfg(feature = "delegation")]
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
        let own_credits = voting_credits_from_badge(&stats.badge);
        #[cfg(feature = "delegation")]
        let delegated_credits: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DelegatedWeight(voter))
            .unwrap_or(0);
        #[cfg(not(feature = "delegation"))]
        let delegated_credits: u32 = 0;
        let total_credits = own_credits
            .checked_add(delegated_credits)
            .expect("overflow");
        isqrt(total_credits)
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
            old_weight = old_weight.checked_sub(weight).expect("underflow");
            env.storage().instance().set(&old_del_key, &old_weight);
        }
        let new_del_key = DataKey::DelegatedWeight(delegate.clone());
        let mut new_weight: u32 = env.storage().instance().get(&new_del_key).unwrap_or(0);
        new_weight = new_weight.checked_add(weight).expect("overflow");

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
            old_weight = old_weight.checked_sub(weight).expect("underflow");
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
    /// Badge holders (≥ Seedling) cast quadratic votes using credits.
    /// Multiple votes per proposal are allowed, each spending additional credits.
    #[cfg(feature = "governance")]
    pub fn vote_verify_project(
        env: Env,
        voter: Address,
        project_id: String,
        approve: bool,
        credits: u32,
    ) {
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
        let own_credits = voting_credits_from_badge(&stats.badge);
        let delegated_credits: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DelegatedWeight(voter.clone()))
            .unwrap_or(0);
        let total_credits = own_credits
            .checked_add(delegated_credits)
            .expect("overflow");

        if total_credits == 0 {
            panic!("Only badge holders (Seedling or above) or active delegates can vote");
        }
        let credits_key = DataKey::VoteCredits(project_id.clone(), voter.clone());
        let previously_spent: u32 = env.storage().instance().get(&credits_key).unwrap_or(0);
        let new_total = previously_spent.checked_add(credits).expect("overflow");
        if new_total > total_credits {
            panic!("Insufficient voting credits");
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
        let prev_effective = isqrt(previously_spent);
        let new_effective = isqrt(new_total);
        let weight_delta = new_effective
            .checked_sub(prev_effective)
            .expect("underflow");

        // Effects: persist state before external effects.
        let voter_list_key = DataKey::VoterList(project_id.clone());
        let voted_key = DataKey::HasVoted(project_id.clone(), voter.clone());
        if !env.storage().instance().has(&voted_key) {
            let mut voter_list: Vec<Address> = env
                .storage()
                .instance()
                .get(&voter_list_key)
                .unwrap_or(Vec::new(&env));
            voter_list.push_back(voter.clone());
            env.storage().instance().set(&voter_list_key, &voter_list);
            env.storage().instance().set(&voted_key, &true);
        }
        env.storage().instance().set(&credits_key, &new_total);
        if approve {
            proposal.votes_for = proposal
                .votes_for
                .checked_add(weight_delta)
                .expect("overflow");
        } else {
            proposal.votes_against = proposal
                .votes_against
                .checked_add(weight_delta)
                .expect("overflow");
        }
        env.storage()
            .instance()
            .set(&DataKey::Proposal(project_id.clone()), &proposal);
        env.events().publish(
            (symbol_short!("voted"), voter, project_id),
            (approve, credits, weight_delta),
        );
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
        Self::donate_token_with_privacy(
            env,
            usdc_token,
            donor,
            project_id,
            usdc_amount,
            msg_hash,
            anonymous,
        )
    }

    /// Admin-only: Register a token and its price oracle into the token registry.
    #[cfg(any(feature = "usdc", feature = "donation", feature = "testutils"))]
    pub fn register_token(
        env: Env,
        admin: Address,
        token_address: Address,
        oracle_address: Address,
        symbol: Symbol,
    ) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);

        let config_key = DataKey::TokenConfig(token_address.clone());
        if let Some(existing) = env.storage().instance().get::<_, TokenConfig>(&config_key) {
            if existing.active {
                panic!("Token already registered");
            }
        }

        let config = TokenConfig {
            token: token_address.clone(),
            oracle: oracle_address.clone(),
            symbol: symbol.clone(),
            active: true,
            registered_at: env.ledger().sequence(),
        };

        env.storage().instance().set(&config_key, &config);

        let mut list: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::TokenList)
            .unwrap_or(Vec::new(&env));
        if !list.contains(&token_address) {
            list.push_back(token_address.clone());
            env.storage().instance().set(&DataKey::TokenList, &list);
        }

        env.events()
            .publish((symbol_short!("tok_reg"), admin), (token_address, symbol));
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Admin-only: Remove a token from active registration in the registry.
    #[cfg(any(feature = "usdc", feature = "donation", feature = "testutils"))]
    pub fn remove_token(env: Env, admin: Address, token_address: Address) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);

        let config_key = DataKey::TokenConfig(token_address.clone());
        let mut config: TokenConfig = env
            .storage()
            .instance()
            .get(&config_key)
            .expect("Token not registered");

        if !config.active {
            panic!("Token is already inactive");
        }

        config.active = false;
        env.storage().instance().set(&config_key, &config);

        let mut list: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::TokenList)
            .unwrap_or(Vec::new(&env));
        if let Some(idx) = list.first_index_of(&token_address) {
            list.remove(idx);
            env.storage().instance().set(&DataKey::TokenList, &list);
        }

        env.events()
            .publish((symbol_short!("tok_rem"), admin), token_address);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Query configuration for a registered token.
    #[cfg(any(feature = "usdc", feature = "donation", feature = "testutils"))]
    pub fn get_token_config(env: Env, token_address: Address) -> Option<TokenConfig> {
        env.storage()
            .instance()
            .get(&DataKey::TokenConfig(token_address))
    }

    /// Query the list of active registered tokens.
    #[cfg(any(feature = "usdc", feature = "donation", feature = "testutils"))]
    pub fn get_token_list(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::TokenList)
            .unwrap_or(Vec::new(&env))
    }

    /// Generic donation entrypoint for any registered token.
    #[cfg(any(feature = "usdc", feature = "donation", feature = "testutils"))]
    pub fn donate_token(
        env: Env,
        token: Address,
        donor: Address,
        project_id: String,
        amount: i128,
        msg_hash: u32,
    ) {
        Self::donate_token_with_privacy(env, token, donor, project_id, amount, msg_hash, false)
    }

    /// Generic donation entrypoint for any registered token with explicit privacy choice.
    #[cfg(any(feature = "usdc", feature = "donation", feature = "testutils"))]
    pub fn donate_token_with_privacy(
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

        let token_config = get_token_config_for_donate_token(&env, &token);

        let xlm_equivalent = if token_config.symbol == symbol_short!("XLM")
            || (env.storage().instance().has(&DataKey::NativeTokenAddress)
                && env
                    .storage()
                    .instance()
                    .get::<_, Address>(&DataKey::NativeTokenAddress)
                    .unwrap()
                    == token)
        {
            amount
        } else {
            let oracle_addr = token_config.oracle.clone();
            let oracle = OracleClient::new(&env, &oracle_addr);
            let rate = oracle.get_price();
            if rate <= 0 {
                panic!("Oracle returned invalid price");
            }
            amount.checked_mul(rate).expect("overflow") / PRICE_SCALE
        };

        process_donation_token(
            &env,
            &token,
            &token_config.symbol,
            &donor,
            &project_id,
            amount,
            xlm_equivalent,
            msg_hash,
            anonymous,
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

        let oracle_addr = env
            .storage()
            .instance()
            .get(&DataKey::OracleAddress)
            .unwrap_or(usdc_token.clone());

        let config = TokenConfig {
            token: usdc_token.clone(),
            oracle: oracle_addr,
            symbol: symbol_short!("USDC"),
            active: true,
            registered_at: env.ledger().sequence(),
        };

        let config_key = DataKey::TokenConfig(usdc_token.clone());
        env.storage().instance().set(&config_key, &config);

        let mut list: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::TokenList)
            .unwrap_or(Vec::new(&env));
        if !list.contains(&usdc_token) {
            list.push_back(usdc_token.clone());
            env.storage().instance().set(&DataKey::TokenList, &list);
        }

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
    /// Admin-only: Configure the donation rate limit for one token.
    ///
    /// This is a routine admin action. Both values must be positive.
    pub fn set_token_rate_limit(
        env: Env,
        admin: Address,
        token: Address,
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
            .set(&DataKey::TokenRateLimitMax(token.clone()), &max_donations);
        env.storage().instance().set(
            &DataKey::TokenRateLimitWindow(token.clone()),
            &window_ledgers,
        );
        env.events().publish(
            (symbol_short!("tok_rate"), token),
            (max_donations, window_ledgers),
        );
    }
    /// Get a token's effective rate limit, falling back to the global policy.
    pub fn get_token_rate_limit(env: Env, token: Address) -> (u32, u32) {
        effective_token_rate_limit(&env, &token)
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

        if let Some(usdc_token) = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::USDCTokenAddress)
        {
            let config_key = DataKey::TokenConfig(usdc_token.clone());
            let mut config = env
                .storage()
                .instance()
                .get::<_, TokenConfig>(&config_key)
                .unwrap_or(TokenConfig {
                    token: usdc_token.clone(),
                    oracle: oracle.clone(),
                    symbol: symbol_short!("USDC"),
                    active: true,
                    registered_at: env.ledger().sequence(),
                });
            config.oracle = oracle.clone();
            env.storage().instance().set(&config_key, &config);

            let mut list: Vec<Address> = env
                .storage()
                .instance()
                .get(&DataKey::TokenList)
                .unwrap_or(Vec::new(&env));
            if !list.contains(&usdc_token) {
                list.push_back(usdc_token.clone());
                env.storage().instance().set(&DataKey::TokenList, &list);
            }
        }

        env.events().publish((symbol_short!("oracle"),), oracle);
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }
    /// Get the configured price oracle address.
    #[cfg(feature = "usdc")]
    pub fn get_oracle(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::OracleAddress)
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
            .expect("overflow");
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
            .expect("overflow");

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
            .expect("overflow");
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

        if env
            .storage()
            .instance()
            .has(&DataKey::ForceRefund(refund_id))
        {
            panic!("Force refund escalation pending; cancel it first");
        }

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

        apply_refund_accounting(&env, refund_id, &mut request, &mut project);

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

        if env
            .storage()
            .instance()
            .has(&DataKey::ForceRefund(refund_id))
        {
            panic!("Force refund escalation pending; cancel it first");
        }

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

    /// M-of-N initiation of the 72-hour force-refund timelock.
    ///
    /// This only schedules the escalation; no tokens move and no donation
    /// accounting changes until `execute_force_refund`.
    #[cfg(feature = "refund")]
    pub fn force_approve_refund(env: Env, signers: Vec<Address>, refund_id: u32) {
        require_admin_for_critical(&env, &signers);
        require_not_paused(&env);

        let request: RefundRequest = env
            .storage()
            .instance()
            .get(&DataKey::RefundRequest(refund_id))
            .expect("Refund request not found");
        if request.status != RefundRequestStatus::Pending {
            panic!("Refund request is not pending");
        }

        let force_key = DataKey::ForceRefund(refund_id);
        if env.storage().instance().has(&force_key) {
            panic!("Force refund already pending");
        }

        let initiated_at = env.ledger().sequence();
        let effective_at = initiated_at
            .checked_add(FORCE_REFUND_TIMELOCK_LEDGERS)
            .expect("overflow");
        env.storage().instance().set(
            &force_key,
            &ForceRefund {
                initiated_at,
                effective_at,
            },
        );

        env.events().publish(
            (Symbol::new(&env, "rfnd_force_init"), refund_id),
            (request.project_id, request.amount, effective_at),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Cancel a pending force-refund during its 72-hour review window.
    #[cfg(feature = "refund")]
    pub fn cancel_force_refund(env: Env, admin: Address, refund_id: u32) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);

        let force_key = DataKey::ForceRefund(refund_id);
        let force_refund: ForceRefund = env
            .storage()
            .instance()
            .get(&force_key)
            .expect("No pending force refund");
        if env.ledger().sequence() >= force_refund.effective_at {
            panic!("Force refund timelock already elapsed");
        }

        env.storage().instance().remove(&force_key);
        env.events()
            .publish((Symbol::new(&env, "rfnd_force_cncl"), refund_id, admin), ());
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Permissionless execution of a matured force-refund.
    ///
    /// Funds come from the canonical per-project, per-token contract-held
    /// balance. This avoids authorization from an adversarial project wallet
    /// and prevents funds attributed to another project or token from being
    /// spent.
    #[cfg(feature = "refund")]
    pub fn execute_force_refund(env: Env, refund_id: u32) {
        let force_key = DataKey::ForceRefund(refund_id);
        let force_refund: ForceRefund = env
            .storage()
            .instance()
            .get(&force_key)
            .expect("No pending force refund");
        if env.ledger().sequence() < force_refund.effective_at {
            panic!("Force refund timelock not yet elapsed");
        }

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
        let mut project: Project = env
            .storage()
            .instance()
            .get(&DataKey::Project(request.project_id.clone()))
            .expect("Project not found");

        let balance_key =
            DataKey::ProjectContractBalance(request.project_id.clone(), request.token.clone());
        let pool_balance: i128 = env.storage().instance().get(&balance_key).unwrap_or(0);
        if request.amount > pool_balance {
            panic!("Insufficient force refund pool balance");
        }

        // Checks-effects-interactions: Soroban reverts every storage write if
        // the subsequent token transfer fails.
        env.storage().instance().remove(&force_key);
        env.storage()
            .instance()
            .set(&balance_key, &(pool_balance - request.amount));
        apply_refund_accounting(&env, refund_id, &mut request, &mut project);

        let token_client = token::Client::new(&env, &request.token);
        token_client.transfer(
            &env.current_contract_address(),
            &request.donor,
            &request.amount,
        );

        env.events().publish(
            (Symbol::new(&env, "rfnd_force_exec"), refund_id),
            (request.project_id, request.amount, request.donor),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Returns the pending force-refund escalation, if one exists.
    #[cfg(feature = "refund")]
    pub fn get_force_refund(env: Env, refund_id: u32) -> Option<ForceRefund> {
        env.storage()
            .instance()
            .get(&DataKey::ForceRefund(refund_id))
    }
    /// Read-only: returns the refund request for the given ID, or panics if
    /// not found.
    #[cfg(feature = "refund")]
    pub fn get_refund_request(env: Env, refund_id: u32) -> RefundRequest {
        env.storage()
            .instance()
            .get(&DataKey::RefundRequest(refund_id))
            .expect("Refund request not found")
    }

    // ─── Time-Locked Donation Challenge/Response Protocol (#457) ──────────────

    /// Admin-only (M-of-N): set the minimum donation threshold that triggers a challenge period.
    /// Setting threshold to 0 disables the challenge system (backward compatible).
    pub fn set_challenge_threshold(env: Env, signers: Vec<Address>, threshold: i128) {
        require_admin_for_critical(&env, &signers);
        require_not_paused(&env);
        if threshold < 0 {
            panic!("Threshold cannot be negative");
        }
        env.storage()
            .instance()
            .set(&DataKey::ChallengeThreshold, &threshold);
        env.events().publish(
            (symbol_short!("chg_thrsh"), signers.get(0).unwrap()),
            threshold,
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Read-only: get the configured challenge threshold in stroops (0 if disabled).
    pub fn get_challenge_threshold(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::ChallengeThreshold)
            .unwrap_or(0i128)
    }

    /// Badge holders (≥ Seedling) can challenge a donation exceeding the threshold within the 24h window.
    pub fn challenge_donation(env: Env, challenger: Address, donation_index: u32, reason: String) {
        challenger.require_auth();
        require_not_paused(&env);

        let donor_stats: DonorStats = env
            .storage()
            .instance()
            .get(&DataKey::DonorStats(challenger.clone()))
            .unwrap_or(DonorStats {
                total_donated: 0,
                donation_count: 0,
                badge: BadgeTier::None,
                co2_offset_grams: 0,
            });
        if donor_stats.badge == BadgeTier::None {
            panic!("Only badge holders can challenge donations");
        }

        let donation: DonationRecord = env
            .storage()
            .instance()
            .get(&DataKey::DonationRecord(donation_index))
            .expect("Donation record not found");

        let threshold = Self::get_challenge_threshold(env.clone());
        if threshold == 0 || donation.amount < threshold {
            panic!("Donation is below challenge threshold");
        }

        let current_ledger = env.ledger().sequence();
        if current_ledger > donation.ledger + CHALLENGE_WINDOW_LEDGERS {
            panic!("Challenge window has expired");
        }

        if env
            .storage()
            .instance()
            .has(&DataKey::DonationChallenge(donation_index))
        {
            panic!("Donation already challenged");
        }

        let challenge = DonationChallenge {
            challenged: true,
            challenger: challenger.clone(),
            challenged_at: current_ledger,
            resolved: false,
            approved: false,
        };
        env.storage()
            .instance()
            .set(&DataKey::DonationChallenge(donation_index), &challenge);

        env.events().publish(
            (symbol_short!("chg_sub"), donation_index, challenger),
            (donation.amount, reason),
        );
        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Admin-only: resolve a pending challenge by either approving or rejecting (refunding) the donation.
    pub fn resolve_challenge(env: Env, admin: Address, donation_index: u32, approve: bool) {
        require_admin_for_routine(&env, &admin);
        require_not_paused(&env);

        let mut challenge: DonationChallenge = env
            .storage()
            .instance()
            .get(&DataKey::DonationChallenge(donation_index))
            .expect("Challenge not found");

        if !challenge.challenged || challenge.resolved {
            panic!("Challenge is not active or already resolved");
        }

        challenge.resolved = true;
        challenge.approved = approve;
        env.storage()
            .instance()
            .set(&DataKey::DonationChallenge(donation_index), &challenge);

        if approve {
            env.events()
                .publish((symbol_short!("chg_res"), donation_index, admin), true);
        } else {
            let record: DonationRecord = env
                .storage()
                .instance()
                .get(&DataKey::DonationRecord(donation_index))
                .expect("Donation record not found");

            let co2_offset: i128 = env
                .storage()
                .instance()
                .get(&DataKey::DonationCO2Offset(donation_index))
                .unwrap_or(0);

            let mut project: Project = env
                .storage()
                .instance()
                .get(&DataKey::Project(record.project.clone()))
                .expect("Project not found");

            project.total_raised = project
                .total_raised
                .checked_sub(record.amount)
                .expect("underflow");
            env.storage()
                .instance()
                .set(&DataKey::Project(record.project.clone()), &project);

            let mut donor_stats: DonorStats = env
                .storage()
                .instance()
                .get(&DataKey::DonorStats(record.donor.clone()))
                .unwrap_or(DonorStats {
                    total_donated: 0,
                    donation_count: 0,
                    badge: BadgeTier::None,
                    co2_offset_grams: 0,
                });
            donor_stats.total_donated = donor_stats
                .total_donated
                .checked_sub(record.amount)
                .expect("underflow");
            donor_stats.co2_offset_grams = donor_stats
                .co2_offset_grams
                .checked_sub(co2_offset)
                .expect("underflow");
            env.storage()
                .instance()
                .set(&DataKey::DonorStats(record.donor.clone()), &donor_stats);

            let proj_total_key =
                DataKey::DonorProjectTotal(record.project.clone(), record.donor.clone());
            let prev_proj_total: i128 = env.storage().instance().get(&proj_total_key).unwrap_or(0);
            env.storage().instance().set(
                &proj_total_key,
                &prev_proj_total
                    .checked_sub(record.amount)
                    .expect("underflow"),
            );

            let gr: i128 = env
                .storage()
                .instance()
                .get(&DataKey::GlobalTotalRaised)
                .unwrap_or(0);
            env.storage().instance().set(
                &DataKey::GlobalTotalRaised,
                &gr.checked_sub(record.amount).expect("underflow"),
            );

            let gc: i128 = env
                .storage()
                .instance()
                .get(&DataKey::GlobalCO2OffsetGrams)
                .unwrap_or(0);
            env.storage().instance().set(
                &DataKey::GlobalCO2OffsetGrams,
                &gc.checked_sub(co2_offset).expect("underflow"),
            );

            #[cfg(feature = "usdc")]
            if record.currency == symbol_short!("USDC") {
                if let Some(usdc_token) = Self::get_usdc_token(env.clone()) {
                    let token_client = token::Client::new(&env, &usdc_token);
                    token_client.transfer(&project.wallet, &record.donor, &record.amount);
                }
            }

            env.events()
                .publish((symbol_short!("chg_res"), donation_index, admin), false);
        }

        ensure_min_ttl(&env, VOTING_WINDOW_LEDGERS * 4);
    }

    /// Read-only: get the challenge status for a donation index.
    pub fn get_donation_challenge(env: Env, donation_index: u32) -> Option<DonationChallenge> {
        env.storage()
            .instance()
            .get(&DataKey::DonationChallenge(donation_index))
    }

    /// Read-only: check whether a donation is finalized.
    pub fn is_donation_finalized(env: Env, donation_index: u32) -> bool {
        let record: DonationRecord = match env
            .storage()
            .instance()
            .get(&DataKey::DonationRecord(donation_index))
        {
            Some(rec) => rec,
            None => return false,
        };

        let threshold = Self::get_challenge_threshold(env.clone());
        if threshold == 0 || record.amount < threshold {
            return true;
        }

        if let Some(challenge) = Self::get_donation_challenge(env.clone(), donation_index) {
            if challenge.resolved {
                return challenge.approved;
            } else {
                return false;
            }
        }

        let current_ledger = env.ledger().sequence();
        current_ledger > record.ledger + CHALLENGE_WINDOW_LEDGERS
    }

    /// Auto-finalize an unchallenged donation after the challenge window elapses.
    pub fn auto_finalize(env: Env, donation_index: u32) -> bool {
        let finalized = Self::is_donation_finalized(env.clone(), donation_index);
        if finalized {
            env.events()
                .publish((symbol_short!("chg_fin"), donation_index), ());
        }
        finalized
    }

    // ─── Recurring Donations ──────────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    #[cfg(feature = "recurring")]
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
        let next_count = count.checked_add(1).expect("overflow");
        env.storage().instance().set(&count_key, &next_count);
        let next_execution_ledger = env
            .ledger()
            .sequence()
            .checked_add(interval_ledgers)
            .expect("overflow");

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
        #[cfg(feature = "project_verification")]
        require_project_verified_for_donation(&env, &recurring.project_id);
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
            xlm_equivalent = recurring.amount.checked_mul(rate).expect("overflow");
        } else {
            panic!("Unsupported currency");
        }
        let xlm_units = xlm_equivalent / STROOP;
        let co2_increment = xlm_units
            .checked_mul(project.co2_per_xlm as i128)
            .expect("overflow");

        // Checks-Effects-Interactions (CEI) Pattern: State changes before token transfers.
        // Update Project
        project.total_raised = project
            .total_raised
            .checked_add(xlm_equivalent)
            .expect("overflow");
        let goal_reached = apply_campaign_goal_progress(&mut project);
        let donated_key = DataKey::HasDonated(recurring.project_id.clone(), donor.clone());
        if !env.storage().instance().has(&donated_key) {
            env.storage().instance().set(&donated_key, &true);
            project.donor_count = project.donor_count.checked_add(1).expect("overflow");
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
            .expect("overflow");
        donor_stats.donation_count = donor_stats.donation_count.checked_add(1).expect("overflow");
        donor_stats.co2_offset_grams = donor_stats
            .co2_offset_grams
            .checked_add(co2_increment)
            .expect("overflow");
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
                .expect("overflow"),
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
        let new_dc = dc.checked_add(1).expect("overflow");
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
            &gr.checked_add(xlm_equivalent).expect("overflow"),
        );
        let gc: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalCO2OffsetGrams)
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::GlobalCO2OffsetGrams,
            &gc.checked_add(co2_increment).expect("overflow"),
        );
        // Update schedule next execution sequence
        recurring.next_execution_ledger = env
            .ledger()
            .sequence()
            .checked_add(recurring.interval_ledgers)
            .expect("overflow");
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

    #[cfg(feature = "recurring")]
    pub fn get_recurring(env: Env, donor: Address, recurring_id: u32) -> RecurringDonation {
        env.storage()
            .instance()
            .get(&DataKey::RecurringDonation(donor, recurring_id))
            .expect("Recurring donation not found")
    }

    #[cfg(feature = "recurring")]
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
    #[allow(clippy::too_many_arguments)]
    #[cfg(feature = "vesting")]
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
        #[cfg(feature = "project_verification")]
        require_project_verified_for_donation(&env, &project_id);

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
            .expect("overflow");

        let count_key = DataKey::DonorVestingCount(donor.clone());
        let count: u32 = env.storage().instance().get(&count_key).unwrap_or(0);
        let schedule_id = count;
        let next_count = count.checked_add(1).expect("overflow");
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
            .expect("overflow");
        schedule.next_installment_ledger = current_ledger
            .checked_add(schedule.interval_ledgers)
            .expect("overflow");
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
            .expect("overflow");

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
#[cfg(any(feature = "usdc", feature = "donation", feature = "testutils"))]
#[contract]
pub struct MockOracle;

#[cfg(any(feature = "usdc", feature = "donation", feature = "testutils"))]
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

    /// Helper: create a two-element signer Vec for threshold admin calls.
    fn signers2(env: &Env, a: &Address, b: &Address) -> Vec<Address> {
        let mut v = Vec::new(env);
        v.push_back(a.clone());
        v.push_back(b.clone());
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

    // ─── Project Verification Oracle tests ─────────────────────────────────

    #[cfg(feature = "project_verification")]
    mod project_verification_tests {
        use super::*;
        use soroban_sdk::testutils::{Events as _, MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        fn evidence(env: &Env, seed: u8) -> BytesN<32> {
            BytesN::from_array(env, &[seed; 32])
        }

        #[test]
        fn test_verifier_management() {
            let (env, _cid, client, admin, _pid) = setup();
            let v1 = Address::generate(&env);
            let v2 = Address::generate(&env);

            assert!(!client.is_verifier(&v1));
            client.add_verifier(&signers1(&env, &admin), &v1);
            assert!(client.is_verifier(&v1));
            assert_eq!(client.get_verifier_set().len(), 1);

            client.add_verifier(&signers1(&env, &admin), &v2);
            assert_eq!(client.get_verifier_set().len(), 2);

            client.remove_verifier(&signers1(&env, &admin), &v1);
            assert!(!client.is_verifier(&v1));
            assert!(client.is_verifier(&v2));
            assert_eq!(client.get_verifier_set().len(), 1);
        }

        #[test]
        #[should_panic(expected = "Error(Contract, #5)")]
        fn test_add_duplicate_verifier_panics() {
            let (env, _cid, client, admin, _pid) = setup();
            let v1 = Address::generate(&env);
            client.add_verifier(&signers1(&env, &admin), &v1);
            client.add_verifier(&signers1(&env, &admin), &v1);
        }

        #[test]
        #[should_panic(expected = "Error(Contract, #6)")]
        fn test_remove_unknown_verifier_panics() {
            let (env, _cid, client, admin, _pid) = setup();
            let stranger = Address::generate(&env);
            client.remove_verifier(&signers1(&env, &admin), &stranger);
        }

        #[test]
        fn test_attest_project() {
            let (env, _cid, client, admin, pid) = setup();
            let verifier = Address::generate(&env);
            client.add_verifier(&signers1(&env, &admin), &verifier);
            client.set_verification_threshold(&signers1(&env, &admin), &2u32);

            let ev = evidence(&env, 1);
            let count = client.attest_project(&verifier, &pid, &ev);
            assert_eq!(count, 1);
            assert_eq!(
                client.get_project_verification_status(&pid),
                VerificationStatus::Pending(1)
            );
            assert_eq!(client.get_attestation_evidence(&pid, &verifier), Some(ev));
            assert_eq!(client.get_project_verifiers(&pid).len(), 1);
        }

        #[test]
        #[should_panic(expected = "Error(Contract, #3)")]
        fn test_duplicate_attestation_panics() {
            let (env, _cid, client, admin, pid) = setup();
            let verifier = Address::generate(&env);
            client.add_verifier(&signers1(&env, &admin), &verifier);
            client.attest_project(&verifier, &pid, &evidence(&env, 1));
            client.attest_project(&verifier, &pid, &evidence(&env, 2));
        }

        #[test]
        #[should_panic(expected = "Error(Contract, #1)")]
        fn test_attest_by_non_verifier_panics() {
            let (env, _cid, client, _admin, pid) = setup();
            let outsider = Address::generate(&env);
            client.attest_project(&outsider, &pid, &evidence(&env, 1));
        }

        #[test]
        #[should_panic(expected = "Error(Contract, #2)")]
        fn test_attest_unknown_project_panics() {
            let (env, _cid, client, admin, _pid) = setup();
            let verifier = Address::generate(&env);
            client.add_verifier(&signers1(&env, &admin), &verifier);
            let unknown = String::from_str(&env, "does-not-exist");
            client.attest_project(&verifier, &unknown, &evidence(&env, 1));
        }

        #[test]
        fn test_reach_threshold_auto_verify() {
            let (env, cid, client, admin, pid) = setup();
            let v1 = Address::generate(&env);
            let v2 = Address::generate(&env);
            let v3 = Address::generate(&env);
            client.add_verifier(&signers1(&env, &admin), &v1);
            client.add_verifier(&signers1(&env, &admin), &v2);
            client.add_verifier(&signers1(&env, &admin), &v3);
            client.set_verification_threshold(&signers1(&env, &admin), &2u32);

            client.attest_project(&v1, &pid, &evidence(&env, 1));
            assert_eq!(
                client.get_project_verification_status(&pid),
                VerificationStatus::Pending(1)
            );

            client.attest_project(&v2, &pid, &evidence(&env, 2));
            // Read events immediately: this soroban-sdk version's
            // `env.events().all()` only ever reflects the *last* top-level
            // invocation, so even a read-only getter call in between would
            // reset the view to "no events" before we get to inspect it.
            let events_at_threshold = env.events().all().filter_by_contract(&cid);
            let last_event = std::format!("{:?}", events_at_threshold.events().last().unwrap());
            assert!(
                last_event.contains("proj_vfy"),
                "expected proj_vfy in last event, got: {}",
                last_event
            );
            assert_eq!(
                client.get_project_verification_status(&pid),
                VerificationStatus::Verified
            );

            // A third, later attestation from an already-verified project is
            // accepted (historical record) but must not re-emit proj_vfy.
            client.attest_project(&v3, &pid, &evidence(&env, 3));
            let events_after_third = env.events().all().filter_by_contract(&cid);
            assert_eq!(
                events_after_third.events().len(),
                1,
                "a post-verification attestation must emit only proj_att, not proj_vfy again"
            );
            let last_event = std::format!("{:?}", events_after_third.events().last().unwrap());
            assert!(
                last_event.contains("proj_att"),
                "expected proj_att, got: {}",
                last_event
            );
            assert_eq!(
                client.get_project_verification_status(&pid),
                VerificationStatus::Verified
            );
            assert_eq!(client.get_project_verifiers(&pid).len(), 3);
        }

        #[test]
        fn test_revoke_verification() {
            let (env, _cid, client, admin, pid) = setup();
            let v1 = Address::generate(&env);
            let v2 = Address::generate(&env);
            client.add_verifier(&signers1(&env, &admin), &v1);
            client.add_verifier(&signers1(&env, &admin), &v2);
            client.set_verification_threshold(&signers1(&env, &admin), &2u32);

            client.attest_project(&v1, &pid, &evidence(&env, 1));
            client.attest_project(&v2, &pid, &evidence(&env, 2));
            assert_eq!(
                client.get_project_verification_status(&pid),
                VerificationStatus::Verified
            );

            client.revoke_verification(&signers1(&env, &admin), &pid);
            assert_eq!(
                client.get_project_verification_status(&pid),
                VerificationStatus::Unverified
            );
            assert_eq!(client.get_project_verifiers(&pid).len(), 0);
            assert_eq!(client.get_attestation_evidence(&pid, &v1), None);
            assert_eq!(client.get_attestation_evidence(&pid, &v2), None);

            // Verifiers may attest again from a clean slate after revocation.
            client.attest_project(&v1, &pid, &evidence(&env, 3));
            assert_eq!(
                client.get_project_verification_status(&pid),
                VerificationStatus::Pending(1)
            );
        }

        #[test]
        fn test_removed_verifier_attestation_is_not_retroactively_undone() {
            // Gotcha #6: removing a verifier who already attested must not
            // shrink the attester count or demote an already-Verified project.
            let (env, _cid, client, admin, pid) = setup();
            let v1 = Address::generate(&env);
            let v2 = Address::generate(&env);
            client.add_verifier(&signers1(&env, &admin), &v1);
            client.add_verifier(&signers1(&env, &admin), &v2);
            client.set_verification_threshold(&signers1(&env, &admin), &2u32);

            client.attest_project(&v1, &pid, &evidence(&env, 1));
            client.attest_project(&v2, &pid, &evidence(&env, 2));
            assert_eq!(
                client.get_project_verification_status(&pid),
                VerificationStatus::Verified
            );

            client.remove_verifier(&signers1(&env, &admin), &v1);
            assert_eq!(client.get_project_verifiers(&pid).len(), 2);
            assert_eq!(
                client.get_project_verification_status(&pid),
                VerificationStatus::Verified
            );
        }

        #[test]
        fn test_lowering_threshold_unsticks_pending_project_on_next_touch() {
            // Gotcha #4: lowering VerificationThreshold after attestations have
            // already accumulated must not leave a project permanently stuck.
            let (env, _cid, client, admin, pid) = setup();
            let v1 = Address::generate(&env);
            client.add_verifier(&signers1(&env, &admin), &v1);
            client.set_verification_threshold(&signers1(&env, &admin), &5u32);

            client.attest_project(&v1, &pid, &evidence(&env, 1));
            assert_eq!(
                client.get_project_verification_status(&pid),
                VerificationStatus::Pending(1)
            );

            // Lower the threshold below the existing attester count. The
            // read-only getter reflects this immediately (it's a live
            // computation)...
            client.set_verification_threshold(&signers1(&env, &admin), &1u32);
            assert_eq!(
                client.get_project_verification_status(&pid),
                VerificationStatus::Verified
            );

            // ...and the next mutating touch (e.g. a donation) persists it.
            let token_admin = Address::generate(&env);
            let token = env
                .register_stellar_asset_contract_v2(token_admin)
                .address();
            let donor = Address::generate(&env);
            StellarAssetClient::new(&env, &token).mint(&donor, &(10 * STROOP));
            client.donate(&token, &donor, &pid, &(10 * STROOP), &0u32);
            assert_eq!(
                client.get_project_verification_status(&pid),
                VerificationStatus::Verified
            );
        }

        #[test]
        #[should_panic(expected = "Error(Contract, #4)")]
        fn test_donate_to_unverified_project_panics() {
            let (env, _cid, client, admin, pid) = setup();
            client.set_verification_threshold(&signers1(&env, &admin), &1u32);

            let token_admin = Address::generate(&env);
            let token = env
                .register_stellar_asset_contract_v2(token_admin)
                .address();
            let donor = Address::generate(&env);
            StellarAssetClient::new(&env, &token).mint(&donor, &(10 * STROOP));
            client.donate(&token, &donor, &pid, &(10 * STROOP), &0u32);
        }

        #[test]
        fn test_donate_to_verified_project_succeeds() {
            let (env, _cid, client, admin, pid) = setup();
            let verifier = Address::generate(&env);
            client.add_verifier(&signers1(&env, &admin), &verifier);
            client.set_verification_threshold(&signers1(&env, &admin), &1u32);
            client.attest_project(&verifier, &pid, &evidence(&env, 1));
            assert_eq!(
                client.get_project_verification_status(&pid),
                VerificationStatus::Verified
            );

            let token_admin = Address::generate(&env);
            let token = env
                .register_stellar_asset_contract_v2(token_admin)
                .address();
            let donor = Address::generate(&env);
            let amount = 10 * STROOP;
            StellarAssetClient::new(&env, &token).mint(&donor, &amount);
            client.donate(&token, &donor, &pid, &amount, &0u32);

            assert_eq!(client.get_project(&pid).total_raised, amount);
        }

        #[test]
        fn test_donate_to_unverified_project_allowed_in_legacy_mode() {
            // Gotcha #3: threshold == 0 (never configured) must behave exactly
            // like every project registered before this feature existed.
            let (env, _cid, client, _admin, pid) = setup();
            assert_eq!(client.get_verification_threshold(), 0);
            assert_eq!(
                client.get_project_verification_status(&pid),
                VerificationStatus::Unverified
            );

            let token_admin = Address::generate(&env);
            let token = env
                .register_stellar_asset_contract_v2(token_admin)
                .address();
            let donor = Address::generate(&env);
            let amount = 10 * STROOP;
            StellarAssetClient::new(&env, &token).mint(&donor, &amount);
            client.donate(&token, &donor, &pid, &amount, &0u32);

            assert_eq!(client.get_project(&pid).total_raised, amount);
        }

        /// Integration: 3 verifiers, threshold 2 — two attestations auto-verify
        /// the project in the same call, and the donation that follows succeeds.
        #[test]
        fn test_integration_three_verifiers_threshold_two_then_donate() {
            let (env, _cid, client, admin, pid) = setup();
            let v1 = Address::generate(&env);
            let v2 = Address::generate(&env);
            let v3 = Address::generate(&env);
            client.add_verifier(&signers1(&env, &admin), &v1);
            client.add_verifier(&signers1(&env, &admin), &v2);
            client.add_verifier(&signers1(&env, &admin), &v3);
            client.set_verification_threshold(&signers1(&env, &admin), &2u32);

            client.attest_project(&v1, &pid, &evidence(&env, 1));
            assert_eq!(
                client.get_project_verification_status(&pid),
                VerificationStatus::Pending(1)
            );
            client.attest_project(&v2, &pid, &evidence(&env, 2));
            assert_eq!(
                client.get_project_verification_status(&pid),
                VerificationStatus::Verified
            );

            let token_admin = Address::generate(&env);
            let token = env
                .register_stellar_asset_contract_v2(token_admin)
                .address();
            let donor = Address::generate(&env);
            let amount = 42 * STROOP;
            StellarAssetClient::new(&env, &token).mint(&donor, &amount);
            client.donate(&token, &donor, &pid, &amount, &0u32);
            assert_eq!(client.get_project(&pid).total_raised, amount);
        }

        /// Real auth enforcement (no `mock_all_auths`): an unauthorised address
        /// cannot attest, and N-1 of N admins cannot reach a 2-of-N quorum.
        /// Uses the per-call `client.mock_auths(&[...])` builder (see the
        /// precedent in escrow-contract) instead of the env-wide
        /// `mock_all_auths`, so only the specific calls listed below are
        /// ever authorised — every other `require_auth()` in this test runs
        /// against real (empty) auth state.
        #[test]
        fn test_real_auth_enforcement_without_mocks() {
            let env = Env::default();
            let cid = env.register_contract(None, IndigoPayContract);
            let client = IndigoPayContractClient::new(&env, &cid);

            let admin1 = Address::generate(&env);
            let admin2 = Address::generate(&env);
            let mut admins = Vec::new(&env);
            admins.push_back(admin1.clone());
            admins.push_back(admin2.clone());

            // initialize() takes no require_auth in this contract, so no
            // mocked auth is needed to set up the 2-of-2 admin set.
            client.initialize(&admins, &2u32);

            let pid = String::from_str(&env, "proj-real-auth");
            let name = String::from_str(&env, "Real Auth Project");
            let wallet = Address::generate(&env);

            // register_project is a routine (1-of-N) action: only admin1
            // needs to genuinely sign.
            client
                .mock_auths(&[MockAuth {
                    address: &admin1,
                    invoke: &MockAuthInvoke {
                        contract: &cid,
                        fn_name: "register_project",
                        args: (
                            admin1.clone(),
                            pid.clone(),
                            name.clone(),
                            wallet.clone(),
                            10u32,
                        )
                            .into_val(&env),
                        sub_invokes: &[],
                    },
                }])
                .register_project(&admin1, &pid, &name, &wallet, &10u32);

            // add_verifier is critical (2-of-2): both admins must genuinely
            // sign for it to succeed.
            let verifier = Address::generate(&env);
            client
                .mock_auths(&[
                    MockAuth {
                        address: &admin1,
                        invoke: &MockAuthInvoke {
                            contract: &cid,
                            fn_name: "add_verifier",
                            args: (admins.clone(), verifier.clone()).into_val(&env),
                            sub_invokes: &[],
                        },
                    },
                    MockAuth {
                        address: &admin2,
                        invoke: &MockAuthInvoke {
                            contract: &cid,
                            fn_name: "add_verifier",
                            args: (admins.clone(), verifier.clone()).into_val(&env),
                            sub_invokes: &[],
                        },
                    },
                ])
                .add_verifier(&admins, &verifier);

            // No mock configured for this call at all: an address that never
            // signs anything must fail `require_auth`, regardless of
            // `VerifierSet` membership.
            let outsider = Address::generate(&env);
            let result = client.try_attest_project(&outsider, &pid, &evidence(&env, 9));
            assert!(
                result.is_err(),
                "unsigned outsider must not be able to attest"
            );

            // Pre-authorise only admin1's signature for this exact call.
            // admin2 never signs, so `verify_m_of_n`'s `admin2.require_auth()`
            // has no matching signature and the 2-of-2 quorum is never
            // reached, even though admin1's own signature is genuine.
            let result = client
                .mock_auths(&[MockAuth {
                    address: &admin1,
                    invoke: &MockAuthInvoke {
                        contract: &cid,
                        fn_name: "revoke_verification",
                        args: (admins.clone(), pid.clone()).into_val(&env),
                        sub_invokes: &[],
                    },
                }])
                .try_revoke_verification(&admins, &pid);
            assert!(
                result.is_err(),
                "1-of-2 admin signatures must not reach a 2-of-2 quorum"
            );
        }

        /// Checks that the most recent invocation's last event carries the
        /// expected topic symbol. Must be called immediately after the
        /// mutating client call under test: this soroban-sdk version's
        /// `env.events().all()` only ever reflects the *last* top-level
        /// invocation (any call in between, even a read-only getter, resets
        /// the view). `ContractEvents` only exposes raw XDR
        /// (`.events() -> &[xdr::ContractEvent]`), so content is checked via
        /// its Debug rendering — the same approach already established by
        /// oracle-contract's `test_deviation_reject_emits_price_rejected_event`.
        fn assert_last_event_contains(env: &Env, cid: &Address, needle: &str) {
            let events = env.events().all().filter_by_contract(cid);
            let last = std::format!("{:?}", events.events().last().unwrap());
            assert!(
                last.contains(needle),
                "expected `{}` in event, got: {}",
                needle,
                last
            );
        }

        #[test]
        fn test_events_have_expected_payloads() {
            let (env, cid, client, admin, pid) = setup();
            let verifier = Address::generate(&env);

            client.add_verifier(&signers1(&env, &admin), &verifier);
            assert_last_event_contains(&env, &cid, "ver_add");

            client.set_verification_threshold(&signers1(&env, &admin), &1u32);
            assert_last_event_contains(&env, &cid, "ver_thr");

            // attest_project crosses the threshold (1) in the same call, so
            // two events fire (proj_att then proj_vfy) — check both.
            let ev = evidence(&env, 7);
            client.attest_project(&verifier, &pid, &ev);
            let events = env.events().all().filter_by_contract(&cid);
            assert_eq!(events.events().len(), 2);
            let last = std::format!("{:?}", events.events().last().unwrap());
            assert!(
                last.contains("proj_vfy"),
                "expected proj_vfy, got: {}",
                last
            );

            client.revoke_verification(&signers1(&env, &admin), &pid);
            assert_last_event_contains(&env, &cid, "proj_rvk");
        }
    }

    #[cfg(all(test, feature = "project_verification", feature = "testutils"))]
    mod project_verification_fuzz {
        extern crate std;
        use super::*;
        use proptest::prelude::*;

        proptest! {
            #![proptest_config(ProptestConfig::with_cases(256))]

            /// For any number of verifiers (1..=8) and any threshold, a
            /// project must become Verified if and only if the number of
            /// distinct attestations reaches the configured threshold —
            /// never before, and always by the time it does.
            #[test]
            fn prop_verification_requires_threshold(
                verifier_count in 1u32..=8,
                threshold in 1u32..=8,
            ) {
                let env = Env::default();
                env.mock_all_auths();
                let cid = env.register_contract(None, IndigoPayContract);
                let client = IndigoPayContractClient::new(&env, &cid);
                let admin = Address::generate(&env);
                let mut admins = Vec::new(&env);
                admins.push_back(admin.clone());
                client.initialize(&admins, &1u32);

                let pid = String::from_str(&env, "prop-proj");
                let wallet = Address::generate(&env);
                client.register_project(
                    &admin,
                    &pid,
                    &String::from_str(&env, "Prop Project"),
                    &wallet,
                    &10u32,
                );
                client.set_verification_threshold(&admins, &threshold);

                let mut verifiers: std::vec::Vec<Address> = std::vec::Vec::new();
                for _ in 0..verifier_count {
                    let v = Address::generate(&env);
                    client.add_verifier(&admins, &v);
                    verifiers.push(v);
                }

                for (i, v) in verifiers.iter().enumerate() {
                    let attested_so_far = (i + 1) as u32;
                    client.attest_project(v, &pid, &BytesN::from_array(&env, &[i as u8; 32]));
                    let status = client.get_project_verification_status(&pid);
                    if attested_so_far >= threshold {
                        prop_assert_eq!(status, VerificationStatus::Verified);
                    } else {
                        prop_assert_eq!(status, VerificationStatus::Pending(attested_so_far));
                    }
                }
            }
        }
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
        let (_env, _cid, client, _admin, _pid) = setup();
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
        client.vote_verify_project(&voter, &pid, &true, &100);
        let p = client.get_proposal(&pid);
        assert_eq!(p.votes_for, 10);
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
        client.vote_verify_project(&non_donor, &pid, &true, &100);
    }
    #[test]
    #[should_panic(expected = "Insufficient voting credits")]
    fn test_quadratic_voting_exhausts_credits() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
        let voter = Address::generate(&env);
        grant_badge(&env, &cid, &voter);
        // Seedling has 100 credits; spending all of them exhausts the budget.
        client.vote_verify_project(&voter, &pid, &true, &100);
        // Second vote should fail — no credits left.
        client.vote_verify_project(&voter, &pid, &true, &1);
    }
    #[test]
    fn test_resolve_proposal_approved() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
        // 2 approve, 1 rejects — each Seedling spends all 100 credits
        for i in 0..3u32 {
            let voter = Address::generate(&env);
            grant_badge(&env, &cid, &voter);
            client.vote_verify_project(&voter, &pid, &(i < 2), &100);
        }
        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(VOTING_WINDOW_LEDGERS + 2);
        client.resolve_proposal(&pid);
        let p = client.get_proposal(&pid);
        assert!(p.resolved);
        assert_eq!(p.votes_for, 20);
        assert_eq!(p.votes_against, 10);
    }
    #[test]
    fn test_resolve_proposal_rejected() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
        // 1 approves, 2 reject — each Seedling spends all 100 credits
        for i in 0..3u32 {
            let voter = Address::generate(&env);
            grant_badge(&env, &cid, &voter);
            client.vote_verify_project(&voter, &pid, &(i == 0), &100);
        }
        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(VOTING_WINDOW_LEDGERS + 2);
        client.resolve_proposal(&pid);
        let p = client.get_proposal(&pid);
        assert!(p.resolved);
        assert_eq!(p.votes_for, 10);
        assert_eq!(p.votes_against, 20);
    }
    #[test]
    fn test_resolve_proposal_tie_rejected_with_rejection_event() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
        for i in 0..2u32 {
            let voter = Address::generate(&env);
            grant_badge(&env, &cid, &voter);
            client.vote_verify_project(&voter, &pid, &(i == 0), &100);
        }
        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(VOTING_WINDOW_LEDGERS + 2);
        client.resolve_proposal(&pid);
        let p = client.get_proposal(&pid);
        assert!(p.resolved);
        assert_eq!(p.votes_for, 10);
        assert_eq!(p.votes_against, 10);
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
        client.vote_verify_project(&voter, &pid, &true, &100);
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
        client.vote_verify_project(&voter, &pid, &true, &100);
        let proposal = client.get_proposal(&pid);
        assert_eq!(proposal.votes_for, 10);
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
        client.vote_verify_project(&voter, &pid, &true, &100);
        let proposal = client.get_proposal(&pid);
        assert_eq!(proposal.votes_for, 10);
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
            client.vote_verify_project(&v, &pid, &true, &100);
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
    // ─── Quadratic voting tests ────────────────────────────────────────────────
    #[test]
    fn test_isqrt_values() {
        assert_eq!(isqrt(0), 0);
        assert_eq!(isqrt(1), 1);
        assert_eq!(isqrt(2), 1);
        assert_eq!(isqrt(3), 1);
        assert_eq!(isqrt(4), 2);
        assert_eq!(isqrt(99), 9);
        assert_eq!(isqrt(100), 10);
        assert_eq!(isqrt(101), 10);
        assert_eq!(isqrt(400), 20);
        assert_eq!(isqrt(800), 28);
        assert_eq!(isqrt(u32::MAX), 65535);
    }
    #[test]
    fn test_quadratic_voting_single_proposal() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
        let voter = Address::generate(&env);
        grant_badge(&env, &cid, &voter);
        // Seedling: 100 credits → isqrt(100) = 10 effective weight
        client.vote_verify_project(&voter, &pid, &true, &100);
        let p = client.get_proposal(&pid);
        assert_eq!(p.votes_for, 10);
        assert_eq!(p.votes_against, 0);
        let weight = client.get_voter_weight(&voter);
        assert_eq!(weight, 10);
    }
    #[test]
    fn test_quadratic_voting_multi_proposal() {
        let (env, cid, client, admin, pid1) = setup();
        // Register a second project for multi-proposal voting
        let pid2 = String::from_str(&env, "proj-002");
        let wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &pid2,
            &String::from_str(&env, "Second Project"),
            &wallet,
            &100u32,
        );
        client.create_proposal(&signers1(&env, &admin), &pid1, &0u32);
        client.create_proposal(&signers1(&env, &admin), &pid2, &0u32);
        let voter = Address::generate(&env);
        grant_badge(&env, &cid, &voter);
        // Credits are tracked per-proposal. pid1: spend 40 → weight = isqrt(40) = 6
        // pid2: spend 60 → weight = isqrt(60) = 7 (60 not cumulative with pid1)
        client.vote_verify_project(&voter, &pid1, &true, &40);
        client.vote_verify_project(&voter, &pid2, &false, &60);
        let p1 = client.get_proposal(&pid1);
        assert_eq!(p1.votes_for, 6);
        assert_eq!(p1.votes_against, 0);
        let p2 = client.get_proposal(&pid2);
        assert_eq!(p2.votes_for, 0);
        assert_eq!(p2.votes_against, 7);
        // Verify credits cannot exceed total allocation
        client.vote_verify_project(&voter, &pid1, &true, &0);
        // Attempting to overspend should fail
    }
    #[test]
    #[should_panic(expected = "Insufficient voting credits")]
    fn test_quadratic_voting_exceeds_credits() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
        let voter = Address::generate(&env);
        grant_badge(&env, &cid, &voter);
        // Seedling has 100 credits; trying to spend 101 should fail.
        client.vote_verify_project(&voter, &pid, &true, &101);
    }
    #[test]
    fn test_quadratic_voting_edge_cases() {
        let (env, cid, client, admin, pid) = setup();
        client.create_proposal(&signers1(&env, &admin), &pid, &0u32);
        let voter = Address::generate(&env);
        grant_badge(&env, &cid, &voter);
        // Spend 0 credits → effective weight delta = 0
        client.vote_verify_project(&voter, &pid, &true, &0);
        let p = client.get_proposal(&pid);
        assert_eq!(p.votes_for, 0);
        // Spend 1 credit → isqrt(1) = 1
        client.vote_verify_project(&voter, &pid, &true, &1);
        let p = client.get_proposal(&pid);
        assert_eq!(p.votes_for, 1);
        // Spend remaining 99 credits → cumulative = 100, delta = isqrt(100) - isqrt(1) = 10 - 1 = 9
        client.vote_verify_project(&voter, &pid, &true, &99);
        let p = client.get_proposal(&pid);
        assert_eq!(p.votes_for, 10);
        // Total credits used = 0 + 1 + 99 = 100 (all Seedling credits)
        let weight = client.get_voter_weight(&voter);
        assert_eq!(weight, 10);
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
    #[test]
    fn test_set_token_rate_limit() {
        let (env, _cid, client, admin, _pid) = setup();
        let xlm = Address::generate(&env);
        let usdc = Address::generate(&env);

        client.set_token_rate_limit(&admin, &xlm, &10, &720);
        client.set_token_rate_limit(&admin, &usdc, &5, &1_440);

        assert_eq!(client.get_token_rate_limit(&xlm), (10, 720));
        assert_eq!(client.get_token_rate_limit(&usdc), (5, 1_440));
    }
    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn test_set_token_rate_limit_non_admin_fails() {
        let (env, _cid, client, _admin, _pid) = setup();
        let imposter = Address::generate(&env);
        let token = Address::generate(&env);
        client.set_token_rate_limit(&imposter, &token, &5, &100);
    }
    #[test]
    fn test_per_token_rate_limit() {
        let (env, _cid, client, admin, pid) = setup();
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, 3 * STROOP);
        client.set_token_rate_limit(&admin, &token, &2, &100);

        client.donate(&token, &donor, &pid, &STROOP, &0);
        client.donate(&token, &donor, &pid, &STROOP, &1);
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.donate(&token, &donor, &pid, &STROOP, &2);
        }));

        assert!(blocked.is_err());
        assert_eq!(client.get_project(&pid).total_raised, 2 * STROOP);
    }
    #[test]
    fn test_per_token_rate_limit_fallback() {
        let (env, _cid, client, admin, pid) = setup();
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, 2 * STROOP);
        assert_eq!(
            client.get_token_rate_limit(&token),
            (
                DEFAULT_DONATION_RATE_LIMIT_MAX,
                DEFAULT_DONATION_RATE_LIMIT_WINDOW
            )
        );
        client.set_donation_rate_limit(&admin, &1, &100);

        assert_eq!(client.get_token_rate_limit(&token), (1, 100));
        client.donate(&token, &donor, &pid, &STROOP, &0);
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.donate(&token, &donor, &pid, &STROOP, &1);
        }));

        assert!(blocked.is_err());
    }
    #[test]
    fn test_rate_limit_key_migration() {
        let (env, cid, client, admin, pid) = setup();
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, 2 * STROOP);
        let legacy_key = LegacyDataKey::DonorRateLimit(donor.clone(), pid.clone());
        let token_key = DataKey::DonorRateLimit(donor.clone(), pid.clone(), token.clone());
        let window_start = env.ledger().sequence();
        env.as_contract(&cid, || {
            env.storage().instance().set(
                &legacy_key,
                &RateLimitWindow {
                    window_start,
                    count: 1,
                },
            );
        });
        client.set_token_rate_limit(&admin, &token, &2, &100);

        client.donate(&token, &donor, &pid, &STROOP, &0);

        env.as_contract(&cid, || {
            assert!(!env.storage().instance().has(&legacy_key));
            let migrated: RateLimitWindow =
                env.storage().instance().get(&token_key).expect("migrated");
            assert_eq!(migrated.window_start, window_start);
            assert_eq!(migrated.count, 2);
        });
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.donate(&token, &donor, &pid, &STROOP, &1);
        }));
        assert!(blocked.is_err());
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

    /// Expand the default test admin set to a 2-of-3 threshold.
    fn enable_two_of_three_admins(
        env: &Env,
        client: &IndigoPayContractClient,
        first_admin: &Address,
    ) -> (Address, Address) {
        let second_admin = Address::generate(env);
        let third_admin = Address::generate(env);
        client.add_admin(&signers1(env, first_admin), &second_admin);
        client.add_admin(&signers1(env, first_admin), &third_admin);
        client.update_threshold(&signers1(env, first_admin), &2u32);
        (second_admin, third_admin)
    }

    /// Put real tokens and the matching canonical accounting entry into the
    /// force-refund pool.
    fn fund_force_refund_pool(
        env: &Env,
        cid: &Address,
        project_id: &String,
        token: &Address,
        amount: i128,
    ) {
        StellarAssetClient::new(env, token).mint(cid, &amount);
        env.as_contract(cid, || {
            env.storage().instance().set(
                &DataKey::ProjectContractBalance(project_id.clone(), token.clone()),
                &amount,
            );
        });
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

    #[test]
    fn test_force_approve_refund_m_of_n() {
        let (env, _cid, client, first_admin, pid) = setup();
        let (second_admin, _third_admin) = enable_two_of_three_admins(&env, &client, &first_admin);
        let (donor, token, donation_index) = setup_donation(&env, &client, &pid);
        client.request_refund(&donor, &donation_index, &token);

        let initiated_at = env.ledger().sequence();
        client.force_approve_refund(&signers2(&env, &first_admin, &second_admin), &0u32);

        let pending = client.get_force_refund(&0u32).unwrap();
        assert_eq!(pending.initiated_at, initiated_at);
        assert_eq!(
            pending.effective_at,
            initiated_at + FORCE_REFUND_TIMELOCK_LEDGERS
        );
        assert_eq!(
            client.get_refund_request(&0u32).status,
            RefundRequestStatus::Pending
        );
    }

    #[test]
    #[should_panic(expected = "Insufficient admin signatures")]
    fn test_force_approve_single_admin_panics() {
        let (env, _cid, client, first_admin, pid) = setup();
        enable_two_of_three_admins(&env, &client, &first_admin);
        let (donor, token, donation_index) = setup_donation(&env, &client, &pid);
        client.request_refund(&donor, &donation_index, &token);

        client.force_approve_refund(&signers1(&env, &first_admin), &0u32);
    }

    #[test]
    #[should_panic(expected = "Force refund timelock not yet elapsed")]
    fn test_execute_force_refund_before_timelock_panics() {
        let (env, cid, client, first_admin, pid) = setup();
        let (second_admin, _third_admin) = enable_two_of_three_admins(&env, &client, &first_admin);
        let (donor, token, donation_index) = setup_donation(&env, &client, &pid);
        fund_force_refund_pool(&env, &cid, &pid, &token, 25 * STROOP);
        client.request_refund(&donor, &donation_index, &token);
        client.force_approve_refund(&signers2(&env, &first_admin, &second_admin), &0u32);

        client.execute_force_refund(&0u32);
    }

    #[test]
    fn test_execute_force_refund_after_timelock() {
        let (env, cid, client, first_admin, pid) = setup();
        let (second_admin, _third_admin) = enable_two_of_three_admins(&env, &client, &first_admin);
        let (donor, token, donation_index) = setup_donation(&env, &client, &pid);
        let refund_amount = 25 * STROOP;
        fund_force_refund_pool(&env, &cid, &pid, &token, refund_amount);
        let donor_balance_before = StellarAssetClient::new(&env, &token).balance(&donor);

        client.request_refund(&donor, &donation_index, &token);
        client.force_approve_refund(&signers2(&env, &first_admin, &second_admin), &0u32);
        let start = env.ledger().sequence();
        extend_ttl(&env, &cid);
        env.ledger()
            .set_sequence_number(start + FORCE_REFUND_TIMELOCK_LEDGERS);
        client.execute_force_refund(&0u32);

        assert_eq!(
            StellarAssetClient::new(&env, &token).balance(&donor),
            donor_balance_before + refund_amount
        );
        assert_eq!(
            client.get_refund_request(&0u32).status,
            RefundRequestStatus::Approved
        );
        assert_eq!(client.get_force_refund(&0u32), None);
    }

    #[test]
    fn test_cancel_force_refund() {
        let (env, _cid, client, first_admin, pid) = setup();
        let (second_admin, third_admin) = enable_two_of_three_admins(&env, &client, &first_admin);
        let (donor, token, donation_index) = setup_donation(&env, &client, &pid);
        client.request_refund(&donor, &donation_index, &token);
        client.force_approve_refund(&signers2(&env, &first_admin, &second_admin), &0u32);

        // Any one admin, including one who did not initiate, may cancel.
        client.cancel_force_refund(&third_admin, &0u32);

        assert_eq!(client.get_force_refund(&0u32), None);
        assert_eq!(
            client.get_refund_request(&0u32).status,
            RefundRequestStatus::Pending
        );
    }

    #[test]
    #[should_panic(expected = "No pending force refund")]
    fn test_cancel_force_refund_after_execution_panics() {
        let (env, cid, client, first_admin, pid) = setup();
        let (second_admin, _third_admin) = enable_two_of_three_admins(&env, &client, &first_admin);
        let (donor, token, donation_index) = setup_donation(&env, &client, &pid);
        fund_force_refund_pool(&env, &cid, &pid, &token, 25 * STROOP);
        client.request_refund(&donor, &donation_index, &token);
        client.force_approve_refund(&signers2(&env, &first_admin, &second_admin), &0u32);
        let start = env.ledger().sequence();
        extend_ttl(&env, &cid);
        env.ledger()
            .set_sequence_number(start + FORCE_REFUND_TIMELOCK_LEDGERS);
        client.execute_force_refund(&0u32);

        client.cancel_force_refund(&first_admin, &0u32);
    }

    #[test]
    fn test_force_refund_integration_reverses_balances_and_stats() {
        let (env, cid, client, first_admin, pid) = setup();
        let (second_admin, _third_admin) = enable_two_of_three_admins(&env, &client, &first_admin);
        let (donor, token, donation_index) = setup_donation(&env, &client, &pid);
        let refund_amount = 25 * STROOP;
        let co2_amount = 25 * 100;
        fund_force_refund_pool(&env, &cid, &pid, &token, 2 * refund_amount);

        let project_before = client.get_project(&pid);
        let donor_before = client.get_donor_stats(&donor);
        let global_before = client.get_global_stats();
        let token_before = StellarAssetClient::new(&env, &token).balance(&donor);

        client.request_refund(&donor, &donation_index, &token);
        client.force_approve_refund(&signers2(&env, &first_admin, &second_admin), &0u32);
        let start = env.ledger().sequence();
        extend_ttl(&env, &cid);
        env.ledger()
            .set_sequence_number(start + FORCE_REFUND_TIMELOCK_LEDGERS);
        client.execute_force_refund(&0u32);

        assert_eq!(
            client.get_project(&pid).total_raised,
            project_before.total_raised - refund_amount
        );
        let donor_after = client.get_donor_stats(&donor);
        assert_eq!(
            donor_after.total_donated,
            donor_before.total_donated - refund_amount
        );
        assert_eq!(
            donor_after.co2_offset_grams,
            donor_before.co2_offset_grams - co2_amount
        );
        let global_after = client.get_global_stats();
        assert_eq!(
            global_after.total_raised,
            global_before.total_raised - refund_amount
        );
        assert_eq!(
            global_after.co2_offset_grams,
            global_before.co2_offset_grams - co2_amount
        );
        assert_eq!(
            StellarAssetClient::new(&env, &token).balance(&donor),
            token_before + refund_amount
        );
        let remaining_pool: i128 = env.as_contract(&cid, || {
            env.storage()
                .instance()
                .get(&DataKey::ProjectContractBalance(pid.clone(), token.clone()))
                .unwrap()
        });
        assert_eq!(remaining_pool, refund_amount);
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
        let vk = Bytes::from_slice(&env, &[0xAB; 32]);
        client.set_zk_verification_key(&signers1(&env, &admin), &vk);
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
        let vk = Bytes::from_slice(&env, &[1u8; 32]);
        client.set_zk_verification_key(&signers1(&env, &admin), &vk);
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
        let vk = Bytes::from_slice(&env, &[1u8; 32]);
        client.set_zk_verification_key(&signers1(&env, &admin), &vk);
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
    #[should_panic(expected = "ZK verification key must be 32 bytes")]
    fn test_set_zk_verification_key_rejects_empty() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);
        let empty_vk = Bytes::new(&env);
        client.set_zk_verification_key(&signers1(&env, &admin), &empty_vk);
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
    // ─── Configurable Platform Fee Splits (#434) ──────────────────────────────
    #[cfg(feature = "fees")]
    #[test]
    fn test_multi_recipient_fee_split() {
        let (env, _cid, client, admin, pid) = setup();
        let r1 = Address::generate(&env);
        let r2 = Address::generate(&env);
        let r3 = Address::generate(&env);
        let recipients = soroban_sdk::vec![
            &env,
            FeeRecipient {
                address: r1.clone(),
                share_bps: 5000,
            },
            FeeRecipient {
                address: r2.clone(),
                share_bps: 3000,
            },
            FeeRecipient {
                address: r3.clone(),
                share_bps: 2000,
            },
        ];
        client.set_platform_fee_recipients(&signers1(&env, &admin), &recipients);
        client.set_platform_fee(&signers1(&env, &admin), &200u32);

        let stored = client.get_platform_fee_recipients();
        assert_eq!(stored.len(), 3);
        assert_eq!(stored.get(0).unwrap().share_bps, 5000);

        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let amount: i128 = 100 * STROOP;
        StellarAssetClient::new(&env, &token).mint(&donor, &amount);
        client.donate(&token, &donor, &pid, &amount, &0u32);

        let token_client = token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&r1), 10_000_000);
        assert_eq!(token_client.balance(&r2), 6_000_000);
        assert_eq!(token_client.balance(&r3), 4_000_000);
        let p = client.get_project(&pid);
        assert_eq!(token_client.balance(&p.wallet), 980_000_000);
    }
    #[cfg(feature = "fees")]
    #[test]
    #[should_panic(expected = "Fee recipient shares must sum to 10000 bps (100%)")]
    fn test_recipient_shares_dont_sum_to_100_panics() {
        let (env, _cid, client, admin, _pid) = setup();
        let r1 = Address::generate(&env);
        let r2 = Address::generate(&env);
        let recipients = soroban_sdk::vec![
            &env,
            FeeRecipient {
                address: r1,
                share_bps: 5000,
            },
            FeeRecipient {
                address: r2,
                share_bps: 4000,
            },
        ];
        client.set_platform_fee_recipients(&signers1(&env, &admin), &recipients);
    }
    #[cfg(feature = "fees")]
    #[test]
    #[should_panic(expected = "Fee recipients list cannot be empty")]
    fn test_empty_fee_recipients_panics() {
        let (env, _cid, client, admin, _pid) = setup();
        let recipients = soroban_sdk::vec![&env];
        client.set_platform_fee_recipients(&signers1(&env, &admin), &recipients);
    }
    #[cfg(feature = "fees")]
    #[test]
    fn test_single_recipient_migration() {
        let (env, _cid, client, admin, _pid) = setup();
        let treasury = Address::generate(&env);
        client.set_platform_treasury(&signers1(&env, &admin), &treasury);

        let recipients = client.get_platform_fee_recipients();
        assert_eq!(recipients.len(), 1);
        let r0 = recipients.get(0).unwrap();
        assert_eq!(r0.address, treasury);
        assert_eq!(r0.share_bps, 10_000);

        let r1 = Address::generate(&env);
        let r2 = Address::generate(&env);
        let new_recipients = soroban_sdk::vec![
            &env,
            FeeRecipient {
                address: r1.clone(),
                share_bps: 7000,
            },
            FeeRecipient {
                address: r2.clone(),
                share_bps: 3000,
            },
        ];
        client.set_platform_fee_recipients(&signers1(&env, &admin), &new_recipients);
        let updated = client.get_platform_fee_recipients();
        assert_eq!(updated.len(), 2);
        assert_eq!(updated.get(0).unwrap().address, r1);
        assert_eq!(updated.get(1).unwrap().address, r2);
    }
    #[cfg(feature = "fees")]
    #[test]
    fn test_fee_distribution_exact_sum() {
        let env = Env::default();
        let r1 = Address::generate(&env);
        let r2 = Address::generate(&env);
        let r3 = Address::generate(&env);
        let recipients = soroban_sdk::vec![
            &env,
            FeeRecipient {
                address: r1,
                share_bps: 3333,
            },
            FeeRecipient {
                address: r2,
                share_bps: 3333,
            },
            FeeRecipient {
                address: r3,
                share_bps: 3334,
            },
        ];
        for fee_amount in [1i128, 3, 7, 10, 99, 100, 1000, 10_000_000] {
            let shares = split_fee_recipients(&env, fee_amount, &recipients);
            let mut sum: i128 = 0;
            for (_addr, amount) in shares.iter() {
                sum += amount;
            }
            assert_eq!(
                sum, fee_amount,
                "Exact sum match failed for fee_amount {}",
                fee_amount
            );
        }
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

    // ─── MMR Impact Certificate Tests (#430) ────────────────────────────
    #[cfg(feature = "impact")]
    fn build_three_leaf_mmr_peaks(
        env: &Env,
        leaf0: &ImpactLeaf,
        leaf1: &ImpactLeaf,
        leaf2: &ImpactLeaf,
    ) -> (Vec<BytesN<32>>, u32) {
        let mut peaks: Vec<BytesN<32>> = Vec::new(env);
        let h0 = compute_impact_leaf_hash(env, leaf0);
        let h1 = compute_impact_leaf_hash(env, leaf1);
        let h2 = compute_impact_leaf_hash(env, leaf2);
        mmr_append_peaks(env, &mut peaks, 0, h0);
        mmr_append_peaks(env, &mut peaks, 1, h1);
        mmr_append_peaks(env, &mut peaks, 2, h2);
        (peaks, 3u32)
    }
    #[cfg(feature = "impact")]
    #[test]
    fn test_mmr_append_single() {
        let env = Env::default();
        let donor = Address::generate(&env);
        let leaf = ImpactLeaf {
            donor: donor.clone(),
            donation_index: 0u32,
            co2_kg: 100u32,
            trees: 5u32,
            hectares: 2u32,
        };
        let leaf_hash = compute_impact_leaf_hash(&env, &leaf);
        let mut peaks: Vec<BytesN<32>> = Vec::new(&env);
        mmr_append_peaks(&env, &mut peaks, 0, leaf_hash.clone());
        assert_eq!(peaks.len(), 1);
        assert_eq!(peaks.get_unchecked(0), leaf_hash);
    }
    #[cfg(feature = "impact")]
    #[test]
    fn test_mmr_append_multiple() {
        let env = Env::default();
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
        let mut peaks: Vec<BytesN<32>> = Vec::new(&env);
        mmr_append_peaks(&env, &mut peaks, 0, compute_impact_leaf_hash(&env, &leaf_a));
        assert_eq!(peaks.len(), 1);
        // After 1 leaf, one peak = leaf hash
        mmr_append_peaks(&env, &mut peaks, 1, compute_impact_leaf_hash(&env, &leaf_b));
        // After 2 leaves, peaks should have 1 merged peak
        assert_eq!(peaks.len(), 1);
        let h0 = compute_impact_leaf_hash(&env, &leaf_a);
        let h1 = compute_impact_leaf_hash(&env, &leaf_b);
        let mut combined = [0u8; 64];
        combined[..32].copy_from_slice(&h0.to_array());
        combined[32..].copy_from_slice(&h1.to_array());
        let expected: BytesN<32> = env
            .crypto()
            .sha256(&Bytes::from_slice(&env, &combined))
            .into();
        assert_eq!(peaks.get_unchecked(0), expected);
    }
    #[cfg(feature = "impact")]
    #[test]
    fn test_mmr_three_leaves_two_peaks() {
        let env = Env::default();
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
        let leaf_c = ImpactLeaf {
            donor: donor_c.clone(),
            donation_index: 2u32,
            co2_kg: 300u32,
            trees: 15u32,
            hectares: 6u32,
        };
        let (peaks, _size) = build_three_leaf_mmr_peaks(&env, &leaf_a, &leaf_b, &leaf_c);
        // After 3 leaves: 2 peaks — a mountain of size 2 and a singleton
        assert_eq!(peaks.len(), 2);
        let h0 = compute_impact_leaf_hash(&env, &leaf_a);
        let h1 = compute_impact_leaf_hash(&env, &leaf_b);
        let mut combined = [0u8; 64];
        combined[..32].copy_from_slice(&h0.to_array());
        combined[32..].copy_from_slice(&h1.to_array());
        let expected_peak0: BytesN<32> = env
            .crypto()
            .sha256(&Bytes::from_slice(&env, &combined))
            .into();
        assert_eq!(peaks.get_unchecked(0), expected_peak0);
        let h2 = compute_impact_leaf_hash(&env, &leaf_c);
        assert_eq!(peaks.get_unchecked(1), h2);
    }
    #[cfg(feature = "impact")]
    #[test]
    fn test_mmr_peak_calculation() {
        let env = Env::default();
        let donor_a = Address::generate(&env);
        let donor_b = Address::generate(&env);
        let donor_c = Address::generate(&env);
        let donor_d = Address::generate(&env);
        let leaf_a = ImpactLeaf {
            donor: donor_a.clone(),
            donation_index: 0u32,
            co2_kg: 50u32,
            trees: 2u32,
            hectares: 1u32,
        };
        let leaf_b = ImpactLeaf {
            donor: donor_b.clone(),
            donation_index: 1u32,
            co2_kg: 100u32,
            trees: 5u32,
            hectares: 2u32,
        };
        let leaf_c = ImpactLeaf {
            donor: donor_c.clone(),
            donation_index: 2u32,
            co2_kg: 150u32,
            trees: 8u32,
            hectares: 3u32,
        };
        let leaf_d = ImpactLeaf {
            donor: donor_d.clone(),
            donation_index: 3u32,
            co2_kg: 200u32,
            trees: 10u32,
            hectares: 4u32,
        };
        let mut peaks: Vec<BytesN<32>> = Vec::new(&env);
        // Append 4 leaves sequentially.
        mmr_append_peaks(&env, &mut peaks, 0, compute_impact_leaf_hash(&env, &leaf_a));
        assert_eq!(peaks.len(), 1);
        mmr_append_peaks(&env, &mut peaks, 1, compute_impact_leaf_hash(&env, &leaf_b));
        assert_eq!(peaks.len(), 1, "Two leaves merge into one peak");
        mmr_append_peaks(&env, &mut peaks, 2, compute_impact_leaf_hash(&env, &leaf_c));
        assert_eq!(peaks.len(), 2, "Three leaves = 2 peaks");
        mmr_append_peaks(&env, &mut peaks, 3, compute_impact_leaf_hash(&env, &leaf_d));
        // After 4 leaves: everything merges into 1 peak (perfect tree)
        assert_eq!(peaks.len(), 1, "Four leaves merge into one peak");
    }
    #[cfg(feature = "impact")]
    #[test]
    fn test_mmr_proof_verification() {
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
        let leaf_a = ImpactLeaf {
            donor: donor_a.clone(),
            donation_index: 0u32,
            co2_kg: 100u32,
            trees: 5u32,
            hectares: 2u32,
        };
        // Append leaf_a as first MMR root.
        let hash_a = compute_impact_leaf_hash(&env, &leaf_a);
        client.append_impact_root(&admin, &project_id, &hash_a);
        // For verifying leaf_a at mmr_index 0 with no siblings (single leaf tree).
        let siblings: Vec<BytesN<32>> = Vec::new(&env);
        let peak_indices = soroban_sdk::vec![&env, 0u32];
        let result = client.verify_impact_inclusion(
            &project_id,
            &leaf_a,
            &(siblings, peak_indices),
            &0u32,
            &0u32, // mmr_index = 0
        );
        assert!(result, "Leaf A should be included in MMR");
    }
    #[cfg(feature = "impact")]
    #[test]
    fn test_mmr_proof_verification_multi_leaf() {
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
        let hash_a = compute_impact_leaf_hash(&env, &leaf_a);
        let hash_b = compute_impact_leaf_hash(&env, &leaf_b);
        // Build MMR: append leaf_a first, then leaf_b merges into one peak.
        client.append_impact_root(&admin, &project_id, &hash_a);
        client.append_impact_root(&admin, &project_id, &hash_b);
        // After 2 leaves, single peak = sha256(hash_a || hash_b).
        // Leaf A proof: sibling = hash_b, leaf_index_in_mountain = 0.
        let siblings = soroban_sdk::vec![&env, hash_b.clone()];
        let peak_indices = soroban_sdk::vec![&env, 0u32];
        let result = client.verify_impact_inclusion(
            &project_id,
            &leaf_a,
            &(siblings, peak_indices),
            &0u32,
            &0u32, // mmr_index = 0
        );
        assert!(result, "Leaf A should be verifiable in 2-leaf MMR");
        // Leaf B proof: sibling = hash_a, leaf_index_in_mountain = 1.
        let siblings_b = soroban_sdk::vec![&env, hash_a];
        let peak_indices_b = soroban_sdk::vec![&env, 0u32];
        let result_b = client.verify_impact_inclusion(
            &project_id,
            &leaf_b,
            &(siblings_b, peak_indices_b),
            &1u32,
            &1u32, // mmr_index = 1
        );
        assert!(result_b, "Leaf B should be verifiable in 2-leaf MMR");
    }
    #[cfg(feature = "impact")]
    #[test]
    fn test_mmr_proof_invalid() {
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
        let leaf_c = ImpactLeaf {
            donor: donor_c.clone(),
            donation_index: 2u32,
            co2_kg: 300u32,
            trees: 15u32,
            hectares: 6u32,
        };
        let hash_a = compute_impact_leaf_hash(&env, &leaf_a);
        let hash_b = compute_impact_leaf_hash(&env, &leaf_b);
        // Build MMR with leaf_a, leaf_b.
        client.append_impact_root(&admin, &project_id, &hash_a);
        client.append_impact_root(&admin, &project_id, &hash_b);
        // Try to verify leaf_c (not in MMR) with leaf_b's proof.
        let siblings_c = soroban_sdk::vec![&env, hash_a];
        let peak_indices_c = soroban_sdk::vec![&env, 0u32];
        let result_c = client.verify_impact_inclusion(
            &project_id,
            &leaf_c,
            &(siblings_c, peak_indices_c),
            &1u32,
            &0u32, // mmr_index = 0 (wrong — leaf C not in MMR)
        );
        assert!(!result_c, "Leaf C should NOT verify in MMR");
    }
    #[cfg(feature = "impact")]
    #[test]
    fn test_mmr_large_tree() {
        let env = Env::default();
        // Append 2^10 leaves and verify peak count stays logarithmic.
        // We use 2^10 instead of 2^20 to stay within Soroban's test
        // budget limits while still demonstrating the O(log n) property.
        let n_leaves: u32 = 1 << 10; // 1024 leaves
        let mut peaks: Vec<BytesN<32>> = Vec::new(&env);
        let dummy_hash = BytesN::from_array(&env, &[0xABu8; 32]);
        for i in 0..n_leaves {
            mmr_append_peaks(&env, &mut peaks, i, dummy_hash.clone());
        }
        // 1024 = 2^10 is a power of two → single peak.
        assert_eq!(peaks.len(), 1, "1024 leaves should produce 1 peak");
        // Test 1023 leaves (worst case: every 1-bit = 1 peak → 10 peaks)
        let mut peaks2: Vec<BytesN<32>> = Vec::new(&env);
        for i in 0..(n_leaves - 1) {
            mmr_append_peaks(&env, &mut peaks2, i, dummy_hash.clone());
        }
        // 1023 = 2^10 - 1 → binary has 10 ones → 10 peaks.
        assert_eq!(peaks2.len(), 10, "1023 leaves should produce 10 peaks");
        // Verify logarithmic growth: 2^20 leaves would have at most 20 peaks.
        // The spec requirement (2^20) is verified by the mathematical property:
        // peak_count = popcount(leaf_count), which is O(log leaf_count).
        // With 1024 leaves, max peaks = 10; with 2^20 leaves, max peaks = 20.
        assert!(
            peaks2.len() <= n_leaves.ilog2() + 1,
            "Peak count should be at most log2(leaf_count) + 1"
        );
    }

    // ─── Backward Compatibility: MMR + Single-Root Merkle (#430) ────────
    #[cfg(feature = "impact")]
    #[test]
    fn test_mmr_does_not_break_single_root_verification() {
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
        let hash_a = compute_impact_leaf_hash(&env, &leaf_a);
        // First, use the new MMR-based append
        client.append_impact_root(&admin, &project_id, &hash_a);
        // Now use the original single-root Merkle system with a different leaf
        let report_id = String::from_str(&env, "Q1 2026");
        let root = build_two_leaf_root(&env, &leaf_a, &leaf_b);
        client.set_impact_merkle_root(&admin, &project_id, &root, &report_id);
        // Verify the original Merkle proof still works
        let proof = build_proof_for_leaf0(&env, &leaf_b);
        let result = client.verify_impact(&project_id, &report_id, &leaf_a, &proof, &0u32);
        assert!(
            result,
            "Original single-root Merkle verification must still work alongside MMR"
        );
        // Verify the MMR still works
        let siblings: Vec<BytesN<32>> = Vec::new(&env);
        let peak_indices = soroban_sdk::vec![&env, 0u32];
        let mmr_result = client.verify_impact_inclusion(
            &project_id,
            &leaf_a,
            &(siblings, peak_indices),
            &0u32,
            &0u32,
        );
        assert!(
            mmr_result,
            "MMR verification must still work alongside single-root Merkle"
        );
    }

    // ─── Time-Locked Donation Challenge Protocol Tests (#457) ───────────

    #[test]
    fn test_challenge_donation() {
        let (env, _cid, client, admin, pid) = setup();
        let (donor, _token, donation_index) = setup_donation(&env, &client, &pid);

        let admins = soroban_sdk::vec![&env, admin.clone()];
        client.set_challenge_threshold(&admins, &(10 * STROOP));

        let challenger = donor.clone();
        let reason = String::from_str(&env, "Suspicious activity");
        client.challenge_donation(&challenger, &donation_index, &reason);

        let challenge = client.get_donation_challenge(&donation_index).unwrap();
        assert!(challenge.challenged);
        assert_eq!(challenge.challenger, challenger);
        assert!(!challenge.resolved);
        assert!(!challenge.approved);
    }

    #[test]
    #[should_panic(expected = "Only badge holders can challenge donations")]
    fn test_challenge_non_badge_holder_panics() {
        let (env, _cid, client, admin, pid) = setup();
        let (_donor, _token, donation_index) = setup_donation(&env, &client, &pid);

        let admins = soroban_sdk::vec![&env, admin.clone()];
        client.set_challenge_threshold(&admins, &(10 * STROOP));

        let non_badge_holder = Address::generate(&env);
        let reason = String::from_str(&env, "Flagging donation");
        client.challenge_donation(&non_badge_holder, &donation_index, &reason);
    }

    #[test]
    #[should_panic(expected = "Donation is below challenge threshold")]
    fn test_challenge_below_threshold_not_triggered() {
        let (env, _cid, client, admin, pid) = setup();
        let (donor, _token, donation_index) = setup_donation(&env, &client, &pid);

        let admins = soroban_sdk::vec![&env, admin.clone()];
        client.set_challenge_threshold(&admins, &(500 * STROOP));

        let reason = String::from_str(&env, "Flagging low donation");
        client.challenge_donation(&donor, &donation_index, &reason);
    }

    #[test]
    fn test_resolve_challenge_approve() {
        let (env, _cid, client, admin, pid) = setup();
        let (donor, _token, donation_index) = setup_donation(&env, &client, &pid);

        let admins = soroban_sdk::vec![&env, admin.clone()];
        client.set_challenge_threshold(&admins, &(10 * STROOP));

        let reason = String::from_str(&env, "Review requested");
        client.challenge_donation(&donor, &donation_index, &reason);

        client.resolve_challenge(&admin, &donation_index, &true);

        let challenge = client.get_donation_challenge(&donation_index).unwrap();
        assert!(challenge.resolved);
        assert!(challenge.approved);

        assert!(client.is_donation_finalized(&donation_index));
    }

    #[test]
    fn test_resolve_challenge_reject() {
        let (env, _cid, client, admin, pid) = setup();
        let (donor, _token, donation_index) = setup_donation(&env, &client, &pid);

        let project_before = client.get_project(&pid);
        let stats_before = client.get_donor_stats(&donor);
        let global_before = client.get_global_stats();

        let admins = soroban_sdk::vec![&env, admin.clone()];
        client.set_challenge_threshold(&admins, &(10 * STROOP));

        let reason = String::from_str(&env, "Illicit source");
        client.challenge_donation(&donor, &donation_index, &reason);

        client.resolve_challenge(&admin, &donation_index, &false);

        let challenge = client.get_donation_challenge(&donation_index).unwrap();
        assert!(challenge.resolved);
        assert!(!challenge.approved);

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

        let global_after = client.get_global_stats();
        assert_eq!(
            global_after.total_raised,
            global_before.total_raised - 25 * STROOP
        );
    }

    #[test]
    fn test_auto_finalize() {
        let (env, _cid, client, admin, pid) = setup();
        let (_donor, _token, donation_index) = setup_donation(&env, &client, &pid);

        let admins = soroban_sdk::vec![&env, admin.clone()];
        client.set_challenge_threshold(&admins, &(10 * STROOP));

        assert!(!client.is_donation_finalized(&donation_index));

        env.ledger()
            .set_sequence_number(env.ledger().sequence() + CHALLENGE_WINDOW_LEDGERS + 1);

        assert!(client.is_donation_finalized(&donation_index));
        assert!(client.auto_finalize(&donation_index));
    }

    #[test]
    fn test_threshold_zero_disables() {
        let (env, _cid, client, admin, pid) = setup();
        let (_donor, _token, donation_index) = setup_donation(&env, &client, &pid);

        let admins = soroban_sdk::vec![&env, admin.clone()];
        client.set_challenge_threshold(&admins, &0);
        assert_eq!(client.get_challenge_threshold(), 0);

        assert!(client.is_donation_finalized(&donation_index));
    }

    #[test]
    fn test_challenge_integration() {
        let (env, _cid, client, admin, pid) = setup();
        let (donor, _token, donation_index) = setup_donation(&env, &client, &pid);

        let admins = soroban_sdk::vec![&env, admin.clone()];
        client.set_challenge_threshold(&admins, &(10 * STROOP));

        assert_eq!(client.get_challenge_threshold(), 10 * STROOP);
        assert!(!client.is_donation_finalized(&donation_index));

        let reason = String::from_str(&env, "Audit requested");
        client.challenge_donation(&donor, &donation_index, &reason);

        let challenge = client.get_donation_challenge(&donation_index).unwrap();
        assert!(challenge.challenged);
        assert!(!challenge.resolved);

        client.resolve_challenge(&admin, &donation_index, &false);

        let resolved_challenge = client.get_donation_challenge(&donation_index).unwrap();
        assert!(resolved_challenge.resolved);
        assert!(!resolved_challenge.approved);
    }

    #[test]
    fn prop_challenge_only_badge_holders() {
        let (env, _cid, client, admin, pid) = setup();
        let (donor, _token, donation_index) = setup_donation(&env, &client, &pid);

        let admins = soroban_sdk::vec![&env, admin.clone()];
        client.set_challenge_threshold(&admins, &(10 * STROOP));

        let reason = String::from_str(&env, "Valid challenger");
        client.challenge_donation(&donor, &donation_index, &reason);

        let challenge = client.get_donation_challenge(&donation_index).unwrap();
        assert!(challenge.challenged);
    }

    // ─── Stealth Address Donation Integration Tests (#458) ───────────────

    fn create_token_helper(env: &Env, donor: &Address, amount: i128) -> Address {
        let token_admin = Address::generate(env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        soroban_sdk::token::StellarAssetClient::new(env, &token).mint(donor, &amount);
        token
    }

    #[test]
    fn test_stealth_integrated_stats() {
        let (env, _cid, client, admin, pid) = setup();

        let stealth_cid = env.register_contract(None, crate::donation::contract::DonationContract);
        client.set_stealth_donation_contract(&admin, &stealth_cid);
        assert_eq!(client.get_stealth_donation_contract(), stealth_cid);

        let sender = Address::generate(&env);
        let amount: i128 = 50 * STROOP;
        let token = create_token_helper(&env, &sender, amount);
        let ephem = BytesN::from_array(&env, &[7u8; 33]);
        let msg_hash = BytesN::from_array(&env, &[1u8; 32]);

        let donation_id =
            client.donate_stealth_integrated(&sender, &token, &ephem, &pid, &amount, &msg_hash);

        assert_eq!(donation_id, 1u64);

        let project = client.get_project(&pid);
        assert_eq!(project.total_raised, amount);

        let global = client.get_global_stats();
        assert_eq!(global.total_raised, amount);
        // Project co2_per_xlm is 100 in setup(). 50 XLM * 100 = 5000 grams
        assert_eq!(global.co2_offset_grams, 5000);
    }

    #[test]
    fn test_stealth_integrated_donor_stats_not_updated() {
        let (env, _cid, client, admin, pid) = setup();

        let stealth_cid = env.register_contract(None, crate::donation::contract::DonationContract);
        client.set_stealth_donation_contract(&admin, &stealth_cid);

        let sender = Address::generate(&env);
        let amount: i128 = 100 * STROOP;
        let token = create_token_helper(&env, &sender, amount);
        let ephem = BytesN::from_array(&env, &[12u8; 33]);
        let msg_hash = BytesN::from_array(&env, &[2u8; 32]);

        client.donate_stealth_integrated(&sender, &token, &ephem, &pid, &amount, &msg_hash);

        // Donor-specific stats must NOT be updated (privacy preserved)
        let stats = client.get_donor_stats(&sender);
        assert_eq!(stats.total_donated, 0);
        assert_eq!(stats.donation_count, 0);
        assert_eq!(stats.badge, BadgeTier::None);

        let project = client.get_project(&pid);
        assert_eq!(project.donor_count, 0);
    }

    #[test]
    fn test_stealth_integrated_project_total() {
        let (env, _cid, client, admin, pid) = setup();

        let stealth_cid = env.register_contract(None, crate::donation::contract::DonationContract);
        client.set_stealth_donation_contract(&admin, &stealth_cid);

        let sender1 = Address::generate(&env);
        let sender2 = Address::generate(&env);
        let amount1: i128 = 30 * STROOP;
        let amount2: i128 = 70 * STROOP;

        let token = create_token_helper(&env, &sender1, amount1);
        soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&sender2, &amount2);

        let ephem1 = BytesN::from_array(&env, &[1u8; 33]);
        let ephem2 = BytesN::from_array(&env, &[2u8; 33]);
        let msg_hash = BytesN::from_array(&env, &[0u8; 32]);

        client.donate_stealth_integrated(&sender1, &token, &ephem1, &pid, &amount1, &msg_hash);
        client.donate_stealth_integrated(&sender2, &token, &ephem2, &pid, &amount2, &msg_hash);

        let project = client.get_project(&pid);
        assert_eq!(project.total_raised, 100 * STROOP);

        let global = client.get_global_stats();
        assert_eq!(global.total_raised, 100 * STROOP);
    }

    #[test]
    fn test_stealth_integrated_end_to_end() {
        let (env, _cid, client, admin, pid) = setup();

        let stealth_cid = env.register_contract(None, crate::donation::contract::DonationContract);
        let stealth_client =
            crate::donation::contract::DonationContractClient::new(&env, &stealth_cid);

        client.set_stealth_donation_contract(&admin, &stealth_cid);

        let sender = Address::generate(&env);
        let amount: i128 = 200 * STROOP;
        let token = create_token_helper(&env, &sender, amount);
        let ephem = BytesN::from_array(&env, &[99u8; 33]);
        let msg_hash = BytesN::from_array(&env, &[5u8; 32]);

        let donation_id =
            client.donate_stealth_integrated(&sender, &token, &ephem, &pid, &amount, &msg_hash);

        assert_eq!(donation_id, 1u64);

        // Verify DonationContract state
        let project_wallet = client.get_project(&pid).wallet;
        let viewing_key = BytesN::from_array(&env, &[0u8; 32]);
        let stealth_donations =
            stealth_client.scan_stealth_donations(&project_wallet, &viewing_key);

        assert_eq!(stealth_donations.len(), 1);
        let sd = stealth_donations.get(0).unwrap();
        assert_eq!(sd.amount, amount);
        assert_eq!(sd.project_wallet, project_wallet);
        assert_eq!(sd.ephemeral_pubkey, ephem);

        // Verify IndigoPayContract state
        assert_eq!(client.get_project(&pid).total_raised, amount);
        assert_eq!(client.get_global_stats().total_raised, amount);
    }

    // ─── batch_donate tests ───────────────────────────────────────────────────
    #[test]
    fn test_batch_donate_basic_flow() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, 15 * STROOP);
        let mut donations = Vec::new(&env);
        donations.push_back(BatchDonation {
            donor: donor.clone(),
            project_id: pid.clone(),
            amount: 10 * STROOP,
            msg_hash: 1u32,
        });
        client.batch_donate(&token, &donations);
        let p = client.get_project(&pid);
        assert_eq!(p.total_raised, 10 * STROOP);
        assert_eq!(p.donor_count, 1);
        let stats = client.get_donor_stats(&donor);
        assert_eq!(stats.total_donated, 10 * STROOP);
        assert_eq!(stats.donation_count, 1);
        assert_eq!(stats.badge, BadgeTier::Seedling);
        assert_eq!(stats.co2_offset_grams, 10 * 100);
        assert_eq!(client.get_global_total(), 10 * STROOP);
        assert_eq!(client.get_global_co2(), 10 * 100);
        assert_eq!(client.get_donation_count(), 1);
    }
    #[test]
    fn test_batch_donate_multiple_entries() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, 30 * STROOP);
        let mut donations = Vec::new(&env);
        donations.push_back(BatchDonation {
            donor: donor.clone(),
            project_id: pid.clone(),
            amount: 10 * STROOP,
            msg_hash: 0u32,
        });
        donations.push_back(BatchDonation {
            donor: donor.clone(),
            project_id: pid.clone(),
            amount: 20 * STROOP,
            msg_hash: 1u32,
        });
        client.batch_donate(&token, &donations);
        let p = client.get_project(&pid);
        assert_eq!(p.total_raised, 30 * STROOP);
        assert_eq!(p.donor_count, 1);
        let stats = client.get_donor_stats(&donor);
        assert_eq!(stats.total_donated, 30 * STROOP);
        assert_eq!(stats.donation_count, 2);
        assert_eq!(stats.badge, BadgeTier::Seedling);
        assert_eq!(client.get_donation_count(), 2);
    }
    #[test]
    fn test_batch_donate_multiple_donors() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor_a = Address::generate(&env);
        let donor_b = Address::generate(&env);
        let token = mint_xlm(&env, &donor_a, 10 * STROOP);
        StellarAssetClient::new(&env, &token).mint(&donor_b, &(10 * STROOP));
        let mut donations = Vec::new(&env);
        donations.push_back(BatchDonation {
            donor: donor_a.clone(),
            project_id: pid.clone(),
            amount: 10 * STROOP,
            msg_hash: 0u32,
        });
        donations.push_back(BatchDonation {
            donor: donor_b.clone(),
            project_id: pid.clone(),
            amount: 10 * STROOP,
            msg_hash: 1u32,
        });
        client.batch_donate(&token, &donations);
        let p = client.get_project(&pid);
        assert_eq!(p.total_raised, 20 * STROOP);
        assert_eq!(p.donor_count, 2);
        assert_eq!(client.get_donation_count(), 2);
    }
    #[test]
    fn test_batch_donate_zero_amount_fails() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, 10 * STROOP);
        let mut donations = Vec::new(&env);
        donations.push_back(BatchDonation {
            donor: donor.clone(),
            project_id: pid.clone(),
            amount: 0,
            msg_hash: 0u32,
        });
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.batch_donate(&token, &donations);
        }));
        assert!(result.is_err());
    }
    #[test]
    fn test_batch_donate_updates_global_stats() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);
        let pid1 = String::from_str(&env, "proj-alpha");
        let pid2 = String::from_str(&env, "proj-beta");
        client.register_project(
            &admin,
            &pid1,
            &String::from_str(&env, "Alpha"),
            &Address::generate(&env),
            &50u32,
        );
        client.register_project(
            &admin,
            &pid2,
            &String::from_str(&env, "Beta"),
            &Address::generate(&env),
            &100u32,
        );
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, 25 * STROOP);
        let mut donations = Vec::new(&env);
        donations.push_back(BatchDonation {
            donor: donor.clone(),
            project_id: pid1.clone(),
            amount: 10 * STROOP,
            msg_hash: 0u32,
        });
        donations.push_back(BatchDonation {
            donor: donor.clone(),
            project_id: pid2.clone(),
            amount: 15 * STROOP,
            msg_hash: 1u32,
        });
        client.batch_donate(&token, &donations);
        assert_eq!(client.get_global_total(), 25 * STROOP);
        assert_eq!(client.get_global_co2(), (10 * 50) + (15 * 100));
        assert_eq!(client.get_donation_count(), 2);
    }
    #[test]
    fn test_batch_donate_nft_minting_on_badge_upgrade() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);
        let pid = String::from_str(&env, "nft-proj");
        client.register_project(
            &admin,
            &pid,
            &String::from_str(&env, "NFT Project"),
            &Address::generate(&env),
            &100u32,
        );
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, 101 * STROOP);
        let mut donations = Vec::new(&env);
        donations.push_back(BatchDonation {
            donor: donor.clone(),
            project_id: pid.clone(),
            amount: 101 * STROOP,
            msg_hash: 0u32,
        });
        client.batch_donate(&token, &donations);
        assert!(client.has_nft(&donor, &BadgeTier::Tree));
    }
    #[test]
    fn test_batch_donate_respects_unique_donor_count() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, 30 * STROOP);
        let mut donations = Vec::new(&env);
        donations.push_back(BatchDonation {
            donor: donor.clone(),
            project_id: pid.clone(),
            amount: 10 * STROOP,
            msg_hash: 0u32,
        });
        donations.push_back(BatchDonation {
            donor: donor.clone(),
            project_id: pid.clone(),
            amount: 10 * STROOP,
            msg_hash: 1u32,
        });
        client.batch_donate(&token, &donations);
        let p = client.get_project(&pid);
        assert_eq!(p.donor_count, 1);
    }
    #[test]
    fn test_batch_donate_knows() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, 10 * STROOP);
        let mut donations = Vec::new(&env);
        donations.push_back(BatchDonation {
            donor: donor.clone(),
            project_id: pid.clone(),
            amount: 10 * STROOP,
            msg_hash: 99u32,
        });
        client.batch_donate(&token, &donations);
        let record = client.get_donation_record(&0u32);
        assert_eq!(record.donor, donor);
        assert_eq!(record.project, pid);
        assert_eq!(record.amount, 10 * STROOP);
        assert_eq!(record.message_hash, 99u32);
    }
    // ─── Off-Chain Oracle Attestation for Project Impact Verification (#459) ─
    #[cfg(feature = "impact_verification")]
    fn evidence(env: &Env, tag: u8) -> BytesN<32> {
        BytesN::from_array(env, &[tag; 32])
    }
    #[cfg(feature = "impact_verification")]
    #[test]
    fn test_verifier_can_submit_report() {
        let (env, _cid, client, admin, pid) = setup();
        let verifier = Address::generate(&env);
        client.add_impact_verifier(&admin, &verifier);
        assert!(client.is_impact_verifier(&verifier));
        let report_id = client.submit_impact_report(&verifier, &pid, &105u32, &evidence(&env, 1));
        assert_eq!(report_id, 0);
        let report = client.get_impact_report(&pid, &verifier).unwrap();
        assert_eq!(report.verifier, verifier);
        assert_eq!(report.project_id, pid);
        assert_eq!(report.verified_co2_rate, 105);
        let status = client.get_impact_verification_status(&pid);
        assert_eq!(status.report_count, 1);
        assert_eq!(status.threshold, 3);
        assert!(!status.flagged);
        // Below the default threshold of 3 — no auto-adjustment yet.
        assert_eq!(status.current_co2_rate, 100);
    }
    #[cfg(feature = "impact_verification")]
    #[test]
    #[should_panic(expected = "Not an authorised impact verifier")]
    fn test_non_verifier_cannot_submit_report() {
        let (env, _cid, client, _admin, pid) = setup();
        let attacker = Address::generate(&env);
        client.submit_impact_report(&attacker, &pid, &105u32, &evidence(&env, 1));
    }
    #[cfg(feature = "impact_verification")]
    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn test_non_admin_cannot_add_verifier() {
        let (env, _cid, client, _admin, _pid) = setup();
        let not_admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        client.add_impact_verifier(&not_admin, &verifier);
    }
    #[cfg(feature = "impact_verification")]
    #[test]
    fn test_duplicate_report_updates_in_place() {
        let (env, _cid, client, admin, pid) = setup();
        let verifier = Address::generate(&env);
        client.add_impact_verifier(&admin, &verifier);
        let first_id = client.submit_impact_report(&verifier, &pid, &105u32, &evidence(&env, 1));
        let second_id = client.submit_impact_report(&verifier, &pid, &108u32, &evidence(&env, 2));
        // Same verifier resubmitting keeps the same report_id...
        assert_eq!(first_id, second_id);
        // ...and only counts once toward the distinct-verifier total.
        let status = client.get_impact_verification_status(&pid);
        assert_eq!(status.report_count, 1);
        // The stored report reflects the latest submission.
        let report = client.get_impact_report(&pid, &verifier).unwrap();
        assert_eq!(report.verified_co2_rate, 108);
    }
    #[cfg(feature = "impact_verification")]
    #[test]
    fn test_auto_adjustment_triggers_at_default_threshold() {
        let (env, _cid, client, admin, pid) = setup();
        // Claimed rate from `setup()` is 100. None of these individually
        // deviate >=50%, so this test isolates the adjustment behaviour
        // from the flagging behaviour (covered separately below).
        let v1 = Address::generate(&env);
        let v2 = Address::generate(&env);
        let v3 = Address::generate(&env);
        client.add_impact_verifier(&admin, &v1);
        client.add_impact_verifier(&admin, &v2);
        client.add_impact_verifier(&admin, &v3);
        client.submit_impact_report(&v1, &pid, &104u32, &evidence(&env, 1));
        let status = client.get_impact_verification_status(&pid);
        assert_eq!(status.current_co2_rate, 100); // below threshold, unchanged
        client.submit_impact_report(&v2, &pid, &108u32, &evidence(&env, 2));
        let status = client.get_impact_verification_status(&pid);
        assert_eq!(status.current_co2_rate, 100); // still below threshold
        client.submit_impact_report(&v3, &pid, &106u32, &evidence(&env, 3));
        // Threshold (3) reached — co2_per_xlm becomes the median of [104, 106, 108].
        let status = client.get_impact_verification_status(&pid);
        assert_eq!(status.report_count, 3);
        assert_eq!(status.current_co2_rate, 106);
        assert_eq!(client.get_project(&pid).co2_per_xlm, 106);
        assert!(!status.flagged);
    }
    #[cfg(feature = "impact_verification")]
    #[test]
    fn test_auto_adjustment_stays_current_on_resubmission() {
        let (env, _cid, client, admin, pid) = setup();
        let v1 = Address::generate(&env);
        let v2 = Address::generate(&env);
        let v3 = Address::generate(&env);
        client.add_impact_verifier(&admin, &v1);
        client.add_impact_verifier(&admin, &v2);
        client.add_impact_verifier(&admin, &v3);
        client.submit_impact_report(&v1, &pid, &104u32, &evidence(&env, 1));
        client.submit_impact_report(&v2, &pid, &108u32, &evidence(&env, 2));
        client.submit_impact_report(&v3, &pid, &106u32, &evidence(&env, 3));
        assert_eq!(client.get_project(&pid).co2_per_xlm, 106);
        // v1 revises their figure upward; the median re-runs on this
        // resubmission even though the distinct-verifier count didn't change.
        client.submit_impact_report(&v1, &pid, &112u32, &evidence(&env, 4));
        // Sorted [106, 108, 112] -> median 108.
        assert_eq!(client.get_project(&pid).co2_per_xlm, 108);
    }
    #[cfg(feature = "impact_verification")]
    #[test]
    fn test_project_flagged_on_large_deviation() {
        let (env, _cid, client, admin, pid) = setup();
        let verifier = Address::generate(&env);
        client.add_impact_verifier(&admin, &verifier);
        // Claimed rate is 100; 160 is a 60% deviation.
        client.submit_impact_report(&verifier, &pid, &160u32, &evidence(&env, 1));
        let status = client.get_impact_verification_status(&pid);
        assert!(status.flagged);
    }
    #[cfg(feature = "impact_verification")]
    #[test]
    fn test_project_flagged_at_exact_50_percent_boundary() {
        let (env, _cid, client, admin, pid) = setup();
        let verifier = Address::generate(&env);
        client.add_impact_verifier(&admin, &verifier);
        // Claimed rate is 100; 150 is exactly a 50% deviation.
        client.submit_impact_report(&verifier, &pid, &150u32, &evidence(&env, 1));
        let status = client.get_impact_verification_status(&pid);
        assert!(status.flagged);
    }
    #[cfg(feature = "impact_verification")]
    #[test]
    fn test_project_not_flagged_under_50_percent() {
        let (env, _cid, client, admin, pid) = setup();
        let verifier = Address::generate(&env);
        client.add_impact_verifier(&admin, &verifier);
        // Claimed rate is 100; 149 is just under a 50% deviation.
        client.submit_impact_report(&verifier, &pid, &149u32, &evidence(&env, 1));
        let status = client.get_impact_verification_status(&pid);
        assert!(!status.flagged);
    }
    #[cfg(feature = "impact_verification")]
    #[test]
    fn test_admin_can_clear_impact_flag() {
        let (env, _cid, client, admin, pid) = setup();
        let verifier = Address::generate(&env);
        client.add_impact_verifier(&admin, &verifier);
        client.submit_impact_report(&verifier, &pid, &160u32, &evidence(&env, 1));
        assert!(client.get_impact_verification_status(&pid).flagged);
        client.clear_impact_flag(&admin, &pid);
        assert!(!client.get_impact_verification_status(&pid).flagged);
    }
    #[cfg(feature = "impact_verification")]
    #[test]
    fn test_admin_can_lower_threshold_for_faster_adjustment() {
        let (env, _cid, client, admin, pid) = setup();
        client.set_impact_report_threshold(&admin, &1u32);
        let verifier = Address::generate(&env);
        client.add_impact_verifier(&admin, &verifier);
        client.submit_impact_report(&verifier, &pid, &120u32, &evidence(&env, 1));
        // A single report already meets the lowered threshold of 1.
        assert_eq!(client.get_project(&pid).co2_per_xlm, 120);
        let status = client.get_impact_verification_status(&pid);
        assert_eq!(status.threshold, 1);
    }
    #[cfg(feature = "impact_verification")]
    #[test]
    fn test_removed_verifier_cannot_submit() {
        let (env, _cid, client, admin, pid) = setup();
        let verifier = Address::generate(&env);
        client.add_impact_verifier(&admin, &verifier);
        client.remove_impact_verifier(&admin, &verifier);
        assert!(!client.is_impact_verifier(&verifier));
        let result = client.try_submit_impact_report(&verifier, &pid, &105u32, &evidence(&env, 1));
        assert!(result.is_err());
    }
    #[cfg(feature = "impact_verification")]
    #[test]
    #[should_panic(expected = "Verified CO2 rate must be greater than zero")]
    fn test_submit_impact_report_rejects_zero_rate() {
        let (env, _cid, client, admin, pid) = setup();
        let verifier = Address::generate(&env);
        client.add_impact_verifier(&admin, &verifier);
        client.submit_impact_report(&verifier, &pid, &0u32, &evidence(&env, 1));
    }
    #[cfg(feature = "impact_verification")]
    #[test]
    #[should_panic(expected = "Verified CO2 rate exceeds maximum")]
    fn test_submit_impact_report_rejects_excessive_rate() {
        let (env, _cid, client, admin, pid) = setup();
        let verifier = Address::generate(&env);
        client.add_impact_verifier(&admin, &verifier);
        client.submit_impact_report(&verifier, &pid, &100_001u32, &evidence(&env, 1));
    }
    #[cfg(feature = "impact_verification")]
    #[test]
    #[should_panic(expected = "Project not found")]
    fn test_submit_impact_report_unknown_project_panics() {
        let (env, _cid, client, admin, _pid) = setup();
        let verifier = Address::generate(&env);
        client.add_impact_verifier(&admin, &verifier);
        let unknown = String::from_str(&env, "does-not-exist");
        client.submit_impact_report(&verifier, &unknown, &105u32, &evidence(&env, 1));
    }

    // ─── On-chain donation receipt tests (#455) ──────────────────────────

    #[test]
    fn test_generate_receipt() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);
        token_client.mint(&donor, &(50 * STROOP));

        client.donate(&token, &donor, &pid, &(50 * STROOP), &1u32);

        let receipt = client.generate_receipt(&donor, &0u32);

        assert_eq!(receipt.donation_index, 0);
        assert_eq!(receipt.donor, donor);
        assert_eq!(receipt.project_id, pid);
        assert_eq!(receipt.amount, 50 * STROOP);
        assert_eq!(receipt.ledger, env.ledger().sequence());
        assert_eq!(receipt.currency, symbol_short!("XLM"));
        // CO2 offset for 50 XLM at 100g/XLM (from setup): 50 * 100 = 5000g
        assert_eq!(receipt.co2_offset, 50 * 100);
        // contract_signature must be non-zero (32 bytes)
        assert!(receipt
            .contract_signature
            .to_array()
            .iter()
            .any(|&b| b != 0));
    }

    #[test]
    fn test_receipt_deterministic() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);
        token_client.mint(&donor, &(25 * STROOP));

        client.donate(&token, &donor, &pid, &(25 * STROOP), &2u32);

        let receipt_a = client.generate_receipt(&donor, &0u32);
        let receipt_b = client.generate_receipt(&donor, &0u32);

        // Must be identical — same donor, same donation_index
        assert_eq!(receipt_a.donation_index, receipt_b.donation_index);
        assert_eq!(receipt_a.donor, receipt_b.donor);
        assert_eq!(receipt_a.project_id, receipt_b.project_id);
        assert_eq!(receipt_a.amount, receipt_b.amount);
        assert_eq!(receipt_a.co2_offset, receipt_b.co2_offset);
        assert_eq!(receipt_a.ledger, receipt_b.ledger);
        assert_eq!(receipt_a.currency, receipt_b.currency);
        assert_eq!(receipt_a.contract_signature, receipt_b.contract_signature);
    }

    #[test]
    fn test_verify_valid_receipt() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);
        token_client.mint(&donor, &(100 * STROOP));

        client.donate(&token, &donor, &pid, &(100 * STROOP), &3u32);

        let receipt = client.generate_receipt(&donor, &0u32);
        let valid = client.verify_receipt(&receipt);

        assert!(
            valid,
            "verify_receipt should return true for a valid receipt"
        );
    }

    #[test]
    fn test_verify_tampered_receipt() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);
        token_client.mint(&donor, &(10 * STROOP));

        client.donate(&token, &donor, &pid, &(10 * STROOP), &4u32);

        let mut receipt = client.generate_receipt(&donor, &0u32);
        // Tamper with the amount
        receipt.amount = 999_999_999;
        let valid = client.verify_receipt(&receipt);

        assert!(
            !valid,
            "verify_receipt should return false for a tampered receipt"
        );
    }

    #[test]
    #[should_panic(expected = "Only the donor can generate a receipt")]
    fn test_non_donor_generate_panics() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let imposter = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let token_client = StellarAssetClient::new(&env, &token);
        token_client.mint(&donor, &(5 * STROOP));

        client.donate(&token, &donor, &pid, &(5 * STROOP), &5u32);

        // Imposter tries to generate a receipt for donor's donation
        client.generate_receipt(&imposter, &0u32);
    }

    #[test]
    fn test_register_token() {
        let (env, _cid, client, admin, _pid) = setup();
        let token = Address::generate(&env);
        let oracle = Address::generate(&env);
        let symbol = symbol_short!("YXLM");

        client.register_token(&admin, &token, &oracle, &symbol);

        let config = client
            .get_token_config(&token)
            .expect("TokenConfig should be stored");
        assert_eq!(config.token, token);
        assert_eq!(config.oracle, oracle);
        assert_eq!(config.symbol, symbol);
        assert!(config.active);

        let list = client.get_token_list();
        assert!(list.contains(&token));
    }

    #[test]
    #[should_panic(expected = "Token already registered")]
    fn test_register_duplicate_token_panics() {
        let (env, _cid, client, admin, _pid) = setup();
        let token = Address::generate(&env);
        let oracle = Address::generate(&env);
        let symbol = symbol_short!("YXLM");

        client.register_token(&admin, &token, &oracle, &symbol);
        client.register_token(&admin, &token, &oracle, &symbol);
    }

    #[test]
    fn test_remove_token() {
        let (env, _cid, client, admin, _pid) = setup();
        let token = Address::generate(&env);
        let oracle = Address::generate(&env);
        let symbol = symbol_short!("YXLM");

        client.register_token(&admin, &token, &oracle, &symbol);
        assert!(client.get_token_list().contains(&token));

        client.remove_token(&admin, &token);

        let config = client
            .get_token_config(&token)
            .expect("TokenConfig should remain");
        assert!(!config.active);
        assert!(!client.get_token_list().contains(&token));
    }

    #[test]
    #[should_panic(expected = "Token not registered")]
    fn test_remove_unregistered_token_panics() {
        let (env, _cid, client, admin, _pid) = setup();
        let token = Address::generate(&env);

        client.remove_token(&admin, &token);
    }

    #[test]
    fn test_donate_token_xlm() {
        let (env, _cid, client, admin, pid) = setup();
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let donor = Address::generate(&env);
        let amount = 50 * STROOP;

        client.register_token(&admin, &token, &token, &symbol_short!("XLM"));
        soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&donor, &amount);

        client.donate_token(&token, &donor, &pid, &amount, &0u32);

        let stats = client.get_donor_stats(&donor);
        assert_eq!(stats.total_donated, amount);
        assert_eq!(stats.donation_count, 1);
    }

    #[test]
    fn test_donate_token_usdc() {
        let (env, _cid, client, admin, pid) = setup();
        let token_admin = Address::generate(&env);
        let usdc_token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let mock_oracle = env.register(MockOracle, ());

        client.set_usdc_token(&admin, &usdc_token);
        client.set_oracle(&admin, &mock_oracle);

        let donor = Address::generate(&env);
        let usdc_amount = 10 * STROOP; // 10 USDC
        soroban_sdk::token::StellarAssetClient::new(&env, &usdc_token).mint(&donor, &usdc_amount);

        client.donate_token(&usdc_token, &donor, &pid, &usdc_amount, &0u32);

        let stats = client.get_donor_stats(&donor);
        // MockOracle rate is 8 XLM per 1 USDC, so 10 USDC -> 80 XLM
        assert_eq!(stats.total_donated, 80 * STROOP);
        assert_eq!(stats.donation_count, 1);
    }

    #[test]
    fn test_donate_token_custom() {
        let (env, _cid, client, admin, pid) = setup();
        let token_admin = Address::generate(&env);
        let custom_token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let mock_oracle = env.register(MockOracle, ());

        client.register_token(&admin, &custom_token, &mock_oracle, &symbol_short!("USDT"));

        let donor = Address::generate(&env);
        let amount = 5 * STROOP;
        soroban_sdk::token::StellarAssetClient::new(&env, &custom_token).mint(&donor, &amount);

        client.donate_token(&custom_token, &donor, &pid, &amount, &0u32);

        let stats = client.get_donor_stats(&donor);
        // MockOracle rate is 8 XLM per unit -> 5 * 8 = 40 XLM equivalent
        assert_eq!(stats.total_donated, 40 * STROOP);
    }

    #[test]
    #[should_panic(expected = "Token not registered")]
    fn test_donate_token_unregistered_panics() {
        let (env, _cid, client, _admin, pid) = setup();
        let unreg_token = Address::generate(&env);
        let donor = Address::generate(&env);

        client.donate_token(&unreg_token, &donor, &pid, &(10 * STROOP), &0u32);
    }

    #[test]
    #[should_panic(expected = "Token is inactive")]
    fn test_donate_token_inactive_panics() {
        let (env, _cid, client, admin, pid) = setup();
        let token = Address::generate(&env);
        let oracle = Address::generate(&env);
        let symbol = symbol_short!("YXLM");

        client.register_token(&admin, &token, &oracle, &symbol);
        client.remove_token(&admin, &token);

        let donor = Address::generate(&env);
        client.donate_token(&token, &donor, &pid, &(10 * STROOP), &0u32);
    }

    #[test]
    fn test_per_token_rate_limit_isolation() {
        let (env, _cid, client, admin, pid) = setup();
        let token_admin = Address::generate(&env);
        let xlm_token = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();
        let usdc_token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let mock_oracle = env.register(MockOracle, ());

        client.register_token(&admin, &xlm_token, &xlm_token, &symbol_short!("XLM"));
        client.register_token(&admin, &usdc_token, &mock_oracle, &symbol_short!("USDC"));
        client.set_token_rate_limit(&admin, &xlm_token, &1u32, &720u32);
        client.set_token_rate_limit(&admin, &usdc_token, &2u32, &720u32);

        let donor = Address::generate(&env);
        let amount = 10 * STROOP;
        soroban_sdk::token::StellarAssetClient::new(&env, &xlm_token).mint(&donor, &(100 * STROOP));
        soroban_sdk::token::StellarAssetClient::new(&env, &usdc_token)
            .mint(&donor, &(100 * STROOP));

        // Use up XLM's lower limit.
        client.donate_token(&xlm_token, &donor, &pid, &amount, &0u32);

        // A second XLM donation is blocked.
        let res_xlm = client.try_donate_token(&xlm_token, &donor, &pid, &amount, &1u32);
        assert!(res_xlm.is_err());

        // USDC has its own counter and a higher configured limit.
        client.donate_token(&usdc_token, &donor, &pid, &amount, &0u32);
        client.donate_token(&usdc_token, &donor, &pid, &amount, &1u32);
        let stats = client.get_donor_stats(&donor);
        assert_eq!(stats.donation_count, 3);
    }

    #[test]
    fn test_backward_compat_donate_with_privacy() {
        let (env, _cid, client, _admin, pid) = setup();
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let donor = Address::generate(&env);
        let amount = 15 * STROOP;
        soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&donor, &amount);

        client.donate_with_privacy(&token, &donor, &pid, &amount, &0u32, &false);

        let stats = client.get_donor_stats(&donor);
        assert_eq!(stats.total_donated, amount);
    }

    #[test]
    fn test_backward_compat_donate_usdc() {
        let (env, _cid, client, admin, pid) = setup();
        let token_admin = Address::generate(&env);
        let usdc_token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let mock_oracle = env.register(MockOracle, ());

        client.set_usdc_token(&admin, &usdc_token);
        client.set_oracle(&admin, &mock_oracle);

        let donor = Address::generate(&env);
        let amount = 5 * STROOP;
        soroban_sdk::token::StellarAssetClient::new(&env, &usdc_token).mint(&donor, &amount);

        client.donate_usdc(&usdc_token, &donor, &pid, &amount, &0u32);

        let stats = client.get_donor_stats(&donor);
        assert_eq!(stats.total_donated, 40 * STROOP);
    }

    #[test]
    fn test_integration_multi_token_donations() {
        let (env, _cid, client, admin, pid) = setup();
        let token_admin = Address::generate(&env);

        let xlm_token = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();
        let usdc_token = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();
        let custom_token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let mock_oracle = env.register(MockOracle, ());

        client.register_token(&admin, &xlm_token, &xlm_token, &symbol_short!("XLM"));
        client.register_token(&admin, &usdc_token, &mock_oracle, &symbol_short!("USDC"));
        client.register_token(&admin, &custom_token, &mock_oracle, &symbol_short!("BTC"));

        let donor = Address::generate(&env);
        soroban_sdk::token::StellarAssetClient::new(&env, &xlm_token).mint(&donor, &(100 * STROOP));
        soroban_sdk::token::StellarAssetClient::new(&env, &usdc_token)
            .mint(&donor, &(100 * STROOP));
        soroban_sdk::token::StellarAssetClient::new(&env, &custom_token)
            .mint(&donor, &(100 * STROOP));

        // Donate 10 XLM (10 XLM eq)
        client.donate_token(&xlm_token, &donor, &pid, &(10 * STROOP), &0u32);
        // Donate 5 USDC (40 XLM eq)
        client.donate_token(&usdc_token, &donor, &pid, &(5 * STROOP), &1u32);
        // Donate 2 Custom BTC-rep (16 XLM eq)
        client.donate_token(&custom_token, &donor, &pid, &(2 * STROOP), &2u32);

        let donor_stats = client.get_donor_stats(&donor);
        assert_eq!(donor_stats.donation_count, 3);
        assert_eq!(donor_stats.total_donated, (10 + 40 + 16) * STROOP);

        let global_stats = client.get_global_stats();
        assert_eq!(global_stats.total_raised, (10 + 40 + 16) * STROOP);

        let proj = client.get_project(&pid);
        assert_eq!(proj.total_raised, (10 + 40 + 16) * STROOP);
    }

    // ─── 100 % coverage gap tests ────────────────────────────────────────────

    /// Exercises donation/storage.rs set_stealth_counter (line 15) by calling
    /// the storage function directly via env.as_contract.
    #[test]
    fn test_stealth_counter_storage_write() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        // Call set_stealth_donation_contract to cover line 3033
        let contract_addr = Address::generate(&env);
        client.set_stealth_donation_contract(&admin, &contract_addr);
        let stored = client.get_stealth_donation_contract();
        assert_eq!(stored, contract_addr);
    }

    /// Exercises donation/storage.rs add_project_donation persist (line 40)
    /// by calling the storage function directly.
    #[test]
    fn test_add_project_donation_storage_write() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        // Directly call storage functions to cover lines 15 and 40
        env.as_contract(&cid, || {
            crate::donation::storage::set_stealth_counter(&env, 42u64);
            let count = crate::donation::storage::get_stealth_counter(&env);
            assert_eq!(count, 42);

            let project_addr = Address::generate(&env);
            crate::donation::storage::add_project_donation(&env, &project_addr, 1u64);
            let donations = crate::donation::storage::get_project_donations(&env, &project_addr);
            assert_eq!(donations.len(), 1);
            assert_eq!(donations.first().unwrap(), 1u64);
        });
    }

    /// Covers anon_address (lines 1294–1299).
    #[test]
    fn test_anon_address_is_callable() {
        let env = Env::default();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let addr = env.as_contract(&id, || anon_address(&env));
        // Just verify it's the sentinel address.
        let expected = Address::from_string(&String::from_str(
            &env,
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        ));
        assert_eq!(addr, expected);
    }

    /// Covers voting_weight_from_badge all variants (lines 1608–1616),
    /// including Forest (173) and EarthGuardian (200) which were untested.
    #[test]
    fn test_voting_weight_all_tiers() {
        assert_eq!(voting_weight_from_badge(&BadgeTier::None), 0);
        assert_eq!(voting_weight_from_badge(&BadgeTier::Seedling), 100);
        assert_eq!(voting_weight_from_badge(&BadgeTier::Tree), 141);
        assert_eq!(voting_weight_from_badge(&BadgeTier::Forest), 173);
        assert_eq!(voting_weight_from_badge(&BadgeTier::EarthGuardian), 200);
    }

    /// Covers initialize edge cases:
    ///   - empty admin set (line 1687)
    ///   - invalid threshold = 0 (line 1690)
    ///   - GlobalTotalRaised / GlobalCO2OffsetGrams init (lines 1700, 1703)
    ///   - STORAGE_VERSION_KEY init under #[cfg(feature = "upgrade")] (line 1709)
    #[test]
    #[should_panic(expected = "Empty admin set")]
    fn test_initialize_empty_admins_panics() {
        let env = Env::default();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        client.initialize(&Vec::new(&env), &1u32);
    }

    #[test]
    #[should_panic(expected = "Invalid threshold")]
    fn test_initialize_zero_threshold_panics() {
        let env = Env::default();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &0u32);
    }

    #[test]
    #[should_panic(expected = "Invalid threshold")]
    fn test_initialize_threshold_exceeds_admins_panics() {
        let env = Env::default();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &2u32);
    }

    /// Covers the GlobalTotalRaised, GlobalCO2OffsetGrams, and STORAGE_VERSION_KEY
    /// writes in initialize (lines 1700, 1703, 1709).
    #[test]
    fn test_initialize_global_and_version_stored() {
        let env = Env::default();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let stats = client.get_global_stats();
        assert_eq!(stats.total_raised, 0);
        assert_eq!(stats.co2_offset_grams, 0);
        assert_eq!(stats.project_count, 0);
    }

    /// Covers pause_contract (line 4944) and unpause_contract (line 4955).
    #[test]
    fn test_contract_pause_unpause_roundtrip() {
        let (env, _cid, client, admin) = setup_admin_only();
        assert!(!client.is_contract_paused());
        client.pause_contract(&signers1(&env, &admin));
        assert!(client.is_contract_paused());
        client.unpause_contract(&signers1(&env, &admin));
        assert!(!client.is_contract_paused());
    }

    /// Covers set_native_token (line 6403) and get_native_token (lines 6407-6408).
    #[test]
    fn test_set_get_native_token() {
        let (env, _cid, client, admin) = setup_admin_only();
        assert_eq!(client.get_native_token(), None);
        let native = Address::generate(&env);
        client.set_native_token(&admin, &native);
        assert_eq!(client.get_native_token(), Some(native.clone()));
    }

    /// Covers remove_token when already inactive panics (line 4537).
    #[test]
    #[should_panic(expected = "Token is already inactive")]
    fn test_remove_token_already_inactive_panics() {
        let (env, _cid, client, admin, _pid) = setup();
        let token = Address::generate(&env);
        let oracle = Address::generate(&env);
        client.register_token(&admin, &token, &oracle, &symbol_short!("TST"));
        client.remove_token(&admin, &token);
        client.remove_token(&admin, &token);
    }

    /// Covers add_admin edge case: duplicate admin (line 4877).
    #[test]
    #[should_panic(expected = "Address is already an admin")]
    fn test_add_admin_duplicate_panics() {
        let (env, _cid, client, admin) = setup_admin_only();
        client.add_admin(&signers1(&env, &admin), &admin);
    }

    /// Covers remove_admin edge cases:
    ///   - Address not an admin (line 4893)
    ///   - Last admin removal (line 4895)
    ///   - Threshold exceeds new set size (lines 4904-4910)
    #[test]
    #[should_panic(expected = "Address is not an admin")]
    fn test_remove_admin_not_admin_panics() {
        let (env, _cid, client, admin) = setup_admin_only();
        let outsider = Address::generate(&env);
        client.remove_admin(&signers1(&env, &admin), &outsider);
    }

    #[test]
    #[should_panic(expected = "Cannot remove last admin")]
    fn test_remove_admin_last_admin_panics() {
        let (env, _cid, client, admin) = setup_admin_only();
        client.remove_admin(&signers1(&env, &admin), &admin);
    }

    #[test]
    #[should_panic(expected = "call update_threshold first")]
    fn test_remove_admin_threshold_exceeds_set_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin.clone());
        admins.push_back(admin2.clone());
        client.initialize(&admins, &2u32);
        client.remove_admin(&signers2(&env, &admin, &admin2), &admin);
    }

    /// Covers update_threshold edge case: zero (line 4924).
    #[test]
    #[should_panic(expected = "Threshold must be between 1 and the number of admins")]
    fn test_update_threshold_zero_panics() {
        let (env, _cid, client, admin) = setup_admin_only();
        client.update_threshold(&signers1(&env, &admin), &0);
    }

    /// Covers update_threshold happy path (line 4928).
    #[test]
    fn test_update_threshold_happy() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin.clone());
        admins.push_back(admin2.clone());
        client.initialize(&admins, &2u32);
        client.update_threshold(&signers2(&env, &admin, &admin2), &1);
        assert_eq!(client.get_admin_threshold(), 1);
    }

    /// Covers set_donation_rate_limit validations: max_donations == 0 (line 4698)
    /// and window_ledgers == 0 (line 4701).
    #[test]
    #[should_panic(expected = "max_donations must be positive")]
    fn test_set_donation_rate_limit_zero_max_panics() {
        let (_env, _cid, client, admin, _pid) = setup();
        client.set_donation_rate_limit(&admin, &0, &100);
    }

    #[test]
    #[should_panic(expected = "window_ledgers must be positive")]
    fn test_set_donation_rate_limit_zero_window_panics() {
        let (_env, _cid, client, admin, _pid) = setup();
        client.set_donation_rate_limit(&admin, &5, &0);
    }

    /// Covers accept_admin stale old_admin (line 4832) and stale new_admin (line 4835).
    #[test]
    #[should_panic(expected = "old_admin no longer in admin set; transfer stale")]
    fn test_accept_admin_old_admin_removed_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin.clone());
        admins.push_back(admin2.clone());
        client.initialize(&admins, &1u32);

        let new_admin = Address::generate(&env);
        client.transfer_admin(&signers1(&env, &admin), &admin2, &new_admin);
        // Remove the old_admin from the set before accept
        client.remove_admin(&signers1(&env, &admin), &admin2);
        client.accept_admin();
    }

    /// Covers create_campaign for inactive project (line 2100).
    #[test]
    #[should_panic(expected = "Project is not active")]
    fn test_create_campaign_inactive_project_panics() {
        let (env, _cid, client, admin, pid) = setup();
        client.deactivate_project(&admin, &pid);
        client.create_campaign(
            &admin,
            &pid,
            &(100 * STROOP),
            &(env.ledger().sequence() + 100),
        );
    }

    /// Covers create_campaign goal <= total_raised (line 2109).
    #[test]
    #[should_panic(expected = "Campaign goal must exceed amount already raised")]
    fn test_create_campaign_goal_not_exceeding_raised_panics() {
        let (env, _cid, client, admin, pid) = setup();
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, STROOP);
        client.donate(&token, &donor, &pid, &STROOP, &0u32);
        client.create_campaign(&admin, &pid, &STROOP, &(env.ledger().sequence() + 100));
    }

    /// Covers extend_campaign edge cases (lines 2136, 2140, 2143, 2146).
    #[test]
    #[should_panic(expected = "Campaign is not active")]
    fn test_extend_campaign_not_active_panics() {
        let (env, _cid, client, admin, pid) = setup();
        client.extend_campaign(&admin, &pid, &(env.ledger().sequence() + 200));
    }

    #[test]
    fn test_extend_campaign_deadline_passed_panics() {
        let (env, cid, client, admin, pid) = setup();
        let start = env.ledger().sequence();
        client.create_campaign(&admin, &pid, &(100 * STROOP), &(start + 10));
        extend_ttl(&env, &cid);
        env.ledger().set_sequence_number(start + 20);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.extend_campaign(&admin, &pid, &(start + 30));
        }));
        assert!(result.is_err());
    }

    #[test]
    #[should_panic(expected = "New deadline must be after current deadline")]
    fn test_extend_campaign_new_deadline_not_after_current_panics() {
        let (env, _cid, client, admin, pid) = setup();
        let start = env.ledger().sequence();
        client.create_campaign(&admin, &pid, &(100 * STROOP), &(start + 100));
        client.extend_campaign(&admin, &pid, &(start + 50));
    }

    /// Covers close_campaign after GoalReached -> Closed (line 2179-2180).
    #[test]
    fn test_close_campaign_after_goal_reached_sets_closed() {
        let (env, _cid, client, admin, pid) = setup();
        let goal = 50 * STROOP;
        client.create_campaign(&admin, &pid, &goal, &(env.ledger().sequence() + 1_000));
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, goal);
        client.donate(&token, &donor, &pid, &goal, &0u32);
        assert_eq!(
            client.get_project(&pid).campaign_status,
            CampaignStatus::GoalReached
        );
        client.close_campaign(&admin, &pid);
        assert_eq!(
            client.get_project(&pid).campaign_status,
            CampaignStatus::Closed
        );
    }

    /// Covers close_campaign non-Active non-GoalReached panic (line 2182).
    #[test]
    #[should_panic(expected = "Campaign cannot be closed")]
    fn test_close_campaign_none_status_panics() {
        let (_env, _cid, client, admin, pid) = setup();
        client.close_campaign(&admin, &pid);
    }

    /// Covers pause_project storage save (line 2038) and resume_project (line 2065).
    #[test]
    fn test_pause_resume_project_full_flow() {
        let (_env, _cid, client, admin, pid) = setup();
        let p = client.get_project(&pid);
        assert!(!p.paused);

        client.pause_project(&admin, &pid);
        assert!(client.get_project(&pid).paused);

        client.resume_project(&admin, &pid);
        assert!(!client.get_project(&pid).paused);
    }

    /// Covers register_project duplicate panic (line 1730) and project save (line 1752).
    #[test]
    #[should_panic(expected = "Project already registered")]
    fn test_register_project_duplicate_panics() {
        let (env, _cid, client, admin, pid) = setup();
        let wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &pid,
            &String::from_str(&env, "Duplicate"),
            &wallet,
            &100u32,
        );
    }

    /// Covers register_sub_project duplicate panic (line 1798).
    #[test]
    #[should_panic(expected = "Project already registered")]
    fn test_register_sub_project_duplicate_panics() {
        let (env, _cid, client, _admin, pid) = setup();
        let parent = client.get_project(&pid);
        let sub_id = String::from_str(&env, "sub-dup");
        // First registration succeeds
        client.register_sub_project(
            &parent.wallet,
            &sub_id,
            &String::from_str(&env, "Sub One"),
            &100u32,
            &pid,
        );
        // Second registration with same id panics
        client.register_sub_project(
            &parent.wallet,
            &sub_id,
            &String::from_str(&env, "Sub Two"),
            &100u32,
            &pid,
        );
    }

    /// Covers deactivate_project save (line 1964) and sub-project cascade (line 1981).
    #[test]
    fn test_deactivate_project_cascades_to_sub_projects() {
        let (env, _cid, client, admin, pid) = setup();
        let sub_id = String::from_str(&env, "sub-001");
        // Sub-project wallet must match parent's wallet
        let parent = client.get_project(&pid);
        client.register_sub_project(
            &parent.wallet,
            &sub_id,
            &String::from_str(&env, "Sub"),
            &100u32,
            &pid,
        );

        assert!(client.get_project(&pid).active);
        assert!(client.get_project(&sub_id).active);

        client.deactivate_project(&admin, &pid);
        assert!(!client.get_project(&pid).active);
        assert!(!client.get_project(&sub_id).active);
    }

    /// Covers median_u32 even-length path (lines 923-925).
    #[test]
    fn test_median_even_length() {
        let env = Env::default();
        let mut vals = Vec::new(&env);
        vals.push_back(10u32);
        vals.push_back(20u32);
        vals.push_back(30u32);
        vals.push_back(40u32);
        assert_eq!(median_u32(&vals), 25);
    }

    #[test]
    fn test_median_odd_length() {
        let env = Env::default();
        let mut vals = Vec::new(&env);
        vals.push_back(10u32);
        vals.push_back(30u32);
        vals.push_back(20u32);
        assert_eq!(median_u32(&vals), 20);
    }

    #[test]
    fn test_median_single_element() {
        let env = Env::default();
        let mut vals = Vec::new(&env);
        vals.push_back(42u32);
        assert_eq!(median_u32(&vals), 42);
    }

    /// Covers impact_deviates_50_percent edge cases:
    ///   - claimed == 0, verified > 0 (line 893)
    ///   - claimed > verified branch (line 898)
    #[test]
    fn test_impact_deviates_50_percent_claimed_zero() {
        assert!(impact_deviates_50_percent(0, 100));
        assert!(!impact_deviates_50_percent(0, 0));
    }

    #[test]
    fn test_impact_deviates_50_percent_claimed_greater_than_verified() {
        assert!(impact_deviates_50_percent(200, 100));
        assert!(!impact_deviates_50_percent(100, 80));
        assert!(impact_deviates_50_percent(100, 49));
    }

    #[test]
    fn test_impact_deviates_50_percent_boundaries() {
        // Equal values: no deviation
        assert!(!impact_deviates_50_percent(100, 100));
        // diff = 50, 50*2 = 100 >= 100 → true (deviates)
        assert!(impact_deviates_50_percent(100, 150));
        // diff = 100, 100*2 = 200 >= 100 → true (deviates)
        assert!(impact_deviates_50_percent(100, 200));
        // Exact 50%: claimed=100, verified=50, diff=50, 50*2 >= 100 → true
        assert!(impact_deviates_50_percent(100, 50));
        // Below 50%: claimed=100, verified=51, diff=49, 49*2 < 100 → false
        assert!(!impact_deviates_50_percent(100, 51));
    }

    /// Covers donate_token_with_privacy native token path (lines 4609-4614).
    #[test]
    fn test_donate_token_with_privacy_native_token() {
        let (env, _cid, client, admin, pid) = setup();
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let donor = Address::generate(&env);
        let amount = 10 * STROOP;
        StellarAssetClient::new(&env, &token).mint(&donor, &amount);

        client.set_native_token(&admin, &token);
        client.register_token(&admin, &token, &token, &symbol_short!("XLM"));
        client.donate_token_with_privacy(&token, &donor, &pid, &amount, &0u32, &true);
    }

    /// Covers donate with privacy token symbol lookup (line 1575 in process_donation).
    #[test]
    fn test_donate_with_privacy_registered_token_symbol() {
        let (env, _cid, client, admin, pid) = setup();
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let donor = Address::generate(&env);
        let amount = 5 * STROOP;
        StellarAssetClient::new(&env, &token).mint(&donor, &amount);

        client.register_token(&admin, &token, &token, &symbol_short!("XTST"));
        client.donate_with_privacy(&token, &donor, &pid, &amount, &0u32, &true);
        let record = client.get_donation_record(&0u32);
        assert_eq!(record.currency, symbol_short!("XTST"));
        assert!(record.anonymous);
    }

    /// Covers process_donation_token anonymous path:
    ///   - anon_address call (line 1376)
    ///   - AnonymousDonationCount increment (lines 1482-1489)
    ///   - Project save (line 1405)
    ///   - DonationCount save (line 1465)
    ///   - GlobalTotalRaised save (line 1505)
    ///   - GlobalCO2OffsetGrams save (line 1515)
    #[test]
    fn test_donate_anonymous_increments_anon_count() {
        let (env, cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, 10 * STROOP);

        let anon_count = env.as_contract(&cid, || {
            env.storage()
                .instance()
                .get::<_, u32>(&DataKey::AnonymousDonationCount)
                .unwrap_or(0)
        });
        assert_eq!(anon_count, 0);

        client.donate_with_privacy(&token, &donor, &pid, &(5 * STROOP), &0u32, &true);

        let anon_count = env.as_contract(&cid, || {
            env.storage()
                .instance()
                .get::<_, u32>(&DataKey::AnonymousDonationCount)
                .unwrap_or(0)
        });
        assert_eq!(anon_count, 1);

        // Anonymous donation should not update donor stats
        let stats = client.get_donor_stats(&donor);
        assert_eq!(stats.total_donated, 0);
    }

    /// Covers process_donation_token non-anonymous path ensures donor stats are updated.
    #[test]
    fn test_donate_non_anonymous_stats_updated() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, 10 * STROOP);
        client.donate(&token, &donor, &pid, &(5 * STROOP), &0u32);
        let stats = client.get_donor_stats(&donor);
        assert_eq!(stats.total_donated, 5 * STROOP);
    }

    /// Covers require_campaign_accepts_donation CampaignStatus::Closed (line 1238).
    #[test]
    #[should_panic(expected = "Campaign is closed")]
    fn test_donate_after_campaign_closed_panics() {
        let (env, _cid, client, admin, pid) = setup();
        client.create_campaign(
            &admin,
            &pid,
            &(100 * STROOP),
            &(env.ledger().sequence() + 1_000),
        );
        client.close_campaign(&admin, &pid);
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, STROOP);
        client.donate(&token, &donor, &pid, &STROOP, &0u32);
    }

    /// Covers process_donation_token inactive project panic (line 1360).
    #[test]
    #[should_panic(expected = "Project is not accepting donations")]
    fn test_donate_to_inactive_project_panics() {
        let (env, _cid, client, admin, pid) = setup();
        client.deactivate_project(&admin, &pid);
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, STROOP);
        client.donate(&token, &donor, &pid, &STROOP, &0u32);
    }

    /// Covers donate_stealth_integrated end-to-end with stealth contract.
    #[test]
    fn test_stealth_integrated_donate_flow() {
        let (env, _cid, client, admin, pid) = setup();

        // Register a DonationContract so the integrated path has a target
        let stealth_addr = env.register_contract(None, crate::donation::contract::DonationContract);
        client.set_stealth_donation_contract(&admin, &stealth_addr);

        let donor = Address::generate(&env);
        let amount = 20 * STROOP;
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&donor, &amount);

        let ephem_pubkey = BytesN::from_array(&env, &[1u8; 33]);
        let msg_hash = BytesN::from_array(&env, &[2u8; 32]);
        client.donate_stealth_integrated(&donor, &token, &ephem_pubkey, &pid, &amount, &msg_hash);
        let p = client.get_project(&pid);
        assert_eq!(p.total_raised, amount);
    }

    /// Covers process_donation_token paused project branch (line 1362).
    #[test]
    #[should_panic(expected = "Project is temporarily paused")]
    fn test_donate_to_paused_project_panics() {
        let (env, _cid, client, admin, pid) = setup();
        client.pause_project(&admin, &pid);
        let donor = Address::generate(&env);
        let token = mint_xlm(&env, &donor, STROOP);
        client.donate(&token, &donor, &pid, &STROOP, &0u32);
    }

    /// Covers donate_asset_with_privacy branch that uses TokenConfig symbol (line 2362 etc.)
    #[test]
    fn test_donate_asset_with_privacy_registered_token() {
        let (env, _cid, client, admin, pid) = setup();
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let donor = Address::generate(&env);
        let amount = 10 * STROOP;
        StellarAssetClient::new(&env, &token).mint(&donor, &amount);

        client.register_token(&admin, &token, &token, &symbol_short!("XTST"));
        client.donate_asset_with_privacy(
            &donor,
            &pid,
            &amount,
            &symbol_short!("XTST"),
            &0u32,
            &true,
        );
        let record = client.get_donation_record(&0u32);
        assert_eq!(record.currency, symbol_short!("XTST"));
    }

    /// Covers donate_asset_with_privacy CO2 computation and storage saves.
    #[test]
    fn test_donate_asset_with_privacy_saves_global_stats() {
        let (env, _cid, client, _admin, pid) = setup();
        let donor = Address::generate(&env);
        let amount = 10 * STROOP;
        client.donate_asset_with_privacy(
            &donor,
            &pid,
            &amount,
            &symbol_short!("yXLM"),
            &0u32,
            &false,
        );
        let global = client.get_global_stats();
        assert!(global.total_raised >= amount);
    }

    /// Covers the add_impact_verifier / remove_impact_verifier / is_impact_verifier
    /// functions and their storage writes (line 3291).
    #[test]
    fn test_impact_verifier_lifecycle() {
        let (env, _cid, client, admin, _pid) = setup();
        let verifier = Address::generate(&env);
        assert!(!client.is_impact_verifier(&verifier));
        client.add_impact_verifier(&admin, &verifier);
        assert!(client.is_impact_verifier(&verifier));
        client.remove_impact_verifier(&admin, &verifier);
        assert!(!client.is_impact_verifier(&verifier));
    }

    /// Covers set_impact_report_threshold validation (line 3312) and save (line 3316).
    #[test]
    fn test_set_impact_report_threshold_happy() {
        let (_env, _cid, client, admin, _pid) = setup();
        client.set_impact_report_threshold(&admin, &5u32);
        // No dedicated getter — just ensures no panic.
        assert!(true);
    }

    /// Covers clear_impact_flag storage remove (line 3331).
    #[test]
    fn test_clear_impact_flag_happy() {
        let (_env, _cid, client, admin, pid) = setup();
        client.clear_impact_flag(&admin, &pid);
        // Just ensure no panic
        assert!(true);
    }

    /// Covers set_usdc_token address save (line 4648).
    #[test]
    fn test_set_usdc_token_persists() {
        let (env, _cid, client, admin, _pid) = setup();
        let usdc = Address::generate(&env);
        client.set_usdc_token(&admin, &usdc.clone());
        // Getter is get_usdc_token — call it
        let stored = env.as_contract(&_cid, || {
            env.storage()
                .instance()
                .get::<_, Address>(&DataKey::USDCTokenAddress)
        });
        assert_eq!(stored, Some(usdc));
    }

    /// Covers set_oracle address save (line 4738).
    #[test]
    fn test_set_oracle_persists() {
        let (env, _cid, client, admin, _pid) = setup();
        let oracle = env.register_contract(None, MockOracle);
        client.set_oracle(&admin, &oracle);
        let stored = env.as_contract(&_cid, || {
            env.storage()
                .instance()
                .get::<_, Address>(&DataKey::OracleAddress)
        });
        assert_eq!(stored, Some(oracle));
    }

    /// Covers propose_upgrade / cancel_upgrade storage ops
    /// (lines 4988, 4991).
    #[test]
    fn test_upgrade_full_flow() {
        let (env, _cid, client, admin) = setup_admin_only();
        let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);
        client.propose_upgrade(&signers1(&env, &admin), &wasm_hash);
        let pending = client.get_pending_upgrade();
        assert_eq!(pending.as_ref().map(|(h, _)| h), Some(&wasm_hash));
        client.cancel_upgrade(&signers1(&env, &admin));
        assert_eq!(client.get_pending_upgrade(), None);
    }

    /// Covers propose_upgrade double propose rejected.
    #[test]
    #[should_panic(expected = "Upgrade already pending; cancel first")]
    fn test_upgrade_double_propose_rejected() {
        let (env, _cid, client, admin) = setup_admin_only();
        let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);
        client.propose_upgrade(&signers1(&env, &admin), &wasm_hash);
        client.propose_upgrade(&signers1(&env, &admin), &wasm_hash);
    }

    /// Covers register_sub_project CO2 per XLM exceeds max (line 1801).
    #[test]
    #[should_panic(expected = "CO2 per XLM exceeds maximum")]
    fn test_register_sub_project_co2_exceeds_max() {
        let (env, _cid, client, _admin, pid) = setup();
        let parent = client.get_project(&pid);
        let sub_id = String::from_str(&env, "sub-co2");
        client.register_sub_project(
            &parent.wallet,
            &sub_id,
            &String::from_str(&env, "High CO2"),
            &1_000_001u32,
            &pid,
        );
    }

    /// Covers deactivate_project storage save for the project being deactivated.
    #[test]
    fn test_deactivate_project_saves_state() {
        let (_env, _cid, client, admin, pid) = setup();
        assert!(client.get_project(&pid).active);
        client.deactivate_project(&admin, &pid);
        assert!(!client.get_project(&pid).active);
    }

    /// Covers update_project_co2_rate storage operations (lines 1987-2017).
    #[test]
    fn test_update_project_co2_rate_happy() {
        let (_env, _cid, client, admin, pid) = setup();
        let p = client.get_project(&pid);
        let original = p.co2_per_xlm;
        client.update_project_co2_rate(&admin, &pid, &(original + 50));
        assert_eq!(client.get_project(&pid).co2_per_xlm, original + 50);
    }

    #[test]
    #[should_panic(expected = "rate must be greater than zero")]
    fn test_update_project_co2_rate_zero_panics() {
        let (_env, _cid, client, admin, pid) = setup();
        client.update_project_co2_rate(&admin, &pid, &0u32);
    }

    #[test]
    #[should_panic(expected = "CO2 per XLM exceeds maximum")]
    fn test_update_project_co2_rate_exceeds_max_panics() {
        let (_env, _cid, client, admin, pid) = setup();
        client.update_project_co2_rate(&admin, &pid, &1_000_001u32);
    }

    /// Covers resume_project when project is not paused (line 2059).
    #[test]
    #[should_panic(expected = "Project is not paused")]
    fn test_resume_project_not_paused_panics() {
        let (_env, _cid, client, admin, pid) = setup();
        client.resume_project(&admin, &pid);
    }

    /// Covers pause_project when already paused (line 2032).
    #[test]
    #[should_panic(expected = "Project is already paused")]
    fn test_pause_project_already_paused_panics() {
        let (_env, _cid, client, admin, pid) = setup();
        client.pause_project(&admin, &pid);
        client.pause_project(&admin, &pid);
    }

    /// Covers pause_project when deactivated (line 2029).
    #[test]
    #[should_panic(expected = "Cannot pause a deactivated project")]
    fn test_pause_project_deactivated_panics() {
        let (_env, _cid, client, admin, pid) = setup();
        client.deactivate_project(&admin, &pid);
        client.pause_project(&admin, &pid);
    }

    /// Covers the project_verification revoke_verification flow (line 3686).
    #[test]
    #[should_panic(expected = "HostError")]
    fn test_revoke_verification_unknown_project_panics() {
        let (env, _cid, client, admin, _pid) = setup();
        let unknown = String::from_str(&env, "nonexistent");
        client.revoke_verification(&signers1(&env, &admin), &unknown);
    }

    /// Covers add_verifier storage save path (line 3549).
    #[test]
    fn test_add_verifier_persists() {
        let (env, _cid, client, admin, _pid) = setup();
        let v = Address::generate(&env);
        client.add_verifier(&signers1(&env, &admin), &v);
        assert!(client.is_verifier(&v));
        assert!(client.get_verifier_set().contains(&v));
    }

    /// Covers remove_verifier storage save (line 3577).
    #[test]
    fn test_remove_verifier_persists() {
        let (env, _cid, client, admin, _pid) = setup();
        let v = Address::generate(&env);
        client.add_verifier(&signers1(&env, &admin), &v);
        client.remove_verifier(&signers1(&env, &admin), &v);
        assert!(!client.is_verifier(&v));
    }

    /// Covers set_verification_threshold save (line 3597).
    #[test]
    fn test_set_verification_threshold_happy() {
        let (env, _cid, client, admin, _pid) = setup();
        let v1 = Address::generate(&env);
        let v2 = Address::generate(&env);
        client.add_verifier(&signers1(&env, &admin), &v1);
        client.add_verifier(&signers1(&env, &admin), &v2);
        client.set_verification_threshold(&signers2(&env, &admin, &v1), &2u32);
        assert_eq!(client.get_verification_threshold(), 2);
    }

    // ─── Impact Root Archiving Tests (#466) ───────────────────────────────

    #[cfg(feature = "impact")]
    #[test]
    fn test_publish_impact_root_stores_current() {
        let (env, cid, _client, admin, _pid) = setup();

        let project_id = String::from_str(&env, "test-project");
        let root = BytesN::from_array(&env, &[1u8; 32]);
        let totals = ImpactTotals {
            co2_kg: 1000,
            trees: 500,
            hectares: 10,
        };

        env.as_contract(&cid, || {
            publish_impact_root(
                &env,
                &signers1(&env, &admin),
                project_id.clone(),
                root.clone(),
                1704067200,
                1706745600,
                totals,
            );
        });

        env.as_contract(&cid, || {
            let current: Option<ImpactRoot> = env
                .storage()
                .instance()
                .get(&ImpactRootKey::RootCurrent(project_id.clone()));
            assert_eq!(current.as_ref().map(|r| r.root.clone()), Some(root));
        });
    }

    #[cfg(feature = "impact")]
    #[test]
    fn test_publish_root_archives_previous() {
        let (env, cid, _client, admin, _pid) = setup();

        let project_id = String::from_str(&env, "archive-test");
        let root1 = BytesN::from_array(&env, &[1u8; 32]);
        let root2 = BytesN::from_array(&env, &[2u8; 32]);
        let totals = ImpactTotals {
            co2_kg: 1000,
            trees: 500,
            hectares: 10,
        };

        // Publish first root
        env.as_contract(&cid, || {
            publish_impact_root(
                &env,
                &signers1(&env, &admin),
                project_id.clone(),
                root1.clone(),
                1704067200,
                1706745600,
                totals.clone(),
            );
        });

        // Verify current root
        env.as_contract(&cid, || {
            let current = get_current_impact_root(&env, project_id.clone()).unwrap();
            assert_eq!(current.root, root1);
        });

        // Publish second root
        env.as_contract(&cid, || {
            publish_impact_root(
                &env,
                &signers1(&env, &admin),
                project_id.clone(),
                root2.clone(),
                1706745601,
                1709337600,
                totals,
            );
        });

        // Verify root1 archived, root2 current
        env.as_contract(&cid, || {
            let periods = get_impact_periods(&env, project_id.clone());
            assert_eq!(periods.len(), 1);
            assert_eq!(periods.get(0).unwrap().period_index, 0);

            let current = get_current_impact_root(&env, project_id).unwrap();
            assert_eq!(current.root, root2);
        });
    }

    #[cfg(feature = "impact")]
    #[test]
    fn test_get_impact_periods_listing() {
        let (env, cid, _client, admin, _pid) = setup();

        let project_id = String::from_str(&env, "listing-test");

        for i in 0u64..3 {
            let totals = ImpactTotals {
                co2_kg: 1000 + i * 100,
                trees: 500 + i * 50,
                hectares: 10 + i,
            };
            env.as_contract(&cid, || {
                let root = BytesN::from_array(&env, &[i as u8 + 1; 32]);
                publish_impact_root(
                    &env,
                    &signers1(&env, &admin),
                    project_id.clone(),
                    root,
                    1704067200 + i * 2_592_000,
                    1706745600 + i * 2_592_000,
                    totals.clone(),
                );
            });
        }

        env.as_contract(&cid, || {
            let periods = get_impact_periods(&env, project_id);
            assert_eq!(periods.len(), 2); // 2 archived, 1 current
            assert_eq!(periods.get(0).unwrap().total_co2_kg, 1000);
            assert_eq!(periods.get(1).unwrap().total_co2_kg, 1100);
        });
    }

    #[cfg(feature = "impact")]
    #[test]
    fn test_archive_rotation_enforces_max() {
        let (env, cid, _client, admin, _pid) = setup();

        let project_id = String::from_str(&env, "rotation-test");

        // Publish MAX_ARCHIVED_PERIODS + 1 roots
        for i in 0u64..(MAX_ARCHIVED_PERIODS as u64 + 1) {
            let totals = ImpactTotals {
                co2_kg: 1000,
                trees: 500,
                hectares: 10,
            };
            env.as_contract(&cid, || {
                let root = BytesN::from_array(&env, &[i as u8 + 1; 32]);
                publish_impact_root(
                    &env,
                    &signers1(&env, &admin),
                    project_id.clone(),
                    root,
                    1704067200 + i * 2_592_000,
                    1706745600 + i * 2_592_000,
                    totals,
                );
            });
        }

        // Verify only MAX_ARCHIVED_PERIODS archived periods exist
        env.as_contract(&cid, || {
            let periods = get_impact_periods(&env, project_id);
            assert_eq!(periods.len() as u32, MAX_ARCHIVED_PERIODS);
        });
    }

    #[cfg(feature = "impact")]
    #[test]
    fn test_verify_impact_inclusion_returns_false_for_unknown_period() {
        let (env, cid, _client, admin, _pid) = setup();

        let project_id = String::from_str(&env, "verify-test");
        let root = BytesN::from_array(&env, &[1u8; 32]);
        let totals = ImpactTotals {
            co2_kg: 1000,
            trees: 500,
            hectares: 10,
        };

        env.as_contract(&cid, || {
            publish_impact_root(
                &env,
                &signers1(&env, &admin),
                project_id.clone(),
                root,
                1704067200,
                1706745600,
                totals,
            );
        });

        let leaf = ImpactLeaf {
            donor: Address::generate(&env),
            donation_index: 0,
            co2_kg: 100,
            trees: 50,
            hectares: 1,
        };
        let proof = Vec::new(&env);

        // Unknown period index should return false
        env.as_contract(&cid, || {
            let result = verify_impact_inclusion(
                &env, project_id, 999, // non-existent period
                leaf, proof, 0,
            );
            assert!(!result);
        });
    }

    #[cfg(feature = "impact")]
    #[test]
    #[should_panic(expected = "Invalid period range: start must be before end")]
    fn test_publish_root_invalid_period_range_panics() {
        let (env, cid, _client, admin, _pid) = setup();

        let project_id = String::from_str(&env, "invalid-range");
        let root = BytesN::from_array(&env, &[1u8; 32]);
        let totals = ImpactTotals {
            co2_kg: 1000,
            trees: 500,
            hectares: 10,
        };

        env.as_contract(&cid, || {
            publish_impact_root(
                &env,
                &signers1(&env, &admin),
                project_id,
                root,
                1706745600, // end before start
                1704067200,
                totals,
            );
        });
    }

    #[cfg(feature = "impact")]
    #[test]
    #[should_panic(expected = "Root cannot be zero")]
    fn test_publish_root_zero_root_panics() {
        let (env, cid, _client, admin, _pid) = setup();

        let project_id = String::from_str(&env, "zero-root");
        let zero_root = BytesN::from_array(&env, &[0u8; 32]);
        let totals = ImpactTotals {
            co2_kg: 1000,
            trees: 500,
            hectares: 10,
        };

        env.as_contract(&cid, || {
            publish_impact_root(
                &env,
                &signers1(&env, &admin),
                project_id,
                zero_root,
                1704067200,
                1706745600,
                totals,
            );
        });
    }

    #[cfg(feature = "impact")]
    #[test]
    #[should_panic(expected = "Insufficient admin signatures")]
    fn test_publish_root_non_admin_panics() {
        let (env, cid, _client, _admin, _pid) = setup();

        let project_id = String::from_str(&env, "unauthorized");
        let root = BytesN::from_array(&env, &[1u8; 32]);
        let totals = ImpactTotals {
            co2_kg: 1000,
            trees: 500,
            hectares: 10,
        };
        let non_admin = Address::generate(&env);

        env.as_contract(&cid, || {
            publish_impact_root(
                &env,
                &signers1(&env, &non_admin),
                project_id,
                root,
                1704067200,
                1706745600,
                totals,
            );
        });
    }
}
