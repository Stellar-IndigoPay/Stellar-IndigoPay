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

## Off-Chain Oracle Attestation for Project Impact Verification (#459)

Gated behind the `impact_verification` Cargo feature (on by default; excluded from the size-checked `--no-default-features` CI build). Lets admin-authorised verifiers submit independent measurements of a project's actual CO₂ impact, which the contract compares against the project's self-reported (claimed) rate.

### Trust model

- **Verifiers are admin-appointed**, not permissionless. `add_impact_verifier` / `remove_impact_verifier` require `require_admin_for_routine`, so the same trust assumption as every other routine admin action (single admin signature, or 1-of-N under the Phase B multi-sig model) applies here too. A compromised admin key can add an adversarial verifier; this is not a new SPOF beyond what Phase B already accepts for routine operations.
- **Reports are not adversarially aggregated.** `submit_impact_report` does not require multiple verifiers to agree before storage — each report is stored independently. Manipulation resistance comes from the *median* of all distinct verifiers' reports once the threshold is reached, not from any single report being authoritative. A minority of colluding verifiers cannot move the median unless they control a majority of the authorised verifier set.
- **The deviation flag is sticky by design.** Once `ImpactFlagged` is set it stays set until an admin explicitly calls `clear_impact_flag` — a later report that happens to fall back within tolerance does not silently clear it. This forces a human admin decision rather than letting a flag disappear on its own.
- **Duplicate submissions cannot inflate the verifier count.** Reports are keyed by `(project_id, verifier)`; a verifier resubmitting updates their existing record and does not add a second entry to the distinct-verifier list used for both the threshold check and the median.
- **The threshold is admin-configurable** (`set_impact_report_threshold`, falls back to `DEFAULT_IMPACT_REPORT_THRESHOLD = 3` when unset) so operators can tune how many independent verifiers are required before the contract trusts their consensus enough to overwrite `co2_per_xlm` without further admin sign-off.

### Bounds and overflow

`verified_co2_rate` is checked against the same `MAX_CO2_PER_XLM` bound used at project registration and by `update_project_co2_rate`, so an auto-adjustment can never push a project's rate above the platform-wide ceiling. The median itself is additionally clamped to `[1, MAX_CO2_PER_XLM]` before being written, guarding against a `co2_per_xlm = 0` write (which `update_project_co2_rate` treats as invalid) even in a degenerate single-verifier case.

### Event audit trail

| Event topic | Trigger                                                        |
| ----------- | --------------------------------------------------------------- |
| `impv_add`  | `add_impact_verifier` authorised a new verifier                 |
| `impv_rem`  | `remove_impact_verifier` revoked a verifier                      |
| `impv_thr`  | `set_impact_report_threshold` changed the auto-adjust threshold  |
| `impv_sub`  | `submit_impact_report` recorded or updated a report              |
| `impv_flg`  | A submission deviated ≥50% from the claimed rate                |
| `impv_adj`  | `co2_per_xlm` was auto-adjusted to the new median                |
| `impv_clr`  | `clear_impact_flag` cleared a project's deviation flag           |

## Off-Chain Multi-Verifier Project Verification Oracle

Gated behind the `project_verification` Cargo feature (on by default; excluded
from the size-checked `--no-default-features` CI build, same as
`impact_verification`). Gates whether a registered project is *eligible to
receive donations at all* — distinct from `impact_verification` above, which
audits an ongoing metric (`co2_per_xlm`) on projects that are already
donatable.

### Trust model

- **Verifiers are admin-appointed, not permissionless**, and are managed by
  **M-of-N admin signatures** (`add_verifier` / `remove_verifier` /
  `set_verification_threshold` / `revoke_verification` all require
  `require_admin_for_critical`) — a stricter bar than `impact_verification`'s
  verifier management, which only requires a single routine admin signature.
  This was a deliberate choice for this feature: getting the verifier set or
  threshold wrong directly controls which projects can receive donor funds at
  all, so a single compromised admin key should not be able to unilaterally
  add a colluding verifier or drop the threshold to zero.
- **`VerifierSet` is a separate role from `AdminSet`.** Being an admin does
  not make an address a verifier and vice versa; the M-of-N admin quorum
  manages the verifier role, but does not itself attest to anything.
- **What the threshold protects, and what it doesn't.** Requiring M distinct
  verifier attestations before a project can receive donations raises the bar
  from "one admin registers a project" to "M independently-appointed
  reviewers vouched for it." It does **not** validate the *content* of the
  off-chain evidence — the contract only stores a hash of it — so it cannot
  detect a verifier who signs off without actually doing due diligence, or M
  colluding verifiers who all vouch for a fraudulent project. The same
  caveat `impact_verification` already documents applies here: a minority of
  colluding verifiers cannot move the outcome unless they control a majority
  of the authorised verifier set.
