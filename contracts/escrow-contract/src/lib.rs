#![no_std]
#![allow(deprecated)]

//! Escrow contract with milestone-based fund release.
//! Client locks funds with `create_job`, then releases them per milestone.

#[cfg(feature = "oracle-escrow")]
use soroban_sdk::BytesN;
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env, String, Vec,
};

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum JobStatus {
    Escrowed,
    PartiallyReleased,
    Completed,
    Disputed,
}

#[cfg(not(feature = "oracle-escrow"))]
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Milestone {
    pub name: String,
    pub percentage: u32, // 0-100
    pub released: bool,
    // Cumulative percentage of THIS milestone released so far (0-100).
    // `released` is always kept in sync with `partial_release_percentage == 100`.
    pub partial_release_percentage: u32,
    pub disputed: bool,
    pub oracle: Option<Address>,
    pub verified: bool,
    pub proof_hash: Option<BytesN<32>>,
}

#[cfg(feature = "oracle-escrow")]
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Milestone {
    pub name: String,
    pub percentage: u32, // 0-100
    pub released: bool,
    // Cumulative percentage of THIS milestone released so far (0-100).
    // `released` is always kept in sync with `partial_release_percentage == 100`.
    pub partial_release_percentage: u32,
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
}

/// Minimum number of ledgers a job's release period may specify. Jobs
/// cannot request a shorter freelancer auto-claim window than this; it is
/// a floor, not a default — callers must pass their own `release_after`
/// to `create_job`.
pub const RELEASE_AFTER_LEDGERS: u32 = 10;
pub const DEFAULT_DEADLINE_LEDGERS: u32 = 1_555_200; // 90 days @ 5s/ledger

/// The full proportional amount a milestone is worth, and how much of that
/// has been released so far given its cumulative `partial_release_percentage`.
fn milestone_amounts(job: &Job, milestone: &Milestone) -> (i128, i128) {
    let full_amount = (job.amount * milestone.percentage as i128) / 100i128;
    let released_amount = (full_amount * milestone.partial_release_percentage as i128) / 100i128;
    (full_amount, released_amount)
}

fn compute_remaining_funds(job: &Job) -> i128 {
    let mut remaining_amount: i128 = 0;
    for milestone in job.milestones.iter() {
        let (full_amount, released_amount) = milestone_amounts(job, &milestone);
        remaining_amount = remaining_amount
            .checked_add(full_amount - released_amount)
            .expect("remaining_amount overflow");
    }
    remaining_amount
}

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
        .expect("Not initialized")
}

