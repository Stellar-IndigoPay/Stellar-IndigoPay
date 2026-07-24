/// Integration tests: dispute
///
/// Coverage:
///   - Dispute freezes further releases (existing)
///   - Resolve dispute — approve remaining funds to freelancer (new)
///   - Resolve dispute — refund remaining funds to client (new)
///   - Resolving a non-disputed job panics (new)
///   - Non-admin cannot dispute (new)
///   - Non-admin cannot resolve (new)
///   - Dispute on non-existent job panics (new)
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, BytesN, Env, String as SorobanString, Vec};

use escrow_contract::{DisputeStatus, EscrowContractClient, JobStatus};

mod common;

// ─────────────────────────────────────────────────────────────────────────────
// Existing tests migrated from lib.rs
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_dispute_freezes_release() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-dispute");

    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-dispute",
        1000i128,
    );

    // Dispute the job
    client.dispute_job(&admin, &job_id);

    let job = client.get_job(&job_id).expect("Job should exist");
    assert_eq!(job.status, JobStatus::Disputed);
    assert!(job.disputed);
}

// ─────────────────────────────────────────────────────────────────────────────
// New tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_resolve_dispute_approve_remaining() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-resolve-approve");

    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-resolve-approve",
        1000i128,
    );

    // Dispute then resolve: approve remaining to freelancer
    client.dispute_job(&admin, &job_id);
    client.resolve_dispute(&admin, &job_id, &true);

    let job = client.get_job(&job_id).expect("Job should exist");
    assert_eq!(job.status, JobStatus::Completed);
    assert!(!job.disputed);

    // Freelancer should have received the full 1000
    let bal = common::token_balance(&env, &token, &freelancer);
    assert_eq!(
        bal, 1000i128,
        "Freelancer should receive all funds on approve resolution"
    );
}

#[test]
fn test_resolve_dispute_refund_client() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-resolve-refund");

    // Use multi-milestone so we can release one first, then dispute the rest
    let mut milestones = Vec::new(&env);
    milestones.push_back(escrow_contract::Milestone {
        name: SorobanString::from_str(&env, "M1"),
        percentage: 50,
        released: false,
        disputed: false,
    });
    milestones.push_back(escrow_contract::Milestone {
        name: SorobanString::from_str(&env, "M2"),
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

    // Release first milestone (50 % = 500)
    client.release_milestone(&client_addr, &job_id, &0u32);

    // Dispute remaining 500
    client.dispute_job(&admin, &job_id);

    // Resolve: refund remaining to client
    client.resolve_dispute(&admin, &job_id, &false);

    let job = client.get_job(&job_id).expect("Job should exist");
    assert_eq!(job.status, JobStatus::Completed);
    assert!(!job.disputed);

    // Freelancer should have 500 (first milestone)
    assert_eq!(common::token_balance(&env, &token, &freelancer), 500i128);
    // Client should have 500 refunded
    assert_eq!(common::token_balance(&env, &token, &client_addr), 500i128);
}

#[test]
fn test_resolve_after_two_rounds() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-resolve-two-rounds");

    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-resolve-two-rounds",
        1000i128,
    );

    let initiator_hash = BytesN::from_array(&env, &[11u8; 32]);
    let response_hash = BytesN::from_array(&env, &[22u8; 32]);

    client.initiate_dispute(&client_addr, &job_id, &0u32, &initiator_hash);
    client.respond_to_dispute(&freelancer, &job_id, &0u32, &response_hash);

    let dispute = client.get_dispute(&job_id, &0u32).unwrap();
    assert_eq!(dispute.rounds.len(), 2);
    assert_eq!(dispute.rounds.get(0).unwrap().evidence_hash, initiator_hash);
    assert_eq!(dispute.rounds.get(1).unwrap().evidence_hash, response_hash);
    assert_eq!(dispute.status, DisputeStatus::AwaitingResponse);

    client.resolve_milestone_dispute(&admin, &job_id, &0u32, &true);

    let resolved_job = client.get_job(&job_id).unwrap();
    assert!(resolved_job.milestones.get(0).unwrap().released);
    assert_eq!(
        client.get_dispute(&job_id, &0u32).unwrap().status,
        DisputeStatus::Resolved
    );
}

#[test]
fn test_full_three_round_dispute_flow() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-three-round-flow");

    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-three-round-flow",
        1000i128,
    );

    let h1 = BytesN::from_array(&env, &[1u8; 32]);
    let h2 = BytesN::from_array(&env, &[2u8; 32]);
    let h3 = BytesN::from_array(&env, &[3u8; 32]);

    client.initiate_dispute(&client_addr, &job_id, &0u32, &h1);
    client.respond_to_dispute(&freelancer, &job_id, &0u32, &h2);
    client.respond_to_dispute(&client_addr, &job_id, &0u32, &h3);

    let dispute = client.get_dispute(&job_id, &0u32).unwrap();
    assert_eq!(dispute.rounds.len(), 3);
    assert_eq!(dispute.rounds.get(0).unwrap().evidence_hash, h1);
    assert_eq!(dispute.rounds.get(1).unwrap().evidence_hash, h2);
    assert_eq!(dispute.rounds.get(2).unwrap().evidence_hash, h3);
    assert_eq!(dispute.status, DisputeStatus::UnderReview);

    client.resolve_milestone_dispute(&admin, &job_id, &0u32, &false);

    let job = client.get_job(&job_id).unwrap();
    assert_eq!(job.status, JobStatus::Completed);
    assert!(!job.milestones.get(0).unwrap().disputed);
    assert!(job.milestones.get(0).unwrap().released);
}

#[test]
#[should_panic(expected = "Job is not disputed")]
fn test_resolve_non_disputed_job_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-not-disputed");

    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-not-disputed",
        1000i128,
    );

    // Resolve without disputing first — should panic
    client.resolve_dispute(&admin, &job_id, &true);
}

#[test]
#[should_panic(expected = "Only admin can dispute jobs")]
fn test_non_admin_cannot_dispute() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-bad-dispute");

    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-bad-dispute",
        1000i128,
    );

    // A non-admin address tries to dispute
    client.dispute_job(&client_addr, &job_id);
}

#[test]
#[should_panic(expected = "Only admin can resolve disputes")]
fn test_non_admin_cannot_resolve() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-bad-resolve");

    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-bad-resolve",
        1000i128,
    );

    client.dispute_job(&admin, &job_id);
    // Non-admin tries to resolve
    client.resolve_dispute(&freelancer, &job_id, &true);
}

#[test]
#[should_panic(expected = "Job not found")]
fn test_dispute_non_existent_job_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = common::setup(&env);

    let job_id = SorobanString::from_str(&env, "ghost-job");
    client.dispute_job(&admin, &job_id);
}
