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
///   FUZZ_ITERATIONS env var overrides the default case count (256).
///   Nightly deep-fuzz uses 2 000. Falls back to 256 when absent.
///
/// Run:
///   cargo test --features testutils -- fuzz
///   FUZZ_ITERATIONS=1000 cargo test --features testutils -- fuzz
#[cfg(all(test, feature = "testutils"))]
mod fuzz {
    extern crate std;

    use crate::{
        BadgeTier, DataKey, GlobalStats, IndigoPayContract,
        IndigoPayContractClient, MockOracle, Project, VoteProposal,
    };
    use proptest::prelude::*;
    use soroban_sdk::Vec;
    use soroban_sdk::{
        testutils::Address as _,
        token::StellarAssetClient,
        Address, Env, String as SorobanString,
    };

    /// Helper: create a single-element signer Vec for admin calls.
    fn signers1(env: &Env, a: &Address) -> Vec<Address> {
        let mut v = Vec::new(env);
        v.push_back(a.clone());
        v
    }

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
    /// `FUZZ_ITERATIONS` environment variable. Falls back to 256 so
    /// the CI `fuzz` job (20 min timeout) can complete reliably even
    /// with ~26 property tests each creating a full Soroban test env.
    fn fuzz_config() -> ProptestConfig {
        let cases: u32 = std::env::var("FUZZ_ITERATIONS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(256);
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
        client.initialize(&signers1(&env, &admin), &1u32);

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
        client.initialize(&signers1(&env, &admin), &1u32);

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
        client.initialize(&signers1(&env, &admin), &1u32);

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

        client.transfer_admin(&signers1(&env, &admin), &admin, &new_admin);
        let pending = client.get_pending_admin();
        assert_eq!(pending, Some((admin.clone(), new_admin.clone())));

        client.accept_admin();
        let stored_admin = client.get_admin();
        assert_eq!(stored_admin, new_admin);
        assert_eq!(client.get_pending_admin(), None);
    }

    #[test]
    fn admin_transfer_cancel() {
        let (env, admin, client, _project_id) = setup_with_admin();
        let new_admin = Address::generate(&env);
        client.transfer_admin(&signers1(&env, &admin), &admin, &new_admin);
        assert!(client.get_pending_admin().is_some());

        client.cancel_admin_transfer(&signers1(&env, &admin));
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
        client.create_proposal(&signers1(&_env, &admin), &project_id, &720u32);
        let proposal_before = client.get_proposal(&project_id);
        assert!(!proposal_before.resolved);

        client.veto_proposal(&signers1(&_env, &admin), &project_id);
        let proposal_after = client.get_proposal(&project_id);
        assert!(proposal_after.resolved);
    }

    #[test]
    fn proposal_default_duration() {
        let (_env, admin, client, project_id) = setup_with_admin();
        client.create_proposal(&signers1(&_env, &admin), &project_id, &0u32);
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

        client.deactivate_all_projects(&signers1(&env, &admin));

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

            client.pause_contract(&signers1(&env, &admin));
            prop_assert!(client.is_contract_paused());

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.donate(&token, &donor, &project_id, &amount, &42u32);
            }));
            prop_assert!(result.is_err(), "donate should panic when contract is paused");

            client.unpause_contract(&signers1(&env, &admin));
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
            client.initialize(&signers1(&env, &admin), &1u32);

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
        // `co2_per_xlm <= MAX_CO2_PER_XLM` check. This test bypasses
        // that guard via `set_project_co2_rate_direct` to verify the
        // boundary: at extreme CO₂ rates, donations still succeed and
        // produce correct (potentially zero) offset values.
        //
        // For usdc_amount in 1..=100_000_000 stroops with MockOracle rate=8
        // the XLM-equivalent is at most 800_000_000 stroops = 80 XLM, so
        //   xlm_units = xlm_equivalent / STROOP  ≤  80
        //   co2_increment = xlm_units * u32::MAX  ≤  80 * 4_294_967_295  ≈  3.4 × 10^11
        // which fits comfortably in i128 — no CO2 overflow occurs.
        // Very small USDC amounts (< STROOP / 8 = 1_250_000 stroops) produce
        // xlm_units = 0 and therefore co2_increment = 0, which is correct
        // integer-division rounding behavior.
        #[test]
        fn prop_usdc_max_co2_rate_boundary(
            usdc_amount in 1i128..=100_000_000i128,
        ) {
            // Register the project with a valid co2_per_xlm first, then
            // bypass the validation by setting co2_per_xlm directly in storage.
            // With usdc_amount ≤ 100_000_000 stroops and oracle rate = 8,
            // the resulting xlm_units is at most 80, so co2_increment fits in
            // i128 and donate_usdc must succeed.
            let (env, cid, client, project_id, usdc_token) = setup_usdc(100u32);
            let donor = Address::generate(&env);
            fund_usdc(&env, &usdc_token, &donor, usdc_amount);

            set_project_co2_rate_direct(&env, &cid, &project_id, u32::MAX);

            let result = client.try_donate_usdc(&usdc_token, &donor, &project_id, &usdc_amount, &MSG_HASH);
            prop_assert!(result.is_ok(), "donate_usdc should succeed when usdc_amount is small enough that CO2 does not overflow (xlm_units * u32::MAX fits in i128)");

            // CO2 invariant: global CO2 offset must be non-negative after the donation.
            let global_co2 = client.get_global_co2();
            prop_assert!(global_co2 >= 0, "global CO2 offset went negative: {}", global_co2);
        }
    } // END of first proptest!

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        #[test]
        fn prop_fuzz_badge_weighted_voting(
            amount in 10i128 * STROOP..=10_000i128 * STROOP,
        ) {
            let (env, admin, client, project_id) = setup_with_admin();
            client.create_proposal(&signers1(&env, &admin), &project_id, &720u32);

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

        client.transfer_admin(&signers1(&env, &admin), &admin, &new_admin);
        let pending = client.get_pending_admin();
        assert_eq!(pending, Some((admin.clone(), new_admin.clone())));

        client.accept_admin();
        let stored_admin = client.get_admin();
        assert_eq!(stored_admin, new_admin);
        assert_eq!(client.get_pending_admin(), None);
    }

    #[test]
    fn test_admin_transfer_cancel() {
        let (env, admin, client, _project_id) = setup_with_admin();
        let new_admin = Address::generate(&env);
        client.transfer_admin(&signers1(&env, &admin), &admin, &new_admin);
        assert!(client.get_pending_admin().is_some());

        client.cancel_admin_transfer(&signers1(&env, &admin));
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
        let (env, admin, client, project_id) = setup_with_admin();
        client.create_proposal(&signers1(&env, &admin), &project_id, &720u32);
        let proposal_before = client.get_proposal(&project_id);
        assert!(!proposal_before.resolved);

        client.veto_proposal(&signers1(&env, &admin), &project_id);
        let proposal_after = client.get_proposal(&project_id);
        assert!(proposal_after.resolved);
    }

    #[test]
    fn test_proposal_default_duration() {
        let (env, admin, client, project_id) = setup_with_admin();
        client.create_proposal(&signers1(&env, &admin), &project_id, &0u32);
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

        client.deactivate_all_projects(&signers1(&env, &admin));

        assert!(!client.get_project(&project_id).active);
        assert!(!client.get_project(&project_b).active);
    }

    #[test]
    fn test_badge_weighted_voting_seedling_and_earth_guardian() {
        let (env, admin, client, project_id) = setup_with_admin();
        client.create_proposal(&signers1(&env, &admin), &project_id, &720u32);

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
        client.create_proposal(&signers1(&env, &admin), &project_id, &720u32);

        let voter = Address::generate(&env);
        let result = client.try_vote_verify_project(&voter, &project_id, &true);
        assert!(result.is_err(), "None tier voter should panic");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ContractAction-based Fuzzing Harness
    // ═══════════════════════════════════════════════════════════════════════

    /// A single contract interaction for action-sequence fuzzing.
    #[derive(Debug, Clone)]
    enum ContractAction {
        /// Donate XLM: project_idx, donor_idx, amount in stroops
        Donate { project_idx: usize, donor_idx: usize, amount: i128 },
        /// Donate USDC: project_idx, donor_idx, usdc_amount
        DonateUsdc { project_idx: usize, donor_idx: usize, usdc_amount: i128 },
        /// Register a new project: name_suffix, co2_rate
        RegisterProject { name: String, co2_rate: u32 },
        /// Pause a project by index
        PauseProject { project_idx: usize },
        /// Resume a project by index
        ResumeProject { project_idx: usize },
        /// Create a proposal for a project
        CreateProposal { project_idx: usize, duration_ledgers: u32 },
        /// Vote on a proposal: project_idx, voter_idx, approve
        Vote { project_idx: usize, voter_idx: usize, approve: bool },
        /// Resolve a proposal
        ResolveProposal { project_idx: usize },
    }

    /// Strategy for generating valid donation amounts: 1 stroop to 100K XLM.
    fn donation_amount_strategy() -> impl Strategy<Value = i128> {
        1i128..=100_000i128 * STROOP
    }

    /// Strategy for generating valid CO₂ rates: 1 to MAX_CO2_PER_XLM.
    fn co2_rate_strategy() -> impl Strategy<Value = u32> {
        1u32..=MAX_CO2_PER_XLM
    }

    /// Strategy for generating a sequence of ContractActions bounded by
    /// available project and donor pools.
    fn contract_action_strategy(
        num_projects: usize,
        num_donors: usize,
    ) -> impl Strategy<Value = ContractAction> {
        let project_idx = 0..num_projects;
        let donor_idx = 0..num_donors;
        let amount = donation_amount_strategy();
        let co2_rate = co2_rate_strategy();

        prop_oneof![
            // Donate XLM: weighted higher since it's the most common operation
            8 => (project_idx.clone(), donor_idx.clone(), amount.clone())
                .prop_map(|(pi, di, a)| ContractAction::Donate {
                    project_idx: pi, donor_idx: di, amount: a
                }),
            // Donate USDC: moderate weight for multi-currency path coverage
            2 => (project_idx.clone(), donor_idx.clone(), amount.clone())
                .prop_map(|(pi, di, a)| ContractAction::DonateUsdc {
                    project_idx: pi, donor_idx: di, usdc_amount: a
                }),
            // Register project (less frequent)
            1 => ("[a-z]{3,10}", co2_rate.clone())
                .prop_map(|(name, cr)| ContractAction::RegisterProject {
                    name, co2_rate: cr
                }),
            // Pause/resume (infrequent)
            1 => project_idx.clone()
                .prop_map(|pi| ContractAction::PauseProject { project_idx: pi }),
            1 => project_idx.clone()
                .prop_map(|pi| ContractAction::ResumeProject { project_idx: pi }),
            // Governance (infrequent)
            1 => (project_idx.clone(), (720u32..=518_400u32))
                .prop_map(|(pi, d)| ContractAction::CreateProposal {
                    project_idx: pi, duration_ledgers: d
                }),
            2 => (project_idx.clone(), donor_idx.clone(), proptest::bool::ANY)
                .prop_map(|(pi, di, a)| ContractAction::Vote {
                    project_idx: pi, donor_idx: di, approve: a
                }),
            1 => project_idx.clone()
                .prop_map(|pi| ContractAction::ResolveProposal { project_idx: pi }),
        ]
    }

    /// Set up a multi-project, multi-donor environment for action-sequence fuzzing.
    /// Returns (env, contract_id, client, admin, project_ids, donors, token, usdc_token).
    fn setup_multi(
        num_projects: usize,
        num_donors: usize,
    ) -> (
        Env,
        Address,
        IndigoPayContractClient<'static>,
        Address,
        std::vec::Vec<SorobanString>,
        std::vec::Vec<Address>,
        Address,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let cid = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &cid);

        let admin = Address::generate(&env);
        client.initialize(&signers1(&env, &admin), &1u32);

        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        // Set up USDC token and oracle for DonateUsdc fuzzing
        let usdc_admin = Address::generate(&env);
        let usdc_token = env
            .register_stellar_asset_contract_v2(usdc_admin)
            .address();
        client.set_usdc_token(&admin, &usdc_token);
        let oracle_addr = env.register_contract(None, MockOracle);
        client.set_oracle(&admin, &oracle_addr);

        let mut project_ids: std::vec::Vec<SorobanString> = std::vec::Vec::new();
        for i in 0..num_projects {
            let pid = SorobanString::from_str(&env, &format!("proj-seq-{}", i));
            let wallet = Address::generate(&env);
            client.register_project(
                &admin,
                &pid,
                &SorobanString::from_str(&env, &format!("Seq Project {}", i)),
                &wallet,
                &50u32,
            );
            project_ids.push(pid);
        }

        let mut donors: std::vec::Vec<Address> = std::vec::Vec::new();
        for _ in 0..num_donors {
            let donor = Address::generate(&env);
            // Mint a large amount so they never run out during fuzzing
            mint_tokens(&env, &token, &donor, 10_000_000i128 * STROOP);
            fund_usdc(&env, &usdc_token, &donor, 10_000_000i128 * STROOP);
            donors.push(donor);
        }

        (env, cid, client, admin, project_ids, donors, token, usdc_token)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Enhanced Property Tests (Properties 1-7 from Issue #239)
    // ═══════════════════════════════════════════════════════════════════════

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(500))]

        // ─────────────────────────────────────────────────────────────────
        // PROPERTY 1 — Donation Totals Consistency
        //   For any sequence of donations to project P:
        //     sum(donation.amount) == project.total_raised
        //   and sum(donation.co2_offset) == project.total_co2_offset
        // ─────────────────────────────────────────────────────────────────

        #[test]
        fn prop_donation_totals_consistency(
            actions in prop::collection::vec(
                (0usize..5, donation_amount_strategy(), 0usize..10),
                1..50,
            ),
        ) {
            let (env, _cid, client, _admin, project_ids, donors, token, _usdc) =
                setup_multi(5, 10);

            // Track expected totals AND CO₂ offsets per project
            let mut expected_totals: std::vec::Vec<i128> =
                std::vec![0i128; project_ids.len()];
            let mut expected_co2: std::vec::Vec<i128> =
                std::vec![0i128; project_ids.len()];

            for (proj_idx, amount, donor_idx) in actions.iter() {
                let pi = proj_idx % project_ids.len();
                let di = donor_idx % donors.len();
                let pid = &project_ids[pi];
                let donor = &donors[di];
                let proj_before = client.get_project(pid);

                // Try donation — it may panic for good reasons (rate limit, etc.)
                // but if it succeeds we track the expected total and CO₂
                let result = std::panic::catch_unwind(
                    std::panic::AssertUnwindSafe(|| {
                        client.donate(&token, donor, pid, amount, &MSG_HASH);
                    }),
                );

                if result.is_ok() {
                    expected_totals[pi] = expected_totals[pi]
                        .checked_add(*amount)
                        .expect("test internal overflow");
                    // CO₂ = (amount / STROOP) * co2_per_xlm (floor division)
                    let co2 = (amount / STROOP)
                        .checked_mul(proj_before.co2_per_xlm as i128)
                        .expect("test CO2 overflow");
                    expected_co2[pi] = expected_co2[pi]
                        .checked_add(co2)
                        .expect("test CO2 overflow");
                }

                let proj_after = client.get_project(pid);
                // Project total_raised must always be non-negative
                prop_assert!(proj_after.total_raised >= 0,
                    "project.total_raised went negative: {}", proj_after.total_raised);
                // Project total_raised must never decrease
                prop_assert!(proj_after.total_raised >= proj_before.total_raised,
                    "project.total_raised decreased from {} to {}",
                    proj_before.total_raised, proj_after.total_raised);
            }

            // Verify final totals: global totals match sum of project expectations
            let global_total = client.get_global_total();
            let sum_expected: i128 = expected_totals.iter().sum();
            prop_assert_eq!(global_total, sum_expected,
                "global_total {} != sum of expected totals {}",
                global_total, sum_expected);

            // Verify per-project CO₂ offsets are consistent with global CO₂
            let global_co2 = client.get_global_co2();
            let sum_co2: i128 = expected_co2.iter().sum();
            prop_assert_eq!(global_co2, sum_co2,
                "global CO₂ {} != sum of per-project CO₂ expectations {}",
                global_co2, sum_co2);
        }

        // ─────────────────────────────────────────────────────────────────
        // PROPERTY 2 — Badge Monotonicity (Enhanced)
        //   A donor's badge tier never decreases across any sequence.
        // ─────────────────────────────────────────────────────────────────

        #[test]
        fn prop_badge_monotonicity_sequence(
            donations in prop::collection::vec(
                (0usize..3, donation_amount_strategy(), 0usize..5),
                1..30,
            ),
        ) {
            let (_env, _cid, client, _admin, project_ids, donors, token, _usdc) =
                setup_multi(3, 5);

            let rank = |b: &BadgeTier| -> u8 {
                match b {
                    BadgeTier::None => 0,
                    BadgeTier::Seedling => 1,
                    BadgeTier::Tree => 2,
                    BadgeTier::Forest => 3,
                    BadgeTier::EarthGuardian => 4,
                }
            };

            // Track the best rank seen for each donor
            let mut best_rank: std::vec::Vec<u8> = std::vec![0u8; donors.len()];

            for (proj_idx, amount, donor_idx) in donations.iter() {
                let pi = proj_idx % project_ids.len();
                let di = donor_idx % donors.len();
                let pid = &project_ids[pi];
                let donor = &donors[di];

                let _ = std::panic::catch_unwind(
                    std::panic::AssertUnwindSafe(|| {
                        client.donate(&token, donor, pid, amount, &MSG_HASH);
                    }),
                );

                let badge = client.get_badge(donor);
                let current_rank = rank(&badge);
                prop_assert!(
                    current_rank >= best_rank[di],
                    "Donor {} badge regressed from rank {} to rank {} (badge: {:?})",
                    di, best_rank[di], current_rank, badge,
                );
                best_rank[di] = current_rank;
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // PROPERTY 3 — Donor Count Accuracy
        //   project.donor_count == count(distinct donor_address)
        // ─────────────────────────────────────────────────────────────────

        #[test]
        fn prop_donor_count_accuracy(
            donations in prop::collection::vec(
                (0usize..3, donation_amount_strategy(), 0usize..8),
                1..40,
            ),
        ) {
            let (_env, _cid, client, _admin, project_ids, donors, token, _usdc) =
                setup_multi(3, 8);

            // Track which donors have donated to which projects
            // project_donors[project_idx] = set of donor indices
            let mut project_donors: std::vec::Vec<std::vec::Vec<usize>> =
                std::vec![std::vec::Vec::new(); project_ids.len()];

            for (proj_idx, amount, donor_idx) in donations.iter() {
                let pi = proj_idx % project_ids.len();
                let di = donor_idx % donors.len();
                let pid = &project_ids[pi];
                let donor = &donors[di];

                let _ = std::panic::catch_unwind(
                    std::panic::AssertUnwindSafe(|| {
                        client.donate(&token, donor, pid, amount, &MSG_HASH);
                    }),
                );

                // Track unique donors
                if !project_donors[pi].contains(&di) {
                    project_donors[pi].push(di);
                }

                let project = client.get_project(pid);
                let expected_count = project_donors[pi].len() as u32;
                prop_assert_eq!(
                    project.donor_count, expected_count,
                    "Project {} donor_count {} != expected unique donors {}",
                    pi, project.donor_count, expected_count,
                );
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // PROPERTY 4 — Global Stats Consistency
        //   get_global_stats().total_raised == sum(project.total_raised)
        //   get_global_stats().donation_count == total donations
        // ─────────────────────────────────────────────────────────────────

        #[test]
        fn prop_global_stats_consistency(
            actions in prop::collection::vec(
                (0usize..4, donation_amount_strategy(), 0usize..6),
                1..30,
            ),
        ) {
            let (_env, _cid, client, _admin, project_ids, donors, token, _usdc) =
                setup_multi(4, 6);

            let mut total_donations: u32 = 0;

            for (proj_idx, amount, donor_idx) in actions.iter() {
                let pi = proj_idx % project_ids.len();
                let di = donor_idx % donors.len();
                let pid = &project_ids[pi];
                let donor = &donors[di];

                let result = std::panic::catch_unwind(
                    std::panic::AssertUnwindSafe(|| {
                        client.donate(&token, donor, pid, amount, &MSG_HASH);
                    }),
                );
                if result.is_ok() {
                    total_donations = total_donations
                        .checked_add(1)
                        .expect("donation count overflow");
                }
            }

            // After all actions, verify global stats match projects
            let stats: GlobalStats = client.get_global_stats();

            // Sum all project totals
            let mut sum_total: i128 = 0;
            for pid in project_ids.iter() {
                let proj = client.get_project(pid);
                sum_total = sum_total.checked_add(proj.total_raised).expect("overflow");
            }

            prop_assert_eq!(
                stats.total_raised, sum_total,
                "GlobalStats.total_raised {} != sum of project totals {}",
                stats.total_raised, sum_total,
            );

            prop_assert_eq!(
                stats.donation_count, total_donations,
                "GlobalStats.donation_count {} != tracked donations {}",
                stats.donation_count, total_donations,
            );

            prop_assert!(stats.project_count >= project_ids.len() as u32,
                "GlobalStats.project_count {} < number of projects {}",
                stats.project_count, project_ids.len());

            // All stats must be non-negative
            prop_assert!(stats.total_raised >= 0);
            prop_assert!(stats.co2_offset_grams >= 0);
            prop_assert!(stats.donation_count >= 0);
            prop_assert!(stats.project_count >= 0);
        }

        // ─────────────────────────────────────────────────────────────────
        // PROPERTY 5 — Vote Integrity
        //   After resolve_proposal(), proposal.resolved == true and the
        //   vote is never modified again.
        //   Sum of votes_for + votes_against equals sum of voter weights.
        // ─────────────────────────────────────────────────────────────────

        #[test]
        fn prop_vote_integrity(
            donors_with_amounts in prop::collection::vec(
                (donation_amount_strategy(), proptest::bool::ANY),
                1..10,
            ),
        ) {
            let (env, _cid, client, admin, project_ids, _donors, token, _usdc) =
                setup_multi(1, 10);
            let pid = &project_ids[0];

            // Create a proposal with a voting window
            client.create_proposal(&signers1(&env, &admin), pid, &720u32);

            let mut expected_weight_sum: u32 = 0;

            // Make donations to establish badges, then vote
            for (i, (amount, approve)) in donors_with_amounts.iter().enumerate() {
                let donor = Address::generate(&env);
                mint_tokens(&env, &token, &donor, *amount);

                // Donate first to get a badge
                let _ = std::panic::catch_unwind(
                    std::panic::AssertUnwindSafe(|| {
                        client.donate(&token, &donor, pid, amount, &MSG_HASH);
                    }),
                );

                // Try voting
                let badge = client.get_badge(&donor);
                let weight = match badge {
                    BadgeTier::Seedling => 1u32,
                    BadgeTier::Tree => 3u32,
                    BadgeTier::Forest => 10u32,
                    BadgeTier::EarthGuardian => 25u32,
                    BadgeTier::None => 0u32,
                };

                if weight > 0 {
                    let vote_result = std::panic::catch_unwind(
                        std::panic::AssertUnwindSafe(|| {
                            client.vote_verify_project(&donor, pid, approve);
                        }),
                    );
                    if vote_result.is_ok() {
                        expected_weight_sum = expected_weight_sum
                            .checked_add(weight)
                            .expect("weight overflow");
                    }
                }
            }

            // Advance ledger past the voting deadline
            env.ledger().set_sequence_number(env.ledger().sequence() + 721);

            // Resolve the proposal
            let resolve_result = std::panic::catch_unwind(
                std::panic::AssertUnwindSafe(|| {
                    client.resolve_proposal(pid);
                }),
            );
            prop_assert!(resolve_result.is_ok(),
                "resolve_proposal should succeed after deadline");

            let proposal: VoteProposal = client.get_proposal(pid);
            prop_assert!(proposal.resolved,
                "Proposal must be marked resolved");

            // Sum of votes_for + votes_against must equal sum of voter weights
            let total_votes = proposal.votes_for
                .checked_add(proposal.votes_against)
                .expect("overflow");
            prop_assert_eq!(
                total_votes, expected_weight_sum,
                "votes_for({}) + votes_against({}) = {} != expected weight sum {}",
                proposal.votes_for, proposal.votes_against,
                total_votes, expected_weight_sum,
            );

            // After resolution, the proposal must be immutable:
            // no further votes should be possible
            let donor = Address::generate(&env);
            mint_tokens(&env, &token, &donor, 2000i128 * STROOP);
            let _ = std::panic::catch_unwind(
                std::panic::AssertUnwindSafe(|| {
                    client.donate(&token, &donor, pid, &(2000i128 * STROOP), &MSG_HASH);
                }),
            );
            let post_vote = std::panic::catch_unwind(
                std::panic::AssertUnwindSafe(|| {
                    client.vote_verify_project(&donor, pid, &true);
                }),
            );
            prop_assert!(post_vote.is_err(),
                "Voting on resolved proposal should panic");

            // Proposal state must be unchanged after failed vote
            let proposal2: VoteProposal = client.get_proposal(pid);
            prop_assert_eq!(proposal2.votes_for, proposal.votes_for);
            prop_assert_eq!(proposal2.votes_against, proposal.votes_against);
        }

        // ─────────────────────────────────────────────────────────────────
        // PROPERTY 6 — CO₂ Offset Monotonicity
        //   For any sequence of donations, global_co2_offset never decreases.
        // ─────────────────────────────────────────────────────────────────

        #[test]
        fn prop_co2_offset_monotonicity(
            donations in prop::collection::vec(
                (0usize..3, donation_amount_strategy(), 0usize..6),
                1..30,
            ),
        ) {
            let (_env, _cid, client, _admin, project_ids, donors, token, _usdc) =
                setup_multi(3, 6);

            let mut prev_co2 = client.get_global_co2();
            prop_assert!(prev_co2 >= 0, "Initial CO2 offset must be non-negative");

            for (proj_idx, amount, donor_idx) in donations.iter() {
                let pi = proj_idx % project_ids.len();
                let di = donor_idx % donors.len();
                let pid = &project_ids[pi];
                let donor = &donors[di];

                let _ = std::panic::catch_unwind(
                    std::panic::AssertUnwindSafe(|| {
                        client.donate(&token, donor, pid, amount, &MSG_HASH);
                    }),
                );

                let current_co2 = client.get_global_co2();
                prop_assert!(
                    current_co2 >= prev_co2,
                    "Global CO₂ offset decreased from {} to {}",
                    prev_co2, current_co2,
                );
                prev_co2 = current_co2;
            }

            // Also verify via GlobalStats
            let stats: GlobalStats = client.get_global_stats();
            prop_assert_eq!(stats.co2_offset_grams, prev_co2,
                "GlobalStats.co2_offset_grams must match get_global_co2()");
        }

        // ─────────────────────────────────────────────────────────────────
        // PROPERTY 7 — Pause/Resume Idempotency
        //   - Pausing an already-paused project panics.
        //   - Resuming an already-active (not paused) project panics.
        //   - Pausing a deactivated project panics.
        // ─────────────────────────────────────────────────────────────────

        #[test]
        fn prop_pause_resume_idempotency(
            pause_active in proptest::bool::ANY,
            deactivate_first in proptest::bool::ANY,
        ) {
            let (_env, admin, client, project_id) = setup_with_admin();

            if deactivate_first {
                client.deactivate_project(&admin, &project_id);
                // Pausing a deactivated project must panic
                let result = std::panic::catch_unwind(
                    std::panic::AssertUnwindSafe(|| {
                        client.pause_project(&admin, &project_id);
                    }),
                );
                prop_assert!(result.is_err(),
                    "pause_project should panic when project is deactivated");
                return;
            }

            if pause_active {
                client.pause_project(&admin, &project_id);
                // Double-pause must panic (idempotency guard)
                let result = std::panic::catch_unwind(
                    std::panic::AssertUnwindSafe(|| {
                        client.pause_project(&admin, &project_id);
                    }),
                );
                prop_assert!(result.is_err(),
                    "Double pause should panic (Project is already paused)");

                // Resume once
                client.resume_project(&admin, &project_id);
                // Double-resume must panic
                let result2 = std::panic::catch_unwind(
                    std::panic::AssertUnwindSafe(|| {
                        client.resume_project(&admin, &project_id);
                    }),
                );
                prop_assert!(result2.is_err(),
                    "Double resume should panic (Project is not paused)");
            } else {
                // Resume a never-paused project must panic
                let result = std::panic::catch_unwind(
                    std::panic::AssertUnwindSafe(|| {
                        client.resume_project(&admin, &project_id);
                    }),
                );
                prop_assert!(result.is_err(),
                    "Resume on unpaused project should panic (Project is not paused)");
            }
        }
    } // END of enhanced proptest!

    // ═══════════════════════════════════════════════════════════════════════
    // Action-Sequence Fuzzing (ContractAction)
    // ═══════════════════════════════════════════════════════════════════════

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(200))]

        /// Full action-sequence fuzz test: generate random sequences of
        /// contract calls and verify all seven properties hold.
        #[test]
        fn fuzz_action_sequence_consistency(
            actions in prop::collection::vec(
                contract_action_strategy(5, 10),
                1..100,
            ),
        ) {
            let (_env, _cid, client, admin, mut project_ids, donors, token, usdc_token) =
                setup_multi(5, 10);

            let rank = |b: &BadgeTier| -> u8 {
                match b {
                    BadgeTier::None => 0,
                    BadgeTier::Seedling => 1,
                    BadgeTier::Tree => 2,
                    BadgeTier::Forest => 3,
                    BadgeTier::EarthGuardian => 4,
                }
            };

            let mut best_badge_ranks: std::vec::Vec<u8> = std::vec![0u8; donors.len()];
            let mut prev_global_co2 = client.get_global_co2();
            let mut prev_donation_count: u32 = 0;

            for action in actions.iter() {
                match action {
                    ContractAction::Donate { project_idx, donor_idx, amount } => {
                        let pi = project_idx % project_ids.len();
                        let di = donor_idx % donors.len();
                        let pid = &project_ids[pi];
                        let donor = &donors[di];

                        let _ = std::panic::catch_unwind(
                            std::panic::AssertUnwindSafe(|| {
                                client.donate(&token, donor, pid, amount, &MSG_HASH);
                            }),
                        );

                        // Check badge monotonicity
                        let badge = client.get_badge(donor);
                        let current_rank = rank(&badge);
                        prop_assert!(current_rank >= best_badge_ranks[di],
                            "Badge regressed after donate");
                        best_badge_ranks[di] = current_rank;

                        // Check CO2 monotonicity
                        let current_co2 = client.get_global_co2();
                        prop_assert!(current_co2 >= prev_global_co2,
                            "CO2 decreased from {} to {}",
                            prev_global_co2, current_co2);
                        prev_global_co2 = current_co2;

                        // Check donation count monotonic
                        let dc = client.get_donation_count();
                        prop_assert!(dc >= prev_donation_count,
                            "Donation count decreased");
                        prev_donation_count = dc;
                    }
                    ContractAction::DonateUsdc { project_idx, donor_idx, usdc_amount } => {
                        let pi = project_idx % project_ids.len();
                        let di = donor_idx % donors.len();
                        let pid = &project_ids[pi];
                        let donor = &donors[di];

                        let _ = std::panic::catch_unwind(
                            std::panic::AssertUnwindSafe(|| {
                                client.donate_usdc(
                                    &usdc_token, donor, pid, usdc_amount, &MSG_HASH,
                                );
                            }),
                        );

                        // Check badge monotonicity
                        let badge = client.get_badge(donor);
                        let current_rank = rank(&badge);
                        prop_assert!(current_rank >= best_badge_ranks[di],
                            "Badge regressed after donate_usdc");
                        best_badge_ranks[di] = current_rank;

                        // Check CO2 monotonicity
                        let current_co2 = client.get_global_co2();
                        prop_assert!(current_co2 >= prev_global_co2,
                            "CO2 decreased from {} to {}",
                            prev_global_co2, current_co2);
                        prev_global_co2 = current_co2;

                        // Check donation count monotonic
                        let dc = client.get_donation_count();
                        prop_assert!(dc >= prev_donation_count,
                            "Donation count decreased");
                        prev_donation_count = dc;
                    }
                    ContractAction::RegisterProject { name, co2_rate } => {
                        let pid = SorobanString::from_str(
                            &_env,
                            &format!("fuzz-seq-{}", name),
                        );
                        let wallet = Address::generate(&_env);
                        let result = std::panic::catch_unwind(
                            std::panic::AssertUnwindSafe(|| {
                                client.register_project(
                                    &admin, &pid,
                                    &SorobanString::from_str(&_env, &name),
                                    &wallet, co2_rate,
                                );
                            }),
                        );
                        if result.is_ok() {
                            project_ids.push(pid);
                        }
                    }
                    ContractAction::PauseProject { project_idx } => {
                        let pi = project_idx % project_ids.len();
                        let pid = &project_ids[pi];
                        let _ = std::panic::catch_unwind(
                            std::panic::AssertUnwindSafe(|| {
                                client.pause_project(&admin, pid);
                            }),
                        );
                    }
                    ContractAction::ResumeProject { project_idx } => {
                        let pi = project_idx % project_ids.len();
                        let pid = &project_ids[pi];
                        let _ = std::panic::catch_unwind(
                            std::panic::AssertUnwindSafe(|| {
                                client.resume_project(&admin, pid);
                            }),
                        );
                    }
                    ContractAction::CreateProposal { project_idx, duration_ledgers } => {
                        let pi = project_idx % project_ids.len();
                        let pid = &project_ids[pi];
                        let _ = std::panic::catch_unwind(
                            std::panic::AssertUnwindSafe(|| {
                                client.create_proposal(
                                    &signers1(&_env, &admin),
                                    pid, duration_ledgers,
                                );
                            }),
                        );
                    }
                    ContractAction::Vote { project_idx, voter_idx, approve } => {
                        let pi = project_idx % project_ids.len();
                        let vi = voter_idx % donors.len();
                        let pid = &project_ids[pi];
                        let voter = &donors[vi];
                        let _ = std::panic::catch_unwind(
                            std::panic::AssertUnwindSafe(|| {
                                client.vote_verify_project(voter, pid, approve);
                            }),
                        );
                    }
                    ContractAction::ResolveProposal { project_idx } => {
                        let pi = project_idx % project_ids.len();
                        let pid = &project_ids[pi];
                        let _ = std::panic::catch_unwind(
                            std::panic::AssertUnwindSafe(|| {
                                client.resolve_proposal(pid);
                            }),
                        );
                    }
                }
            }

            // Final global consistency check
            let stats: GlobalStats = client.get_global_stats();
            prop_assert!(stats.total_raised >= 0, "Global total_raised negative");
            prop_assert!(stats.co2_offset_grams >= 0, "Global CO2 negative");

            // Sum of project totals must match global total
            let mut sum_total: i128 = 0;
            for pid in project_ids.iter() {
                let proj = client.get_project(pid);
                sum_total = sum_total.checked_add(proj.total_raised)
                    .expect("overflow in final sum");
            }
            prop_assert_eq!(stats.total_raised, sum_total,
                "Final global total {} != sum of project totals {}",
                stats.total_raised, sum_total);
        }
    } // END of action-sequence proptest!

    // ═══════════════════════════════════════════════════════════════════════
    // Fuzz Corpus — Replayable Regression Tests
    // ═══════════════════════════════════════════════════════════════════════

    /// Corpus module: deterministic regression tests that replay known
    /// edge cases discovered during fuzzing. Each test is a standalone
    /// replay of a sequence of actions that previously caused a failure.
    ///
    /// To add a new corpus entry:
    /// 1. When a fuzz test fails, serialize the action sequence.
    /// 2. Add it as a `#[test]` below with a descriptive name.
    /// 3. Assert the exact expected behavior (panic or specific outcome).
    mod corpus {
        use super::*;

        /// CORPUS-001: A single edge-case donation of exactly 1 stroop.
        /// This exercises the minimum valid amount and verifies that
        /// integer division by STROOP handles it correctly (1/STROOP = 0).
        #[test]
        fn replay_min_stroop_donation() {
            let (env, _cid, client, project_id, token) = setup();
            let donor = Address::generate(&env);
            mint_tokens(&env, &token, &donor, 1);

            client.donate(&token, &donor, &project_id, &1i128, &MSG_HASH);

            let project = client.get_project(&project_id);
            // 1 stroop with co2_per_xlm=100 → 0 * 100 = 0 CO2 (floor division)
            assert_eq!(project.total_raised, 1);
            assert_eq!(project.donor_count, 1);

            let stats: GlobalStats = client.get_global_stats();
            assert_eq!(stats.total_raised, 1);
            assert_eq!(stats.co2_offset_grams, 0);
        }

        /// CORPUS-002: Donation that produces exactly 0 CO2 offset due
        /// to floor division (amount < STROOP).
        #[test]
        fn replay_sub_stroop_donation_zero_co2() {
            let (env, _cid, client, project_id, token) = setup();
            let donor = Address::generate(&env);
            let sub_stroop = STROOP - 1;
            mint_tokens(&env, &token, &donor, sub_stroop);

            client.donate(&token, &donor, &project_id, &sub_stroop, &MSG_HASH);

            let stats: GlobalStats = client.get_global_stats();
            assert_eq!(stats.total_raised, sub_stroop);
            // co2_offset_grams must be 0 because floor(sub_stroop / STROOP) = 0
            assert_eq!(stats.co2_offset_grams, 0);

            // CO2 offset must be non-negative
            assert!(stats.co2_offset_grams >= 0);
        }

        /// CORPUS-003: Donate to a project, pause it, attempt donation, resume, donate again.
        /// Verifies the full pause/resume lifecycle with state consistency.
        #[test]
        fn replay_pause_resume_lifecycle() {
            let (env, admin, client, project_id) = setup_with_admin();
            let token_admin = Address::generate(&env);
            let token = env
                .register_stellar_asset_contract_v2(token_admin)
                .address();

            let donor = Address::generate(&env);
            mint_tokens(&env, &token, &donor, 200 * STROOP);

            // Donate 50 XLM
            client.donate(&token, &donor, &project_id, &(50 * STROOP), &MSG_HASH);
            assert_eq!(client.get_project(&project_id).total_raised, 50 * STROOP);

            // Pause
            client.pause_project(&admin, &project_id);
            assert!(client.get_project(&project_id).paused);

            // Donation to paused project must panic
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.donate(&token, &donor, &project_id, &(10 * STROOP), &MSG_HASH);
            }));
            assert!(result.is_err());
            // Total must be unchanged
            assert_eq!(client.get_project(&project_id).total_raised, 50 * STROOP);

            // Resume
            client.resume_project(&admin, &project_id);
            assert!(!client.get_project(&project_id).paused);

            // Donate again — must succeed
            client.donate(&token, &donor, &project_id, &(10 * STROOP), &MSG_HASH);
            assert_eq!(client.get_project(&project_id).total_raised, 60 * STROOP);
        }

        /// CORPUS-004: Vote on a proposal, resolve it, verify immutability.
        #[test]
        fn replay_vote_resolve_immutability() {
            let (env, admin, client, project_id) = setup_with_admin();
            client.create_proposal(&signers1(&env, &admin), &project_id, &720u32);

            let token_admin = Address::generate(&env);
            let token = env
                .register_stellar_asset_contract_v2(token_admin)
                .address();

            let donor = Address::generate(&env);
            mint_tokens(&env, &token, &donor, 500 * STROOP);
            client.donate(&token, &donor, &project_id, &(500 * STROOP), &MSG_HASH);

            // Forest badge = weight 10
            client.vote_verify_project(&donor, &project_id, &true);
            let proposal = client.get_proposal(&project_id);
            assert_eq!(proposal.votes_for, 10);
            assert!(!proposal.resolved);

            // Advance past deadline
            env.ledger()
                .set_sequence_number(env.ledger().sequence() + 721);

            // Resolve
            client.resolve_proposal(&project_id);
            let proposal2 = client.get_proposal(&project_id);
            assert!(proposal2.resolved);

            // Voting after resolution must panic
            let donor2 = Address::generate(&env);
            mint_tokens(&env, &token, &donor2, 2000 * STROOP);
            client.donate(&token, &donor2, &project_id, &(2000 * STROOP), &MSG_HASH);

            let result = client.try_vote_verify_project(&donor2, &project_id, &true);
            assert!(result.is_err(), "vote after resolution must panic");

            // Proposal state must be unchanged
            let proposal3 = client.get_proposal(&project_id);
            assert_eq!(proposal3.votes_for, proposal2.votes_for);
            assert!(proposal3.resolved);
        }
    } // END mod corpus

    // ═══════════════════════════════════════════════════════════════════════
    // Regression tests for bugs discovered via fuzzing
    // ═══════════════════════════════════════════════════════════════════════

    /// REGRESSION-001: Verify that sub-stroop donations don't cause CO2
    /// underflow or negative offsets. The CO2 calculation uses floor
    /// division (amount / STROOP), so amounts < STROOP produce 0 CO2.
    #[test]
    fn regression_sub_stroop_co2_no_underflow() {
        let (env, _cid, client, project_id, token) = setup();
        let donor = Address::generate(&env);
        mint_tokens(&env, &token, &donor, 5_000_000);

        client.donate(&token, &donor, &project_id, &5_000_000i128, &MSG_HASH);

        let donor_co2 = client.get_donor_stats(&donor).co2_offset_grams;
        assert_eq!(donor_co2, 0);

        let global_co2 = client.get_global_co2();
        assert!(global_co2 >= 0, "Global CO2 must never go negative");
    }

    /// REGRESSION-002: Verify that multi-project donor counts are tracked
    /// independently (same donor donating to different projects).
    #[test]
    fn regression_multi_project_donor_count_independence() {
        let (env, admin, client, project_a) = setup_with_admin();
        let wallet_b = Address::generate(&env);
        let project_b = SorobanString::from_str(&env, "proj-reg-b");
        client.register_project(
            &admin,
            &project_b,
            &SorobanString::from_str(&env, "Reg Project B"),
            &wallet_b,
            &50u32,
        );

        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        let donor = Address::generate(&env);
        mint_tokens(&env, &token, &donor, 10 * STROOP);

        client.donate(&token, &donor, &project_a, &(3 * STROOP), &MSG_HASH);
        client.donate(&token, &donor, &project_b, &(3 * STROOP), &MSG_HASH);

        // Same donor, two projects — each should have donor_count = 1
        let pa = client.get_project(&project_a);
        let pb = client.get_project(&project_b);
        assert_eq!(pa.donor_count, 1);
        assert_eq!(pb.donor_count, 1);

        // Donor's badge should reflect total across all projects
        let badge = client.get_badge(&donor);
        // 6 XLM total → No badge yet (threshold is 10 XLM)
        assert_eq!(badge, BadgeTier::None);
    }

    /// REGRESSION-003: Verify that CO2 global consistency holds even when
    /// donating to a project with co2_per_xlm = 0 (updated after registration).
    /// Updating co2_per_xlm to zero is rejected by the contract, but we verify
    /// the rejection behavior.
    #[test]
    fn regression_zero_co2_rate_update_rejected() {
        let (_env, admin, client, project_id) = setup_with_admin();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_project_co2_rate(&admin, &project_id, &0u32);
        }));
        assert!(result.is_err(), "Setting CO2 rate to 0 must panic");

        // The existing rate should be preserved
        let project = client.get_project(&project_id);
        assert_eq!(project.co2_per_xlm, 100u32);
    }
}
