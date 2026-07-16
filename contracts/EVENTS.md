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

| Event Type          | Topics           | Data | When Emitted            |
| ------------------- | ---------------- | ---- | ----------------------- |
| `UpgradeCancelled`  | `admin: Address` | —    | On upgrade cancellation |

---

## Usage Notes

- All events use the `#[contractevent]` pattern (Soroban SDK 27+). The struct name becomes the first topic, `#[topic]` fields become indexed topics, and remaining fields form the data payload.
- Events can be queried via Horizon or Soroban RPC tools.
- Frontend / backend should listen to these for real-time updates, notifications, and leaderboard.

**Last Updated**: July 16, 2026
