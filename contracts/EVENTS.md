# Soroban Contract Events

This document lists all events emitted by the Stellar IndigoPay Soroban smart contracts.

## Event Schema Format

| Event Name | Topics | Data | When Emitted |
| ---------- | ------ | ---- | ------------ |

---

## 1. `donated`

**Description**: Emitted after a successful XLM donation to a project.

| Event Name | Topics                           | Data                                                     | When Emitted                  |
| ---------- | -------------------------------- | -------------------------------------------------------- | ----------------------------- |
| `donated`  | `["donated", donor, project_id]` | `{ "amount": u128, "badge": String, "msg_hash": Bytes }` | After successful XLM donation |

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
| `ew_cncl`  | `["ew_cncl", admin, project_id]`   | `()` | When admin calls `cancel_emergency_withdrawal` |

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

## Usage Notes

- All events follow Soroban’s standard event format: `topics: Vec<Val>`, `data: Val`.
- `donor` and `project_id` are usually `Address` or `String` depending on implementation.
- Events can be queried via Horizon or Soroban RPC tools.
- Frontend / backend should listen to these for real-time updates, notifications, and leaderboard.

**Last Updated**: July 19, 2026

---

## Coordination Note for #277 (Matching Pool)

`DataKey::ProjectContractBalance(String, Address)` is the **canonical per-project per-token balance ledger** for all contract-held funds. Any deposit/matching-pool logic (including #277) **must** increment this key on deposit and decrement it on withdrawal. Do not introduce a parallel balance concept — the compound key already supports multi-token per project. See `SECURITY.md` for the full rationale.

