# IndigoPay Contract Upgrade Notes

## Phase A — 48-hour timelock (current)

As of Phase A, contract upgrades are no longer a single `upgrade(admin, new_wasm_hash)` call. The admin must run a two-step timelock flow:

1. `propose_upgrade(admin, new_wasm_hash)` — records the proposed hash under `DataKey::PendingUpgrade` and the earliest executable ledger under `DataKey::UpgradeEffectiveAt`. Emits an `upg_prop` event.
2. **Wait** for at least `UPGRADE_TIMELOCK_LEDGERS = 34_560` ledgers (48h × 3600s / 5s/ledger) to elapse.
3. `execute_upgrade()` — permissionless; anyone can call it after the timelock. The contract WASM is swapped via `env.deployer().update_current_contract_wasm`, the executed hash is recorded under `DataKey::LastExecutedUpgrade`, and an `upg_exec` event is emitted.
4. **Cancel** — admin may call `cancel_upgrade(admin)` at any time before execution to drop a pending upgrade. Emits an `upg_cncl` event.

This 48h delay is the **sole safety mechanism** against a compromised admin key proposing a malicious WASM. See `SECURITY.md` for the full threat model and the recovery procedure.

If you are upgrading this contract:

- The proposed WASM MUST be a drop-in replacement that preserves every storage key and value layout listed below.
- During the 48h window, run a dry-run deployment to a testnet address with the same storage, and verify the regression test (`test_upgrade_preserves_donation_state_and_storage_keys`) passes against the new WASM.
- If the proposed WASM is discovered to be malicious or buggy during the window, the admin MUST call `cancel_upgrade` before the timelock elapses.

## Storage Compatibility

IndigoPay uses Soroban instance storage. Upgrade code must keep existing storage keys and stored value layouts backward-compatible because old ledger entries are decoded by the new contract executable after upgrade.

The current persisted keys are:

