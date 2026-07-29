/// Integration tests: amend_job_milestones
///
/// Coverage:
///   - Create job, amend milestones, release the amended milestones, verify payouts.
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String as SorobanString, Vec};

use escrow_contract::{JobStatus, Milestone};

mod common;

#[test]
fn test_create_amend_then_release_new_milestones() {
    let env = Env::default();
    env.mock_all_auths();

    let (_admin, client) = common::setup(&env);
    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);

    let job_id = SorobanString::from_str(&env, "job-amend-integration");
    let milestones = common::three_milestones(&env); // 50, 30, 20

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );

    // Client and freelancer agree to reallocate: split the 50% Design
    // milestone into two smaller milestones, keep the rest the same.
    let mut new_milestones: Vec<Milestone> = Vec::new(&env);
    new_milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "Design-Wireframes"),
        percentage: 20,
        released: false,
        partial_release_percentage: 0,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });
    new_milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "Design-Visuals"),
        percentage: 30,
        released: false,
        partial_release_percentage: 0,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });
    new_milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "Development"),
        percentage: 30,
        released: false,
        partial_release_percentage: 0,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });
    new_milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "Testing"),
        percentage: 20,
        released: false,
        partial_release_percentage: 0,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });

    client.amend_job_milestones(&client_addr, &freelancer, &job_id, &new_milestones);

    let amended_job = client.get_job(&job_id).unwrap();
    assert_eq!(amended_job.amount, 1000i128);
    assert_eq!(amended_job.status, JobStatus::Escrowed);
    assert_eq!(amended_job.milestones.len(), 4);
    assert_eq!(client.get_job_amendment_count(&job_id), 1);

    // Release the new milestones and verify proportional payouts against the
    // *original* locked amount (1000), confirming the amendment reallocated
    // percentages without moving any additional funds.
    client.release_milestone(&client_addr, &job_id, &0u32, &100u32); // Design-Wireframes 20%
    assert_eq!(common::token_balance(&env, &token, &freelancer), 200i128);

    client.release_milestone(&client_addr, &job_id, &1u32, &100u32); // Design-Visuals 30%
    assert_eq!(common::token_balance(&env, &token, &freelancer), 500i128);

    client.release_milestone(&client_addr, &job_id, &2u32, &100u32); // Development 30%
    assert_eq!(common::token_balance(&env, &token, &freelancer), 800i128);

    client.release_milestone(&client_addr, &job_id, &3u32, &100u32); // Testing 20%
    let final_job = client.get_job(&job_id).unwrap();
    assert_eq!(final_job.status, JobStatus::Completed);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 1000i128);
}

#[test]
#[should_panic(expected = "Amendment only allowed before any milestone is released")]
fn test_amend_after_release_panics_integration() {
    let env = Env::default();
    env.mock_all_auths();

    let (_admin, client) = common::setup(&env);
    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);

    let job_id = SorobanString::from_str(&env, "job-amend-after-release");
    let milestones = common::three_milestones(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );
    client.release_milestone(&client_addr, &job_id, &0u32, &100u32);

    let mut new_milestones: Vec<Milestone> = Vec::new(&env);
    new_milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "Whole thing"),
        percentage: 100,
        released: false,
        partial_release_percentage: 0,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });
    client.amend_job_milestones(&client_addr, &freelancer, &job_id, &new_milestones);
}
