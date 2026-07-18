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

## Validation

Run the focused regression test:

```bash
cargo test -p indigopay-contract --lib test_upgrade_preserves_donation_state_and_storage_keys
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

## Storage Migration Flow (Redeployment)

When upgrading via WASM swap is not possible or desirable (e.g. migrating to a different network or applying structural changes that cannot be handled via WASM replacement), use the migration helpers to export and import state.

### 1. Export State & Get Hash
1. Call `export_state(admin)` on the active deployed contract. This returns a `Vec<StateEntry>` representing the contract's instance data.
2. Call `get_state_hash(admin)` on the active contract to get a deterministic 32-byte SHA-256 digest of the exported state.

### 2. Deploy & Import
1. Deploy the new contract WASM to the target network. Do **not** initialize it.
2. Call `import_state(admin, state)` on the new contract, passing the `Vec<StateEntry>` exported in Step 1.
   - *Note:* The contract must not have been initialized (must not contain an `Admin` key in instance storage) for this to succeed.
3. Once completed, the imported state is active on the new contract.

### 3. Verify
1. Call `get_state_hash(admin)` on the new contract.
2. Verify that the returned 32-byte digest matches the hash retrieved from the source contract in Step 1.
3. The new deployment is now ready to use, and all historical projects, settings, and donation records are preserved.

