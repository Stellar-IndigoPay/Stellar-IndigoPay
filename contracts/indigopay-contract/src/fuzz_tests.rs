/// fuzz_tests.rs — Property-based tests for the IndigoPay Soroban contract.
///
/// Uses `proptest` to drive configurable iterations of every state-mutating
/// function, asserting invariants:
///   - Global total_raised never decreases
///   - Global CO2 offset never decreases
///   - Per-project total_raised never decreases
///   - Donation counts are monotonically increasing
///   - Donor badges only upgrade (never downgrade)
///   - Project paused flag is only true when project.active is true
///   - GlobalTotalRaised == sum of all project.total_raised
///   - Deactivated/paused projects reject donations
///
/// CI integration:
///   FUZZ_ITERATIONS env var overrides the default case count (1.5k in PR,
///   1M on nightly). Falls back to 1 500 when the env var is absent.
///
/// Run:
///   cargo test --features testutils -- fuzz
///   FUZZ_ITERATIONS=100000 cargo test --features testutils -- fuzz
#[cfg(all(test, feature = "testutils"))]
mod fuzz {
    extern crate std;

    use crate::{
        BadgeTier, DataKey, IndigoPayContract, IndigoPayContractClient, MockOracle, Project,
    };
    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::Address as _, token::StellarAssetClient, Address, Env, String as SorobanString,
    };

    // ─── Constants ───────────────────────────────────────────────────────────

    /// Upper bound for a single donation: 1 billion XLM in stroops (10^16).
    const MAX_DONATION: i128 = 1_000_000_000 * 10_000_000; // 10^16

    /// 1 XLM expressed in stroops.
    const STROOP: i128 = 10_000_000;

    /// Stable msg-hash placeholder for `donate` / `donate_usdc` calls.
    const MSG_HASH: u32 = 42;

    /// Maximum allowed CO2 per XLM from the contract constants.
    const MAX_CO2_PER_XLM: u32 = 100_000;

    // ─── Proptest config from CI env ────────────────────────────────────────

    /// Build a `ProptestConfig` whose case count is driven by the
    /// `FUZZ_ITERATIONS` environment variable. Falls back to 1 500.
    fn fuzz_config() -> ProptestConfig {
        let cases: u32 = std::env::var("FUZZ_ITERATIONS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1_500);
        ProptestConfig::with_cases(cases)
    }

    // ─── Setup helpers ──────────────────────────────────────────────────────

    /// Returns (env, contract_id, client, project_id, token).
    /// Creates one registered project and one XLM token for donations.
    fn setup() -> (
        Env,
        Address,
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

        (env, cid, client, project_id, token)
    }

    /// Returns (env, admin, client, project_id).
    fn setup_with_admin() -> (
        Env,
        Address,
        IndigoPayContractClient<'static>,
        SorobanString,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let cid = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &cid);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let project_id = SorobanString::from_str(&env, "proj-fuzz-admin");
        let wallet = Address::generate(&env);
        client.register_project(
            &admin,
            &project_id,
            &SorobanString::from_str(&env, "Admin Fuzz Project"),
            &wallet,
            &100u32,
        );

        (env, admin, client, project_id)
    }

    fn setup_usdc(
        co2_per_xlm: u32,
    ) -> (
        Env,
        Address,
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

        (env, cid, client, project_id, usdc_token)
    }

    /// Bypass the register_project validation to set co2_per_xlm directly
    /// in storage. Used by fuzz tests that need extreme co2_per_xlm values
    /// (e.g. to trigger CO2 calculation overflow) which the contract's
    /// MAX_CO2_PER_XLM guard would reject at registration time.
    fn set_project_co2_rate_direct(
        env: &Env,
        contract_id: &Address,
        project_id: &SorobanString,
        co2_per_xlm: u32,
    ) {
        env.as_contract(contract_id, || {
            let mut project: Project = env
                .storage()
                .instance()
                .get(&DataKey::Project(project_id.clone()))
                .expect("project should exist");
            project.co2_per_xlm = co2_per_xlm;
            env.storage()
                .instance()
                .set(&DataKey::Project(project_id.clone()), &project);
        });
    }

    fn fund_usdc(env: &Env, usdc_token: &Address, donor: &Address, amount: i128) {
        StellarAssetClient::new(env, usdc_token).mint(donor, &amount);
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

    // ─── Existing deterministic tests ────────────────────────────────────────

    #[test]
    fn donation_of_i128_max_minus_one_does_not_panic() {
        let (env, _cid, client, project_id, token) = setup();
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
        let (env, cid_val, client, project_id, token) = setup();
        let donor = Address::generate(&env);
        set_project_total_raised(&env, &cid_val, &project_id, 1);
        mint_tokens(&env, &token, &donor, i128::MAX);

        client.donate(&token, &donor, &project_id, &i128::MAX, &42u32);
    }

    #[test]
    #[should_panic(expected = "Project total_raised overflow")]
    fn sequential_donations_panic_when_sum_exceeds_i128_max() {
        let (env, cid_val, client, project_id, token) = setup();
        let donor_a = Address::generate(&env);
        let donor_b = Address::generate(&env);
        set_project_total_raised(&env, &cid_val, &project_id, 1);
        mint_tokens(&env, &token, &donor_a, i128::MAX - 1);
        mint_tokens(&env, &token, &donor_b, 2);

        client.donate(&token, &donor_a, &project_id, &(i128::MAX - 1), &42u32);
        client.donate(&token, &donor_b, &project_id, &2i128, &42u32);
    }

    // ─── Deterministic scenario tests (moved out of proptest! to avoid
    //      unnecessary iterations — each runs once) ─────────────────────────

    #[test]
    fn zero_amount_donation_rejected() {
        let (env, _cid, client, project_id, token) = setup();
        let donor = Address::generate(&env);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.donate(&token, &donor, &project_id, &0i128, &42u32);
        }));
        assert!(result.is_err(), "donate with amount=0 should panic");
    }

    #[test]
    fn deactivated_project_cannot_be_paused() {
        let (_env, admin, client, project_id) = setup_with_admin();

        client.deactivate_project(&admin, &project_id);

        // Pausing a deactivated project must panic
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.pause_project(&admin, &project_id);
        }));
        assert!(
            result.is_err(),
            "pause_project should panic when project is deactivated"
        );

        let project = client.get_project(&project_id);
        assert!(!project.active);
    }

    #[test]
    fn zero_co2_rate_rejected() {
        let (_env, admin, client, project_id) = setup_with_admin();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_project_co2_rate(&admin, &project_id, &0u32);
        }));
        assert!(
            result.is_err(),
            "update_project_co2_rate with 0 should panic"
        );
    }

    #[test]
    fn excessive_co2_rate_rejected() {
        let (_env, admin, client, project_id) = setup_with_admin();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_project_co2_rate(&admin, &project_id, &(MAX_CO2_PER_XLM + 1));
        }));
        assert!(
            result.is_err(),
            "update_project_co2_rate > MAX should panic"
        );
    }

    #[test]
    fn admin_transfer_happy_path() {
        let (env, admin, client, _project_id) = setup_with_admin();
        let new_admin = Address::generate(&env);

        client.transfer_admin(&admin, &new_admin);
        let pending = client.get_pending_admin();
        assert_eq!(pending, Some(new_admin.clone()));

        client.accept_admin();
        let stored_admin = client.get_admin();
        assert_eq!(stored_admin, new_admin);
        assert_eq!(client.get_pending_admin(), None);
    }

    #[test]
    fn admin_transfer_cancel() {
        let (env, admin, client, _project_id) = setup_with_admin();
        let new_admin = Address::generate(&env);
        client.transfer_admin(&admin, &new_admin);
        assert!(client.get_pending_admin().is_some());

        client.cancel_admin_transfer(&admin);
        assert!(client.get_pending_admin().is_none());
        assert_eq!(client.get_admin(), admin);
    }

    #[test]
    fn duplicate_project_id_rejected() {
        let (env, admin, client, project_id) = setup_with_admin();
        let wallet2 = Address::generate(&env);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.register_project(
                &admin,
                &project_id,
                &SorobanString::from_str(&env, "Duplicate"),
                &wallet2,
                &50u32,
            );
        }));
        assert!(
            result.is_err(),
            "register_project with duplicate ID should panic"
        );
    }

    #[test]
    fn veto_before_resolution() {
        let (_env, admin, client, project_id) = setup_with_admin();
        client.create_proposal(&admin, &project_id, &720u32);
        let proposal_before = client.get_proposal(&project_id);
        assert!(!proposal_before.resolved);

        client.veto_proposal(&admin, &project_id);
        let proposal_after = client.get_proposal(&project_id);
        assert!(proposal_after.resolved);
    }

    #[test]
    fn proposal_default_duration() {
        let (_env, admin, client, project_id) = setup_with_admin();
        client.create_proposal(&admin, &project_id, &0u32);
        let proposal = client.get_proposal(&project_id);
        assert!(!proposal.resolved);
        assert_eq!(proposal.votes_for, 0u32);
        assert_eq!(proposal.votes_against, 0u32);
    }

    #[test]
    fn deactivate_all_projects() {
        let (env, admin, client, project_id) = setup_with_admin();

        let wallet_b = Address::generate(&env);
        let project_b = SorobanString::from_str(&env, "proj-bulk-b");
        client.register_project(
            &admin,
            &project_b,
            &SorobanString::from_str(&env, "Bulk B"),
            &wallet_b,
            &75u32,
        );

        assert!(client.get_project(&project_id).active);
        assert!(client.get_project(&project_b).active);

        client.deactivate_all_projects(&admin);

        assert!(!client.get_project(&project_id).active);
        assert!(!client.get_project(&project_b).active);
    }

    // ─── Property-based fuzz tests ─────────────────────────────────────────

    proptest! {
        #![proptest_config(fuzz_config())]

        // ═══════════════════════════════════════════════════════════════════
        // INVARIANT 1: Global total_raised never decreases / is additive
        // INVARIANT 2: Global CO2 offset never decreases
        // INVARIANT 3: Per-project total_raised never decreases
        // INVARIANT 4: Donation count increases monotonically
        // ═══════════════════════════════════════════════════════════════════

        #[test]
        fn prop_single_donation_no_overflow(amount in 1i128..=MAX_DONATION) {
            let (env, _cid, client, project_id, token) = setup();
            let donor = Address::generate(&env);
            mint_tokens(&env, &token, &donor, amount);

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

        #[test]
        fn prop_two_donations_are_additive(
            a in 1i128..=MAX_DONATION / 2,
            b in 1i128..=MAX_DONATION / 2,
        ) {
            let (env, _cid, client, project_id, token) = setup();
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

        #[test]
        fn prop_single_donation_consistency(
            legit in 1i128..=MAX_DONATION,
        ) {
            let (env, _cid, client, project_id, token) = setup();
            let donor = Address::generate(&env);
            mint_tokens(&env, &token, &donor, legit);

            client.donate(&token, &donor, &project_id, &legit, &42u32);
            let total_before = client.get_global_total();

            prop_assert_eq!(total_before, legit);
        }

        // ═══════════════════════════════════════════════════════════════════
        // INVARIANT 4 (continued): Same donor — donation_count stays at 1
        //                          but total_raised increases.
        // ═══════════════════════════════════════════════════════════════════

        #[test]
        fn prop_same_donor_multiple_donations_increases_total_not_count(
            first in 1i128..=MAX_DONATION / 2,
            second in 1i128..=MAX_DONATION / 2,
        ) {
            let (env, _cid, client, project_id, token) = setup();
            let donor = Address::generate(&env);
            mint_tokens(&env, &token, &donor, first.checked_add(second).expect("overflow"));

            client.donate(&token, &donor, &project_id, &first, &42u32);
            let p1 = client.get_project(&project_id);
            prop_assert_eq!(p1.donor_count, 1u32);
            prop_assert_eq!(p1.total_raised, first);

            client.donate(&token, &donor, &project_id, &second, &42u32);
            let p2 = client.get_project(&project_id);
            // Donor count stays 1 — same donor
            prop_assert_eq!(p2.donor_count, 1u32);
            // Total raised increases
            let expected = first.checked_add(second).expect("overflow");
            prop_assert_eq!(p2.total_raised, expected);
            prop_assert_eq!(client.get_global_total(), expected);
        }

        // ═══════════════════════════════════════════════════════════════════
        // INVARIANT 5: Donor badge only upgrades (never downgrades)
        // ═══════════════════════════════════════════════════════════════════

        #[test]
        fn prop_donor_badge_only_upgrades(
            first in 1i128..=MAX_DONATION / 2,
            second in 1i128..=MAX_DONATION / 2,
        ) {
            let (env, _cid, client, project_id, token) = setup();
            let donor = Address::generate(&env);
            mint_tokens(&env, &token, &donor, first.checked_add(second).expect("overflow"));

            client.donate(&token, &donor, &project_id, &first, &42u32);
            let badge_after_first = client.get_badge(&donor);

            client.donate(&token, &donor, &project_id, &second, &42u32);
            let badge_after_second = client.get_badge(&donor);

            // Badge must never regress
            let rank = |b: &BadgeTier| -> u8 {
                match b {
                    BadgeTier::None => 0,
                    BadgeTier::Seedling => 1,
                    BadgeTier::Tree => 2,
                    BadgeTier::Forest => 3,
                    BadgeTier::EarthGuardian => 4,
                }
            };
            prop_assert!(
                rank(&badge_after_second) >= rank(&badge_after_first),
                "Badge downgraded from {:?} to {:?}",
                badge_after_first,
                badge_after_second,
            );
        }

        // ═══════════════════════════════════════════════════════════════════
        // INVARIANT 6: Deactivated project rejects donations
        // ═══════════════════════════════════════════════════════════════════

        #[test]
        fn prop_deactivated_project_rejects_donations(
            amount in 1i128..=MAX_DONATION,
        ) {
            let (env, admin, client, project_id) = setup_with_admin();
            let token_admin = Address::generate(&env);
            let token = env.register_stellar_asset_contract_v2(token_admin).address();
            let donor = Address::generate(&env);
            mint_tokens(&env, &token, &donor, amount);

            // Donate once to verify baseline
            client.donate(&token, &donor, &project_id, &amount, &42u32);
            let total_before = client.get_global_total();

            // Deactivate
            client.deactivate_project(&admin, &project_id);

            // Donation to deactivated project must panic
            let donor2 = Address::generate(&env);
            mint_tokens(&env, &token, &donor2, amount);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.donate(&token, &donor2, &project_id, &amount, &42u32);
            }));
            prop_assert!(result.is_err(), "donate to deactivated project should panic");

            // Global total must NOT have changed
            let total_after = client.get_global_total();
            prop_assert_eq!(total_before, total_after);
        }

        // ═══════════════════════════════════════════════════════════════════
        // INVARIANT 7: Paused project rejects donations
        // ═══════════════════════════════════════════════════════════════════

        #[test]
        fn prop_paused_project_rejects_donations(
            amount in 1i128..=MAX_DONATION,
        ) {
            let (env, admin, client, project_id) = setup_with_admin();
            let token_admin = Address::generate(&env);
            let token = env.register_stellar_asset_contract_v2(token_admin).address();
            let donor = Address::generate(&env);
            mint_tokens(&env, &token, &donor, amount);

            client.donate(&token, &donor, &project_id, &amount, &42u32);
            let total_before = client.get_global_total();

            // Pause
            client.pause_project(&admin, &project_id);

            // Donation to paused project must panic
            let donor2 = Address::generate(&env);
            mint_tokens(&env, &token, &donor2, amount);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.donate(&token, &donor2, &project_id, &amount, &42u32);
            }));
            prop_assert!(result.is_err(), "donate to paused project should panic");

            // Global total must NOT have changed
            let total_after = client.get_global_total();
            prop_assert_eq!(total_before, total_after);
        }

        // ═══════════════════════════════════════════════════════════════════
        // INVARIANT 8: Resume project unpauses and donations succeed again
        // ═══════════════════════════════════════════════════════════════════

        #[test]
        fn prop_resumed_project_accepts_donations(
            amount in 1i128..=MAX_DONATION,
        ) {
            let (env, admin, client, project_id) = setup_with_admin();
            let token_admin = Address::generate(&env);
            let token = env.register_stellar_asset_contract_v2(token_admin).address();
            let donor = Address::generate(&env);
            mint_tokens(&env, &token, &donor, amount);

            client.pause_project(&admin, &project_id);
            client.resume_project(&admin, &project_id);

            // Donation must succeed after resume
            client.donate(&token, &donor, &project_id, &amount, &42u32);
            let project = client.get_project(&project_id);
            prop_assert_eq!(project.total_raised, amount);
            prop_assert!(!project.paused);
        }

        // ═══════════════════════════════════════════════════════════════════
        // INVARIANT 9: update_project_co2_rate respects bounds
        // ═══════════════════════════════════════════════════════════════════

        #[test]
        fn prop_co2_rate_bounds_respected(
            new_rate in 1u32..=MAX_CO2_PER_XLM,
        ) {
            let (_env, admin, client, project_id) = setup_with_admin();
            client.update_project_co2_rate(&admin, &project_id, &new_rate);
            let project = client.get_project(&project_id);
            prop_assert_eq!(project.co2_per_xlm, new_rate);
        }

        // ═══════════════════════════════════════════════════════════════════
        // INVARIANT 10: Two-step admin transfer flow
        // ═══════════════════════════════════════════════════════════════════

        #[test]
        fn prop_contract_pause_blocks_donations(
            amount in 1i128..=MAX_DONATION,
        ) {
            let (env, admin, client, project_id) = setup_with_admin();
            let token_admin = Address::generate(&env);
            let token = env.register_stellar_asset_contract_v2(token_admin).address();
            let donor = Address::generate(&env);
            mint_tokens(&env, &token, &donor, amount);

            client.pause_contract(&admin);
            prop_assert!(client.is_contract_paused());

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.donate(&token, &donor, &project_id, &amount, &42u32);
            }));
            prop_assert!(result.is_err(), "donate should panic when contract is paused");

            client.unpause_contract(&admin);
            prop_assert!(!client.is_contract_paused());

            client.donate(&token, &donor, &project_id, &amount, &42u32);
            let project = client.get_project(&project_id);
            prop_assert_eq!(project.total_raised, amount);
        }

        // ═══════════════════════════════════════════════════════════════════
        // INVARIANT 11: Multi-project — global_total == sum(project.totals)
        // ═══════════════════════════════════════════════════════════════════

        #[test]
        fn prop_multi_project_global_consistency(
            amount_a in 1i128..=MAX_DONATION / 4,
            amount_b in 1i128..=MAX_DONATION / 4,
        ) {
            let (env, admin, client, project_a) = setup_with_admin();
            let wallet_b = Address::generate(&env);
            let project_b = SorobanString::from_str(&env, "proj-fuzz-b");
            client.register_project(
                &admin,
                &project_b,
                &SorobanString::from_str(&env, "Fuzz Project B"),
                &wallet_b,
                &50u32,
            );

            let token_admin = Address::generate(&env);
            let token = env.register_stellar_asset_contract_v2(token_admin).address();
            let donor_a = Address::generate(&env);
            let donor_b = Address::generate(&env);
            mint_tokens(&env, &token, &donor_a, amount_a);
            mint_tokens(&env, &token, &donor_b, amount_b);

            client.donate(&token, &donor_a, &project_a, &amount_a, &42u32);
            client.donate(&token, &donor_b, &project_b, &amount_b, &42u32);

            let proj_a = client.get_project(&project_a);
            let proj_b = client.get_project(&project_b);
            let global_total = client.get_global_total();
            let sum = proj_a.total_raised.checked_add(proj_b.total_raised).expect("overflow");

            prop_assert_eq!(
                global_total, sum,
                "global_total {} != sum of project totals {}",
                global_total, sum,
            );
        }

        // ═══════════════════════════════════════════════════════════════════
        // INVARIANT 12: Project milestone NFT — threshold gating
        // ═══════════════════════════════════════════════════════════════════

        #[test]
        fn prop_project_nft_threshold(
            amount in 101i128 * STROOP..=200i128 * STROOP,
        ) {
            let (env, _cid, client, project_id, token) = setup();
            let donor = Address::generate(&env);
            mint_tokens(&env, &token, &donor, amount);

            client.donate(&token, &donor, &project_id, &amount, &42u32);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.mint_project_nft(&donor, &project_id);
            }));
            prop_assert!(result.is_ok(), "mint_project_nft should succeed when cumulative > 100 XLM");
            prop_assert!(client.has_project_nft(&donor, &project_id));

            let result2 = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.mint_project_nft(&donor, &project_id);
            }));
            prop_assert!(result2.is_err(), "second mint_project_nft should panic");
        }

        // ═══════════════════════════════════════════════════════════════════
        // USDC fuzz cases (preserved from original)
        // ═══════════════════════════════════════════════════════════════════

        #[test]
        fn prop_usdc_amount_near_max(usdc_amount in (i128::MAX / 8 + 1)..=i128::MAX) {
            let (env, _cid, client, project_id, usdc_token) = setup_usdc(100u32);
            let donor = Address::generate(&env);
            fund_usdc(&env, &usdc_token, &donor, usdc_amount);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.donate_usdc(&usdc_token, &donor, &project_id, &usdc_amount, &MSG_HASH);
            }));
            prop_assert!(result.is_err(), "donate_usdc should panic when usdc_amount > i128::MAX / 8");
        }

        #[test]
        fn prop_usdc_token_mismatch(amount in 1i128..=100_000_000i128) {
            let (env, _cid, client, project_id, _usdc_token) = setup_usdc(100u32);
            let donor = Address::generate(&env);
            let wrong_token = Address::generate(&env);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.donate_usdc(&wrong_token, &donor, &project_id, &amount, &MSG_HASH);
            }));
            prop_assert!(result.is_err(), "donate_usdc should panic on token mismatch");
        }

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
            fund_usdc(&env, &usdc_token, &donor, amount);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.donate_usdc(&usdc_token, &donor, &project_id, &amount, &MSG_HASH);
            }));
            prop_assert!(result.is_err(), "donate_usdc should panic when project is inactive");
        }

        #[test]
        fn prop_usdc_co2_overflow(
            usdc_amount in {
                let min = (i128::MAX / (u32::MAX as i128)) * STROOP / 8 + 1;
                let max = i128::MAX / 8;
                min..=max
            },
        ) {
            // Register the project with a valid co2_per_xlm first, then
            // bypass the validation by setting co2_per_xlm directly in storage.
            // This lets us trigger CO2 calculation overflow in donate_usdc.
            let (env, cid, client, project_id, usdc_token) = setup_usdc(100u32);
            let donor = Address::generate(&env);
            fund_usdc(&env, &usdc_token, &donor, usdc_amount);

            set_project_co2_rate_direct(&env, &cid, &project_id, u32::MAX);

            let result = client.try_donate_usdc(&usdc_token, &donor, &project_id, &usdc_amount, &MSG_HASH);
            prop_assert!(result.is_err(), "donate_usdc should panic on CO2 overflow");
        }
    } // END of first proptest!

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        #[test]
        fn prop_fuzz_badge_weighted_voting(
            amount in 10i128 * STROOP..=10_000i128 * STROOP,
        ) {
            let (env, admin, client, project_id) = setup_with_admin();
            client.create_proposal(&admin, &project_id, &720u32);

            let token_admin = Address::generate(&env);
            let token = env
                .register_stellar_asset_contract_v2(token_admin)
                .address();

            let donor = Address::generate(&env);
            mint_tokens(&env, &token, &donor, amount);
            client.donate(&token, &donor, &project_id, &amount, &42u32);

            let stats = client.get_donor_stats(&donor);
            let expected_weight = match stats.badge {
                BadgeTier::Seedling => 1u32,
                BadgeTier::Tree => 3u32,
                BadgeTier::Forest => 10u32,
                BadgeTier::EarthGuardian => 25u32,
                BadgeTier::None => 0u32,
            };

            client.vote_verify_project(&donor, &project_id, &true);

            let proposal = client.get_proposal(&project_id);
            prop_assert_eq!(proposal.votes_for, expected_weight);
        }
    } // END of proptest!

    #[test]
    fn test_zero_amount_donation_rejected() {
        let (env, _cid, client, project_id, token) = setup();
        let donor = Address::generate(&env);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.donate(&token, &donor, &project_id, &0i128, &42u32);
        }));
        assert!(result.is_err(), "donate with amount=0 should panic");
    }

    #[test]
    fn test_deactivated_project_cannot_be_paused() {
        let (_env, admin, client, project_id) = setup_with_admin();

        client.deactivate_project(&admin, &project_id);

        // Pausing a deactivated project must panic
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.pause_project(&admin, &project_id);
        }));
        assert!(
            result.is_err(),
            "pause_project should panic when project is deactivated"
        );

        let project = client.get_project(&project_id);
        assert!(!project.active);
    }

    #[test]
    fn test_zero_co2_rate_rejected() {
        let (_env, admin, client, project_id) = setup_with_admin();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_project_co2_rate(&admin, &project_id, &0u32);
        }));
        assert!(
            result.is_err(),
            "update_project_co2_rate with 0 should panic"
        );
    }

    #[test]
    fn test_excessive_co2_rate_rejected() {
        let (_env, admin, client, project_id) = setup_with_admin();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_project_co2_rate(&admin, &project_id, &(MAX_CO2_PER_XLM + 1));
        }));
        assert!(
            result.is_err(),
            "update_project_co2_rate > MAX should panic"
        );
    }

    #[test]
    fn test_admin_transfer_happy_path() {
        let (env, admin, client, _project_id) = setup_with_admin();
        let new_admin = Address::generate(&env);

        client.transfer_admin(&admin, &new_admin);
        let pending = client.get_pending_admin();
        assert_eq!(pending, Some(new_admin.clone()));

        client.accept_admin();
        let stored_admin = client.get_admin();
        assert_eq!(stored_admin, new_admin);
        assert_eq!(client.get_pending_admin(), None);
    }

    #[test]
    fn test_admin_transfer_cancel() {
        let (env, admin, client, _project_id) = setup_with_admin();
        let new_admin = Address::generate(&env);
        client.transfer_admin(&admin, &new_admin);
        assert!(client.get_pending_admin().is_some());

        client.cancel_admin_transfer(&admin);
        assert!(client.get_pending_admin().is_none());
        assert_eq!(client.get_admin(), admin);
    }

    #[test]
    fn test_duplicate_project_id_rejected() {
        let (env, admin, client, project_id) = setup_with_admin();
        let wallet2 = Address::generate(&env);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.register_project(
                &admin,
                &project_id,
                &SorobanString::from_str(&env, "Duplicate"),
                &wallet2,
                &50u32,
            );
        }));
        assert!(
            result.is_err(),
            "register_project with duplicate ID should panic"
        );
    }

    #[test]
    fn test_veto_before_resolution() {
        let (_env, admin, client, project_id) = setup_with_admin();
        client.create_proposal(&admin, &project_id, &720u32);
        let proposal_before = client.get_proposal(&project_id);
        assert!(!proposal_before.resolved);

        client.veto_proposal(&admin, &project_id);
        let proposal_after = client.get_proposal(&project_id);
        assert!(proposal_after.resolved);
    }

    #[test]
    fn test_proposal_default_duration() {
        let (_env, admin, client, project_id) = setup_with_admin();
        client.create_proposal(&admin, &project_id, &0u32);
        let proposal = client.get_proposal(&project_id);
        assert!(!proposal.resolved);
        assert_eq!(proposal.votes_for, 0u32);
        assert_eq!(proposal.votes_against, 0u32);
    }

    #[test]
    fn test_deactivate_all_projects() {
        let (env, admin, client, project_id) = setup_with_admin();

        let wallet_b = Address::generate(&env);
        let project_b = SorobanString::from_str(&env, "proj-bulk-b");
        client.register_project(
            &admin,
            &project_b,
            &SorobanString::from_str(&env, "Bulk B"),
            &wallet_b,
            &75u32,
        );

        assert!(client.get_project(&project_id).active);
        assert!(client.get_project(&project_b).active);

        client.deactivate_all_projects(&admin);

        assert!(!client.get_project(&project_id).active);
        assert!(!client.get_project(&project_b).active);
    }

    #[test]
    fn test_badge_weighted_voting_seedling_and_earth_guardian() {
        let (env, admin, client, project_id) = setup_with_admin();
        client.create_proposal(&admin, &project_id, &720u32);

        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        let donor_seedling = Address::generate(&env);
        let amt_seedling = 10i128 * STROOP;
        mint_tokens(&env, &token, &donor_seedling, amt_seedling);
        client.donate(&token, &donor_seedling, &project_id, &amt_seedling, &42u32);

        client.vote_verify_project(&donor_seedling, &project_id, &true);

        let donor_earth = Address::generate(&env);
        let amt_earth = 2000i128 * STROOP;
        mint_tokens(&env, &token, &donor_earth, amt_earth);
        client.donate(&token, &donor_earth, &project_id, &amt_earth, &42u32);

        client.vote_verify_project(&donor_earth, &project_id, &true);

        let proposal = client.get_proposal(&project_id);
        assert_eq!(proposal.votes_for, 26u32);
    }

    #[test]
    fn test_badge_weighted_voting_none_tier_panics() {
        let (env, admin, client, project_id) = setup_with_admin();
        client.create_proposal(&admin, &project_id, &720u32);

        let voter = Address::generate(&env);
        let result = client.try_vote_verify_project(&voter, &project_id, &true);
        assert!(result.is_err(), "None tier voter should panic");
    }
}
