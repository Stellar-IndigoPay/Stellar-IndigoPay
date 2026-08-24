//! Integration tests: payout arithmetic at extreme amounts.
//!
//! Regression coverage for
//! <https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/616> and the
//! follow-up fix reviewed under
//! <https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/617>.
//!
//! `job.amount` is fully client-controlled at `create_job` (any positive
//! `i128`). A near-`i128::MAX` amount used to make the intermediate
//! `amount * percentage` product overflow, permanently locking funds behind a
//! structured `EscrowError`. The payout helper now splits `amount` into
//! quotient + remainder before scaling, so every valid job pays out exactly
//! (`floor(amount * percentage / 100)`) and the structured errors only fire
//! on genuine arithmetic failure.
//!
//! Coverage:
//!   - `release_milestone` at max amount     -> pays exactly, no error
//!   - `claim_milestone` at max amount       -> pays exactly, no error
//!   - `resolve_milestone_dispute` max amt   -> pays exactly, no error
//!   - `resolve_dispute` remaining funds     -> pays exactly, no error
//!   - `refund_expired_job` remaining funds  -> refunds exactly, no error
//!   - normal amounts and full-payout (100 %) milestones are unaffected

use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, ConversionError, Env, Error, InvokeError, String as SorobanString};

use escrow_contract::{
    EscrowContractClient, EscrowError, DEFAULT_DEADLINE_LEDGERS, RELEASE_AFTER_LEDGERS,
};

mod common;

/// Largest positive amount the contract accepts at `create_job`.
const MAX_AMOUNT: i128 = i128::MAX;

/// Reference implementation of the contract's payout math: exact
/// floor division decomposed as `(amount / 100) * proportion +
/// (amount % 100) * proportion / 100`, mirroring
/// `compute_proportional_payout` without any overflowing intermediate.
fn proportional(amount: i128, percentage: i128) -> i128 {
    (amount / 100) * percentage + (amount % 100) * percentage / 100
}

/// Sum of the 50/30/20 milestone payouts for `amount`.
fn three_milestone_total(amount: i128) -> i128 {
    proportional(amount, 50) + proportional(amount, 30) + proportional(amount, 20)
}

/// Assert that a `try_*` client call succeeded, and nothing else.
///
/// The generated `try_*` client methods return
/// `Result<Result<T, ConversionError>, Result<Error, InvokeError>>`. A
/// `panic_with_error!` in the contract surfaces as
/// `Err(Ok(Error::Contract(code)))`.
fn assert_ok(
    result: Result<Result<(), ConversionError>, Result<Error, InvokeError>>,
    context: &str,
) {
    match result {
        Ok(Ok(())) => {}
        Err(Ok(error)) => match EscrowError::try_from(&error) {
            Ok(err) => panic!("expected success for {context}, got contract error {err:?}"),
            Err(_) => panic!("expected success for {context}, got non-contract error {error:?}"),
        },
        other => panic!("expected success for {context}, got {other:?}"),
    }
}

/// Create a job funded with `i128::MAX` and three milestones (50/30/20).
fn create_max_job(
    env: &Env,
    client: &EscrowContractClient,
    client_addr: &Address,
    freelancer: &Address,
    token: &Address,
    job_id: &str,
) {
    common::fund(env, token, client_addr, MAX_AMOUNT);
    let milestones = common::three_milestones(env); // 50, 30, 20
    client.create_job(
        client_addr,
        freelancer,
        &SorobanString::from_str(env, job_id),
        token,
        &MAX_AMOUNT,
        &milestones,
        &RELEASE_AFTER_LEDGERS,
    );
}

/// Advance the ledger past the job's `release_after` window.
fn jump_past_release_period(env: &Env) {
    let current = env.ledger().sequence();
    env.ledger()
        .set_sequence_number(current + RELEASE_AFTER_LEDGERS + 2);
}

#[test]
fn test_release_milestone_max_amount_pays_exactly() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    let job_id = SorobanString::from_str(&env, "job-overflow-release");
    create_max_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-overflow-release",
    );

    // 50 % of i128::MAX must pay out exactly — the intermediate product never
    // materializes, so no funds are locked.
    let result = client.try_release_milestone(&client_addr, &job_id, &0u32);
    assert_ok(result, "release_milestone at max amount");

    assert_eq!(
        common::token_balance(&env, &token, &freelancer),
        proportional(MAX_AMOUNT, 50),
        "freelancer should receive exactly 50 % of i128::MAX"
    );
}

