/// Integration tests: multi-sig admin + per-job release period (#440)
///
/// Coverage:
///   - Initialize with a 3-of-5 admin set, dispute a milestone with exactly
///     3 signers, resolve it, and release the job's remaining milestone
///     after its own custom `release_after` period elapses.
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, Env, String as SorobanString, Vec};

use escrow_contract::{EscrowContract, EscrowContractClient, JobStatus, Milestone};

mod common;

fn build_signers(env: &Env, addrs: &[Address]) -> Vec<Address> {
    let mut v = Vec::new(env);
    for a in addrs {
        v.push_back(a.clone());
    }
    v
}

#[test]
fn test_3_of_5_dispute_and_release_with_per_job_period() {
    let env = Env::default();
    env.mock_all_auths();

    let cid = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &cid);

    let admins = [
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];
    client.initialize(&build_signers(&env, &admins), &3u32);
    assert_eq!(client.get_admin_threshold(), 3u32);
    assert_eq!(client.get_admin_set().len(), 5);

    let client_addr = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = common::create_token(&env);
    common::fund(&env, &token, &client_addr, 1000i128);

    let job_id = SorobanString::from_str(&env, "job-3-of-5");
    let mut milestones = Vec::new(&env);
    milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "M1"),
        percentage: 40,
        released: false,
        partial_release_percentage: 0,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });
    milestones.push_back(Milestone {
        name: SorobanString::from_str(&env, "M2"),
        percentage: 60,
        released: false,
        partial_release_percentage: 0,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });

    // Custom per-job release period, longer than the contract-wide minimum.
    let custom_release_after = escrow_contract::RELEASE_AFTER_LEDGERS * 4;
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
    assert_eq!(
        client.get_job(&job_id).unwrap().release_after,
        created_at + custom_release_after
    );

    // 3 of the 5 admins sign to dispute milestone 0 — meets the 3-of-5 threshold.
    let three_signers = build_signers(&env, &admins[0..3]);
    client.dispute_milestone(&three_signers, &job_id, &0u32);
    assert!(
        client
            .get_job(&job_id)
            .unwrap()
            .milestones
            .get(0)
            .unwrap()
            .disputed
    );

    // A different set of 3 admins resolves the dispute in the freelancer's favor.
    let other_three_signers = build_signers(&env, &admins[2..5]);
    client.resolve_milestone_dispute(&other_three_signers, &job_id, &0u32, &true);

    let job = client.get_job(&job_id).unwrap();
    assert!(job.milestones.get(0).unwrap().released);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 400i128);

    // Milestone 1 isn't disputed, but the freelancer must still wait out the
    // job's own (longer than minimum) release period before auto-claiming it.
    env.ledger()
        .set_sequence_number(created_at + escrow_contract::RELEASE_AFTER_LEDGERS + 1);
    let too_early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.claim_milestone(&freelancer, &job_id, &1u32);
    }));
    assert!(
        too_early.is_err(),
        "claim before the job's own release_after must fail"
    );

    env.ledger()
        .set_sequence_number(created_at + custom_release_after + 1);
    client.claim_milestone(&freelancer, &job_id, &1u32);

    let final_job = client.get_job(&job_id).unwrap();
    assert_eq!(final_job.status, JobStatus::Completed);
    assert_eq!(common::token_balance(&env, &token, &freelancer), 1000i128);
}
