# Add On-Chain Freelancer Reputation to Escrow

**Closes #444**

## Summary

Adds an immutable, freelancer-centric reputation layer to the Soroban escrow
contract. Clients can query a freelancer's on-chain job history before opening
an escrow, while reputation is updated automatically from existing job
lifecycle transitions.

## Type

- [ ] Bug fix
- [x] New feature
- [ ] Documentation
- [ ] Refactor
- [x] Smart contract change

## Changes

- Added `FreelancerReputation` with:
  - total jobs;
  - completed jobs;
  - uniquely disputed jobs;
  - total value completed;
  - on-time completions;
  - first reputation ledger.
- Added freelancer reputation and per-job dispute-deduplication storage keys.
- Initializes and increments reputation when a client creates a job.
- Credits completion through:
  - client milestone release;
  - freelancer milestone claim;
  - full-job dispute resolution;
  - per-milestone dispute resolution that completes the job.
- Counts a disputed job once even if multiple milestones are disputed.
- Tracks whether completion happened on or before the job deadline.
- Excludes `refund_expired_job` from completed-job and completed-value totals.
- Added the read-only `get_freelancer_reputation` query.
- Added no admin or public mutation endpoint, keeping reputation append-only.
- Emits `rep_upd` when completion statistics change.

## Testing

- Added `test_reputation_on_completion`.
- Added `test_reputation_on_dispute`.
- Added `test_reputation_on_refund`.
- Added `test_reputation_query`.
- Added `prop_reputation_counts_consistent`.
- `git diff --check` passes.

The branch is monitored against the repository's Contracts CI after push.

## Screenshots

Not applicable; this PR contains no UI changes.
