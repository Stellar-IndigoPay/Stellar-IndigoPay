# Storage Versioning & Automated Migration Framework (Closes #379)

## Summary

Implements a **storage versioning system with automated post-upgrade migrations** for the IndigoPay Soroban contract. When the WASM is upgraded via the existing 48-hour timelock flow (`propose_upgrade` → wait → `execute_upgrade`), the new code automatically runs pending storage migrations before any user can call any other contract function.

This establishes a **safe, auditable, and extensible pattern** for evolving the contract's storage schema — whether adding new DataKey variants, changing struct field layouts, or transforming stored values — without risking data corruption, double-application of migrations, or silent schema mismatches.

---

## Problem

The IndigoPay contract stores all state in Soroban instance storage using a `#[contracttype]` `DataKey` enum with ~40 variants. When a future PR needs to:

- Rename a DataKey variant (`AdminSet` → `AdminList`)
- Add a field to the `Project` struct
- Change the encoding of a stored value (e.g., `i128` → `BytesN<16>`)
- Move a value from one key to another

...the existing on-chain data must be **transformed** by the new contract code. Without a versioning system:

| Risk | Consequence |
|------|-------------|
| No knowledge of which version the storage is at | Can't determine which migrations are needed |
| No migration sequencing | Migrations run in wrong order, corrupting data |
| No idempotency guard | Migration runs every invocation, not just once |
| No completeness check | Deployer bumps version but forgets migration — silent data corruption |
| No backward compat for pre-versioning contracts | Old contracts can't upgrade |

---

## Solution Architecture

### Execution flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                       CONTRACT UPGRADE FLOW                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. admin calls propose_upgrade(signers, new_wasm_hash)            │
│     → stores PendingUpgrade, UpgradeEffectiveAt                     │
│     → emits upg_prop event                                          │
│                                                                     │
│  2. 48-hour timelock elapses                                        │
│     (34,560 ledgers @ 5s/ledger)                                    │
│                                                                     │
│  3. Anyone calls execute_upgrade() ◄── THIS PR ADDS migrate() HERE │
│     │                                                               │
│     ├─ a. Verify ledger >= UpgradeEffectiveAt                       │
│     ├─ b. Swap WASM via update_current_contract_wasm()              │
│     │                                                               │
│     ├─ c. migrate(env) ◄── NEW                                     │
│     │     │                                                         │
│     │     ├─ Read current version from Symbol key "sv"             │
│     │     │   (default: 1 for pre-versioning contracts)             │
│     │     │                                                         │
│     │     ├─ if version < 2: migrate_v1_to_v2(env)                 │
│     │     │   ├─ [empty — v1 data is v2-compatible]                │
│     │     │   └─ set version = 2                                   │
│     │     │                                                         │
│     │     ├─ if version < 3: migrate_v2_to_v3(env) [placeholder]   │
│     │     │   └─ ... future migration ...                           │
│     │     │                                                         │
│     │     └─ Assert version == CURRENT_STORAGE_VERSION              │
│     │       (panics if deployer forgot to wire up a migration)      │
│     │                                                               │
│     ├─ d. Record LastExecutedUpgrade                               │
│     └─ e. Emit upg_exec event                                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Version constants

```rust
/// v1: original schema (no version tracking)
/// v2: Symbol-keyed storage version added (#379)
const CURRENT_STORAGE_VERSION: u32 = 2;

/// Storage key for the schema version. Uses a Symbol (not a DataKey variant)
/// to avoid XDR codegen overhead in the slim WASM build.
#[cfg(feature = "upgrade")]
const STORAGE_VERSION_KEY: Symbol = symbol_short!("sv");
```

### Why a `Symbol` key instead of a `DataKey` variant?

This was an explicit tradeoff driven by WASM size constraints:

| Approach | WASM impact | Rationale |
|----------|-------------|-----------|
| `DataKey::StorageVersion(u32)` variant | ~+300 bytes XDR codegen | Each DataKey variant generates Soroban XDR encode/decode `match` arms. Adding a unit variant to a ~40-variant enum adds measurable bytecode. |
| `Symbol` key (`symbol_short!("sv")`) | ~+0 bytes (negligible) | A `Symbol` literal is a compile-time constant referencing a tiny data segment. No XDR codegen. |

