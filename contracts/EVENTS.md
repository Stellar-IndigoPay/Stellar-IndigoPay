# Soroban Contract Events

This document lists all events emitted by the Stellar IndigoPay Soroban smart contracts.

Events use the `#[contractevent]` pattern (Soroban SDK 27+). The struct
name becomes the event type (first topic). Fields marked with `#[topic]`
are indexed and searchable by external consumers.

## Event Schema Format

| Event Type (struct) | Topics | Data Fields | When Emitted |
| ------------------- | ------ | ----------- | ------------ |

---

## 1. `Donated`

**Description**: Emitted after a successful XLM donation to a project.

| Event Type | Topics                   | Data                                                     | When Emitted                  |
| ---------- | ------------------------ | -------------------------------------------------------- | ----------------------------- |
| `Donated`  | `donor: Address`, `project_id: String` | `amount: i128`, `badge: BadgeTier`, `msg_hash: u32` | After successful donation |

---

## 2. `UsdcDonated`

**Description**: Emitted after a successful USDC donation. Uses the oracle rate to record XLM-equivalent stats while preserving the original USDC amount in the event.

| Event Type     | Topics                   | Data                                                                | When Emitted                   |
| -------------- | ------------------------ | ------------------------------------------------------------------- | ------------------------------ |
| `UsdcDonated`  | `donor: Address`, `project_id: String` | `usdc_amount: i128`, `currency: Symbol`, `msg_hash: u32` | After successful USDC donation |

---

## 3. `NftMinted`

**Description**: Emitted when a donor reaches a new badge tier and receives an Impact NFT.

| Event Type  | Topics            | Data                        | When Emitted              |
| ----------- | ----------------- | --------------------------- | ------------------------- |
| `NftMinted` | `donor: Address`  | `badge_tier: BadgeTier`     | On new badge tier reached |

---

## 4. `ProjectNftMinted`

**Description**: Emitted when a project milestone NFT is minted (cumulative donation to a single project exceeds 100 XLM).

| Event Type          | Topics            | Data                                            | When Emitted                |
| ------------------- | ----------------- | ----------------------------------------------- | --------------------------- |
| `ProjectNftMinted`  | `donor: Address`  | `project_id: String`, `amount_donated: i128`    | On project milestone reached |

---

## 5. `ProjectRegistered`

**Description**: Emitted when a new climate project is registered.

| Event Type           | Topics           | Data                    | When Emitted                   |
| -------------------- | ---------------- | ----------------------- | ------------------------------ |
| `ProjectRegistered`  | `admin: Address` | `project_id: String`    | When a new project is approved |

---

## 6. `DeactivateAll`

**Description**: Emitted when the admin bulk-deactivates all projects.

| Event Type      | Topics           | Data                           | When Emitted          |
| --------------- | ---------------- | ------------------------------ | --------------------- |
| `DeactivateAll` | `admin: Address` | `project_ids: Vec<String>`     | On bulk deactivation  |

---

## 7. `CO2RateUpdated`

**Description**: Emitted when the admin updates a project's CO2-per-XLM rate.

| Event Type       | Topics           | Data                                 | When Emitted            |
| ---------------- | ---------------- | ------------------------------------ | ----------------------- |
| `CO2RateUpdated` | `admin: Address` | `project_id: String`, `co2_per_xlm: u32` | On CO2 rate update  |

---

## 8. `ProjectPaused`

**Description**: Emitted when the admin temporarily pauses a project.

| Event Type       | Topics           | Data                    | When Emitted           |
| ---------------- | ---------------- | ----------------------- | ---------------------- |
| `ProjectPaused`  | `admin: Address` | `project_id: String`    | On project pause       |

---

## 9. `ProjectResumed`

**Description**: Emitted when the admin resumes a paused project.

| Event Type        | Topics           | Data                    | When Emitted            |
| ----------------- | ---------------- | ----------------------- | ----------------------- |
| `ProjectResumed`  | `admin: Address` | `project_id: String`    | On project resume       |

---

## 10. `ProposalCreated`

**Description**: Emitted when the admin creates a governance proposal.

| Event Type         | Topics           | Data                                    | When Emitted               |
| ------------------ | ---------------- | --------------------------------------- | -------------------------- |
| `ProposalCreated`  | `admin: Address` | `project_id: String`, `voting_window: u32` | On proposal creation    |

---

## 11. `Voted`

**Description**: Emitted when a badge holder casts a vote on a proposal.

| Event Type | Topics                        | Data           | When Emitted      |
| ---------- | ----------------------------- | -------------- | ----------------- |
| `Voted`    | `voter: Address`, `project_id: String` | `approve: bool` | On vote cast  |

---

## 12. `ProposalVerified`

