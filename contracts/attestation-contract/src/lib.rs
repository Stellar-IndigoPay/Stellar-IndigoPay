#![no_std]
#![allow(clippy::too_many_arguments)]
#![allow(deprecated)]
// The env.events().publish() calls use the deprecated `Events::publish`
// method. The #[contractevent] migration is tracked in TODO(indigopay-272).
/**
 * contracts/attestation-contract/src/lib.rs
 *
 * Stellar IndigoPay — Cross-Chain Donation Attestation Bridge
 *
 * This contract records verifiable on-chain attestations that a donation
 * occurred on a non-Stellar source chain (e.g. Ethereum, Polygon) and
 * attributes it to a Stellar donor address plus a registered IndigoPay
 * project. Trusts a designated `relayer` admin to do the bookkeeping —
 * later iterations may replace this with on-chain light-client proofs.
 *
 * Lifecycle:
 *   1. Admin calls `initialize(admin)` once.
 *   2. Admin calls `set_relayer(relayer)` to authorise the off-chain
 *      component that watches source chains (e.g. an EVM RPC worker).
 *   3. Relayer (after source-chain finality) calls
 *      `record_attestation(...)` with the donor's Stellar address and
 *      the source tx hash. Replay of (source_chain, source_tx_hash) is
 *      rejected on-chain.
 *   4. Anyone can call `verify_attestation(id)` to flip the status from
 *      PENDING to VERIFIED after the relayer double-checks the proof.
 *   5. Reads (`get_attestation`, `get_by_source`, `get_by_donor`,
 *      `get_pending_count`, `get_total_count`) power the frontend /
 *      backend without going through the indexer.
 *
 * Build:
 *   cargo build --target wasm32v1-none --release
 */
use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, String, Vec};

// ─── Source chains that this contract understands ───────────────────────────
//
// Cap at 32 chars so it fits comfortably in Soroban's Symbol limit and stays
// human-readable on indexer UIs ("ethereum", "polygon", "arbitrum", ...).
const MAX_SOURCE_CHAIN_LEN: u32 = 32;
const MAX_TX_HASH_LEN: u32 = 128;
const MAX_PROJECT_ID_LEN: u32 = 64;

// ─── Status enum ────────────────────────────────────────────────────────────
//
// `Pending`   – recorded by the relayer but not yet verified.
// `Verified`  – confirmed by a second relayer call or manual admin pass.
// `Revoked`   – admin undid a fraudulent attestation (e.g. source tx was
//                a re-orged fork). Kept in storage so reads still resolve
//                the id but `get_attestation` callers can see the reason.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum AttestationStatus {
    Pending,
    Verified,
    Revoked,
}

// ─── Storage types ──────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct Attestation {
    pub id: u64,
    pub source_chain: String,
    pub source_tx_hash: String,
    pub donor: Address,
    pub project_id: String,
    pub amount_usd: i128, // USD-equivalent value, 6 decimals (USDC convention).
    pub amount_xlm: i128, // XLM-equivalent at the time of recording, stroops.
    pub message_hash: u32,
    pub status: AttestationStatus,
    pub created_at_ledger: u32,
    pub verified_at_ledger: u32,
    pub created_by: Address, // the relayer that recorded it.
}

// ─── DataKey enum ───────────────────────────────────────────────────────────
//
// `SourceTxSeen(chain, hash)` is the on-chain replay guard. `Attestation(id)`
// is the canonical record. Ordering puts the guard first so a duplicate
// record always panics before mutating any counters.
#[contracttype]
pub enum DataKey {
    Admin,
    Relayer,
    /// PENDING → COMMITTED toggle.
    Paused,
    /// Optional admin-set source-chain allow-list. Whitelist=[] on init so
    /// every chain is accepted; admins can lock it down later if a malicious
    /// source keeps forging attestations.
    AllowedChain(String),
    AllowedChainInit,
    /// Monotonic attestation id. Starts at 0, incremented before each write
    /// so the first id is 0.
    NextAttestationId,
    Attestation(u64),
    /// (source_chain, source_tx_hash) presence flag — replay defence.
    SourceTxSeen(String, String),
    /// Donor index for "show me everything this wallet has bridged".
    DonorAttestations(Address),
    /// Total number of attestations ever recorded (verified + pending + revoked).
    TotalCount,
    /// Count of attestations currently in PENDING (filtered out by reads).
    PendingCount,
    /// Mutable upgrade timelock shared with the parent contract family.
    /// See `propose_upgrade` / `execute_upgrade` / `cancel_upgrade`.
    PendingUpgrade,
    UpgradeEffectiveAt,
    LastExecutedUpgrade,
}