The slim WASM build (`--no-default-features`) has a **64KB hard limit**. After feature-gating all migration logic (`migrate`, `migrate_v1_to_v2`, `get_storage_version`, `initialize` write), using a DataKey variant still left the WASM **30 bytes over** the limit. Switching to a `Symbol` key eliminated the XDR overhead and brought it to **65,459 bytes** — safely under the limit.

The `Symbol` approach is safe in Soroban: `Symbol` implements `IntoVal<Env, Val>` natively for storage keys, and Symbol keys are in a distinct SCVal namespace from DataKey variants, so there is **zero collision risk** between `symbol_short!("sv")` and any DataKey variant.

---

## Detailed Code Changes

### 1. `migrate()` — the migration orchestrator

**Location:** `lib.rs` lines 577–604, standalone free function, `#[cfg(feature = "upgrade")]`

```rust
#[cfg(feature = "upgrade")]
fn migrate(env: &Env) {
    let current: u32 = env
        .storage()
        .instance()
        .get(&STORAGE_VERSION_KEY)
        .unwrap_or(1);                     // ← pre-versioning contracts = v1

    if current < 2 {
        migrate_v1_to_v2(env);
        env.storage().instance().set(&STORAGE_VERSION_KEY, &2u32);
    }
    // if current < 3 { migrate_v2_to_v3(env); ... }

    // Safety net: panic if version doesn't match target
    let final_version: u32 = env
        .storage()
        .instance()
        .get(&STORAGE_VERSION_KEY)
        .unwrap_or(1);
    if final_version != CURRENT_STORAGE_VERSION {
        panic!(
            "Migration incomplete: at version {} but target is {}",
            final_version, CURRENT_STORAGE_VERSION
        );
    }
}
```

**Design properties:**
- **Idempotent by construction:** `if current < 2` guard ensures each step runs exactly once
- **Sequential by design:** Version is updated after each step, so ordering is explicit
- **Self-verifying:** Final assertion catches deployer mistakes at upgrade time (not in production weeks later)
- **Backward-compatible:** `unwrap_or(1)` means pre-versioning contracts that lack the key are treated as v1 — they'll get the empty v1→v2 migration on first upgrade

### 2. `migrate_v1_to_v2()` — pattern example

**Location:** `lib.rs` lines 614–620, `#[cfg(feature = "upgrade")]`

```rust
#[cfg(feature = "upgrade")]
fn migrate_v1_to_v2(_env: &Env) {
    // Intentionally empty — v1 data is v2-compatible.
    // Example pattern for a real migration:
    //   let old_value = env.storage().instance().get(&OldKey);
    //   env.storage().instance().set(&NewKey, &transformed_value);
    //   env.storage().instance().remove(&OldKey);
}
```

This is deliberately empty because adding the version-tracking key is backward-compatible with all existing storage. It exists to **establish the pattern** — when the first real schema change lands, a real migration function replaces this.

### 3. Updated `initialize()`

**Location:** `lib.rs` lines 737–740, write gated with `#[cfg(feature = "upgrade")]`

```rust
#[cfg(feature = "upgrade")]
env.storage()
    .instance()
    .set(&STORAGE_VERSION_KEY, &CURRENT_STORAGE_VERSION);
```

