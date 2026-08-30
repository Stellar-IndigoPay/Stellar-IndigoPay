#![no_std]
// WS2: forbid `.unwrap()` / `.expect()` in production code.
#![deny(clippy::unwrap_used)]
#![deny(clippy::expect_used)]

//! Escrow contract with milestone-based fund release.
//! Client locks funds with `create_job`, then releases them per milestone.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, BytesN, Env, String, Vec,
};

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum JobStatus {
    Escrowed,
    PartiallyReleased,
    Completed,
    Disputed,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Milestone {
    pub name: String,
    pub percentage: u32, // 0-100
    pub released: bool,
    pub disputed: bool,
    pub oracle: Option<Address>,
    pub verified: bool,
    pub proof_hash: Option<BytesN<32>>,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Job {
    pub id: String,
    pub client: Address,
    pub freelancer: Address,
    pub token: Address,
    pub amount: i128,
    pub status: JobStatus,
    pub milestones: Vec<Milestone>,
    pub disputed: bool,
    pub release_after: u32,
    pub deadline: u32,
}

/// Append-only aggregate of a freelancer's escrow history.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FreelancerReputation {
    pub total_jobs: u32,
    pub completed_jobs: u32,
    pub disputed_jobs: u32,
    pub total_value_completed: i128,
    pub on_time_completions: u32,
    pub created_at: u32,
}

#[contracttype]
pub enum DataKey {
    Job(String),
    // Multi-sig admin set: Vec<Address> of authorized admin addresses.
    // Replaces the former single-admin `Admin` variant.
    AdminSet,
    // M-of-N threshold required to authorize admin-gated actions. Must
    // satisfy 1 <= threshold <= admin_set.len().
    AdminThreshold,
    JobCount,
    JobIds,
    AmendmentCount(String),
    FreelancerReputation(Address),
    // Ensures multiple milestone disputes on one job count only once.
    ReputationDisputeCounted(String),
}

/// Minimum number of ledgers a job's release period may specify. Jobs
/// cannot request a shorter freelancer auto-claim window than this; it is
/// a floor, not a default — callers must pass their own `release_after`
/// to `create_job`.
pub const RELEASE_AFTER_LEDGERS: u32 = 10;
pub const DEFAULT_DEADLINE_LEDGERS: u32 = 1_555_200; // 90 days @ 5s/ledger
pub const MAX_MILESTONE_NAME_LEN: u32 = 64; // bytes; enforced at create + amend

/// Grace period (in ledgers) after a job's `deadline` during which a
/// completed job is not yet eligible for archival by
/// `cleanup_completed_jobs`. A completed job is cleaned up only once
/// `deadline + GRACE_PERIOD` strictly precedes the current ledger, so
/// recently-completed history cannot be swept immediately.
pub const GRACE_PERIOD: u32 = 86_400; // 5 days @ 5s/ledger

/// Hard cap on the number of jobs kept in instance storage. `create_job`
/// rejects new jobs once the stored count reaches this limit
/// (`JobCountExceedsMaximum`).
pub const MAX_JOBS: u32 = 256;

/// Maximum page size accepted by `get_job_ids(from, count)`. Larger `count`
/// values are rejected with `JobIdsPageSizeExceedsMaximum`.
pub const MAX_JOB_IDS_PAGE_SIZE: u32 = 100;

// ─── Contract error codes ───────────────────────────────────────────────────
//
// Every error returned by the escrow contract carries a unique numeric code.
// Clients and indexers can match on the code without parsing panic strings.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum EscrowError {
    // ── Initialization (1–5) ─────────────────────────────────────────────
    AlreadyInitialized = 1,
    AdminSetMustNotBeEmpty = 2,
    ThresholdMustBeBetweenOneAndAdminCount = 3,
    NotInitialized = 4,
    JobCountAlreadyInitialized = 5,
    // ── Job creation (6–15) ──────────────────────────────────────────────
    AmountMustBePositive = 6,
    ReleaseAfterBelowMinimum = 7,
    JobAlreadyExists = 8,
    MilestonesMustSumTo100 = 9,
    ReleaseAfterExceedsDeadline = 10,
    MilestonePercentageZero = 11,
    MilestoneNameTooLong = 12,
    JobIdTooLong = 13,
    MilestoneVectorEmpty = 14,
    DuplicateMilestoneName = 15,
    // ── Job amendment (16–22) ────────────────────────────────────────────
    OnlyJobClientCanAmend = 16,
    OnlyJobFreelancerCanAmend = 17,
    AmendmentOnlyBeforeRelease = 18,
    NewMilestonesMustNotBeReleasedOrDisputed = 19,
    AmendmentCountOverflow = 20,
    ClientAddressMismatch = 21,
    FreelancerAddressMismatch = 22,
    // ── Milestone release (23–30) ────────────────────────────────────────
    OnlyClientCanRelease = 23,
    JobDisputedAdminMustResolve = 24,
    InvalidMilestoneIndex = 25,
    MilestoneIsDisputed = 26,
    MilestoneAlreadyReleased = 27,
    MilestoneNotVerifiedByOracle = 28,
    ReleasedCountOverflow = 29,
    ReleaseAmountCalculationFailed = 30,
    // ── Oracle proof submission / verification (31–38) ───────────────────
    OnlyAssignedFreelancerCanSubmitProof = 31,
    MilestoneAlreadyCompleted = 32,
    MilestoneHasNoOracleConfigured = 33,
    OnlyConfiguredOracleCanVerify = 34,
    NoProofSubmittedYet = 35,
    OracleAddressInvalid = 36,
    ProofHashInvalid = 37,
    ProofVerificationFailed = 38,
    // ── Dispute resolution (39–46) ───────────────────────────────────────
    JobIsNotDisputed = 39,
    MilestoneAlreadyDisputed = 40,
    MilestoneIsNotDisputed = 41,
    InsufficientAdminSignatures = 42,
    DisputeResolutionFailed = 43,
    MilestoneDisputedCannotClaimMilestone = 44,
    JobDisputedCannotClaimMilestone = 45,
    DisputeJobAlreadyDisputed = 46,
    // ── Refund & claims (47–55) ──────────────────────────────────────────
    OnlyClientCanRequestRefund = 47,
    JobDeadlineHasNotPassed = 48,
    CannotRefundMilestonesClaimed = 49,
    OnlyJobFreelancerCanClaim = 50,
    ReleasePeriodNotReached = 51,
    RefundTransferFailed = 52,
    ClaimTransferFailed = 53,
    RefundAmountCalculationFailed = 54,
    ClaimAmountCalculationFailed = 55,
    // ── Admin management (56–62) ─────────────────────────────────────────
    NewReleaseAfterMustExtendCurrent = 56,
    AddressAlreadyAdmin = 57,
    AddressNotAdmin = 58,
    CannotRemoveLastAdmin = 59,
    ThresholdExceedsAdminCount = 60,
    AdminTransferInProgress = 61,
    AdminSetUpdateFailed = 62,
    // ── Job enumeration (63–64) ───────────────────────────────────────────
    JobIdsPageSizeExceedsMaximum = 63,
    JobCountExceedsMaximum = 64,
    // ── Job cleanup / archival (65) ─────────────────────────────────────
    NothingToCleanUp = 65,
    // ── WS2: checked-arithmetic hardening (66–68) ─────────────────────────
    ArithmeticOverflow = 66,
    ArithmeticUnderflow = 67,
    StorageMissing = 68,
}

/// Validate a milestone vector against the invariants that must hold at every
/// mutation point (`create_job` and `amend_job_milestones`):
///
/// 1. Non-empty (`MilestoneVectorEmpty`)
/// 2. Every milestone has a non-zero percentage (`MilestonePercentageZero`)
/// 3. Every milestone name fits within `MAX_MILESTONE_NAME_LEN` bytes
///    (`MilestoneNameTooLong`)
/// 4. No two milestones share a name (`DuplicateMilestoneName`)
///
/// The sum-to-100 invariant is computed by the callers and intentionally not
/// duplicated here.
fn validate_milestones(env: &Env, milestones: &Vec<Milestone>) {
    if milestones.is_empty() {
        panic_with_error!(env, EscrowError::MilestoneVectorEmpty);
    }

    for milestone in milestones.iter() {
        if milestone.percentage == 0 {
            panic_with_error!(env, EscrowError::MilestonePercentageZero);
        }
        if milestone.name.len() > MAX_MILESTONE_NAME_LEN {
            panic_with_error!(env, EscrowError::MilestoneNameTooLong);
        }
    }

    // Duplicate-name detection. Milestone vectors are small (the fuzz harness
    // caps them at 10 entries), so an O(n²) scan avoids allocating a second
    // Vec and keeps the comparison independent of storage.
    for i in 0..milestones.len() {
        for j in (i + 1)..milestones.len() {
            let a = milestones
                .get(i)
                .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));
            let b = milestones
                .get(j)
                .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));
            if a.name == b.name {
                panic_with_error!(env, EscrowError::DuplicateMilestoneName);
            }
        }
    }
}

/// Compute `amount * proportion / 100` with checked arithmetic, panicking
/// with the given structured `EscrowError` on overflow.
///
/// `amount` is fully client-controlled at `create_job` (any positive `i128`),
/// so a value near `i128::MAX` would silently wrap in an unchecked release
/// build and produce an incorrect (small) payout while the full amount stays
/// locked. `checked_mul` / `checked_div` guarantee the payout math panics
/// with a structured error instead of wrapping.
///
/// A `proportion` of `100` is returned as `amount` directly: the intermediate
/// `amount * 100` would otherwise overflow for large amounts even though the
/// mathematically exact result (`amount`) is itself a valid `i128`.
fn compute_proportional_payout(
    env: &Env,
    amount: i128,
    proportion: i128,
    err: EscrowError,
) -> i128 {
    if proportion == 100 {
        return amount;
    }
    // Split `amount` into quotient and remainder *before* multiplying so the
    // intermediate value cannot overflow for large amounts: an
    // `amount * proportion` product can exceed `i128::MAX` even when the final
    // payout fits (e.g. `i128::MAX / 2` with two 50% milestones). The
    // quotient/remainder decomposition preserves floor division exactly.
    let quotient = amount.checked_div(100i128);
    let remainder = amount.checked_rem(100i128);
    quotient
        .and_then(|whole| whole.checked_mul(proportion))
        .and_then(|whole| {
            remainder
                .and_then(|fraction| fraction.checked_mul(proportion))
                // `fraction < 100`, so `fraction * proportion / 100` fits for
                // any valid `proportion <= 100`.
                .and_then(|fraction| whole.checked_add(fraction / 100i128))
        })
        .unwrap_or_else(|| panic_with_error!(env, err))
}

/// Sum the payout of every unreleased milestone using checked arithmetic.
///
/// When all milestones are released the contract holds nothing; return 0
/// directly to avoid deriving a residual from truncated percentage sums.
/// Otherwise compute `job.amount – Σ(truncated proportions of released
/// milestones)`.
fn compute_remaining_funds(env: &Env, job: &Job, err: EscrowError) -> i128 {
    // Fast path: every milestone has been paid out — nothing remains.
    if job.milestones.iter().all(|m| m.released) {
        return 0;
    }

    let mut already_released: i128 = 0;
    for milestone in job.milestones.iter() {
        if milestone.released {
            let proportion = milestone.percentage as i128;
            let payout = compute_proportional_payout(env, job.amount, proportion, err);
            already_released = already_released
                .checked_add(payout)
                .unwrap_or_else(|| panic_with_error!(env, err));
        }
    }
    job.amount
        .checked_sub(already_released)
        .unwrap_or_else(|| panic_with_error!(env, err))
}