**Description**: Emitted when a proposal is resolved with majority approval.

| Event Type          | Topics | Data                    | When Emitted           |
| ------------------- | ------ | ----------------------- | ---------------------- |
| `ProposalVerified`  | —      | `project_id: String`    | On proposal approval   |

---

## 13. `ProposalRejected`

**Description**: Emitted when a proposal is resolved with majority rejection.

| Event Type          | Topics | Data                    | When Emitted           |
| ------------------- | ------ | ----------------------- | ---------------------- |
| `ProposalRejected`  | —      | `project_id: String`    | On proposal rejection  |

---

## 14. `ProposalVetoed`

**Description**: Emitted when the admin vetoes a proposal.

| Event Type        | Topics           | Data                    | When Emitted        |
| ----------------- | ---------------- | ----------------------- | ------------------- |
| `ProposalVetoed`  | `admin: Address` | `project_id: String`    | On admin veto       |

---

## 15. `UsdcTokenSet`

**Description**: Emitted when the admin configures the USDC token address.

| Event Type     | Topics | Data                    | When Emitted           |
| -------------- | ------ | ----------------------- | ---------------------- |
| `UsdcTokenSet` | —      | `usdc_token: Address`   | On USDC token config   |

---

## 16. `OracleSet`

**Description**: Emitted when the admin configures the price oracle address.

| Event Type  | Topics | Data              | When Emitted          |
| ----------- | ------ | ----------------- | --------------------- |
| `OracleSet` | —      | `oracle: Address` | On oracle config      |

---

## 17. `AdminTransferInitiated`

**Description**: Emitted when the admin initiates a two-step admin transfer.

| Event Type                | Topics           | Data                    | When Emitted            |
| ------------------------- | ---------------- | ----------------------- | ----------------------- |
| `AdminTransferInitiated`  | `admin: Address` | `new_admin: Address`    | On transfer initiation  |

---

## 18. `AdminAccepted`

**Description**: Emitted when the pending admin accepts the transfer.

| Event Type       | Topics | Data                   | When Emitted        |
| ---------------- | ------ | ---------------------- | ------------------- |
| `AdminAccepted`  | —      | `new_admin: Address`   | On admin acceptance |

---

## 19. `AdminTransferCancelled`

**Description**: Emitted when the admin cancels a pending transfer.

| Event Type                | Topics           | Data | When Emitted             |
| ------------------------- | ---------------- | ---- | ------------------------ |
| `AdminTransferCancelled`  | `admin: Address` | —    | On transfer cancellation |

---

## 20. `ContractPaused`

**Description**: Emitted when the admin pauses the entire contract.

| Event Type        | Topics           | Data | When Emitted         |
| ----------------- | ---------------- | ---- | -------------------- |
| `ContractPaused`  | `admin: Address` | —    | On contract pause    |

---

## 21. `ContractUnpaused`

**Description**: Emitted when the admin lifts a contract-level pause.

| Event Type         | Topics           | Data | When Emitted          |
| ------------------ | ---------------- | ---- | --------------------- |
| `ContractUnpaused` | `admin: Address` | —    | On contract unpause   |

---

## 22. `UpgradeProposed`

**Description**: Emitted when the admin proposes a contract upgrade.

| Event Type         | Topics           | Data                                         | When Emitted           |
| ------------------ | ---------------- | -------------------------------------------- | ---------------------- |
| `UpgradeProposed`  | `admin: Address` | `new_wasm_hash: BytesN<32>`, `effective_at: u32` | On upgrade proposal |

---

## 23. `UpgradeExecuted`

**Description**: Emitted when an upgrade is executed after the timelock.

| Event Type         | Topics | Data                      | When Emitted           |
| ------------------ | ------ | ------------------------- | ---------------------- |
| `UpgradeExecuted`  | —      | `wasm_hash: BytesN<32>`   | On upgrade execution   |

---

## 24. `UpgradeCancelled`

**Description**: Emitted when the admin cancels a pending upgrade.

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

## Usage Notes

- All events use the `#[contractevent]` pattern (Soroban SDK 27+). The struct name becomes the first topic, `#[topic]` fields become indexed topics, and remaining fields form the data payload.
- Events can be queried via Horizon or Soroban RPC tools.
- Frontend / backend should listen to these for real-time updates, notifications, and leaderboard.

**Last Updated**: July 18, 2026

---

## Coordination Note for #277 (Matching Pool)

`DataKey::ProjectContractBalance(String, Address)` is the **canonical per-project per-token balance ledger** for all contract-held funds. Any deposit/matching-pool logic (including #277) **must** increment this key on deposit and decrement it on withdrawal. Do not introduce a parallel balance concept — the compound key already supports multi-token per project. See `SECURITY.md` for the full rationale.
