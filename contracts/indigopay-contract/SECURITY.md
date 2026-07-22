# Security Audit

This document records the security review of the IndigoPay contract.

## Phase A — Trust model hardening (two-step admin, contract pause, 48h upgrade timelock)

> **Note**: Phase A introduced two-step admin transfer with single-admin keys. Phase B (below) supersedes the admin model with multi-sig threshold signatures. The two-step transfer is preserved but redesigned as an in-place swap within the admin set. The contract pause and upgrade timelock remain unchanged.

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

## Phase B — Multi-sig admin with threshold signatures

Phase B replaces the single-admin model (`DataKey::Admin`) with a multi-signature admin system supporting M-of-N threshold signatures.

### Problem addressed

A single compromised admin key could: deactivate all projects, pause the contract indefinitely, propose a malicious upgrade (with 48h delay), change the USDC token address, or change the oracle address. Multi-sig raises the bar from "compromise one key" to "compromise M of N keys simultaneously."

### New data model

| Key                 | Type             | Description                                     |
| ------------------- | ---------------- | ----------------------------------------------- |
| `DataKey::AdminSet` | `Vec<Address>`   | Set of authorized admin addresses               |
| `DataKey::AdminThreshold` | `u32`     | Number of valid admin signatures required for critical operations |

The former `DataKey::Admin` variant is removed.

### Admin action tiers

**Critical actions** (require M-of-N signatures):
- `propose_upgrade`, `cancel_upgrade`
- `pause_contract`, `unpause_contract`
- `transfer_admin`, `cancel_admin_transfer`
- `deactivate_all_projects`
- `create_proposal`, `veto_proposal`
- `add_admin`, `remove_admin`, `update_threshold`

**Routine actions** (require 1-of-N signature):
- `register_project`, `batch_register_projects`
- `deactivate_project`, `pause_project`, `resume_project`
- `update_project_co2_rate`
- `set_usdc_token`, `set_oracle`, `set_donation_rate_limit`

### Multi-sig verification (`verify_m_of_n`)

The core verification function iterates the supplied `signers` vec:

1. Calls `signer.require_auth()` on each address (Soroban host-level cryptographic verification)
2. Checks membership in the admin set
3. **Deduplicates**: a `counted` vec ensures each address is counted only once, preventing a single compromised key from satisfying the threshold by passing itself multiple times
4. Panics with `"Insufficient admin signatures: M/N required"` if valid count < threshold

### Admin set management

All admin set mutations require M-of-N signatures:

- **`add_admin(signers, new_admin)`** — adds a new address. Panics if already an admin.
- **`remove_admin(signers, admin_to_remove)`** — removes an address. Panics if it would leave the set empty, or if the resulting set is smaller than the current threshold (forces explicit `update_threshold` first).
- **`update_threshold(signers, new_threshold)`** — updates the threshold. Must satisfy `1 <= threshold <= admin_set.len()`.

### Two-step admin transfer (in-place swap)

The two-step transfer is redesigned as an in-place swap that preserves the admin set size and threshold:

1. **Step 1** — M-of-N admins call `transfer_admin(signers, old_admin, new_admin)`. Validates that `old_admin` is in the set and `new_admin` is not. Stores `(old_admin, new_admin)` tuple under `DataKey::PendingAdmin`.
2. **Step 2** — `new_admin` calls `accept_admin()`. Performs a staleness check on both `old_admin` (must still be in set) and `new_admin` (must not have been independently added). Swaps `old_admin` for `new_admin` in-place within the admin set.
3. **Cancel** — M-of-N admins call `cancel_admin_transfer(signers)` to clear the pending entry.

**Security properties**:
- The admin set size N and threshold are never modified by a transfer
- The M-of-N group authorizes "swap A for B", not "dissolve everything"
- Staleness guards prevent both `old_admin` removal and `new_admin` independent addition from corrupting the set
- `new_admin` must self-authenticate via `accept_admin` (proves key control)

### Initialization

```rust
pub fn initialize(env: Env, admins: Vec<Address>, threshold: u32)
```

Validates: `admins` is non-empty, `threshold >= 1`, `threshold <= admins.len()`.

**Backward compatibility**: when threshold=1 and the admin set contains one address, behavior is identical to the previous single-admin model.

### Event audit trail

Every state change in the trust model emits an indexed event for indexer consumers:

| Event topic  | Trigger                                        |
| ------------ | ---------------------------------------------- |
| `ad_xfer`    | `transfer_admin` queued (old_admin → new_admin) |
| `ad_acc`     | `accept_admin` swap completed                  |
| `ad_xfc`     | `cancel_admin_transfer` cleared                |
| `paused`     | `pause_contract` set the pause flag            |
| `unpause`    | `unpause_contract` lifted the pause flag       |
| `upg_prop`   | `propose_upgrade` queued (hash + effective_at) |
| `upg_exec`   | `execute_upgrade` swapped the WASM             |
| `upg_cncl`   | `cancel_upgrade` dropped the pending upgrade   |
| `admin_add`  | `add_admin` added a new admin to the set       |
| `admin_rmv`  | `remove_admin` removed an admin from the set   |
| `thresh_up`  | `update_threshold` changed the threshold       |

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

## Donation Refund (#290)

### Trust model

`approve_refund` requires **both** admin authorization (`require_admin_for_routine`) **and** `project.wallet.require_auth()`. This means the token transfer from project wallet → donor happens atomically inside `approve_refund` (CEI ordering — all counter decrements are written before the transfer fires). If the project wallet does not co-sign, the approval reverts entirely.

This provides on-chain enforcement that "Approved = Paid" for three of the four motivating scenarios:
- Donor sent to the wrong project
- Donor entered the wrong amount
- Technical error in the transaction

The fourth scenario (project found to be fraudulent) is **unresolvable on-chain without escrow** — if the project wallet is adversarial, it will not co-sign the refund. This is a known limitation. The 24-hour cooldown + admin review provides the safety net; the project wallet co-sign closes the gap for honest-mistake cases.

### Pre-upgrade CO₂ limitation

CO₂ offset values for donations are snapshotted in `DataKey::DonationCO2Offset(u32)` at donation time. Pre-upgrade donations lack this key, so refunds for those donations use `co2_offset_grams = 0` — meaning `GlobalCO2OffsetGrams` is not reversed for pre-upgrade refunds. This creates a small, bounded, one-directional drift: the global counter may be marginally overstated relative to true refunded volume. This is an accepted, documented limitation.

### Badge permanence

Badge tiers and minted NFTs are **never** downgraded or burned on refund. The refund adjusts `total_donated` and `co2_offset_grams` but does not call `calculate_badge()`. A donor who reaches EarthGuardian and later refunds all donations keeps their EarthGuardian badge and any minted ImpactNFTs. This is a deliberate design choice — badges are permanent artifacts, not live counters.

### Underflow protection

All counter decrements on refund use `checked_sub(...).expect("...underflow on refund")`, consistent with the `checked_add` convention used for donations. If a refund would drive any counter negative, the transaction panics and reverts.
