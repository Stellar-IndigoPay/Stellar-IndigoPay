# Fix: Escrow — Block `refund_expired_job` While a Milestone Is Disputed

Closes #614

## Summary

Prevents the client from clawing back funds that are the subject of an unresolved milestone dispute. `refund_expired_job` now rejects the refund with a new structured `CannotRefundWhileMilestoneDisputed` error whenever **any** milestone on the job is disputed, instead of only when a milestone has been released.

## Problem

After `dispute_milestone`, the disputed milestone has `released = false` and `disputed = true`. `refund_expired_job` only guarded against refunds when `job.milestones.iter().any(|m| m.released)` — a disputed milestone is *not* released, so the guard passed. The client could then call `refund_expired_job` once the deadline passed, and `compute_remaining_funds` would include the disputed (unreleased) milestone's proportion.

**Result:** Refund and dispute-resolution could race, letting the client unilaterally settle a disputed milestone in their own favor and bypass the ongoing dispute-resolution flow.

## Solution

### Guard: `contracts/escrow-contract/src/lib.rs` — `refund_expired_job`
Added a dispute check immediately after the existing `CannotRefundMilestonesClaimed` guard:

```rust
// A disputed milestone is not released, so without this guard the
// client could claw back the disputed milestone's funds past the
// deadline, bypassing ongoing dispute resolution.
let any_disputed = job.milestones.iter().any(|m| m.disputed);
if any_disputed {
    panic_with_error!(&env, EscrowError::CannotRefundWhileMilestoneDisputed);
}
```

A job with a disputed milestone must go through `resolve_milestone_dispute` (or the deprecated `resolve_dispute`) before any expired-job refund is permitted. Dispute-resolution semantics are unchanged.

### Structured error: `EscrowError::CannotRefundWhileMilestoneDisputed = 63`
Added to the `EscrowError` enum. It is appended at the end (code `63`) rather than inserted into the `Refund & claims (47–55)` section so all existing codes `1–62` remain stable — clients and indexers match on these numeric codes, and renumbering would be a breaking change.

### Regression test: `test_refund_expired_job_disputed_milestone_panics`
`#[should_panic]` unit test that:
1. Creates a 2-milestone (50/50) job with no releases.
2. Disputes milestone 0 via `dispute_milestone`.
3. Advances the ledger past the deadline.
4. Asserts `refund_expired_job` panics.

This mirrors the exact exploit path: disputed milestone, no released milestones, deadline passed.

## Changes

| File | Change |
|------|--------|
| `contracts/escrow-contract/src/lib.rs` | Added `CannotRefundWhileMilestoneDisputed = 63` error; added disputed-milestone guard in `refund_expired_job`; added `test_refund_expired_job_disputed_milestone_panics` |
| `CHANGELOG.md` | Added entry under `### Fixed` referencing `closes #614` |
| `README.md` | Updated escrow error-code count (62 → 63; total 308 → 309) |

## Testing

Rust 1.91.0 (matching `.github/workflows/contracts.yml`):

```bash
cargo fmt --all -- --check          # ✅ clean
cargo clippy --workspace -- -D warnings   # ✅ clean
cargo test --features testutils -p escrow-contract -- --skip fuzz   # ✅ all pass
```

- ✅ New `test_refund_expired_job_disputed_milestone_panics` passes (should-panic).
- ✅ All existing refund tests pass (`test_refund_expired_job_success`, `..._before_deadline_panics`, `..._not_client_panics`, `..._milestones_claimed_panics`).
- ✅ Full escrow suite passes: 46 unit tests + all integration tests (`tests/*.rs`).
- ✅ No formatting or Clippy warnings across the whole `contracts` workspace.

> **Note on `escrow_stateful_fuzz`:** the `escrow_fuzz::fuzz::escrow_stateful_fuzz` proptest fails, but this is **pre-existing** — it fails identically on unmodified `main` (verified via `git stash`), is unrelated to this change (the fuzz model has no `refund` operation), and standard CI skips fuzz tests with `--skip fuzz`.

## Acceptance Criteria

- [x] Refund is blocked while any milestone is disputed (new guard + structured error).
- [x] Existing refund tests still pass.
- [x] One `#[should_panic]` unit test added.
- [x] Standard contract CI checks pass (fmt, clippy, tests).
- [x] CHANGELOG entry added.

## Impact

- **Security/Correctness**: Closes the refund/dispute race — a disputed milestone's funds can no longer be unilaterally refunded to the client past the deadline.
- **Behavioral change**: `refund_expired_job` now panics with `CannotRefundWhileMilestoneDisputed` (code 63) on jobs with an unresolved disputed milestone where it previously succeeded. Callers that relied on the old behavior must resolve the dispute first.
- **Compatibility**: No existing error codes changed; new code is additive.

## Rollback Plan

```bash
git revert <commit-sha>   # reverts guard, error, test, and docs atomically
```

No state migration is required — the guard is enforced at call time.

## Related Issues

- Closes #614 — Escrow: `refund_expired_job` can refund a job while a milestone is still disputed

---

**Labels**: GrantFox OSS, Official Campaign, area/contracts, type/bug, priority/medium

**Tested on**: Local Rust 1.91.0 (host target) — contract CI toolchain

**Contributors**: @Yinklekay
