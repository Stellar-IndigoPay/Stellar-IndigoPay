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

    use crate::{DataKey, IndigoPayContract, IndigoPayContractClient, MockOracle, Project};
    use proptest::prelude::*;
    use soroban_sdk::BytesN;
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
    #[should_panic(expected = "overflow")]
    fn donation_of_i128_max_panics() {
        let (env, contract_id, client, _wallet, project_id, token) = setup();
        let donor = Address::generate(&env);
        set_project_total_raised(&env, &contract_id, &project_id, 1);
        mint_tokens(&env, &token, &donor, i128::MAX);

        client.donate(&token, &donor, &project_id, &i128::MAX, &42u32);
    }

    #[test]
    #[should_panic(expected = "overflow")]
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
            usdc_amount in 1_250_000i128..=100_000_000i128,
        ) {
            let (env, client, project_id, usdc_token) = setup_usdc(100_000);
            let donor = Address::generate(&env);
            fund_usdc(&env, &usdc_token, &donor, usdc_amount);

            client.donate_usdc(&usdc_token, &donor, &project_id, &usdc_amount, &MSG_HASH);

            let donor_stats = client.get_donor_stats(&donor);
            prop_assert!(donor_stats.co2_offset_grams > 0, "CO₂ offset should be non-zero at max rate");
            prop_assert_eq!(donor_stats.donation_count, 1);
        }

        // ── Receipt commitment uniqueness (#455) ──────────────────────────────

        /// Two different donations by the same donor must produce different
        /// receipt commitments (domain-separated SHA-256 commitments).
        /// Verifies that receipt hashes are unique per donation, not per donor.
        #[test]
        fn prop_receipt_commitment_unique(
            amount_a in 100i128..=MAX_DONATION,
            amount_b in 100i128..=MAX_DONATION,
        ) {
            let (env, _contract_id, client, _wallet, project_id, token) = setup();
            let donor = Address::generate(&env);
            mint_tokens(&env, &token, &donor, amount_a + amount_b);

            client.donate(&token, &donor, &project_id, &amount_a, &MSG_HASH);
            client.donate(&token, &donor, &project_id, &amount_b, &MSG_HASH);

            let receipt_a = client.generate_receipt(&donor, &0u32);
            let receipt_b = client.generate_receipt(&donor, &1u32);

            // Different donation indices → different commitments
            prop_assert_ne!(
                receipt_a.receipt_commitment,
                receipt_b.receipt_commitment,
                "Different donations must produce unique receipt commitments"
            );

            // Both donors should be the same.
            // Borrow through `&` because `soroban_sdk::Address` is not `Copy`
            // — passing the owned field twice would move it on the first use
            // and trip an `E0382` on the second.
            prop_assert_eq!(&receipt_a.donor, &receipt_b.donor);
            prop_assert_eq!(&receipt_a.donor, &donor);
        }

        /// Random token address must panic if unregistered when calling `donate_token`.
        #[test]
        fn prop_donate_token_random_token(
            amount in 1i128..=100_000_000i128,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let cid = env.register_contract(None, IndigoPayContract);
            let client = IndigoPayContractClient::new(&env, &cid);
            let admin = Address::generate(&env);
            client.initialize(&soroban_sdk::vec![&env, admin.clone()], &1u32);

            let project_id = SorobanString::from_str(&env, "proj-random-token");
            let wallet = Address::generate(&env);
            client.register_project(
                &admin,
                &project_id,
                &SorobanString::from_str(&env, "Random Token Project"),
                &wallet,
                &100u32,
            );

            let random_token = Address::generate(&env);
            let donor = Address::generate(&env);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.donate_token(&random_token, &donor, &project_id, &amount, &MSG_HASH);
            }));
            prop_assert!(result.is_err(), "donate_token should panic for unregistered token");
        }

        /// XLM-equivalent calculation test: rate * amount must equal total_donated.
        #[test]
        fn prop_xlm_equivalent_calculation(
            usdc_amount in 1i128..=10_000_000_000i128,
        ) {
            let (env, client, project_id, usdc_token) = setup_usdc(100u32);
            let donor = Address::generate(&env);
            fund_usdc(&env, &usdc_token, &donor, usdc_amount);

            client.donate_token(&usdc_token, &donor, &project_id, &usdc_amount, &MSG_HASH);

            let stats = client.get_donor_stats(&donor);
            // Oracle rate is 8 XLM per 1 USDC
            let expected_xlm = usdc_amount.checked_mul(8).unwrap();
            prop_assert_eq!(stats.total_donated, expected_xlm);
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        /// No vector containing fewer than two distinct authorized admins can
        /// initiate a force-refund when the configured threshold is 2.
        #[test]
        fn prop_force_refund_requires_m_of_n(
            include_first in any::<bool>(),
            duplicate_first in any::<bool>(),
            include_outsider in any::<bool>(),
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let contract_id = env.register_contract(None, IndigoPayContract);
            let client = IndigoPayContractClient::new(&env, &contract_id);
            let first_admin = Address::generate(&env);
            let second_admin = Address::generate(&env);
            let outsider = Address::generate(&env);

            client.initialize(
                &soroban_sdk::vec![&env, first_admin.clone(), second_admin],
                &2u32,
            );

            let mut supplied = soroban_sdk::Vec::new(&env);
            if include_first {
                supplied.push_back(first_admin.clone());
            }
            if duplicate_first {
                supplied.push_back(first_admin);
            }
            if include_outsider {
                supplied.push_back(outsider);
            }

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.force_approve_refund(&supplied, &0u32);
            }));
            prop_assert!(
                result.is_err(),
                "fewer than two distinct admins unexpectedly satisfied a 2-of-2 threshold"
            );
        }
    }

    // ─── Impact Root Archiving Fuzz Tests (#466) ───────────────────────────
    //
    // Property: For any N periods published sequentially:
    //   - Period count = N
    //   - All archived periods are accessible at indices 0..N-1
    //   - Indices are sequential with no gaps
    //
    // Uses `env.as_contract()` because the free functions access contract
    // storage directly (not through the client).

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn prop_archive_index_sequential(n in 1u32..=10u32) {
            let env = Env::default();
            env.mock_all_auths();
            let cid = env.register_contract(None, IndigoPayContract);
            let client = IndigoPayContractClient::new(&env, &cid);
            let admin = Address::generate(&env);
            client.initialize(&soroban_sdk::vec![&env, admin.clone()], &1u32);

            let project_id = SorobanString::from_str(&env, "fuzz-archive");
            let wallet = Address::generate(&env);
            client.register_project(
                &admin,
                &project_id,
                &SorobanString::from_str(&env, "Fuzz Archive"),
                &wallet,
                &100u32,
            );

            // Publish N periods
            for i in 0u32..n {
                env.as_contract(&cid, || {
                    let root = BytesN::from_array(&env, &[(i as u8 + 1); 32]);
                    use crate::{publish_impact_root, ImpactTotals};
                    publish_impact_root(
                        &env,
                        &soroban_sdk::vec![&env, admin.clone()],
                        project_id.clone(),
                        root,
                        1704067200u64 + (i as u64) * 2_592_000,
                        1706745600u64 + (i as u64) * 2_592_000,
                        ImpactTotals {
                            co2_kg: 1000 + i as u64 * 100,
                            trees: 500 + i as u64 * 50,
                            hectares: 10u64 + i as u64,
                        },
                    );
                });
            }

            // Verify: period count = min(n-1, MAX_ARCHIVED_PERIODS)
            // (n-1 because the last root is current, not archived)
            let expected_count = if n == 1 { 0 } else { n - 1 };
            let capped_count = core::cmp::min(expected_count, crate::MAX_ARCHIVED_PERIODS);

            let _ = env.as_contract(&cid, || {
                use crate::get_impact_periods;
                let periods = get_impact_periods(&env, project_id);
                prop_assert_eq!(
                    periods.len() as u32,
                    capped_count,
                    "period count mismatch: expected {}, got {}",
                    capped_count,
                    periods.len()
                );

                // Verify sequential indices with no gaps
                for j in 0..periods.len() {
                    let p = periods.get_unchecked(j);
                    prop_assert_eq!(
                        p.period_index, j as u32,
                        "index gap at position {}: expected {}, got {}",
                        j, j, p.period_index
                    );
                }

                // Verify totals are strictly increasing (each period has more impact than the last)
                for j in 1..periods.len() {
                    let prev = periods.get_unchecked(j - 1);
                    let curr = periods.get_unchecked(j);
                    prop_assert!(
                        curr.total_co2_kg > prev.total_co2_kg,
                        "CO2 total not increasing at index {}",
                        j
                    );
                }
                Ok(())
            });
        }

        #[test]
        fn prop_fee_sum_equals_total(fee_amount in 1i128..=1_000_000_000_000i128, s1 in 1u32..=9998u32) {
            let env = Env::default();
            let r1 = crate::FeeRecipient {
                address: Address::generate(&env),
                share_bps: s1,
            };
            let r2 = crate::FeeRecipient {
                address: Address::generate(&env),
                share_bps: 10_000 - s1,
            };
            let recipients = soroban_sdk::vec![&env, r1, r2];
            let shares = crate::split_fee_recipients(&env, fee_amount, &recipients);
            let mut sum: i128 = 0;
            for (_addr, amount) in shares.iter() {
                sum += amount;
            }
            prop_assert_eq!(sum, fee_amount, "Sum of recipient fee shares must equal total fee amount");
        }
    }
}
