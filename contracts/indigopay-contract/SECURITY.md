# Security Audit

This document records the security review of the IndigoPay contract.

## Phase A — Trust model hardening (two-step admin, contract pause, 48h upgrade timelock)

The previous design had three single-admin SPOFs:

1. **Admin transfer was instant** — a single compromised signature could silently give the attacker full control.
2. **No contract-level pause** — only per-project pause existed, leaving no way to halt the contract during an incident.
3. **Upgrade was instant** — `upgrade(admin, new_wasm_hash)` swapped the WASM in one transaction, with no community review window.

Phase A replaces all three with a stronger trust model.

### 1. Two-step admin transfer

The admin key is now a two-step handoff:

1. **Step 1** — current admin calls `transfer_admin(admin, new_admin)`. The proposed admin is stored under `DataKey::PendingAdmin` and an `ad_xfer` event is emitted.
2. **Step 2** — the proposed admin calls `accept_admin()`. The contract reads the pending entry and promotes it. Auth is gated by `pending.require_auth()`, so only the proposed recipient (not the old admin) can promote themselves.
3. **Cancel** — the current admin may call `cancel_admin_transfer(admin)` to clear the pending entry if the proposed recipient lost their key or the transfer was a mistake.

State invariants:

- `accept_admin` panics with `"No pending admin transfer"` if no proposal exists.
- `transfer_admin` panics with `"Admin transfer already pending; cancel first"` if a proposal is already in flight, preventing an attacker from overwriting a pending recipient.
- `accept_admin` does not take a caller argument — the only value the contract trusts to become admin is the stored pending entry. There is no path for an imposter to promote a different address.

### 2. Contract-level pause

A single boolean `DataKey::ContractPaused` (default `false`) gates every state-mutating public function:

- `donate`, `donate_usdc`
- `mint_impact_nft`, `mint_project_nft`
- `create_proposal`, `vote_verify_project`
- `register_project`, `batch_register_projects`
- `update_project_co2_rate`, `deactivate_project`, `deactivate_all_projects`
- `set_usdc_token`, `set_oracle`

Read-only getters continue to work while the contract is paused, so off-chain UIs and indexers can keep polling.

The pause functions (`pause_contract` / `unpause_contract`), the admin-recovery functions (`transfer_admin` / `accept_admin` / `cancel_admin_transfer`), and the upgrade lifecycle (`propose_upgrade` / `execute_upgrade` / `cancel_upgrade`) are **deliberately not pause-gated** so the admin can always recover from a paused contract or cancel a pending upgrade during an incident.

The `require_not_paused` helper is called immediately after `require_auth` and before any storage read, so a paused-contract call panics as cheaply as possible.

### 3. 48-hour upgrade timelock

The old single-step `upgrade(admin, new_wasm_hash)` is removed in favour of a 48-hour timelock:

1. **Step 1** — admin calls `propose_upgrade(admin, new_wasm_hash)`. The hash is stored under `DataKey::PendingUpgrade`; the earliest executable ledger is stored under `DataKey::UpgradeEffectiveAt`. An `upg_prop` event is emitted with both values.
2. **Wait 48h** — `UPGRADE_TIMELOCK_LEDGERS = 34_560` ledgers (48h × 3600s / 5s/ledger) must elapse.
3. **Step 2** — anyone may call `execute_upgrade()` after the timelock has elapsed. On success the contract WASM is swapped via `env.deployer().update_current_contract_wasm`, the executed hash is recorded under `DataKey::LastExecutedUpgrade`, and an `upg_exec` event is emitted.
4. **Cancel** — admin may call `cancel_upgrade(admin)` at any time before execution to drop a pending upgrade.

**SECURITY**: the 48h timelock is the SOLE delay between a proposed upgrade and its execution. If the admin key is compromised, the attacker can `propose_upgrade` immediately, but the community has 48h to react (exit positions, deploy a rescue contract, signal objections off-chain) before the WASM is swapped. There is no second gate.

Helpers:

- `get_pending_upgrade() -> Option<(BytesN<32>, u32)>` — hash + effective_at ledger of the pending upgrade, or `None`.
- `get_last_executed_upgrade() -> Option<BytesN<32>>` — hash of the most-recently executed upgrade. `None` if the contract has never been upgraded.

### Event audit trail

Every state change in the new trust model emits an indexed event for indexer consumers:

| Event topic        | Trigger                                              |
|--------------------|------------------------------------------------------|
| `ad_xfer`          | `transfer_admin` queued                              |
| `ad_acc`           | `accept_admin` promoted                              |
| `ad_xfc`           | `cancel_admin_transfer` cleared                      |
| `paused`           | `pause_contract` set the pause flag                  |
| `unpause`          | `unpause_contract` lifted the pause flag             |
| `upg_prop`         | `propose_upgrade` queued (hash + effective_at)      |
| `upg_exec`         | `execute_upgrade` swapped the WASM                   |
| `upg_cancel`       | `cancel_upgrade` dropped the pending upgrade         |

---

## Integer overflow prevention

This section records the security review of arithmetic operations in the IndigoPay contract, with focus on integer overflow in global stats accumulators.

### Scope

Audit covers all arithmetic in `record_donation` and related functions that update global state:
- `GlobalTotalRaised` (i128)
- `GlobalCO2OffsetGrams` (i128)
- Project and donor statistics

### Findings

#### Protected Operations

All critical arithmetic operations use Rust's checked_add to prevent silent overflow:

1. **GlobalTotalRaised updates**
   - Line 311: `gr.checked_add(amount).expect("GlobalTotalRaised overflow")`
   - Line 610: `gr.checked_add(xlm_equivalent).expect(...)`
   - Panics if sum exceeds i128::MAX (9,223,372,036,854,775,807)

2. **GlobalCO2OffsetGrams updates**
   - Line 315: `gc.checked_add(co2_increment).expect("GlobalCO2 overflow")`
   - Line 614: `gg.checked_add(co2_increment).expect(...)`
   - Panics if sum exceeds i128::MAX

3. **Pre-computation of CO2 increment**
   - Line 260: `xlm_units.checked_mul(project.co2_per_xlm as i128).expect("CO2 calculation overflow")`
   - Prevents multiplication overflow before accumulation

4. **Project and Donor statistics**
   - Line 273: Project total_raised uses checked_add
   - Line 283: Donor total_donated uses checked_add
   - Line 287: Donor co2_offset_grams uses checked_add
   - All checked operations with panic on overflow

### Extreme Input Analysis

Max donation scenarios:
- Single donation: i128::MAX stroops (9.22e18 XLM equivalent)
- With CO2 factor: 100 grams/XLM max project setting
  - Overflow would occur at: i128::MAX / 100 = 9.22e16 XLM
  - Current check prevents all overflow paths

- Multiple donations accumulating to GlobalTotalRaised:
  - Each donation checked individually before accumulation
  - Cumulative cap: i128::MAX (9.22e18 stroops total)
  - Current design prevents integer wrap-around

### Conclusion

No silent overflows possible. All operations that could exceed i128::MAX will panic with descriptive messages. The contract is safe for production use with any realistic donation volume.