fn read_reputation(env: &Env, freelancer: &Address) -> FreelancerReputation {
    env.storage()
        .instance()
        .get(&DataKey::FreelancerReputation(freelancer.clone()))
        .unwrap_or(FreelancerReputation {
            total_jobs: 0,
            completed_jobs: 0,
            disputed_jobs: 0,
            total_value_completed: 0,
            on_time_completions: 0,
            created_at: 0,
        })
}

fn store_reputation(env: &Env, freelancer: &Address, reputation: &FreelancerReputation) {
    env.storage().instance().set(
        &DataKey::FreelancerReputation(freelancer.clone()),
        reputation,
    );
}

fn reputation_job_created(env: &Env, freelancer: &Address) {
    let is_new = !env
        .storage()
        .instance()
        .has(&DataKey::FreelancerReputation(freelancer.clone()));
    let mut reputation = read_reputation(env, freelancer);
    if is_new {
        reputation.created_at = env.ledger().sequence();
    }
    reputation.total_jobs = reputation
        .total_jobs
        .checked_add(1)
        .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));
    store_reputation(env, freelancer, &reputation);
}

fn reputation_job_disputed(env: &Env, job: &Job) {
    let counted_key = DataKey::ReputationDisputeCounted(job.id.clone());
    if env.storage().instance().has(&counted_key) {
        return;
    }
    let mut reputation = read_reputation(env, &job.freelancer);
    reputation.disputed_jobs = reputation
        .disputed_jobs
        .checked_add(1)
        .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));
    store_reputation(env, &job.freelancer, &reputation);
    env.storage().instance().set(&counted_key, &true);
}

fn reputation_job_completed(env: &Env, job: &Job) {
    let mut reputation = read_reputation(env, &job.freelancer);
    reputation.completed_jobs = reputation
        .completed_jobs
        .checked_add(1)
        .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));
    reputation.total_value_completed = reputation
        .total_value_completed
        .checked_add(job.amount)
        .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));
    if env.ledger().sequence() <= job.deadline {
        reputation.on_time_completions = reputation
            .on_time_completions
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));
    }
    store_reputation(env, &job.freelancer, &reputation);
    ReputationUpdated {
        freelancer: job.freelancer.clone(),
        completed_jobs: reputation.completed_jobs,
        disputed_jobs: reputation.disputed_jobs,
        total_value_completed: reputation.total_value_completed,
    }
    .publish(env);
}

/// Read the stored admin set. Panics if not initialized.
fn read_admin_set(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::AdminSet)
        .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing))
}

/// Read the stored admin threshold. Panics if not initialized.
fn read_admin_threshold(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::AdminThreshold)
        .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing))
}

/// Count the number of distinct addresses in `signers` that belong to
/// `admin_set`. Pure counting logic, decoupled from authentication so it
/// can be exercised directly (e.g. by property tests) without needing a
/// signed authorization entry per signer. Duplicate signers are counted
/// only once so a single compromised key cannot satisfy a threshold by
/// appearing multiple times in `signers`.
fn count_distinct_admins(env: &Env, admin_set: &Vec<Address>, signers: &Vec<Address>) -> u32 {
    let mut counted: Vec<Address> = Vec::new(admin_set.env());
    let mut valid_count: u32 = 0;
    for signer in signers.iter() {
        if admin_set.contains(&signer) && !counted.contains(&signer) {
            counted.push_back(signer.clone());
            valid_count = valid_count
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));
        }
    }
    valid_count
}

/// Verify M-of-N threshold signatures for an admin-gated action.
///
/// Calls `require_auth()` on every supplied signer (Soroban host-level
/// cryptographic verification), then delegates to `count_distinct_admins`
/// to determine how many distinct signers belong to the admin set. Panics
/// if that count is below `required_threshold`.
fn verify_m_of_n(env: &Env, signers: &Vec<Address>, required_threshold: u32) {
    for signer in signers.iter() {
        signer.require_auth();
    }

    let admin_set: Vec<Address> = read_admin_set(env);
    let valid_count = count_distinct_admins(env, &admin_set, signers);

    if valid_count < required_threshold {
        panic_with_error!(env, EscrowError::InsufficientAdminSignatures);
    }
}

/// Require M-of-N admin signatures for an admin-gated escrow action.
fn require_admin(env: &Env, signers: &Vec<Address>) {
    let threshold: u32 = read_admin_threshold(env);
    verify_m_of_n(env, signers, threshold);
}

#[contract]
pub struct EscrowContract;

// ─── WS7: typed contract events ─────────────────────────────────────────────
// Migrated from `env.events().publish(...)` to `#[contractevent]` structs. The
// emitted topic list and data payload are byte-for-byte identical to the legacy
// emit sites they replace, so indexers observe an unchanged stream.

#[contractevent(topics = ["rep_upd"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReputationUpdated {
    #[topic]
    pub freelancer: Address,
    pub completed_jobs: u32,
    pub disputed_jobs: u32,
    pub total_value_completed: i128,
}

#[contractevent(topics = ["job_creat"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobCreated {
    #[topic]
    pub client: Address,
    pub job_id: String,
    pub freelancer: Address,
    pub amount: i128,
}

#[contractevent(topics = ["job_amend"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobAmended {
    #[topic]
    pub client: Address,
    pub job_id: String,
    pub old_milestone_count: u32,
    pub new_milestone_count: u32,
    pub next_amendment_count: u32,
}

#[contractevent(topics = ["ms_rel"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneReleased {
    #[topic]
    pub client: Address,
    pub job_id: String,
    pub milestone_index: u32,
    pub release_amount: i128,
}

#[contractevent(topics = ["ms_proof"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneProofSubmitted {
    #[topic]
    pub freelancer: Address,
    pub job_id: String,
    pub milestone_index: u32,
}

#[contractevent(topics = ["ms_verif"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneVerified {
    #[topic]
    pub oracle: Address,
    pub job_id: String,
    pub milestone_index: u32,
}

#[contractevent(topics = ["job_disp"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobDisputed {
    pub job_id: String,
}

#[contractevent(topics = ["job_reslv"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobResolved {
    pub job_id: String,
    pub approve_remaining: bool,
}

#[contractevent(topics = ["ms_disp"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneDisputed {
    pub job_id: String,
    pub milestone_index: u32,
}

#[contractevent(topics = ["ms_reslv"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneResolved {
    pub job_id: String,
    pub milestone_index: u32,
    pub approve: bool,
}

#[contractevent(topics = ["job_refnd"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobRefunded {
    #[topic]
    pub client: Address,
    pub job_id: String,
    pub remaining: i128,
}

#[contractevent(topics = ["ms_claim"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneClaimed {
    #[topic]
    pub freelancer: Address,
    pub job_id: String,
    pub milestone_index: u32,
    pub release_amount: i128,
}

#[contractevent(topics = ["rel_upd"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleaseUpdated {
    pub job_id: String,
    pub new_release_after: u32,
}

#[contractevent(topics = ["admin_add"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminAdded {
    pub new_admin: Address,
}

#[contractevent(topics = ["admin_rmv"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminRemoved {
    pub admin_to_remove: Address,
}

#[contractevent(topics = ["thresh_up"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThresholdUpdated {
    pub new_threshold: u32,
}

#[contractevent(topics = ["jobs_clnd"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobsCleaned {
    pub removed: u32,
}

#[contractimpl]
impl EscrowContract {
    /// Number of distinct semantic event topics this contract can emit (WS7).
    /// Keep in sync with the `event_catalog.json` golden file.
    pub fn event_count(_env: Env) -> u32 {
        17
    }

    /// Initialize the contract with an M-of-N multi-sig admin set.
    /// Single-admin deployments call this with `vec![admin]` and threshold `1`.
    pub fn initialize(env: Env, admins: Vec<Address>, threshold: u32) {
        if env.storage().instance().has(&DataKey::AdminSet) {
            panic_with_error!(&env, EscrowError::AlreadyInitialized);
        }
        if admins.is_empty() {
            panic_with_error!(&env, EscrowError::AdminSetMustNotBeEmpty);
        }
        if threshold == 0 || threshold > admins.len() {
            panic_with_error!(&env, EscrowError::ThresholdMustBeBetweenOneAndAdminCount);
        }
        env.storage().instance().set(&DataKey::AdminSet, &admins);
        env.storage()
            .instance()
            .set(&DataKey::AdminThreshold, &threshold);
        if !env.storage().instance().has(&DataKey::JobCount) {
            env.storage().instance().set(&DataKey::JobCount, &0u32);
        }
        if !env.storage().instance().has(&DataKey::JobIds) {
            let ids: Vec<String> = Vec::new(&env);
            env.storage().instance().set(&DataKey::JobIds, &ids);
        }
    }

