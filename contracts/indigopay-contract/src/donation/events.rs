use soroban_sdk::{contractevent, Address, BytesN, Env};

// WS7 typed contract events. Emitted topic list and data payload are
// byte-for-byte identical to the legacy `env.events().publish(...)` sites these
// replace, so indexers observe an unchanged stealth-donation stream.
//
// `StelthDn` / `StlthScn` / `StlthWdr` use the exact 1-word Symbol spelling the
// legacy `symbol_short!` sites produced.

#[contractevent(export = false, topics = ["StelthDn"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StealthDonation {
    #[topic]
    pub project_wallet: Address,
    pub donation_id: u64,
    pub amount: i128,
    pub ephemeral_pubkey: BytesN<33>,
    pub msg_hash: BytesN<32>,
    pub timestamp: u64,
}

#[contractevent(export = false, topics = ["StlthScn"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StealthScan {
    #[topic]
    pub project_wallet: Address,
    pub donation_count: u32,
    pub timestamp: u64,
}

#[contractevent(export = false, topics = ["StlthWdr"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StealthWithdrawal {
    #[topic]
    pub project_wallet: Address,
    pub token: Address,
    pub amount: i128,
    pub remaining_balance: i128,
    pub timestamp: u64,
}

pub fn emit_stealth_donation(
    env: &Env,
    donation_id: u64,
    project_wallet: &Address,
    amount: i128,
    ephemeral_pubkey: &BytesN<33>,
    msg_hash: &BytesN<32>,
) {
    let timestamp = env.ledger().timestamp();
    StealthDonation {
        project_wallet: project_wallet.clone(),
        donation_id,
        amount,
        ephemeral_pubkey: ephemeral_pubkey.clone(),
        msg_hash: msg_hash.clone(),
        timestamp,
    }
    .publish(env);
}

pub fn emit_stealth_scan(env: &Env, project_wallet: &Address, donation_count: u32) {
    StealthScan {
        project_wallet: project_wallet.clone(),
        donation_count,
        timestamp: env.ledger().timestamp(),
    }
    .publish(env);
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
    StealthWithdrawal {
        project_wallet: project_wallet.clone(),
        token: token.clone(),
        amount,
        remaining_balance,
        timestamp: env.ledger().timestamp(),
    }
    .publish(env);
}