- **Attestations are historical facts, not live credentials.**
  `remove_verifier` only prevents *future* attestations from that address; it
  does not retroactively remove attestations that address already submitted,
  and does not demote a project that reached `Verified` partly because of
  them. This mirrors `remove_impact_verifier`'s documented behaviour exactly
  ("reports it already submitted... are left untouched"). Only the explicit,
  audited `revoke_verification` call clears a project's accumulated
  attestations.
- **`Verified` is a one-way ratchet within a verification cycle.** Once a
  project reaches `Verified`, neither removing a verifier nor raising
  `VerificationThreshold` afterwards demotes it — only `revoke_verification`
  does, and doing so resets the project to `Unverified` from a clean slate
  (all prior attestations and evidence hashes are cleared, so re-verification
  starts over rather than instantly re-triggering off leftover state).
- **Duplicate attestations cannot inflate the count.** A verifier attesting
  the same project twice panics (`DuplicateAttestation`) rather than silently
  updating — unlike `impact_verification`'s reports, which intentionally
  allow resubmission. A verifier who made a mistake needs an admin to
  `revoke_verification` before attesting again.
- **Changing the threshold never leaves a project in an inconsistent state,
  by construction rather than by eager recomputation.** There is no bounded
  way to walk every registered project when an admin changes
  `VerificationThreshold`, so the contract never tries to. Instead, both
  `attest_project` and the donation gate (`require_project_verified_for_donation`)
  recompute a project's live status against the *current* threshold on every
  call (never downgrading an already-`Verified` project — see the ratchet
  point above). Practically: if an admin lowers the threshold below a
  project's existing attester count, that project reads as `Verified`
  immediately on the next read-only status query, and the very next
  `donate*` or `attest_project` call persists the transition and emits
  `proj_vfy`. There is no scenario where a project needs a *fresh*
  attestation just to notice a threshold change that already qualifies it.
- **Backward compatibility (legacy mode).** `VerificationThreshold` defaults
  to `0` (absent) when never configured, and an absent `ProjectVerification`
  key reads as `Unverified` by default. The donation gate treats
  `(threshold == 0, Unverified)` as an explicit pass-through — every project
  registered before this feature existed (or on a deployment that never
  configures a threshold) remains donatable exactly as it was.
- **`Rejected` is a reserved state.** The `VerificationStatus` enum includes
  a `Rejected` variant for a possible future issue (e.g. an explicit
  verifier-rejection vote). No function in this feature assigns it; it exists
  only so a future migration doesn't need to add a new enum variant to
  already-deployed storage.

### Storage design note

Kept as a separate `ProjectVerificationKey` enum rather than new `DataKey`
variants, mirroring `ImpactVerificationKey`. Appending
`#[cfg(feature = "project_verification")]`-gated variants directly to the
shared, always-on `DataKey` enum would shift every later variant's XDR
discriminant depending on whether the feature is compiled in, silently
corrupting storage reads across builds with different feature sets. Per-
project attester lists (`ProjectAttesters`) deliberately hold only verifier
addresses, not full attestation records; evidence hashes live in their own
per-(project, verifier) key (`ProjectAttestationEvidence`) so reading the
attester list/count for a threshold check never has to pull evidence data
along with it.

### Donation gate coverage

`require_project_verified_for_donation` is called from every donation-crediting
entry point: `process_donation` (backing `donate`, `donate_with_privacy`, and
`batch_donate`), `donate_asset_with_privacy`, `donate_anonymous`,
`donate_usdc_with_privacy`, `execute_recurring`, and `donate_vested`. It is not
called from `initiate_emergency_withdrawal` — that function disburses funds a
project has already collected and is unrelated to donation eligibility.

### Event audit trail

| Event topic | Trigger                                                              |
| ----------- | ---------------------------------------------------------------------- |
| `ver_add`   | `add_verifier` authorised a new verifier                             |
| `ver_rem`   | `remove_verifier` revoked a verifier (past attestations unaffected)  |
| `ver_thr`   | `set_verification_threshold` changed the auto-verify threshold      |
| `proj_att`  | `attest_project` recorded a new attestation                          |
| `proj_vfy`  | A project's status transitioned to `Verified`                        |
| `proj_rvk`  | `revoke_verification` cleared a project's verification state         |