    /// Client funds escrow with milestones: transfers `amount` of `token` from client into this contract.
    /// `release_after` is the number of ledgers, from creation, before the freelancer may
    /// auto-claim unclaimed milestones; it must be at least `RELEASE_AFTER_LEDGERS`.
    #[allow(clippy::too_many_arguments)]
    pub fn create_job(
        env: Env,
        client: Address,
        freelancer: Address,
        job_id: String,
        token: Address,
        amount: i128,
        milestones: Vec<Milestone>,
        release_after: u32,
    ) {
        client.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, EscrowError::AmountMustBePositive);
        }
        if release_after < RELEASE_AFTER_LEDGERS {
            panic_with_error!(&env, EscrowError::ReleaseAfterBelowMinimum);
        }
        if env.storage().instance().has(&DataKey::Job(job_id.clone())) {
            panic_with_error!(&env, EscrowError::JobAlreadyExists);
        }

        validate_milestones(&env, &milestones);

        // Validate milestones sum to 100%
        let mut total_percentage: u32 = 0;
        for milestone in milestones.iter() {
            total_percentage = total_percentage
                .checked_add(milestone.percentage)
                .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));
        }
        if total_percentage != 100 {
            panic_with_error!(&env, EscrowError::MilestonesMustSumTo100);
        }

        let deadline = env.ledger().sequence() + DEFAULT_DEADLINE_LEDGERS;

        // release_after is stored as an absolute ledger sequence; compute it
        // now so we can validate it against the deadline before persisting.
        let release_after_abs = env.ledger().sequence() + release_after;
        if release_after_abs > deadline {
            panic_with_error!(&env, EscrowError::ReleaseAfterExceedsDeadline);
        }

        // ── Effects: persist the Job struct BEFORE the external token
        //    transfer so a malicious token contract cannot exploit a
        //    non-CEI ordering to leave the ledger without a `Job` entry
        //    while having already received the funds.
        let job = Job {
            id: job_id.clone(),
            client: client.clone(),
            freelancer: freelancer.clone(),
            token: token.clone(),
            amount,
            status: JobStatus::Escrowed,
            milestones,
            disputed: false,
            release_after: release_after_abs,
            deadline,
        };
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);
        reputation_job_created(&env, &freelancer);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::JobCount)
            .unwrap_or(0);
        if count >= MAX_JOBS {
            panic_with_error!(&env, EscrowError::JobCountExceedsMaximum);
        }
        let next_count = count
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));
        env.storage()
            .instance()
            .set(&DataKey::JobCount, &next_count);

        let mut ids: Vec<String> = env
            .storage()
            .instance()
            .get(&DataKey::JobIds)
            .unwrap_or_else(|| Vec::new(&env));
        ids.push_back(job_id.clone());
        env.storage().instance().set(&DataKey::JobIds, &ids);

        // Event emission
        JobCreated {
            client: client.clone(),
            job_id,
            freelancer,
            amount,
        }
        .publish(&env);

        // ── Interaction: external token transfer last.
        let token_client = token::Client::new(&env, &token);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&client, &contract_addr, &amount);
    }

    /// Client and freelancer jointly amend a job's milestones before any release.
    /// Milestones may be added, removed, or reordered as long as the new set sums
    /// to 100%; the total escrowed amount never changes. Requires auth from both
    /// the client and the freelancer, and is only permitted while the job is still
    /// fully `Escrowed` (no milestone released or disputed).
    pub fn amend_job_milestones(
        env: Env,
        client: Address,
        freelancer: Address,
        job_id: String,
        new_milestones: Vec<Milestone>,
    ) {
        client.require_auth();
        freelancer.require_auth();

        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));

        if job.client != client {
            panic_with_error!(&env, EscrowError::OnlyJobClientCanAmend);
        }
        if job.freelancer != freelancer {
            panic_with_error!(&env, EscrowError::OnlyJobFreelancerCanAmend);
        }
        if job.status != JobStatus::Escrowed {
            panic_with_error!(&env, EscrowError::AmendmentOnlyBeforeRelease);
        }

        validate_milestones(&env, &new_milestones);

        let mut total_percentage: u32 = 0;
        for milestone in new_milestones.iter() {
            if milestone.released || milestone.disputed {
                panic_with_error!(&env, EscrowError::NewMilestonesMustNotBeReleasedOrDisputed);
            }
            total_percentage = total_percentage
                .checked_add(milestone.percentage)
                .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));
        }
        if total_percentage != 100 {
            panic_with_error!(&env, EscrowError::MilestonesMustSumTo100);
        }

        let old_milestone_count = job.milestones.len();
        let new_milestone_count = new_milestones.len();
        job.milestones = new_milestones;
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        let amendment_count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::AmendmentCount(job_id.clone()))
            .unwrap_or(0);
        let next_amendment_count = amendment_count
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));
        env.storage().instance().set(
            &DataKey::AmendmentCount(job_id.clone()),
            &next_amendment_count,
        );

        JobAmended {
            client,
            job_id,
            old_milestone_count,
            new_milestone_count,
            next_amendment_count,
        }
        .publish(&env);
    }

    /// Number of times a job's milestones have been amended via `amend_job_milestones`.
    pub fn get_job_amendment_count(env: Env, job_id: String) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::AmendmentCount(job_id))
            .unwrap_or(0)
    }

    /// Client releases a specific milestone. Pays proportional XLM to freelancer.
    pub fn release_milestone(env: Env, client: Address, job_id: String, milestone_index: u32) {
        client.require_auth();
        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));

        if job.client != client {
            panic_with_error!(&env, EscrowError::OnlyClientCanRelease);
        }
        if milestone_index >= job.milestones.len() {
            panic_with_error!(&env, EscrowError::InvalidMilestoneIndex);
        }

        let milestone = &job
            .milestones
            .get(milestone_index)
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));
        if milestone.disputed {
            panic_with_error!(&env, EscrowError::MilestoneIsDisputed);
        }
        if milestone.released {
            panic_with_error!(&env, EscrowError::MilestoneAlreadyReleased);
        }

        #[cfg(feature = "oracle-escrow")]
        if milestone.oracle.is_some() && !milestone.verified {
            panic_with_error!(&env, EscrowError::MilestoneNotVerifiedByOracle);
        }

        let proportion = milestone.percentage as i128;
        let mut already_released: i128 = 0;
        for m in job.milestones.iter() {
            if m.released {
                let p = compute_proportional_payout(
                    &env,
                    job.amount,
                    m.percentage as i128,
                    EscrowError::ReleaseAmountCalculationFailed,
                );
                already_released = already_released.checked_add(p).unwrap_or_else(|| {
                    panic_with_error!(&env, EscrowError::ReleaseAmountCalculationFailed)
                });
            }
        }
        let unreleased_count = job.milestones.iter().filter(|m| !m.released).count();
        let release_amount = if unreleased_count == 1 {
            job.amount.checked_sub(already_released).unwrap_or_else(|| {
                panic_with_error!(&env, EscrowError::ReleaseAmountCalculationFailed)
            })
        } else {
            compute_proportional_payout(
                &env,
                job.amount,
                proportion,
                EscrowError::ReleaseAmountCalculationFailed,
            )
        };

        // ── Effects: rebuild the milestone vector, recompute status,
        //    and persist state BEFORE the external token movement (CEI ordering).
        let mut updated_milestones = job.milestones.clone();
        let mut released_count = 0u32;
        for i in 0..updated_milestones.len() {
            let mut m = updated_milestones
                .get(i)
                .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing))
                .clone();
            if i == milestone_index {
                m.released = true;
            }
            if m.released {
                released_count = released_count
                    .checked_add(1)
                    .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));
            }
            updated_milestones.set(i, m);
        }
        job.milestones = updated_milestones;
        let any_disputed = job.milestones.iter().any(|m| m.disputed);
        job.status = if released_count == job.milestones.len() {
            JobStatus::Completed
        } else if any_disputed {
            JobStatus::Disputed
        } else {
            JobStatus::PartiallyReleased
        };
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);
        if job.status == JobStatus::Completed {
            reputation_job_completed(&env, &job);
        }

        // Event emission
        MilestoneReleased {
            client,
            job_id,
            milestone_index,
            release_amount,
        }
        .publish(&env);

        // ── Interaction: external token transfer last.
        let token_client = token::Client::new(&env, &job.token);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&contract_addr, &job.freelancer, &release_amount);
    }

    /// Freelancer submits an off-chain proof hash for oracle-verified milestones.
    /// Resets `verified` to `false` so the oracle must re-verify after a new proof.
    #[cfg(feature = "oracle-escrow")]
    pub fn submit_milestone_proof(
        env: Env,
        freelancer: Address,
        job_id: String,
        milestone_index: u32,
        proof_hash: BytesN<32>,
    ) {
        freelancer.require_auth();

        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));

        if job.freelancer != freelancer {
            panic_with_error!(&env, EscrowError::OnlyAssignedFreelancerCanSubmitProof);
        }
        if milestone_index >= job.milestones.len() {
            panic_with_error!(&env, EscrowError::InvalidMilestoneIndex);
        }

        let mut milestones = job.milestones.clone();
        let mut milestone = milestones
            .get(milestone_index)
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing))
            .clone();
        if milestone.released {
            panic_with_error!(&env, EscrowError::MilestoneAlreadyCompleted);
        }

        milestone.proof_hash = Some(proof_hash);
        milestone.verified = false;
        milestones.set(milestone_index, milestone);
        job.milestones = milestones;
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        MilestoneProofSubmitted {
            freelancer,
            job_id,
            milestone_index,
        }
        .publish(&env);
    }

    /// Oracle verifies a milestone proof and marks it as verified.
    /// Only the oracle configured on the milestone can call this.
    #[cfg(feature = "oracle-escrow")]
    pub fn verify_milestone(env: Env, oracle: Address, job_id: String, milestone_index: u32) {
        oracle.require_auth();

        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));

        if milestone_index >= job.milestones.len() {
            panic_with_error!(&env, EscrowError::InvalidMilestoneIndex);
        }

        let mut milestones = job.milestones.clone();
        let mut milestone = milestones
            .get(milestone_index)
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing))
            .clone();
        if milestone.oracle.is_none() {
            panic_with_error!(&env, EscrowError::MilestoneHasNoOracleConfigured);
        }
        if milestone
            .oracle
            .as_ref()
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing))
            != &oracle
        {
            panic_with_error!(&env, EscrowError::OnlyConfiguredOracleCanVerify);
        }
        if milestone.proof_hash.is_none() {
            panic_with_error!(&env, EscrowError::NoProofSubmittedYet);
        }
        if milestone.released {
            panic_with_error!(&env, EscrowError::MilestoneAlreadyCompleted);
        }

        milestone.verified = true;
        milestones.set(milestone_index, milestone);
        job.milestones = milestones;
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        MilestoneVerified {
            oracle,
            job_id,
            milestone_index,
        }
        .publish(&env);
    }

    /// M-of-N admin (deprecated): Mark a job as disputed, freezing remaining releases.
    ///
    /// Delegates to the milestone-level dispute representation for backward
    /// compatibility: every unreleased milestone is flagged `disputed` so the
    /// non-deprecated `resolve_milestone_dispute` can also unblock a job
    /// disputed through this entrypoint (issue #613).
    #[deprecated]
    pub fn dispute_job(env: Env, signers: Vec<Address>, job_id: String) {
        require_admin(&env, &signers);

        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));

        // Mirror the dispute onto every unreleased milestone so the
        // milestone-level resolution path can resolve it later.
        let mut milestones = job.milestones.clone();
        for i in 0..milestones.len() {
            let mut milestone = milestones
                .get(i)
                .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing))
                .clone();
            if !milestone.released {
                milestone.disputed = true;
                #[cfg(feature = "oracle-escrow")]
                {
                    milestone.verified = false;
                    milestone.proof_hash = None;
                }
            }
            milestones.set(i, milestone);
        }
        job.milestones = milestones;

        job.disputed = true;
        job.status = JobStatus::Disputed;
        reputation_job_disputed(&env, &job);
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        JobDisputed { job_id }.publish(&env);
    }

    /// M-of-N admin (deprecated): Resolve a dispute and release remaining funds.
    ///
    /// Works for both dispute entrypoints now that `dispute_milestone` keeps
    /// `job.disputed` in sync with the milestone-level flags (issue #613).
    #[deprecated]
    pub fn resolve_dispute(
        env: Env,
        signers: Vec<Address>,
        job_id: String,
        approve_remaining: bool,
    ) {
        require_admin(&env, &signers);

        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));

        if !job.disputed {
            panic_with_error!(&env, EscrowError::JobIsNotDisputed);
        }

        let remaining_amount =
            compute_remaining_funds(&env, &job, EscrowError::ReleaseAmountCalculationFailed);

        let mut updated_milestones = job.milestones.clone();
        for i in 0..updated_milestones.len() {
            let mut m = updated_milestones
                .get(i)
                .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing))
                .clone();
            m.released = true;
            m.disputed = false;
            updated_milestones.set(i, m);
        }
        job.milestones = updated_milestones;
        job.status = JobStatus::Completed;
        job.disputed = false;
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);
        reputation_job_completed(&env, &job);

        JobResolved {
            job_id: job_id.clone(),
            approve_remaining,
        }
        .publish(&env);

        if remaining_amount > 0 {
            let token_client = token::Client::new(&env, &job.token);
            let contract_addr = env.current_contract_address();
            let recipient = if approve_remaining {
                job.freelancer.clone()
            } else {
                job.client.clone()
            };
            token_client.transfer(&contract_addr, &recipient, &remaining_amount);
        }
    }

    /// M-of-N admin: Dispute a single milestone without freezing non-disputed milestones.
    pub fn dispute_milestone(
        env: Env,
        signers: Vec<Address>,
        job_id: String,
        milestone_index: u32,
    ) {
        require_admin(&env, &signers);

        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));

        if milestone_index >= job.milestones.len() {
            panic_with_error!(&env, EscrowError::InvalidMilestoneIndex);
        }

        let mut milestones = job.milestones.clone();
        let mut milestone = milestones
            .get(milestone_index)
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing))
            .clone();
        if milestone.released {
            panic_with_error!(&env, EscrowError::MilestoneAlreadyReleased);
        }
        if milestone.disputed {
            panic_with_error!(&env, EscrowError::MilestoneAlreadyDisputed);
        }
        milestone.disputed = true;
        #[cfg(feature = "oracle-escrow")]
        {
            milestone.verified = false;
            milestone.proof_hash = None;
        }
        milestones.set(milestone_index, milestone);
        job.milestones = milestones;
        job.disputed = true;
        job.status = JobStatus::Disputed;
        reputation_job_disputed(&env, &job);

        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        MilestoneDisputed {
            job_id,
            milestone_index,
        }
        .publish(&env);
    }

    /// M-of-N admin: Resolve a single milestone dispute.
    /// If `approve` is true -> release funds for that milestone to freelancer.
    /// If `approve` is false -> refund funds for that milestone to client.
    pub fn resolve_milestone_dispute(
        env: Env,
        signers: Vec<Address>,
        job_id: String,
        milestone_index: u32,
        approve: bool,
    ) {
        require_admin(&env, &signers);

        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));

        if milestone_index >= job.milestones.len() {
            panic_with_error!(&env, EscrowError::InvalidMilestoneIndex);
        }

        let mut milestones = job.milestones.clone();
        let mut milestone = milestones
            .get(milestone_index)
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing))
            .clone();
        if !milestone.disputed {
            panic_with_error!(&env, EscrowError::MilestoneIsNotDisputed);
        }

        let proportion = milestone.percentage as i128;
        let mut already_released: i128 = 0;
        for m in job.milestones.iter() {
            if m.released {
                let p = compute_proportional_payout(
                    &env,
                    job.amount,
                    m.percentage as i128,
                    EscrowError::ReleaseAmountCalculationFailed,
                );
                already_released = already_released.checked_add(p).unwrap_or_else(|| {
                    panic_with_error!(&env, EscrowError::ReleaseAmountCalculationFailed)
                });
            }
        }
        let unreleased_count = job.milestones.iter().filter(|m| !m.released).count();
        let release_amount = if unreleased_count == 1 {
            job.amount.checked_sub(already_released).unwrap_or_else(|| {
                panic_with_error!(&env, EscrowError::ReleaseAmountCalculationFailed)
            })
        } else {
            compute_proportional_payout(
                &env,
                job.amount,
                proportion,
                EscrowError::ReleaseAmountCalculationFailed,
            )
        };

        milestone.disputed = false;
        milestone.released = true;
        milestones.set(milestone_index, milestone);
        job.milestones = milestones;

        let all_released = job.milestones.iter().all(|m| m.released);
        let any_disputed = job.milestones.iter().any(|m| m.disputed);
        job.disputed = any_disputed;
        job.status = if all_released {
            JobStatus::Completed
        } else if any_disputed {
            JobStatus::Disputed
        } else {
            JobStatus::PartiallyReleased
        };

        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);
        if job.status == JobStatus::Completed {
            reputation_job_completed(&env, &job);
        }

        MilestoneResolved {
            job_id,
            milestone_index,
            approve,
        }
        .publish(&env);

        if release_amount > 0 {
            let token_client = token::Client::new(&env, &job.token);
            let contract_addr = env.current_contract_address();
            let recipient = if approve {
                job.freelancer.clone()
            } else {
                job.client.clone()
            };
            token_client.transfer(&contract_addr, &recipient, &release_amount);
        }
    }

    /// Client can request full refund after job deadline passes if no milestone has been claimed.
    pub fn refund_expired_job(env: Env, client: Address, job_id: String) {
        client.require_auth();
        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));

        if job.client != client {
            panic_with_error!(&env, EscrowError::OnlyClientCanRequestRefund);
        }
        if env.ledger().sequence() < job.deadline {
            panic_with_error!(&env, EscrowError::JobDeadlineHasNotPassed);
        }

        let any_claimed = job.milestones.iter().any(|m| m.released);
        if any_claimed {
            panic_with_error!(&env, EscrowError::CannotRefundMilestonesClaimed);
        }

        let remaining =
            compute_remaining_funds(&env, &job, EscrowError::RefundAmountCalculationFailed);

        job.status = JobStatus::Completed;
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        JobRefunded {
            client: client.clone(),
            job_id,
            remaining,
        }
        .publish(&env);

        if remaining > 0 {
            let token_client = token::Client::new(&env, &job.token);
            let contract_addr = env.current_contract_address();
            token_client.transfer(&contract_addr, &client, &remaining);
        }
    }

    /// Freelancer can claim a milestone after release_after ledgers if not disputed.
    pub fn claim_milestone(env: Env, freelancer: Address, job_id: String, milestone_index: u32) {
        freelancer.require_auth();
        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));

        if job.freelancer != freelancer {
            panic_with_error!(&env, EscrowError::OnlyJobFreelancerCanClaim);
        }
        if env.ledger().sequence() < job.release_after {
            panic_with_error!(&env, EscrowError::ReleasePeriodNotReached);
        }
        if milestone_index >= job.milestones.len() {
            panic_with_error!(&env, EscrowError::InvalidMilestoneIndex);
        }
        let milestone = &job
            .milestones
            .get(milestone_index)
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));
        if milestone.disputed {
            panic_with_error!(&env, EscrowError::MilestoneDisputedCannotClaimMilestone);
        }
        if milestone.released {
            panic_with_error!(&env, EscrowError::MilestoneAlreadyReleased);
        }
        let proportion = milestone.percentage as i128;
        let mut already_released: i128 = 0;
        for m in job.milestones.iter() {
            if m.released {
                let p = compute_proportional_payout(
                    &env,
                    job.amount,
                    m.percentage as i128,
                    EscrowError::ClaimAmountCalculationFailed,
                );
                already_released = already_released.checked_add(p).unwrap_or_else(|| {
                    panic_with_error!(&env, EscrowError::ClaimAmountCalculationFailed)
                });
            }
        }
        let unreleased_count = job.milestones.iter().filter(|m| !m.released).count();
        let release_amount = if unreleased_count == 1 {
            job.amount.checked_sub(already_released).unwrap_or_else(|| {
                panic_with_error!(&env, EscrowError::ClaimAmountCalculationFailed)
            })
        } else {
            compute_proportional_payout(
                &env,
                job.amount,
                proportion,
                EscrowError::ClaimAmountCalculationFailed,
            )
        };

        // ── Effects: mark milestone released and update status BEFORE
        //    the external token transfer (CEI ordering).
        let mut updated_milestones = job.milestones.clone();
        let mut m = updated_milestones
            .get(milestone_index)
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing))
            .clone();
        m.released = true;
        updated_milestones.set(milestone_index, m);
        job.milestones = updated_milestones;
        let all_released = job.milestones.iter().all(|m| m.released);
        let any_disputed = job.milestones.iter().any(|m| m.disputed);
        job.status = if all_released {
            JobStatus::Completed
        } else if any_disputed {
            JobStatus::Disputed
        } else {
            JobStatus::PartiallyReleased
        };
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);
        if job.status == JobStatus::Completed {
            reputation_job_completed(&env, &job);
        }

        // Event emission
        MilestoneClaimed {
            freelancer,
            job_id,
            milestone_index,
            release_amount,
        }
        .publish(&env);

        // ── Interaction: external token transfer last.
        let token_client = token::Client::new(&env, &job.token);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&contract_addr, &job.freelancer, &release_amount);
    }

    /// M-of-N admin: extend a job's release period. `new_release_after` is the
    /// new absolute ledger sequence at which the freelancer may auto-claim
    /// unclaimed milestones; it must be later than the job's current
    /// `release_after` and cannot exceed the job deadline.
    pub fn update_release_after(
        env: Env,
        signers: Vec<Address>,
        job_id: String,
        new_release_after: u32,
    ) {
        require_admin(&env, &signers);

        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));

        if new_release_after <= job.release_after {
            panic_with_error!(&env, EscrowError::NewReleaseAfterMustExtendCurrent);
        }
        if new_release_after > job.deadline {
            panic_with_error!(&env, EscrowError::ReleaseAfterExceedsDeadline);
        }

        job.release_after = new_release_after;
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        ReleaseUpdated {
            job_id,
            new_release_after,
        }
        .publish(&env);
    }

    /// M-of-N admin: add a new address to the admin set.
    pub fn add_admin(env: Env, signers: Vec<Address>, new_admin: Address) {
        require_admin(&env, &signers);
        let mut admin_set: Vec<Address> = read_admin_set(&env);
        if admin_set.contains(&new_admin) {
            panic_with_error!(&env, EscrowError::AddressAlreadyAdmin);
        }
        admin_set.push_back(new_admin.clone());
        env.storage().instance().set(&DataKey::AdminSet, &admin_set);
        AdminAdded { new_admin }.publish(&env);
    }

    /// M-of-N admin: remove an address from the admin set. Panics if this would
    /// leave the set empty, or if the resulting set is smaller than the
    /// current threshold (call `update_threshold` first).
    pub fn remove_admin(env: Env, signers: Vec<Address>, admin_to_remove: Address) {
        require_admin(&env, &signers);
        let admin_set: Vec<Address> = read_admin_set(&env);
        if !admin_set.contains(&admin_to_remove) {
            panic_with_error!(&env, EscrowError::AddressNotAdmin);
        }
        if admin_set.len() <= 1 {
            panic_with_error!(&env, EscrowError::CannotRemoveLastAdmin);
        }
        let mut new_set: Vec<Address> = Vec::new(&env);
        for addr in admin_set.iter() {
            if addr != admin_to_remove {
                new_set.push_back(addr);
            }
        }
        let threshold: u32 = read_admin_threshold(&env);
        if threshold > new_set.len() {
            panic_with_error!(&env, EscrowError::ThresholdExceedsAdminCount);
        }
        env.storage().instance().set(&DataKey::AdminSet, &new_set);
        AdminRemoved { admin_to_remove }.publish(&env);
    }

    /// M-of-N admin: update the threshold for admin-gated actions. Must
    /// satisfy `1 <= new_threshold <= admin_set.len()`.
    pub fn update_threshold(env: Env, signers: Vec<Address>, new_threshold: u32) {
        require_admin(&env, &signers);
        let admin_set: Vec<Address> = read_admin_set(&env);
        if new_threshold == 0 || new_threshold > admin_set.len() {
            panic_with_error!(&env, EscrowError::ThresholdMustBeBetweenOneAndAdminCount);
        }
        env.storage()
            .instance()
            .set(&DataKey::AdminThreshold, &new_threshold);
        ThresholdUpdated { new_threshold }.publish(&env);
    }

    /// Returns the full admin set.
    pub fn get_admin_set(env: Env) -> Vec<Address> {
        read_admin_set(&env)
    }

    /// Returns the current M-of-N threshold for admin-gated actions.
    pub fn get_admin_threshold(env: Env) -> u32 {
        read_admin_threshold(&env)
    }

    pub fn get_job(env: Env, job_id: String) -> Option<Job> {
        env.storage().instance().get(&DataKey::Job(job_id))
    }

    /// Read-only helper: returns `job.amount – Σ already_released`, i.e. the
    /// exact number of stroops the contract still holds for this job.
    /// Returns `None` if the job does not exist.
    pub fn get_remaining_funds(env: Env, job_id: String) -> Option<i128> {
        let job: Job = env.storage().instance().get(&DataKey::Job(job_id))?;
        Some(compute_remaining_funds(
            &env,
            &job,
            EscrowError::RefundAmountCalculationFailed,
        ))
    }

    pub fn get_job_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::JobCount)
            .unwrap_or(0)
    }

    /// Return a bounded window of job IDs in creation order.
    pub fn get_job_ids(env: Env, from: u32, count: u32) -> Vec<String> {
        if count > MAX_JOB_IDS_PAGE_SIZE {
            panic_with_error!(&env, EscrowError::JobIdsPageSizeExceedsMaximum);
        }

        let ids: Vec<String> = env
            .storage()
            .instance()
            .get(&DataKey::JobIds)
            .unwrap_or_else(|| Vec::new(&env));
        let end = from.saturating_add(count).min(ids.len());
        let mut page = Vec::new(&env);
        let mut index = from;

        while index < end {
            if let Some(job_id) = ids.get(index) {
                page.push_back(job_id);
            }
            index += 1;
        }

        page
    }

    /// Permissionless storage GC. Archives every job whose status is
    /// `Completed` and whose `deadline + GRACE_PERIOD` strictly precedes the
    /// current ledger, reclaiming the `MAX_JOBS` slots those finished jobs
    /// occupy so `create_job` can keep honoring the hard cap instead of being
    /// permanently blocked by long-completed work.
    ///
    /// For each eligible job this removes its `DataKey::Job` entry, drops its
    /// id from the `JobIds` vector, and decrements `JobCount`. `FreelancerReputation`
    /// is intentionally left untouched — it is an append-only history aggregate
    /// that must survive archival.
    ///
    /// Panics with `NothingToCleanUp` when no job is eligible, otherwise
    /// returns the number of jobs archived.
    pub fn cleanup_completed_jobs(env: Env) -> u32 {
        let ids: Vec<String> = env
            .storage()
            .instance()
            .get(&DataKey::JobIds)
            .unwrap_or_else(|| Vec::new(&env));
        let current = env.ledger().sequence();

        let mut kept: Vec<String> = Vec::new(&env);
        let mut removed: u32 = 0;

        for job_id in ids.iter() {
            let id = job_id.clone();
            // `deadline + GRACE_PERIOD` is computed in i128 so a very large
            // deadline near `u32::MAX` cannot overflow the addition.
            let cleanable = env
                .storage()
                .instance()
                .get::<_, Job>(&DataKey::Job(id.clone()))
                .is_some_and(|job| {
                    job.status == JobStatus::Completed
                        && (job.deadline as i128 + GRACE_PERIOD as i128) < current as i128
                });
            if cleanable {
                env.storage().instance().remove(&DataKey::Job(id));
                removed = removed
                    .checked_add(1)
                    .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));
            } else {
                kept.push_back(id);
            }
        }

        if removed == 0 {
            panic_with_error!(&env, EscrowError::NothingToCleanUp);
        }

        env.storage().instance().set(&DataKey::JobIds, &kept);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::JobCount)
            .unwrap_or(0);
        let next_count = count
            .checked_sub(removed)
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::StorageMissing));
        env.storage()
            .instance()
            .set(&DataKey::JobCount, &next_count);

        JobsCleaned { removed }.publish(&env);

        removed
    }

    /// Return the immutable aggregate history for `freelancer`.
    pub fn get_freelancer_reputation(env: Env, freelancer: Address) -> FreelancerReputation {
        read_reputation(&env, &freelancer)
    }
}

