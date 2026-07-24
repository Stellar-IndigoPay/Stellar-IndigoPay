## Summary

Closes #467 — Donation Batching with Atomic Multi-Project Distribution

Implements an atomic batch donation feature for the IndigoPay Soroban contract. Donors can distribute a single token across multiple climate projects in one Soroban invocation. If any donation in the batch fails (validation, auth, rate limit), the entire batch reverts atomically.

---

## What This PR Adds

### Contract (`contracts/indigopay-contract/src/lib.rs`)

**New constant:**
- `MAX_BATCH_SIZE = 20` — caps the number of individual donations per batch invocation

**Implementation — `batch_donate(token, donations)`:**

| Phase | Description |
|-------|-------------|
| **1. Auth** | Authenticates all unique donors via `require_auth()` as they are encountered |
| **2. Execution** | Calls existing `process_donation()` for each donation, which performs validation, state writes, and token transfers following the CEI (Checks-Effects-Interactions) pattern |

**Key design decisions:**
- Reuses existing `process_donation()` logic — no duplicate validation or state management
- Per-donation validation (amount > 0, project active, rate limits) is handled by `process_donation`
- Atomicity: if any `process_donation` call panics, the entire transaction reverts via Soroban's built-in revert mechanism
- Individual `donated` events are emitted per project (via `process_donation`)

### Tests (`contracts/indigopay-contract/src/lib.rs` — unit tests)

| Test | Description |
|------|-------------|
| `test_batch_donate_basic_flow` | Basic batch with 2 donations, verifies amounts and donor counts |
| `test_batch_donate_multiple_entries` | Multiple donations to same project |
| `test_batch_donate_multiple_donors` | Multiple donors in a single batch |
| `test_batch_donate_zero_amount_fails` | Zero-amount donation panics |
| `test_batch_donate_updates_global_stats` | Global stats (total_raised, donation_count) are updated correctly |
| `test_batch_donate_nft_minting_on_badge_upgrade` | Badge tier NFTs are minted on badge upgrade within batch |
| `test_batch_donate_respects_unique_donor_count` | Unique donor counting works across batch |
| `test_batch_donate_knows` | Smoke test for batch functionality |

### Fuzz Tests (`contracts/indigopay-contract/src/fuzz_tests.rs`)

| Test | Property |
|------|----------|
| `prop_batch_sum_conservation` | Global total raised equals sum of all batch amounts |
| `prop_batch_atomicity` | Both projects in a 2-project batch receive correct amounts atomically |

### Documentation

- **`CHANGELOG.md`** — Added entry under `[Unreleased] > Features`

---

## Files Changed

| File | Change |
|------|--------|
| `contracts/indigopay-contract/src/lib.rs` | +MAX_BATCH_SIZE constant, `batch_donate` implementation, 8 unit tests |
| `contracts/indigopay-contract/src/fuzz_tests.rs` | 2 new property-based fuzz tests |
| `CHANGELOG.md` | +Feature entry under [Unreleased] |

---

## Deliverables Checklist

- [x] `batch_donate` function with atomic batch processing
- [x] `BatchDonation` type (pre-existing, no changes needed)
- [x] Batch size limit (`MAX_BATCH_SIZE = 20`)
- [x] Atomicity: entire batch reverts on any validation failure
- [x] Unit tests covering acceptance criteria
- [x] Property-based fuzz tests for sum conservation and atomicity
- [x] CHANGELOG.md updated
- [x] No secrets in diff
