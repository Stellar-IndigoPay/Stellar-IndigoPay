#![no_std]
#![allow(deprecated)]

//! Escrow contract with milestone-based fund release.
//! Client locks funds with `create_job`, then releases them per milestone.

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Env, String, Vec,
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
    Admin,
    JobCount,
    JobIds,
}

pub const RELEASE_AFTER_LEDGERS: u32 = 10;
pub const DEFAULT_DEADLINE_LEDGERS: u32 = 1_555_200; // 90 days @ 5s/ledger

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

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Initialize contract with admin address.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        if !env.storage().instance().has(&DataKey::JobCount) {
            env.storage().instance().set(&DataKey::JobCount, &0u32);
        }
        if !env.storage().instance().has(&DataKey::JobIds) {
            let ids: Vec<String> = Vec::new(&env);
            env.storage().instance().set(&DataKey::JobIds, &ids);
        }
    }

    /// Client funds escrow with milestones: transfers `amount` of `token` from client into this contract.
    pub fn create_job(
        env: Env,
        client: Address,
        freelancer: Address,
        job_id: String,
        token: Address,
        amount: i128,
        milestones: Vec<Milestone>,
    ) {
        client.require_auth();
        if amount <= 0 {
            panic!("Amount must be positive");
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
            release_after: env.ledger().sequence() + RELEASE_AFTER_LEDGERS,
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

    /// Admin-only (deprecated): Mark a job as disputed, freezing remaining releases.
    #[deprecated]
    pub fn dispute_job(env: Env, admin: Address, job_id: String) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if stored_admin != admin {
            panic!("Only admin can dispute jobs");
        }

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

        env.events()
            .publish((symbol_short!("job_disp"), admin), job_id);
    }

    /// Admin-only (deprecated): Resolve a dispute and release remaining funds.
    #[deprecated]
    pub fn resolve_dispute(env: Env, admin: Address, job_id: String, approve_remaining: bool) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if stored_admin != admin {
            panic!("Only admin can resolve disputes");
        }

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
            (symbol_short!("job_reslv"), admin),
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

    /// Admin-only: Dispute a single milestone without freezing non-disputed milestones.
    pub fn dispute_milestone(env: Env, admin: Address, job_id: String, milestone_index: u32) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if stored_admin != admin {
            panic!("Only admin can dispute milestones");
        }

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
        milestones.set(milestone_index, milestone);
        job.milestones = milestones;
        job.status = JobStatus::Disputed;

        env.storage()
            .instance()
            .set(&DataKey::Job(job_id.clone()), &job);

        env.events()
            .publish((symbol_short!("ms_disp"), admin), (job_id, milestone_index));
    }

    /// Admin-only: Resolve a single milestone dispute.
    /// If `approve` is true -> release funds for that milestone to freelancer.
    /// If `approve` is false -> refund funds for that milestone to client.
    pub fn resolve_milestone_dispute(
        env: Env,
        admin: Address,
        job_id: String,
        milestone_index: u32,
        approve: bool,
    ) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        if stored_admin != admin {
            panic!("Only admin can resolve milestone disputes");
        }

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
            (symbol_short!("ms_reslv"), admin),
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

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::token::StellarAssetClient;
    use soroban_sdk::{Address, Env, String, Vec};

    fn setup(env: &Env) -> (Address, EscrowContractClient<'_>) {
        let cid = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(env, &cid);
        let admin = Address::generate(env);
        client.initialize(&admin);
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
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "Development"),
            percentage: 30,
            released: false,
            disputed: false,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "Testing"),
            percentage: 20,
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
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M2"),
            percentage: 40,
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
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
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
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M2"),
            percentage: 40,
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
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
        );

        client.dispute_job(&admin, &job_id);

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
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
        );
        client.dispute_job(&admin, &job_id);
        client.resolve_dispute(&admin, &job_id, &true);

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
            &1000i128,
            &milestones,
        );

        // Dispute milestone 1 only
        client.dispute_milestone(&admin, &job_id, &1u32);
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
        client.resolve_milestone_dispute(&admin, &job_id, &1u32, &true);
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
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
        );
        client.dispute_milestone(&admin, &job_id, &0u32);
        client.resolve_milestone_dispute(&admin, &job_id, &0u32, &false);

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
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
        );
        client.dispute_milestone(&admin, &job_id, &0u32);
        client.dispute_milestone(&admin, &job_id, &0u32);
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
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
        );
        client.release_milestone(&client_addr, &job_id, &0u32);
        client.dispute_milestone(&admin, &job_id, &0u32);
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
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
        );
        client.resolve_milestone_dispute(&admin, &job_id, &0u32, &true);
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
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
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
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
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
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
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
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
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
        });

        client.create_job(
            &client_addr,
            &freelancer,
            &job_id,
            &token,
            &1000i128,
            &milestones,
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
            &1000i128,
            &milestones,
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
        );
        client.create_job(
            &client_addr,
            &freelancer,
            &job_2,
            &token,
            &1000i128,
            &milestones,
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
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M2-Implementation"),
            percentage: 40,
            released: false,
            disputed: false,
        });
        milestones.push_back(Milestone {
            name: String::from_str(&env, "M3-Deployment"),
            percentage: 30,
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

        // 2. Freelancer claims Milestone 1 after release period
        env.ledger().set_sequence_number(RELEASE_AFTER_LEDGERS + 1);
        client.claim_milestone(&freelancer, &job_id, &0u32);

        let job = client.get_job(&job_id).unwrap();
        assert_eq!(job.status, JobStatus::PartiallyReleased);
        assert!(job.milestones.get(0).unwrap().released);

        // 3. Admin disputes Milestone 2
        client.dispute_milestone(&admin, &job_id, &1u32);
        let job_disputed = client.get_job(&job_id).unwrap();
        assert_eq!(job_disputed.status, JobStatus::Disputed);

        // 4. Admin resolves Milestone 2 dispute in favor of freelancer
        client.resolve_milestone_dispute(&admin, &job_id, &1u32, &true);
        let job_resolved = client.get_job(&job_id).unwrap();
        assert_eq!(job_resolved.status, JobStatus::PartiallyReleased);
        assert!(job_resolved.milestones.get(1).unwrap().released);

        // 5. Client releases Milestone 3
        client.release_milestone(&client_addr, &job_id, &2u32);
        let job_final = client.get_job(&job_id).unwrap();
        assert_eq!(job_final.status, JobStatus::Completed);
    }
}