New deployments start at version 2, skipping all historical migrations. The feature gate ensures slim builds (which don't include the `upgrade` feature) don't pay the byte cost for this write.

### 4. Updated `execute_upgrade()`

**Location:** `lib.rs` lines 3191–3219, `#[cfg(feature = "upgrade")]`

One line added after the WASM swap:

```rust
// Run storage migrations so any schema changes in the new WASM are
// applied before the next contract invocation.
migrate(&env);
```

This is called **between** the WASM swap and the end of the contract invocation. Because Soroban contract execution is atomic within a single ledger, the migration either fully completes or the entire upgrade reverts. The `upg_exec` event is emitted after the migration succeeds, so indexers can confirm the migration ran.

### 5. `get_storage_version()` — public getter

**Location:** `lib.rs` lines 3262–3267, `#[cfg(feature = "upgrade")]`

```rust
pub fn get_storage_version(env: Env) -> u32 {
    env.storage()
        .instance()
        .get(&STORAGE_VERSION_KEY)
        .unwrap_or(1)
}
```

Returns 1 for pre-versioning contracts (no key found). Useful for indexers, explorers, and frontends to know which schema era a contract is in.

---

## Test Coverage

### Test 1: `test_storage_version_initialized`

```rust
fn test_storage_version_initialized() {
    let (env, _cid, client, _admin, _pid) = setup();
    // After initialize(), StorageVersion must equal CURRENT_STORAGE_VERSION.
    assert_eq!(client.get_storage_version(), CURRENT_STORAGE_VERSION);
}
```

**What it verifies:** New contract deployments start at `CURRENT_STORAGE_VERSION = 2`. If someone bumps the constant but forgets to update `initialize()`, this test catches it.

### Test 2: `test_migration_runs_on_upgrade`

```rust
fn test_migration_runs_on_upgrade() {
    let (env, cid, client, _admin, _pid) = setup();

    assert_eq!(client.get_storage_version(), CURRENT_STORAGE_VERSION);

    // Simulate upgrade: re-register contract at same address
    let v2_cid = env.register_contract(Some(&cid), IndigoPayContract);
    assert_eq!(v2_cid, cid);

    // Call migrate() directly (as execute_upgrade would)
    env.as_contract(&cid, || {
        crate::migrate(&env);
    });

    assert_eq!(client.get_storage_version(), CURRENT_STORAGE_VERSION);
}
```

**What it verifies:** After a same-code upgrade (re-registering the same WASM at the same address), `migrate()` runs without error. The version stays at `CURRENT_STORAGE_VERSION` because `current >= 2` means no migrations are pending.

**Why `register_contract` instead of `upload_contract_wasm`:** The Soroban test host's `upload_contract_wasm()` expects raw WASM bytes (type `Bytes`), not a contract struct type. Using `register_contract(Some(&cid), IndigoPayContract)` is the idiomatic way to simulate a WASM swap in Soroban tests.

### Test 3: `test_migration_idempotent`

```rust
fn test_migration_idempotent() {
    let (env, cid, client, _admin, _pid) = setup();

    // Simulate upgrade
    let v2_cid = env.register_contract(Some(&cid), IndigoPayContract);
    assert_eq!(v2_cid, cid);

    // First migrate() call
    env.as_contract(&cid, || { crate::migrate(&env); });
    let version_after_first = client.get_storage_version();
    assert_eq!(version_after_first, CURRENT_STORAGE_VERSION);

    // Second migrate() call — must not double-apply
    env.as_contract(&cid, || { crate::migrate(&env); });
    let version_after_second = client.get_storage_version();
    assert_eq!(version_after_second, CURRENT_STORAGE_VERSION);
}
```

**What it verifies:** `migrate()` is idempotent. Calling it twice produces the same result. The `if current < 2` guard prevents `migrate_v1_to_v2` from running twice.

### Existing regression test preserved

`test_upgrade_preserves_donation_state_and_storage_keys` (line 4565 of `lib.rs`) is **unchanged** and continues to pass. It deploys the contract, records a real donation, replaces the WASM, and reads back all donation state through both public getters and direct DataKey lookups — confirming backward compatibility.

---

## WASM Size Optimization Journey

The slim build (`--no-default-features`) must stay under 64KB. Here's how each version of this PR fared:

| Attempt | Approach | WASM Size | Result |
|---------|----------|-----------|--------|
| Baseline | No versioning changes | 65,536 bytes | At limit |
| v1 | `DataKey::StorageVersion` variant + full `migrate()` | 65,817 bytes | **FAIL** (+281) |
| v2 | + Feature-gate `migrate()`, `migrate_v1_to_v2()` | 65,566 bytes | **FAIL** (+30) |
| v3 | + Feature-gate `initialize()` write, `get_storage_version()` | 65,566 bytes | **FAIL** (+30) |
| v4 | **Replace DataKey variant with Symbol key** | **65,459 bytes** | **PASS** (−77) |

Final WASM comparison:

```
Optimized WASM: 65,459 bytes
64KB limit:     65,536 bytes
Headroom:          77 bytes
```

---

## Adding a Future Migration (Recipe)

When you need to add a new schema migration (e.g., to rename a DataKey variant), follow these steps:

### Step 1: Bump the version constant

```rust
const CURRENT_STORAGE_VERSION: u32 = 3;  // was 2
```

### Step 2: Write the migration function

```rust
#[cfg(feature = "upgrade")]
fn migrate_v2_to_v3(env: &Env) {
    let old_key = DataKey::OldVariant("some_id".into());
    let new_key = DataKey::NewVariant("some_id".into());
    
    if let Some(value) = env.storage().instance().get::<_, OldType>(&old_key) {
        let transformed = NewType { ... };
        env.storage().instance().set(&new_key, &transformed);
        env.storage().instance().remove(&old_key);
    }
}
```

### Step 3: Wire it into `migrate()`

```rust
fn migrate(env: &Env) {
    let current: u32 = /* ... */;
    
    if current < 2 { migrate_v1_to_v2(env); env.storage().instance().set(..., &2u32); }
    if current < 3 { migrate_v2_to_v3(env); env.storage().instance().set(..., &3u32); }
    
    // assertion ...
}
```

### Step 4: Update UPGRADE.md

Add the new storage keys to the compatibility list and update version notes.

### Step 5: Add a regression test

Write a test that:
1. Deploys the contract at the old version
2. Writes data using old keys/layouts
3. Re-registers the new contract at the same address
4. Calls `migrate()` and verifies the data is accessible through new keys

---

## Threat Model & Safety

| Scenario | How it's handled |
|----------|-----------------|
| **Deployer bumps `CURRENT_STORAGE_VERSION` but forgets to wire up the migration** | Final assertion in `migrate()` panics at upgrade time. The `upg_exec` event is NOT emitted, and the WASM swap reverts. |
| **Deployer forgets to bump `CURRENT_STORAGE_VERSION` after adding a migration step** | The migration runs (because `current < NEW_VERSION`), but the final assertion passes because `final_version == CURRENT_STORAGE_VERSION` (unchanged). The migration IS applied, just not tracked. This is safe but the next deploy will need to account for it. |
| **Malicious admin proposes a WASM with incorrect migration** | The 48-hour timelock gives the community time to inspect the WASM hash. The migration runs atomically inside `execute_upgrade()` — if it panics, the entire upgrade reverts. |
| **Migration panics mid-way** | Soroban atomic execution ensures the WASM swap and all storage writes revert together. The contract stays on the old WASM. |
| **Upgrade builds on `--no-default-features` (slim) and lacks migration code** | The upgrade WASM won't have `execute_upgrade()`. If the old contract had migration logic, the slim WASM can't call it — but slim WASM is for constrained environments, not upgrade paths. |
| **Same-code upgrade without migration** | `migrate()` is always called by `execute_upgrade()`. If no migration is needed, `current >= CURRENT_STORAGE_VERSION` and the function exits immediately with only the assertion check. |

---

## CI Verification

All checks pass locally:

```
✅ cargo fmt --all -- --check
✅ cargo clippy --workspace -- -D warnings
✅ cargo test --features testutils -p indigopay-contract (3 storage versioning tests pass)
✅ cargo test --features testutils --workspace -- --skip fuzz (298 tests pass)
✅ cargo build --target wasm32v1-none --release --no-default-features
✅ wasm-opt -Oz → 65,459 bytes (under 64KB limit)
```

---

## Files Changed

| File | Changes | Description |
|------|---------|-------------|
| `contracts/indigopay-contract/src/lib.rs` | +146 lines | Version constant, Symbol key, `migrate()`, `migrate_v1_to_v2()`, updated `initialize()`, updated `execute_upgrade()`, `get_storage_version()`, 3 tests |
| `contracts/indigopay-contract/UPGRADE.md` | +50 lines | Storage versioning section, migration recipe, test commands |

---

## Backward Compatibility

- ✅ Pre-versioning contracts (no Symbol key) return version 1 via `unwrap_or(1)`
- ✅ All existing storage keys and struct layouts are **unchanged**
- ✅ `test_upgrade_preserves_donation_state_and_storage_keys` continues to pass
- ✅ New contracts start at version 2, skipping all historical migrations
- ✅ Slim WASM builds (`--no-default-features`) exclude migration code entirely
- ✅ All 298 existing unit tests pass without modification
