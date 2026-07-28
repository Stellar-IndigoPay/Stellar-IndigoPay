use soroban_sdk::{Address, Env, Vec};

use crate::donation::types::{DataKey, StealthDonation};

pub const MAX_DONATIONS_PER_PROJECT: u64 = 10_000;

pub fn get_stealth_counter(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::StealthCounter)
        .unwrap_or(0u64)
}

pub fn set_stealth_counter(env: &Env, counter: u64) {
    env.storage()
        .instance()
        .set(&DataKey::StealthCounter, &counter);
}

pub fn set_stealth_donation(env: &Env, id: u64, donation: &StealthDonation) {
    env.storage()
        .persistent()
        .set(&DataKey::StealthDonation(id), donation);
}

pub fn get_stealth_donation(env: &Env, id: u64) -> StealthDonation {
    env.storage()
        .persistent()
        .get(&DataKey::StealthDonation(id))
        .expect("stealth donation not found")
}

pub fn add_project_donation(env: &Env, project: &Address, donation_id: u64) {
    let mut ids: Vec<u64> = env
        .storage()
        .persistent()
        .get(&DataKey::ProjectDonations(project.clone()))
        .unwrap_or(Vec::new(env));
    if ids.len() as u64 >= MAX_DONATIONS_PER_PROJECT {
        panic!("max donations per project reached");
    }
    ids.push_back(donation_id);
    env.storage()
        .persistent()
        .set(&DataKey::ProjectDonations(project.clone()), &ids);
}

pub fn get_project_donations(env: &Env, project: &Address) -> Vec<u64> {
    env.storage()
        .persistent()
        .get(&DataKey::ProjectDonations(project.clone()))
        .unwrap_or(Vec::new(env))
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    #[should_panic(expected = "max donations per project reached")]
    fn test_add_project_donation_max_limit() {
        let env = Env::default();
        let project = Address::generate(&env);

        let mut ids = Vec::new(&env);
        for i in 0..MAX_DONATIONS_PER_PROJECT {
            ids.push_back(i);
        }
        env.storage()
            .persistent()
            .set(&DataKey::ProjectDonations(project.clone()), &ids);

        add_project_donation(&env, &project, 10_001);
    }
}

