use soroban_sdk::{contract, contractimpl, token, Address, Bytes, BytesN, Env, Vec};

use crate::donation::{
    events::{emit_pause_recurring, emit_resume_recurring, emit_stealth_donation},
    storage::{
        add_project_donation, get_project_donations, get_recurring_counter, get_recurring_donation,
        get_stealth_counter, get_stealth_donation, set_recurring_counter, set_recurring_donation,
        set_stealth_counter, set_stealth_donation,
    },
    types::{RecurringDonation, StealthDonation},
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
            let donation = get_stealth_donation(&env, id);
            donations.push_back(donation);
        }
        donations
    }

    pub fn create_recurring(
        env: Env,
        donor: Address,
        project_wallet: Address,
        amount: i128,
        interval_ledgers: u64,
    ) -> u64 {
        donor.require_auth();

        let id = get_recurring_counter(&env) + 1;
        set_recurring_counter(&env, id);

        let current_ledger = env.ledger().sequence() as u64;
        let donation = RecurringDonation {
            id,
            donor,
            project_wallet,
            amount,
            interval_ledgers,
            next_execution_ledger: current_ledger + interval_ledgers,
            paused: false,
            paused_at: 0,
        };

        set_recurring_donation(&env, id, &donation);
        id
    }

    pub fn pause_recurring(env: Env, donor: Address, recurring_id: u64) {
        donor.require_auth();

        let mut donation = get_recurring_donation(&env, recurring_id);
        if donation.donor != donor {
            panic!("unauthorized donor");
        }
        if donation.paused {
            panic!("already paused");
        }

        let current_ledger = env.ledger().sequence() as u64;
        donation.paused = true;
        donation.paused_at = current_ledger;

        set_recurring_donation(&env, recurring_id, &donation);
        emit_pause_recurring(&env, recurring_id, &donor, current_ledger);
    }

    pub fn resume_recurring(
        env: Env,
        donor: Address,
        token: Address,
        recurring_id: u64,
        catch_up: bool,
    ) {
        donor.require_auth();

        let mut donation = get_recurring_donation(&env, recurring_id);
        if donation.donor != donor {
            panic!("unauthorized donor");
        }
        if !donation.paused {
            panic!("not paused");
        }

        let current_ledger = env.ledger().sequence() as u64;
        let mut catch_up_amount = 0i128;

        if catch_up {
            let missed_ledgers = current_ledger.saturating_sub(donation.paused_at);
            let missed_cycles = missed_ledgers / donation.interval_ledgers;

            if missed_cycles > 0 {
                catch_up_amount = donation.amount * (missed_cycles as i128);
                let token_client = token::Client::new(&env, &token);
                token_client.transfer(&donor, &donation.project_wallet, &catch_up_amount);
            }
        }

        donation.paused = false;
        donation.paused_at = 0;
        donation.next_execution_ledger = current_ledger + donation.interval_ledgers;

        set_recurring_donation(&env, recurring_id, &donation);
        emit_resume_recurring(&env, recurring_id, &donor, catch_up, catch_up_amount);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        token::StellarAssetClient,
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

        pub fn get_stealth_donation(env: Env, donation_id: u64) -> StealthDonation {
            crate::donation::storage::get_stealth_donation(&env, donation_id)
        }

        pub fn create_recurring(
            env: Env,
            donor: Address,
            project_wallet: Address,
            amount: i128,
            interval_ledgers: u64,
        ) -> u64 {
            DonationContract::create_recurring(env, donor, project_wallet, amount, interval_ledgers)
        }

        pub fn pause_recurring(env: Env, donor: Address, recurring_id: u64) {
            DonationContract::pause_recurring(env, donor, recurring_id)
        }

        pub fn resume_recurring(
            env: Env,
            donor: Address,
            token: Address,
            recurring_id: u64,
            catch_up: bool,
        ) {
            DonationContract::resume_recurring(env, donor, token, recurring_id, catch_up)
        }

        pub fn get_recurring_donation(env: Env, id: u64) -> RecurringDonation {
            crate::donation::storage::get_recurring_donation(&env, id)
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

        let stored = client.get_stealth_donation(&1);
        assert_eq!(stored.amount, amount);
        assert_eq!(stored.project_wallet, project);
        assert_eq!(stored.ephemeral_pubkey, ephem);
        assert_eq!(stored.msg_hash, msg_hash);
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

    #[test]
    fn test_scan_stealth_donations() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TestHarness);
        let client = TestHarnessClient::new(&env, &contract_id);

        let (project, viewing_key) = seed_donations(&env, &contract_id);

        let donations = client.scan_stealth_donations(&project, &viewing_key);

        assert_eq!(donations.len(), 2);
        assert_eq!(donations.get(0).unwrap().amount, 3_000_000);
        assert_eq!(donations.get(1).unwrap().amount, 7_000_000);
    }

    #[test]
    fn test_scan_stealth_donations_empty() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TestHarness);
        let client = TestHarnessClient::new(&env, &contract_id);

        let project = Address::generate(&env);
        let viewing_key = BytesN::from_array(&env, &[0u8; 32]);

        let donations = client.scan_stealth_donations(&project, &viewing_key);

        assert_eq!(donations.len(), 0);
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

    #[test]
    fn test_pause_and_resume_with_catch_up() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TestHarness);
        let client = TestHarnessClient::new(&env, &contract_id);

        let donor = Address::generate(&env);
        let project = Address::generate(&env);
        let token = create_token(&env, &donor, 10_000_000);

        let recurring_id = client.create_recurring(&donor, &project, &1_000_000, &100);

        // Pause recurring donation
        client.pause_recurring(&donor, &recurring_id);
        let donation = client.get_recurring_donation(&recurring_id);
        assert!(donation.paused);

        // Advance ledgers to simulate 2 missed cycles (200 ledgers)
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + 200);

        // Resume with catch up
        client.resume_recurring(&donor, &token, &recurring_id, &true);

        let resumed_donation = client.get_recurring_donation(&recurring_id);
        assert!(!resumed_donation.paused);
    }
}
