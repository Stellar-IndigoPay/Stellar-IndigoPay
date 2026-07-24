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
pub enum DataKey {
    StealthCounter,
    StealthDonation(u64),
    ProjectDonations(Address),
}
