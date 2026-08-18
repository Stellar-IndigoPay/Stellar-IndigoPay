use soroban_sdk::{contracterror, contracttype, Address, BytesN};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StealthDonation {
    pub stealth_address: BytesN<32>,
    pub project_wallet: Address,
    pub ephemeral_pubkey: BytesN<33>,
    pub amount: i128,
    pub msg_hash: BytesN<32>,
}

/// Structured errors for the stealth donation module (#621).
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum DonationError {
    /// `withdraw_stealth_donations` requires a strictly positive amount.
    WithdrawalAmountMustBePositive = 1,
    /// The requested withdrawal exceeds the project's per-(project_wallet, token)
    /// stealth withdrawable balance held by the `DonationContract`.
    InsufficientStealthWithdrawableBalance = 2,
}

#[contracttype]
pub enum DataKey {
    StealthCounter,
    StealthDonation(u64),
    ProjectDonations(Address),
    /// Per-(project_wallet, token) balance of stealth-donated funds held by
    /// this contract and creditable to the project wallet. Credited on
    /// `donate_stealth`, debited on `withdraw_stealth_donations` (#621).
    StealthWithdrawableBalance(Address, Address),
}
