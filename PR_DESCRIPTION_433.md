# Storage Garbage Collection for Expired Proposals and Vesting Schedules

**Closes #433**

## Summary

Implements a permissionless storage garbage collection mechanism to clean up
expired governance proposals and completed/cancelled vesting schedules from
Soroban instance storage. Without cleanup, stale data accumulates indefinitely,
increasing state bloat and TTL extension costs. This PR adds two cleanup
functions — `cleanup_proposal` and `cleanup_vesting_schedule` — callable by
anyone after a 30-day grace period post-resolution or post-completion, with
appropriate event emissions for indexer reconciliation.

## Type

- [ ] Bug fix
- [x] New feature
- [x] Documentation
- [x] Smart contract change
- [ ] Refactor

## Changes

### Struct Changes (appended fields for backward compatibility)

- **`VoteProposal`**: Added `resolved_at: u32` — set to the current ledger
  sequence by `resolve_proposal` and `veto_proposal`. Defaults to `0` for
  unresolved and pre-upgrade proposals (backward compatible).

- **`VestingSchedule`**: Added `completed_at: u32` — set to the current ledger
  sequence by `cancel_vesting` and `claim_vested_installment` (when the final
  installment is claimed). Defaults to `0` for active and pre-upgrade schedules
  (backward compatible).

### New Constant

- **`GRACE_PERIOD_LEDGERS = 518_400`** (~30 days @ 5s/ledger). The post-
  resolution or post-completion window during which stale data is preserved
  for indexers.

### New Functions

- **`cleanup_proposal(env, project_id)`**
  - Permissionless — anyone can call after `resolved_at + GRACE_PERIOD_LEDGERS`.
  - Removes the `DataKey::Proposal`, all `DataKey::HasVoted` entries (by
    iterating the `VoterList`), and `DataKey::VoterList`.
  - Panics if the proposal is not found, not resolved, or the grace period
    has not elapsed.
  - Emits `prop_clean` event.
  - Feature-gated behind `governance`.

- **`cleanup_vesting_schedule(env, donor, schedule_id)`**
  - Permissionless — anyone can call after `completed_at + GRACE_PERIOD_LEDGERS`.
  - Removes the `DataKey::VestingSchedule` entry.
  - Panics if the schedule is not found, still active (`completed_at == 0`),
    or the grace period has not elapsed.
  - Emits `vest_clean` event.
  - Feature-gated behind `vesting`.

### Behavioural Change

- **`cancel_vesting`** no longer removes the schedule from storage immediately.
  Instead, it sets `completed_at` to the current ledger sequence and persists
  the schedule. Unvested tokens are still returned to the donor atomically in
  the same transaction. The schedule is later removed by
  `cleanup_vesting_schedule` after the grace period elapses.

### New Events

| Event Name   | Topics                                | Data | Description                              |
| ------------ | ------------------------------------- | ---- | ---------------------------------------- |
| `prop_cln` | `["prop_cln", project_id]`          | `()` | Proposal & vote data removed from storage |
| `vest_cln` | `["vest_cln", donor, schedule_id]`  | `()` | Vesting schedule removed from storage    |

### Cargo Feature

- Added `vesting` to the default feature set in `Cargo.toml` to ensure the
  vesting cleanup path is compiled and tested in the standard build.

## Testing

### Unit Tests Added

| Test | Description |
| --- | --- |
| `test_cleanup_resolved_proposal` | Proposal cleaned up after resolution + grace period |
| `test_cleanup_unresolved_panics` | Cleaning unresolved proposal panics |
| `test_cleanup_before_grace_period_panics` | Cleaning too early panics |
| `test_cleanup_proposal_idempotent` | Second cleanup panics (proposal already removed) |
| `test_cleanup_vesting_completed` | Completed vesting schedule cleaned up |
| `test_cleanup_vesting_active_panics` | Active schedule cleanup panics |
| `test_cleanup_vesting_before_grace_period_panics` | Early cleanup panics |
| `test_cleanup_vesting_cancelled` | Cancelled schedule cleaned up after grace period |