/// Count the number of distinct addresses in `signers` that belong to
/// `admin_set`. Pure counting logic, decoupled from authentication so it
/// can be exercised directly (e.g. by property tests) without needing a
/// signed authorization entry per signer. Duplicate signers are counted
/// only once so a single compromised key cannot satisfy a threshold by
/// appearing multiple times in `signers`.
fn count_distinct_admins(admin_set: &Vec<Address>, signers: &Vec<Address>) -> u32 {
    let mut counted: Vec<Address> = Vec::new(admin_set.env());
    let mut valid_count: u32 = 0;
    for signer in signers.iter() {
        if admin_set.contains(&signer) && !counted.contains(&signer) {
            counted.push_back(signer.clone());
            valid_count = valid_count.checked_add(1).expect("valid_count overflow");
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
    let valid_count = count_distinct_admins(&admin_set, signers);

    if valid_count < required_threshold {
        panic!(
            "Insufficient admin signatures: {}/{} required",
            valid_count, required_threshold
        );
    }
}

/// Require M-of-N admin signatures for an admin-gated escrow action.
fn require_admin(env: &Env, signers: &Vec<Address>) {
    let threshold: u32 = read_admin_threshold(env);
    verify_m_of_n(env, signers, threshold);
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Initialize the contract with an M-of-N multi-sig admin set.
    /// Single-admin deployments call this with `vec![admin]` and threshold `1`.
    pub fn initialize(env: Env, admins: Vec<Address>, threshold: u32) {
        if env.storage().instance().has(&DataKey::AdminSet) {
            panic!("Already initialized");
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
            panic!("Amount must be positive");
        }
        if release_after < RELEASE_AFTER_LEDGERS {
            panic!(
                "release_after must be at least the minimum of {} ledgers",
                RELEASE_AFTER_LEDGERS
            );
        }
        if env.storage().instance().has(&DataKey::Job(job_id.clone())) {
            panic!("Job already exists");
        }

        // Validate milestones sum to 100%
        let mut total_percentage: u32 = 0;
        for milestone in milestones.iter() {
            total_percentage = total_percentage
                .checked_add(milestone.percentage)
                .expect("Milestone percentage overflow");
        }
        if total_percentage != 100 {
            panic!("Milestones must sum to 100%");
        }

        let deadline = env.ledger().sequence() + DEFAULT_DEADLINE_LEDGERS;

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
            release_after: env.ledger().sequence() + release_after,
            deadline,
        };
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::JobCount)
            .unwrap_or(0);
        let next_count = count.checked_add(1).expect("JobCount overflow");
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
        env.events().publish(
            (symbol_short!("job_creat"), client.clone()),
            (job_id, freelancer, amount),
        );

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
            .expect("Job not found");

        if job.client != client {
            panic!("Only the job's client can amend");
        }
        if job.freelancer != freelancer {
            panic!("Only the job's freelancer can amend");
        }
        if job.status != JobStatus::Escrowed {
            panic!("Amendment only allowed before any milestone is released");
        }

        let mut total_percentage: u32 = 0;
        for milestone in new_milestones.iter() {
            if milestone.released || milestone.disputed || milestone.partial_release_percentage != 0
            {
                panic!("New milestones must not be released or disputed");
            }
            total_percentage = total_percentage
                .checked_add(milestone.percentage)
                .expect("Milestone percentage overflow");
        }
        if total_percentage != 100 {
            panic!("Milestones must sum to 100%");
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
            .expect("AmendmentCount overflow");
        env.storage().instance().set(
            &DataKey::AmendmentCount(job_id.clone()),
            &next_amendment_count,
        );

        env.events().publish(
            (symbol_short!("job_amend"), client),
            (
                job_id,
                old_milestone_count,
                new_milestone_count,
                next_amendment_count,
            ),
        );
    }

    /// Number of times a job's milestones have been amended via `amend_job_milestones`.
    pub fn get_job_amendment_count(env: Env, job_id: String) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::AmendmentCount(job_id))
            .unwrap_or(0)
    }

    /// Client releases `release_pct`% of a milestone's proportional amount
    /// (e.g. `release_pct=50` on a 40%-of-job milestone pays out 20% of the
    /// total job amount). `release_pct` is added to whatever has already
    /// been released for this milestone via prior partial releases; the
    /// milestone becomes fully released once the cumulative total reaches
    /// 100. Pays the incremental amount to the freelancer.
    pub fn release_milestone(
        env: Env,
        client: Address,
        job_id: String,
        milestone_index: u32,
        release_pct: u32,
    ) {
        client.require_auth();
        if release_pct == 0 {
            panic!("release_pct must be greater than 0");
        }
        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .expect("Job not found");

        if job.client != client {
            panic!("Only the client can release");
        }
        if job.disputed {
            panic!("Job is disputed; admin must resolve");
        }
        if milestone_index >= job.milestones.len() {
            panic!("Invalid milestone index");
        }

        let milestone = &job.milestones.get(milestone_index).unwrap();
        if milestone.disputed {
            panic!("Milestone is disputed");
        }
        if milestone.released {
            panic!("Milestone already released");
        }

        #[cfg(feature = "oracle-escrow")]
        if milestone.oracle.is_some() && !milestone.verified {
            panic!("Milestone not verified by oracle");
        }

        let new_partial_pct = milestone
            .partial_release_percentage
            .checked_add(release_pct)
            .expect("partial_release_percentage overflow");
        if new_partial_pct > 100 {
            panic!("release_pct exceeds remaining milestone percentage");
        }

        let (full_amount, released_before) = milestone_amounts(&job, milestone);
        let released_after = (full_amount * new_partial_pct as i128) / 100i128;
        let release_amount = released_after - released_before;

        // ── Effects: rebuild the milestone vector, recompute status,
        //    and persist state BEFORE the external token movement (CEI ordering).
        let mut updated_milestones = job.milestones.clone();
        let mut released_count = 0u32;
        for i in 0..updated_milestones.len() {
            let mut m = updated_milestones.get(i).unwrap().clone();
            if i == milestone_index {
                m.partial_release_percentage = new_partial_pct;
                m.released = new_partial_pct == 100;
            }
            if m.released {
                released_count = released_count
                    .checked_add(1)
                    .expect("released_count overflow");
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

        // Event emission
        env.events().publish(
            (symbol_short!("ms_rel"), client),
            (job_id, milestone_index, release_pct, release_amount),
        );

        // ── Interaction: external token transfer last.
        let token_client = token::Client::new(&env, &job.token);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&contract_addr, &job.freelancer, &release_amount);
    }

    /// Alias for `release_milestone` — releases `release_pct`% of a milestone's
    /// proportional amount. Provided for callers that want an explicitly-named
    /// entry point for partial releases.
    pub fn release_milestone_partial(
        env: Env,
        client: Address,
        job_id: String,
        milestone_index: u32,
        release_pct: u32,
    ) {
        Self::release_milestone(env, client, job_id, milestone_index, release_pct);
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
            .expect("Job not found");

        if job.freelancer != freelancer {
            panic!("Only the assigned freelancer can submit proof");
        }
        if milestone_index >= job.milestones.len() {
            panic!("Invalid milestone index");
        }

        let mut milestones = job.milestones.clone();
        let mut milestone = milestones.get(milestone_index).unwrap().clone();
        if milestone.released {
            panic!("Milestone already completed");
        }

        milestone.proof_hash = Some(proof_hash);
        milestone.verified = false;
        milestones.set(milestone_index, milestone);
        job.milestones = milestones;
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        env.events().publish(
            (symbol_short!("ms_proof"), freelancer),
            (job_id, milestone_index),
        );
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
            .expect("Job not found");

        if milestone_index >= job.milestones.len() {
            panic!("Invalid milestone index");
        }

        let mut milestones = job.milestones.clone();
        let mut milestone = milestones.get(milestone_index).unwrap().clone();
        if milestone.oracle.is_none() {
            panic!("Milestone has no oracle configured");
        }
        if milestone.oracle.as_ref().unwrap() != &oracle {
            panic!("Only the configured oracle can verify");
        }
        if milestone.proof_hash.is_none() {
            panic!("No proof submitted yet");
        }
        if milestone.released {
            panic!("Milestone already completed");
        }

        milestone.verified = true;
        milestones.set(milestone_index, milestone);
        job.milestones = milestones;
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        env.events().publish(
            (symbol_short!("ms_verif"), oracle),
            (job_id, milestone_index),
        );
    }

    /// M-of-N admin (deprecated): Mark a job as disputed, freezing remaining releases.
    #[deprecated]
    pub fn dispute_job(env: Env, signers: Vec<Address>, job_id: String) {
        require_admin(&env, &signers);

        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .expect("Job not found");
        job.disputed = true;
        job.status = JobStatus::Disputed;
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        env.events().publish((symbol_short!("job_disp"),), job_id);
    }

    /// M-of-N admin (deprecated): Resolve a dispute and release remaining funds.
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
            .expect("Job not found");

        if !job.disputed {
            panic!("Job is not disputed");
        }

        let remaining_amount = compute_remaining_funds(&job);

        let mut updated_milestones = job.milestones.clone();
        for i in 0..updated_milestones.len() {
            let mut m = updated_milestones.get(i).unwrap().clone();
            m.released = true;
            m.partial_release_percentage = 100;
            m.disputed = false;
            updated_milestones.set(i, m);
        }
        job.milestones = updated_milestones;
        job.status = JobStatus::Completed;
        job.disputed = false;
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        env.events().publish(
            (symbol_short!("job_reslv"),),
            (job_id.clone(), approve_remaining),
        );

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
            .expect("Job not found");

        if milestone_index >= job.milestones.len() {
            panic!("Invalid milestone index");
        }

        let mut milestones = job.milestones.clone();
        let mut milestone = milestones.get(milestone_index).unwrap().clone();
        if milestone.released {
            panic!("Milestone already released");
        }
        if milestone.disputed {
            panic!("Milestone already disputed");
        }
        milestone.disputed = true;
        #[cfg(feature = "oracle-escrow")]
        {
            milestone.verified = false;
            milestone.proof_hash = None;
        }
        milestones.set(milestone_index, milestone);
        job.milestones = milestones;
        job.status = JobStatus::Disputed;

        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        env.events()
            .publish((symbol_short!("ms_disp"),), (job_id, milestone_index));
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
            .expect("Job not found");

        if milestone_index >= job.milestones.len() {
            panic!("Invalid milestone index");
        }

        let mut milestones = job.milestones.clone();
        let mut milestone = milestones.get(milestone_index).unwrap().clone();
        if !milestone.disputed {
            panic!("Milestone is not disputed");
        }

        // Only the portion not already paid out by a prior partial release
        // is settled here — a milestone can be disputed after some of its
        // percentage has already been released.
        let (full_amount, released_before) = milestone_amounts(&job, &milestone);
        let release_amount = full_amount - released_before;

        milestone.disputed = false;
        milestone.released = true;
        milestone.partial_release_percentage = 100;
        milestones.set(milestone_index, milestone);
        job.milestones = milestones;

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

        env.events().publish(
            (symbol_short!("ms_reslv"),),
            (job_id, milestone_index, approve),
        );

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
            .expect("Job not found");

        if job.client != client {
            panic!("Only the client can request refund");
        }
        if env.ledger().sequence() < job.deadline {
            panic!("Job deadline has not passed");
        }

        let any_claimed = job
            .milestones
            .iter()
            .any(|m| m.partial_release_percentage > 0);
        if any_claimed {
            panic!("Cannot refund - milestones have been claimed");
        }

        let remaining = compute_remaining_funds(&job);

        job.status = JobStatus::Completed;
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        env.events().publish(
            (symbol_short!("job_refnd"), client.clone()),
            (job_id, remaining),
        );

        if remaining > 0 {
            let token_client = token::Client::new(&env, &job.token);
            let contract_addr = env.current_contract_address();
            token_client.transfer(&contract_addr, &client, &remaining);
        }
    }

    /// Freelancer can claim a milestone's remaining unreleased percentage
    /// after release_after ledgers if not disputed. If the milestone already
    /// has a partial release, only the outstanding portion is paid out.
    pub fn claim_milestone(env: Env, freelancer: Address, job_id: String, milestone_index: u32) {
        freelancer.require_auth();
        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .expect("Job not found");

        if job.disputed {
            panic!("Job is disputed; cannot claim milestone");
        }
        if env.ledger().sequence() < job.release_after {
            panic!("Release period not reached");
        }
        if milestone_index >= job.milestones.len() {
            panic!("Invalid milestone index");
        }
        let milestone = &job.milestones.get(milestone_index).unwrap();
        if milestone.disputed {
            panic!("Milestone is disputed; cannot claim milestone");
        }
        if milestone.released {
            panic!("Milestone already released");
        }
        let (full_amount, released_before) = milestone_amounts(&job, milestone);
        let release_amount = full_amount - released_before;

        // ── Effects: mark milestone released and update status BEFORE
        //    the external token transfer (CEI ordering).
        let mut updated_milestones = job.milestones.clone();
        let mut m = updated_milestones.get(milestone_index).unwrap().clone();
        m.released = true;
        m.partial_release_percentage = 100;
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

        // Event emission
        env.events().publish(
            (symbol_short!("ms_claim"), freelancer),
            (job_id, milestone_index, release_amount),
        );

        // ── Interaction: external token transfer last.
        let token_client = token::Client::new(&env, &job.token);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&contract_addr, &job.freelancer, &release_amount);
    }

    /// M-of-N admin: extend a job's release period. `new_release_after` is the
    /// new absolute ledger sequence at which the freelancer may auto-claim
    /// unclaimed milestones; it must be later than the job's current
    /// `release_after` (extension only — the period can never be shortened).
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
            .expect("Job not found");

        if new_release_after <= job.release_after {
            panic!("New release_after must extend the current release period");
        }

        job.release_after = new_release_after;
        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        env.events()
            .publish((symbol_short!("rel_upd"),), (job_id, new_release_after));
    }

    /// M-of-N admin: add a new address to the admin set.
    pub fn add_admin(env: Env, signers: Vec<Address>, new_admin: Address) {
        require_admin(&env, &signers);
        let mut admin_set: Vec<Address> = read_admin_set(&env);
        if admin_set.contains(&new_admin) {
            panic!("Address is already an admin");
        }
        admin_set.push_back(new_admin.clone());
        env.storage().instance().set(&DataKey::AdminSet, &admin_set);
        env.events()
            .publish((symbol_short!("admin_add"),), new_admin);
    }

    /// M-of-N admin: remove an address from the admin set. Panics if this would
    /// leave the set empty, or if the resulting set is smaller than the
    /// current threshold (call `update_threshold` first).
    pub fn remove_admin(env: Env, signers: Vec<Address>, admin_to_remove: Address) {
        require_admin(&env, &signers);
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
    }

    /// M-of-N admin: update the threshold for admin-gated actions. Must
    /// satisfy `1 <= new_threshold <= admin_set.len()`.
    pub fn update_threshold(env: Env, signers: Vec<Address>, new_threshold: u32) {
        require_admin(&env, &signers);
        let admin_set: Vec<Address> = read_admin_set(&env);
        if new_threshold == 0 || new_threshold > admin_set.len() {
            panic!("Threshold must be between 1 and the number of admins");
        }
        env.storage()
            .instance()
            .set(&DataKey::AdminThreshold, &new_threshold);
        env.events()
            .publish((symbol_short!("thresh_up"),), new_threshold);
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

    pub fn get_job_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::JobCount)
            .unwrap_or(0)
    }

    pub fn get_job_ids(env: Env) -> Vec<String> {
        env.storage()
            .instance()
            .get(&DataKey::JobIds)
            .unwrap_or_else(|| Vec::new(&env))
    }
}

