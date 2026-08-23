use soroban_sdk::{Address, Env, Vec};

use crate::donation::types::{DataKey, StealthDonation};

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

pub fn get_stealth_donation(env: &Env, id: u64) -> Option<StealthDonation> {
    env.storage()
        .persistent()
        .get(&DataKey::StealthDonation(id))
}

pub fn add_project_donation(env: &Env, project: &Address, donation_id: u64) {
    let mut ids: Vec<u64> = env
        .storage()
        .persistent()
        .get(&DataKey::ProjectDonations(project.clone()))
        .unwrap_or(Vec::new(env));
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

pub fn get_stealth_withdrawable_balance(env: &Env, project: &Address, token: &Address) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::StealthWithdrawableBalance(
            project.clone(),
            token.clone(),
        ))
        .unwrap_or(0i128)
}

pub fn add_stealth_withdrawable_balance(
    env: &Env,
    project: &Address,
    token: &Address,
    amount: i128,
) {
    let balance = get_stealth_withdrawable_balance(env, project, token);
    set_stealth_withdrawable_balance(
        env,
        project,
        token,
        balance.checked_add(amount).expect("overflow"),
    );
}

pub fn set_stealth_withdrawable_balance(
    env: &Env,
    project: &Address,
    token: &Address,
    balance: i128,
) {
    env.storage().instance().set(
        &DataKey::StealthWithdrawableBalance(project.clone(), token.clone()),
        &balance,
    );
}