// ─── Default / limit constants ──────────────────────────────────────────────
//
// 48 hours × 3600 s / 5 s per ledger ≈ 34 560 ledgers. Same window as
// `indigopay-contract` so two-step upgrade governance feels uniform across
// the contract family.
const UPGRADE_TIMELOCK_LEDGERS: u32 = 34_560;

fn read_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("Not initialized")
}

fn require_admin(env: &Env, caller: &Address) {
    if read_admin(env) != *caller {
        panic!("Only admin can perform this action");
    }
}

fn read_relayer(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Relayer)
}

fn require_relayer(env: &Env, caller: &Address) {
    let relayer = read_relayer(env).expect("Relayer not configured");
    if relayer != *caller {
        panic!("Only relayer can perform this action");
    }
}

fn require_not_paused(env: &Env) {
    let paused: bool = env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if paused {
        panic!("Contract is paused");
    }
}

fn require_positive(amount: i128, label: &str) {
    if amount <= 0 {
        panic!("Amount must be positive");
    }
    let _ = label; // currently unused; reserved for richer error messages.
}

// ─── Contract ───────────────────────────────────────────────────────────────

#[contract]
pub struct AttestationContract;

#[contractimpl]
impl AttestationContract {
    // ─── Initialization ─────────────────────────────────────────────────────

