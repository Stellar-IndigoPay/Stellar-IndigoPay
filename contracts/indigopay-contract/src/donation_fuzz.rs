/// fuzz testing for donation entry points
#[cfg(all(test, feature = "testutils"))]
mod fuzz {
    extern crate std;
    use crate::{BatchDonation, IndigoPayContract, IndigoPayContractClient};
    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::Address as _,
        token::StellarAssetClient,
        Address, Env, String as SorobanString, Symbol, Vec,
    };
    
    // We can use a simple mock oracle
    soroban_sdk::contract!(
        pub struct MockOracle;
    );
    #[soroban_sdk::contractimpl]
    impl MockOracle {
        pub fn get_price(_env: Env) -> i128 {
            8 // 1 USDC = 8 XLM stroops
        }
    }

    const MAX_DONATION: i128 = 1_000_000_000 * 10_000_000; // 10^16

    fn setup(project_id_str: &str) -> (
        Env,
        IndigoPayContractClient<'static>,
        Address,
        SorobanString,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&soroban_sdk::vec![&env, admin.clone()], &1u32);

        let project_id = SorobanString::from_str(&env, project_id_str);
        let wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &project_id,
            &SorobanString::from_str(&env, "Fuzz Project"),
            &wallet,
            &100u32, // co2_per_xlm
        );

        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        (env, client, wallet, project_id, token)
    }

    fn setup_usdc(project_id_str: &str) -> (
        Env,
        IndigoPayContractClient<'static>,
        SorobanString,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let cid = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &cid);

        let admin = Address::generate(&env);
        client.initialize(&soroban_sdk::vec![&env, admin.clone()], &1u32);

        let project_id = SorobanString::from_str(&env, project_id_str);
        let wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &project_id,
            &SorobanString::from_str(&env, "USDC Fuzz Project"),
            &wallet,
            &100u32,
        );

        let token_admin = Address::generate(&env);
        let usdc_token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        client.set_usdc_token(&admin, &usdc_token);

        let oracle_addr = env.register_contract(None, MockOracle);
        client.set_oracle(&admin, &oracle_addr);

        (env, client, project_id, usdc_token)
    }

    fn mint_tokens(env: &Env, token: &Address, donor: &Address, amount: i128) {
        let token_client = StellarAssetClient::new(env, token);
        token_client.mint(donor, &amount);
    }

    fn valid_project_id() -> impl Strategy<Value = std::string::String> {
        "[a-zA-Z0-9]{5,15}".prop_map(|s| std::format!("proj-{}", s))
    }

    fn valid_donor_index() -> impl Strategy<Value = usize> {
        (0usize..10usize).prop_map(|i| i)
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        #[test]
        fn prop_donate(
            amount in 1i128..=MAX_DONATION,
            msg_hash in any::<u32>(),
            project_str in valid_project_id(),
            donor_idx in valid_donor_index(),
        ) {
            let (env, client, _wallet, project_id, token) = setup(&project_str);
            let mut donors = std::vec::Vec::new();
            for _ in 0..10 {
                donors.push(Address::generate(&env));
            }
            let test_donor = &donors[donor_idx];
            
            mint_tokens(&env, &token, test_donor, amount);

            client.donate(&token, test_donor, &project_id, &amount, &msg_hash);

            let project = client.get_project(&project_id);
            prop_assert_eq!(project.total_raised, amount);
            prop_assert_eq!(project.donor_count, 1);
            
            let stats = client.get_donor_stats(test_donor);
            prop_assert_eq!(stats.total_donated, amount);
            prop_assert!(stats.co2_offset_grams >= 0);
        }

        #[test]
        fn prop_donate_asset(
            amount in 1i128..=MAX_DONATION,
            msg_hash in any::<u32>(),
            project_str in valid_project_id(),
            donor_idx in valid_donor_index(),
        ) {
            let (env, client, _wallet, project_id, token) = setup(&project_str);
            let mut donors = std::vec::Vec::new();
            for _ in 0..10 {
                donors.push(Address::generate(&env));
            }
            let test_donor = &donors[donor_idx];
            
            mint_tokens(&env, &token, test_donor, amount);

            let asset_code = Symbol::new(&env, "yXLM");

            // Mock implementation to mimic path payment, which under the hood just invokes donate with attribution,
            // passing down the token used for setup.
            client.donate_asset(test_donor, &project_id, &amount, &asset_code, &msg_hash);

            let project = client.get_project(&project_id);
            prop_assert_eq!(project.total_raised, amount);
        }

        #[test]
        fn prop_donate_usdc(
            usdc_amount in 1i128..=(i128::MAX / 10),
            msg_hash in any::<u32>(),
            project_str in valid_project_id(),
            donor_idx in valid_donor_index(),
        ) {
            let (env, client, project_id, usdc_token) = setup_usdc(&project_str);
            let mut donors = std::vec::Vec::new();
            for _ in 0..10 {
                donors.push(Address::generate(&env));
            }
            let test_donor = &donors[donor_idx];
            
            mint_tokens(&env, &usdc_token, test_donor, usdc_amount);

            client.donate_usdc(&usdc_token, test_donor, &project_id, &usdc_amount, &msg_hash);

            let project = client.get_project(&project_id);
            let expected_xlm = usdc_amount.checked_mul(8).unwrap();
            prop_assert_eq!(project.total_raised, expected_xlm);
        }

        #[test]
        fn prop_batch_donate(
            amounts in proptest::collection::vec(1i128..=1_000_000_000_000i128, 1..=5),
            msg_hashes in proptest::collection::vec(any::<u32>(), 1..=5),
            project_str in valid_project_id(),
        ) {
            let (env, client, _wallet, project_id, token) = setup(&project_str);
            let mut donations = Vec::new(&env);
            
            let mut expected_total = 0i128;
            for i in 0..amounts.len() {
                let donor = Address::generate(&env);
                let amt = amounts[i];
                mint_tokens(&env, &token, &donor, amt);
                
                let hash = if i < msg_hashes.len() { msg_hashes[i] } else { 0 };
                
                donations.push_back(BatchDonation {
                    donor: donor.clone(),
                    project_id: project_id.clone(),
                    amount: amt,
                    msg_hash: hash,
                });
                
                expected_total += amt;
            }

            client.batch_donate(&token, &donations);

            let project = client.get_project(&project_id);
            prop_assert_eq!(project.total_raised, expected_total);
            prop_assert_eq!(project.donor_count, amounts.len() as u32);
        }
    }
}
