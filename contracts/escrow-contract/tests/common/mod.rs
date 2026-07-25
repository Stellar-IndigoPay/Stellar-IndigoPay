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

/// Build a single-element signer Vec for admin calls.
pub fn signers1(env: &Env, a: &Address) -> Vec<Address> {
    let mut v = Vec::new(env);
    v.push_back(a.clone());
    v
}

/// Create an escrow contract instance with a freshly-generated single-admin
/// (1-of-1) admin set, and return the admin address + contract client.
pub fn setup<'a>(env: &'a Env) -> (Address, EscrowContractClient<'a>) {
    let cid = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &cid);
    let admin = Address::generate(env);
    client.initialize(&signers1(env, &admin), &1u32);
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
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });
    client.create_job(
        client_addr,
        freelancer,
        &SorobanString::from_str(env, job_id),
        token,
        &amount,
        &milestones,
        &escrow_contract::RELEASE_AFTER_LEDGERS,
    );
}

/// Return the token balance for a given address.
#[allow(dead_code)]
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
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });
    milestones.push_back(Milestone {
        name: SorobanString::from_str(env, "Development"),
        percentage: 30,
        released: false,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });
    milestones.push_back(Milestone {
        name: SorobanString::from_str(env, "Testing"),
        percentage: 20,
        released: false,
        disputed: false,
        oracle: None,
        verified: false,
        proof_hash: None,
    });
    milestones
}
