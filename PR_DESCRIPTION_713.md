# Validate campaign escrow milestones at creation

Closes #713

## Summary

`create_campaign_with_escrow` previously checked only that milestone percentages summed to 100%. This allowed malformed milestone vectors to be stored in campaign state, even though the escrow contract rejects the same inputs during `create_job`.

This PR adds campaign-side validation for empty vectors, zero-percentage milestones, duplicate names, and oversized names before the campaign or milestone configuration is stored. It also adds regression tests for each invalid case and records the fix in `CHANGELOG.md`.

## Type

- [x] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactor
- [x] Smart contract change

## Related Issue

Closes #713

## Problem statement

The campaign-to-escrow integration created a validation gap:

1. `create_campaign_with_escrow` iterated over milestones only to calculate the percentage total.
2. Empty milestone vectors, zero percentages, duplicate names, and names longer than 64 bytes were accepted and persisted.
3. The later escrow `create_job` call applies these invariants, so malformed campaign configurations could fail later at funding time or be inconsistent with escrow expectations.

## Scope

### In scope

- `contracts/indigopay-contract/src/lib.rs`
  - Campaign escrow milestone validation.
  - `create_campaign_with_escrow` integration.
  - Regression tests using `#[should_panic]`.
- `CHANGELOG.md`

### Out of scope

- Changes to the escrow contract itself.
- Changes to milestone amendment or release behavior.
- Changes to campaign percentage semantics.

## Implementation

### Milestone validator

Added `validate_campaign_escrow_milestones`, enabled with the `escrow` feature. It applies the same invariants enforced by the escrow contract's `validate_milestones` helper:

- the vector must not be empty;
- every milestone percentage must be greater than zero;
- every name must be no longer than 64 bytes;
- milestone names must be unique.

Duplicate names are detected with an $O(n^2)$ comparison, matching the escrow contract's approach and avoiding additional storage allocation for the small milestone vectors.

### Validation order

`create_campaign_with_escrow` now runs the validator before calculating the percentage total. The existing checked sum and requirement that percentages equal 100% remain unchanged. Validation therefore occurs before the project state and `CampaignEscrowMilestones` storage are updated.

### Regression coverage

Added `#[should_panic]` tests for:

- an empty milestone vector;
- a zero-percentage milestone;
- duplicate milestone names;
- a milestone name exceeding 64 bytes;
- a milestone total that is not 100%.

The escrow-specific tests are feature-gated so the default non-escrow build remains compatible.

## Files changed

| File | Change |
|------|--------|
| `contracts/indigopay-contract/src/lib.rs` | Added campaign escrow milestone validation, wired it into campaign creation, and added regression tests. |
| `CHANGELOG.md` | Documented rejection of malformed campaign escrow milestones. |

## Testing

### Checks run

```bash
cd contracts
cargo fmt --all -- --check
```

Passed.

```bash
cd contracts/indigopay-contract
cargo test --features escrow test_create_campaign_with_escrow_ -- --nocapture
```

Not runnable in the current Windows environment because Rust's MSVC linker `link.exe` is unavailable. The installed GNU toolchain also has no MinGW linker available. The command fails during dependency build-script compilation before reaching the contract tests.

Additional validation:

- VS Code Rust error scan reports no errors for `contracts/indigopay-contract/src/lib.rs`.
- `git diff --check` passes.

## Acceptance criteria

- [x] Empty campaign escrow milestone vectors are rejected.
- [x] Zero-percentage milestones are rejected.
- [x] Duplicate milestone names are rejected.
- [x] Names longer than 64 bytes are rejected.
- [x] Milestone percentages must still sum to 100%.
- [x] Validation occurs before campaign escrow milestones are stored.
- [x] Regression tests use `#[should_panic]`.
- [x] `CHANGELOG.md` updated.
- [ ] Native contract test execution completed in an environment with a working linker.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Campaigns created with previously accepted malformed milestones may not be recoverable through the new path. | The fix applies at creation time and does not alter existing stored campaign data or escrow jobs. |
| Validation behavior could diverge from the escrow contract. | The checks and 64-byte name bound mirror the escrow contract's current milestone validator. |
| Non-escrow builds could fail because of escrow-specific tests or symbols. | Production helper and regression tests are gated behind the `escrow` feature. |

## Rollback

This change can be reverted without a migration. It introduces no storage schema changes and does not change the serialized layout of `EscrowMilestone` or `DataKey`.

## Screenshots (if UI change)

Not applicable.
