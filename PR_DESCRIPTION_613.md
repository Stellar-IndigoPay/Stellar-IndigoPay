# Escrow: unify the two divergent dispute models so interleaving them cannot deadlock a job

Closes #613

## What it fixes

The escrow contract has two parallel dispute mechanisms that maintain **disjoint
state representations**:

| Entrypoint | Representation it writes |
|------------|--------------------------|
| `dispute_job` (deprecated) | `job.disputed = true`, `job.status = Disputed` — **no** milestone flag |
| `dispute_milestone` | `milestone.disputed = true`, `job.status = Disputed` — leaves `job.disputed = false` |

The resolution entrypoints are split the same way: `resolve_dispute` reads
`job.disputed`, while `resolve_milestone_dispute` reads `milestone.disputed`.

Interleaving the two paths can strand a job with no recovery path except the
deprecated one:

1. An operator (or a bot) disputes a job with `dispute_job` → `job.disputed = true`,
   but no milestone is flagged.
2. `release_milestone` / `claim_milestone` both reject because `job.disputed == true`.
3. The operator tries the **current** resolution entrypoint
   `resolve_milestone_dispute` → it panics with `MilestoneIsNotDisputed` because
   no milestone flag was set.
4. Only the deprecated `resolve_dispute` can clear `job.disputed`.

The reverse interleaving is also broken: a job disputed via `dispute_milestone`
leaves `job.disputed == false`, so `resolve_dispute` panics with
`JobIsNotDisputed`.

This PR makes the **per-milestone `disputed` flag the single source of truth**
and keeps `job.disputed` as a derived summary flag, so every disputed state has
a well-defined resolution path in both directions.

## Root cause

`dispute_job` wrote a job-level boolean (`job.disputed`) without touching the
milestones, while `dispute_milestone` wrote milestone flags without touching
`job.disputed`. The two representations had incompatible state transitions and
no reconciliation path, so an operator who mixed the deprecated and current
entrypoints could reach a state that only the deprecated resolver could leave.

Separately, `release_milestone` and `claim_milestone` guarded on the **job-level**
`job.disputed` flag, which is why a job disputed via `dispute_job` froze every
milestone even though the per-milestone model is designed to let non-disputed
milestones continue.

## The fix and why

### 1. `dispute_job` (deprecated) delegates to the milestone representation

```rust
// Mirror the dispute onto every unreleased milestone so the
// milestone-level resolution path can resolve it later.
let mut milestones = job.milestones.clone();
for i in 0..milestones.len() {
    let mut milestone = milestones.get(i).unwrap().clone();
    if !milestone.released {
        milestone.disputed = true;
        #[cfg(feature = "oracle-escrow")]
        {
            milestone.verified = false;
            milestone.proof_hash = None;
        }
    }
    milestones.set(i, milestone);
}
job.milestones = milestones;
job.disputed = true;
job.status = JobStatus::Disputed;
```

`dispute_job` now marks every **unreleased** milestone disputed (mirroring the
oracle-verification voiding that `dispute_milestone` already does), so
`resolve_milestone_dispute` can subsequently unblock the job. It still sets
`job.disputed = true` and `JobStatus::Disputed`, preserving its documented
"freeze remaining releases" behavior and the fuzz-verified re-dispute behavior.

### 2. `dispute_milestone` keeps `job.disputed` in sync

```rust
job.disputed = true;
job.status = JobStatus::Disputed;
```

A milestone-level dispute now also sets the job-level summary flag, so the
deprecated `resolve_dispute` (which checks `job.disputed`) can resolve it.

### 3. `resolve_milestone_dispute` recomputes the summary flag

```rust
let all_released = job.milestones.iter().all(|m| m.released);
let any_disputed = job.milestones.iter().any(|m| m.disputed);
job.disputed = any_disputed;
job.status = if all_released { /* … */ };
```

As milestones are resolved one at a time, `job.disputed` now correctly falls back
to `false` once the last disputed milestone is resolved — the job is no longer
"stuck" in a stale disputed state.

### 4. `release_milestone` / `claim_milestone` gate on the milestone, not the job

The job-level `if job.disputed` guard is removed from both. Release/claim now
rely on the per-milestone `milestone.disputed` check. This:

- Preserves the deprecated "freeze everything" semantics, because `dispute_job`
  flags **every** unreleased milestone (`release`/`claim` of any of them still
  panics with `MilestoneIsDisputed` / `MilestoneDisputedCannotClaimMilestone`).
- Restores the per-milestone model's intended behavior (already covered by
  `test_per_milestone_dispute_and_resolution_approve`): a job with one disputed
  milestone can still release its non-disputed milestones.

### Why this approach over the alternatives

