/// Integration tests: multi-token support
///
/// Coverage:
///   - Job created with USDC token → funded with USDC → milestones released in USDC
///   - Job created with XLM (existing behavior) → works unchanged
///   - Dispute resolution returns correct token
///   - Two jobs with different tokens do not interfere
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, Env, String as SorobanString, Vec};

use escrow_contract::{EscrowContractClient, JobStatus, Milestone};

mod common;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers specific to multi-token tests
// ─────────────────────────────────────────────────────────────────────────────

/// Jump the ledger past the escrow release_after window so the freelancer
/// can claim milestones.
fn jump_past_release_period(env: &Env) {
    let current = env.ledger().sequence();
    env.ledger().set_sequence_number(current + 12); // RELEASE_AFTER_LEDGERS = 10
}

// ─────────────────────────────────────────────────────────────────────────────
// USDC-specific lifecycle tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_create_job_with_usdc() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let usdc = common::create_token(&env);
    common::fund(&env, &usdc, &client_addr, 5000i128);

    let job_id = SorobanString::from_str(&env, "usdc-job-create");
    let milestones = common::three_milestones(&env); // 50 %, 30 %, 20 %

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &usdc,
        &5000i128,
        &milestones,
    );

    let job = client.get_job(&job_id).expect("USDC job should exist");
    assert_eq!(job.status, JobStatus::Escrowed);
    assert_eq!(job.token, usdc, "Job must store the USDC token address");
    assert_eq!(job.amount, 5000i128);
    assert_eq!(job.milestones.len(), 3);
    assert_eq!(job.client, client_addr);
    assert_eq!(job.freelancer, freelancer);

    // Verify the USDC was transferred from client to escrow contract
    let client_balance = common::token_balance(&env, &usdc, &client_addr);
    assert_eq!(
        client_balance, 0i128,
        "Client should have 0 USDC after funding the escrow"
    );
}

#[test]
fn test_release_milestone_usdc() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let usdc = common::create_token(&env);
    common::fund(&env, &usdc, &client_addr, 10_000i128);

    let job_id = SorobanString::from_str(&env, "usdc-job-release");
    let milestones = common::three_milestones(&env); // 50, 30, 20

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &usdc,
        &10_000i128,
        &milestones,
    );

    // Release milestone 0 (50 % of 10_000 = 5_000 USDC)
    client.release_milestone(&client_addr, &job_id, &0u32);
    let bal = common::token_balance(&env, &usdc, &freelancer);
    assert_eq!(
        bal, 5_000i128,
        "Freelancer should receive 5_000 USDC after first milestone"
    );

    let job = client.get_job(&job_id).unwrap();
    assert_eq!(job.status, JobStatus::PartiallyReleased);
    assert!(job.milestones.get(0).unwrap().released);

    // Release milestone 1 (30 % = 3_000)  →  8_000 USDC total
    client.release_milestone(&client_addr, &job_id, &1u32);
    let bal = common::token_balance(&env, &usdc, &freelancer);
    assert_eq!(
        bal, 8_000i128,
        "Freelancer should have 8_000 USDC after second milestone"
    );

    // Release milestone 2 (20 % = 2_000)  →  10_000 USDC total — Completed
    client.release_milestone(&client_addr, &job_id, &2u32);
    let bal = common::token_balance(&env, &usdc, &freelancer);
    assert_eq!(
        bal, 10_000i128,
        "Freelancer should have all 10_000 USDC after final milestone"
    );

    let job = client.get_job(&job_id).unwrap();
    assert_eq!(job.status, JobStatus::Completed);
    assert!(job.milestones.iter().all(|m| m.released));
}

#[test]
fn test_claim_milestone_usdc() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let usdc = common::create_token(&env);
    common::fund(&env, &usdc, &client_addr, 7_500i128);

    let job_id = SorobanString::from_str(&env, "usdc-job-claim");

    // Two milestones: 40 % + 60 %
    let mut milestones = Vec::new(&env);
    milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "Phase 1"),
        percentage: 40,
        released: false,
        disputed: false,
    });
    milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "Phase 2"),
        percentage: 60,
        released: false,
        disputed: false,
    });

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &usdc,
        &7_500i128,
        &milestones,
    );

    // Advance past the release period
    jump_past_release_period(&env);

    // Claim milestone 0 (40 % of 7_500 = 3_000 USDC)
    client.claim_milestone(&freelancer, &job_id, &0u32);
    let bal = common::token_balance(&env, &usdc, &freelancer);
    assert_eq!(
        bal, 3_000i128,
        "Freelancer should receive 3_000 USDC after claiming first milestone"
    );

    let job = client.get_job(&job_id).unwrap();
    assert_eq!(job.status, JobStatus::PartiallyReleased);
    assert!(job.milestones.get(0).unwrap().released);

    // Claim milestone 1 (60 % = 4_500) → 7_500 total — Completed
    client.claim_milestone(&freelancer, &job_id, &1u32);
    let bal = common::token_balance(&env, &usdc, &freelancer);
    assert_eq!(
        bal, 7_500i128,
        "Freelancer should have all 7_500 USDC after claiming all milestones"
    );

    let job = client.get_job(&job_id).unwrap();
    assert_eq!(job.status, JobStatus::Completed);
}

