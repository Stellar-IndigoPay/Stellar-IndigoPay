//! Integration tests: permissionless `cleanup_completed_jobs` storage GC.
//!
//! Coverage:
//!   - a Completed job past `deadline + GRACE_PERIOD` is archived: its `Job`
//!     entry is removed, it is dropped from `JobIds`, and `JobCount` drops
//!   - `FreelancerReputation` is preserved across archival
//!   - in-flight jobs (Escrowed / PartiallyReleased / Disputed) are never removed
//!   - cleanup with nothing eligible panics with `NothingToCleanUp`
//!
//! Note: the escrow contract keeps every job in `env.storage().instance()`,
//! which Soroban serializes into a single 64 KiB-capped instance entry. That
//! hard platform limit is reached long before `MAX_JOBS = 256`, so this suite
//! exercises the mechanism with a storage-safe volume rather than a literal
//! 256-job fill.

use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, Env, String as SorobanString};

use escrow_contract::{
    EscrowError, JobStatus, GRACE_PERIOD, MAX_JOB_IDS_PAGE_SIZE, RELEASE_AFTER_LEDGERS,
};

mod common;

/// Verify an expired, completed job is archived while its in-flight siblings
/// survive, and that reputation history is untouched.
#[test]
fn cleanup_archives_expired_completed_jobs() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 2000i128);

    // One Escrowed (in-flight) job and one Completed job.
    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "in-flight",
        1000,
    );
    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "done",
        1000,
    );
    client.release_milestone(&client_addr, &SorobanString::from_str(&env, "done"), &0u32);
    assert_eq!(client.get_job_count(), 2);

    let rep_before = client.get_freelancer_reputation(&freelancer);

    // Fast-forward past deadline + grace for every job.
    let completed = client
        .get_job(&SorobanString::from_str(&env, "done"))
        .expect("completed job exists");
    env.ledger()
        .set_sequence_number(completed.deadline + GRACE_PERIOD + 1);

    let removed = client.cleanup_completed_jobs();
    assert_eq!(removed, 1);

    // Completed job archived; in-flight job survives.
    assert!(client
        .get_job(&SorobanString::from_str(&env, "done"))
        .is_none());
    assert!(client
        .get_job(&SorobanString::from_str(&env, "in-flight"))
        .is_some());
    assert_eq!(client.get_job_count(), 1);

    let ids = client.get_job_ids(&0, &MAX_JOB_IDS_PAGE_SIZE);
    assert_eq!(ids.len(), 1);
    assert_eq!(
        ids.get(0).unwrap(),
        SorobanString::from_str(&env, "in-flight")
    );

    // Reputation aggregate survives archival intact.
    let rep_after = client.get_freelancer_reputation(&freelancer);
    assert_eq!(rep_after, rep_before);
    assert_eq!(rep_after.completed_jobs, 1);
    assert_eq!(rep_after.total_jobs, 2);
}

/// Advance past every deadline + grace period on the current ledger, matching
/// a job whose deadline was `DEFAULT_DEADLINE_LEDGERS` after creation.
fn jump_past_grace_and_deadline(env: &Env, created_at: u32) {
    let start = created_at.saturating_add(GRACE_PERIOD + 1);
    env.ledger()
        .set_sequence_number(start + escrow_contract::DEFAULT_DEADLINE_LEDGERS + 1);
}

