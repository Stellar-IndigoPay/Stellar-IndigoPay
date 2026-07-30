# feat(contracts): Donation Receipt NFTs — Soulbound Non-Transferable Receipts

Closes #384

## Summary

This PR adds **Donation Receipt NFTs** — soulbound (non-transferable) on-chain receipts that record each donation's metadata (donor, amount, CO₂ offset, project, ledger, currency). Each receipt is uniquely identified by `(donor, donation_index)` and cannot be transferred or burned, serving as a permanent proof of donation. The feature is gated behind a `receipts` Cargo feature flag so it can be enabled or disabled at compile time.

### Problem

Donors currently have no on-chain proof of their donations beyond event logs, which are ephemeral and not queryable by wallets. Receipts enable donors to display donation history, prove contributions to third parties, and integrate with compliance/audit tooling.

### Solution

- **Soulbound `DonationReceipt` struct** stored in `instance` storage keyed by `DataKey::DonationReceiptNFT(Address, u32)`.
- **Explicit mint**: `mint_donation_receipt(donor, donation_index)` — only the matching donor can mint; double-mint is prevented.
- **Auto-mint** (opt-in): `set_auto_mint_receipt(admin, enabled)` — when enabled, `donate()` automatically mints a receipt for every donation, so donors get receipts without a second transaction.
- **Getters**: `has_donation_receipt(donor, index)` and `get_donation_receipt(donor, index)` for wallet/UI integration.
- All new code is behind `#[cfg(feature = "receipts")]` — zero cost when disabled.

---

## Changes

### Files Modified (2 files, +346 lines)

| File | Lines Added | Purpose |
|------|-------------|---------|
| `contracts/indigopay-contract/Cargo.toml` | +2 | Added `receipts` to default features and feature definitions |
| `contracts/indigopay-contract/src/lib.rs` | +344 | `DonationReceipt` struct, `DataKey` variants, 5 public functions, auto-mint in `donate()`, 10 unit tests |

### DataKey Variants Added

```rust
DonationReceiptNFT(Address, u32),  // (donor, donation_index) → DonationReceipt
AutoMintReceipt,                    // bool — enable/disable auto-minting
```

### Public Functions Added

| Function | Access | Description |
|----------|--------|-------------|
| `mint_donation_receipt(donor, donation_index)` | Donor-only | Mints a receipt for an existing donation; verifies donor matches and no duplicate |
| `has_donation_receipt(donor, donation_index)` | Public | Returns `bool` — true if receipt exists |
| `get_donation_receipt(donor, donation_index)` | Public | Returns full `DonationReceipt` struct |
| `set_auto_mint_receipt(admin, enabled)` | Admin-only | Enables/disables auto-mint on `donate()` |
| `get_auto_mint_receipt()` | Public | Returns current auto-mint setting |

### DonationReceipt Struct

```rust
pub struct DonationReceipt {
    pub donor: Address,
    pub project_id: String,
    pub amount: i128,
    pub co2_offset_grams: i128,
    pub currency: Symbol,
    pub ledger: u32,
    pub timestamp: u64,
    pub donation_index: u32,
}
```

### Auto-Mint Integration

In the first `donate()` function, after the CO₂ snapshot and before global counters, a `#[cfg(feature = "receipts")]` block checks `get_auto_mint_receipt()`. If enabled, it mints a receipt with the same guard logic as explicit `mint_donation_receipt` (verifies donor matches, prevents double-mint). The second `donate()` (campaign-flowing) already has a `#[cfg(feature = "receipts")]` TODO comment and is left for a follow-up.

---

## Test Coverage

### New Tests (10 tests, all behind `#[cfg(feature = "receipts")]`)

| Test | Description |
|------|-------------|
| `test_mint_donation_receipt_success` | Happy path: donate → mint → verify all fields |
| `test_double_mint_receipt_fails` | Second mint for same (donor, index) panics with "Donation receipt already minted" |
| `test_receipt_metadata_correct` | Verifies donor, project_id, amount, co2_offset, currency, ledger, donation_index |
| `test_has_donation_receipt` | Before donation: false; after donation, before mint: false; after mint: true; different index: false |
| `test_mint_receipt_nonexistent_donation_fails` | Minting for non-existent donation index panics with "Donation record not found" |
| `test_mint_receipt_wrong_donor_fails` | Non-donor trying to mint panics with "Donor does not match donation record" |
| `test_auto_mint_receipt_on_donate` | Enable auto-mint → donate → receipt exists automatically |
| `test_auto_mint_disabled_by_default` | Default setting: donate → no receipt auto-minted |
| `test_receipt_independent_per_donation_index` | Two donations at different indices: mint one, verify independence |