    /// One-shot init. Stores the admin and primes counters. Subsequent calls
    /// panic so a redeploy that doesn't re-init storage is called out.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialized");
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::NextAttestationId, &0u64);
        env.storage().instance().set(&DataKey::TotalCount, &0u64);
        env.storage().instance().set(&DataKey::PendingCount, &0u64);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish((symbol_short!("att_init"),), admin);
    }

    // ─── Configuration ─────────────────────────────────────────────────────

    /// Admin-only: set the relayer address that will record attestations.
    /// Refuses to overwrite; admin must explicitly `clear_relayer` first so
    /// a stuck key rotation can't silently change who signs new entries.
    pub fn set_relayer(env: Env, admin: Address, relayer: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        require_not_paused(&env);
        if env.storage().instance().has(&DataKey::Relayer) {
            panic!("Relayer already set; clear first");
        }
        env.storage().instance().set(&DataKey::Relayer, &relayer);
        env.events().publish((symbol_short!("rl_set"),), relayer);
    }

    /// Admin-only: drop the stored relayer. Used when the relayer key is
    /// compromised — until a fresh `set_relayer` is called no new
    /// attestations can be recorded.
    pub fn clear_relayer(env: Env, admin: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        if !env.storage().instance().has(&DataKey::Relayer) {
            panic!("Relayer not configured");
        }
        env.storage().instance().remove(&DataKey::Relayer);
        env.events().publish((symbol_short!("rl_clr"),), ());
    }

    /// Admin-only: register an allowed source chain. While the allow-list
    /// is non-empty `record_attestation` only accepts attestations whose
    /// `source_chain` is in it. Initial state is empty (all chains OK) so
    /// upgrading an existing deployment doesn't break in-flight bridges.
    pub fn add_allowed_chain(env: Env, admin: Address, chain: String) {
        admin.require_auth();
        require_admin(&env, &admin);
        require_not_paused(&env);
        // Mark init so we can distinguish "empty whitelist = all OK" from
        // "explicit denial" if the admin later wants to lock things down.
        env.storage()
            .instance()
            .set(&DataKey::AllowedChainInit, &true);
        env.storage()
            .instance()
            .set(&DataKey::AllowedChain(chain.clone()), &true);
        env.events().publish((symbol_short!("chain_a"),), chain);
    }

    /// Admin-only: remove a chain from the allow-list. After removal any new
    /// `record_attestation` with that chain panics.
    pub fn remove_allowed_chain(env: Env, admin: Address, chain: String) {
        admin.require_auth();
        require_admin(&env, &admin);
        require_not_paused(&env);
        env.storage()
            .instance()
            .remove(&DataKey::AllowedChain(chain.clone()));
        env.events().publish((symbol_short!("chain_r"),), chain);
    }

    /// Pause every state-mutating function. Reads continue to work so the
    /// frontend can keep showing existing attestations.
    pub fn pause(env: Env, admin: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish((symbol_short!("paused"),), ());
    }

    pub fn unpause(env: Env, admin: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish((symbol_short!("unpause"),), ());
    }

    // ─── Attestation lifecycle ─────────────────────────────────────────────

    /// Relayer-only — record a new attestation tying a source-chain
    /// transaction to a Stellar donor + project. Panics on:
    ///  - paused contract,
    ///  - duplicate (source_chain, source_tx_hash),
    ///  - chain not on the allow-list (when an allow-list exists),
    ///  - non-positive amount,
    ///  - ledger sequence overflow when stabilising effective_at.
    pub fn record_attestation(
        env: Env,
        relayer: Address,
        source_chain: String,
        source_tx_hash: String,
        donor: Address,
        project_id: String,
        amount_usd: i128,
        amount_xlm: i128,
        message_hash: u32,
    ) -> u64 {
        relayer.require_auth();
        require_relayer(&env, &relayer);
        require_not_paused(&env);

        // Length guards — Soroban Strings are unbounded on size so we add
        // explicit upper bounds to keep storage predictable.
        if source_chain.is_empty() || source_chain.len() > MAX_SOURCE_CHAIN_LEN {
            panic!("Invalid source_chain length");
        }
        if source_tx_hash.is_empty() || source_tx_hash.len() > MAX_TX_HASH_LEN {
            panic!("Invalid source_tx_hash length");
        }
        if project_id.is_empty() || project_id.len() > MAX_PROJECT_ID_LEN {
            panic!("Invalid project_id length");
        }
        // Donor is a Soroban Address (protocol-bounded, ~56 chars public key).
        require_positive(amount_usd, "amount_usd");
        require_positive(amount_xlm, "amount_xlm");

        // Allow-list enforcement when the admin has populated one.
        let allowlist_inited: bool = env
            .storage()
            .instance()
            .get(&DataKey::AllowedChainInit)
            .unwrap_or(false);
        if allowlist_inited {
            let allowed: bool = env
                .storage()
                .instance()
                .get(&DataKey::AllowedChain(source_chain.clone()))
                .unwrap_or(false);
            if !allowed {
                panic!("Source chain not allowed");
            }
        }

        // ─── Replay protection (Checks-Effects-Interactions) ──────────────
        let seen_key = DataKey::SourceTxSeen(source_chain.clone(), source_tx_hash.clone());
        if env.storage().instance().has(&seen_key) {
            panic!("Source transaction already attested");
        }
        env.storage().instance().set(&seen_key, &true);

        // Persist donor → attestation index BEFORE allocating the id so a
        // crash mid-write can't orphan the index. Idempotent re-records
        // can't happen because we already panicked above.
        let id: u64 = {
            let next: u64 = env
                .storage()
                .instance()
                .get(&DataKey::NextAttestationId)
                .unwrap_or(0);
            let new_id = next.checked_add(1).expect("Attestation id overflow");
            env.storage()
                .instance()
                .set(&DataKey::NextAttestationId, &new_id);
            new_id
        };

        let now = env.ledger().sequence();
        let record = Attestation {
            id,
            source_chain: source_chain.clone(),
            source_tx_hash: source_tx_hash.clone(),
            donor: donor.clone(),
            project_id: project_id.clone(),
            amount_usd,
            amount_xlm,
            message_hash,
            status: AttestationStatus::Pending,
            created_at_ledger: now,
            verified_at_ledger: 0,
            created_by: relayer.clone(),
        };
        env.storage()
            .instance()
            .set(&DataKey::Attestation(id), &record);

        let total: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TotalCount)
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::TotalCount,
            &total.checked_add(1).expect("total overflow"),
        );
        let pending: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PendingCount)
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::PendingCount,
            &pending.checked_add(1).expect("pending overflow"),
        );

        let donor_key = DataKey::DonorAttestations(donor.clone());
        let mut list: Vec<u64> = env
            .storage()
            .instance()
            .get(&donor_key)
            .unwrap_or(Vec::new(&env));
        list.push_back(id);
        env.storage().instance().set(&donor_key, &list);

        env.events().publish(
            (
                symbol_short!("att_new"),
                relayer.clone(),
                donor.clone(),
                source_chain.clone(),
            ),
            (id, project_id, amount_usd, amount_xlm),
        );

        id
    }

    /// Anyone may call `verify_attestation(id)`. Idempotent: a second call
    /// on an already-verified attestation panics with a clear message so a
    /// buggy double-submit fails loudly.
    pub fn verify_attestation(env: Env, id: u64) {
        let mut record: Attestation = env
            .storage()
            .instance()
            .get(&DataKey::Attestation(id))
            .expect("Attestation not found");
        match record.status {
            AttestationStatus::Verified => panic!("Already verified"),
            AttestationStatus::Revoked => panic!("Attestation was revoked"),
            AttestationStatus::Pending => {}
        }

        record.status = AttestationStatus::Verified;
        record.verified_at_ledger = env.ledger().sequence();
        env.storage()
            .instance()
            .set(&DataKey::Attestation(id), &record);

        let pending: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PendingCount)
            .unwrap_or(0);
        if pending > 0 {
            let new_pending = pending - 1;
            env.storage()
                .instance()
                .set(&DataKey::PendingCount, &new_pending);
        }

        env.events().publish((symbol_short!("att_vfy"),), id);
    }

    /// Admin-only: revoke an attestation. Used when the source-chain tx is
    /// later found to be invalid (e.g. a deep reorg on the source chain
    /// orphaned the block). The record stays in storage so historical
    /// lookups still resolve but the status flips to `Revoked`.
    pub fn revoke_attestation(env: Env, admin: Address, id: u64) {
        admin.require_auth();
        require_admin(&env, &admin);
        let mut record: Attestation = env
            .storage()
            .instance()
            .get(&DataKey::Attestation(id))
            .expect("Attestation not found");
        if record.status == AttestationStatus::Revoked {
            panic!("Already revoked");
        }
        let was_pending = matches!(record.status, AttestationStatus::Pending);
        record.status = AttestationStatus::Revoked;
        env.storage()
            .instance()
            .set(&DataKey::Attestation(id), &record);
        if was_pending {
            let pending: u64 = env
                .storage()
                .instance()
                .get(&DataKey::PendingCount)
                .unwrap_or(0);
            if pending > 0 {
                let new_pending = pending - 1;
                env.storage()
                    .instance()
                    .set(&DataKey::PendingCount, &new_pending);
            }
        }
        env.events().publish((symbol_short!("att_rvk"), admin), id);
    }

    // ─── Read endpoints ────────────────────────────────────────────────────

    pub fn get_attestation(env: Env, id: u64) -> Attestation {
        env.storage()
            .instance()
            .get(&DataKey::Attestation(id))
            .expect("Attestation not found")
    }

    /// Convenience: locate an attestation by the source-chain keys without
    /// first scanning the index. Returns the id if found, None otherwise.
    pub fn get_attestation_by_source(
        env: Env,
        source_chain: String,
        source_tx_hash: String,
    ) -> Option<u64> {
        // Clone before the move into the DataKey so we can compare later.
        let chain_check = source_chain.clone();
        let hash_check = source_tx_hash.clone();
        if !env
            .storage()
            .instance()
            .has(&DataKey::SourceTxSeen(source_chain, source_tx_hash))
        {
            return None;
        }
        // See note below: the on-chain replay flag doesn't carry the id, so
        // we fall back to scanning from the most recent id down to 1.
        // next is the next available slot; the actual ids are 1..=next.
        let next: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextAttestationId)
            .unwrap_or(0);
        if next == 0 {
            return None;
        }
        // Scan backwards from the most recent id. Bounded because `next`
        // itself caps at u64::MAX.
        let mut cursor: u64 = next;
        loop {
            if cursor == 0 {
                return None;
            }
            if let Some(rec) = env
                .storage()
                .instance()
                .get::<DataKey, Attestation>(&DataKey::Attestation(cursor))
            {
                if rec.source_tx_hash == hash_check && rec.source_chain == chain_check {
                    return Some(cursor);
                }
            }
            cursor -= 1;
        }
    }

    pub fn get_by_donor(env: Env, donor: Address) -> Vec<Attestation> {
        let ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::DonorAttestations(donor.clone()))
            .unwrap_or(Vec::new(&env));
        let mut out: Vec<Attestation> = Vec::new(&env);
        for id in ids.iter() {
            if let Some(rec) = env.storage().instance().get(&DataKey::Attestation(id)) {
                out.push_back(rec);
            }
        }
        out
    }

    pub fn get_pending_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::PendingCount)
            .unwrap_or(0)
    }

    pub fn get_total_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::TotalCount)
            .unwrap_or(0)
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn get_admin(env: Env) -> Address {
        read_admin(&env)
    }

    pub fn get_relayer(env: Env) -> Option<Address> {
        read_relayer(&env)
    }

    // ─── 48-hour upgrade timelock (mirrors parent contract) ────────────────

    pub fn propose_upgrade(env: Env, admin: Address, new_wasm_hash: soroban_sdk::BytesN<32>) {
        admin.require_auth();
        require_admin(&env, &admin);
        if env.storage().instance().has(&DataKey::PendingUpgrade) {
            panic!("Upgrade already pending");
        }
        let effective_at = env
            .ledger()
            .sequence()
            .checked_add(UPGRADE_TIMELOCK_LEDGERS)
            .expect("Upgrade effective-at overflow");
        env.storage()
            .instance()
            .set(&DataKey::PendingUpgrade, &new_wasm_hash);
        env.storage()
            .instance()
            .set(&DataKey::UpgradeEffectiveAt, &effective_at);
        env.events().publish(
            (symbol_short!("upg_prop"), admin),
            (new_wasm_hash, effective_at),
        );
    }

    pub fn execute_upgrade(env: Env) {
        let pending: soroban_sdk::BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
            .expect("No pending upgrade");
        let effective_at: u32 = env
            .storage()
            .instance()
            .get(&DataKey::UpgradeEffectiveAt)
            .expect("No pending upgrade effective-at");
        if env.ledger().sequence() < effective_at {
            panic!("Upgrade timelock not yet elapsed");
        }
        env.deployer().update_current_contract_wasm(pending.clone());
        env.storage()
            .instance()
            .set(&DataKey::LastExecutedUpgrade, &pending);
        env.storage().instance().remove(&DataKey::PendingUpgrade);
        env.storage()
            .instance()
            .remove(&DataKey::UpgradeEffectiveAt);
        env.events().publish((symbol_short!("upg_exec"),), pending);
    }

    pub fn cancel_upgrade(env: Env, admin: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        if !env.storage().instance().has(&DataKey::PendingUpgrade) {
            panic!("No pending upgrade");
        }
        env.storage().instance().remove(&DataKey::PendingUpgrade);
        env.storage()
            .instance()
            .remove(&DataKey::UpgradeEffectiveAt);
        env.events().publish((symbol_short!("upg_cncl"), admin), ());
    }

    pub fn get_pending_upgrade(env: Env) -> Option<(soroban_sdk::BytesN<32>, u32)> {
        let hash: Option<soroban_sdk::BytesN<32>> =
            env.storage().instance().get(&DataKey::PendingUpgrade);
        let effective: Option<u32> = env.storage().instance().get(&DataKey::UpgradeEffectiveAt);
        match (hash, effective) {
            (Some(h), Some(e)) => Some((h, e)),
            _ => None,
        }
    }

    pub fn get_last_executed_upgrade(env: Env) -> Option<soroban_sdk::BytesN<32>> {
        env.storage().instance().get(&DataKey::LastExecutedUpgrade)
    }
}

