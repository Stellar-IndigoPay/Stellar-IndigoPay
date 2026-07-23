#![no_std]

// Include the entire v1 contract implementation.
// Since this is compiled in the indigopay-contract-v2 package without the "v1" feature,
// the paused field is present in Project, simulating the upgraded storage layout.
include!("../src/lib.rs");

#[contractimpl]
impl IndigoPayContract {
    /// A new function introduced in v2 to verify upgrade success.
    pub fn new_v2_function(env: Env) -> i32 {
        let key = DataKey::NewFeature;
        env.storage().instance().set(&key, &42i32);
        42
    }

    /// Read-only helper to read the new feature value.
    pub fn get_new_feature_val(env: Env) -> i32 {
        let key = DataKey::NewFeature;
        env.storage().instance().get(&key).unwrap_or(0)
    }
}
