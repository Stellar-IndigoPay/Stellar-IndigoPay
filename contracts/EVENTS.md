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

| Event Name | Topics                | Data               | When Emitted              |
| ---------- | --------------------- | ------------------ | ------------------------- |
| `nft_mint` | `["nft_mint", donor]` | `ImpactNFT` struct | On new badge tier reached |

### `ImpactNFT` Struct Format:
- `owner`: `Address` (owner of the NFT)
- `tier`: `BadgeTier` (`None`, `Seedling`, `Tree`, `Forest`, `EarthGuardian`)
- `total_donated`: `i128` (total donated in stroops)
- `minted_at_ledger`: `u32` (ledger sequence when minted)
- `badge_name`: `String` (human-readable badge tier name with emoji)
- `projects_supported`: `Vec<String>` (list of supported project IDs)
- `co2_by_project`: `Vec<(String, i128)>` (vector of tuples with `(project_id, co2_grams)`)
- `first_donation_at`: `u32` (earliest donation ledger sequence)
- `donation_count`: `u32` (total number of donations by the donor)

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

| Event Name             | Topics                     | Data                   | When Emitted                  |
| ---------------------- | -------------------------- | ---------------------- | ----------------------------- |
| `contract_initialized` | `["contract_initialized"]` | `{ "admin": Address }` | On contract deployment / init |

---

## 9. `rate_lim`

**Description**: Emitted when the admin updates the per-donor per-project donation rate limit.

| Event Name | Topics        | Data                                      | When Emitted                          |
| ---------- | ------------- | ----------------------------------------- | ------------------------------------- |
| `rate_lim` | `["rate_lim"]` | `{ "max_donations": u32, "window_ledgers": u32 }` | When admin calls `set_donation_rate_limit` |

---

## Usage Notes

- All events follow Soroban’s standard event format: `topics: Vec<Val>`, `data: Val`.
- `donor` and `project_id` are usually `Address` or `String` depending on implementation.
- Events can be queried via Horizon or Soroban RPC tools.
- Frontend / backend should listen to these for real-time updates, notifications, and leaderboard.

**Last Updated**: June 30, 2026
