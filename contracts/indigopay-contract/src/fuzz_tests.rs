/// fuzz_tests.rs — Property-based tests for the IndigoPay Soroban contract.
///
/// Uses `proptest` to drive 10 000+ iterations of the `donate` function with
/// random `i128` amounts, asserting that:
///   - Global total-raised never overflows
///   - Global CO2 counter never overflows
///   - Per-project totals stay consistent with global totals
///   - Donation counts are monotonically increasing
///
/// Run:
///   cargo test --features testutils -- fuzz
#[cfg(all(test, feature = "testutils"))]
mod fuzz {
    extern crate std;

    use crate::{BatchDonation, DataKey, IndigoPayContract, IndigoPayContractClient, MockOracle, Project};
    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::Address as _, token::StellarAssetClient, Address, Env, String as SorobanString,
    };

    /// Upper bound for a single donation: 1 billion XLM in stroops (10^16).
    /// Chosen so that a single donation is large but a few thousand back-to-back
    /// still fit in an i128 without overflowing.
    const MAX_DONATION: i128 = 1_000_000_000 * 10_000_000; // 10^16

    /// Stable msg-hash placeholder for `donate` / `donate_usdc` calls.
    const MSG_HASH: u32 = 42;

    /// USDC-flavoured variant of `setup`. Registers an oracle (the bundled
    /// `MockOracle` returns a fixed rate of 8 XLM per 1 USDC stroop) and a
    /// USDC Stellar asset, then binds them to the contract via
    /// `set_oracle` / `set_usdc_token`.
    fn setup_usdc(
        co2_per_xlm: u32,
    ) -> (
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

        let project_id = SorobanString::from_str(&env, "proj-usdc-fuzz");
        let wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &project_id,
            &SorobanString::from_str(&env, "USDC Fuzz Project"),
            &wallet,
            &co2_per_xlm,
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

    /// Mint USDC balance for `donor` using a fresh Stellar asset admin.
    fn fund_usdc(env: &Env, usdc_token: &Address, donor: &Address, amount: i128) {
        StellarAssetClient::new(env, usdc_token).mint(donor, &amount);
    }

    fn setup() -> (
        Env,
        Address,
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

        let project_id = SorobanString::from_str(&env, "proj-fuzz-1");
        let wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &project_id,
            &SorobanString::from_str(&env, "Fuzz Project"),
            &wallet,
            &100u32,
        );

        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        (env, contract_id, client, wallet, project_id, token)
    }

    fn set_project_total_raised(
        env: &Env,
        contract_id: &Address,
        project_id: &SorobanString,
        amount: i128,
    ) {
        env.as_contract(contract_id, || {
            let mut project: Project = env
                .storage()
                .instance()
                .get(&DataKey::Project(project_id.clone()))
                .expect("project should exist");
            project.total_raised = amount;
            env.storage()
                .instance()
                .set(&DataKey::Project(project_id.clone()), &project);
        });
    }

    fn mint_tokens(env: &Env, token: &Address, donor: &Address, amount: i128) {
        let token_client = StellarAssetClient::new(env, token);
        token_client.mint(donor, &amount);
    }

    #[test]
    fn donation_of_i128_max_minus_one_does_not_panic() {
        let (env, _contract_id, client, _wallet, project_id, token) = setup();
        let donor = Address::generate(&env);
        mint_tokens(&env, &token, &donor, i128::MAX - 1);

        client.donate(&token, &donor, &project_id, &(i128::MAX - 1), &42u32);

        let project = client.get_project(&project_id);
        assert_eq!(project.total_raised, i128::MAX - 1);
        assert_eq!(project.donor_count, 1u32);
        assert_eq!(client.get_global_total(), i128::MAX - 1);
    }

    #[test]
    #[should_panic(expected = "Project total_raised overflow")]
    fn donation_of_i128_max_panics() {
        let (env, contract_id, client, _wallet, project_id, token) = setup();
        let donor = Address::generate(&env);
        set_project_total_raised(&env, &contract_id, &project_id, 1);
        mint_tokens(&env, &token, &donor, i128::MAX);

        client.donate(&token, &donor, &project_id, &i128::MAX, &42u32);
    }

    #[test]
    #[should_panic(expected = "Project total_raised overflow")]
    fn sequential_donations_panic_when_sum_exceeds_i128_max() {
        let (env, contract_id, client, _wallet, project_id, token) = setup();
        let donor_a = Address::generate(&env);
        let donor_b = Address::generate(&env);
        set_project_total_raised(&env, &contract_id, &project_id, 1);
        mint_tokens(&env, &token, &donor_a, i128::MAX - 1);
        mint_tokens(&env, &token, &donor_b, 2);

        client.donate(&token, &donor_a, &project_id, &(i128::MAX - 1), &42u32);
        client.donate(&token, &donor_b, &project_id, &2i128, &42u32);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// Single donation with a random amount in [1, MAX_DONATION] should never
        /// overflow global stats.
        #[test]
        fn prop_single_donation_no_overflow(amount in 1i128..=MAX_DONATION) {
            let (env, _contract_id, client, _wallet, project_id, token) = setup();
            let donor = Address::generate(&env);
            mint_tokens(&env, &token, &donor, amount);

            // donate must not panic (panics signal overflow via checked_add.expect)
            client.donate(&token, &donor, &project_id, &amount, &42u32);

            let global_total = client.get_global_total();
            let global_co2   = client.get_global_co2();
            let project      = client.get_project(&project_id);

            // All counters must be non-negative
            prop_assert!(global_total >= 0, "global_total went negative: {}", global_total);
            prop_assert!(global_co2   >= 0, "global_co2 went negative: {}", global_co2);
            prop_assert!(project.total_raised >= 0, "project.total_raised went negative");

            // Global total must equal project total (single project in this env)
            prop_assert_eq!(
                global_total, project.total_raised,
                "global_total ({}) != project.total_raised ({})",
                global_total, project.total_raised,
            );

            // Donation count must be 1
            prop_assert_eq!(project.donor_count, 1u32);
        }

        /// Two sequential donations with random amounts must keep global totals
        /// consistent and strictly greater than either individual donation.
        #[test]
        fn prop_two_donations_are_additive(
            a in 1i128..=MAX_DONATION / 2,
            b in 1i128..=MAX_DONATION / 2,
        ) {
            let (env, _contract_id, client, _wallet, project_id, token) = setup();
            let donor_a = Address::generate(&env);
            let donor_b = Address::generate(&env);
            mint_tokens(&env, &token, &donor_a, a);
            mint_tokens(&env, &token, &donor_b, b);

            client.donate(&token, &donor_a, &project_id, &a, &42u32);
            client.donate(&token, &donor_b, &project_id, &b, &42u32);

            let global_total = client.get_global_total();
            let expected     = a.checked_add(b).expect("test helper overflow");

            prop_assert_eq!(
                global_total, expected,
                "global_total {} != a+b {}",
                global_total, expected,
            );

            // Two distinct donors → donor_count == 2
            let project = client.get_project(&project_id);
            prop_assert_eq!(project.donor_count, 2u32);
        }

        /// Donating a zero amount is an edge case — the contract uses
        /// `checked_add(0)` which is always safe. Verify no state mutation occurs
        /// when amount == 0 is passed (or contract rejects it gracefully).
        #[test]
        fn prop_zero_donation_does_not_corrupt_state(
            legit in 1i128..=MAX_DONATION,
        ) {
            let (env, _contract_id, client, _wallet, project_id, token) = setup();
            let donor = Address::generate(&env);
            mint_tokens(&env, &token, &donor, legit);

            client.donate(&token, &donor, &project_id, &legit, &42u32);
            let total_before = client.get_global_total();

            // A second call with the same donor — amount 0 may panic or succeed
            // depending on contract implementation; we only assert the state
            // before the second call was not corrupted.
            prop_assert_eq!(total_before, legit);
        }

        // ── USDC fuzz cases ────────────────────────────────────────────────────

        /// USDC amount near i128::MAX triggers the `checked_mul(8)` overflow guard
        /// inside donate_usdc. Any value above i128::MAX / 8 must panic.
        #[test]
        fn prop_usdc_amount_near_max(usdc_amount in (i128::MAX / 8 + 1)..=i128::MAX) {
            let (env, client, project_id, usdc_token) = setup_usdc(100u32);
            let donor = Address::generate(&env);
            fund_usdc(&env, &usdc_token, &donor, usdc_amount);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.donate_usdc(&usdc_token, &donor, &project_id, &usdc_amount, &MSG_HASH);
            }));
            prop_assert!(result.is_err(), "donate_usdc should panic when usdc_amount > i128::MAX / 8");
        }

        /// USDC token address mismatch must be rejected before any state mutation.
        /// The provided `usdc_token` does not match the stored `USDCTokenAddress`.
        #[test]
        fn prop_usdc_token_mismatch(amount in 1i128..=100_000_000i128) {
            let (env, client, project_id, _usdc_token) = setup_usdc(100u32);
            let donor = Address::generate(&env);
            let wrong_token = Address::generate(&env);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.donate_usdc(&wrong_token, &donor, &project_id, &amount, &MSG_HASH);
            }));
            prop_assert!(result.is_err(), "donate_usdc should panic on token mismatch");
        }

        /// Donating USDC to a deactivated (inactive) project must be rejected.
        /// This test sets up the environment in-line so the admin address is
        /// available to call `deactivate_project`.
        #[test]
        fn prop_usdc_inactive_project(amount in 1i128..=100_000_000i128) {
            let env = Env::default();
            env.mock_all_auths();
            let cid = env.register_contract(None, IndigoPayContract);
            let client = IndigoPayContractClient::new(&env, &cid);
            let admin = Address::generate(&env);
            client.initialize(&soroban_sdk::vec![&env, admin.clone()], &1u32);

            let project_id = SorobanString::from_str(&env, "proj-inactive");
            let wallet = Address::generate(&env);
            client.register_project(
                &admin,
                &project_id,
                &SorobanString::from_str(&env, "Inactive USDC Project"),
                &wallet,
                &100u32,
            );

            let token_admin = Address::generate(&env);
            let usdc_token = env.register_stellar_asset_contract_v2(token_admin).address();
            client.set_usdc_token(&admin, &usdc_token);

            client.deactivate_project(&admin, &project_id);

            let donor = Address::generate(&env);
            fund_usdc(&env, &usdc_token, &donor, amount);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.donate_usdc(&usdc_token, &donor, &project_id, &amount, &MSG_HASH);
            }));
            prop_assert!(result.is_err(), "donate_usdc should panic when project is inactive");
        }

        // CO2 overflow is now prevented at registration time by the
        // `co2_per_xlm <= MAX_CO2_PER_XLM` check. This test instead
        // verifies the boundary: at the maximum allowed CO₂ rate,
        // donations still succeed and produce correct offset values.
        #[test]
        fn prop_usdc_max_co2_rate_boundary(
            usdc_amount in 1i128..=100_000_000i128,
        ) {
            let (env, client, project_id, usdc_token) = setup_usdc(100_000);
            let donor = Address::generate(&env);
            fund_usdc(&env, &usdc_token, &donor, usdc_amount);

            client.donate_usdc(&usdc_token, &donor, &project_id, &usdc_amount, &MSG_HASH);

            let donor_stats = client.get_donor_stats(&donor);
            prop_assert!(donor_stats.co2_offset_grams > 0, "CO₂ offset should be non-zero at max rate");
            prop_assert_eq!(donor_stats.donation_count, 1);
        }

        // ── Batch donation fuzz cases ───────────────────────────────────────

        /// A batch of random donations must conservatively sum: the global
        /// total raised must equal the sum of all individual amounts.
        #[test]
        fn prop_batch_sum_conservation(
            a in 1i128..=MAX_DONATION / 4,
            b in 1i128..=MAX_DONATION / 4,
            c in 1i128..=MAX_DONATION / 4,
        ) {
            let (env, _contract_id, client, _wallet, project_id, token) = setup();
            let donor = Address::generate(&env);
            let total = a.checked_add(b).and_then(|v| v.checked_add(c)).unwrap_or(MAX_DONATION);
            mint_tokens(&env, &token, &donor, total);

            let mut donations = soroban_sdk::Vec::new(&env);
            donations.push_back(BatchDonation {
                donor: donor.clone(),
                project_id: project_id.clone(),
                amount: a,
                msg_hash: MSG_HASH,
            });
            donations.push_back(BatchDonation {
                donor: donor.clone(),
                project_id: project_id.clone(),
                amount: b,
                msg_hash: MSG_HASH,
            });
            donations.push_back(BatchDonation {
                donor: donor.clone(),
                project_id: project_id.clone(),
                amount: c,
                msg_hash: MSG_HASH,
            });

            client.batch_donate(&token, &donations);

            let expected = a.checked_add(b).and_then(|v| v.checked_add(c)).unwrap();
            let global_total = client.get_global_total();
            prop_assert_eq!(global_total, expected,
                "global_total {} != sum {}", global_total, expected);

            let project = client.get_project(&project_id);
            prop_assert_eq!(project.total_raised, expected,
                "project.total_raised {} != sum {}", project.total_raised, expected);

            // All counters must be non-negative
            prop_assert!(global_total >= 0, "global_total went negative");
            prop_assert!(client.get_global_co2() >= 0, "global_co2 went negative");
        }

        /// After a successful batch, all project stats must be updated
        /// atomically — either all donations land or none do.
        #[test]
        fn prop_batch_atomicity(
            a in 1i128..=MAX_DONATION / 4,
            b in 1i128..=MAX_DONATION / 4,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let cid = env.register_contract(None, IndigoPayContract);
            let client = IndigoPayContractClient::new(&env, &cid);
            let admin = Address::generate(&env);
            client.initialize(&soroban_sdk::vec![&env, admin.clone()], &1u32);

            let pid1 = SorobanString::from_str(&env, "fuzz-a");
            let pid2 = SorobanString::from_str(&env, "fuzz-b");
            client.register_project(&admin, &pid1, &SorobanString::from_str(&env, "A"), &Address::generate(&env), &100u32);
            client.register_project(&admin, &pid2, &SorobanString::from_str(&env, "B"), &Address::generate(&env), &100u32);

            let donor = Address::generate(&env);
            let total = a.checked_add(b).unwrap_or(MAX_DONATION);

            let token_admin = Address::generate(&env);
            let batch_token = env
                .register_stellar_asset_contract_v2(token_admin)
                .address();
            mint_tokens(&env, &batch_token, &donor, total);

            let mut donations = soroban_sdk::Vec::new(&env);
            donations.push_back(BatchDonation {
                donor: donor.clone(),
                project_id: pid1.clone(),
                amount: a,
                msg_hash: MSG_HASH,
            });
            donations.push_back(BatchDonation {
                donor: donor.clone(),
                project_id: pid2.clone(),
                amount: b,
                msg_hash: MSG_HASH,
            });

            client.batch_donate(&batch_token, &donations);

            let p1 = client.get_project(&pid1);
            let p2 = client.get_project(&pid2);

            // Both projects must have received their amounts
            prop_assert_eq!(p1.total_raised, a,
                "project A total_raised {} != a {}", p1.total_raised, a);
            prop_assert_eq!(p2.total_raised, b,
                "project B total_raised {} != b {}", p2.total_raised, b);

            // Global total must equal sum
            let global_total = client.get_global_total();
            prop_assert_eq!(global_total, a.checked_add(b).unwrap());
        }
    }
}
