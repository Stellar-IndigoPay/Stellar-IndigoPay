# Soroban Contract Events

This document lists all events emitted by the Stellar IndigoPay Soroban smart contracts.

## Event Schema Format

| Event Name | Topics | Data | When Emitted |
| ---------- | ------ | ---- | ------------ |

---

## `zk_vk_set`

**Description**: Emitted after M-of-N admins install a new anonymous-donation
verification key. Event data is the SHA-256 hash of the key.

| Event Name  | Topics          | Data               | When Emitted |
| ----------- | --------------- | ------------------ | ------------ |
| `zk_vk_set` | `["zk_vk_set"]` | `BytesN<32>`       | Verification key update |

## `zk_donate`

**Description**: Emitted after an anonymous proof is verified and its
nullifier consumed. No donor address is included.

| Event Name  | Topics                                      | Data                                      | When Emitted |
| ----------- | ------------------------------------------- | ----------------------------------------- | ------------ |
| `zk_donate` | `["zk_donate", project_id, nullifier]`      | `(amount_commitment, co2_offset_grams)`   | Verified anonymous donation |

---

## `StealthScan`

**Description**: Emitted when an authenticated project wallet scans for its
stealth donations, including scans that find no donations.

| Event Name    | Topics                              | Data                                         | When Emitted |
| ------------- | ----------------------------------- | -------------------------------------------- | ------------ |
| `StealthScan` | `["StealthScan", project_wallet]`   | `(donation_count: u32, timestamp: u64)`      | After `scan_stealth_donations` completes |

---

## `StealthWithdrawal`