- **Deriving `job.disputed` from `any(milestone.disputed)` and dropping the
  `job.disputed` field entirely** is the "purest" single representation, but it
  is a breaking change to the persisted `Job` struct (Soroban contracttype) and
  to every off-chain reader of `get_job().disputed`, and it would change the
  deprecated `dispute_job` re-dispute semantics (a completed job has no
  unreleased milestone to flag, so it could no longer be re-disputed). That
  change is out of scope for a bug fix and would ripple into the committed fuzz
  regression seeds.
- **Making `resolve_milestone_dispute` fall back to the job-level flag** would
  patch the symptom but leave two sources of truth in place, so future
  interleavings could strand jobs again.
- The chosen approach is the smallest change that makes the milestone flag
  authoritative while keeping `job.disputed` as a *derived summary* that stays
  in sync — so the deprecated entrypoints remain callable, behave consistently,
  and no existing public type or entrypoint is removed.

## Critical-path trade-offs (escrow / payments)

This touches the **escrow payment state machine**, so I want to be explicit
about what changed and what did not:

- **No fund-movement semantics changed.** `resolve_dispute` still releases all
  remaining funds to freelancer (`approve=true`) or client (`approve=false`);
  `resolve_milestone_dispute` still pays/refunds the single milestone's
  proportional amount. Amount arithmetic is untouched (still the
  `compute_proportional_payout` checked-math helper from #616).
- **A released milestone can never become disputable.** `dispute_job` only flags
  *unreleased* milestones, and `dispute_milestone` still panics on a released
  milestone (`MilestoneAlreadyReleased`). This preserves the invariant that
  `resolve_milestone_dispute`'s payout cannot double-pay an already-released
  milestone.
- **The deprecated "freeze all" behavior is preserved** (via milestone flags
  rather than the job boolean), and the fuzz-verified re-dispute behavior is
  unchanged (`dispute_job` still flips a resolved job back to `Disputed`).
- **Behavior change that is intentional:** after `dispute_milestone`,
  `resolve_dispute` now works (it no longer panics with `JobIsNotDisputed`).
  Because `resolve_dispute` is a *job-level* resolution, calling it resolves
  **every** remaining milestone (releasing the disputed one and any undisputed
  remainder to the chosen party). This matches the documented deprecated
  "release remaining funds" semantics; operators who want granular control
  should use `resolve_milestone_dispute`.

## How it was tested

Two new cross-path integration tests in `contracts/escrow-contract/tests/dispute.rs`
(the exact sequences that failed before and pass now):

- `test_dispute_job_then_resolve_milestone_dispute` — dispute via the deprecated
  path, then resolve milestone-by-milestone via the current path; asserts the
  milestone flags are set, `job.disputed` decays to `false` after the last
  milestone is resolved, the job reaches `Completed`, and the freelancer is paid
  in full.
- `test_dispute_milestone_then_resolve_dispute` — the reverse: dispute a
  milestone, then resolve via the deprecated job-level path; asserts
  `job.disputed` is set and the job reaches `Completed`.

Existing behavior is re-verified by the unchanged suites:
`test_release_disputed_job_panics`, `test_claim_disputed_job_panics` (the
"freeze" now fires via `MilestoneIsDisputed` /
`MilestoneDisputedCannotClaimMilestone`), `test_per_milestone_dispute_and_resolution_approve`
(per-milestone release still works), and the overflow/structured-error tests.

Full local verification (matching `contracts.yml`):

```bash
cargo fmt --all -- --check                         # clean
cargo clippy --workspace -- -D warnings            # clean
cargo test --features testutils --workspace -- --skip fuzz   # all green
cargo build --workspace --target wasm32v1-none --release --no-default-features  # builds
cargo test -p escrow-contract --features testutils -- escrow_stateful_fuzz        # fuzz + regression seeds green
```

The stateful fuzz harness (`escrow_fuzz::fuzz::escrow_stateful_fuzz`) and its
committed regression seeds (including the re-dispute sequence) pass unchanged,
confirming the model and contract stay aligned.

## Follow-ups worth filing separately

1. **Remove the deprecated `dispute_job` / `resolve_dispute` entrypoints**
   (after a deprecation window and off-chain indexer migration) and delete the
   now-vestigial `job.disputed` field. This is explicitly out of scope here
   ("removing public entrypoints without a deprecation note").
2. **Harden `resolve_dispute` against re-disputing a fully-completed job** —
   today `dispute_job` can flip a completed job back to `Disputed` (a no-op on
   funds, but confusing). With the unified model, this could be made a
   structured no-op/error; it would require updating the fuzz model and its
   regression seed in the same change.
3. **Dead error codes** — `JobDisputedAdminMustResolve`,
   `JobDisputedCannotClaimMilestone`, and `DisputeJobAlreadyDisputed` are no
   longer emitted; consider deprecating them in the error enum when the public
   entrypoints are removed.
