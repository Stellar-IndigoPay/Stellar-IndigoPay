/// Integration tests: multi-round dispute arbitration
///
/// Coverage:
///   - Full 3-round dispute flow (initiate → respond → surrebuttal → admin resolve)
///   - State and events verification at each step
///   - Admin resolution after timeout
///   - Backward compatibility with admin dispute_milestone path
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, BytesN, Env, String as SorobanString, Vec};

use escrow_contract::{
    DisputeStatus, EscrowContractClient, JobStatus, Milestone, DISPUTE_RESPONSE_WINDOW,
    MAX_DISPUTE_ROUNDS, RELEASE_AFTER_LEDGERS,
};

mod common;

/// Helper: create a job with a single 100% milestone.
fn create_single_milestone_job(
    env: &Env,
    client: &EscrowContractClient<'_>,
    client_addr: &Address,
    freelancer: &Address,
    token: &Address,
    job_id: &str,
    amount: i128,
) -> SorobanString {
    let s_id = SorobanString::from_str(env, job_id);
    let mut milestones = Vec::new(env);
    milestones.push_back(Milestone {
        name: SorobanString::from_str(env, "Full Delivery"),
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
        &s_id,
        token,
        &amount,
        &milestones,
        &RELEASE_AFTER_LEDGERS,
    );
    s_id
}

// ─────────────────────────────────────────────────────────────────────────────
// Full 3-round dispute flow
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_full_3_round_dispute_flow() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = create_single_milestone_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-3-round",
        1000i128,
    );

    // ── Step 1: Freelancer initiates dispute on milestone 0 ─────────────────
    let ev_freelancer = BytesN::from_array(&env, &[1u8; 32]);
    client.initiate_dispute(&freelancer, &job_id, &0u32, &ev_freelancer);

    // Verify state after initiation
    let job = client.get_job(&job_id).unwrap();
    assert_eq!(job.status, JobStatus::Disputed);
    assert!(job.milestones.get(0).unwrap().disputed);

    let dispute = client.get_dispute(&job_id, &0u32).expect("Dispute exists");
    assert_eq!(dispute.status, DisputeStatus::AwaitingResponse);
    assert_eq!(dispute.initiator, freelancer);
    assert_eq!(dispute.rounds.len(), 1);
    assert_eq!(dispute.rounds.get(0).unwrap().submitter, freelancer);
    assert_eq!(dispute.rounds.get(0).unwrap().evidence_hash, ev_freelancer);

    // Verify funds are still in contract
    assert_eq!(common::token_balance(&env, &token, &freelancer), 0i128);
    assert_eq!(common::token_balance(&env, &token, &client_addr), 0i128);

    // ── Step 2: Client responds with evidence ──────────────────────────────
    let ev_client = BytesN::from_array(&env, &[2u8; 32]);
    client.respond_to_dispute(&client_addr, &job_id, &0u32, &ev_client);

    let dispute = client.get_dispute(&job_id, &0u32).expect("Dispute exists");
    assert_eq!(dispute.rounds.len(), 2);
    assert_eq!(dispute.rounds.get(1).unwrap().submitter, client_addr);
    assert_eq!(dispute.rounds.get(1).unwrap().evidence_hash, ev_client);
    // Still awaiting response because rounds (2) < MAX_DISPUTE_ROUNDS (3)
    assert_eq!(dispute.status, DisputeStatus::AwaitingResponse);

    // ── Step 3: Freelancer surrebuts (round 3) ─────────────────────────────
    let ev_surrebuttal = BytesN::from_array(&env, &[3u8; 32]);
    client.respond_to_dispute(&freelancer, &job_id, &0u32, &ev_surrebuttal);

    let dispute = client.get_dispute(&job_id, &0u32).expect("Dispute exists");
    assert_eq!(dispute.rounds.len(), 3);
    assert_eq!(dispute.status, DisputeStatus::UnderReview);
    assert_eq!(
        dispute.rounds.get(2).unwrap().submitter,
        freelancer
    );
    assert_eq!(
        dispute.rounds.get(2).unwrap().evidence_hash,
        ev_surrebuttal
    );

    // ── Step 4: Admin resolves in freelancer's favor after all rounds ──────
    client.resolve_milestone_dispute(
        &common::signers1(&env, &admin),
        &job_id,
        &0u32,
        &true,
    );

    // Verify resolution
    let job = client.get_job(&job_id).unwrap();
    assert_eq!(job.status, JobStatus::Completed);
    assert!(job.milestones.get(0).unwrap().released);
    assert!(!job.milestones.get(0).unwrap().disputed);        // Dispute record should be preserved with Resolved status
        let resolved = client
            .get_dispute(&job_id, &0u32)
            .expect("Dispute record should persist after resolution");
        assert_eq!(resolved.status, escrow_contract::DisputeStatus::Resolved);
        assert_eq!(resolved.rounds.len(), 3);

    // Freelancer should receive the full amount
    assert_eq!(
        common::token_balance(&env, &token, &freelancer),
        1000i128,
        "Freelancer should receive 1000 XLM"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin resolution after timeout
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_admin_resolve_after_timeout() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = create_single_milestone_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-to-resolve",
        1000i128,
    );

    // Freelancer initiates (round 1)
    client.initiate_dispute(
        &freelancer,
        &job_id,
        &0u32,
        &BytesN::from_array(&env, &[1u8; 32]),
    );

    // Advance past response window
    let now = env.ledger().sequence();
    env.ledger()
        .set_sequence_number(now + DISPUTE_RESPONSE_WINDOW + 1);

    // Timeout the dispute
    client.timeout_dispute(&job_id, &0u32);

    // Admin can now resolve (because timeout has occurred)
    client.resolve_milestone_dispute(
        &common::signers1(&env, &admin),
        &job_id,
        &0u32,
        &true,
    );

    let job = client.get_job(&job_id).unwrap();
    assert_eq!(job.status, JobStatus::Completed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Backward compatibility: admin dispute_milestone path still works
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_admin_dispute_milestone_still_works() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = create_single_milestone_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-admin-legacy",
        1000i128,
    );

    // Admin uses the old dispute_milestone path (no dispute record created)
    client.dispute_milestone(&common::signers1(&env, &admin), &job_id, &0u32);

    // No dispute record exists (old path)
    assert!(client.get_dispute(&job_id, &0u32).is_none());

    // Admin can still resolve (backward compatible path — no dispute record
    // means the multi-round precondition is skipped)
    client.resolve_milestone_dispute(
        &common::signers1(&env, &admin),
        &job_id,
        &0u32,
        &true,
    );

    let job = client.get_job(&job_id).unwrap();
    assert_eq!(job.status, JobStatus::Completed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "No dispute found for this milestone")]