**Description**: Emitted by the `DonationContract` when a project wallet
withdraws stealth-donated funds to its own wallet. `remaining_balance` lets
indexers reconcile on-chain `total_raised` with funds actually received by
the project, so stealth donations are never left stranded in the
`DonationContract` (closes #621).

| Event Name          | Topics                                  | Data                                                          | When Emitted |
| ------------------- | --------------------------------------- | ------------------------------------------------------------- | ------------ |
| `StealthWithdrawal` | `["StealthWithdrawal", project_wallet]` | `(token: Address, amount: i128, remaining_balance: i128, timestamp: u64)` | After `withdraw_stealth_donations` transfers the tokens |

---

## `stlth_wdr`

**Description**: Emitted by `IndigoPayContract.withdraw_stealth_integrated`
after forwarding a stealth withdrawal to the `DonationContract`. Keyed by
`project_id` so main-contract indexers can reconcile `total_raised` with
funds actually received (closes #621).

| Event Name   | Topics                       | Data                                       | When Emitted |
| ------------ | ---------------------------- | ------------------------------------------ | ------------ |
| `stlth_wdr`  | `["stlth_wdr", project_id]` | `(token: Address, amount: i128, remaining_balance: i128)` | After `withdraw_stealth_integrated` completes |

---

## 1. `donated`

**Description**: Emitted after a successful XLM donation to a project.

| Event Name | Topics                           | Data                                                     | When Emitted                  |
| ---------- | -------------------------------- | -------------------------------------------------------- | ----------------------------- |
| `donated`  | `["donated", donor_or_zero_address, project_id]` | `{ "amount": u128, "badge": String, "msg_hash": Bytes }` | After successful donation |

When a donor passes `anonymous: true`, `donor_or_zero_address` is the Stellar
zero-address placeholder (`GAAAAAAAA…WHF`). Amounts and project/global impact
metrics remain public; public donor-profile and leaderboard projections exclude it.
The contract exposes `get_anonymous_donation_count(env, project_id)` for
project-scoped anonymous donation totals.

> **Privacy guarantee (#707):** For anonymous donations, `DonationRecord.donor`
> is also stored as the zero-address placeholder — not the real donor — so the
> on-chain record is unlinkable. The real donor retains provable ownership via a
> per-donation SHA-256 commitment stored under `DataKey::AnonymousCommitment(index)`.

---

## 2. `nft_mint`

**Description**: Emitted when a donor reaches a new badge tier and receives an NFT.

| Event Name | Topics                | Data                                        | When Emitted              |
| ---------- | --------------------- | ------------------------------------------- | ------------------------- |
| `nft_mint` | `["nft_mint", donor]` | `{ "badge_tier": String, "token_id": u32 }` | On new badge tier reached |

---

## 3. `project_registered`

**Description**: Emitted when a new climate project is registered.

| Event Name           | Topics                               | Data                                    | When Emitted                   |
| -------------------- | ------------------------------------ | --------------------------------------- | ------------------------------ |
| `project_registered` | `["project_registered", project_id]` | `{ "name": String, "wallet": Address }` | When a new project is approved |

---

## 4. `project_updated`

**Description**: Emitted when project details or impact metrics are updated.

| Event Name        | Topics                            | Data                                       | When Emitted                 |
| ----------------- | --------------------------------- | ------------------------------------------ | ---------------------------- |
| `project_updated` | `["project_updated", project_id]` | `{ "field": String, "new_value": String }` | When project info is updated |

---

## 5. `impact_updated`

**Description**: Emitted when CO₂ impact or other metrics are updated for a project.

| Event Name       | Topics                           | Data                                   | When Emitted                |
| ---------------- | -------------------------------- | -------------------------------------- | --------------------------- |
| `impact_updated` | `["impact_updated", project_id]` | `{ "co2_offset": u128, "trees": u32 }` | After impact metrics update |

---

## 6. `badge_awarded`

**Description**: Emitted when a donor is awarded a new badge (complements `nft_mint`).

| Event Name      | Topics                     | Data                                 | When Emitted                       |
| --------------- | -------------------------- | ------------------------------------ | ---------------------------------- |
| `badge_awarded` | `["badge_awarded", donor]` | `{ "tier": String, "name": String }` | When donor reaches badge threshold |

---

## 7. `withdrawal`

**Description**: Emitted when a project withdraws funds.

| Event Name   | Topics                       | Data                                    | When Emitted               |
| ------------ | ---------------------------- | --------------------------------------- | -------------------------- |
| `withdrawal` | `["withdrawal", project_id]` | `{ "amount": u128, "remaining": u128 }` | When project withdraws XLM |

---

## 8. `contract_initialized`

**Description**: Emitted once when the contract is initialized.

| Event Name             | Topics                     | Data                                                | When Emitted                  |
| ---------------------- | -------------------------- | --------------------------------------------------- | ----------------------------- |
| `contract_initialized` | `["contract_initialized"]` | `{ "admins": Vec<Address>, "threshold": u32 }`      | On contract deployment / init |

---

## 9. `rate_lim`

**Description**: Emitted when the admin updates the per-donor per-project donation rate limit.

| Event Name | Topics        | Data                                      | When Emitted                          |
| ---------- | ------------- | ----------------------------------------- | ------------------------------------- |
| `rate_lim` | `["rate_lim"]` | `{ "max_donations": u32, "window_ledgers": u32 }` | When admin calls `set_donation_rate_limit` |

---

## 9a. `tok_rate`

**Description**: Emitted when the admin updates the donation rate limit for one token.

| Event Name | Topics                       | Data                                                   | When Emitted                           |
| ---------- | ---------------------------- | ------------------------------------------------------ | -------------------------------------- |
| `tok_rate` | `["tok_rate", token_address]` | `{ "max_donations": u32, "window_ledgers": u32 }`      | When admin calls `set_token_rate_limit` |

---

## 10. `admin_add`

**Description**: Emitted when a new admin address is added to the multi-sig set.

| Event Name  | Topics           | Data                   | When Emitted                  |
| ----------- | ---------------- | ---------------------- | ----------------------------- |
| `admin_add` | `["admin_add"]` | `{ "admin": Address }` | When M-of-N admins call `add_admin` |

---

## 11. `admin_rmv`

**Description**: Emitted when an admin address is removed from the multi-sig set.

| Event Name  | Topics           | Data                   | When Emitted                    |
| ----------- | ---------------- | ---------------------- | ------------------------------- |
| `admin_rmv` | `["admin_rmv"]` | `{ "admin": Address }` | When M-of-N admins call `remove_admin` |

---

## 12. `thresh_up`

**Description**: Emitted when the multi-sig threshold is changed.

| Event Name  | Topics           | Data                          | When Emitted                      |
| ----------- | ---------------- | ----------------------------- | --------------------------------- |
| `thresh_up` | `["thresh_up"]` | `{ "threshold": u32 }`        | When M-of-N admins call `update_threshold` |

---

## 13. `ew_init`

**Description**: Emitted when an admin initiates a 7-day timelocked emergency withdrawal.

| Event Name | Topics                                | Data                                                               | When Emitted                                  |
| ---------- | ------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| `ew_init`  | `["ew_init", admin, project_id]`     | `{ "new_wallet": Address, "amount": i128, "token": Address, "executable_at": u32 }` | When admin calls `initiate_emergency_withdrawal` |

---

## 14. `ew_exec`

**Description**: Emitted when an emergency withdrawal is executed after the 7-day timelock.

| Event Name | Topics                            | Data                                                   | When Emitted                                |
| ---------- | --------------------------------- | ------------------------------------------------------ | ------------------------------------------- |
| `ew_exec`  | `["ew_exec", project_id]`        | `{ "new_wallet": Address, "amount": i128, "token": Address }` | After timelock, funds transferred to new wallet |

---

## 15. `ew_cncl`

**Description**: Emitted when an admin cancels a pending emergency withdrawal.

| Event Name | Topics                              | Data | When Emitted                                |
| ---------- | ----------------------------------- | ---- | ------------------------------------------- |
| `ew_cncl`  | `["ew_cncl", admin, project_id]`   | `token: Address` | When admin calls `cancel_emergency_withdrawal` or `cancel_all_emergency_withdrawals` |

---

## 15b. `ew_batch`

**Description**: Emitted when batch emergency withdrawals are executed for a project.

| Event Name | Topics                            | Data                | When Emitted                                     |
| ---------- | --------------------------------- | ------------------- | ------------------------------------------------ |
| `ew_batch` | `["ew_batch", project_id]`       | `executed_count: u32` | When calling `exec_all_emergency_withdrawals` |

---

## 16. `rfnd_rq`

**Description**: Emitted when a donor requests a refund within the 24-hour cooldown window.

| Event Name  | Topics                              | Data                                                            | When Emitted                          |
| ----------- | ----------------------------------- | --------------------------------------------------------------- | ------------------------------------- |
| `rfnd_rq`   | `["rfnd_rq", refund_id, donor]`    | `(project_id: String, amount: i128, donation_record_index: u32)` | When donor calls `request_refund` |

---

## 17. `rfnd_ap`

**Description**: Emitted when an admin + project wallet approve a refund. The token transfer happens atomically.

| Event Name  | Topics                              | Data                                                    | When Emitted                          |
| ----------- | ----------------------------------- | ------------------------------------------------------- | ------------------------------------- |
| `rfnd_ap`   | `["rfnd_ap", refund_id, admin]`    | `(project_id: String, amount: i128, donor: Address)`    | When admin calls `approve_refund`     |

---

## 18. `rfnd_rj`

**Description**: Emitted when an admin rejects a refund request. The donation stands; no counters are adjusted.

| Event Name  | Topics                              | Data                                        | When Emitted                          |
| ----------- | ----------------------------------- | ------------------------------------------- | ------------------------------------- |
| `rfnd_rj`   | `["rfnd_rj", refund_id, admin]`    | `(project_id: String, donor: Address)`       | When admin calls `reject_refund`      |

---

## Force-refund escalation events

These lifecycle events use full `Symbol` values because their names exceed the
nine-character `symbol_short!` limit.

### `rfnd_force_init`

**Description**: Emitted after M-of-N admins schedule a force-refund. No tokens
or donation accounting move at this point.

| Event Name         | Topics                           | Data                                                     | When Emitted |
| ------------------ | -------------------------------- | -------------------------------------------------------- | ------------ |
| `rfnd_force_init`  | `["rfnd_force_init", refund_id]` | `(project_id: String, amount: i128, effective_at: u32)` | When M-of-N admins call `force_approve_refund` |

### `rfnd_force_exec`

**Description**: Emitted after the timelock when a force-refund is paid from
the project's canonical contract-held token balance.

| Event Name         | Topics                           | Data                                                   | When Emitted |
| ------------------ | -------------------------------- | ------------------------------------------------------ | ------------ |
| `rfnd_force_exec`  | `["rfnd_force_exec", refund_id]` | `(project_id: String, amount: i128, donor: Address)`  | After `execute_force_refund` completes |

### `rfnd_force_cncl`

**Description**: Emitted when any current admin cancels an escalation before
its effective ledger.

| Event Name         | Topics                                  | Data | When Emitted |
| ------------------ | --------------------------------------- | ---- | ------------ |
| `rfnd_force_cncl`  | `["rfnd_force_cncl", refund_id, admin]` | `()` | When an admin calls `cancel_force_refund` |

---

## Escrow Contract Events

## 19. `job_creat`

**Description**: Emitted when a client creates and funds an escrow job.

| Event Name  | Topics                     | Data                                           | When Emitted                     |
| ----------- | -------------------------- | ---------------------------------------------- | -------------------------------- |
| `job_creat` | `["job_creat", client]`    | `(job_id: String, freelancer: Address, amount: i128)` | When client calls `create_job` |

---

## 20. `ms_rel`

**Description**: Emitted when a client releases funds for a specific milestone.

| Event Name | Topics                  | Data                                                        | When Emitted                            |
| ---------- | ----------------------- | ----------------------------------------------------------- | --------------------------------------- |
| `ms_rel`   | `["ms_rel", client]`    | `(job_id: String, milestone_index: u32, release_amount: i128)` | When client calls `release_milestone`   |

---

## 21. `ms_claim`

**Description**: Emitted when a freelancer claims a released milestone after the release period.

| Event Name | Topics                     | Data                                                        | When Emitted                            |
| ---------- | -------------------------- | ----------------------------------------------------------- | --------------------------------------- |
| `ms_claim` | `["ms_claim", freelancer]` | `(job_id: String, milestone_index: u32, release_amount: i128)` | When freelancer calls `claim_milestone` |

---

## 22. `ms_disp`

**Description**: Emitted when an admin disputes a single milestone on a job.

| Event Name | Topics                 | Data                                      | When Emitted                            |
| ---------- | ---------------------- | ----------------------------------------- | --------------------------------------- |
| `ms_disp`  | `["ms_disp", admin]`   | `(job_id: String, milestone_index: u32)`  | When admin calls `dispute_milestone`    |

---

## 23. `ms_reslv`

**Description**: Emitted when an admin resolves a single milestone dispute.

| Event Name | Topics                 | Data                                                           | When Emitted                                   |
| ---------- | ---------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| `ms_reslv` | `["ms_reslv", admin]`  | `(job_id: String, milestone_index: u32, approve: bool)`       | When admin calls `resolve_milestone_dispute`   |

---

## 24. `job_refnd`

**Description**: Emitted when a client claims an auto-refund for an expired job with no claimed milestones.

| Event Name  | Topics                     | Data                                    | When Emitted                             |
| ----------- | -------------------------- | --------------------------------------- | ---------------------------------------- |
| `job_refnd` | `["job_refnd", client]`    | `(job_id: String, refund_amount: i128)` | When client calls `refund_expired_job`   |

---

## 25. `job_disp` (deprecated)

**Description**: Emitted when an admin disputes an entire job.

| Event Name | Topics                 | Data               | When Emitted                        |
| ---------- | ---------------------- | ------------------ | ----------------------------------- |
| `job_disp` | `["job_disp", admin]`  | `job_id: String`   | When admin calls `dispute_job`      |

---

## 26. `job_reslv` (deprecated)

**Description**: Emitted when an admin resolves an entire job dispute.

| Event Name  | Topics                 | Data                                        | When Emitted                        |
| ----------- | ---------------------- | ------------------------------------------- | ----------------------------------- |
| `job_reslv` | `["job_reslv", admin]` | `(job_id: String, approve_remaining: bool)` | When admin calls `resolve_dispute`  |

---

## 9. `sub_new` (recurring donation subscription created)

**Description**: Emitted by `create_subscription` (#81). Named `sub_new` rather than the
`sub_created` used in the issue spec because `symbol_short!` topics are capped at 9
characters — same convention as `prop_new` / `prop_veto` elsewhere in this contract.

| Event Name | Topics                  | Data                                                                  | When Emitted                    |
| ---------- | ------------------------ | ---------------------------------------------------------------------- | -------------------------------- |
| `sub_new`  | `["sub_new", donor]`     | `{ "project_id": String, "amount": i128, "interval_ledgers": u32, "next_execution": u32 }` | After a subscription is created or re-created |

## 10. `sub_canc` (recurring donation subscription cancelled)

**Description**: Emitted by `cancel_subscription` (#81). Shortened from `sub_cancelled`
for the same `symbol_short!` 9-character limit.

| Event Name | Topics                 | Data                    | When Emitted                  |
| ---------- | ------------------------ | ------------------------ | ------------------------------ |
| `sub_canc` | `["sub_canc", donor]`   | `{ "project_id": String }` | After a subscription is cancelled |

## 11. `sub_exec` (recurring donation subscription executed)

**Description**: Emitted by `execute_subscription` (#81) after it delegates to `donate`
and advances `next_execution`. Shortened from `sub_executed`.

| Event Name | Topics                 | Data                                                        | When Emitted                          |
| ---------- | ------------------------ | -------------------------------------------------------------- | --------------------------------------- |
| `sub_exec` | `["sub_exec", donor]`   | `{ "project_id": String, "amount": i128, "next_execution": u32 }` | After a due subscription donation executes |
## 27. `rec_cr` (Recurring Created)

**Description**: Emitted when a donor registers a new recurring donation schedule.

| Event Name | Topics                           | Data                                                                                                    | When Emitted                              |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `rec_cr`   | `["rec_cr", donor, project_id]`  | `(recurring_id: u32, amount: i128, currency: Symbol, interval_ledgers: u32, keeper_incentive: i128, msg_hash: u32)` | When a donor registers a recurring schedule |

---

## 28. `rec_can` (Recurring Cancelled)

**Description**: Emitted when a donor cancels an active recurring donation schedule.

| Event Name | Topics                 | Data                 | When Emitted                                |
| ---------- | ---------------------- | -------------------- | ------------------------------------------- |
| `rec_can`  | `["rec_can", donor]`   | `(recurring_id: u32)` | When a donor cancels a recurring schedule   |

---

## 29. `rec_exec` (Recurring Executed)

**Description**: Emitted when a keeper successfully executes a matured recurring donation schedule.

| Event Name | Topics                      | Data                                                                           | When Emitted                                  |
| ---------- | --------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| `rec_exec` | `["rec_exec", keeper, donor]`| `(recurring_id: u32, amount: i128, currency: Symbol, project_id: String)`      | When a keeper executes a recurring donation   |

## 30. `vest_crt` (Vesting Created)

**Description**: Emitted when a donor creates a time-locked vesting donation schedule.

| Event Name | Topics                           | Data                                                                                                    | When Emitted                   |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `vest_crt` | `["vest_crt", donor, project_id]` | `(schedule_id: u32, total_amount: i128, amount_per_installment: i128, installment_count: u32, interval_ledgers: u32, msg_hash: u32)` | When donor calls `donate_vested` |

---

## 31. `vest_clm` (Vesting Claimed)

**Description**: Emitted when a vested installment is claimed by anyone after the interval elapses.

| Event Name | Topics                    | Data                                                     | When Emitted                          |
| ---------- | ------------------------- | -------------------------------------------------------- | ------------------------------------- |
| `vest_clm` | `["vest_clm", project_id]` | `(schedule_id: u32, amount: i128, remaining: u32)`       | When `claim_vested_installment` fires |

---

## 32. `vest_can` (Vesting Cancelled)

**Description**: Emitted when a donor cancels a vesting schedule and receives back the unvested amount.

| Event Name | Topics                            | Data                                      | When Emitted                    |
| ---------- | --------------------------------- | ----------------------------------------- | ------------------------------- |
| `vest_can` | `["vest_can", donor, project_id]` | `(schedule_id: u32, unvested_amount: i128)` | When donor calls `cancel_vesting` |

---

## Off-Chain Multi-Verifier Project Verification Oracle

Gated behind the `project_verification` Cargo feature (on by default). An M-of-N
committee of admin-appointed verifiers attests that a project has passed
independent off-chain due diligence; once enough distinct verifiers have
attested, the project auto-transitions to `Verified` and every `donate*` entry
point starts accepting donations to it. See `SECURITY.md` for the full trust
model.

## 33. `ver_add` (Verifier Added)

**Description**: Emitted when M-of-N admins authorise a new address to submit project attestations.

| Event Name | Topics          | Data                | When Emitted                    |
| ---------- | --------------- | -------------------- | -------------------------------- |
| `ver_add`  | `["ver_add"]`   | `verifier: Address`  | When admins call `add_verifier` |

---

## 34. `ver_rem` (Verifier Removed)

**Description**: Emitted when M-of-N admins revoke a verifier's ability to submit new attestations. Attestations it already submitted are not affected.

| Event Name | Topics          | Data                | When Emitted                       |
| ---------- | --------------- | -------------------- | ------------------------------------ |
| `ver_rem`  | `["ver_rem"]`   | `verifier: Address`  | When admins call `remove_verifier` |

---

## 35. `ver_thr` (Verification Threshold Updated)

**Description**: Emitted when M-of-N admins change the number of distinct verifier attestations required for a project to auto-verify. `0` disables the gate (legacy mode).

| Event Name | Topics          | Data              | When Emitted                                   |
| ---------- | --------------- | ------------------ | ------------------------------------------------ |
| `ver_thr`  | `["ver_thr"]`   | `threshold: u32`   | When admins call `set_verification_threshold` |

---

## 36. `proj_att` (Project Attestation Recorded)

**Description**: Emitted when an authorised verifier attests a project. Fired once per (project, verifier) pair — a second attestation from the same verifier for the same project panics instead of re-emitting this event.

| Event Name | Topics                                | Data                                             | When Emitted                       |
| ---------- | -------------------------------------- | -------------------------------------------------- | ------------------------------------ |
| `proj_att` | `["proj_att", verifier, project_id]`   | `(attestation_count: u32, evidence_hash: BytesN<32>)` | When a verifier calls `attest_project` |

---

## 37. `proj_vfy` (Project Verified)

**Description**: Emitted the moment a project's distinct-attester count reaches `VerificationThreshold`, in the same invocation as the attestation (or donation) that crossed it. Fires at most once per verification cycle — a `revoke_verification` followed by re-attesting to the threshold fires it again.

| Event Name | Topics                     | Data                    | When Emitted                                          |
| ---------- | --------------------------- | ------------------------ | -------------------------------------------------------- |
| `proj_vfy` | `["proj_vfy", project_id]`  | `attestation_count: u32` | When a project's status transitions to `Verified`        |

---

## 38. `proj_rvk` (Project Verification Revoked)

**Description**: Emitted when M-of-N admins clear a project's entire verification state — all accumulated attestations and evidence hashes are removed and the project reverts to `Unverified`.

| Event Name | Topics                          | Data              | When Emitted                                |
| ---------- | --------------------------------- | ------------------ | ---------------------------------------------- |
| `proj_rvk` | `["proj_rvk", admin]`            | `project_id: String` | When admins call `revoke_verification`      |

---

## 39. `tok_reg` (Token Registered)

**Description**: Emitted when an admin registers a new token and its oracle into the dynamic token registry.

| Event Name | Topics                 | Data                             | When Emitted                     |
| ---------- | ---------------------- | -------------------------------- | -------------------------------- |
| `tok_reg`  | `["tok_reg", admin]`   | `(token: Address, symbol: Symbol)` | When admin calls `register_token` |

---

## 40. `tok_rem` (Token Removed)

**Description**: Emitted when an admin removes a token from active registration in the dynamic token registry.

| Event Name | Topics                 | Data               | When Emitted                   |
| ---------- | ---------------------- | ------------------ | ------------------------------ |
| `tok_rem`  | `["tok_rem", admin]`   | `token: Address`   | When admin calls `remove_token` |

---

## 51. `rcpt_gen` (Donation Receipt Generated)

**Description**: Emitted when a donor generates a cryptographic receipt for one
of their donations. For **anonymous** donations the `donor` topic is the
zero-address placeholder (`GAAAAAAAA…WHF`) — not the real caller — so the
event log does not reveal who generated the receipt.

| Event Name | Topics                              | Data                                                          | When Emitted                               |
| ---------- | ----------------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| `rcpt_gen` | `["rcpt_gen", donor_or_zero_addr]`  | `(donation_index: u32, amount: i128, project_id: String, co2_offset: i128)` | When donor calls `generate_receipt` |

- `donor_or_zero_addr` is the real donor address for public donations and
  `GAAAAAAAA…WHF` for anonymous donations (fixes #707).
- The receipt carries a `contract_signature` field: `SHA-256` over the XDR
  encoding of all other receipt fields. Anyone can recompute it to verify
  authenticity without trusting the caller.
- For anonymous donations, ownership is proved via `DataKey::AnonymousCommitment(index)`
  at generation time; the emitted event and returned receipt expose no linkable identity.

---

## Usage Notes

- All events follow Soroban’s standard event format: `topics: Vec<Val>`, `data: Val`.
- `donor` and `project_id` are usually `Address` or `String` depending on implementation.
- Events can be queried via Horizon or Soroban RPC tools.
- Frontend / backend should listen to these for real-time updates, notifications, and leaderboard.

**Last Updated**: August 16, 2026

---

## 30. `slash_ev` (Oracle Slash Event)

**Description**: Emitted when an admin slashes a reporter in the oracle contract. Each event records the timestamp, admin who performed the slash, and a reason symbol.

| Event Name  | Topics                        | Data                                                                             | When Emitted                                        |
| ----------- | ----------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------- |
| `slash_ev`  | `["slash_ev", reporter]`      | `{ "at": u32, "slashed_by": Address, "reason": Symbol }`                        | When admin calls `slash_reporter` on SimpleOracle    |

**Note**: Slash history is bounded to the 20 most recent events per reporter. Older entries are evicted in ring-buffer order to prevent unbounded storage growth. Off-chain observers should capture `slash_ev` events in real time for complete history.

---

## Coordination Note for #277 (Matching Pool)

**Description**: Emitted when an admin appends a new period's Merkle root to a
project's Merkle Mountain Range for cumulative impact certificate verification.

| Event Name | Topics                                          | Data             | When Emitted                               |
| ---------- | ----------------------------------------------- | ---------------- | ------------------------------------------ |
| `mmr_app`  | `["mmr_app", admin, project_id, new_leaf_count]` | `new_root: BytesN<32>` | When admin calls `append_impact_root` |

---

## 43. `prop_cln` (Proposal Cleanup)

**Description**: Emitted when a resolved governance proposal and all associated
vote data are cleaned up after the 30-day grace period. Permissionless — anyone
may call `cleanup_proposal` once the grace period has elapsed.

| Event Name   | Topics                         | Data | When Emitted                             |
| ------------ | ------------------------------ | ---- | ---------------------------------------- |
| `prop_cln` | `["prop_cln", project_id]`   | `()` | After `cleanup_proposal` completes |

---

## 44. `vest_cln` (Vesting Schedule Cleanup)

**Description**: Emitted when a completed or cancelled vesting schedule is
removed from storage after the 30-day grace period. Permissionless — anyone may
call `cleanup_vesting_schedule` once the grace period has elapsed.

| Event Name   | Topics                                | Data | When Emitted                                  |
| ------------ | ------------------------------------- | ---- | --------------------------------------------- |
| `vest_cln` | `["vest_cln", donor, schedule_id]`  | `()` | After `cleanup_vesting_schedule` completes |

---

## 45. `recip_set` (Platform Fee Recipients Set)

**Description**: Emitted when M-of-N admins configure or update multi-recipient platform fee splits.

| Event Name  | Topics                 | Data                   | When Emitted                              |
| ----------- | ---------------------- | ---------------------- | ----------------------------------------- |
| `recip_set` | `["recip_set", admin]` | `recipient_count: u32` | When admin calls `set_platform_fee_recipients` |

---

# Campaign-to-Escrow Integration Events (#426)

Gated behind the `escrow` Cargo feature (opt-in). Bridges the indigopay-contract
campaign system with the escrow-contract to enable milestone-based fund release
for climate projects.

## 43. `esc_set` (Escrow Contract Address Set)

**Description**: Emitted when M-of-N admins configure the escrow contract address
for campaign escrow integration.

| Event Name | Topics          | Data                   | When Emitted                                     |
| ---------- | --------------- | ---------------------- | ------------------------------------------------ |
| `esc_set`  | `["esc_set"]`   | `escrow_contract: Address` | When admins call `set_escrow_contract_address` |

---

## 44. `camp_es` (Campaign with Escrow Created)

**Description**: Emitted when an admin creates a campaign with milestone-based
escrow for a project. The escrow job is not created yet — it is funded later
via `fund_campaign_escrow_job` once donations accumulate.

| Event Name | Topics                                 | Data                          | When Emitted                               |
| ---------- | -------------------------------------- | ----------------------------- | ------------------------------------------ |
| `camp_es`  | `["camp_es", admin, project_id]`       | `(goal: i128, deadline_ledger: u32)` | When admin calls `create_campaign_with_escrow` |

---

## 45. `esc_fnd` (Campaign Escrow Job Funded)

**Description**: Emitted when an admin funds the escrow job for a campaign.
The accumulated contract-held donations are transferred to the escrow contract
and the escrow job is created with the project wallet as the freelancer.

| Event Name | Topics                              | Data                                        | When Emitted                            |
| ---------- | ----------------------------------- | ------------------------------------------- | --------------------------------------- |
| `esc_fnd`  | `["esc_fnd", admin, project_id]`    | `(job_id: String, total_raised: i128)`      | When admin calls `fund_campaign_escrow_job` |

---

## 46. `esc_rel` (Campaign Milestone Released)

**Description**: Emitted when an admin releases a milestone for an escrow campaign.
Proxies through to the escrow contract's `release_milestone`.

| Event Name | Topics                               | Data                       | When Emitted                                |
| ---------- | ------------------------------------ | -------------------------- | ------------------------------------------- |
| `esc_rel`  | `["esc_rel", admin, project_id]`     | `milestone_index: u32`     | When admin calls `release_campaign_milestone` |

---

## 47. `esc_clm` (Campaign Milestone Claimed)

**Description**: Emitted when a project wallet claims a released milestone for
an escrow campaign. Proxies through to the escrow contract's `claim_milestone`.

| Event Name | Topics                                | Data                       | When Emitted                               |
| ---------- | ------------------------------------- | -------------------------- | ------------------------------------------ |
| `esc_clm`  | `["esc_clm", project_wallet, project_id]` | `milestone_index: u32` | When project wallet calls `claim_campaign_milestone` |

---

## 48. `esc_dsp` (Campaign Milestone Disputed)

**Description**: Emitted when M-of-N admins dispute a milestone on an escrow
campaign. Proxies through to the escrow contract's `dispute_milestone`.

| Event Name | Topics                         | Data                       | When Emitted                                |
| ---------- | ------------------------------ | -------------------------- | ------------------------------------------- |
| `esc_dsp`  | `["esc_dsp", project_id]`      | `milestone_index: u32`     | When admins call `dispute_campaign_milestone` |

---

## 49. `esc_rsv` (Campaign Milestone Dispute Resolved)

**Description**: Emitted when M-of-N admins resolve a milestone dispute on an
escrow campaign. Proxies through to the escrow contract's
`resolve_milestone_dispute`.

| Event Name | Topics                         | Data                                    | When Emitted                                          |
| ---------- | ------------------------------ | --------------------------------------- | ----------------------------------------------------- |
| `esc_rsv`  | `["esc_rsv", project_id]`      | `(milestone_index: u32, approve: bool)` | When admins call `resolve_campaign_ms_dispute` |

---

## 50. `att_settle` (Cross-Chain Attestation Settled)

**Description**: Emitted when a verified cross-chain donation attestation is
settled into the main contract's donation stats via `settle_attestation`. One
event per attestation id — a second settlement of the same id panics with
`"Attestation already settled"`, so this event never repeats.

| Event Name   | Topics                                    | Data                                                                    | When Emitted                                     |
| ------------ | ----------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| `att_settle` | `["att_settle", donor, project_id]`       | `(attestation_id: u64, amount_xlm: i128, co2_grams: i128, donation_index: u32)` | When anyone calls `settle_attestation` on a `Verified` attestation |

- `donor` and `project_id` come from the attestation record, not the caller —
  `settle_attestation` is permissionless.
- `amount_xlm` is the attested XLM value in stroops. It is credited to the
  project's `total_raised`, the donor's `total_donated`, and
  `GlobalTotalRaised`.
- `co2_grams` is `amount_xlm / STROOP * project.co2_per_xlm`, the same formula
  the native donation path uses.
- `donation_index` is the index of the `DonationRecord` the settlement created.
  That record carries the `XCHAIN` currency symbol, so indexers can separate
  bridged donations from Stellar-native ones.

A settlement also emits the events the shared donation path emits: `nft_mint`
when the donor crosses into a new badge tier, and `camp_goal` when the
credited amount takes a campaign over its goal. It emits **no** `donated`
event — no tokens moved on Stellar.

---

## Usage Notes

- All events follow Soroban's standard event format: `topics: Vec<Val>`, `data: Val`.
- `donor` and `project_id` are usually `Address` or `String` depending on implementation.
- Events can be queried via Horizon or Soroban RPC tools.
- Frontend / backend should listen to these for real-time updates, notifications, and leaderboard.

**Last Updated**: August 16, 2026