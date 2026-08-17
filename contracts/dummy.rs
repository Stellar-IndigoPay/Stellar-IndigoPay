#![no_std]
use soroban_sdk::{contract, contractimpl, Env, Address};
#[contract] pub struct Dummy;
#[contractimpl]
impl Dummy {
    pub fn test(env: Env, target: Address) {
        let result = env.try_invoke_contract::<i128, soroban_sdk::Error>(&target, &soroban_sdk::symbol_short!("get_price"), soroban_sdk::Vec::new(&env));
        match result {
            Ok(Ok(_)) => {}
            Ok(Err(_)) => {}
            Err(_) => {}
        }
    }
}
