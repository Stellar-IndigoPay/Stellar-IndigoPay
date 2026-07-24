use soroban_sdk::{Env, Bytes, BytesN, Vec};

#[cfg(feature = "state-proofs")]
pub fn compute_state_root(env: &Env, entries: &Vec<(Bytes, Bytes)>) -> BytesN<32> {
    // Simple deterministic hash accumulation for state root representation
    let mut hasher_input = Bytes::new(env);
    for (k, v) in entries.iter() {
        hasher_input.append(&k);
        hasher_input.append(&v);
    }
    let digest = env.crypto().sha256(&hasher_input);
    digest
}

#[cfg(feature = "state-proofs")]
pub struct StateProof {
    pub key: Bytes,
    pub value: Bytes,
    pub proof: Vec<BytesN<32>>,
    pub root: BytesN<32>,
}
