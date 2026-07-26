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

pub fn emit_pause_recurring(env: &Env, donation_id: u64, donor: &Address, paused_at: u64) {
    env.events().publish(
        (symbol_short!("rec_pause"), donor.clone()),
        (donation_id, paused_at),
    );
}

pub fn emit_resume_recurring(
    env: &Env,
    donation_id: u64,
    donor: &Address,
    catch_up: bool,
    catch_up_amount: i128,
) {
    env.events().publish(
        (symbol_short!("rec_resum"), donor.clone()),
        (donation_id, catch_up, catch_up_amount),
    );
}
