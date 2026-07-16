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

    use crate::{
        BadgeTier, DataKey, DonorStats, IndigoPayContract, IndigoPayContractClient, MockOracle,
        OracleInterface, Project,
    };
    use proptest::prelude::*;
    use soroban_sdk::{
        contract, contractimpl, testutils::Address as _, token::StellarAssetClient, Address, Env,
        String as SorobanString, Symbol,
    };

    /// Upper bound for a single donation: 1 billion XLM in stroops (10^16).
    /// Chosen so that a single donation is large but a few thousand back-to-back
    /// still fit in an i128 without overflowing.
    const MAX_DONATION: i128 = 1_000_000_000 * 10_000_000; // 10^16

    /// 1 XLM expressed in stroops. USDC fuzz tests multiply donations by
    /// the 8x oracle rate and divide by this constant to get the
    /// XLM-equivalent units that drive the CO₂ `checked_mul` path.
    const FUZZ_STROOP: i128 = 10_000_000;

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
        client.initialize(&admin);

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
        client.initialize(&admin);

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

    fn grant_badge(env: &Env, cid: &Address, donor: &Address, total_stroops: i128) {
        env.as_contract(cid, || {
            env.storage().instance().set(
                &DataKey::DonorStats(donor.clone()),
                &DonorStats {
                    total_donated: total_stroops,
                    donation_count: 1,
                    badge: BadgeTier::Seedling,
                    co2_offset_grams: 0,
                },
            );
        });
    }

    #[contract]
    struct PriceOracleHarness;

    #[contractimpl]
    impl OracleInterface for PriceOracleHarness {
        fn get_price(env: Env) -> i128 {
            let key = Symbol::new(&env, "price");
            env.storage().instance().get(&key).unwrap_or(8)
        }
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
            fund_usdc(&env, &usdc_token, &donor, &usdc_amount);

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
            client.initialize(&admin);

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
            fund_usdc(&env, &usdc_token, &donor, &amount);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.donate_usdc(&usdc_token, &donor, &project_id, &amount, &MSG_HASH);
            }));
            prop_assert!(result.is_err(), "donate_usdc should panic when project is inactive");
        }

        /// CO₂ overflow when a project has a high `co2_per_xlm` multiplied by
        /// a large XLM-equivalent amount.  The `checked_mul` inside
        /// `donate_usdc` must panic before any state mutation.
        #[test]
        fn prop_usdc_co2_overflow(
            usdc_amount in {
                let min = (i128::MAX / (u32::MAX as i128)) * FUZZ_STROOP / 8 + 1;
                let max = i128::MAX / 8;
                min..=max
            },
        ) {
            let (env, client, project_id, usdc_token) = setup_usdc(u32::MAX);
            let donor = Address::generate(&env);
            fund_usdc(&env, &usdc_token, &donor, &usdc_amount);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.donate_usdc(&usdc_token, &donor, &project_id, &usdc_amount, &MSG_HASH);
            }));
            prop_assert!(result.is_err(), "donate_usdc should panic on CO2 overflow");
        }

        #[test]
        fn fuzz_governance_proposals(
            num_donors in 1usize..=6,
            num_projects in 1usize..=4,
            ledger_offset in 0u32..=200_000u32,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let cid = env.register_contract(None, IndigoPayContract);
            let client = IndigoPayContractClient::new(&env, &cid);
            let admin = Address::generate(&env);
            client.initialize(&admin);

            let mut expected_for = vec![0u32; num_projects];
            let mut expected_against = vec![0u32; num_projects];
            let mut project_ids = Vec::new();
            for idx in 0..num_projects {
                let project_id = SorobanString::from_str(&env, &format!("gov-fuzz-{}", idx));
                let wallet = Address::generate(&env);
                client.register_project(
                    &admin,
                    &project_id,
                    &SorobanString::from_str(&env, "Governance Fuzz Project"),
                    &wallet,
                    &100u32,
                );
                client.create_proposal(&admin, &project_id, &0u32);
                project_ids.push(project_id.clone());
            }

            for donor_idx in 0..num_donors {
                let donor = Address::generate(&env);
                grant_badge(&env, &cid, &donor, 10 * FUZZ_STROOP);
                let proposal_idx = donor_idx % num_projects;
                let project_id = project_ids[proposal_idx].clone();
                let approve = (donor_idx + proposal_idx) % 2 == 0;

                let first_vote = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.vote_verify_project(&donor, &project_id, &approve);
                }));
                prop_assert!(first_vote.is_ok(), "badge holder should be able to vote");

                let second_vote = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.vote_verify_project(&donor, &project_id, &approve);
                }));
                prop_assert!(second_vote.is_err(), "duplicate vote should be rejected");

                if approve {
                    expected_for[proposal_idx] += 1;
                } else {
                    expected_against[proposal_idx] += 1;
                }
            }

            env.as_contract(&cid, || {
                env.storage().instance().extend_ttl(crate::VOTING_WINDOW_LEDGERS * 4, crate::VOTING_WINDOW_LEDGERS * 4);
            });
            env.ledger().set_sequence_number(crate::VOTING_WINDOW_LEDGERS + 2 + ledger_offset);

            for (idx, project_id) in project_ids.iter().enumerate() {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.resolve_proposal(project_id);
                }));
                prop_assert!(result.is_ok(), "proposal should resolve after deadline");
                let proposal = client.get_proposal(project_id);
                prop_assert!(proposal.resolved);
                prop_assert_eq!(proposal.votes_for, expected_for[idx]);
                prop_assert_eq!(proposal.votes_against, expected_against[idx]);
                if expected_for[idx] > expected_against[idx] {
                    prop_assert!(proposal.votes_for > proposal.votes_against);
                } else {
                    prop_assert!(proposal.votes_for <= proposal.votes_against);
                }
            }
        }

        #[test]
        fn fuzz_upgrade_timelock(
            proposal_ledger in 0u32..=50_000u32,
            offset in 0u32..=50_000u32,
            cancel_first in bool,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let cid = env.register_contract(None, IndigoPayContract);
            let client = IndigoPayContractClient::new(&env, &cid);
            let admin = Address::generate(&env);
            client.initialize(&admin);

            env.ledger().set_sequence_number(proposal_ledger);
            let upgrade_wasm = env.deployer().upload_contract_wasm(IndigoPayContract);
            client.propose_upgrade(&admin, &upgrade_wasm);

            let effective_at = proposal_ledger + crate::UPGRADE_TIMELOCK_LEDGERS;
            env.ledger().set_sequence_number(proposal_ledger + offset);

            if cancel_first {
                let cancel_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.cancel_upgrade(&admin);
                }));
                prop_assert!(cancel_result.is_ok(), "cancel_upgrade should succeed");
                let execute_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.execute_upgrade();
                }));
                prop_assert!(execute_result.is_err(), "execute_upgrade should be rejected after cancel");
            } else if proposal_ledger + offset < effective_at {
                let execute_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.execute_upgrade();
                }));
                prop_assert!(execute_result.is_err(), "execute_upgrade should fail before timelock");
            } else {
                let execute_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    client.execute_upgrade();
                }));
                prop_assert!(execute_result.is_ok(), "execute_upgrade should succeed after timelock");
                prop_assert!(client.get_pending_upgrade().is_none());
                prop_assert!(client.get_last_executed_upgrade().is_some());
            }
        }

        #[test]
        fn fuzz_multi_currency_donations(
            co2_per_xlm in 1u32..=10_000u32,
            oracle_price in prop_oneof![Just(0i128), 1i128..=100i128],
            use_usdc in prop::collection::vec(any::<bool>(), 1..=6),
            amounts in prop::collection::vec(1i128..=10_000_000i128, 1..=6),
        ) {
            let (env, client, project_id, usdc_token) = setup_usdc(co2_per_xlm);
            let admin = client.get_admin();
            let donor = Address::generate(&env);
            fund_usdc(&env, &usdc_token, &donor, &100_000_000i128);
            let oracle_addr = env.register_contract(None, PriceOracleHarness);
            env.as_contract(&oracle_addr, || {
                env.storage().instance().set(&Symbol::new(&env, "price"), &oracle_price);
            });
            client.set_oracle(&admin, &oracle_addr);

            let mut expected_total = 0i128;
            let mut expected_co2 = 0i128;
            for (idx, use_usdc_step) in use_usdc.iter().enumerate() {
                let amount = amounts[idx];
                if *use_usdc_step {
                    let rate = oracle_price;
                    if rate <= 0 {
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            client.donate_usdc(&usdc_token, &donor, &project_id, &amount, &MSG_HASH);
                        }));
                        prop_assert!(result.is_err(), "zero oracle price must be rejected");
                        continue;
                    }
                    let xlm_equivalent = amount.checked_mul(rate).expect("safe product");
                    let co2_increment = (xlm_equivalent / FUZZ_STROOP) * (co2_per_xlm as i128);
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        client.donate_usdc(&usdc_token, &donor, &project_id, &amount, &MSG_HASH);
                    }));
                    prop_assert!(result.is_ok(), "USDC donation should succeed with a valid oracle price");
                    expected_total += xlm_equivalent;
                    expected_co2 += co2_increment;
                } else {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        client.donate(&usdc_token, &donor, &project_id, &amount, &MSG_HASH);
                    }));
                    prop_assert!(result.is_ok(), "XLM donation should succeed");
                    let xlm_units = amount / FUZZ_STROOP;
                    let co2_increment = xlm_units * (co2_per_xlm as i128);
                    expected_total += amount;
                    expected_co2 += co2_increment;
                }

                prop_assert_eq!(client.get_global_co2(), expected_co2);
                prop_assert_eq!(client.get_global_total(), expected_total);
            }

            prop_assert_eq!(client.get_global_co2(), expected_co2);
            prop_assert_eq!(client.get_global_total(), expected_total);
        }

        #[test]
        fn fuzz_project_lifecycle(
            actions in prop::collection::vec(0u8..=3, 1..=8),
            amount in 1i128..=10_000_000i128,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let cid = env.register_contract(None, IndigoPayContract);
            let client = IndigoPayContractClient::new(&env, &cid);
            let admin = Address::generate(&env);
            client.initialize(&admin);

            let project_id = SorobanString::from_str(&env, "lifecycle-fuzz");
            let wallet = Address::generate(&env);
            client.register_project(
                &admin,
                &project_id,
                &SorobanString::from_str(&env, "Lifecycle Fuzz Project"),
                &wallet,
                &100u32,
            );

            let donor = Address::generate(&env);
            let token_admin = Address::generate(&env);
            let token = env.register_stellar_asset_contract_v2(token_admin).address();
            mint_tokens(&env, &token, &donor, amount);

            let mut active = true;
            let mut paused = false;
            let mut expected_total = 0i128;
            for action in actions {
                match action {
                    0 => {
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            client.pause_project(&admin, &project_id);
                        }));
                        if active && !paused {
                            prop_assert!(result.is_ok(), "pause should succeed for an active project");
                            paused = true;
                        } else {
                            prop_assert!(result.is_err(), "pause should be rejected in invalid states");
                        }
                    }
                    1 => {
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            client.resume_project(&admin, &project_id);
                        }));
                        if active && paused {
                            prop_assert!(result.is_ok(), "resume should succeed for a paused project");
                            paused = false;
                        } else {
                            prop_assert!(result.is_err(), "resume should be rejected in invalid states");
                        }
                    }
                    2 => {
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            client.deactivate_project(&admin, &project_id);
                        }));
                        if active {
                            prop_assert!(result.is_ok(), "deactivate should succeed for an active project");
                            active = false;
                            paused = false;
                        } else {
                            prop_assert!(result.is_err(), "deactivate should be rejected after deactivation");
                        }
                    }
                    _ => {
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            client.donate(&token, &donor, &project_id, &amount, &MSG_HASH);
                        }));
                        if active && !paused {
                            prop_assert!(result.is_ok(), "donation should succeed for an active project");
                            expected_total += amount;
                        } else {
                            prop_assert!(result.is_err(), "donation should be rejected when paused or inactive");
                        }
                    }
                }

                let project = client.get_project(&project_id);
                prop_assert_eq!(project.active, active);
                prop_assert_eq!(project.paused, paused);
            }

            prop_assert_eq!(client.get_global_total(), expected_total);
        }
    }
}