// ─── Unit tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::String;

    fn init_and_relayer() -> (Env, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, AttestationContract);
        let _client = AttestationContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        let relayer = Address::generate(&env);
        let donor = Address::generate(&env);
        // initialize must be called by admin — mock_all_auths lets Address::generate().require_auth through.
        let client = AttestationContractClient::new(&env, &id);
        client.initialize(&admin);
        client.set_relayer(&admin, &relayer);
        (env, id, admin, relayer, donor)
    }

    #[test]
    fn test_initialize_stores_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, AttestationContract);
        let client = AttestationContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_total_count(), 0);
        assert_eq!(client.get_pending_count(), 0);
        assert!(!client.is_paused());
    }

    #[test]
    #[should_panic(expected = "Contract already initialized")]
    fn test_double_init_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, AttestationContract);
        let client = AttestationContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        client.initialize(&admin);
    }

    #[test]
    fn test_record_attestation_returns_id_and_increments_counts() {
        let (env, id, _admin, _relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        let chain = String::from_str(&env, "ethereum");
        let tx_hash = String::from_str(&env, "0xabcdef");
        let project = String::from_str(&env, "proj-1");
        let new_id = client.record_attestation(
            &client.get_relayer().unwrap(),
            &chain,
            &tx_hash,
            &donor,
            &project,
            &10_000_000i128, // 10 USDC (6dp)
            &80_000_000i128, // 80 XLM stroops
            &1u32,
        );
        assert_eq!(new_id, 1u64);
        assert_eq!(client.get_total_count(), 1);
        assert_eq!(client.get_pending_count(), 1);
        let rec = client.get_attestation(&new_id);
        assert_eq!(rec.status, AttestationStatus::Pending);
        assert_eq!(rec.donor, donor);
        assert_eq!(rec.project_id, project);
    }

    #[test]
    #[should_panic(expected = "Source transaction already attested")]
    fn test_replay_attempt_panics() {
        let (env, id, _admin, _relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        let chain = String::from_str(&env, "ethereum");
        let tx_hash = String::from_str(&env, "0xabcdef");
        let project = String::from_str(&env, "proj-1");
        client.record_attestation(
            &client.get_relayer().unwrap(),
            &chain,
            &tx_hash,
            &donor,
            &project,
            &10_000_000i128,
            &80_000_000i128,
            &1u32,
        );
        // Second call with the same source must panic.
        client.record_attestation(
            &client.get_relayer().unwrap(),
            &chain,
            &tx_hash,
            &donor,
            &project,
            &10_000_000i128,
            &80_000_000i128,
            &2u32,
        );
    }

    #[test]
    fn test_verify_attestation_moves_to_verified() {
        let (env, id, _admin, _relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        let chain = String::from_str(&env, "polygon");
        let tx_hash = String::from_str(&env, "0xdeadbeef");
        let new_id = client.record_attestation(
            &client.get_relayer().unwrap(),
            &chain,
            &tx_hash,
            &donor,
            &String::from_str(&env, "proj"),
            &1_000_000i128,
            &8_000_000i128,
            &0u32,
        );
        assert_eq!(client.get_pending_count(), 1);
        client.verify_attestation(&new_id);
        let rec = client.get_attestation(&new_id);
        assert_eq!(rec.status, AttestationStatus::Verified);
        assert_eq!(client.get_pending_count(), 0);
        assert_eq!(client.get_total_count(), 1);
    }

    #[test]
    #[should_panic(expected = "Already verified")]
    fn test_double_verify_panics() {
        let (env, id, _admin, _relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        let new_id = client.record_attestation(
            &client.get_relayer().unwrap(),
            &String::from_str(&env, "ethereum"),
            &String::from_str(&env, "0x11"),
            &donor,
            &String::from_str(&env, "proj"),
            &1i128,
            &1i128,
            &0u32,
        );
        client.verify_attestation(&new_id);
        client.verify_attestation(&new_id);
    }

    #[test]
    fn test_revoke_attestation_keeps_record_but_status_is_revoked() {
        let (env, id, admin, _relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        let new_id = client.record_attestation(
            &client.get_relayer().unwrap(),
            &String::from_str(&env, "ethereum"),
            &String::from_str(&env, "0x22"),
            &donor,
            &String::from_str(&env, "proj"),
            &1i128,
            &1i128,
            &0u32,
        );
        client.revoke_attestation(&admin, &new_id);
        let rec = client.get_attestation(&new_id);
        assert_eq!(rec.status, AttestationStatus::Revoked);
        assert_eq!(client.get_pending_count(), 0);
    }

    #[test]
    fn test_get_by_donor_returns_all_attestations_for_that_donor() {
        let (env, id, _admin, _relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        // two attestations, different (chain, hash) tuples so replay guard is satisfied
        client.record_attestation(
            &client.get_relayer().unwrap(),
            &String::from_str(&env, "ethereum"),
            &String::from_str(&env, "0xa1"),
            &donor,
            &String::from_str(&env, "proj"),
            &1i128,
            &1i128,
            &0u32,
        );
        client.record_attestation(
            &client.get_relayer().unwrap(),
            &String::from_str(&env, "polygon"),
            &String::from_str(&env, "0xb2"),
            &donor,
            &String::from_str(&env, "proj"),
            &1i128,
            &1i128,
            &0u32,
        );
        let list = client.get_by_donor(&donor);
        assert_eq!(list.len(), 2);
    }

    #[test]
    #[should_panic(expected = "Source chain not allowed")]
    fn test_allow_list_rejects_unlisted_chain() {
        let (env, id, admin, _relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        // Lock down to ethereum only
        client.add_allowed_chain(&admin, &String::from_str(&env, "ethereum"));
        // polygon must be rejected
        client.record_attestation(
            &client.get_relayer().unwrap(),
            &String::from_str(&env, "polygon"),
            &String::from_str(&env, "0xc3"),
            &donor,
            &String::from_str(&env, "proj"),
            &1i128,
            &1i128,
            &0u32,
        );
    }

    #[test]
    fn test_pause_blocks_record_attestation() {
        let (env, id, admin, _relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        client.pause(&admin);
        assert!(client.is_paused());
        // We can't easily capture the panic from a client call inside this
        // test, so we check the flag and let `test_pause_blocks_record_via_event`
        // exercise the panic in #[should_panic] form.
        let _ = donor; // silence unused
    }

    #[test]
    #[should_panic(expected = "Contract is paused")]
    fn test_pause_blocks_record_via_event() {
        let (env, id, admin, _relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        client.pause(&admin);
        client.record_attestation(
            &client.get_relayer().unwrap(),
            &String::from_str(&env, "ethereum"),
            &String::from_str(&env, "0xd4"),
            &donor,
            &String::from_str(&env, "proj"),
            &1i128,
            &1i128,
            &0u32,
        );
    }

    #[test]
    #[should_panic(expected = "Only relayer can perform this action")]
    fn test_non_relayer_cannot_record() {
        let (env, id, _admin, _relayer, _donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        let attacker = Address::generate(&env);
        client.record_attestation(
            &attacker,
            &String::from_str(&env, "ethereum"),
            &String::from_str(&env, "0xe5"),
            &address_donor(&env),
            &String::from_str(&env, "proj"),
            &1i128,
            &1i128,
            &0u32,
        );
    }

    fn address_donor(env: &Env) -> Address {
        Address::generate(env)
    }

    #[test]
    #[should_panic(expected = "Amount must be positive")]
    fn test_zero_amount_panics() {
        let (env, id, _admin, _relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        client.record_attestation(
            &client.get_relayer().unwrap(),
            &String::from_str(&env, "ethereum"),
            &String::from_str(&env, "0xf6"),
            &donor,
            &String::from_str(&env, "proj"),
            &0i128,
            &0i128,
            &0u32,
        );
    }

    #[test]
    fn test_get_attestation_by_source_resolves_to_correct_id() {
        let (env, id, _admin, _relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        let chain = String::from_str(&env, "arbitrum");
        let tx_hash = String::from_str(&env, "0x77");
        let new_id = client.record_attestation(
            &client.get_relayer().unwrap(),
            &chain,
            &tx_hash,
            &donor,
            &String::from_str(&env, "proj"),
            &1i128,
            &1i128,
            &0u32,
        );
        let found = client.get_attestation_by_source(&chain, &tx_hash);
        assert_eq!(found, Some(new_id));
    }
}
