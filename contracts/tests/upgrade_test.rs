#![cfg(test)]

use soroban_sdk::{
    contracttype, symbol_short, token, Address, BytesN, Env, IntoVal, String, Symbol, Val, Vec,
};

// We import the contract client and types from the current indigopay-contract crate
use indigopay_contract::{
    BadgeTier, DonorStats, GlobalStats, IndigoPayContract, IndigoPayContractClient, Project,
    VoteProposal,
};

// Include the compiled WASM binaries for the tests
const V1_WASM: &[u8] = include_bytes!("fixtures/v1.wasm");
const V2_WASM: &[u8] = include_bytes!("fixtures/v2.wasm");

#[test]
fn test_full_upgrade_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();

    // Generate test accounts
    let admin = Address::generate(&env);
    let donor_1 = Address::generate(&env);
    let voter = Address::generate(&env);
    let project_id_1 = String::from_str(&env, "proj-1");
    let name_1 = String::from_str(&env, "Green Forest");
    let wallet_1 = Address::generate(&env);

    // Deploy token contract
    let token_admin = Address::generate(&env);
    let token_address = env.register_stellar_asset_contract_v2(token_admin).address();
    let token_client = token::StellarAssetClient::new(&env, &token_address);
    token_client.mint(&donor_1, &200_0000000);
    token_client.mint(&voter, &200_0000000);

    // Phase 1: Deploy and seed V1 contract (compiled without paused field)
    let contract_id = env.register_contract_wasm(None, V1_WASM);
    let client = IndigoPayContractClient::new(&env, &contract_id);

    client.initialize(&admin);

    // Register project with donations
    client.register_project(&admin, &project_id_1, &name_1, &wallet_1, &500);

    // Make donor_1 donate 100 XLM (100_0000000 stroops)
    client.donate(&token_address, &donor_1, &project_id_1, &100_0000000, &0);

    // Make voter donate 10 XLM so they have a Seedling badge to vote
    client.donate(&token_address, &voter, &project_id_1, &10_0000000, &0);

    // Create governance proposal and vote
    client.create_proposal(&admin, &project_id_1, &0);
    client.vote_verify_project(&voter, &project_id_1, &true);

    // Phase 2: Propose and execute upgrade
    let v2_wasm_hash = env.deployer().upload_contract_wasm(V2_WASM);

    // Test Cancel / Resubmit Flow
    client.propose_upgrade(&admin, &v2_wasm_hash);
    
    // Assert we cannot propose another upgrade while one is pending
    let propose_res = client.try_propose_upgrade(&admin, &v2_wasm_hash);
    assert!(propose_res.is_err());

    // Cancel the upgrade
    client.cancel_upgrade(&admin);
    let pending = client.get_pending_upgrade();
    assert!(pending.is_none());

    // Re-propose upgrade
    client.propose_upgrade(&admin, &v2_wasm_hash);

    // Assert cannot execute before timelock (34,560 ledgers)
    let result = client.try_execute_upgrade();
    assert!(result.is_err());

    // Advance ledger past timelock (34,560 ledgers)
    env.ledger().set_sequence(env.ledger().sequence() + 34560);

    // Execute upgrade
    client.execute_upgrade();

    // Phase 3: Verify state continuity
    let project = client.get_project(&project_id_1);
    assert_eq!(project.total_raised, 110_0000000);
    assert_eq!(project.donor_count, 2);
    
    // In V2, paused is false (defaults to false or is parsed correctly)
    assert_eq!(project.paused, false);

    // Verify donor stats continuity
    let donor_stats = client.get_donor_stats(&donor_1);
    assert_eq!(donor_stats.total_donated, 100_0000000);
    assert_eq!(donor_stats.donation_count, 1);
    assert_eq!(donor_stats.badge, BadgeTier::Tree);

    // Verify governance proposal survives
    let proposal = client.get_proposal(&project_id_1);
    assert_eq!(proposal.votes_for, 1);
    assert!(!proposal.resolved);

    // Verify voter list survives
    let voters = client.get_voter_list(&project_id_1);
    assert_eq!(voters.len(), 1);
    assert_eq!(voters.get(0).unwrap(), voter);

    // Phase 4: Verify new V2 features work
    // We use env.invoke_contract to invoke the new functions introduced in V2
    let new_func_res: i32 = env.invoke_contract(
        &contract_id,
        &Symbol::new(&env, "new_v2_function"),
        Vec::new(&env),
    );
    assert_eq!(new_func_res, 42);

    let val_res: i32 = env.invoke_contract(
        &contract_id,
        &Symbol::new(&env, "get_new_feature_val"),
        Vec::new(&env),
    );
    assert_eq!(val_res, 42);
}
