/// Integration tests: claim
///
/// Coverage:
///   - Freelancer can claim a milestone after the release period (new)
///   - Claiming before the release period panics (new)
///   - Claiming on a disputed job panics (new)
///   - Claiming an already-released milestone panics (new)
///   - Claiming an invalid milestone index panics (new)
///   - Full claim flow transitions to Completed (new)
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, Env, String as SorobanString, Vec};

use escrow_contract::{EscrowContractClient, JobStatus};

mod common;

// ─────────────────────────────────────────────────────────────────────────────
// Claim tests (all new)
// ─────────────────────────────────────────────────────────────────────────────

/// Helper: jump the ledger forward past the release_after window.
fn jump_past_release_period(env: &Env) {
    let current = env.ledger().sequence();
    // release_after = current + RELEASE_AFTER_LEDGERS (10)
    // So we need to jump to at least current + 10 + 1
    env.ledger().set_sequence_number(current + 12);
}

#[test]
fn test_freelancer_can_claim_after_release_period() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-claim");
    let milestones = common::three_milestones(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
    );

    // Jump past the release period
    jump_past_release_period(&env);

    // Claim first milestone (50 %)
    client.claim_milestone(&freelancer, &job_id, &0u32);

    let job = client.get_job(&job_id).expect("Job should exist");
    assert_eq!(job.status, JobStatus::PartiallyReleased);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 500i128);
}

#[test]
#[should_panic(expected = "Release period not reached")]
fn test_claim_before_release_period_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-early-claim");
    let milestones = common::three_milestones(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
    );

    // Claim immediately without advancing ledger — should panic
    client.claim_milestone(&freelancer, &job_id, &0u32);
}

#[test]
#[should_panic(expected = "Job is disputed; cannot claim milestone")]
fn test_claim_disputed_job_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-dispute-claim");
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

    // Jump past release period
    jump_past_release_period(&env);

    // Claim while disputed — should panic
    client.claim_milestone(&freelancer, &job_id, &0u32);
}

#[test]
#[should_panic(expected = "Milestone already released")]
fn test_claim_already_released_milestone_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-reclaim");
    let milestones = common::three_milestones(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
    );

    jump_past_release_period(&env);

    // First claim succeeds
    client.claim_milestone(&freelancer, &job_id, &0u32);
    // Second claim of same milestone should panic
    client.claim_milestone(&freelancer, &job_id, &0u32);
}

#[test]
#[should_panic(expected = "Invalid milestone index")]
fn test_claim_invalid_milestone_index_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-bad-idx-claim");
    let milestones = common::three_milestones(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
    );

    jump_past_release_period(&env);

    // Index 3 is out of bounds
    client.claim_milestone(&freelancer, &job_id, &3u32);
}

#[test]
fn test_claim_all_milestones_completes_job() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-claim-all");
    let milestones = common::three_milestones(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
    );

    jump_past_release_period(&env);

    // Claim all three milestones
    client.claim_milestone(&freelancer, &job_id, &0u32);
    client.claim_milestone(&freelancer, &job_id, &1u32);
    client.claim_milestone(&freelancer, &job_id, &2u32);

    let job = client.get_job(&job_id).expect("Job should exist");
    assert_eq!(job.status, JobStatus::Completed);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 1000i128);
}

#[test]
#[should_panic(expected = "Job not found")]
fn test_claim_non_existent_job_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let freelancer = Address::generate(&env);
    let job_id = SorobanString::from_str(&env, "ghost-claim");

    jump_past_release_period(&env);
    client.claim_milestone(&freelancer, &job_id, &0u32);
}