/// Ensure in-flight jobs (Escrowed / PartiallyReleased / Disputed) are never
/// removed, even when every deadline and grace period has elapsed.
#[test]
fn cleanup_keeps_in_flight_jobs() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 20_000i128);

    let created_at = env.ledger().sequence();

    // Escrowed.
    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "escrowed",
        1000,
    );
    // PartiallyReleased: two milestones, first released.
    client.create_job(
        &client_addr,
        &freelancer,
        &SorobanString::from_str(&env, "partial"),
        &token,
        &1000i128,
        &common::three_milestones(&env),
        &RELEASE_AFTER_LEDGERS,
    );
    client.release_milestone(
        &client_addr,
        &SorobanString::from_str(&env, "partial"),
        &0u32,
    );
    assert_eq!(
        client
            .get_job(&SorobanString::from_str(&env, "partial"))
            .unwrap()
            .status,
        JobStatus::PartiallyReleased
    );
    // Disputed.
    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "disputed",
        1000,
    );
    client.dispute_milestone(
        &common::signers1(&env, &admin),
        &SorobanString::from_str(&env, "disputed"),
        &0u32,
    );
    assert_eq!(
        client
            .get_job(&SorobanString::from_str(&env, "disputed"))
            .unwrap()
            .status,
        JobStatus::Disputed
    );

    // Fast-forward well past every deadline + grace. Nothing is Completed, so
    // cleanup panics with NothingToCleanUp and none of the in-flight jobs move.
    jump_past_grace_and_deadline(&env, created_at);
    match client.try_cleanup_completed_jobs() {
        Err(Ok(error)) => assert_eq!(
            EscrowError::try_from(&error).ok(),
            Some(EscrowError::NothingToCleanUp)
        ),
        other => panic!("expected NothingToCleanUp, got {other:?}"),
    }
    assert!(client
        .get_job(&SorobanString::from_str(&env, "escrowed"))
        .is_some());
    assert!(client
        .get_job(&SorobanString::from_str(&env, "partial"))
        .is_some());
    assert!(client
        .get_job(&SorobanString::from_str(&env, "disputed"))
        .is_some());
    assert_eq!(client.get_job_count(), 3);
}

/// Cleanup frees capacity: after archiving completed jobs, new jobs succeed.
#[test]
fn cleanup_frees_jobs_for_new_creation() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);

    const FILL: u32 = 20;
    common::fund(&env, &token, &client_addr, (FILL as i128 + 1) * 1000);

    let mut milestones = soroban_sdk::Vec::new(&env);
    milestones.push_back(milestone(&env, "M1", 50));
    milestones.push_back(milestone(&env, "M2", 50));

    let created_at = env.ledger().sequence();
    for i in 0..FILL {
        client.create_job(
            &client_addr,
            &freelancer,
            &SorobanString::from_str(&env, &format!("job-{i}")),
            &token,
            &1000i128,
            &milestones,
            &RELEASE_AFTER_LEDGERS,
        );
    }
    assert_eq!(client.get_job_count(), FILL);

    // Complete every job by releasing both milestones.
    for i in 0..FILL {
        client.release_milestone(
            &client_addr,
            &SorobanString::from_str(&env, &format!("job-{i}")),
            &0u32,
        );
        client.release_milestone(
            &client_addr,
            &SorobanString::from_str(&env, &format!("job-{i}")),
            &1u32,
        );
    }
    assert_eq!(client.get_job_count(), FILL);

    jump_past_grace_and_deadline(&env, created_at);

    let removed = client.cleanup_completed_jobs();
    assert_eq!(removed, FILL);
    assert_eq!(client.get_job_count(), 0);
    assert!(client.get_job_ids(&0, &MAX_JOB_IDS_PAGE_SIZE).is_empty());

    // Reclaimed storage allows brand-new jobs to be created.
    client.create_job(
        &client_addr,
        &freelancer,
        &SorobanString::from_str(&env, "post-cleanup"),
        &token,
        &1000i128,
        &milestones,
        &RELEASE_AFTER_LEDGERS,
    );
    assert_eq!(client.get_job_count(), 1);
    assert!(client
        .get_job(&SorobanString::from_str(&env, "post-cleanup"))
        .is_some());
}

/// Assert `cleanup_completed_jobs` panics with `NothingToCleanUp` when nothing
/// is eligible.
#[test]
fn cleanup_panics_when_nothing_to_clean() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    // No jobs at all.
    match client.try_cleanup_completed_jobs() {
        Err(Ok(error)) => assert_eq!(
            EscrowError::try_from(&error).ok(),
            Some(EscrowError::NothingToCleanUp)
        ),
        other => panic!("expected NothingToCleanUp, got {other:?}"),
    }
}

/// Build a single milestone with the given name and percentage.
fn milestone(env: &Env, name: &str, percentage: u32) -> escrow_contract::Milestone {
    escrow_contract::Milestone {
        name: SorobanString::from_str(env, name),
        percentage,
        released: false,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    }
}
