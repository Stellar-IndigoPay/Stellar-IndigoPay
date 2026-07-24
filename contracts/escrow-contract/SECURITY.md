# Security Notes

## Multi-sig admin with configurable release periods (#440)

Replaces the single-admin model (`DataKey::Admin`) with an M-of-N multi-sig
admin system, mirroring the pattern in `indigopay-contract` (see its
`SECURITY.md`, Phase B). Also replaces the fixed `RELEASE_AFTER_LEDGERS`
release period with a per-job, caller-supplied period bounded by a minimum.

### Problem addressed

A single compromised admin key could freeze all funds by disputing every
job (`dispute_job` / `dispute_milestone`) and could then unilaterally decide
every dispute's outcome. Multi-sig raises the bar from "compromise one key"
to "compromise M of N keys simultaneously." Separately, a single global
10-ledger release period is too short for many real-world escrow scenarios;
jobs now choose their own period, subject to a floor.

### New data model

| Key                       | Type           | Description                                                        |
| -------------------------- | -------------- | -------------------------------------------------------------------- |
| `DataKey::AdminSet`       | `Vec<Address>` | Set of authorized admin addresses                                  |
| `DataKey::AdminThreshold` | `u32`          | Number of valid admin signatures required for admin-gated actions  |

The former `DataKey::Admin` variant is removed. `Job.release_after` is
unchanged in type (`u32`, an absolute ledger sequence) but is now derived
from a per-job caller-supplied offset instead of the global constant.

### Admin-gated actions (all require M-of-N)

- `dispute_job`, `resolve_dispute` (deprecated, kept for backward compatibility)
- `dispute_milestone`, `resolve_milestone_dispute`
- `update_release_after`
- `add_admin`, `remove_admin`, `update_threshold`

Escrow has no functions gated at a lower "1-of-N" tier — every admin action
here is fund- or dispute-affecting, so all of them require the full
threshold.

### Multi-sig verification (`verify_m_of_n`)

1. Calls `signer.require_auth()` on every address in the supplied `signers`
   vec (Soroban host-level cryptographic verification).
2. Delegates counting to `count_distinct_admins`, a pure function that
   counts how many *distinct* addresses in `signers` belong to the admin
   set — counted only once each, so repeating an address does not inflate
   the count.
3. Panics with `"Insufficient admin signatures: M/N required"` if the
   distinct count is below the threshold.

`count_distinct_admins` is deliberately decoupled from `require_auth` so its
dedup invariant can be property-tested directly (`prop_escrow_m_of_n_dedup`
in `escrow_fuzz.rs`) without needing a signed authorization entry per
signer.

### Admin set management

- **`add_admin(signers, new_admin)`** — adds a new address. Panics if
  already an admin.
- **`remove_admin(signers, admin_to_remove)`** — removes an address. Panics
  if it would leave the set empty, or if the resulting set would be smaller
  than the current threshold (call `update_threshold` first).
- **`update_threshold(signers, new_threshold)`** — updates the threshold.
  Must satisfy `1 <= new_threshold <= admin_set.len()`.

### Initialization and backward compatibility

```rust
pub fn initialize(env: Env, admins: Vec<Address>, threshold: u32)
```

Validates: `admins` is non-empty, `1 <= threshold <= admins.len()`.
Single-admin deployments call `initialize(vec![admin], 1)`, which behaves
identically to the previous single-admin model.

### Per-job configurable release period

`create_job` now takes a `release_after: u32` parameter — the number of
ledgers, from creation, before the freelancer may auto-claim an unclaimed
milestone via `claim_milestone`. It must be at least `RELEASE_AFTER_LEDGERS`
(now a floor, not a default); shorter values panic with
`"release_after must be at least the minimum of N ledgers"`. The resulting
absolute ledger sequence is stored on the job as before.

M-of-N admins can extend (never shorten) a job's release period via
`update_release_after(signers, job_id, new_release_after)`. This lets
admins accommodate a job that legitimately needs more time without
requiring a new escrow. Attempting to set a value that does not strictly
extend the current period panics with
`"New release_after must extend the current release period"`.