#[test]
fn test_refund_usdc_job() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let usdc = common::create_token(&env);
    common::fund(&env, &usdc, &client_addr, 2_000i128);

    let job_id = SorobanString::from_str(&env, "usdc-job-refund");

    // Single milestone, 100 %
    let mut milestones = Vec::new(&env);
    milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "Full Delivery"),
        percentage: 100,
        released: false,
        disputed: false,
    });

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &usdc,
        &2_000i128,
        &milestones,
    );

    // Fast-forward past the job deadline
    let current = env.ledger().sequence();
    env.ledger()
        .set_sequence_number(current + escrow_contract::DEFAULT_DEADLINE_LEDGERS + 10);

    // Client refunds the expired job
    client.refund_expired_job(&client_addr, &job_id);

    let job = client.get_job(&job_id).unwrap();
    assert_eq!(job.status, JobStatus::Completed);

    // Client should have all USDC back
    let client_balance = common::token_balance(&env, &usdc, &client_addr);
    assert_eq!(
        client_balance, 2_000i128,
        "Client should receive full 2_000 USDC refund on expired job"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-token isolation tests
// ─────────────────────────────────────────────────────────────────────────────

/// Prove that two jobs using different tokens do NOT interfere with each
/// other.  This is the canonical "no cross-token leakage" invariant.
#[test]
fn test_two_jobs_different_tokens_isolated() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);

    // Token A = "XLM"  (the default token helper)
    let token_xlm = common::create_token(&env);
    common::fund(&env, &token_xlm, &client_addr, 10_000i128);

    // Token B = "USDC" (a second distinct token)
    let token_usdc = common::create_token(&env);
    common::fund(&env, &token_usdc, &client_addr, 10_000i128);

    // ── Job 1: XLM, 1_000 total, single milestone ──
    let job_xlm = SorobanString::from_str(&env, "job-xlm");
    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token_xlm,
        "job-xlm",
        1_000i128,
    );

    // ── Job 2: USDC, 2_000 total, single milestone ──
    let job_usdc = SorobanString::from_str(&env, "job-usdc");
    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token_usdc,
        "job-usdc",
        2_000i128,
    );

    // Release the XLM job → freelancer gets 1_000 XLM, 0 USDC
    client.release_milestone(&client_addr, &job_xlm, &0u32);
    assert_eq!(
        common::token_balance(&env, &token_xlm, &freelancer),
        1_000i128,
        "Freelancer should have 1_000 XLM"
    );
    assert_eq!(
        common::token_balance(&env, &token_usdc, &freelancer),
        0i128,
        "Freelancer should have 0 USDC after XLM-only release"
    );

    // Release the USDC job → freelancer gets 2_000 USDC, XLM stays at 1_000
    client.release_milestone(&client_addr, &job_usdc, &0u32);
    assert_eq!(
        common::token_balance(&env, &token_xlm, &freelancer),
        1_000i128,
        "XLM balance should be unchanged after USDC release"
    );
    assert_eq!(
        common::token_balance(&env, &token_usdc, &freelancer),
        2_000i128,
        "Freelancer should have 2_000 USDC after USDC release"
    );
}

/// Dispute resolution on a USDC job must return USDC (not XLM).
#[test]
fn test_dispute_resolution_usdc() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let usdc = common::create_token(&env);
    common::fund(&env, &usdc, &client_addr, 5_000i128);

    let job_id = SorobanString::from_str(&env, "usdc-dispute");

    // Single milestone: 100 % of 5_000 USDC
    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &usdc,
        "usdc-dispute",
        5_000i128,
    );

    // Dispute and resolve (approve) → freelancer gets all 5_000 USDC
    client.dispute_job(&admin, &job_id);
    client.resolve_dispute(&admin, &job_id, &true);

    let job = client.get_job(&job_id).unwrap();
    assert_eq!(job.status, JobStatus::Completed);
    assert!(!job.disputed);

    let bal = common::token_balance(&env, &usdc, &freelancer);
    assert_eq!(
        bal, 5_000i128,
        "Freelancer should receive 5_000 USDC after dispute resolution"
    );
}

/// Full lifecycle integration: create USDC job, claim some milestones,
/// refund another, and verify the resulting balances.
#[test]
fn test_usdc_full_lifecycle_integration() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let usdc = common::create_token(&env);
    common::fund(&env, &usdc, &client_addr, 10_000i128);

    let job_id = SorobanString::from_str(&env, "usdc-lifecycle");
    let milestones = common::three_milestones(&env); // 50, 30, 20

    // 1. Create job with 10_000 USDC
    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &usdc,
        &10_000i128,
        &milestones,
    );
    assert_eq!(client.get_job(&job_id).unwrap().status, JobStatus::Escrowed);

    // 2. Freelancer claims milestone 0 (50 % = 5_000) after release period
    jump_past_release_period(&env);
    client.claim_milestone(&freelancer, &job_id, &0u32);
    assert_eq!(common::token_balance(&env, &usdc, &freelancer), 5_000i128);
    assert_eq!(
        client.get_job(&job_id).unwrap().status,
        JobStatus::PartiallyReleased
    );

    // 3. Client releases milestone 1 (30 % = 3_000)
    client.release_milestone(&client_addr, &job_id, &1u32);
    assert_eq!(common::token_balance(&env, &usdc, &freelancer), 8_000i128);

    // 4. Freelancer claims milestone 2 (20 % = 2_000) → Completed
    client.claim_milestone(&freelancer, &job_id, &2u32);
    let job = client.get_job(&job_id).unwrap();
    assert_eq!(job.status, JobStatus::Completed);
    assert_eq!(common::token_balance(&env, &usdc, &freelancer), 10_000i128);

    // 5. Verify all milestones are released
    assert!(job.milestones.iter().all(|m| m.released));
}