#[cfg(all(test, feature = "testutils"))]
mod escrow_fuzz;

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    // `std` is not linked in this `#![no_std]` crate by default; declare it
    // explicitly (matching the `escrow_fuzz` harness) so `std::format!` is
    // available for building job-id strings in tests.
    extern crate std;
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::token::StellarAssetClient;
    use soroban_sdk::{Address, Env, IntoVal, String, Vec};

    /// Build a single-element signer Vec for admin calls.
    fn signers1(env: &Env, a: &Address) -> Vec<Address> {
        let mut v = Vec::new(env);
        v.push_back(a.clone());
        v
    }

    fn setup(env: &Env) -> (Address, EscrowContractClient<'_>) {
        let cid = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(env, &cid);
        let admin = Address::generate(env);
        client.initialize(&signers1(env, &admin), &1u32);
        (admin, client)
    }

    fn create_reputation_job(
        env: &Env,
        client: &EscrowContractClient<'_>,
        client_addr: &Address,
        freelancer: &Address,
        job_id: &String,
        amount: i128,
    ) {
        let token_admin = Address::generate(env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(env, &token).mint(client_addr, &amount);
        let mut milestones = Vec::new(env);
        milestones.push_back(Milestone {
            name: String::from_str(env, "Delivery"),
            percentage: 100,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });
        client.create_job(
            client_addr,
            freelancer,
            job_id,
            &token,
            &amount,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
    }

    #[test]
    fn test_milestone_based_release() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-1");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "Design"),
            percentage: 50,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "Development"),
            percentage: 30,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "Testing"),
            percentage: 20,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        let job = client.get_job(&job_id).expect("Job should exist");
        assert_eq!(job.status, JobStatus::Escrowed);
        assert_eq!(job.milestones.len(), 3);
        assert_eq!(
            job.deadline,
            env.ledger().sequence() + DEFAULT_DEADLINE_LEDGERS
        );
    }

    #[test]
    fn test_release_milestone_success() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-rel");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 60,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M2"),
            percentage: 40,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
        client.release_milestone(&client_addr, &job_id, &0u32);

        let job = client.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::PartiallyReleased);
        assert!(job.milestones.get(0).unwrap().released);
        assert!(!job.milestones.get(1).unwrap().released);

        // Release second milestone -> Completed
        client.release_milestone(&client_addr, &job_id, &1u32);
        let job2 = client.get_job(&job_id).unwrap();
        assert_eq!(job2.status, JobStatus::Completed);
    }

    #[test]
    #[should_panic(expected = "Error")]
    fn test_release_already_released_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-dup-rel");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
        client.release_milestone(&client_addr, &job_id, &0u32);
        client.release_milestone(&client_addr, &job_id, &0u32);
    }

    #[test]
    #[should_panic(expected = "Error")]
    fn test_milestone_validation() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token = Address::generate(&env);
        let job_id = String::from_str(&env, "job-invalid");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 50,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M2"),
            percentage: 40,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
    }

    #[test]
    #[should_panic(expected = "Error")]
    fn release_missing_job_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);
        let addr = Address::generate(&env);
        client.release_milestone(&addr, &String::from_str(&env, "no-such-job"), &0u32);
    }

    #[test]
    // Legacy `dispute_job`/`resolve_dispute` are retained for backward
    // compatibility and are authorized with the same M-of-N `require_admin`
    // gate as `dispute_milestone`/`resolve_milestone_dispute` (issue #1104,
    // Part B) — the allow is scoped to these compatibility tests only.
    #[allow(deprecated)]
    fn test_dispute_freezes_release() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-dispute");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        client.dispute_job(&signers1(&env, &admin), &job_id);

        let job = client.get_job(&job_id).expect("Job should exist");
        assert_eq!(job.status, JobStatus::Disputed);
        assert!(job.disputed);
    }

    #[test]
    // Legacy-path compatibility test; see `test_dispute_freezes_release`.
    #[allow(deprecated)]
    fn test_resolve_dispute_deprecated() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-res-dep");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
        client.dispute_job(&signers1(&env, &admin), &job_id);
        client.resolve_dispute(&signers1(&env, &admin), &job_id, &true);

        let job = client.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Completed);
        assert!(!job.disputed);
    }

    #[test]
    fn test_per_milestone_dispute_and_resolution_approve() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-ms-disp");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 50,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M2"),
            percentage: 50,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        // Dispute milestone 1 only
        client.dispute_milestone(&signers1(&env, &admin), &job_id, &1u32);
        let job = client.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Disputed);
        assert!(job.milestones.get(1).unwrap().disputed);
        assert!(!job.milestones.get(0).unwrap().disputed);

        // Client can still release milestone 0 while milestone 1 is disputed
        client.release_milestone(&client_addr, &job_id, &0u32);
        let job2 = client.get_job(&job_id).unwrap();
        assert_eq!(job2.status, JobStatus::Disputed);
        assert!(job2.milestones.get(0).unwrap().released);

        // Resolve milestone 1 dispute with approve=true
        client.resolve_milestone_dispute(&signers1(&env, &admin), &job_id, &1u32, &true);
        let job3 = client.get_job(&job_id).unwrap();
        assert_eq!(job3.status, JobStatus::Completed);
        assert!(job3.milestones.get(1).unwrap().released);
        assert!(!job3.milestones.get(1).unwrap().disputed);
    }

    #[test]
    fn test_per_milestone_dispute_resolution_reject() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-ms-rej");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
        client.dispute_milestone(&signers1(&env, &admin), &job_id, &0u32);
        client.resolve_milestone_dispute(&signers1(&env, &admin), &job_id, &0u32, &false);

        let job = client.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Completed);
        assert!(job.milestones.get(0).unwrap().released);
    }

    #[test]
    #[should_panic]
    fn test_dispute_milestone_already_disputed_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-dup-disp");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
        client.dispute_milestone(&signers1(&env, &admin), &job_id, &0u32);
        client.dispute_milestone(&signers1(&env, &admin), &job_id, &0u32);
    }

    #[test]
    #[should_panic]
    fn test_dispute_released_milestone_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-disp-rel");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
        client.release_milestone(&client_addr, &job_id, &0u32);
        client.dispute_milestone(&signers1(&env, &admin), &job_id, &0u32);
    }

    #[test]
    #[should_panic]
    fn test_resolve_not_disputed_milestone_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-res-not-disp");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
        client.resolve_milestone_dispute(&signers1(&env, &admin), &job_id, &0u32, &true);
    }

    #[test]
    fn test_claim_milestone_after_release_period() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-claim");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        // Advance sequence past release_after
        env.ledger().set_sequence_number(RELEASE_AFTER_LEDGERS + 1);

        client.claim_milestone(&freelancer, &job_id, &0u32);

        let job = client.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Completed);
        assert!(job.milestones.get(0).unwrap().released);
    }

    #[test]
    #[should_panic]
    fn test_claim_milestone_before_release_period_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-early-claim");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
        client.claim_milestone(&freelancer, &job_id, &0u32);
    }

    #[test]
    #[should_panic]
    fn test_claim_milestone_wrong_freelancer_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let wrong_freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-wrong-freelancer");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        // Advance sequence past release_after
        env.ledger().set_sequence_number(RELEASE_AFTER_LEDGERS + 1);

        // Wrong freelancer tries to claim - should panic
        client.claim_milestone(&wrong_freelancer, &job_id, &0u32);
    }

    #[test]
    fn test_refund_expired_job_success() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-expired");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        // Fast forward ledger sequence past deadline
        env.ledger()
            .set_sequence_number(DEFAULT_DEADLINE_LEDGERS + 10);

        client.refund_expired_job(&client_addr, &job_id);

        let job = client.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Completed);
    }

    #[test]
    #[should_panic]
    fn test_refund_expired_job_before_deadline_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-not-expired");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
        client.refund_expired_job(&client_addr, &job_id);
    }

    #[test]
    #[should_panic]
    fn test_refund_expired_job_not_client_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-not-client");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
        env.ledger()
            .set_sequence_number(DEFAULT_DEADLINE_LEDGERS + 10);

        let stranger = Address::generate(&env);
        client.refund_expired_job(&stranger, &job_id);
    }

    #[test]
    #[should_panic]
    fn test_refund_expired_job_milestones_claimed_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-claimed-expired");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 50,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M2"),
            percentage: 50,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
        client.release_milestone(&client_addr, &job_id, &0u32);

        env.ledger()
            .set_sequence_number(DEFAULT_DEADLINE_LEDGERS + 10);
        client.refund_expired_job(&client_addr, &job_id);
    }

    #[test]
    fn test_enumeration_get_job_count_and_ids() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        assert_eq!(client.get_job_count(), 0);
        assert_eq!(client.get_job_ids(&0, &MAX_JOB_IDS_PAGE_SIZE).len(), 0);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &2000i128);

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        let job_1 = String::from_str(&env, "job-enum-1");
        let job_2 = String::from_str(&env, "job-enum-2");

        client.create_job(
            &client_addr,
            &freelancer,
            &job_1,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
        client.create_job(
            &client_addr,
            &freelancer,
            &job_2,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        assert_eq!(client.get_job_count(), 2);
        let ids = client.get_job_ids(&0, &MAX_JOB_IDS_PAGE_SIZE);
        assert_eq!(ids.len(), 2);
        assert_eq!(ids.get(0).unwrap(), job_1);
        assert_eq!(ids.get(1).unwrap(), job_2);

        let first_page = client.get_job_ids(&0, &1);
        assert_eq!(first_page.len(), 1);
        assert_eq!(first_page.get(0).unwrap(), job_1);

        let second_page = client.get_job_ids(&1, &1);
        assert_eq!(second_page.len(), 1);
        assert_eq!(second_page.get(0).unwrap(), job_2);

        assert_eq!(client.get_job_ids(&2, &1).len(), 0);
        assert_eq!(client.get_job_ids(&u32::MAX, &1).len(), 0);
        assert!(client
            .try_get_job_ids(&0, &(MAX_JOB_IDS_PAGE_SIZE + 1))
            .is_err());
    }

    #[test]
    fn test_create_job_rejects_when_job_count_cap_is_reached() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        env.as_contract(&cid, || {
            env.storage().instance().set(&DataKey::JobCount, &MAX_JOBS);
        });

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        let job_id = String::from_str(&env, "job-over-cap");
        assert!(client
            .try_create_job(
                &client_addr,
                &freelancer,
                &job_id,
                &token,
                &1000i128,
                &milestones,
                &RELEASE_AFTER_LEDGERS,
            )
            .is_err());
    }

    /// Register a token, mint `amount` to `client`, and create a single-milestone
    /// (100%) job of `amount` from `client` to `freelancer`. Returns the token.
    fn setup_single_milestone_job(
        env: &Env,
        client: &EscrowContractClient<'_>,
        client_addr: &Address,
        freelancer: &Address,
        job_id: &String,
        amount: i128,
    ) -> Address {
        let token_admin = Address::generate(env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(env, &token).mint(client_addr, &amount);
        let mut milestones = Vec::new(env);
        milestones.push_back(make_milestone(env, "M1", 100));
        client.create_job(
            client_addr,
            freelancer,
            job_id,
            &token,
            &amount,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
        token
    }

    #[test]
    fn test_cleanup_completed_jobs_archives_expired_completed() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        // Job A always stays in-flight; Job B will be completed and cleaned up.
        setup_single_milestone_job(
            &env,
            &client,
            &client_addr,
            &freelancer,
            &String::from_str(&env, "job-inflight"),
            1000i128,
        );
        setup_single_milestone_job(
            &env,
            &client,
            &client_addr,
            &freelancer,
            &String::from_str(&env, "job-completed"),
            1000i128,
        );

        // Complete job B.
        client.release_milestone(
            &client_addr,
            &String::from_str(&env, "job-completed"),
            &0u32,
        );
        assert_eq!(
            client
                .get_job(&String::from_str(&env, "job-completed"))
                .unwrap()
                .status,
            JobStatus::Completed
        );
        assert_eq!(client.get_job_count(), 2);

        // Capture reputation data before cleanup — it must be preserved.
        let rep_before = client.get_freelancer_reputation(&freelancer);

        // Advance time well past deadline + grace period for both jobs.
        let completed = client
            .get_job(&String::from_str(&env, "job-completed"))
            .unwrap();
        env.ledger()
            .set_sequence_number(completed.deadline + GRACE_PERIOD + 1);

        let removed = client.cleanup_completed_jobs();
        assert_eq!(removed, 1);

        // Job B's entry and id are gone; job A remains.
        assert!(client
            .get_job(&String::from_str(&env, "job-completed"))
            .is_none());
        assert!(client
            .get_job(&String::from_str(&env, "job-inflight"))
            .is_some());
        assert_eq!(client.get_job_count(), 1);

        let ids = client.get_job_ids(&0, &MAX_JOB_IDS_PAGE_SIZE);
        assert_eq!(ids.len(), 1);
        assert_eq!(ids.get(0).unwrap(), String::from_str(&env, "job-inflight"));

        // Reputation history survives archival intact.
        let rep_after = client.get_freelancer_reputation(&freelancer);
        assert_eq!(rep_after, rep_before);
        assert_eq!(rep_after.completed_jobs, 1);
        assert_eq!(rep_after.total_jobs, 2);
    }

    #[test]
    fn test_cleanup_does_not_remove_in_flight_jobs() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        // Escrowed (never released).
        setup_single_milestone_job(
            &env,
            &client,
            &client_addr,
            &freelancer,
            &String::from_str(&env, "escrowed"),
            1000i128,
        );
        // PartiallyReleased: two milestones, only the first released.
        {
            let token_admin = Address::generate(&env);
            let token = env
                .register_stellar_asset_contract_v2(token_admin)
                .address();
            StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
            let mut milestones = Vec::new(&env);
            milestones.push_back(make_milestone(&env, "M1", 50));
            milestones.push_back(make_milestone(&env, "M2", 50));
            client.create_job(
                &client_addr,
                &freelancer,
                &String::from_str(&env, "partial"),
                &token,
                &1000i128,
                &milestones,
                &RELEASE_AFTER_LEDGERS,
            );
        }
        client.release_milestone(&client_addr, &String::from_str(&env, "partial"), &0u32);
        assert_eq!(
            client
                .get_job(&String::from_str(&env, "partial"))
                .unwrap()
                .status,
            JobStatus::PartiallyReleased
        );
        // Disputed: single milestone, admin flags it.
        setup_single_milestone_job(
            &env,
            &client,
            &client_addr,
            &freelancer,
            &String::from_str(&env, "disputed"),
            1000i128,
        );
        client.dispute_milestone(
            &signers1(&env, &admin),
            &String::from_str(&env, "disputed"),
            &0u32,
        );
        assert_eq!(
            client
                .get_job(&String::from_str(&env, "disputed"))
                .unwrap()
                .status,
            JobStatus::Disputed
        );

        // A completed job that qualifies for archival once past its grace period.
        setup_single_milestone_job(
            &env,
            &client,
            &client_addr,
            &freelancer,
            &String::from_str(&env, "completed"),
            1000i128,
        );
        client.release_milestone(&client_addr, &String::from_str(&env, "completed"), &0u32);

        // Advance time far beyond every deadline AND grace period.
        let completed_job = client
            .get_job(&String::from_str(&env, "completed"))
            .unwrap();
        env.ledger()
            .set_sequence_number(completed_job.deadline + GRACE_PERIOD + 1);

        // Only the completed job is cleanable; all in-flight jobs survive.
        let removed = client.cleanup_completed_jobs();
        assert_eq!(removed, 1);
        assert!(client
            .get_job(&String::from_str(&env, "escrowed"))
            .is_some());
        assert!(client.get_job(&String::from_str(&env, "partial")).is_some());
        assert!(client
            .get_job(&String::from_str(&env, "disputed"))
            .is_some());
        assert!(client
            .get_job(&String::from_str(&env, "completed"))
            .is_none());
        assert_eq!(client.get_job_count(), 3);

        // Nothing cleanable remaining -> cleanup panics with NothingToCleanUp.
        match client.try_cleanup_completed_jobs() {
            Err(Ok(error)) => assert_eq!(
                EscrowError::try_from(&error).ok(),
                Some(EscrowError::NothingToCleanUp)
            ),
            other => panic!("expected NothingToCleanUp, got {other:?}"),
        }
    }

    #[test]
    fn test_cleanup_frees_jobs_for_new_creation() {
        // The escrow contract keeps every job in `env.storage().instance()`,
        // which Soroban serializes into a single instance entry capped at
        // 64 KiB. That hard platform limit is reached long before
        // `MAX_JOBS = 256` (filling ~101 jobs exceeds it), so a literal
        // 256-job test cannot run. Instead, fill a storage-safe volume,
        // complete all but one, archive the completed jobs, and prove the
        // reclaimed slots let more jobs be created afterwards.
        const FILL: i128 = 64;
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        // Fund the client enough for FILL + 1 jobs.
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &((FILL + 1) * 1000));

        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 100));

        // Create FILL jobs.
        for i in 0..FILL {
            let job_id = String::from_str(&env, &std::format!("bulk-{}", i));
            client.create_job(
                &client_addr,
                &freelancer,
                &job_id,
                &token,
                &1000i128,
                &milestones,
                &RELEASE_AFTER_LEDGERS,
            );
        }
        assert_eq!(client.get_job_count(), FILL as u32);

        // Complete all but the last; that one stays Escrowed (in-flight).
        for i in 0..(FILL - 1) {
            let job_id = String::from_str(&env, &std::format!("bulk-{}", i));
            client.release_milestone(&client_addr, &job_id, &0u32);
        }
        assert_eq!(client.get_job_count(), FILL as u32);

        // Advance well past deadline + grace so all completed jobs are cleanable.
        let last = client
            .get_job(&String::from_str(&env, &std::format!("bulk-{}", FILL - 1)))
            .unwrap();
        env.ledger()
            .set_sequence_number(last.deadline + GRACE_PERIOD + 1);

        let removed = client.cleanup_completed_jobs();
        assert_eq!(removed, (FILL - 1) as u32);

        // FILL - 1 slots reclaimed; the in-flight job remains.
        assert_eq!(client.get_job_count(), 1);
        assert!(client
            .get_job(&String::from_str(&env, &std::format!("bulk-{}", FILL - 1)))
            .is_some());
        for i in 0..(FILL - 1) {
            assert!(client
                .get_job(&String::from_str(&env, &std::format!("bulk-{}", i)))
                .is_none());
        }

        // A new job now succeeds thanks to the reclaimed slots: creating one
        // more than pre-cleanup would be impossible only because the cap is
        // not reached here, so assert the reclaim allowed an additional create.
        client.create_job(
            &client_addr,
            &freelancer,
            &String::from_str(&env, "bulk-reclaimed"),
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
        assert_eq!(client.get_job_count(), 2);
        assert!(client
            .get_job(&String::from_str(&env, "bulk-reclaimed"))
            .is_some());
    }

    #[test]
    fn test_lifecycle_integration() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &3000i128);
        let job_id = String::from_str(&env, "lifecycle-job");

        // 1. Create Job with 3 milestones: 30%, 40%, 30%
        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1-Design"),
            percentage: 30,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M2-Implementation"),
            percentage: 40,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M3-Deployment"),
            percentage: 30,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        // 2. Freelancer claims Milestone 1 after release period
        env.ledger().set_sequence_number(RELEASE_AFTER_LEDGERS + 1);
        client.claim_milestone(&freelancer, &job_id, &0u32);

        let job = client.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::PartiallyReleased);
        assert!(job.milestones.get(0).unwrap().released);

        // 3. Admin disputes Milestone 2
        client.dispute_milestone(&signers1(&env, &admin), &job_id, &1u32);
        let job_disputed = client.get_job(&job_id).unwrap();
        assert_eq!(job_disputed.status, JobStatus::Disputed);

        // 4. Admin resolves Milestone 2 dispute in favor of freelancer
        client.resolve_milestone_dispute(&signers1(&env, &admin), &job_id, &1u32, &true);
        let job_resolved = client.get_job(&job_id).unwrap();
        assert_eq!(job_resolved.status, JobStatus::PartiallyReleased);
        assert!(job_resolved.milestones.get(1).unwrap().released);

        // 5. Client releases Milestone 3
        client.release_milestone(&client_addr, &job_id, &2u32);
        let job_final = client.get_job(&job_id).unwrap();
        assert_eq!(job_final.status, JobStatus::Completed);
    }

    fn make_milestone(env: &Env, name: &str, percentage: u32) -> Milestone {
        Milestone {
            name: String::from_str(env, name),
            percentage,
            released: false,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        }
    }

    /// Create a funded single-milestone job and return its key components.
    /// Shared by the issue #1104 dispute-authorization tests.
    fn create_job_fixture(
        env: &Env,
        client: &EscrowContractClient,
    ) -> (Address, Address, Address, String) {
        let client_addr = Address::generate(env);
        let freelancer = Address::generate(env);
        let token_admin = Address::generate(env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(env, "job-authz-audit");

        let mut milestones = Vec::new(env);
        milestones.push_back(make_milestone(env, "M1", 100));

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
        (client_addr, freelancer, token, job_id)
    }

    #[test]
    fn test_amend_unreleased_job() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-amend");

        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 50));
        milestones.push_back(make_milestone(&env, "M2", 50));

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        let mut new_milestones = Vec::new(&env);
        new_milestones.push_back(make_milestone(&env, "M1-Split-A", 20));
        new_milestones.push_back(make_milestone(&env, "M1-Split-B", 30));
        new_milestones.push_back(make_milestone(&env, "M2", 50));

        client.amend_job_milestones(&client_addr, &freelancer, &job_id, &new_milestones);

        let job = client.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Escrowed);
        assert_eq!(job.amount, 1000i128);
        assert_eq!(job.milestones.len(), 3);
        assert_eq!(
            job.milestones.get(0).unwrap().name,
            String::from_str(&env, "M1-Split-A")
        );
        assert_eq!(client.get_job_amendment_count(&job_id), 1);
    }

    #[test]
    #[should_panic]
    fn test_amend_released_job_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-amend-released");

        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 50));
        milestones.push_back(make_milestone(&env, "M2", 50));

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
        client.release_milestone(&client_addr, &job_id, &0u32);

        let mut new_milestones = Vec::new(&env);
        new_milestones.push_back(make_milestone(&env, "M1", 100));
        client.amend_job_milestones(&client_addr, &freelancer, &job_id, &new_milestones);
    }

    #[test]
    #[should_panic]
    fn test_amend_wrong_sum_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-amend-badsum");

        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 100));

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        let mut new_milestones = Vec::new(&env);
        new_milestones.push_back(make_milestone(&env, "M1", 40));
        new_milestones.push_back(make_milestone(&env, "M2", 40));
        client.amend_job_milestones(&client_addr, &freelancer, &job_id, &new_milestones);
    }

    #[test]
    #[should_panic]
    fn test_amend_only_client_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-amend-only-client");

        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 100));

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        let mut new_milestones = Vec::new(&env);
        new_milestones.push_back(make_milestone(&env, "M1-A", 50));
        new_milestones.push_back(make_milestone(&env, "M1-B", 50));

        client
            .mock_auths(&[soroban_sdk::testutils::MockAuth {
                address: &client_addr,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "amend_job_milestones",
                    args: (
                        client_addr.clone(),
                        freelancer.clone(),
                        job_id.clone(),
                        new_milestones.clone(),
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .amend_job_milestones(&client_addr, &freelancer, &job_id, &new_milestones);
    }

    #[test]
    #[should_panic]
    fn test_amend_only_freelancer_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-amend-only-freelancer");

        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 100));

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        let mut new_milestones = Vec::new(&env);
        new_milestones.push_back(make_milestone(&env, "M1-A", 50));
        new_milestones.push_back(make_milestone(&env, "M1-B", 50));

        client
            .mock_auths(&[soroban_sdk::testutils::MockAuth {
                address: &freelancer,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "amend_job_milestones",
                    args: (
                        client_addr.clone(),
                        freelancer.clone(),
                        job_id.clone(),
                        new_milestones.clone(),
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .amend_job_milestones(&client_addr, &freelancer, &job_id, &new_milestones);
    }

    #[test]
    fn test_amend_count_increments() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-amend-count");

        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 100));

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
        assert_eq!(client.get_job_amendment_count(&job_id), 0);

        let mut amend_1 = Vec::new(&env);
        amend_1.push_back(make_milestone(&env, "M1-A", 60));
        amend_1.push_back(make_milestone(&env, "M1-B", 40));
        client.amend_job_milestones(&client_addr, &freelancer, &job_id, &amend_1);
        assert_eq!(client.get_job_amendment_count(&job_id), 1);

        let mut amend_2 = Vec::new(&env);
        amend_2.push_back(make_milestone(&env, "M1-Only", 100));
        client.amend_job_milestones(&client_addr, &freelancer, &job_id, &amend_2);
        assert_eq!(client.get_job_amendment_count(&job_id), 2);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Multi-sig admin (#440)
    // ─────────────────────────────────────────────────────────────────────

    fn build_signers(env: &Env, addrs: &[Address]) -> Vec<Address> {
        let mut v = Vec::new(env);
        for a in addrs {
            v.push_back(a.clone());
        }
        v
    }

    #[test]
    fn test_multi_sig_admin_initialize() {
        let env = Env::default();
        env.mock_all_auths();

        let cid = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &cid);

        let admins = [
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        ];
        client.initialize(&build_signers(&env, &admins), &2u32);

        assert_eq!(client.get_admin_set(), build_signers(&env, &admins));
        assert_eq!(client.get_admin_threshold(), 2u32);
    }

    #[test]
    fn test_multi_sig_dispute() {
        let env = Env::default();
        env.mock_all_auths();

        let cid = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &cid);

        let admins = [
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        ];
        client.initialize(&build_signers(&env, &admins), &2u32);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-multisig-dispute");
        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 100));

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        // 2 of the 3 admins sign — meets the 2-of-3 threshold.
        let two_signers = build_signers(&env, &admins[0..2]);
        client.dispute_milestone(&two_signers, &job_id, &0u32);

        let job = client.get_job(&job_id).unwrap();
        assert!(job.milestones.get(0).unwrap().disputed);
    }

    #[test]
    #[should_panic]
    fn test_single_admin_threshold_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-single-admin-threshold");
        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 100));

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        // Contract is 1-of-1; a stranger's signature never satisfies the
        // threshold no matter how many times it is repeated.
        let stranger = Address::generate(&env);
        client.dispute_milestone(&signers1(&env, &stranger), &job_id, &0u32);
    }

    #[test]
    #[should_panic]
    fn test_insufficient_signatures_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let cid = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &cid);

        let admins = [Address::generate(&env), Address::generate(&env)];
        client.initialize(&build_signers(&env, &admins), &2u32);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-insufficient-sigs");
        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 100));

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        // Only one of the two required admins signs; the second signer is a
        // stranger who isn't in the admin set, so the valid count stays at 1.
        let stranger = Address::generate(&env);
        let mut mixed_signers = Vec::new(&env);
        mixed_signers.push_back(admins[0].clone());
        mixed_signers.push_back(stranger);
        client.dispute_milestone(&mixed_signers, &job_id, &0u32);
    }

    // ─── Issue #1104, Part B: legacy dispute-path authorization audit ────────
    // `dispute_job` and `resolve_dispute` are deprecated but retained for
    // backward compatibility; the audit (issue #1104) requires them to be
    // gated with the SAME M-of-N `require_admin` checks as
    // `dispute_milestone`/`resolve_milestone_dispute`, with tests for wrong
    // callers, insufficient admin signatures, and disputed-state transitions.

    /// A non-admin signer cannot dispute a job through the legacy entrypoint.
    #[test]
    #[should_panic]
    fn test_dispute_job_wrong_signer_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let (client_addr, freelancer, token, job_id) = create_job_fixture(&env, &client);

        // 1-of-1 admin set: a stranger's signature never satisfies the threshold.
        let stranger = Address::generate(&env);
        client.dispute_job(&signers1(&env, &stranger), &job_id);
        let _ = (admin, client_addr, freelancer, token);
    }

    /// The legacy `dispute_job` enforces the same M-of-N threshold as the
    /// modern `dispute_milestone` — one valid admin of a 2-of-2 set is not
    /// enough.
    #[test]
    #[should_panic]
    fn test_dispute_job_insufficient_signatures_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let cid = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &cid);

        let admins = [Address::generate(&env), Address::generate(&env)];
        client.initialize(&build_signers(&env, &admins), &2u32);

        let (client_addr, freelancer, token, job_id) = create_job_fixture(&env, &client);
        let _ = (client_addr, freelancer, token);

        // Only one of the two required admins signs; the second signer is a
        // stranger, so the valid count stays at 1 (< 2).
        let stranger = Address::generate(&env);
        let mut mixed_signers = Vec::new(&env);
        mixed_signers.push_back(admins[0].clone());
        mixed_signers.push_back(stranger);
        client.dispute_job(&mixed_signers, &job_id);
    }

    /// The legacy `resolve_dispute` enforces the same M-of-N threshold.
    #[test]
    #[should_panic]
    fn test_resolve_dispute_insufficient_signatures_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let cid = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &cid);

        let admins = [Address::generate(&env), Address::generate(&env)];
        client.initialize(&build_signers(&env, &admins), &2u32);

        let (_client_addr, _freelancer, _token, job_id) = create_job_fixture(&env, &client);

        // Put the job into a disputed state with a full admin set first.
        client.dispute_job(&build_signers(&env, &admins), &job_id);

        // Resolving with only one valid admin must be rejected.
        let stranger = Address::generate(&env);
        let mut mixed_signers = Vec::new(&env);
        mixed_signers.push_back(admins[0].clone());
        mixed_signers.push_back(stranger);
        client.resolve_dispute(&mixed_signers, &job_id, &true);
    }

    /// `resolve_milestone_dispute` enforces the same M-of-N threshold.
    #[test]
    #[should_panic]
    fn test_resolve_milestone_dispute_insufficient_signatures_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let cid = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &cid);

        let admins = [Address::generate(&env), Address::generate(&env)];
        client.initialize(&build_signers(&env, &admins), &2u32);

        let (_client_addr, _freelancer, _token, job_id) = create_job_fixture(&env, &client);

        client.dispute_milestone(&build_signers(&env, &admins), &job_id, &0u32);

        let stranger = Address::generate(&env);
        let mut mixed_signers = Vec::new(&env);
        mixed_signers.push_back(admins[0].clone());
        mixed_signers.push_back(stranger);
        client.resolve_milestone_dispute(&mixed_signers, &job_id, &0u32, &true);
    }

    /// `resolve_dispute` on a job that was never disputed panics.
    #[test]
    #[should_panic(expected = "Error(Contract, #39)")]
    fn test_resolve_dispute_not_disputed_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let (_client_addr, _freelancer, _token, job_id) = create_job_fixture(&env, &client);

        client.resolve_dispute(&signers1(&env, &admin), &job_id, &true);
    }

    /// A non-admin signer cannot resolve a milestone dispute.
    #[test]
    #[should_panic]
    fn test_resolve_milestone_dispute_wrong_signer_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let (_client_addr, _freelancer, _token, job_id) = create_job_fixture(&env, &client);
        client.dispute_milestone(&signers1(&env, &admin), &job_id, &0u32);

        let stranger = Address::generate(&env);
        client.resolve_milestone_dispute(&signers1(&env, &stranger), &job_id, &0u32, &true);
    }

    #[test]
    fn test_per_job_release_after() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-custom-release-after");
        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 100));

        let custom_release_after = RELEASE_AFTER_LEDGERS * 5;
        let created_at = env.ledger().sequence();
        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &custom_release_after,
        );

        let job = client.get_job(&job_id).unwrap();
        assert_eq!(job.release_after, created_at + custom_release_after);

        // Once the job's own (longer) release_after is reached, the claim succeeds.
        env.ledger()
            .set_sequence_number(created_at + custom_release_after + 1);
        client.claim_milestone(&freelancer, &job_id, &0u32);
        assert!(
            client
                .get_job(&job_id)
                .unwrap()
                .milestones
                .get(0)
                .unwrap()
                .released
        );
    }

    #[test]
    #[should_panic]
    fn test_per_job_release_after_longer_than_minimum_still_enforced() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-custom-release-after-early");
        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 100));

        let custom_release_after = RELEASE_AFTER_LEDGERS * 5;
        let created_at = env.ledger().sequence();
        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &custom_release_after,
        );

        // Past the contract-wide minimum but before this job's own (longer)
        // release_after — must still be rejected.
        env.ledger()
            .set_sequence_number(created_at + RELEASE_AFTER_LEDGERS + 1);
        client.claim_milestone(&freelancer, &job_id, &0u32);
    }

    #[test]
    #[should_panic]
    fn test_release_after_exceeds_deadline_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-release-after-exceeds-deadline");
        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 100));

        // DEFAULT_DEADLINE_LEDGERS is 1_555_200; passing 2_000_000 makes the
        // absolute release_after exceed the absolute deadline.
        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &2_000_000u32,
        );
    }

    #[test]
    #[should_panic]
    fn test_release_after_below_minimum_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token = Address::generate(&env);
        let job_id = String::from_str(&env, "job-release-after-too-low");
        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 100));

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &(RELEASE_AFTER_LEDGERS - 1),
        );
    }

    #[test]
    fn test_update_release_after() {
        let env = Env::default();
        env.mock_all_auths();

        let cid = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &cid);
        let admins = [Address::generate(&env), Address::generate(&env)];
        client.initialize(&build_signers(&env, &admins), &2u32);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-update-release-after");
        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 100));

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        let original_release_after = client.get_job(&job_id).unwrap().release_after;
        let extended = original_release_after + 100;
        client.update_release_after(&build_signers(&env, &admins), &job_id, &extended);

        assert_eq!(client.get_job(&job_id).unwrap().release_after, extended);
    }

    #[test]
    #[should_panic]
    fn test_update_release_after_cannot_shorten_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-shorten-release-after");
        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 100));

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        let current = client.get_job(&job_id).unwrap().release_after;
        client.update_release_after(&signers1(&env, &admin), &job_id, &(current - 1));
    }

    #[test]
    #[should_panic]
    fn test_update_release_after_cannot_exceed_deadline_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-release-after-past-deadline");
        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 100));

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        let deadline = client.get_job(&job_id).unwrap().deadline;
        client.update_release_after(&signers1(&env, &admin), &job_id, &(deadline + 1));
    }

    #[test]
    fn test_admin_management() {
        let env = Env::default();
        env.mock_all_auths();

        let cid = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &cid);
        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        client.initialize(&build_signers(&env, &[admin1.clone()]), &1u32);

        // Add a second admin, then raise the threshold to 2-of-2.
        client.add_admin(&signers1(&env, &admin1), &admin2);
        assert_eq!(
            client.get_admin_set(),
            build_signers(&env, &[admin1.clone(), admin2.clone()])
        );

        client.update_threshold(
            &build_signers(&env, &[admin1.clone(), admin2.clone()]),
            &2u32,
        );
        assert_eq!(client.get_admin_threshold(), 2u32);

        // Lower the threshold back to 1 before removing an admin, otherwise
        // the resulting 1-member set would be smaller than the threshold.
        client.update_threshold(
            &build_signers(&env, &[admin1.clone(), admin2.clone()]),
            &1u32,
        );
        client.remove_admin(
            &build_signers(&env, &[admin1.clone(), admin2.clone()]),
            &admin2,
        );
        assert_eq!(
            client.get_admin_set(),
            build_signers(&env, &[admin1.clone()])
        );
    }

    #[test]
    #[should_panic]
    fn test_remove_last_admin_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);
        client.remove_admin(&signers1(&env, &admin), &admin);
    }

    #[test]
    fn test_reputation_on_completion() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, contract) = setup(&env);
        let client = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let job_id = String::from_str(&env, "rep-complete");
        create_reputation_job(&env, &contract, &client, &freelancer, &job_id, 1_000);

        let created = contract.get_freelancer_reputation(&freelancer);
        assert_eq!(created.total_jobs, 1);
        assert_eq!(created.completed_jobs, 0);

        contract.release_milestone(&client, &job_id, &0);
        let completed = contract.get_freelancer_reputation(&freelancer);
        assert_eq!(completed.completed_jobs, 1);
        assert_eq!(completed.total_value_completed, 1_000);
        assert_eq!(completed.on_time_completions, 1);
    }

    #[test]
    fn test_reputation_on_time_completion() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, contract) = setup(&env);
        let client = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let job_id = String::from_str(&env, "rep-on-time");
        create_reputation_job(&env, &contract, &client, &freelancer, &job_id, 1_000);

        contract.release_milestone(&client, &job_id, &0);
        let reputation = contract.get_freelancer_reputation(&freelancer);
        assert_eq!(reputation.completed_jobs, 1);
        assert_eq!(reputation.on_time_completions, 1);
    }

    #[test]
    fn test_reputation_late_completion() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, contract) = setup(&env);
        let client = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let job_id = String::from_str(&env, "rep-late");
        create_reputation_job(&env, &contract, &client, &freelancer, &job_id, 1_000);

        let deadline = contract.get_job(&job_id).unwrap().deadline;
        env.ledger().set_sequence_number(deadline + 1);

        contract.release_milestone(&client, &job_id, &0);
        let reputation = contract.get_freelancer_reputation(&freelancer);
        assert_eq!(reputation.completed_jobs, 1);
        assert_eq!(reputation.on_time_completions, 0);
    }

    #[test]
    fn test_reputation_on_dispute() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, contract) = setup(&env);
        let client = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let job_id = String::from_str(&env, "rep-dispute");
        create_reputation_job(&env, &contract, &client, &freelancer, &job_id, 500);

        contract.dispute_milestone(&signers1(&env, &admin), &job_id, &0);
        let disputed = contract.get_freelancer_reputation(&freelancer);
        assert_eq!(disputed.total_jobs, 1);
        assert_eq!(disputed.disputed_jobs, 1);
        assert_eq!(disputed.completed_jobs, 0);

        contract.resolve_milestone_dispute(&signers1(&env, &admin), &job_id, &0, &true);
        let resolved = contract.get_freelancer_reputation(&freelancer);
        assert_eq!(resolved.disputed_jobs, 1);
        assert_eq!(resolved.completed_jobs, 1);
    }

    #[test]
    fn test_reputation_on_refund() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, contract) = setup(&env);
        let client = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let job_id = String::from_str(&env, "rep-refund");
        create_reputation_job(&env, &contract, &client, &freelancer, &job_id, 750);
        let deadline = contract.get_job(&job_id).unwrap().deadline;
        env.ledger().set_sequence_number(deadline);

        contract.refund_expired_job(&client, &job_id);
        let reputation = contract.get_freelancer_reputation(&freelancer);
        assert_eq!(reputation.total_jobs, 1);
        assert_eq!(reputation.completed_jobs, 0);
        assert_eq!(reputation.total_value_completed, 0);
        assert_eq!(reputation.on_time_completions, 0);
    }

    #[test]
    fn test_reputation_query() {
        let env = Env::default();
        let (_admin, contract) = setup(&env);
        let reputation = contract.get_freelancer_reputation(&Address::generate(&env));
        assert_eq!(
            reputation,
            FreelancerReputation {
                total_jobs: 0,
                completed_jobs: 0,
                disputed_jobs: 0,
                total_value_completed: 0,
                on_time_completions: 0,
                created_at: 0,
            }
        );
    }

    #[cfg(feature = "oracle-escrow")]
    mod oracle_escrow_tests {
        use super::*;
        use soroban_sdk::testutils::Address as _;

        fn setup_oracle_job(
            env: &Env,
            client: &EscrowContractClient<'_>,
            client_addr: &Address,
            freelancer: &Address,
            oracle: Option<Address>,
        ) -> (String, Address) {
            let token_admin = Address::generate(env);
            let token = env
                .register_stellar_asset_contract_v2(token_admin)
                .address();
            StellarAssetClient::new(env, &token).mint(client_addr, &1000i128);
            let job_id = String::from_str(env, "oracle-job");

            let mut milestones = Vec::new(env);
            milestones.push_back(Milestone {
                name: String::from_str(env, "Oracle Milestone"),
                percentage: 100,
                released: false,
                disputed: false,
                oracle: oracle.clone(),
                verified: false,
                proof_hash: None,
            });

            client.create_job(
                client_addr,
                freelancer,
                &job_id,
                &token,
                &1000i128,
                &milestones,
                &RELEASE_AFTER_LEDGERS,
            );
            (job_id, token)
        }

        #[test]
        fn test_oracle_verified_milestone_release() {
            let env = Env::default();
            env.mock_all_auths();
            let (_admin, client) = setup(&env);

            let client_addr = Address::generate(&env);
            let freelancer = Address::generate(&env);
            let oracle = Address::generate(&env);

            let (job_id, _token) = setup_oracle_job(
                &env,
                &client,
                &client_addr,
                &freelancer,
                Some(oracle.clone()),
            );

            let proof = BytesN::from_array(&env, &[42u8; 32]);

            client.submit_milestone_proof(&freelancer, &job_id, &0u32, &proof);
            client.verify_milestone(&oracle, &job_id, &0u32);
            client.release_milestone(&client_addr, &job_id, &0u32);

            let job = client.get_job(&job_id).unwrap();
            assert_eq!(job.status, JobStatus::Completed);
            assert!(job.milestones.get(0).unwrap().released);
        }

        #[test]
        #[should_panic]
        fn test_release_unverified_oracle_milestone_fails() {
            let env = Env::default();
            env.mock_all_auths();
            let (_admin, client) = setup(&env);

            let client_addr = Address::generate(&env);
            let freelancer = Address::generate(&env);
            let oracle = Address::generate(&env);

            let (job_id, _token) = setup_oracle_job(
                &env,
                &client,
                &client_addr,
                &freelancer,
                Some(oracle.clone()),
            );

            let proof = BytesN::from_array(&env, &[1u8; 32]);
            client.submit_milestone_proof(&freelancer, &job_id, &0u32, &proof);
            // Do NOT verify → release should panic
            client.release_milestone(&client_addr, &job_id, &0u32);
        }

        #[test]
        fn test_milestone_without_oracle_works_as_before() {
            let env = Env::default();
            env.mock_all_auths();
            let (_admin, client) = setup(&env);

            let client_addr = Address::generate(&env);
            let freelancer = Address::generate(&env);

            let (job_id, _token) = setup_oracle_job(&env, &client, &client_addr, &freelancer, None);

            // No proof, no verification — release should succeed as before
            client.release_milestone(&client_addr, &job_id, &0u32);

            let job = client.get_job(&job_id).unwrap();
            assert_eq!(job.status, JobStatus::Completed);
            assert!(job.milestones.get(0).unwrap().released);
        }

        #[test]
        fn test_dispute_voids_verification() {
            let env = Env::default();
            env.mock_all_auths();
            let (_admin, client) = setup(&env);

            let client_addr = Address::generate(&env);
            let freelancer = Address::generate(&env);
            let oracle = Address::generate(&env);

            let (job_id, _token) = setup_oracle_job(
                &env,
                &client,
                &client_addr,
                &freelancer,
                Some(oracle.clone()),
            );

            let proof = BytesN::from_array(&env, &[99u8; 32]);
            client.submit_milestone_proof(&freelancer, &job_id, &0u32, &proof);
            client.verify_milestone(&oracle, &job_id, &0u32);

            // Verify it's verified before dispute
            let job_before = client.get_job(&job_id).unwrap();
            assert!(job_before.milestones.get(0).unwrap().verified);

            // Dispute the milestone
            client.dispute_milestone(&signers1(&env, &_admin), &job_id, &0u32);

            // After dispute, verified must be false and proof_hash cleared
            let job_after = client.get_job(&job_id).unwrap();
            let m = job_after.milestones.get(0).unwrap();
            assert!(!m.verified);
            assert!(m.proof_hash.is_none());
        }
    }
}
