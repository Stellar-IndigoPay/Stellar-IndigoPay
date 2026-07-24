use escrow_contract::{EscrowContract, EscrowContractClient, JobStatus, Milestone};
use indigopay_contract::{IndigoPayContract, IndigoPayContractClient};
use oracle_contract::{SimpleOracle, SimpleOracleClient};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger as _},
    token::StellarAssetClient,
    Address, Env, String as SorobanString, Vec,
};

fn signers1(env: &Env, admin: &Address) -> Vec<Address> {
    let mut signers = Vec::new(env);
    signers.push_back(admin.clone());
    signers
}

fn make_milestones(env: &Env) -> Vec<Milestone> {
    let mut milestones = Vec::new(env);
    milestones.push_back(Milestone {
        name: SorobanString::from_str(env, "Design"),
        percentage: 50,
        released: false,
        disputed: false,
    });
    milestones.push_back(Milestone {
        name: SorobanString::from_str(env, "Development"),
        percentage: 30,
        released: false,
        disputed: false,
    });
    milestones.push_back(Milestone {
        name: SorobanString::from_str(env, "Testing"),
        percentage: 20,
        released: false,
        disputed: false,
    });
    milestones
}

fn setup_contracts() -> (
    Env,
    Address,
    Address,
    Address,
    Address,
    Address,
    IndigoPayContractClient<'static>,
    EscrowContractClient<'static>,
    SimpleOracleClient<'static>,
    Address,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();

    let indigopay_id = env.register_contract(None, IndigoPayContract);
    let escrow_id = env.register_contract(None, EscrowContract);
    let oracle_id = env.register_contract(None, SimpleOracle);

    let indigopay_client = IndigoPayContractClient::new(&env, &indigopay_id);
    let escrow_client = EscrowContractClient::new(&env, &escrow_id);
    let oracle_client = SimpleOracleClient::new(&env, &oracle_id);

    let admin = Address::generate(&env);
    let oracle_admin = Address::generate(&env);
    let oracle_reporter = Address::generate(&env);
    let donor = Address::generate(&env);
    let project_wallet = Address::generate(&env);
    let freelancer = Address::generate(&env);

    indigopay_client.initialize(&signers1(&env, &admin), &1u32);
    oracle_client.initialize(&oracle_admin);
    oracle_client.add_reporter(&oracle_admin, &oracle_reporter);
    escrow_client.initialize(&admin);

    (
        env,
        admin,
        oracle_admin,
        oracle_reporter,
        donor,
        project_wallet,
        indigopay_client,
        escrow_client,
        oracle_client,
        oracle_id,
        indigopay_id,
        escrow_id,
    )
}

#[test]
#[ignore]
fn integration_oracle_get_price_is_used_by_real_indigopay_donation_flow() {
    let (
        env,
        admin,
        _oracle_admin,
        oracle_reporter,
        donor,
        project_wallet,
        indigopay_client,
        _escrow_client,
        oracle_client,
        oracle_id,
        _indigopay_id,
        _escrow_id,
    ) = setup_contracts();

    let usdc_admin = Address::generate(&env);
    let usdc_token = env.register_stellar_asset_contract_v2(usdc_admin).address();
    let project_id = SorobanString::from_str(&env, "proj-oracle");
    let usdc_amount: i128 = 10 * 1_000_000;

    oracle_client.report_price(&oracle_reporter, &80_000_000);
    indigopay_client.set_usdc_token(&admin, &usdc_token);
    indigopay_client.set_oracle(&admin, &oracle_id);
    indigopay_client.register_project(
        &admin,
        &project_id,
        &SorobanString::from_str(&env, "Oracle Project"),
        &project_wallet,
        &100u32,
    );

    StellarAssetClient::new(&env, &usdc_token).mint(&donor, &usdc_amount);
    indigopay_client.donate_usdc(&usdc_token, &donor, &project_id, &usdc_amount, &42u32);

    let project = indigopay_client.get_project(&project_id);
    let global_stats = indigopay_client.get_global_stats();
    let record = indigopay_client.get_donation_record(&0u32);
    assert_eq!(project.total_raised, 80_000_000);
    assert_eq!(global_stats.total_raised, 80_000_000);
    assert_eq!(record.amount, usdc_amount);
    assert_eq!(record.currency, symbol_short!("USDC"));
}

#[test]
#[ignore]
fn integration_oracle_fallback_is_used_when_price_becomes_stale() {
    let (
        env,
        admin,
        oracle_admin,
        oracle_reporter,
        donor,
        project_wallet,
        indigopay_client,
        _escrow_client,
        oracle_client,
        oracle_id,
        _indigopay_id,
        _escrow_id,
    ) = setup_contracts();

    let usdc_admin = Address::generate(&env);
    let usdc_token = env.register_stellar_asset_contract_v2(usdc_admin).address();
    let project_id = SorobanString::from_str(&env, "proj-fallback");
    let usdc_amount: i128 = 10 * 1_000_000;

    oracle_client.report_price(&oracle_reporter, &80_000_000);
    oracle_client.set_fallback_price(&oracle_admin, &50_000_000);
    env.ledger().set_sequence(env.ledger().sequence() + 721);

    indigopay_client.set_usdc_token(&admin, &usdc_token);
    indigopay_client.set_oracle(&admin, &oracle_id);
    indigopay_client.register_project(
        &admin,
        &project_id,
        &SorobanString::from_str(&env, "Fallback Project"),
        &project_wallet,
        &100u32,
    );

    StellarAssetClient::new(&env, &usdc_token).mint(&donor, &usdc_amount);
    indigopay_client.donate_usdc(&usdc_token, &donor, &project_id, &usdc_amount, &7u32);

    let project = indigopay_client.get_project(&project_id);
    assert_eq!(project.total_raised, 50_000_000);
}

