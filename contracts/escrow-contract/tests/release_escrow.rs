/// Integration tests: release_escrow
///
/// Coverage:
///   - Releasing on a non-existent job panics (existing)
///   - Proportional payout (new)
///   - Partial release transitions status to PartiallyReleased (new)
///   - Full release transitions status to Completed (new)
///   - Only the client can release (new)
///   - Releasing an already-released milestone panics (new)
///   - Releasing on a disputed job panics (new)
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String as SorobanString, Vec};

use escrow_contract::{EscrowContractClient, JobStatus};

mod common;

// ─────────────────────────────────────────────────────────────────────────────
// Existing tests migrated from lib.rs
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Job not found")]
fn release_missing_job_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);
    let addr = Address::generate(&env);
    client.release_milestone(&addr, &SorobanString::from_str(&env, "no-such-job"), &0u32);
}

// ─────────────────────────────────────────────────────────────────────────────
// New tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_milestone_release_pays_proportional_amount() {
    let env = Env::default();
    env.mock_all_auths();

    let (_admin, client) = common::setup(&env);
    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);

    let job_id = SorobanString::from_str(&env, "job-prop");
    let milestones = common::three_milestones(&env); // 50, 30, 20
    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
    );

    // Release milestone 0 (50 %)
    client.release_milestone(&client_addr, &job_id, &0u32);
    // freelancer should have 500
    let bal = common::token_balance(&env, &token, &freelancer);
    assert_eq!(
        bal, 500i128,
        "Freelancer should have 500 after first milestone"
    );

    // Release milestone 1 (30 %)
    client.release_milestone(&client_addr, &job_id, &1u32);
    let bal = common::token_balance(&env, &token, &freelancer);
    assert_eq!(
        bal, 800i128,
        "Freelancer should have 800 after second milestone"
    );

    // Release milestone 2 (20 %) → 1000 total
    client.release_milestone(&client_addr, &job_id, &2u32);
    let bal = common::token_balance(&env, &token, &freelancer);
    assert_eq!(
        bal, 1000i128,
        "Freelancer should have 1000 after all milestones"
    );
}

#[test]
fn test_partial_release_updates_status() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-partial");
    let milestones = common::three_milestones(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
    );
    assert_eq!(client.get_job(&job_id).unwrap().status, JobStatus::Escrowed);

    // Release one milestone → status becomes PartiallyReleased
    client.release_milestone(&client_addr, &job_id, &0u32);
    assert_eq!(
        client.get_job(&job_id).unwrap().status,
        JobStatus::PartiallyReleased
    );
}

#[test]
fn test_full_release_completes_job() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-full");
    let milestones = common::three_milestones(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
    );

    // Release all three milestones
    client.release_milestone(&client_addr, &job_id, &0u32);
    client.release_milestone(&client_addr, &job_id, &1u32);
    client.release_milestone(&client_addr, &job_id, &2u32);

    assert_eq!(
        client.get_job(&job_id).unwrap().status,
        JobStatus::Completed
    );
}

#[test]
#[should_panic(expected = "Only the client can release")]
fn test_only_client_can_release() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let impersonator = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-auth");
    let milestones = common::three_milestones(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
    );

    // Impersonator tries to release — should panic
    client.release_milestone(&impersonator, &job_id, &0u32);
}

#[test]
#[should_panic(expected = "Milestone already released")]
fn test_release_already_released_milestone_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-re-release");
    let milestones = common::three_milestones(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
    );

    // First release succeeds
    client.release_milestone(&client_addr, &job_id, &0u32);
    // Second release of same index should panic
    client.release_milestone(&client_addr, &job_id, &0u32);
}

#[test]
#[should_panic(expected = "Invalid milestone index")]
fn test_invalid_milestone_index_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-bad-idx");
    let milestones = common::three_milestones(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
    );

    // Index 3 is out of bounds (0..=2 are valid)
    client.release_milestone(&client_addr, &job_id, &3u32);
}

#[test]
#[should_panic(expected = "Job is disputed; admin must resolve")]
fn test_release_disputed_job_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-disputed-rel");
    let milestones = common::three_milestones(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
    );

    client.dispute_job(&admin, &job_id);

    // Attempt release while disputed → should panic
    client.release_milestone(&client_addr, &job_id, &0u32);
}
