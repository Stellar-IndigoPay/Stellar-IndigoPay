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
#[derive(Clone, Debug, PartialEq)]
pub enum DisputeStatus {
    Open,
    AwaitingResponse,
    UnderReview,
    Resolved,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct DisputeRound {
    pub submitter: Address,
    pub evidence_hash: BytesN<32>,
    pub submitted_at: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Dispute {
    pub milestone_index: u32,
    pub initiator: Address,
    pub initiated_at: u32,
    pub rounds: Vec<DisputeRound>,
    pub status: DisputeStatus,
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
    Dispute(String, u32),
}

/// Minimum number of ledgers a job's release period may specify. Jobs
/// cannot request a shorter freelancer auto-claim window than this; it is
/// a floor, not a default — callers must pass their own `release_after`
/// to `create_job`.
pub const RELEASE_AFTER_LEDGERS: u32 = 10;
pub const DEFAULT_DEADLINE_LEDGERS: u32 = 1_555_200; // 90 days @ 5s/ledger
pub const MAX_DISPUTE_ROUNDS: u32 = 3;
pub const DISPUTE_RESPONSE_WINDOW: u32 = 100; // ledgers

fn compute_remaining_funds(job: &Job) -> i128 {
    let mut remaining_amount: i128 = 0;
    for milestone in job.milestones.iter() {
        if !milestone.released {
            let proportion = milestone.percentage as i128;
            remaining_amount = remaining_amount
                .checked_add((job.amount * proportion) / 100i128)
                .expect("remaining_amount overflow");
        }
    }
    remaining_amount
}

fn dispute_ready_for_resolution(dispute: &Dispute) -> bool {
    dispute.status == DisputeStatus::UnderReview || dispute.rounds.len() >= 2
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
            if milestone.released || milestone.disputed {
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

    /// Client releases a specific milestone. Pays proportional XLM to freelancer.
    pub fn release_milestone(env: Env, client: Address, job_id: String, milestone_index: u32) {
        client.require_auth();
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

        let proportion = milestone.percentage as i128;
        let release_amount = (job.amount * proportion) / 100i128;

        // ── Effects: rebuild the milestone vector, recompute status,
        //    and persist state BEFORE the external token movement (CEI ordering).
        let mut updated_milestones = job.milestones.clone();
        let mut released_count = 0u32;
        for i in 0..updated_milestones.len() {
            let mut m = updated_milestones.get(i).unwrap().clone();
            if i == milestone_index {
                m.released = true;
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
            (job_id, milestone_index, release_amount),
        );

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

    /// Party-initiated dispute with evidence. Client or freelancer initiates
    /// a multi-round dispute protocol for a specific milestone.
    pub fn initiate_dispute(
        env: Env,
        initiator: Address,
        job_id: String,
        milestone_index: u32,
        evidence_hash: BytesN<32>,
    ) {
        initiator.require_auth();

        let mut job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .expect("Job not found");

        if initiator != job.client && initiator != job.freelancer {
            panic!("Only client or freelancer can initiate dispute");
        }

        if milestone_index >= job.milestones.len() {
            panic!("Invalid milestone index");
        }

        if env
            .storage()
            .instance()
            .has(&DataKey::Dispute(job_id.clone(), milestone_index))
        {
            panic!("Active dispute already exists for this milestone");
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
        milestones.set(milestone_index, milestone);
        job.milestones = milestones;
        job.status = JobStatus::Disputed;

        let seq = env.ledger().sequence();
        let mut rounds = Vec::new(&env);
        rounds.push_back(DisputeRound {
            submitter: initiator.clone(),
            evidence_hash,
            submitted_at: seq,
        });

        let dispute = Dispute {
            milestone_index,
            initiator: initiator.clone(),
            initiated_at: seq,
            rounds,
            status: DisputeStatus::AwaitingResponse,
        };

        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);
        env.storage().instance().set(
            &DataKey::Dispute(job_id.clone(), milestone_index),
            &dispute,
        );

        env.events()
            .publish((symbol_short!("dsp_init"), initiator), (job_id, milestone_index));
    }

    /// The other party responds to a dispute with evidence.
    pub fn respond_to_dispute(
        env: Env,
        responder: Address,
        job_id: String,
        milestone_index: u32,
        evidence_hash: BytesN<32>,
    ) {
        responder.require_auth();

        let mut dispute: Dispute = env
            .storage()
            .instance()
            .get(&DataKey::Dispute(job_id.clone(), milestone_index))
            .expect("No active dispute for this milestone");

        if dispute.status == DisputeStatus::Resolved {
            panic!("Dispute already resolved");
        }
        if dispute.status == DisputeStatus::UnderReview {
            panic!("Dispute is under review");
        }

        let last_submitter = dispute
            .rounds
            .get(dispute.rounds.len() - 1)
            .unwrap()
            .submitter
            .clone();
        if responder == last_submitter {
            panic!("Cannot respond to your own submission");
        }

        let job: Job = env
            .storage()
            .instance()
            .get(&DataKey::Job(job_id.clone()))
            .expect("Job not found");
        if responder != job.client && responder != job.freelancer {
            panic!("Only client or freelancer can respond to dispute");
        }

        if dispute.rounds.len() >= MAX_DISPUTE_ROUNDS {
            panic!("Maximum dispute rounds reached");
        }

        dispute.rounds.push_back(DisputeRound {
            submitter: responder,
            evidence_hash,
            submitted_at: env.ledger().sequence(),
        });

        if dispute.rounds.len() >= MAX_DISPUTE_ROUNDS {
            dispute.status = DisputeStatus::UnderReview;
        } else {
            dispute.status = DisputeStatus::AwaitingResponse;
        }

        env.storage().instance().set(
            &DataKey::Dispute(job_id.clone(), milestone_index),
            &dispute,
        );

        env.events().publish(
            (symbol_short!("dsp_resp"), responder),
            (job_id, milestone_index, dispute.rounds.len()),
        );
    }

    /// Anyone can timeout a dispute if responder doesn't respond within window.
    pub fn timeout_dispute(env: Env, job_id: String, milestone_index: u32) {
        let mut dispute: Dispute = env
            .storage()
            .instance()
            .get(&DataKey::Dispute(job_id.clone(), milestone_index))
            .expect("No active dispute for this milestone");

        if dispute.status != DisputeStatus::AwaitingResponse {
            panic!("Dispute is not awaiting response");
        }

        let last_round = dispute
            .rounds
            .get(dispute.rounds.len() - 1)
            .unwrap();
        let elapsed = env
            .ledger()
            .sequence()
            .checked_sub(last_round.submitted_at)
            .expect("Ledger sequence went backwards");

        if elapsed < DISPUTE_RESPONSE_WINDOW {
            panic!("Response window has not elapsed");
        }

        dispute.status = DisputeStatus::UnderReview;

        env.storage().instance().set(
            &DataKey::Dispute(job_id.clone(), milestone_index),
            &dispute,
        );

        env.events()
            .publish((symbol_short!("dsp_tout"),), (job_id, milestone_index));
    }

    /// Admin-only: Resolve a single milestone dispute.
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

        // If a multi-round Dispute record exists, it must be UnderReview.
        if let Some(dispute) = env.storage().instance().get::<DataKey, Dispute>(
            &DataKey::Dispute(job_id.clone(), milestone_index),
        ) {
            if dispute.status == DisputeStatus::Resolved {
                panic!("Dispute already resolved");
            }
            if !dispute_ready_for_resolution(&dispute) {
                panic!("Dispute is not ready for resolution");
            }
            let mut resolved_dispute = dispute;
            resolved_dispute.status = DisputeStatus::Resolved;
            env.storage().instance().set(
                &DataKey::Dispute(job_id.clone(), milestone_index),
                &resolved_dispute,
            );
        }

        let proportion = milestone.percentage as i128;
        let release_amount = (job.amount * proportion) / 100i128;

        milestone.disputed = false;
        milestone.released = true;
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

        let any_claimed = job.milestones.iter().any(|m| m.released);
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

    /// Freelancer can claim a milestone after release_after ledgers if not disputed.
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
        let proportion = milestone.percentage as i128;
        let release_amount = (job.amount * proportion) / 100i128;

        // ── Effects: mark milestone released and update status BEFORE
        //    the external token transfer (CEI ordering).
        let mut updated_milestones = job.milestones.clone();
        let mut m = updated_milestones.get(milestone_index).unwrap().clone();
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

    pub fn get_dispute(env: Env, job_id: String, milestone_index: u32) -> Option<Dispute> {
        env.storage()
            .instance()
            .get(&DataKey::Dispute(job_id, milestone_index))
    }

    pub fn get_dispute_history(
        env: Env,
        job_id: String,
        milestone_index: u32,
    ) -> Option<Vec<DisputeRound>> {
        env.storage()
            .instance()
            .get::<DataKey, Dispute>(&DataKey::Dispute(job_id, milestone_index))
            .map(|dispute| dispute.rounds)
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
    #[should_panic(expected = "Job not found")]
    fn release_missing_job_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);
        let addr = Address::generate(&env);
        client.release_milestone(&addr, &String::from_str(&env, "no-such-job"), &0u32);
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

    #[test]
    fn test_initiate_dispute() {
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
        let job_id = String::from_str(&env, "job-dsp-init");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
        });
        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
        );

        let evidence = BytesN::from_array(&env, &[1u8; 32]);
        client.initiate_dispute(&client_addr, &job_id, &0u32, &evidence);

        let job = client.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::Disputed);
        assert!(job.milestones.get(0).unwrap().disputed);

        let dispute = client.get_dispute(&job_id, &0u32).unwrap();
        assert_eq!(dispute.initiator, client_addr);
        assert_eq!(dispute.status, DisputeStatus::AwaitingResponse);
        assert_eq!(dispute.rounds.len(), 1);
    }

    #[test]
    fn test_respond_to_dispute() {
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
        let job_id = String::from_str(&env, "job-dsp-resp");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
        });
        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
        );

        let evidence1 = BytesN::from_array(&env, &[1u8; 32]);
        let evidence2 = BytesN::from_array(&env, &[2u8; 32]);
        client.initiate_dispute(&client_addr, &job_id, &0u32, &evidence1);
        client.respond_to_dispute(&freelancer, &job_id, &0u32, &evidence2);

        let dispute = client.get_dispute(&job_id, &0u32).unwrap();
        assert_eq!(dispute.rounds.len(), 2);
        assert_eq!(dispute.status, DisputeStatus::AwaitingResponse);
    }

    #[test]
    fn test_resolve_after_rounds() {
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
        let job_id = String::from_str(&env, "job-dsp-resolve");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
        });
        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
        );

        let evidence1 = BytesN::from_array(&env, &[1u8; 32]);
        let evidence2 = BytesN::from_array(&env, &[2u8; 32]);
        let evidence3 = BytesN::from_array(&env, &[3u8; 32]);

        // Round 1: client initiates
        client.initiate_dispute(&client_addr, &job_id, &0u32, &evidence1);
        // Round 2: freelancer responds
        client.respond_to_dispute(&freelancer, &job_id, &0u32, &evidence2);
        // Round 3: client surrebuttal (hits MAX_DISPUTE_ROUNDS)
        client.respond_to_dispute(&client_addr, &job_id, &0u32, &evidence3);

        let dispute = client.get_dispute(&job_id, &0u32).unwrap();
        assert_eq!(dispute.status, DisputeStatus::UnderReview);
        assert_eq!(dispute.rounds.len(), 3);

        // Admin resolves in favor of freelancer
        client.resolve_milestone_dispute(&admin, &job_id, &0u32, &true);

        let job = client.get_job(&job_id).unwrap();
        assert!(job.milestones.get(0).unwrap().released);
        assert!(!job.milestones.get(0).unwrap().disputed);

        let dispute = client.get_dispute(&job_id, &0u32).unwrap();
        assert_eq!(dispute.status, DisputeStatus::Resolved);

        let bal = StellarAssetClient::new(&env, &token).balance(&freelancer);
        assert_eq!(bal, 1000i128);
    }

    #[test]
    fn test_timeout_dispute() {
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
        let job_id = String::from_str(&env, "job-dsp-timeout");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
        });
        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
        );

        let evidence1 = BytesN::from_array(&env, &[1u8; 32]);
        client.initiate_dispute(&client_addr, &job_id, &0u32, &evidence1);

        // Advance past response window
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + DISPUTE_RESPONSE_WINDOW);

        client.timeout_dispute(&job_id, &0u32);

        let dispute = client.get_dispute(&job_id, &0u32).unwrap();
        assert_eq!(dispute.status, DisputeStatus::UnderReview);

        // Admin can now resolve
        client.resolve_milestone_dispute(&admin, &job_id, &0u32, &false);
        let job = client.get_job(&job_id).unwrap();
        assert!(job.milestones.get(0).unwrap().released);
    }

    #[test]
    #[should_panic(expected = "Maximum dispute rounds reached")]
    fn test_max_rounds_enforced() {
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
        let job_id = String::from_str(&env, "job-dsp-max");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
        });
        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
        );

        let e1 = BytesN::from_array(&env, &[1u8; 32]);
        let e2 = BytesN::from_array(&env, &[2u8; 32]);
        let e3 = BytesN::from_array(&env, &[3u8; 32]);
        let e4 = BytesN::from_array(&env, &[4u8; 32]);

        // 3 rounds fills MAX_DISPUTE_ROUNDS
        client.initiate_dispute(&client_addr, &job_id, &0u32, &e1);
        client.respond_to_dispute(&freelancer, &job_id, &0u32, &e2);
        client.respond_to_dispute(&client_addr, &job_id, &0u32, &e3);

        // 4th round should panic
        client.respond_to_dispute(&freelancer, &job_id, &0u32, &e4);
    }

    #[test]
    fn test_dispute_history() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &2000i128);
        let job_id = String::from_str(&env, "job-dsp-hist");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 50,
            released: false,
            disputed: false,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M2"),
            percentage: 50,
            released: false,
            disputed: false,
        });
        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &2000i128,
            &milestones,
        );

        // No disputes yet
        assert!(client.get_dispute(&job_id, &0u32).is_none());
        assert!(client.get_dispute(&job_id, &1u32).is_none());

        // Initiate dispute on milestone 0
        let e1 = BytesN::from_array(&env, &[10u8; 32]);
        client.initiate_dispute(&client_addr, &job_id, &0u32, &e1);

        let d0 = client.get_dispute(&job_id, &0u32).unwrap();
        assert_eq!(d0.milestone_index, 0);
        assert_eq!(d0.initiator, client_addr);
        assert_eq!(d0.rounds.len(), 1);

        // Milestone 1 still has no dispute
        assert!(client.get_dispute(&job_id, &1u32).is_none());
    }

    #[test]
    #[should_panic(expected = "Only client or freelancer can initiate dispute")]
    fn test_non_party_cannot_initiate_dispute() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let stranger = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(&env, &token).mint(&client_addr, &1000i128);
        let job_id = String::from_str(&env, "job-dsp-stranger");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
        });
        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
        );

        let evidence = BytesN::from_array(&env, &[1u8; 32]);
        client.initiate_dispute(&stranger, &job_id, &0u32, &evidence);
    }

    #[test]
    #[should_panic(expected = "Cannot respond to your own submission")]
    fn test_cannot_respond_to_own_submission() {
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
        let job_id = String::from_str(&env, "job-dsp-self");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
        });
        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
        );

        let e1 = BytesN::from_array(&env, &[1u8; 32]);
        let e2 = BytesN::from_array(&env, &[2u8; 32]);
        client.initiate_dispute(&client_addr, &job_id, &0u32, &e1);
        // Client tries to respond to their own dispute
        client.respond_to_dispute(&client_addr, &job_id, &0u32, &e2);
    }

    #[test]
    #[should_panic(expected = "Response window has not elapsed")]
    fn test_timeout_too_early_panics() {
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
        let job_id = String::from_str(&env, "job-dsp-early-timeout");

        let mut milestones = Vec::new(&env);
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M1"),
            percentage: 100,
            released: false,
            disputed: false,
        });
        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
        );

        let evidence = BytesN::from_array(&env, &[1u8; 32]);
        client.initiate_dispute(&client_addr, &job_id, &0u32, &evidence);

        // Try timeout immediately (window not elapsed)
        client.timeout_dispute(&job_id, &0u32);
    }
}
