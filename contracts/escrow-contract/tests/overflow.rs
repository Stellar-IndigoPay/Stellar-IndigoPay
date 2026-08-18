//! Integration tests: payout arithmetic overflow protection.
//!
//! Regression coverage for
//! <https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/616>.
//!
//! `job.amount` is fully client-controlled at `create_job` (any positive
//! `i128`). A near-`i128::MAX` amount makes the intermediate
//! `amount * percentage` product overflow. The contract must surface a
//! structured `EscrowError` (via `panic_with_error!`) instead of silently
//! wrapping to a small payout while the full amount stays locked.
//!
//! Coverage:
//!   - `release_milestone` overflow          -> `ReleaseAmountCalculationFailed`
//!   - `claim_milestone` overflow            -> `ClaimAmountCalculationFailed`
//!   - `resolve_milestone_dispute` overflow  -> `ReleaseAmountCalculationFailed`
//!   - `resolve_dispute` remaining-funds     -> `ReleaseAmountCalculationFailed`
//!   - `refund_expired_job` remaining-funds  -> `RefundAmountCalculationFailed`
//!   - normal amounts and full-payout (100 %) milestones are unaffected
#![allow(deprecated)]

use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, ConversionError, Env, Error, InvokeError, String as SorobanString};

use escrow_contract::{
    EscrowContractClient, EscrowError, DEFAULT_DEADLINE_LEDGERS, RELEASE_AFTER_LEDGERS,
};

mod common;

/// Largest positive amount the contract accepts at `create_job`.
const MAX_AMOUNT: i128 = i128::MAX;

/// Assert that a `try_*` client call failed with the expected contract error,
/// and nothing else.
///
/// The generated `try_*` client methods return
/// `Result<Result<T, ConversionError>, Result<Error, InvokeError>>`. A
/// `panic_with_error!` in the contract surfaces as
/// `Err(Ok(Error::Contract(code)))`, which is converted back into the typed
/// [`EscrowError`] and compared for an exact match.
fn assert_contract_error(
    result: Result<Result<(), ConversionError>, Result<Error, InvokeError>>,
    expected: EscrowError,
    context: &str,
) {
    match result {
        Err(Ok(error)) => match EscrowError::try_from(&error) {
            Ok(err) => assert_eq!(err, expected, "unexpected contract error for {context}"),
            Err(_) => panic!(
                "expected contract error {expected:?} for {context}, got non-contract error {error:?}"
            ),
        },
        other => panic!("expected contract error {expected:?} for {context}, got {other:?}"),
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
fn test_release_milestone_overflow_returns_structured_error() {
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

    // 50 % of i128::MAX overflows the intermediate multiplication.
    let result = client.try_release_milestone(&client_addr, &job_id, &0u32);
    assert_contract_error(
        result,
        EscrowError::ReleaseAmountCalculationFailed,
        "release_milestone overflow",
    );
}

#[test]
fn test_claim_milestone_overflow_returns_structured_error() {
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

    // 50 % of i128::MAX overflows the intermediate multiplication.
    let result = client.try_claim_milestone(&freelancer, &job_id, &0u32);
    assert_contract_error(
        result,
        EscrowError::ClaimAmountCalculationFailed,
        "claim_milestone overflow",
    );
}

#[test]
fn test_resolve_milestone_dispute_overflow_returns_structured_error() {
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
    assert_contract_error(
        result,
        EscrowError::ReleaseAmountCalculationFailed,
        "resolve_milestone_dispute overflow",
    );
}

#[test]
fn test_resolve_dispute_remaining_funds_overflow_returns_structured_error() {
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
    // portion (100 % of i128::MAX, whose first 50 % milestone overflows).
    client.dispute_job(&common::signers1(&env, &admin), &job_id);

    let result = client.try_resolve_dispute(&common::signers1(&env, &admin), &job_id, &true);
    assert_contract_error(
        result,
        EscrowError::ReleaseAmountCalculationFailed,
        "resolve_dispute remaining-funds overflow",
    );
}

#[test]
fn test_refund_expired_job_remaining_funds_overflow_returns_structured_error() {
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
    assert_contract_error(
        result,
        EscrowError::RefundAmountCalculationFailed,
        "refund_expired_job remaining-funds overflow",
    );
}

/// Sanity check that the overflow guard does not reject legitimate amounts:
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
/// short-circuited and still pays the full amount — the overflow guard only
/// trips on genuine intermediate overflow, not on the tautological
/// `amount * 100 / 100` full-payout case.
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