#[test]
fn test_claim_milestone_max_amount_pays_exactly() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    let job_id = SorobanString::from_str(&env, "job-overflow-claim");
    create_max_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-overflow-claim",
    );

    jump_past_release_period(&env);

    // 50 % of i128::MAX must auto-release exactly after the claim window.
    let result = client.try_claim_milestone(&freelancer, &job_id, &0u32);
    assert_ok(result, "claim_milestone at max amount");

    assert_eq!(
        common::token_balance(&env, &token, &freelancer),
        proportional(MAX_AMOUNT, 50),
        "freelancer should claim exactly 50 % of i128::MAX"
    );
}

#[test]
fn test_resolve_milestone_dispute_max_amount_pays_exactly() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    let job_id = SorobanString::from_str(&env, "job-overflow-ms-dispute");
    create_max_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-overflow-ms-dispute",
    );

    // Dispute the 50 % milestone, then resolve it (approve -> freelancer).
    client.dispute_milestone(&common::signers1(&env, &admin), &job_id, &0u32);

    let result = client.try_resolve_milestone_dispute(
        &common::signers1(&env, &admin),
        &job_id,
        &0u32,
        &true,
    );
    assert_ok(result, "resolve_milestone_dispute at max amount");

    assert_eq!(
        common::token_balance(&env, &token, &freelancer),
        proportional(MAX_AMOUNT, 50),
        "approved freelancer should receive exactly 50 % of i128::MAX"
    );
}

#[test]
fn test_resolve_dispute_remaining_funds_pay_exactly() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    let job_id = SorobanString::from_str(&env, "job-overflow-resolve");
    create_max_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-overflow-resolve",
    );

    // Dispute the whole job so `resolve_dispute` computes the unreleased
    // portion (all three milestones of an i128::MAX job) and pays it out.
    client.dispute_job(&common::signers1(&env, &admin), &job_id);

    let result = client.try_resolve_dispute(&common::signers1(&env, &admin), &job_id, &true);
    assert_ok(result, "resolve_dispute remaining funds at max amount");

    assert_eq!(
        common::token_balance(&env, &token, &freelancer),
        three_milestone_total(MAX_AMOUNT),
        "approved freelancer should receive the full remaining payout"
    );
}

#[test]
fn test_refund_expired_job_remaining_funds_pay_exactly() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    let job_id = SorobanString::from_str(&env, "job-overflow-refund");
    create_max_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-overflow-refund",
    );

    // Fast-forward past the job deadline so the client can request a refund.
    let current = env.ledger().sequence();
    env.ledger()
        .set_sequence_number(current + DEFAULT_DEADLINE_LEDGERS + 10);

    let result = client.try_refund_expired_job(&client_addr, &job_id);
    assert_ok(result, "refund_expired_job remaining funds at max amount");

    assert_eq!(
        common::token_balance(&env, &token, &client_addr),
        three_milestone_total(MAX_AMOUNT),
        "client should be refunded the full remaining payout"
    );
}

/// Sanity check that the payout math does not reject legitimate amounts:
/// a normal 1000-unit job still releases and pays out correctly.
#[test]
fn test_normal_amounts_are_unaffected() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-normal");
    let milestones = common::three_milestones(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
        &RELEASE_AFTER_LEDGERS,
    );

    client.release_milestone(&client_addr, &job_id, &0u32);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 500i128);

    client.release_milestone(&client_addr, &job_id, &1u32);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 800i128);

    client.release_milestone(&client_addr, &job_id, &2u32);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 1000i128);
}

/// A full-payout job (a single 100 % milestone) funded with `i128::MAX` is
/// short-circuited and still pays the full amount — the payout math only
/// scales partial percentages, never the tautological `amount * 100 / 100`.
#[test]
fn test_full_payout_single_milestone_of_max_amount_pays() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, MAX_AMOUNT);

    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "job-max-full",
        MAX_AMOUNT,
    );
    let job_id = SorobanString::from_str(&env, "job-max-full");

    // A 100 % milestone is short-circuited to return `amount` directly (no
    // intermediate multiplication), so the full amount is released.
    client.release_milestone(&client_addr, &job_id, &0u32);
    assert_eq!(
        common::token_balance(&env, &token, &freelancer),
        MAX_AMOUNT,
        "full i128::MAX should be released for a single 100 % milestone"
    );
}