### Event audit trail

| Event topic | Trigger                                                |
| ----------- | ------------------------------------------------------- |
| `admin_add` | `add_admin` added a new admin to the set                |
| `admin_rmv` | `remove_admin` removed an admin from the set             |
| `thresh_up` | `update_threshold` changed the threshold                 |
| `rel_upd`   | `update_release_after` extended a job's release period   |

## Partial milestone release (#441)

`Milestone` gains a `partial_release_percentage: u32` field tracking the
cumulative percentage of that milestone released so far (0-100).
`released` is always kept in sync with `partial_release_percentage == 100`,
so every other function that reads `milestone.released` (dispute checks,
oracle proof/verify, `amend_job_milestones` validation, job-completion
checks) continues to work unchanged.

### `release_milestone` / `release_milestone_partial`

```rust
pub fn release_milestone(env: Env, client: Address, job_id: String, milestone_index: u32, release_pct: u32)
pub fn release_milestone_partial(env: Env, client: Address, job_id: String, milestone_index: u32, release_pct: u32)
```

`release_milestone_partial` is a thin alias that forwards to
`release_milestone` — both accept the same `release_pct`, the percentage of
*that milestone* (not of the total job) to release now. `release_pct` is
added to the milestone's existing `partial_release_percentage`; the
milestone becomes fully released once the cumulative total reaches 100.

- `release_pct == 0` panics with `"release_pct must be greater than 0"`.
- A `release_pct` that would push the cumulative total above 100 panics
  with `"release_pct exceeds remaining milestone percentage"`.
- The paid amount is computed as the difference between the milestone's
  proportional amount at the new cumulative percentage and at the old one
  (`released_after - released_before`), not `release_pct` applied to the
  milestone amount directly. This ensures a final partial release that
  reaches 100% always pays out exactly whatever integer-division dust is
  left, so the sum of all partial releases equals a single full release to
  the stroop.

### Interaction with claim, dispute, and refund

- **`claim_milestone`** now claims only the outstanding (unreleased)
  portion of a milestone, so a freelancer can auto-claim the remainder of a
  milestone the client had already partially released.
- **`dispute_milestone`** is unchanged: it still guards against disputing
  an already-fully-released milestone, but a *partially* released
  milestone can still be disputed — the dispute freezes only what has not
  yet been paid out.
- **`resolve_milestone_dispute`** settles only the remaining unpaid portion
  of a disputed milestone (`full_amount - released_before`), so a milestone
  that had some percentage released before being disputed is never
  double-paid on resolution.
- **`resolve_dispute`** (deprecated, job-level) and **`refund_expired_job`**
  both route through `compute_remaining_funds`, which now sums each
  milestone's unreleased portion (`full_amount - released_amount`) instead
  of an all-or-nothing `released` check. `refund_expired_job` also now
  rejects if *any* milestone has a nonzero `partial_release_percentage`
  (previously only checked `released`), since a partial payout means a full
  refund would double-pay the client.
- **`amend_job_milestones`** rejects any new milestone with a nonzero
  `partial_release_percentage`, matching the existing rejection of
  `released`/`disputed` milestones.

### Job status

A job reaches `JobStatus::Completed` only when every milestone's
`partial_release_percentage` is 100 — a job with any milestone still
partially released stays `PartiallyReleased`, regardless of how many
individual partial-release calls have succeeded.

### Event change

The `ms_rel` event (emitted by `release_milestone` /
`release_milestone_partial`) now carries the `release_pct` applied in that
call in addition to the incremental `release_amount`:

| Event topic | Payload                                                    |
| ----------- | ----------------------------------------------------------- |
| `ms_rel`    | `(job_id, milestone_index, release_pct, release_amount)`     |

`release_amount` is the incremental amount paid in *this* call (not the
milestone's full amount), consistent with the partial-release semantics
above.
