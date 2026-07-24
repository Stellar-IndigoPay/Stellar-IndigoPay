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
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Map, String, Vec,
};

#[cfg(all(test, feature = "testutils"))]
mod fuzz_tests;

// ─── Source chains that this contract understands ───────────────────────────
//
// Cap at 32 chars so it fits comfortably in Soroban's Symbol limit and stays
// human-readable on indexer UIs ("ethereum", "polygon", "arbitrum", ...).
const MAX_SOURCE_CHAIN_LEN: u32 = 32;
const MAX_TX_HASH_LEN: u32 = 128;
const MAX_PROJECT_ID_LEN: u32 = 64;
pub const MAX_BATCH_SIZE: u32 = 50;

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
pub struct BatchAttestationInput {
    pub source_chain: String,
    pub source_tx_hash: String,
    pub donor: Address,
    pub project_id: String,
    pub amount_usd: i128,
    pub amount_xlm: i128,
    pub message_hash: u32,
}

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
    /// Last assigned attestation id. Starts at 0 and is incremented before
    /// allocation, so the first id is 1.
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
    CoordinatedUpgrade,
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
    let coordinated: bool = env
        .storage()
        .instance()
        .get(&DataKey::CoordinatedUpgrade)
        .unwrap_or(false);
    if coordinated {
        panic!("Coordinated upgrade in progress");
    }
    let paused: bool = env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if paused {
        panic!("Contract is paused");
    }
}

fn require_not_coordinated_upgrade(env: &Env) {
    let coordinated: bool = env
        .storage()
        .instance()
        .get(&DataKey::CoordinatedUpgrade)
        .unwrap_or(false);
    if coordinated {
        panic!("Coordinated upgrade in progress");
    }
}

fn require_positive(amount: i128, label: &str) {
    if amount <= 0 {
        panic!("Amount must be positive");
    }
    let _ = label; // currently unused; reserved for richer error messages.
}

fn validate_source_chain(source_chain: &String) {
    if source_chain.is_empty() || source_chain.len() > MAX_SOURCE_CHAIN_LEN {
        panic!("Invalid source_chain length");
    }
}

fn validate_attestation_input(input: &BatchAttestationInput) {
    if input.source_tx_hash.is_empty() || input.source_tx_hash.len() > MAX_TX_HASH_LEN {
        panic!("Invalid source_tx_hash length");
    }
    if input.project_id.is_empty() || input.project_id.len() > MAX_PROJECT_ID_LEN {
        panic!("Invalid project_id length");
    }
    require_positive(input.amount_usd, "amount_usd");
    require_positive(input.amount_xlm, "amount_xlm");
}

fn require_source_chain_allowed(env: &Env, source_chain: &String) {
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
}

fn emit_attestation_new(env: &Env, relayer: &Address, record: &Attestation) {
    env.events().publish(
        (
            symbol_short!("att_new"),
            relayer.clone(),
            record.donor.clone(),
            record.source_chain.clone(),
        ),
        (
            record.id,
            record.project_id.clone(),
            record.amount_usd,
            record.amount_xlm,
        ),
    );
}