#[test]
#[ignore]
fn integration_donation_and_escrow_job_creation_share_the_same_usdc_flow() {
    let (
        env,
        admin,
        _oracle_admin,
        oracle_reporter,
        donor,
        project_wallet,
        indigopay_client,
        escrow_client,
        oracle_client,
        oracle_id,
        _indigopay_id,
        _escrow_id,
    ) = setup_contracts();

    let usdc_admin = Address::generate(&env);
    let usdc_token = env.register_stellar_asset_contract_v2(usdc_admin).address();
    let project_id = SorobanString::from_str(&env, "proj-escrow");
    let usdc_amount: i128 = 10 * 1_000_000;
    let freelancer = Address::generate(&env);
    let job_id = SorobanString::from_str(&env, "job-escrow");

    oracle_client.report_price(&oracle_reporter, &80_000_000);
    indigopay_client.set_usdc_token(&admin, &usdc_token);
    indigopay_client.set_oracle(&admin, &oracle_id);
    indigopay_client.register_project(
        &admin,
        &project_id,
        &SorobanString::from_str(&env, "Escrow Project"),
        &project_wallet,
        &100u32,
    );

    StellarAssetClient::new(&env, &usdc_token).mint(&donor, &usdc_amount);
    indigopay_client.donate_usdc(&usdc_token, &donor, &project_id, &usdc_amount, &99u32);

    let user_token_client = StellarAssetClient::new(&env, &usdc_token);
    user_token_client.mint(&donor, &usdc_amount);
    escrow_client.create_job(
        &donor,
        &freelancer,
        &job_id,
        &usdc_token,
        &usdc_amount,
        &make_milestones(&env),
    );

    let job = escrow_client.get_job(&job_id).expect("job should exist");
    assert_eq!(job.status, JobStatus::Escrowed);
    assert_eq!(job.amount, usdc_amount);
    assert_eq!(job.milestones.len(), 3);
    assert_eq!(escrow_client.get_job_count(), 1);
}

#[test]
#[ignore]
fn integration_escrow_release_after_donation_linked_job_is_processed() {
    let (
        env,
        admin,
        _oracle_admin,
        oracle_reporter,
        donor,
        project_wallet,
        indigopay_client,
        escrow_client,
        oracle_client,
        oracle_id,
        _indigopay_id,
        _escrow_id,
    ) = setup_contracts();

    let usdc_admin = Address::generate(&env);
    let usdc_token = env.register_stellar_asset_contract_v2(usdc_admin).address();
    let project_id = SorobanString::from_str(&env, "proj-release");
    let usdc_amount: i128 = 10 * 1_000_000;
    let freelancer = Address::generate(&env);
    let job_id = SorobanString::from_str(&env, "job-release");

    oracle_client.report_price(&oracle_reporter, &80_000_000);
    indigopay_client.set_usdc_token(&admin, &usdc_token);
    indigopay_client.set_oracle(&admin, &oracle_id);
    indigopay_client.register_project(
        &admin,
        &project_id,
        &SorobanString::from_str(&env, "Release Project"),
        &project_wallet,
        &100u32,
    );

    StellarAssetClient::new(&env, &usdc_token).mint(&donor, &usdc_amount);
    indigopay_client.donate_usdc(&usdc_token, &donor, &project_id, &usdc_amount, &3u32);

    let user_token_client = StellarAssetClient::new(&env, &usdc_token);
    user_token_client.mint(&donor, &usdc_amount);
    escrow_client.create_job(
        &donor,
        &freelancer,
        &job_id,
        &usdc_token,
        &usdc_amount,
        &make_milestones(&env),
    );

    escrow_client.release_milestone(&donor, &job_id, &0u32);
    let job = escrow_client.get_job(&job_id).expect("job should exist");
    assert_eq!(job.status, JobStatus::PartiallyReleased);
    assert!(job.milestones.get(0).unwrap().released);
}

#[test]
#[ignore]
fn integration_direct_oracle_report_and_get_price_round_trip() {
    let env = Env::default();
    env.mock_all_auths();

    let oracle_id = env.register_contract(None, SimpleOracle);
    let oracle_client = SimpleOracleClient::new(&env, &oracle_id);
    let admin = Address::generate(&env);
    let reporter = Address::generate(&env);

    oracle_client.initialize(&admin);
    oracle_client.add_reporter(&admin, &reporter);
    oracle_client.report_price(&reporter, &80_000_000);

    assert_eq!(oracle_client.get_price(), 8);
}