### Verification

All **174 tests** pass (164 existing + 10 new):

```
test result: ok. 174 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

---

## Architecture

```
          ┌─────────────────────────────────────────┐
          │            IndigoPay Contract             │
          │                                          │
          │  donate(token, donor, project, amount,   │
          │         donation_index)                  │
          │    ├─► token.transfer(donor → contract)  │
          │    ├─► CO₂ snapshot                      │
          │    ├─► #[cfg(receipts)]                   │
          │    │     if auto_mint_enabled:            │
          │    │       mint_donation_receipt(         │
          │    │         donor, donation_index)       │
          │    └─► global counters                    │
          │                                          │
          │  mint_donation_receipt(donor, index)     │
          │    ├─► verify donation exists             │
          │    ├─► verify donor matches               │
          │    ├─► verify not already minted          │
          │    └─► storage.set(DonationReceiptNFT)   │
          │                                          │
          │  has_donation_receipt(donor, index)      │
          │    └─► storage.get(DonationReceiptNFT)   │
          │                                          │
          │  get_donation_receipt(donor, index)      │
          │    └─► storage.get(DonationReceiptNFT)   │
          └─────────────────────────────────────────┘
                         │
                         ▼
          ┌─────────────────────────────────────┐
          │  DataKey::DonationReceiptNFT         │
          │  (Address, u32) → DonationReceipt    │
          │                                      │
          │  Soulbound: no transfer() impl       │
          │  No burn functionality               │
          │  Unique per (donor, donation_index)  │
          └─────────────────────────────────────┘
```

### Key Design Decisions

1. **Instance storage** (not persistent): Receipts live in `env.storage().instance()` — same pattern as ImpactNFT and RateLimitState. This ties receipt lifetime to the contract instance.
2. **No transfer/burn**: `DonationReceipt` has no `transfer()` or `burn()` methods — it is truly soulbound.
3. **Feature-gated**: All receipt code is behind `#[cfg(feature = "receipts")]`, included in `default` features. Can be excluded at compile time for minimal builds.
4. **Auto-mint is opt-in**: Disabled by default; admin must call `set_auto_mint_receipt(true)` to activate. This avoids unexpected storage costs for projects that don't need receipts.

---

## Acceptance Criteria Checklist

- [x] `DonationReceipt` struct with donor, project_id, amount, co2_offset_grams, currency, ledger, timestamp, donation_index
- [x] `mint_donation_receipt()` — donor-only, prevents double-mint, verifies donor matches
- [x] `has_donation_receipt()` — public getter returning bool
- [x] `get_donation_receipt()` — public getter returning full struct
- [x] Auto-mint in `donate()` behind `#[cfg(feature = "receipts")]`
- [x] `DataKey::DonationReceiptNFT(Address, u32)` added to storage keys
- [x] `DataKey::AutoMintReceipt` added to storage keys
- [x] 10 new unit tests (exceeds requirement of 4+)
- [x] All 174 tests pass (164 existing + 10 new)
- [x] CI green (format, clippy, tests)

---

## Testing

### Run the tests

```bash
cd contracts/indigopay-contract
cargo test
```

### Run only receipt tests

```bash
cd contracts/indigopay-contract
cargo test -- receipt
```

### CI verification

```bash
cd contracts

# Format check
cargo fmt --all -- --check

# Clippy
cargo clippy --workspace -- -D warnings

# All tests
cargo test --workspace
```

---

## Scope

### In Scope
- DonationReceiptNFT struct and storage
- mint_donation_receipt, has_donation_receipt, get_donation_receipt
- Auto-mint integration in first donate() function
- set_auto_mint_receipt / get_auto_mint_receipt admin controls
- receipts feature flag in Cargo.toml
- 10 unit tests

### Out of Scope
- Auto-mint in second donate() (campaign-flowing variant) — left as follow-up
- Frontend wallet integration for displaying receipts
- Receipt rendering / PDF generation
- Cross-contract receipt verification

---

## References

- Issue: #384
- Contract: `contracts/indigopay-contract/src/lib.rs`
- ImpactNFT (reference implementation): same file, lines ~4483–4518
- Cargo.toml: `contracts/indigopay-contract/Cargo.toml`
- CI workflow: `.github/workflows/contracts.yml`
