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
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Env, String as SorobanString};

use escrow_contract::JobStatus;

mod common;

// ─────────────────────────────────────────────────────────────────────────────
// Existing tests migrated from lib.rs
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic]
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
        &escrow_contract::RELEASE_AFTER_LEDGERS,
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
        &escrow_contract::RELEASE_AFTER_LEDGERS,
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
        &escrow_contract::RELEASE_AFTER_LEDGERS,
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
#[should_panic]
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
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );

    // Impersonator tries to release — should panic
    client.release_milestone(&impersonator, &job_id, &0u32);
}

#[test]
#[should_panic]
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
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );

    // First release succeeds
    client.release_milestone(&client_addr, &job_id, &0u32);
    // Second release of same index should panic
    client.release_milestone(&client_addr, &job_id, &0u32);
}

#[test]
#[should_panic]
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
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );

    // Index 3 is out of bounds (0..=2 are valid)
    client.release_milestone(&client_addr, &job_id, &3u32);
}

#[test]
#[should_panic]
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
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );

    client.dispute_job(&common::signers1(&env, &admin), &job_id);

    // Attempt release while disputed → should panic
    client.release_milestone(&client_addr, &job_id, &0u32);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rounding-dust regression tests (GH issue: Escrow rounding-dust fix)
// ─────────────────────────────────────────────────────────────────────────────

use escrow_contract::Milestone;

fn make_milestone_pct(env: &Env, name: &str, pct: u32) -> Milestone {
    Milestone {
        name: SorobanString::from_str(env, name),
        percentage: pct,
        released: false,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    }
}

/// amount=101, milestones [50,50] — each truncates to 50; last must absorb the +1.
#[test]
fn test_no_dust_two_milestones_50_50_odd_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 101i128);

    let mut milestones = soroban_sdk::Vec::new(&env);
    milestones.push_back(make_milestone_pct(&env, "M1", 50));
    milestones.push_back(make_milestone_pct(&env, "M2", 50));

    let job_id = SorobanString::from_str(&env, "dust-50-50");
    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &101i128,
        &milestones,
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );

    // Release M1 (50 % of 101 = 50 truncated)
    client.release_milestone(&client_addr, &job_id, &0u32);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 50i128);

    // Release M2 (last milestone must absorb remainder: 101 - 50 = 51)
    client.release_milestone(&client_addr, &job_id, &1u32);
    assert_eq!(
        common::token_balance(&env, &token, &freelancer),
        101i128,
        "Freelancer must receive full job amount with no dust locked"
    );

    // Contract must hold zero balance for this token
    let contract_bal = common::token_balance(&env, &token, &client.address);
    assert_eq!(
        contract_bal, 0i128,
        "Contract must hold zero after full release"
    );
}

/// amount=101, milestones [33,33,34].
#[test]
fn test_no_dust_three_milestones_33_33_34_odd_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 101i128);

    let mut milestones = soroban_sdk::Vec::new(&env);
    milestones.push_back(make_milestone_pct(&env, "M1", 33));
    milestones.push_back(make_milestone_pct(&env, "M2", 33));
    milestones.push_back(make_milestone_pct(&env, "M3", 34));

    let job_id = SorobanString::from_str(&env, "dust-33-33-34");
    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &101i128,
        &milestones,
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );

    client.release_milestone(&client_addr, &job_id, &0u32); // 33
    client.release_milestone(&client_addr, &job_id, &1u32); // 33
    client.release_milestone(&client_addr, &job_id, &2u32); // last → 101-33-33=35

    assert_eq!(
        common::token_balance(&env, &token, &freelancer),
        101i128,
        "Full amount must reach freelancer"
    );
    assert_eq!(
        common::token_balance(&env, &token, &client.address),
        0i128,
        "Contract must hold zero after full release"
    );
}

/// amount=1, milestones [50,50] — extreme edge: each truncates to 0, last pays 1.
#[test]
fn test_no_dust_amount_one_50_50() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1i128);

    let mut milestones = soroban_sdk::Vec::new(&env);
    milestones.push_back(make_milestone_pct(&env, "M1", 50));
    milestones.push_back(make_milestone_pct(&env, "M2", 50));

    let job_id = SorobanString::from_str(&env, "dust-1-50-50");
    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1i128,
        &milestones,
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );

    // First milestone: 50% of 1 = 0 (truncated) — freelancer gets 0
    client.release_milestone(&client_addr, &job_id, &0u32);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 0i128);

    // Last milestone: must pay exact remainder (1 - 0 = 1)
    client.release_milestone(&client_addr, &job_id, &1u32);
    assert_eq!(
        common::token_balance(&env, &token, &freelancer),
        1i128,
        "Single stroop must reach freelancer"
    );
    assert_eq!(
        common::token_balance(&env, &token, &client.address),
        0i128,
        "Contract must hold zero"
    );
}

/// amount=101, claim path [50,50].
#[test]
fn test_no_dust_claim_50_50_odd_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 101i128);

    let mut milestones = soroban_sdk::Vec::new(&env);
    milestones.push_back(make_milestone_pct(&env, "M1", 50));
    milestones.push_back(make_milestone_pct(&env, "M2", 50));

    let job_id = SorobanString::from_str(&env, "claim-dust-50-50");
    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &101i128,
        &milestones,
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );

    // Jump past release period
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 12);

    client.claim_milestone(&freelancer, &job_id, &0u32);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 50i128);

    client.claim_milestone(&freelancer, &job_id, &1u32);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 101i128);
    assert_eq!(
        common::token_balance(&env, &token, &client.address),
        0i128,
        "Contract must hold zero after claim"
    );
}

/// get_remaining_funds returns exact residual, not truncated percentage sum.
#[test]
fn test_get_remaining_funds_exact() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 101i128);

    let mut milestones = soroban_sdk::Vec::new(&env);
    milestones.push_back(make_milestone_pct(&env, "M1", 50));
    milestones.push_back(make_milestone_pct(&env, "M2", 50));

    let job_id = SorobanString::from_str(&env, "remaining-funds-test");
    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &101i128,
        &milestones,
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );

    // Before any release: remaining = 101
    assert_eq!(client.get_remaining_funds(&job_id), Some(101i128));

    // After first release (50 stroops paid): remaining = 51
    client.release_milestone(&client_addr, &job_id, &0u32);
    assert_eq!(client.get_remaining_funds(&job_id), Some(51i128));

    // After final release: remaining = 0
    client.release_milestone(&client_addr, &job_id, &1u32);
    assert_eq!(client.get_remaining_funds(&job_id), Some(0i128));
}