fn test_respond_to_nonexistent_dispute_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = create_single_milestone_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-no-disp",
        1000i128,
    );

    client.respond_to_dispute(
        &client_addr,
        &job_id,
        &0u32,
        &BytesN::from_array(&env, &[1u8; 32]),
    );
}

#[test]
#[should_panic(expected = "Response window has not yet elapsed")]
fn test_timeout_before_window_elapsed_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = create_single_milestone_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-early-to",
        1000i128,
    );

    client.initiate_dispute(
        &freelancer,
        &job_id,
        &0u32,
        &BytesN::from_array(&env, &[1u8; 32]),
    );

    // Try to timeout before window elapses — should panic
    client.timeout_dispute(&job_id, &0u32);
}

#[test]
fn test_max_rounds_transition_to_underreview() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = create_single_milestone_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-max-reached",
        1000i128,
    );

    // Fill all 3 rounds
    client.initiate_dispute(
        &freelancer,
        &job_id,
        &0u32,
        &BytesN::from_array(&env, &[1u8; 32]),
    );
    client.respond_to_dispute(
        &client_addr,
        &job_id,
        &0u32,
        &BytesN::from_array(&env, &[2u8; 32]),
    );

    // After round 2, status should be AwaitingResponse (since MAX_DISPUTE_ROUNDS=3)
    let dispute = client.get_dispute(&job_id, &0u32).unwrap();
    assert_eq!(dispute.status, DisputeStatus::AwaitingResponse);
    assert_eq!(dispute.rounds.len(), 2);

    // Round 3 (surrebuttal)
    client.respond_to_dispute(
        &freelancer,
        &job_id,
        &0u32,
        &BytesN::from_array(&env, &[3u8; 32]),
    );

    // After round 3, status should be UnderReview
    let dispute = client.get_dispute(&job_id, &0u32).unwrap();
    assert_eq!(dispute.status, DisputeStatus::UnderReview);
    assert_eq!(dispute.rounds.len(), MAX_DISPUTE_ROUNDS);
}