fn record_attestations_internal(
    env: &Env,
    relayer: &Address,
    attestations: Vec<BatchAttestationInput>,
    emit_batch_event: bool,
) -> Vec<u64> {
    let count = attestations.len();
    let first_input = attestations.get(0).expect("Batch must not be empty");
    let source_chain = first_input.source_chain.clone();

    validate_source_chain(&source_chain);
    for input in attestations.iter() {
        if input.source_chain != source_chain {
            panic!("Batch source chains must match");
        }
        validate_attestation_input(&input);
    }
    require_source_chain_allowed(env, &source_chain);

    let mut batch_hashes: Map<String, bool> = Map::new(env);
    for input in attestations.iter() {
        let seen_key = DataKey::SourceTxSeen(source_chain.clone(), input.source_tx_hash.clone());
        if batch_hashes.contains_key(input.source_tx_hash.clone())
            || env.storage().instance().has(&seen_key)
        {
            panic!("Source transaction already attested");
        }
        batch_hashes.set(input.source_tx_hash, true);
    }

    let current_last: u64 = env
        .storage()
        .instance()
        .get(&DataKey::NextAttestationId)
        .unwrap_or(0);
    let count_u64 = u64::from(count);
    let first_id = current_last
        .checked_add(1)
        .expect("Attestation id overflow");
    let last_id = current_last
        .checked_add(count_u64)
        .expect("Attestation id overflow");

    let total: u64 = env
        .storage()
        .instance()
        .get(&DataKey::TotalCount)
        .unwrap_or(0);
    let new_total = total.checked_add(count_u64).expect("total overflow");
    let pending: u64 = env
        .storage()
        .instance()
        .get(&DataKey::PendingCount)
        .unwrap_or(0);
    let new_pending = pending.checked_add(count_u64).expect("pending overflow");

    let now = env.ledger().sequence();
    let mut ids = Vec::new(env);
    let mut donor_indexes: Map<Address, Vec<u64>> = Map::new(env);
    let mut donor_order: Vec<Address> = Vec::new(env);

    for index in 0..count {
        let input = attestations.get(index).unwrap();
        let id = first_id
            .checked_add(u64::from(index))
            .expect("Attestation id overflow");
        ids.push_back(id);

        let seen_key = DataKey::SourceTxSeen(source_chain.clone(), input.source_tx_hash.clone());
        env.storage().instance().set(&seen_key, &true);

        let record = Attestation {
            id,
            source_chain: source_chain.clone(),
            source_tx_hash: input.source_tx_hash,
            donor: input.donor.clone(),
            project_id: input.project_id,
            amount_usd: input.amount_usd,
            amount_xlm: input.amount_xlm,
            message_hash: input.message_hash,
            status: AttestationStatus::Pending,
            created_at_ledger: now,
            verified_at_ledger: 0,
            created_by: relayer.clone(),
        };
        env.storage()
            .instance()
            .set(&DataKey::Attestation(id), &record);

        let mut donor_ids = if let Some(cached) = donor_indexes.get(input.donor.clone()) {
            cached
        } else {
            donor_order.push_back(input.donor.clone());
            env.storage()
                .instance()
                .get(&DataKey::DonorAttestations(input.donor.clone()))
                .unwrap_or(Vec::new(env))
        };
        donor_ids.push_back(id);
        donor_indexes.set(input.donor, donor_ids);

        emit_attestation_new(env, relayer, &record);
    }

    for donor in donor_order.iter() {
        let donor_ids = donor_indexes.get(donor.clone()).unwrap();
        env.storage()
            .instance()
            .set(&DataKey::DonorAttestations(donor), &donor_ids);
    }

    env.storage()
        .instance()
        .set(&DataKey::NextAttestationId, &last_id);
    env.storage()
        .instance()
        .set(&DataKey::TotalCount, &new_total);
    env.storage()
        .instance()
        .set(&DataKey::PendingCount, &new_pending);

    if emit_batch_event {
        env.events().publish(
            (symbol_short!("att_batch"), relayer.clone(), source_chain),
            (count, first_id, last_id),
        );
    }

    ids
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
        require_not_paused(&env);
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
        require_not_coordinated_upgrade(&env);
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

        let mut attestations = Vec::new(&env);
        attestations.push_back(BatchAttestationInput {
            source_chain,
            source_tx_hash,
            donor,
            project_id,
            amount_usd,
            amount_xlm,
            message_hash,
        });

        record_attestations_internal(&env, &relayer, attestations, false)
            .get(0)
            .unwrap()
    }

    /// Relayer-only — atomically record up to `MAX_BATCH_SIZE` attestations
    /// from one source chain while amortizing shared validation and counters.
    pub fn record_attestation_batch(
        env: Env,
        relayer: Address,
        attestations: Vec<BatchAttestationInput>,
    ) -> Vec<u64> {
        relayer.require_auth();
        require_relayer(&env, &relayer);
        require_not_paused(&env);

        if attestations.is_empty() {
            panic!("Batch must not be empty");
        }
        if attestations.len() > MAX_BATCH_SIZE {
            panic!("Batch size exceeds maximum");
        }

        record_attestations_internal(&env, &relayer, attestations, true)
    }

    /// Anyone may call `verify_attestation(id)`. Idempotent: a second call
    /// on an already-verified attestation panics with a clear message so a
    /// buggy double-submit fails loudly.
    pub fn verify_attestation(env: Env, id: u64) {
        require_not_paused(&env);
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
        require_not_paused(&env);
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
        // next is the last assigned id; the actual ids are 1..=next.
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
        require_not_coordinated_upgrade(&env);
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
        if env
            .storage()
            .instance()
            .get::<DataKey, bool>(&DataKey::CoordinatedUpgrade)
            .unwrap_or(false)
        {
            panic!("Cannot cancel individual upgrade during coordinated upgrade");
        }
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

    pub fn set_coordinated_pause(env: Env, admin: Address, new_wasm_hash: Option<soroban_sdk::BytesN<32>>) {
        admin.require_auth();
        require_admin(&env, &admin);
        env.storage()
            .instance()
            .set(&DataKey::CoordinatedUpgrade, &true);
        if let Some(hash) = new_wasm_hash {
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
                .set(&DataKey::PendingUpgrade, &hash);
            env.storage()
                .instance()
                .set(&DataKey::UpgradeEffectiveAt, &effective_at);
            env.events().publish(
                (symbol_short!("upg_prop"), env.current_contract_address()),
                (hash, effective_at),
            );
        }
        env.events()
            .publish((symbol_short!("coord_ps"),), true);
    }

    pub fn clear_coordinated_pause(env: Env, admin: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        let coordinated: bool = env
            .storage()
            .instance()
            .get(&DataKey::CoordinatedUpgrade)
            .unwrap_or(false);
        if !coordinated {
            panic!("No coordinated upgrade in progress");
        }
        if env.storage().instance().has(&DataKey::PendingUpgrade) {
            panic!("Upgrades not yet completed");
        }
        env.storage()
            .instance()
            .set(&DataKey::CoordinatedUpgrade, &false);
        env.events()
            .publish((symbol_short!("coord_ps"),), false);
    }

    pub fn cancel_coordinated_pause(env: Env, admin: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        env.storage()
            .instance()
            .set(&DataKey::CoordinatedUpgrade, &false);
        env.storage().instance().remove(&DataKey::PendingUpgrade);
        env.storage()
            .instance()
            .remove(&DataKey::UpgradeEffectiveAt);
        env.events()
            .publish((symbol_short!("coord_ps"),), false);
        env.events()
            .publish((symbol_short!("coord_cnc"),), ());
    }

    pub fn is_coordinated_upgrade_active(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::CoordinatedUpgrade)
            .unwrap_or(false)
    }
}

