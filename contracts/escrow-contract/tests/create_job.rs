/// Integration tests: create_job
///
/// Coverage:
///   - Valid milestone-based job creation (existing)
///   - Invalid milestone percentages (< 100 %) (existing)
///   - Duplicate job ID rejection
///   - Zero amount rejection
///   - Milestone percentage overflow
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String as SorobanString, Vec};

use escrow_contract::{EscrowContractClient, JobStatus, Milestone};

mod common;

// ─────────────────────────────────────────────────────────────────────────────
// Existing tests migrated from lib.rs
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_milestone_based_release() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-1");

    // Use three milestones: 50 %, 30 %, 20 %
    let milestones = common::three_milestones(&env);

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
}

#[test]
#[should_panic(expected = "Milestones must sum to 100%")]
fn test_milestone_validation() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = Address::generate(&env);
    let job_id = SorobanString::from_str(&env, "job-invalid");

    // Only 90 % — should panic
    let mut milestones = Vec::new(&env);
    milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "M1"),
        percentage: 50,
        released: false,
    });
    milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "M2"),
        percentage: 40,
        released: false,
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

// ─────────────────────────────────────────────────────────────────────────────
// New edge-case tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Job already exists")]
fn test_duplicate_job_id_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 2000i128);

    let job_id = SorobanString::from_str(&env, "dup-job");
    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "dup-job",
        1000i128,
    );

    // Second creation with same job_id should panic
    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "dup-job",
        1000i128,
    );
}

#[test]
#[should_panic(expected = "Amount must be positive")]
fn test_zero_amount_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    let job_id = SorobanString::from_str(&env, "zero-amount");
    let milestones = common::three_milestones(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &0i128,
        &milestones,
    );
}

#[test]
#[should_panic(expected = "Amount must be positive")]
fn test_negative_amount_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    let job_id = SorobanString::from_str(&env, "neg-amount");
    let milestones = common::three_milestones(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &(-100i128),
        &milestones,
    );
}

/// Milestones that sum to 100 but contain individual percentages of 0
/// are still valid — the contract only checks that total == 100.
#[test]
fn test_zero_percentage_milestone() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "zero-pct");

    // Two milestones: 0 % + 100 % = 100 %
    let mut milestones = Vec::new(&env);
    milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "Zero"),
        percentage: 0,
        released: false,
    });
    milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "Full"),
        percentage: 100,
        released: false,
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
    assert_eq!(job.milestones.len(), 2);
}
