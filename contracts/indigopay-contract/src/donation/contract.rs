use soroban_sdk::{
    contract, contractimpl, panic_with_error, token, Address, Bytes, BytesN, Env, Vec,
};

use crate::donation::{
    events::{emit_stealth_donation, emit_stealth_scan, emit_stealth_withdrawal},
    storage::{
        add_project_donation, add_stealth_withdrawable_balance, get_project_donations,
        get_stealth_counter, get_stealth_donation, set_stealth_counter, set_stealth_donation,
        set_stealth_withdrawable_balance,
    },
    types::{DonationError, StealthDonation},
};

#[contract]
pub struct DonationContract;

#[contractimpl]
impl DonationContract {
    pub fn generate_stealth_address(
        env: Env,
        project_wallet: Address,
        ephemeral_pubkey: BytesN<33>,
    ) -> BytesN<32> {
        use soroban_sdk::xdr::ToXdr;

        let wallet_xdr = project_wallet.to_xdr(&env);
        let ephem_bytes: Bytes = ephemeral_pubkey.into();

        let mut data = Bytes::new(&env);
        data.append(&wallet_xdr);
        data.append(&ephem_bytes);

        let hash = env.crypto().sha256(&data);
        hash.to_bytes()
    }

    pub fn donate_stealth(
        env: Env,
        sender: Address,
        token: Address,
        ephemeral_pubkey: BytesN<33>,
        project_wallet: Address,
        amount: i128,
        msg_hash: BytesN<32>,
    ) -> u64 {
        sender.require_auth();

        let stealth_addr = Self::generate_stealth_address(
            env.clone(),
            project_wallet.clone(),
            ephemeral_pubkey.clone(),
        );

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&sender, env.current_contract_address(), &amount);

        // Credit the project's per-(project_wallet, token) withdrawable balance
        // so the donation is never stranded in this contract (#621).
        add_stealth_withdrawable_balance(&env, &project_wallet, &token, amount);

        let donation_id = get_stealth_counter(&env) + 1;
        set_stealth_counter(&env, donation_id);

        let donation = StealthDonation {
            stealth_address: stealth_addr,
            project_wallet: project_wallet.clone(),
            ephemeral_pubkey: ephemeral_pubkey.clone(),
            amount,
            msg_hash: msg_hash.clone(),
        };
        set_stealth_donation(&env, donation_id, &donation);

        add_project_donation(&env, &project_wallet, donation_id);

        emit_stealth_donation(
            &env,
            donation_id,
            &project_wallet,
            amount,
            &ephemeral_pubkey,
            &msg_hash,
        );

