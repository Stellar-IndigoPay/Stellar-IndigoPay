use soroban_sdk::{contracttype, Address, BytesN};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StealthDonation {
    pub stealth_address: BytesN<32>,
    pub project_wallet: Address,
    pub ephemeral_pubkey: BytesN<33>,
    pub amount: i128,
    pub msg_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecurringDonation {
    pub id: u64,
    pub donor: Address,
    pub project_wallet: Address,
    pub amount: i128,
    pub interval_ledgers: u64,
    pub next_execution_ledger: u64,
    pub paused: bool,
    pub paused_at: u64,
}

#[contracttype]
pub enum DataKey {
    StealthCounter,
    StealthDonation(u64),
    ProjectDonations(Address),
    RecurringCounter,
    RecurringDonation(u64),
}