// ─── Unit tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use soroban_sdk::testutils::{Address as _, Events as _};
    use soroban_sdk::{IntoVal, String, Val};

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

    fn batch_input(
        env: &Env,
        donor: &Address,
        chain: &str,
        tx_hash: &str,
    ) -> BatchAttestationInput {
        BatchAttestationInput {
            source_chain: String::from_str(env, chain),
            source_tx_hash: String::from_str(env, tx_hash),
            donor: donor.clone(),
            project_id: String::from_str(env, "proj-batch"),
            amount_usd: 1_000_000,
            amount_xlm: 8_000_000,
            message_hash: 42,
        }
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

    #[test]
    fn test_batch_recording_success() {
        let (env, id, _admin, relayer, donor_a) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        let donor_b = Address::generate(&env);
        let mut inputs = Vec::new(&env);
        inputs.push_back(batch_input(&env, &donor_a, "ethereum", "0xbatch-1"));
        inputs.push_back(batch_input(&env, &donor_b, "ethereum", "0xbatch-2"));
        inputs.push_back(batch_input(&env, &donor_a, "ethereum", "0xbatch-3"));

        let ids = client.record_attestation_batch(&relayer, &inputs);

        assert_eq!(ids, soroban_sdk::vec![&env, 1u64, 2u64, 3u64]);
        assert_eq!(client.get_total_count(), 3);
        assert_eq!(client.get_pending_count(), 3);
        for index in 0..inputs.len() {
            let input = inputs.get(index).unwrap();
            let record = client.get_attestation(&ids.get(index).unwrap());
            assert_eq!(record.id, ids.get(index).unwrap());
            assert_eq!(record.source_chain, input.source_chain);
            assert_eq!(record.source_tx_hash, input.source_tx_hash);
            assert_eq!(record.donor, input.donor);
            assert_eq!(record.project_id, input.project_id);
            assert_eq!(record.amount_usd, input.amount_usd);
            assert_eq!(record.amount_xlm, input.amount_xlm);
            assert_eq!(record.message_hash, input.message_hash);
            assert_eq!(record.status, AttestationStatus::Pending);
            assert_eq!(record.created_by, relayer);
        }
        let donor_a_records = client.get_by_donor(&donor_a);
        assert_eq!(donor_a_records.len(), 2);
        assert_eq!(donor_a_records.get(0).unwrap().id, 1);
        assert_eq!(donor_a_records.get(1).unwrap().id, 3);
        let donor_b_records = client.get_by_donor(&donor_b);
        assert_eq!(donor_b_records.len(), 1);
        assert_eq!(donor_b_records.get(0).unwrap().id, 2);
    }

    #[test]
    #[should_panic(expected = "Source transaction already attested")]
    fn test_batch_replay_panics() {
        let (env, id, _admin, relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        client.record_attestation(
            &relayer,
            &String::from_str(&env, "ethereum"),
            &String::from_str(&env, "0xreplayed"),
            &donor,
            &String::from_str(&env, "proj"),
            &1i128,
            &1i128,
            &0u32,
        );
        let mut inputs = Vec::new(&env);
        inputs.push_back(batch_input(&env, &donor, "ethereum", "0xnew"));
        inputs.push_back(batch_input(&env, &donor, "ethereum", "0xreplayed"));

        client.record_attestation_batch(&relayer, &inputs);
    }

    #[test]
    #[should_panic(expected = "Batch size exceeds maximum")]
    fn test_batch_size_limit() {
        let (env, id, _admin, relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        let mut inputs = Vec::new(&env);
        for index in 0..=MAX_BATCH_SIZE {
            let tx_hash = std::format!("0xlimit-{index}");
            inputs.push_back(batch_input(&env, &donor, "ethereum", &tx_hash));
        }

        client.record_attestation_batch(&relayer, &inputs);
    }

    #[test]
    #[should_panic(expected = "Amount must be positive")]
    fn test_batch_invalid_amount_panics() {
        let (env, id, _admin, relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        let mut inputs = Vec::new(&env);
        inputs.push_back(batch_input(&env, &donor, "ethereum", "0xvalid"));
        let mut invalid = batch_input(&env, &donor, "ethereum", "0xinvalid");
        invalid.amount_xlm = 0;
        inputs.push_back(invalid);

        client.record_attestation_batch(&relayer, &inputs);
    }

    #[test]
    fn test_batch_atomicity() {
        let (env, id, _admin, relayer, existing_donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        let existing_id = client.record_attestation(
            &relayer,
            &String::from_str(&env, "ethereum"),
            &String::from_str(&env, "0xexisting"),
            &existing_donor,
            &String::from_str(&env, "existing-project"),
            &5i128,
            &6i128,
            &7u32,
        );
        let existing_before = client.get_attestation(&existing_id);
        let donor_before = client.get_by_donor(&existing_donor);
        let total_before = client.get_total_count();
        let pending_before = client.get_pending_count();

        let new_donor = Address::generate(&env);
        let batch_source_chain = String::from_str(&env, "ethereum");
        let batch_tx_hashes = ["0xatomic-1", "0xatomic-2", "0xatomic-3"];
        let mut inputs = Vec::new(&env);
        inputs.push_back(batch_input(
            &env,
            &existing_donor,
            "ethereum",
            batch_tx_hashes[0],
        ));
        inputs.push_back(batch_input(
            &env,
            &new_donor,
            "ethereum",
            batch_tx_hashes[1],
        ));
        let mut invalid = batch_input(&env, &new_donor, "ethereum", batch_tx_hashes[2]);
        invalid.amount_usd = -1;
        inputs.push_back(invalid);

        let result = client.try_record_attestation_batch(&relayer, &inputs);
        assert!(result.is_err());

        // SDK 27 exposes only successful contract events from the last
        // invocation. Inspect immediately so later getter calls cannot replace
        // the failed batch's event view.
        let successful_events = env.events().all().filter_by_contract(&id);
        assert!(
            successful_events.events().is_empty(),
            "failed batch retained a successful att_new or att_batch event"
        );

        env.as_contract(&id, || {
            assert_eq!(
                env.storage()
                    .instance()
                    .get::<_, u64>(&DataKey::NextAttestationId),
                Some(existing_id),
            );
            for tx_hash in batch_tx_hashes {
                assert!(!env.storage().instance().has(&DataKey::SourceTxSeen(
                    batch_source_chain.clone(),
                    String::from_str(&env, tx_hash),
                )));
            }
        });

        assert_eq!(client.get_total_count(), total_before);
        assert_eq!(client.get_pending_count(), pending_before);
        assert!(client.try_get_attestation(&(existing_id + 1)).is_err());
        assert!(client.try_get_attestation(&(existing_id + 2)).is_err());
        assert!(client.try_get_attestation(&(existing_id + 3)).is_err());
        for tx_hash in batch_tx_hashes {
            assert_eq!(
                client.get_attestation_by_source(
                    &batch_source_chain,
                    &String::from_str(&env, tx_hash),
                ),
                None
            );
        }
        assert_eq!(client.get_by_donor(&existing_donor), donor_before);
        assert!(client.get_by_donor(&new_donor).is_empty());
        let existing_after = client.get_attestation(&existing_id);
        assert_eq!(existing_after.id, existing_before.id);
        assert_eq!(
            existing_after.source_tx_hash,
            existing_before.source_tx_hash
        );
        assert_eq!(existing_after.source_chain, existing_before.source_chain);
        assert_eq!(existing_after.donor, existing_before.donor);
        assert_eq!(existing_after.project_id, existing_before.project_id);
        assert_eq!(existing_after.amount_usd, existing_before.amount_usd);
        assert_eq!(existing_after.amount_xlm, existing_before.amount_xlm);
        assert_eq!(existing_after.message_hash, existing_before.message_hash);
        assert_eq!(existing_after.status, existing_before.status);
        assert_eq!(
            existing_after.created_at_ledger,
            existing_before.created_at_ledger
        );
        assert_eq!(
            existing_after.verified_at_ledger,
            existing_before.verified_at_ledger
        );
        assert_eq!(existing_after.created_by, existing_before.created_by);
    }

    #[test]
    fn test_batch_events() {
        let (env, id, _admin, relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        let mut inputs = Vec::new(&env);
        inputs.push_back(batch_input(&env, &donor, "ethereum", "0xevent-1"));
        inputs.push_back(batch_input(&env, &donor, "ethereum", "0xevent-2"));

        let ids = client.record_attestation_batch(&relayer, &inputs);

        let expected: Vec<(Address, Vec<Val>, Val)> = soroban_sdk::vec![
            &env,
            (
                id.clone(),
                (
                    symbol_short!("att_new"),
                    relayer.clone(),
                    donor.clone(),
                    String::from_str(&env, "ethereum"),
                )
                    .into_val(&env),
                (
                    ids.get(0).unwrap(),
                    String::from_str(&env, "proj-batch"),
                    1_000_000i128,
                    8_000_000i128,
                )
                    .into_val(&env),
            ),
            (
                id.clone(),
                (
                    symbol_short!("att_new"),
                    relayer.clone(),
                    donor.clone(),
                    String::from_str(&env, "ethereum"),
                )
                    .into_val(&env),
                (
                    ids.get(1).unwrap(),
                    String::from_str(&env, "proj-batch"),
                    1_000_000i128,
                    8_000_000i128,
                )
                    .into_val(&env),
            ),
            (
                id.clone(),
                (
                    symbol_short!("att_batch"),
                    relayer,
                    String::from_str(&env, "ethereum"),
                )
                    .into_val(&env),
                (2u32, 1u64, 2u64).into_val(&env),
            ),
        ];
        assert_eq!(env.events().all().filter_by_contract(&id), expected);
    }

    #[test]
    fn test_batch_of_50_all_records_queryable() {
        let (env, id, _admin, relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        let mut inputs = Vec::new(&env);
        for index in 0..MAX_BATCH_SIZE {
            let tx_hash = std::format!("0xmax-{index}");
            inputs.push_back(batch_input(&env, &donor, "ethereum", &tx_hash));
        }

        let ids = client.record_attestation_batch(&relayer, &inputs);

        assert_eq!(ids.len(), MAX_BATCH_SIZE);
        assert_eq!(client.get_total_count(), u64::from(MAX_BATCH_SIZE));
        assert_eq!(client.get_pending_count(), u64::from(MAX_BATCH_SIZE));
        for index in 0..MAX_BATCH_SIZE {
            let expected_id = u64::from(index) + 1;
            assert_eq!(ids.get(index).unwrap(), expected_id);
            let record = client.get_attestation(&expected_id);
            assert_eq!(record.id, expected_id);
            assert_eq!(
                record.source_tx_hash,
                inputs.get(index).unwrap().source_tx_hash
            );
        }
        assert_eq!(client.get_by_donor(&donor).len(), MAX_BATCH_SIZE);
    }

    #[test]
    #[should_panic(expected = "Batch must not be empty")]
    fn test_batch_empty_panics() {
        let (env, id, _admin, relayer, _donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        client.record_attestation_batch(&relayer, &Vec::new(&env));
    }

    #[test]
    #[should_panic(expected = "Batch source chains must match")]
    fn test_batch_mixed_source_chains_panics() {
        let (env, id, _admin, relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        let inputs = soroban_sdk::vec![
            &env,
            batch_input(&env, &donor, "ethereum", "0xmixed-1"),
            batch_input(&env, &donor, "polygon", "0xmixed-2"),
        ];
        client.record_attestation_batch(&relayer, &inputs);
    }

    #[test]
    #[should_panic(expected = "Source transaction already attested")]
    fn test_batch_duplicate_hash_panics() {
        let (env, id, _admin, relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        let inputs = soroban_sdk::vec![
            &env,
            batch_input(&env, &donor, "ethereum", "0xduplicate"),
            batch_input(&env, &donor, "ethereum", "0xduplicate"),
        ];
        client.record_attestation_batch(&relayer, &inputs);
    }

    #[test]
    #[should_panic(expected = "Contract is paused")]
    fn test_batch_paused_panics() {
        let (env, id, admin, relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        client.pause(&admin);
        let inputs = soroban_sdk::vec![&env, batch_input(&env, &donor, "ethereum", "0xpaused"),];
        client.record_attestation_batch(&relayer, &inputs);
    }

    #[test]
    #[should_panic(expected = "Only relayer can perform this action")]
    fn test_batch_unauthorized_relayer_panics() {
        let (env, id, _admin, _relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        let attacker = Address::generate(&env);
        let inputs = soroban_sdk::vec![
            &env,
            batch_input(&env, &donor, "ethereum", "0xunauthorized"),
        ];
        client.record_attestation_batch(&attacker, &inputs);
    }

    #[test]
    fn test_batch_allowlisted_source_chain() {
        let (env, id, admin, relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        client.add_allowed_chain(&admin, &String::from_str(&env, "ethereum"));
        let inputs = soroban_sdk::vec![
            &env,
            batch_input(&env, &donor, "ethereum", "0xallowed-1"),
            batch_input(&env, &donor, "ethereum", "0xallowed-2"),
        ];

        let ids = client.record_attestation_batch(&relayer, &inputs);

        assert_eq!(ids, soroban_sdk::vec![&env, 1u64, 2u64]);
    }

    #[test]
    #[should_panic(expected = "Source chain not allowed")]
    fn test_batch_unlisted_source_chain_panics() {
        let (env, id, admin, relayer, donor) = init_and_relayer();
        let client = AttestationContractClient::new(&env, &id);
        client.add_allowed_chain(&admin, &String::from_str(&env, "ethereum"));
        let inputs = soroban_sdk::vec![&env, batch_input(&env, &donor, "polygon", "0xunlisted"),];
        client.record_attestation_batch(&relayer, &inputs);
    }
}
