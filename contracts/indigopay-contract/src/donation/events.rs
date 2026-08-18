use soroban_sdk::{symbol_short, Address, BytesN, Env};

pub fn emit_stealth_donation(
    env: &Env,
    donation_id: u64,
    project_wallet: &Address,
    amount: i128,
    ephemeral_pubkey: &BytesN<33>,
    msg_hash: &BytesN<32>,
) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("StelthDn"), project_wallet.clone()),
        (
            donation_id,
            amount,
            ephemeral_pubkey.clone(),
            msg_hash.clone(),
            timestamp,
        ),
    );
}

pub fn emit_stealth_scan(env: &Env, project_wallet: &Address, donation_count: u32) {
    env.events().publish(
        (symbol_short!("StlthScn"), project_wallet.clone()),
        (donation_count, env.ledger().timestamp()),
    );
}

/// Emitted when a project wallet withdraws stealth-donated funds from the
/// `DonationContract` to its own wallet (#621). `remaining_balance` lets
/// indexers reconcile on-chain `total_raised` with funds actually received
/// by the project.
pub fn emit_stealth_withdrawal(
    env: &Env,
    project_wallet: &Address,
    token: &Address,
    amount: i128,
    remaining_balance: i128,
) {
    env.events().publish(
        (symbol_short!("StlthWdr"), project_wallet.clone()),
        (
            token.clone(),
            amount,
            remaining_balance,
            env.ledger().timestamp(),
        ),
    );
}
