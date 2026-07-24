#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol};

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum AttestationStatus {
    Active,
    RevocationPending,
    Revoked,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttestationRecord {
    pub id: u64,
    pub attester: Address,
    pub status: AttestationStatus,
    pub revocation_deadline: u64,
}

#[contracttype]
pub enum DataKey {
    Attestation(u64),
    RevocationChallenge(u64),
    GracePeriod,
    Admin,
}

const REVOCATION_GRACE_PERIOD: u64 = 604800; // 7 days in ledger seconds roughly or equivalent units

#[contract]
pub struct AttestationContract;

#[contractimpl]
impl AttestationContract {
    pub fn revoke_attestation(env: Env, admin: Address, id: u64) {
        admin.require_auth();
        // Assume admin check happens here
        
        let mut record: AttestationRecord = env.storage().persistent().get(&DataKey::Attestation(id)).unwrap();
        let current_ledger = env.ledger().timestamp();
        record.status = AttestationStatus::RevocationPending;
        record.revocation_deadline = current_ledger + REVOCATION_GRACE_PERIOD;
        
        env.storage().persistent().set(&DataKey::Attestation(id), &record);
        env.events().publish((Symbol::new(&env, "att_rev_pending"), id), record.revocation_deadline);
    }

    pub fn challenge_revocation(env: Env, challenger: Address, attestation_id: u64, evidence_hash: soroban_sdk::BytesN<32>) {
        challenger.require_auth();
        let record: AttestationRecord = env.storage().persistent().get(&DataKey::Attestation(attestation_id)).unwrap();
        let current_ledger = env.ledger().timestamp();
        
        if current_ledger > record.revocation_deadline {
            panic!("grace period has expired");
        }

        env.storage().persistent().set(&DataKey::RevocationChallenge(attestation_id), &evidence_hash);
        env.events().publish((Symbol::new(&env, "att_rev_challenged"), attestation_id), challenger);
    }

    pub fn finalize_revocation(env: Env, attestation_id: u64) {
        let mut record: AttestationRecord = env.storage().persistent().get(&DataKey::Attestation(attestation_id)).unwrap();
        let current_ledger = env.ledger().timestamp();
        
        if current_ledger <= record.revocation_deadline {
            panic!("grace period is still active");
        }
        
        if env.storage().persistent().has(&DataKey::RevocationChallenge(attestation_id)) {
            panic!("challenge must be resolved by admin");
        }

        record.status = AttestationStatus::Revoked;
        env.storage().persistent().set(&DataKey::Attestation(attestation_id), &record);
        env.events().publish((Symbol::new(&env, "att_rev_finalized"), attestation_id), ());
    }

    pub fn resolve_revocation_challenge(env: Env, admin: Address, attestation_id: u64, uphold_revocation: bool) {
        admin.require_auth();
        let mut record: AttestationRecord = env.storage().persistent().get(&DataKey::Attestation(attestation_id)).unwrap();

        if uphold_revocation {
            record.status = AttestationStatus::Revoked;
            env.events().publish((Symbol::new(&env, "att_rev_finalized"), attestation_id), true);
        } else {
            record.status = AttestationStatus::Active;
            env.events().publish((Symbol::new(&env, "att_rev_overturned"), attestation_id), true);
        }

        env.storage().persistent().set(&DataKey::Attestation(attestation_id), &record);
        env.storage().persistent().remove(&DataKey::RevocationChallenge(attestation_id));
    }
}