- `DataKey::Admin`
- `DataKey::Project(String)`
- `DataKey::ProjectCount`
- `DataKey::DonorStats(Address)`
- `DataKey::ImpactNFT(Address, BadgeTier)`
- `DataKey::DonationCount`
- `DataKey::GlobalTotalRaised`
- `DataKey::GlobalCO2OffsetGrams`
- `DataKey::HasDonated(String, Address)`
- `DataKey::Proposal(String)`
- `DataKey::HasVoted(String, Address)`
- `DataKey::DonorProjectTotal(String, Address)` _(v1.1 milestone-NFT support)_
- `DataKey::ProjectMilestoneNFT(String, Address)` _(v1.1 milestone-NFT support)_
- `DataKey::VoterList(String)` _(v1.2 governance UI support)_
- `DataKey::ProjectIdsAll` _(v1.2 bulk admin support)_
- `DataKey::USDCTokenAddress` _(v1.2 multi-currency)_
- `DataKey::OracleAddress` _(v1.2 price oracle)_
- `DataKey::PendingAdmin` _(Phase A two-step admin)_
- `DataKey::ContractPaused` _(Phase A contract-level pause)_
- `DataKey::PendingUpgrade` _(Phase A 48h timelock)_
- `DataKey::UpgradeEffectiveAt` _(Phase A 48h timelock)_
- `DataKey::LastExecutedUpgrade` _(Phase A 48h timelock)_
- `DataKey::RefundRequest(u32)` _(#290 donation refund)_
- `DataKey::RefundCount` _(#290 donation refund)_
- `DataKey::RefundForDonation(u32)` _(#290 donation refund)_
- `DataKey::DonationCO2Offset(u32)` _(#290 donation refund — CO₂ snapshot per donation)_
- `DataKey::SubProjectIds(String)` _(#391 cross-contract project registry — sub-project index per parent)_
- **Storage version tracking** _(#379 — Symbol-keyed, not a DataKey variant)_

Do not rename or remove these variants, change their argument order, or reorder/remove fields from stored structs such as `Project`, `DonorStats`, `ImpactNFT`, `ProjectMilestoneNFT`, `VoteProposal`, or `GlobalStats` without adding an explicit migration path. New fields should be handled through a new storage version or a new key namespace so existing v1 values remain decodable.

## Regression Coverage

`test_upgrade_preserves_donation_state_and_storage_keys` covers the v1 to v2 same-code path:

1. Deploys IndigoPay v1 in the Soroban test host.
2. Registers a project and records a real token-backed donation.
3. Replaces the executable at the same contract ID with the same IndigoPay code to model a v2 upgrade.
4. Reads the donation-derived project totals, donor stats, badge/NFT state, global counters, and `HasDonated` marker through both public getters and direct `DataKey` lookups.

This confirms the storage keys and value layouts used by existing donation state remain backward-compatible across the upgrade.

## Timelock Regression Coverage

`test_propose_upgrade_*` and `test_execute_upgrade_*` exercise the new timelock lifecycle:

- `test_propose_upgrade_stores_pending_and_effective_at` — verifies both storage keys are written.
- `test_propose_upgrade_double_propose_fails` — verifies only one pending upgrade may exist at a time.
- `test_execute_upgrade_before_timelock_fails` — verifies the timelock panics before the deadline.
- `test_execute_upgrade_after_timelock_succeeds` — advances the ledger past `UPGRADE_TIMELOCK_LEDGERS` and verifies the WASM swap fires and `get_last_executed_upgrade` returns the hash.
- `test_cancel_upgrade_clears_pending` and `test_cancel_upgrade_during_timelock_succeeds` — verify the cancel path.
- `test_get_pending_upgrade` — verifies the read-only getter returns the correct `(hash, effective_at)` tuple.

## Storage Versioning and Migration (#379)

The contract uses a `DataKey::StorageVersion` key to track the current schema
version. This enables automated storage migrations after contract upgrades:

### Version constants

- `CURRENT_STORAGE_VERSION` — defined at the top of `lib.rs`. Bump this and add
  a migration step in `migrate()` whenever a struct layout, DataKey variant,
  or stored value encoding changes in a backward-incompatible way.
- `DataKey::StorageVersion` — persists the version number after each migration
  step completes, ensuring no step is applied twice.

### How migrations work

1. `initialize()` sets `StorageVersion = CURRENT_STORAGE_VERSION` for new
   contracts, so they skip all historical migrations.
2. For upgraded contracts, `execute_upgrade()` calls `migrate()` immediately
   after swapping the WASM.
3. `migrate()` reads the current `StorageVersion`, applies each pending
   migration step sequentially (e.g., `migrate_v1_to_v2`), and updates
   `StorageVersion` after each step.
4. The final assertion in `migrate()` panics if `StorageVersion` does not
   equal `CURRENT_STORAGE_VERSION`, catching incomplete migration sequences
   at upgrade time.

### Adding a new migration

1. Bump `CURRENT_STORAGE_VERSION`.
2. Add the migration function (e.g., `migrate_v2_to_v3`).
3. Add a `if current < NEW_VERSION { migrate_v2_to_v3(env); set_storage_version(NEW_VERSION); }`
   block in `migrate()`.
4. Handle backward-incompatible changes — rename old keys, transform stored
   values, or backfill missing entries — inside the migration function.

### Example migration (v1 → v2)

The v1→v2 migration is empty because v1 storage is v2-compatible. It exists
solely to establish the migration framework pattern. When the first real
schema change is introduced, replace it with actual data transformations.

## Validation

Run the focused regression test:

```bash
cargo test -p indigopay-contract --lib test_upgrade_preserves_donation_state_and_storage_keys
```

Run the storage versioning tests:

```bash
cargo test -p indigopay-contract --lib test_storage_version_initialized
cargo test -p indigopay-contract --lib test_migration_runs_on_upgrade
cargo test -p indigopay-contract --lib test_migration_idempotent
```

Run the timelock regression test:

```bash
cargo test -p indigopay-contract --lib propose_upgrade
cargo test -p indigopay-contract --lib execute_upgrade
cargo test -p indigopay-contract --lib cancel_upgrade
```

Run the full contract suite:

```bash
cargo test
```
