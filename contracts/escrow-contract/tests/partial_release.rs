/// Integration tests: partial milestone release (#441)
///
/// Coverage:
///   - Create a job with 3 milestones, partially release each one across
///     multiple calls, and verify proportional transfers at every step.
///   - `release_milestone_partial` alias behaves identically to
///     `release_milestone`.
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, Env, String as SorobanString};

use escrow_contract::JobStatus;

mod common;

#[test]
fn test_partial_release_across_three_milestones() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);

    let job_id = SorobanString::from_str(&env, "job-partial-3ms");
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

    // Milestone 0 is 50% of the job (500). Release it in two steps: 25% then
    // the remaining 75%.
    client.release_milestone(&client_addr, &job_id, &0u32, &25u32);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 125i128);
    let job = client.get_job(&job_id).unwrap();
    assert_eq!(job.status, JobStatus::PartiallyReleased);
    assert!(!job.milestones.get(0).unwrap().released);

    client.release_milestone(&client_addr, &job_id, &0u32, &75u32);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 500i128);
    assert!(
        client
            .get_job(&job_id)
            .unwrap()
            .milestones
            .get(0)
            .unwrap()
            .released
    );

    // Milestone 1 is 30% of the job (300). Release via the explicit
    // `release_milestone_partial` alias, in three uneven steps.
    client.release_milestone_partial(&client_addr, &job_id, &1u32, &10u32);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 530i128);
    client.release_milestone_partial(&client_addr, &job_id, &1u32, &40u32);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 650i128);
    client.release_milestone_partial(&client_addr, &job_id, &1u32, &50u32);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 800i128);
    assert!(
        client
            .get_job(&job_id)
            .unwrap()
            .milestones
            .get(1)
            .unwrap()
            .released
    );

    // Job still not complete: milestone 2 (20% = 200) is untouched.
    assert_eq!(
        client.get_job(&job_id).unwrap().status,
        JobStatus::PartiallyReleased
    );

    // Fully release milestone 2 in a single call (release_pct = 100).
    client.release_milestone(&client_addr, &job_id, &2u32, &100u32);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 1000i128);

    let final_job = client.get_job(&job_id).unwrap();
    assert_eq!(final_job.status, JobStatus::Completed);
    assert!(final_job.milestones.iter().all(|m| m.released));
}

#[test]
fn test_partial_release_then_claim_remaining_after_period() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);

    let job_id = SorobanString::from_str(&env, "job-partial-then-claim");
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

    // Client partially releases milestone 2 (20% = 200) by 30%: 60 total.
    client.release_milestone(&client_addr, &job_id, &2u32, &30u32);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 60i128);

    // After the release period, the freelancer claims the rest of milestone 2.
    let current = env.ledger().sequence();
    env.ledger()
        .set_sequence_number(current + escrow_contract::RELEASE_AFTER_LEDGERS + 1);
    client.claim_milestone(&freelancer, &job_id, &2u32);

    // 60 (partial release) + 140 (remaining 70% of 200) = 200.
    assert_eq!(common::token_balance(&env, &token, &freelancer), 200i128);
    assert!(
        client
            .get_job(&job_id)
            .unwrap()
            .milestones
            .get(2)
            .unwrap()
            .released
    );
}
