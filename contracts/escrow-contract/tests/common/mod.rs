/// Common test utilities for the escrow-contract integration tests.
///
/// Re-exports the shared `setup()` helper so each test file can write:
/// ```ignore
/// mod common;
/// let (admin, client) = common::setup(&env);
/// ```
use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, Env, String as SorobanString, Vec};

use escrow_contract::{EscrowContract, EscrowContractClient, Milestone};

/// Create an escrow contract instance with a freshly-generated admin,
/// and return the admin address + contract client.
pub fn setup(env: &Env) -> (Address, EscrowContractClient) {
    let cid = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(env, &cid);
    let admin = Address::generate(env);
    client.initialize(&admin);
    (admin, client)
}

/// Mint `amount` of the native Stellar asset for `to`.
pub fn fund(env: &Env, token: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, token).mint(to, &amount);
}

/// Register a Stellar asset contract and return its token address.
pub fn create_token(env: &Env) -> Address {
    let token_admin = Address::generate(env);
    env.register_stellar_asset_contract_v2(token_admin)
        .address()
}

/// Create a simple job with a single 100% milestone and return the components.
/// Shorthand for tests that only need a single-milestone job set up.
#[allow(dead_code)]
pub fn create_simple_job(
    env: &Env,
    client: &EscrowContractClient,
    client_addr: &Address,
    freelancer: &Address,
    token: &Address,
    job_id: &str,
    amount: i128,
) {
    let mut milestones = Vec::new(env);
    milestones.push_back(Milestone {
        name: SorobanString::from_str(env, "Full Delivery"),
        percentage: 100,
        released: false,
    });
    client.create_job(
        client_addr,
        freelancer,
        &SorobanString::from_str(env, job_id),
        token,
        &amount,
        &milestones,
    );
}

/// Return the token balance for a given address.
pub fn token_balance(env: &Env, token: &Address, owner: &Address) -> i128 {
    TokenClient::new(env, token).balance(owner)
}

/// Build a three-milestone vector: 50 % + 30 % + 20 %
#[allow(dead_code)]
pub fn three_milestones(env: &Env) -> Vec<Milestone> {
    let mut milestones = Vec::new(env);
    milestones.push_back(Milestone {
        name: SorobanString::from_str(env, "Design"),
        percentage: 50,
        released: false,
    });
    milestones.push_back(Milestone {
        name: SorobanString::from_str(env, "Development"),
        percentage: 30,
        released: false,
    });
    milestones.push_back(Milestone {
        name: SorobanString::from_str(env, "Testing"),
        percentage: 20,
        released: false,
    });
    milestones
}
