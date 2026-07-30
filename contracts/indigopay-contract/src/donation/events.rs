use soroban_sdk::{symbol_short, Address, BytesN, Env, Symbol};

pub fn emit_stealth_donation(
    e: &Env,
    id: u64,
    wallet: &Address,
    amount: i128,
    pubkey: &BytesN<33>,
    msg_hash: &BytesN<32>,
) {
    let ts = e.ledger().timestamp();
    e.events().publish(
        (symbol_short!("StelthDn"), wallet.clone()),
        (id, amount, pubkey.clone(), msg_hash.clone(), ts),
    );
}

pub fn emit_stealth_scan(e: &Env, wallet: &Address, count: u32) {
    e.events().publish(
        (Symbol::new(e, "StealthScan"), wallet.clone()),
        (count, e.ledger().timestamp()),
    );
}

pub fn emit_pause_recurring(e: &Env, rec_id: u64, wallet: &Address) {
    e.events().publish(
        (symbol_short!("PauseRec"), wallet.clone()),
        (rec_id, e.ledger().timestamp()),
    );
}

pub fn emit_resume_recurring(e: &Env, rec_id: u64, wallet: &Address) {
    e.events().publish(
        (symbol_short!("ResumRec"), wallet.clone()),
        (rec_id, e.ledger().timestamp()),
    );
}
