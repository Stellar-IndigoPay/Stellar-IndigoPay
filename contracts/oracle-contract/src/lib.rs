#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

#[contracttype]
pub enum DataKey {
    Price,
    Admin,
}

#[contract]
pub struct SimpleOracle;

#[contractimpl]
impl SimpleOracle {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn set_price(env: Env, admin: Address, price: i128) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Oracle not initialized");
        if stored_admin != admin {
            panic!("Only admin can perform this action");
        }
        env.storage().instance().set(&DataKey::Price, &price);
    }

    pub fn get_price(env: Env) -> i128 {
        let stored: i128 = env.storage().instance().get(&DataKey::Price).unwrap_or(0);
        stored / 10_000_000
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    #[test]
    fn test_initialize_and_get_price_default() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SimpleOracle);
        let client = SimpleOracleClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        assert_eq!(client.get_price(), 0);
    }

    #[test]
    #[should_panic(expected = "Contract already initialized")]
    fn test_initialize_idempotency() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SimpleOracle);
        let client = SimpleOracleClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);
        client.initialize(&admin);
    }

    #[test]
    fn test_set_and_get_price() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SimpleOracle);
        let client = SimpleOracleClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        client.set_price(&admin, &80_000_000);
        assert_eq!(client.get_price(), 8);

        client.set_price(&admin, &120_000_000);
        assert_eq!(client.get_price(), 12);
    }

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn test_admin_authorization() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SimpleOracle);
        let client = SimpleOracleClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        client.initialize(&admin);

        client.set_price(&non_admin, &100_000_000);
    }
}