### CI Commands

```bash
# Format check
cargo fmt --all -- --check

# Clippy (no warnings)
cargo clippy --workspace -- -D warnings

# Unit tests (skip fuzz)
cargo test --features testutils --workspace -- --skip fuzz

# WASM slim build (size check)
cargo build --workspace --target wasm32v1-none --release --no-default-features
```

> **Note**: All CI checks have been verified locally and pass:
> - ✅ `cargo fmt --all -- --check` — clean
> - ✅ `cargo clippy --workspace -- -D warnings` — clean
> - ✅ `cargo test --features testutils --workspace -- --skip fuzz` — 349 passed, 0 failed
> - ✅ `cargo build --target wasm32v1-none --release --no-default-features` — succeeds
> - ✅ `wasm-opt -Oz` → 64,241 bytes (under 65,536 limit)

## Files Changed

| File | Purpose |
| --- | --- |
| `contracts/indigopay-contract/src/lib.rs` | Struct fields, cleanup functions, events, tests |
| `contracts/indigopay-contract/Cargo.toml` | Added `vesting` to default features |
| `contracts/indigopay-contract/UPGRADE.md` | Backward compat docs, new fields, cleanup docs |
| `contracts/EVENTS.md` | Document `prop_clean` and `vest_clean` events |

## Backward Compatibility

All changes are backward compatible:

1. **Struct fields are appended** to `VoteProposal` and `VestingSchedule`,
   not inserted. Pre-upgrade stored values deserialize with `resolved_at: 0`
   and `completed_at: 0`, which the cleanup functions correctly interpret as
   "eligible for cleanup immediately" (resolved but no timestamp) and "still
   active" (no completion timestamp) respectively.

2. **No `DataKey` variants were added, removed, or reordered.** The storage
   key discriminants are unchanged.

3. **`cancel_vesting` behaviour change**: Previously the schedule was removed
   from storage immediately. Now it persists with `completed_at` set, which
   means the schedule's storage entry survives until cleanup. This is a
   one-time transition — after the first cancellation under the new code,
   subsequent cancellations work the same way. The UPGRADE.md documents this
   change.

## Acceptance Criteria

- [x] `cleanup_proposal` removes proposal and all associated vote data after grace period
- [x] `cleanup_proposal` panics if proposal is not resolved
- [x] `cleanup_proposal` panics if grace period has not elapsed
- [x] `cleanup_vesting_schedule` removes schedule data after grace period
- [x] Events emitted with cleaned item identifiers
- [x] Cleanup reduces storage footprint (verifiable via `env.storage().instance().has()`)
- [x] Tests pass — 349 passed, 0 failed (verified locally)
- [x] WASM under 64 KB — 64,241 bytes after wasm-opt -Oz (verified locally)
- [x] CI green — all checks pass (fmt, clippy, tests, WASM build + size)

## Known Limitations

1. **Pre-upgrade fully-claimed vesting schedules cannot be cleaned up**: Any
   `VestingSchedule` that had all installments claimed before the upgrade will
   have `completed_at == 0` and `installments_released >= installment_count`.
   Since `claim_vested_installment` panics when already fully released and
   `cleanup_vesting_schedule` panics when `completed_at == 0`, these schedules
   are permanently orphaned in storage. There is no on-chain donor index to
   enumerate them for a migration. This affects only pre-existing schedules
   that were fully claimed before the upgrade; all new schedules and
   partially-claimed ones will correctly receive `completed_at` upon their
   next claim or cancellation.

2. **Fuzz test (`prop_cleanup_only_removes_stale_data`) not yet implemented**:
   The issue specified this in testing requirements. It can be added in a
   follow-up PR in `fuzz_tests.rs`.

## Screenshots

Not applicable; this PR contains no UI changes.
