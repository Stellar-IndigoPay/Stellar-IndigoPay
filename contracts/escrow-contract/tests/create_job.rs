/// Integration tests: create_job
///
/// Coverage:
///   - Valid milestone-based job creation (existing)
///   - Invalid milestone percentages (< 100 %) (existing)
///   - Duplicate job ID rejection
///   - Zero amount rejection
///   - Milestone percentage overflow
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String as SorobanString, Vec};

use escrow_contract::{JobStatus, Milestone};

mod common;

// ─────────────────────────────────────────────────────────────────────────────
// Existing tests migrated from lib.rs
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_milestone_based_release() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-1");

    // Use three milestones: 50 %, 30 %, 20 %
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

    let job = client.get_job(&job_id).expect("Job should exist");
    assert_eq!(job.status, JobStatus::Escrowed);
    assert_eq!(job.milestones.len(), 3);
}

#[test]
#[should_panic]
fn test_milestone_validation() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = Address::generate(&env);
    let job_id = SorobanString::from_str(&env, "job-invalid");

    // Only 90 % — should panic
    let mut milestones = Vec::new(&env);
    milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "M1"),
        percentage: 50,
        released: false,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });
    milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "M2"),
        percentage: 40,
        released: false,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// New edge-case tests
// ─────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_duplicate_job_id_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 2000i128);

    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "dup-job",
        1000i128,
    );

    // Second creation with same job_id should panic
    common::create_simple_job(
        &env,
        &client,
        &client_addr,
        &freelancer,
        &token,
        "dup-job",
        1000i128,
    );
}

#[test]
#[should_panic]
fn test_zero_amount_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    let job_id = SorobanString::from_str(&env, "zero-amount");
    let milestones = common::three_milestones(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &0i128,
        &milestones,
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );
}

#[test]
#[should_panic]
fn test_negative_amount_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    let job_id = SorobanString::from_str(&env, "neg-amount");
    let milestones = common::three_milestones(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &(-100i128),
        &milestones,
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );
}

/// A milestone with percentage == 0 must be rejected even when the total
/// of all percentages sums to 100 (e.g. [0, 100]). Fixes #612.
#[test]
#[should_panic]
fn test_zero_percentage_milestone_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "zero-pct");

    // [0, 100] sums to 100 but the first milestone has a zero percentage —
    // create_job must now reject this with MilestonePercentageZero (code 11).
    let mut milestones = Vec::new(&env);
    milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "Zero"),
        percentage: 0,
        released: false,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });
    milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "Full"),
        percentage: 100,
        released: false,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests for issue #612 — missing create_job validations
// ─────────────────────────────────────────────────────────────────────────────

/// An empty milestone vector must be rejected (MilestoneVectorEmpty = 14). (#612)
#[test]
#[should_panic]
fn test_empty_milestone_vector_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "empty-milestones");

    let milestones: Vec<Milestone> = Vec::new(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );
}

/// Duplicate milestone names within a single job must be rejected
/// (DuplicateMilestoneName = 15). (#612)
#[test]
#[should_panic]
fn test_duplicate_milestone_name_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "dup-names");

    let mut milestones = Vec::new(&env);
    milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "Phase"),
        percentage: 50,
        released: false,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });
    milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "Phase"), // duplicate!
        percentage: 50,
        released: false,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );
}

/// A milestone name that exceeds MAX_MILESTONE_NAME_LEN (64 bytes) must be
/// rejected (MilestoneNameTooLong = 12). (#612)
#[test]
#[should_panic]
fn test_milestone_name_too_long_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "long-name-milestone");

    // 65-character name — one byte beyond the 64-byte limit.
    let long_name = SorobanString::from_str(
        &env,
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1", // 65 chars
    );
    let mut milestones = Vec::new(&env);
    milestones.push_back(Milestone {
        name: long_name,
        percentage: 100,
        released: false,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );
}

/// A job_id that exceeds MAX_JOB_ID_LEN (64 bytes) must be rejected
/// (JobIdTooLong = 13). (#612)
#[test]
#[should_panic]
fn test_job_id_too_long_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);

    // 65-character job_id — one byte beyond the 64-byte limit.
    let job_id = SorobanString::from_str(
        &env,
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1", // 65 chars
    );
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
}

/// A valid job with a 64-byte job_id and 64-byte milestone name (boundary
/// values) must still be accepted. (#612)
#[test]
fn test_create_job_at_length_boundaries_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);

    // Exactly 64 characters — must NOT be rejected.
    let job_id = SorobanString::from_str(
        &env,
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // 64 chars
    );
    let milestone_name = SorobanString::from_str(
        &env,
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // 64 chars
    );
    let mut milestones = Vec::new(&env);
    milestones.push_back(Milestone {
        name: milestone_name,
        percentage: 100,
        released: false,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );

    let job = client.get_job(&job_id).expect("Job should exist at boundary length");
    assert_eq!(job.milestones.len(), 1);
}

#[test]
#[should_panic]
fn test_release_after_below_minimum_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "release-after-too-low");
    let milestones = common::three_milestones(&env);

    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
        &(escrow_contract::RELEASE_AFTER_LEDGERS - 1),
    );
}

#[test]
fn test_create_job_with_custom_release_after() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = common::setup(&env);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);
    let job_id = SorobanString::from_str(&env, "job-custom-release-after");
    let milestones = common::three_milestones(&env);

    let custom_release_after = escrow_contract::RELEASE_AFTER_LEDGERS * 3;
    let created_at = env.ledger().sequence();
    client.create_job(
        &client_addr,
        &freelancer,
        &job_id,
        &token,
        &1000i128,
        &milestones,
        &custom_release_after,
    );

    let job = client.get_job(&job_id).expect("Job should exist");
    assert_eq!(job.release_after, created_at + custom_release_after);
}