#[cfg(all(test, feature = "testutils"))]
mod escrow_fuzz;

#[cfg(test)]
mod tests {
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
            partial_release_percentage: 0,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "Development"),
            percentage: 30,
            released: false,
            partial_release_percentage: 0,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "Testing"),
            percentage: 20,
            released: false,
            partial_release_percentage: 0,
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
            partial_release_percentage: 0,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M2"),
            percentage: 40,
            released: false,
            partial_release_percentage: 0,
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
        client.release_milestone(&client_addr, &job_id, &0u32, &100u32);

        let job = client.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::PartiallyReleased);
        assert!(job.milestones.get(0).unwrap().released);
        assert!(!job.milestones.get(1).unwrap().released);

        // Release second milestone -> Completed
        client.release_milestone(&client_addr, &job_id, &1u32, &100u32);
        let job2 = client.get_job(&job_id).unwrap();
        assert_eq!(job2.status, JobStatus::Completed);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Partial milestone release (#441)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_partial_release_50pct() {
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
        let job_id = String::from_str(&env, "job-partial-50");

        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 40));
        milestones.push_back(make_milestone(&env, "M2", 60));

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        // 50% of a 40%-of-job milestone = 20% of the total 1000 -> 200.
        client.release_milestone(&client_addr, &job_id, &0u32, &50u32);

        let job = client.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::PartiallyReleased);
        let m0 = job.milestones.get(0).unwrap();
        assert_eq!(m0.partial_release_percentage, 50);
        assert!(!m0.released);

        let token_client = soroban_sdk::token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&freelancer), 200i128);
    }

    #[test]
    fn test_partial_release_then_remaining() {
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
        let job_id = String::from_str(&env, "job-partial-then-remaining");

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

        client.release_milestone(&client_addr, &job_id, &0u32, &50u32);
        let mid = client.get_job(&job_id).unwrap();
        assert_eq!(mid.status, JobStatus::PartiallyReleased);
        assert!(!mid.milestones.get(0).unwrap().released);

        // Releasing the remaining 50% completes the milestone (and the job,
        // since it is the only milestone).
        client.release_milestone(&client_addr, &job_id, &0u32, &50u32);
        let done = client.get_job(&job_id).unwrap();
        assert_eq!(done.status, JobStatus::Completed);
        let m0 = done.milestones.get(0).unwrap();
        assert!(m0.released);
        assert_eq!(m0.partial_release_percentage, 100);

        let token_client = soroban_sdk::token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&freelancer), 1000i128);
    }

    #[test]
    #[should_panic(expected = "release_pct exceeds remaining milestone percentage")]
    fn test_partial_release_exceeds_100_panics() {
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
        let job_id = String::from_str(&env, "job-partial-exceeds");

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

        client.release_milestone(&client_addr, &job_id, &0u32, &60u32);
        // 60 + 50 = 110 > 100 -> must panic.
        client.release_milestone(&client_addr, &job_id, &0u32, &50u32);
    }

    #[test]
    #[should_panic(expected = "release_pct must be greater than 0")]
    fn test_partial_release_zero_pct_panics() {
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
        let job_id = String::from_str(&env, "job-partial-zero");

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

        client.release_milestone(&client_addr, &job_id, &0u32, &0u32);
    }

    #[test]
    fn test_partial_release_compute_remaining() {
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
        let job_id = String::from_str(&env, "job-partial-remaining-funds");

        let mut milestones = Vec::new(&env);
        milestones.push_back(make_milestone(&env, "M1", 60));
        milestones.push_back(make_milestone(&env, "M2", 40));

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );

        // Release 50% of the 60%-of-job milestone -> 300 already paid out.
        client.release_milestone(&client_addr, &job_id, &0u32, &50u32);

        // Dispute the whole job and resolve in the freelancer's favor:
        // `resolve_dispute` pays out `compute_remaining_funds`, which must
        // exclude the 300 already released and only send the remaining 700.
        client.dispute_job(&signers1(&env, &admin), &job_id);
        client.resolve_dispute(&signers1(&env, &admin), &job_id, &true);

        let token_client = soroban_sdk::token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&freelancer), 1000i128);
    }

    #[test]
    fn test_claim_after_partial_release() {
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
        let job_id = String::from_str(&env, "job-claim-after-partial");

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

        client.release_milestone(&client_addr, &job_id, &0u32, &40u32);

        env.ledger().set_sequence_number(RELEASE_AFTER_LEDGERS + 1);
        client.claim_milestone(&freelancer, &job_id, &0u32);

        let job = client.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Completed);
        let m0 = job.milestones.get(0).unwrap();
        assert!(m0.released);
        assert_eq!(m0.partial_release_percentage, 100);

        let token_client = soroban_sdk::token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&freelancer), 1000i128);
    }

    #[test]
    fn test_job_completed_only_at_full_release() {
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
        let job_id = String::from_str(&env, "job-completed-only-full");

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

        client.release_milestone(&client_addr, &job_id, &0u32, &50u32);
        assert_eq!(
            client.get_job(&job_id).unwrap().status,
            JobStatus::PartiallyReleased
        );

        // Milestone 0 reaches 100%, but milestone 1 hasn't been touched —
        // the job must still not be Completed.
        client.release_milestone(&client_addr, &job_id, &0u32, &50u32);
        let after_m0_full = client.get_job(&job_id).unwrap();
        assert_eq!(after_m0_full.status, JobStatus::PartiallyReleased);
        assert!(after_m0_full.milestones.get(0).unwrap().released);
        assert!(!after_m0_full.milestones.get(1).unwrap().released);

        client.release_milestone(&client_addr, &job_id, &1u32, &100u32);
        assert_eq!(
            client.get_job(&job_id).unwrap().status,
            JobStatus::Completed
        );
    }

    #[test]
    #[should_panic(expected = "Milestone already released")]
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
            partial_release_percentage: 0,
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
        client.release_milestone(&client_addr, &job_id, &0u32, &100u32);
        client.release_milestone(&client_addr, &job_id, &0u32, &100u32);
    }

    #[test]
    #[should_panic(expected = "Milestones must sum to 100%")]
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
            partial_release_percentage: 0,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M2"),
            percentage: 40,
            released: false,
            partial_release_percentage: 0,
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
    #[should_panic(expected = "Job not found")]
    fn release_missing_job_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);
        let addr = Address::generate(&env);
        client.release_milestone(
            &addr,
            &String::from_str(&env, "no-such-job"),
            &0u32,
            &100u32,
        );
    }

    #[test]
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
            partial_release_percentage: 0,
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
            partial_release_percentage: 0,
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
            partial_release_percentage: 0,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M2"),
            percentage: 50,
            released: false,
            partial_release_percentage: 0,
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
        client.release_milestone(&client_addr, &job_id, &0u32, &100u32);
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
            partial_release_percentage: 0,
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
    #[should_panic(expected = "Milestone already disputed")]
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
            partial_release_percentage: 0,
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
    #[should_panic(expected = "Milestone already released")]
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
            partial_release_percentage: 0,
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
        client.release_milestone(&client_addr, &job_id, &0u32, &100u32);
        client.dispute_milestone(&signers1(&env, &admin), &job_id, &0u32);
    }

    #[test]
    #[should_panic(expected = "Milestone is not disputed")]
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
            partial_release_percentage: 0,
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
            partial_release_percentage: 0,
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
    #[should_panic(expected = "Release period not reached")]
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
            partial_release_percentage: 0,
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
            partial_release_percentage: 0,
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
    #[should_panic(expected = "Job deadline has not passed")]
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
            partial_release_percentage: 0,
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
    #[should_panic(expected = "Only the client can request refund")]
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
            partial_release_percentage: 0,
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
    #[should_panic(expected = "milestones have been claimed")]
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
            partial_release_percentage: 0,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M2"),
            percentage: 50,
            released: false,
            partial_release_percentage: 0,
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
        client.release_milestone(&client_addr, &job_id, &0u32, &100u32);

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
        assert_eq!(client.get_job_ids().len(), 0);

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
            partial_release_percentage: 0,
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
        let ids = client.get_job_ids();
        assert_eq!(ids.len(), 2);
        assert_eq!(ids.get(0).unwrap(), job_1);
        assert_eq!(ids.get(1).unwrap(), job_2);
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
            partial_release_percentage: 0,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M2-Implementation"),
            percentage: 40,
            released: false,
            partial_release_percentage: 0,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M3-Deployment"),
            percentage: 30,
            released: false,
            partial_release_percentage: 0,
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
        client.release_milestone(&client_addr, &job_id, &2u32, &100u32);
        let job_final = client.get_job(&job_id).unwrap();
        assert_eq!(job_final.status, JobStatus::Completed);
    }

    fn make_milestone(env: &Env, name: &str, percentage: u32) -> Milestone {
        Milestone {
            name: String::from_str(env, name),
            percentage,
            released: false,
            partial_release_percentage: 0,
            disputed: false,
            oracle: None,
            verified: false,
            proof_hash: None,
        }
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
    #[should_panic(expected = "Amendment only allowed before any milestone is released")]
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
        client.release_milestone(&client_addr, &job_id, &0u32, &100u32);

        let mut new_milestones = Vec::new(&env);
        new_milestones.push_back(make_milestone(&env, "M1", 100));
        client.amend_job_milestones(&client_addr, &freelancer, &job_id, &new_milestones);
    }

    #[test]
    #[should_panic(expected = "Milestones must sum to 100%")]
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
    #[should_panic(expected = "Insufficient admin signatures")]
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
    #[should_panic(expected = "Insufficient admin signatures: 1/2 required")]
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
    #[should_panic(expected = "Release period not reached")]
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
    #[should_panic(expected = "release_after must be at least the minimum")]
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
    #[should_panic(expected = "New release_after must extend the current release period")]
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
    #[should_panic(expected = "Cannot remove last admin")]
    fn test_remove_last_admin_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);
        client.remove_admin(&signers1(&env, &admin), &admin);
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
                partial_release_percentage: 0,
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
            client.release_milestone(&client_addr, &job_id, &0u32, &100u32);

            let job = client.get_job(&job_id).unwrap();
            assert_eq!(job.status, JobStatus::Completed);
            assert!(job.milestones.get(0).unwrap().released);
        }

        #[test]
        #[should_panic(expected = "Milestone not verified by oracle")]
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
            client.release_milestone(&client_addr, &job_id, &0u32, &100u32);
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
            client.release_milestone(&client_addr, &job_id, &0u32, &100u32);

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