        donation_id
    }

    pub fn scan_stealth_donations(
        env: Env,
        project_wallet: Address,
        _viewing_key: BytesN<32>,
    ) -> Vec<StealthDonation> {
        project_wallet.require_auth();

        let donation_ids = get_project_donations(&env, &project_wallet);
        let mut donations = Vec::new(&env);
        for i in 0..donation_ids.len() {
            let id = donation_ids.get(i).unwrap();
            if let Some(donation) = get_stealth_donation(&env, id) {
                donations.push_back(donation);
            }
        }
        emit_stealth_scan(&env, &project_wallet, donations.len());
        donations
    }

    /// Project-wallet-gated withdrawal of stealth-donated funds (#621).
    ///
    /// Moves `amount` of `token` from this contract's per-(project_wallet,
    /// token) withdrawable balance to the project wallet itself. Only the
    /// `project_wallet` address may withdraw, preventing any third party
    /// (including the main `IndigoPayContract` admin) from draining a
    /// project's funds.
    ///
    /// Checks-effects-interactions ordering: the withdrawable balance is
    /// decremented *before* the external token transfer, so a reentrant or
    /// malicious token cannot double-drain the balance.
    ///
    /// Returns the remaining withdrawable balance for (project_wallet, token)
    /// after the withdrawal, so callers and indexers can reconcile.
    pub fn withdraw_stealth_donations(
        env: Env,
        project_wallet: Address,
        token: Address,
        amount: i128,
    ) -> i128 {
        project_wallet.require_auth();

        if amount <= 0 {
            panic_with_error!(env, DonationError::WithdrawalAmountMustBePositive);
        }

        // ── Checks: verify the withdrawable balance is sufficient
        let balance = crate::donation::storage::get_stealth_withdrawable_balance(
            &env,
            &project_wallet,
            &token,
        );
        if amount > balance {
            panic_with_error!(env, DonationError::InsufficientStealthWithdrawableBalance);
        }

        // ── Effects: decrement the balance before the external transfer (CEI)
        let remaining = balance - amount;
        set_stealth_withdrawable_balance(&env, &project_wallet, &token, remaining);

        // ── Interaction: forward the tokens to the project wallet
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &project_wallet, &amount);

        emit_stealth_withdrawal(&env, &project_wallet, &token, amount, remaining);

        remaining
    }

    /// Read-only: per-(project_wallet, token) stealth withdrawable balance.
    /// Lets projects and indexers reconcile on-chain totals with funds
    /// actually received.
    pub fn get_stealth_withdrawable_balance(
        env: Env,
        project_wallet: Address,
        token: Address,
    ) -> i128 {
        crate::donation::storage::get_stealth_withdrawable_balance(&env, &project_wallet, &token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use soroban_sdk::{
        testutils::{Address as _, Events as _, Ledger as _},
        token::StellarAssetClient,
        xdr::{ContractEventBody, ScVal},
        Address, Env,
    };

    #[contract]
    struct TestHarness;

    #[contractimpl]
    impl TestHarness {
        pub fn generate_stealth_address(
            env: Env,
            project_wallet: Address,
            ephemeral_pubkey: BytesN<33>,
        ) -> BytesN<32> {
            DonationContract::generate_stealth_address(env, project_wallet, ephemeral_pubkey)
        }

        pub fn donate_stealth(
            env: Env,
            sender: Address,
            token: Address,
            ephemeral_pubkey: BytesN<33>,
            project_wallet: Address,
            amount: i128,
            msg_hash: BytesN<32>,
        ) -> u64 {
            DonationContract::donate_stealth(
                env,
                sender,
                token,
                ephemeral_pubkey,
                project_wallet,
                amount,
                msg_hash,
            )
        }

        pub fn scan_stealth_donations(
            env: Env,
            project_wallet: Address,
            viewing_key: BytesN<32>,
        ) -> Vec<StealthDonation> {
            DonationContract::scan_stealth_donations(env, project_wallet, viewing_key)
        }

        pub fn withdraw_stealth_donations(
            env: Env,
            project_wallet: Address,
            token: Address,
            amount: i128,
        ) -> i128 {
            DonationContract::withdraw_stealth_donations(env, project_wallet, token, amount)
        }

        pub fn get_stealth_withdrawable_balance(
            env: Env,
            project_wallet: Address,
            token: Address,
        ) -> i128 {
            DonationContract::get_stealth_withdrawable_balance(env, project_wallet, token)
        }

        pub fn get_stealth_donation(env: Env, donation_id: u64) -> Option<StealthDonation> {
            crate::donation::storage::get_stealth_donation(&env, donation_id)
        }
    }

    fn create_token(env: &Env, donor: &Address, amount: i128) -> Address {
        env.mock_all_auths();
        let token_admin = Address::generate(env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        StellarAssetClient::new(env, &token).mint(donor, &amount);
        token
    }

    #[test]
    fn test_generate_stealth_address_deterministic() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TestHarness);
        let client = TestHarnessClient::new(&env, &contract_id);

        let project = Address::generate(&env);
        let ephem = BytesN::from_array(&env, &[1u8; 33]);

        let addr1 = client.generate_stealth_address(&project, &ephem);
        let addr2 = client.generate_stealth_address(&project, &ephem);

        assert_eq!(addr1, addr2);
    }

    #[test]
    fn test_generate_stealth_address_different_keys() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TestHarness);
        let client = TestHarnessClient::new(&env, &contract_id);

        let project = Address::generate(&env);
        let ephem1 = BytesN::from_array(&env, &[1u8; 33]);
        let ephem2 = BytesN::from_array(&env, &[2u8; 33]);

        let addr1 = client.generate_stealth_address(&project, &ephem1);
        let addr2 = client.generate_stealth_address(&project, &ephem2);

        assert_ne!(addr1, addr2);
    }

    #[test]
    fn test_donate_stealth() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TestHarness);
        let client = TestHarnessClient::new(&env, &contract_id);

        let donor = Address::generate(&env);
        let project = Address::generate(&env);
        let token = create_token(&env, &donor, 10_000_000);
        let ephem = BytesN::from_array(&env, &[42u8; 33]);
        let msg_hash = BytesN::from_array(&env, &[0u8; 32]);
        let amount: i128 = 5_000_000;

        let donation_id =
            client.donate_stealth(&donor, &token, &ephem, &project, &amount, &msg_hash);

        assert_eq!(donation_id, 1u64);

        let stored = client.get_stealth_donation(&1).unwrap();
        assert_eq!(stored.amount, amount);
        assert_eq!(stored.project_wallet, project);
        assert_eq!(stored.ephemeral_pubkey, ephem);
        assert_eq!(stored.msg_hash, msg_hash);

        // The donated amount is credited to the project's per-token
        // withdrawable balance so it is never stranded (#621).
        assert_eq!(
            client.get_stealth_withdrawable_balance(&project, &token),
            amount
        );
    }

    fn seed_donations(env: &Env, contract_id: &Address) -> (Address, BytesN<32>) {
        let client = TestHarnessClient::new(env, contract_id);

        let donor1 = Address::generate(env);
        let donor2 = Address::generate(env);
        let project = Address::generate(env);
        let viewing_key = BytesN::from_array(env, &[99u8; 32]);
        let token = create_token(env, &donor1, 10_000_000);
        StellarAssetClient::new(env, &token).mint(&donor2, &10_000_000);
        let ephem1 = BytesN::from_array(env, &[10u8; 33]);
        let ephem2 = BytesN::from_array(env, &[20u8; 33]);
        let msg_hash = BytesN::from_array(env, &[0u8; 32]);

        client.donate_stealth(&donor1, &token, &ephem1, &project, &3_000_000, &msg_hash);
        client.donate_stealth(&donor2, &token, &ephem2, &project, &7_000_000, &msg_hash);

        (project, viewing_key)
    }

    fn assert_stealth_scan_event(
        env: &Env,
        contract_id: &Address,
        project_wallet: &Address,
        donation_count: u32,
        timestamp: u64,
    ) {
        let events = env.events().all().filter_by_contract(contract_id);
        assert_eq!(events.events().len(), 1);

        let event = events.events().last().unwrap();
        let ContractEventBody::V0(body) = &event.body;
        assert_eq!(body.topics.len(), 2);
        let ScVal::Symbol(event_name) = &body.topics[0] else {
            panic!("expected event name symbol");
        };
        assert_eq!(event_name.0.as_vec().as_slice(), b"StlthScn");
        assert_eq!(body.topics[1], ScVal::from(project_wallet));
        let ScVal::Vec(Some(data)) = &body.data else {
            panic!("expected event data vector");
        };
        assert_eq!(
            data.0.as_vec().as_slice(),
            &[ScVal::U32(donation_count), ScVal::U64(timestamp)]
        );
    }

    #[test]
    fn test_scan_stealth_donations() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TestHarness);
        let client = TestHarnessClient::new(&env, &contract_id);

        let (project, viewing_key) = seed_donations(&env, &contract_id);
        env.ledger().set_timestamp(1_234_567);

        let donations = client.scan_stealth_donations(&project, &viewing_key);

        assert_eq!(donations.len(), 2);
        assert_eq!(donations.get(0).unwrap().amount, 3_000_000);
        assert_eq!(donations.get(1).unwrap().amount, 7_000_000);
        assert_stealth_scan_event(&env, &contract_id, &project, 2, 1_234_567);
    }

    #[test]
    fn test_scan_stealth_donations_empty() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TestHarness);
        let client = TestHarnessClient::new(&env, &contract_id);

        let project = Address::generate(&env);
        let viewing_key = BytesN::from_array(&env, &[0u8; 32]);
        env.ledger().set_timestamp(7_654_321);

        let donations = client.scan_stealth_donations(&project, &viewing_key);

        assert_eq!(donations.len(), 0);
        assert_stealth_scan_event(&env, &contract_id, &project, 0, 7_654_321);
    }

    #[test]
    fn test_scan_with_missing_donation_is_graceful() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TestHarness);
        let client = TestHarnessClient::new(&env, &contract_id);

        let donor1 = Address::generate(&env);
        let donor2 = Address::generate(&env);
        let project = Address::generate(&env);
        let viewing_key = BytesN::from_array(&env, &[99u8; 32]);
        let token = create_token(&env, &donor1, 10_000_000);
        StellarAssetClient::new(&env, &token).mint(&donor2, &10_000_000);
        let ephem1 = BytesN::from_array(&env, &[10u8; 33]);
        let ephem2 = BytesN::from_array(&env, &[20u8; 33]);
        let msg_hash = BytesN::from_array(&env, &[0u8; 32]);

        client.donate_stealth(&donor1, &token, &ephem1, &project, &3_000_000, &msg_hash);
        env.as_contract(&contract_id, || {
            crate::donation::storage::add_project_donation(&env, &project, 999);
        });
        client.donate_stealth(&donor2, &token, &ephem2, &project, &7_000_000, &msg_hash);
        assert!(client.get_stealth_donation(&999).is_none());

        let donations = client.scan_stealth_donations(&project, &viewing_key);

        assert_eq!(donations.len(), 2);
        assert_eq!(donations.get(0).unwrap().amount, 3_000_000);
        assert_eq!(donations.get(1).unwrap().amount, 7_000_000);
    }

    #[test]
    fn test_stealth_address_unlinkability() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TestHarness);
        let client = TestHarnessClient::new(&env, &contract_id);

        let project = Address::generate(&env);

        let ephem_alice = BytesN::from_array(&env, &[100u8; 33]);
        let ephem_bob = BytesN::from_array(&env, &[200u8; 33]);

        let alice_stealth = client.generate_stealth_address(&project, &ephem_alice);
        let bob_stealth = client.generate_stealth_address(&project, &ephem_bob);

        assert_ne!(alice_stealth, bob_stealth);
    }

    // ─── Stealth withdrawal tests (#621) ───────────────────────────────────

    fn assert_stealth_withdrawal_event(
        env: &Env,
        contract_id: &Address,
        project_wallet: &Address,
        token: &Address,
        amount: i128,
        remaining: i128,
        timestamp: u64,
    ) {
        let events = env.events().all().filter_by_contract(contract_id);
        let event = events.events().last().unwrap();
        let ContractEventBody::V0(body) = &event.body;
        assert_eq!(body.topics.len(), 2);
        let ScVal::Symbol(event_name) = &body.topics[0] else {
            panic!("expected event name symbol");
        };
        assert_eq!(event_name.0.as_vec().as_slice(), b"StlthWdr");
        assert_eq!(body.topics[1], ScVal::from(project_wallet));
        let ScVal::Vec(Some(data)) = &body.data else {
            panic!("expected event data vector");
        };
        assert_eq!(
            data.0.as_vec().as_slice(),
            &[
                ScVal::from(token),
                ScVal::from(amount),
                ScVal::from(remaining),
                ScVal::U64(timestamp),
            ]
        );
    }

    #[test]
    fn test_withdraw_stealth_donations_full() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TestHarness);
        let client = TestHarnessClient::new(&env, &contract_id);

        let donor = Address::generate(&env);
        let project = Address::generate(&env);
        let token = create_token(&env, &donor, 10_000_000);
        let ephem = BytesN::from_array(&env, &[1u8; 33]);
        let msg_hash = BytesN::from_array(&env, &[0u8; 32]);
        let amount: i128 = 5_000_000;

        client.donate_stealth(&donor, &token, &ephem, &project, &amount, &msg_hash);
        assert_eq!(
            client.get_stealth_withdrawable_balance(&project, &token),
            amount
        );

        // Full withdrawal drains the per-(project, token) balance to the wallet
        let remaining = client.withdraw_stealth_donations(&project, &token, &amount);

        assert_eq!(remaining, 0);
        assert_eq!(client.get_stealth_withdrawable_balance(&project, &token), 0);
        // Tokens moved from the DonationContract to the project wallet
        assert_eq!(
            StellarAssetClient::new(&env, &token).balance(&contract_id),
            0
        );
        assert_eq!(
            StellarAssetClient::new(&env, &token).balance(&project),
            amount
        );
    }

    #[test]
    fn test_withdraw_stealth_donations_partial() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TestHarness);
        let client = TestHarnessClient::new(&env, &contract_id);

        let donor = Address::generate(&env);
        let project = Address::generate(&env);
        let token = create_token(&env, &donor, 10_000_000);
        let ephem = BytesN::from_array(&env, &[1u8; 33]);
        let msg_hash = BytesN::from_array(&env, &[0u8; 32]);

        client.donate_stealth(&donor, &token, &ephem, &project, &5_000_000, &msg_hash);

        // Partial withdrawal leaves the remainder withdrawable later
        let remaining = client.withdraw_stealth_donations(&project, &token, &2_000_000);
        assert_eq!(remaining, 3_000_000);
        assert_eq!(
            client.get_stealth_withdrawable_balance(&project, &token),
            3_000_000
        );
        assert_eq!(
            StellarAssetClient::new(&env, &token).balance(&project),
            2_000_000
        );
        assert_eq!(
            StellarAssetClient::new(&env, &token).balance(&contract_id),
            3_000_000
        );

        // Second withdrawal drains the remainder
        let remaining = client.withdraw_stealth_donations(&project, &token, &3_000_000);
        assert_eq!(remaining, 0);
        assert_eq!(
            StellarAssetClient::new(&env, &token).balance(&project),
            5_000_000
        );
        assert_eq!(
            StellarAssetClient::new(&env, &token).balance(&contract_id),
            0
        );
    }

    #[test]
    fn test_withdraw_stealth_donations_aggregates_multiple_donations() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TestHarness);
        let client = TestHarnessClient::new(&env, &contract_id);

        let donor1 = Address::generate(&env);
        let donor2 = Address::generate(&env);
        let project = Address::generate(&env);
        let token = create_token(&env, &donor1, 10_000_000);
        StellarAssetClient::new(&env, &token).mint(&donor2, &10_000_000);
        let ephem1 = BytesN::from_array(&env, &[10u8; 33]);
        let ephem2 = BytesN::from_array(&env, &[20u8; 33]);
        let msg_hash = BytesN::from_array(&env, &[0u8; 32]);

        client.donate_stealth(&donor1, &token, &ephem1, &project, &3_000_000, &msg_hash);
        client.donate_stealth(&donor2, &token, &ephem2, &project, &7_000_000, &msg_hash);
        assert_eq!(
            client.get_stealth_withdrawable_balance(&project, &token),
            10_000_000
        );

        // One withdrawal moves the aggregated balance to the wallet
        let remaining = client.withdraw_stealth_donations(&project, &token, &10_000_000);
        assert_eq!(remaining, 0);
        assert_eq!(
            StellarAssetClient::new(&env, &token).balance(&project),
            10_000_000
        );
        assert_eq!(
            StellarAssetClient::new(&env, &token).balance(&contract_id),
            0
        );
    }

    #[test]
    fn test_withdraw_stealth_donations_per_token_accounting() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TestHarness);
        let client = TestHarnessClient::new(&env, &contract_id);

        let donor = Address::generate(&env);
        let project = Address::generate(&env);
        let token_a = create_token(&env, &donor, 10_000_000);
        let token_b = create_token(&env, &donor, 10_000_000);
        let ephem = BytesN::from_array(&env, &[1u8; 33]);
        let msg_hash = BytesN::from_array(&env, &[0u8; 32]);

        client.donate_stealth(&donor, &token_a, &ephem, &project, &3_000_000, &msg_hash);
        client.donate_stealth(&donor, &token_b, &ephem, &project, &4_000_000, &msg_hash);

        // Draining token A leaves token B's balance untouched
        let remaining = client.withdraw_stealth_donations(&project, &token_a, &3_000_000);
        assert_eq!(remaining, 0);
        assert_eq!(
            client.get_stealth_withdrawable_balance(&project, &token_a),
            0
        );
        assert_eq!(
            client.get_stealth_withdrawable_balance(&project, &token_b),
            4_000_000
        );
        assert_eq!(
            StellarAssetClient::new(&env, &token_a).balance(&project),
            3_000_000
        );
        assert_eq!(
            StellarAssetClient::new(&env, &token_a).balance(&contract_id),
            0
        );
        // Token B still fully held by the DonationContract
        assert_eq!(
            StellarAssetClient::new(&env, &token_b).balance(&contract_id),
            4_000_000
        );
    }

    #[test]
    fn test_withdraw_stealth_donations_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TestHarness);
        let client = TestHarnessClient::new(&env, &contract_id);

        let donor = Address::generate(&env);
        let project = Address::generate(&env);
        let token = create_token(&env, &donor, 10_000_000);
        let ephem = BytesN::from_array(&env, &[3u8; 33]);
        let msg_hash = BytesN::from_array(&env, &[0u8; 32]);

        client.donate_stealth(&donor, &token, &ephem, &project, &5_000_000, &msg_hash);
        env.ledger().set_timestamp(2_468_000);

        let remaining = client.withdraw_stealth_donations(&project, &token, &2_000_000);

        assert_eq!(remaining, 3_000_000);
        assert_stealth_withdrawal_event(
            &env,
            &contract_id,
            &project,
            &token,
            2_000_000,
            3_000_000,
            2_468_000,
        );
    }

    #[test]
    fn test_withdraw_stealth_donations_unauthorized_rejected() {
        let env = Env::default();
        // NOTE: no `mock_all_auths` — real auth enforcement. The project
        // wallet never signs, so `require_auth` must reject the call.
        let contract_id = env.register_contract(None, TestHarness);
        let client = TestHarnessClient::new(&env, &contract_id);

        let project = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        // Seed the withdrawable balance directly to isolate the auth check.
        env.as_contract(&contract_id, || {
            crate::donation::storage::set_stealth_withdrawable_balance(
                &env, &project, &token, 5_000_000,
            );
        });

        let result = client.try_withdraw_stealth_donations(&project, &token, &1_000_000i128);
        assert!(result.is_err(), "unsigned withdrawal must be rejected");

        // Nothing was transferred and the balance is untouched.
        assert_eq!(
            client.get_stealth_withdrawable_balance(&project, &token),
            5_000_000
        );
        assert_eq!(StellarAssetClient::new(&env, &token).balance(&project), 0);
        assert_eq!(
            StellarAssetClient::new(&env, &token).balance(&contract_id),
            0
        );
    }

    #[test]
    fn test_withdraw_stealth_donations_zero_amount_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TestHarness);
        let client = TestHarnessClient::new(&env, &contract_id);

        let donor = Address::generate(&env);
        let project = Address::generate(&env);
        let token = create_token(&env, &donor, 10_000_000);
        let ephem = BytesN::from_array(&env, &[1u8; 33]);
        let msg_hash = BytesN::from_array(&env, &[0u8; 32]);
        client.donate_stealth(&donor, &token, &ephem, &project, &5_000_000, &msg_hash);

        let result = client.try_withdraw_stealth_donations(&project, &token, &0i128);
        assert!(result.is_err(), "zero-amount withdrawal must be rejected");
        assert_eq!(
            client.get_stealth_withdrawable_balance(&project, &token),
            5_000_000
        );
    }

    #[test]
    fn test_withdraw_stealth_donations_insufficient_balance_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TestHarness);
        let client = TestHarnessClient::new(&env, &contract_id);

        let donor = Address::generate(&env);
        let project = Address::generate(&env);
        let token = create_token(&env, &donor, 10_000_000);
        let ephem = BytesN::from_array(&env, &[1u8; 33]);
        let msg_hash = BytesN::from_array(&env, &[0u8; 32]);
        client.donate_stealth(&donor, &token, &ephem, &project, &5_000_000, &msg_hash);

        let result = client.try_withdraw_stealth_donations(&project, &token, &6_000_000i128);
        assert!(result.is_err(), "over-balance withdrawal must be rejected");

        // Balance and wallet are untouched.
        assert_eq!(
            client.get_stealth_withdrawable_balance(&project, &token),
            5_000_000
        );
        assert_eq!(StellarAssetClient::new(&env, &token).balance(&project), 0);
        assert_eq!(
            StellarAssetClient::new(&env, &token).balance(&contract_id),
            5_000_000
        );
    }
}
