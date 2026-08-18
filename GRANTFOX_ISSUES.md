# GrantFox OSS — 50 Implementation-Ready GitHub Issues

> Generated from deep analysis of the Stellar-IndigoPay codebase (contracts, backend, frontend, CI/CD, monitoring, and cross-cutting concerns). Every issue references real files, modules, and tests that already exist.

---

## Issue #001 — Escrow: Add freelancer identity check in `claim_milestone`

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/bug`, `priority/medium`

### Summary
The `claim_milestone` function in the escrow contract accepts any `freelancer` address as a caller but never verifies that the caller is actually the job's assigned freelancer. A malicious actor who can sign as any address could claim a milestone on a job they have no relationship with.

### Background
The `claim_milestone` entrypoint (in `contracts/escrow-contract/src/lib.rs`) allows a freelancer to auto-claim a milestone after the `release_after` ledger sequence has passed. Unlike `release_milestone` (which verifies `job.client == client`) and `submit_milestone_proof` (which verifies `job.freelancer == freelancer`), `claim_milestone` only calls `freelancer.require_auth()` but never compares the authenticated caller against `job.freelancer`.

### Problem Statement
A caller holding any valid Stellar keypair can call `claim_milestone` with a `freelancer` argument matching a key they control, and `require_auth()` will succeed. But the contract never checks that this caller is the same address stored in `job.freelancer`, so the caller could claim a stranger's milestone. Because `claim_milestone` transfers tokens to `job.freelancer` (the *stored* address, not the caller), an attacker couldn't steal funds — but they could disrupt the job by prematurely marking a milestone as released and transferring tokens to the genuine freelancer without the client's consent, or cause state inconsistency.

### Objectives
- Add an identity check at the start of `claim_milestone`: `if job.freelancer != freelancer { panic!("Only the job's freelancer can claim"); }`
- This mirrors the existing guard already present in `release_milestone` (`if job.client != client`) and `submit_milestone_proof`.

### Scope

**In Scope**
- Add the identity assertion to `claim_milestone` in `contracts/escrow-contract/src/lib.rs`
- Add a `#[should_panic]` test that calls `claim_milestone` with a different address after the release period

**Out of Scope**
- Changing the token transfer logic
- Modifying other entrypoints

### Implementation Plan
1. Navigate to `contracts/escrow-contract/src/lib.rs`
2. Find the `claim_milestone` function
3. After loading the job but before any other logic, add:
   ```rust
   if job.freelancer != freelancer {
       panic!("Only the job's freelancer can claim");
   }
   ```
4. Add a test in the test module:
   ```rust
   #[test]
   #[should_panic(expected = "Only the job's freelancer can claim")]
   fn test_claim_milestone_wrong_freelancer_panics() { ... }
   ```
5. Run `cargo test --features testutils -p escrow-contract` to verify all existing tests pass and the new test panics correctly.

### Expected Files or Components
- `contracts/escrow-contract/src/lib.rs` — the `claim_milestone` function and test module

### Acceptance Criteria
- `claim_milestone` panics with a clear message when `job.freelancer != freelancer`
- The new unit test passes (expected panic)
- All existing escrow tests continue to pass
- `cargo fmt` and `cargo clippy` produce no warnings

### Testing Requirements
- Unit test (`#[should_panic]`) for the wrong-freelancer case
- No integration or fuzz test needed — this is a pure access-control check

### CI Requirements
- `cargo fmt --all -- --check`
- `cargo clippy --workspace -- -D warnings`
- `cargo test --features testutils --workspace -- --skip fuzz`

### Deliverables
- Single commit with the fix + test
- Changelog entry under `[Unreleased]` in `CHANGELOG.md`

### Definition of Done
- [ ] Identity check added to `claim_milestone`
- [ ] Test added
- [ ] All CI checks green
- [ ] PR reviewed and merged

### References
- `contracts/escrow-contract/src/lib.rs` lines ~500-560 (`claim_milestone`)
- `contracts/escrow-contract/src/lib.rs` lines ~340-380 (`release_milestone`) for comparison
- ADR-004 (CEI pattern) at `docs/adr/ADR-004-cei-pattern.md`

---

## Issue #002 — Escrow: Add unit tests for `FreelancerReputation` on-time completion tracking

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/testing`, `priority/medium`

### Summary
The `FreelancerReputation` struct tracks `on_time_completions` and the test module creates helpers like `create_reputation_job` and `setup`, but no test explicitly verifies that `on_time_completions` increments only when the freelancer completes before the deadline and does *not* increment when completion happens after the deadline.

### Background
`reputation_job_completed` in `contracts/escrow-contract/src/lib.rs` compares `env.ledger().sequence() <= job.deadline` to decide whether to bump `on_time_completions`. The existing tests for `release_milestone`, `claim_milestone`, and `resolve_dispute` exercise the completion path but never assert on the resulting `FreelancerReputation.on_time_completions` field. The tests only verify `JobStatus`.

### Problem Statement
Without explicit assertions on `on_time_completions`, a regression that always sets this field to 0 (or always increments it regardless of deadline) would go unnoticed.

### Objectives
- Write two tests: one that proves `on_time_completions` increments when a job is completed before its deadline, and one that proves it stays at 0 (or doesn't increase) when completion happens after the deadline
- Use the existing test helpers (`create_reputation_job`, `setup`, `signers1`)

### Scope

**In Scope**
- Two new unit tests in `contracts/escrow-contract/src/lib.rs` test module
- Use `client.get_freelancer_reputation(&freelancer)` to assert on the reputation struct

**Out of Scope**
- Modifying the reputation logic itself
- Adding new contract entry points

### Implementation Plan
1. Write `test_reputation_on_time_completion` — create a job, release its milestone *before* advancing the ledger past the deadline, then assert `reputation.on_time_completions == 1`
2. Write `test_reputation_late_completion` — create a job, advance the ledger past the deadline, release the milestone, then assert `reputation.on_time_completions == 0`
3. Run `cargo test --features testutils -p escrow-contract`

### Expected Files or Components
- `contracts/escrow-contract/src/lib.rs` — test module

### Acceptance Criteria
- Both new tests pass
- All existing escrow tests continue to pass
- `cargo fmt` + `cargo clippy` clean

### Testing Requirements
- Two new unit tests only

### CI Requirements
- Standard contract CI (`cargo test`, `cargo fmt`, `cargo clippy`)

### Deliverables
- Single commit with two tests
- Changelog entry

### Definition of Done
- [ ] Two reputation on-time tests written and passing
- [ ] CI green

### References
- `contracts/escrow-contract/src/lib.rs` — `reputation_job_completed` function
- `contracts/escrow-contract/src/lib.rs` — `create_reputation_job` helper
- `contracts/escrow-contract/src/lib.rs` — `FreelancerReputation` struct

---

## Issue #003 — IndigoPay: Validate Vec size in `add_project_donation` to prevent unbounded storage growth

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/bug`, `priority/high`

### Summary
The `add_project_donation` function in `contracts/indigopay-contract/src/donation/storage.rs` pushes donation IDs into a `Vec<u64>` keyed by project address with no upper bound. A project receiving many stealth donations could grow this vector without limit, increasing state read/write costs and potentially hitting Soroban ledger entry size limits.

### Background
`add_project_donation` is called from `donate_stealth` in `contract.rs`. Each donation appends a `u64` to the project's donation list. The Soroban host enforces a maximum ledger entry size; a sufficiently large `Vec` would eventually exceed this limit and cause all future donations to that project to fail irrecoverably.

### Problem Statement
No guard prevents the per-project donation list from growing without bound. This is both a storage-cost concern (every `donate_stealth` call reads and writes the full `Vec`) and a correctness concern (the vector could eventually hit the host limit).

### Objectives
- Add a maximum-size check in `add_project_donation` that panics with a clear message when the project's donation count exceeds a reasonable limit (e.g., 10,000)
- Add a test that verifies the panic fires when the limit is reached

### Scope

**In Scope**
- Add a `const MAX_DONATIONS_PER_PROJECT: u64 = 10_000;` constant
- Add a length check in `add_project_donation`
- Add a respective unit test

**Out of Scope**
- Pagination or iteration changes for `get_project_donations`
- Changing the data model

### Implementation Plan
1. Define the constant in `storage.rs`
2. Before `ids.push_back(donation_id)`, check `ids.len() as u64 >= MAX_DONATIONS_PER_PROJECT` and panic
3. Write a test that creates the maximum number of entries and verifies the next push panics

### Expected Files or Components
- `contracts/indigopay-contract/src/donation/storage.rs`

### Acceptance Criteria
- `donate_stealth` panics with a clear message when the per-project limit is reached
- Test verifies the panic
- All existing tests pass

### Testing Requirements
- Unit test verifying the panic behavior

### CI Requirements
- Standard contract CI

### Deliverables
- Single commit with guard + test
- Changelog entry

### Definition of Done
- [ ] Vec size limit added
- [ ] Test added
- [ ] CI green

### References
- `contracts/indigopay-contract/src/donation/storage.rs` — `add_project_donation`
- `contracts/indigopay-contract/src/donation/contract.rs` — `donate_stealth`

---

## Issue #004 — IndigoPay: Replace `.expect()` with graceful `Option` return in `get_stealth_donation`

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/bug`, `priority/medium`

### Summary
`get_stealth_donation` in `contracts/indigopay-contract/src/donation/storage.rs` calls `.expect("stealth donation not found")` — this panics the contract if called with a non-existent ID. The function should return `Option<StealthDonation>` and let callers handle the missing case.

### Background
The `scan_stealth_donations` function (in `contract.rs`) iterates over `get_project_donations` and calls `get_stealth_donation` for each ID. If a donation ID was stored but the corresponding `StealthDonation` entry was somehow removed (edge case in persistent storage), iterating would panic the entire scan call.

### Problem Statement
A panic in a Soroban contract reverts the entire transaction. Since `scan_stealth_donations` is a read-only call that iterates over IDs, a missing entry should be a skip, not a fatal error.

### Objectives
- Change `get_stealth_donation` to return `Option<StealthDonation>` instead of panicking
- Update `scan_stealth_donations` to `continue` on `None`
- Update the test module to reflect the new return type

### Scope

**In Scope**
- `get_stealth_donation` return type change
- `scan_stealth_donations` caller update
- Test updates

**Out of Scope**
- Other callers (if any exist outside this module)

### Implementation Plan
1. Change `get_stealth_donation` signature to return `Option<StealthDonation>` and use `env.storage().persistent().get(...)` without `.expect()`
2. In `scan_stealth_donations`, change `let donation = get_stealth_donation(&env, id);` to `if let Some(donation) = get_stealth_donation(&env, id) { donations.push_back(donation); }`
3. Update test helpers to unwrap the Option
4. Add a new test: `test_scan_with_missing_donation_is_graceful` that verifies the scan doesn't panic when an ID points to nothing

### Expected Files or Components
- `contracts/indigopay-contract/src/donation/storage.rs`
- `contracts/indigopay-contract/src/donation/contract.rs`

### Acceptance Criteria
- `get_stealth_donation` returns `Option<StealthDonation>`
- `scan_stealth_donations` skips missing entries gracefully
- Existing tests updated and pass
- New test passes

### Testing Requirements
- Unit tests updated
- New test for missing entry recovery

### CI Requirements
- Standard contract CI

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Option return type added
- [ ] Callers updated
- [ ] Tests updated/passing
- [ ] CI green

### References
- `contracts/indigopay-contract/src/donation/storage.rs` line ~22
- `contracts/indigopay-contract/src/donation/contract.rs` — `scan_stealth_donations`

---

## Issue #005 — Escrow: Validate that `release_after` does not exceed `deadline` in `create_job`

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/bug`, `priority/medium`

### Summary
`create_job` sets `deadline = env.ledger().sequence() + DEFAULT_DEADLINE_LEDGERS` and also accepts a caller-supplied `release_after` floor. If the caller passes a `release_after` that extends past the computed `deadline`, the freelancer could auto-claim milestones after the refund window has already opened, creating a race between `claim_milestone` (freelancer) and `refund_expired_job` (client).

### Background
`release_after` is an absolute ledger sequence computed as `env.ledger().sequence() + release_after`. The `deadline` is also absolute: `env.ledger().sequence() + DEFAULT_DEADLINE_LEDGERS`. `DEFAULT_DEADLINE_LEDGERS` is 1,555,200 (90 days at 5s/ledger). `RELEASE_AFTER_LEDGERS` is only 10. A caller could pass `release_after = 2_000_000`, which would exceed the 90-day deadline, giving the freelancer a claim window that starts after refund eligibility.

### Problem Statement
No invariant enforces `release_after <= deadline`. The contract should either reject such jobs or cap `release_after` at `deadline`.

### Objectives
- Add a check in `create_job` that panics if `release_after > deadline`
- Add a test for this validation

### Scope

**In Scope**
- Validation check in `create_job`
- Unit test

**Out of Scope**
- Changing the default deadline
- Modifying `claim_milestone` or `refund_expired_job`

### Implementation Plan
1. In `create_job`, after computing `deadline`, add:
   ```rust
   if release_after > deadline {
       panic!("release_after must not exceed the job deadline");
   }
   ```
2. Add a `#[should_panic]` test

### Expected Files or Components
- `contracts/escrow-contract/src/lib.rs` — `create_job`

### Acceptance Criteria
- `create_job` panics when `release_after > deadline`
- Test passes
- Existing tests pass

### Testing Requirements
- One `#[should_panic]` unit test

### CI Requirements
- Standard contract CI

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Validation added
- [ ] Test added
- [ ] CI green

### References
- `contracts/escrow-contract/src/lib.rs` — `create_job`
- `contracts/escrow-contract/src/lib.rs` — `claim_milestone`, `refund_expired_job`

---

## Issue #006 — Escrow: Add fuzz target for milestone percentage edge cases in `create_job`

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/testing`, `priority/medium`

### Summary
The escrow fuzz test in `contracts/escrow-contract/src/escrow_fuzz.rs` covers general job lifecycle but doesn't specifically fuzz the milestone percentage validation in `create_job`. Edge cases like individual percentages of 0, percentages that sum correctly but have one at 0, or overflow scenarios should be validated.

### Background
`create_job` iterates over milestones and sums their percentages using `checked_add`, then asserts the total equals 100. The existing fuzz test creates jobs with random parameters but milestone percentages are not a fuzzed input dimension.

### Problem Statement
Without fuzzing milestone percentages specifically, edge cases like a milestone with percentage 0 (which would sum correctly to 100 with other milestones but might be semantically invalid) could slip through.

### Objectives
- Add a dedicated fuzz test or proptest that generates milestone vectors with valid and invalid percentage distributions
- Verify `create_job` panics on invalid sums and succeeds on valid ones

### Scope

**In Scope**
- New fuzz/proptest test targeting milestone percentage validation

**Out of Scope**
- Fuzzing other contract entrypoints
- Changing the milestone validation logic

### Implementation Plan
1. Add a proptest strategy in `escrow_fuzz.rs` (or a new `tests/milestone_fuzz.rs` file) that generates `Vec<Milestone>` with random percentages
2. Assert: if percentages sum to 100, `create_job` succeeds; otherwise it panics
3. Ensure the fuzz test is registered in the proptest regression file

### Expected Files or Components
- `contracts/escrow-contract/src/escrow_fuzz.rs` or new test file
- `contracts/escrow-contract/Cargo.toml` (if adding `proptest` dependency)

### Acceptance Criteria
- Fuzz test exercises at least 1,000 random milestone distributions
- Test catches the known bug: any sum != 100 panics
- `cargo test --features testutils -p escrow-contract` passes

### Testing Requirements
- New fuzz/proptest test

### CI Requirements
- Standard contract CI (fuzz tests are skipped in CI via `-- --skip fuzz` but should run locally)

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Fuzz test added and passing locally with `cargo test`
- [ ] CI green

### References
- `contracts/escrow-contract/src/escrow_fuzz.rs`
- `contracts/escrow-contract/src/lib.rs` — `create_job` milestone validation

---

## Issue #007 — Escrow: Ensure milestone percentages sum to 100 on `amend_job_milestones` before accepting the amendment

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/improvement`, `priority/low`

### Summary
`amend_job_milestones` verifies that new milestone percentages sum to 100, but it also checks `if milestone.released || milestone.disputed` for each new milestone. This check flags when a new milestone is somehow marked as released/disputed, but the error message doesn't distinguish *which* new milestone triggered the panic. The message should include the offending milestone index for better debugging.

### Background
When `amend_job_milestones` iterates the new milestones and finds one that's `released` or `disputed`, it panics with `"New milestones must not be released or disputed"`. In a multi-milestone amendment, the caller can't tell which milestone caused the failure.

### Problem Statement
Poor error messages make debugging harder in contract call failures. Including the milestone index is a one-line change that improves developer experience.

### Objectives
- Include the index of the offending milestone in the panic message

### Scope

**In Scope**
- Better panic message in `amend_job_milestones`

**Out of Scope**
- Structural changes to milestone validation

### Implementation Plan
Change:
```rust
panic!("New milestones must not be released or disputed");
```
to:
```rust
panic!("New milestone {} must not be released or disputed", i);
```
(where `i` is the loop index).

### Expected Files or Components
- `contracts/escrow-contract/src/lib.rs` — `amend_job_milestones`

### Acceptance Criteria
- Panic message includes the milestone index
- Existing `amend_job_milestones` tests still pass (the message check uses partial matching)

### Testing Requirements
- Verify existing `#[should_panic]` tests still match

### CI Requirements
- Standard contract CI

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Error message improved
- [ ] CI green

### References
- `contracts/escrow-contract/src/lib.rs` — `amend_job_milestones`
- `contracts/escrow-contract/tests/amend_job.rs`

---

## Issue #008 — IndigoPay: Add test verifying stealth donation counter monotonicity across multiple donations

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/testing`, `priority/medium`

### Summary
The existing `test_donate_stealth` test verifies the donation counter starts at 1, and `seed_donations` creates multiple donations but never asserts on the counter values of the second donation. Add a test that verifies the counter increments monotonically and correctly across 3+ donations.

### Background
The stealth donation counter (`StealthCounter` in `storage.rs`) is incremented with `set_stealth_counter(&env, donation_id)`. If `donate_stealth` were refactored and the counter logic accidentally moved, the counter could skip values or reset. No test verifies the counter sequence.

### Problem Statement
Without a test for counter monotonicity, a regression could silently break donation ID assignment.

### Objectives
- Write a test that creates 3 sequential stealth donations and asserts their IDs are exactly 1, 2, 3

### Scope

**In Scope**
- One new test in `contracts/indigopay-contract/src/donation/contract.rs`
- Verify donation IDs are sequential

**Out of Scope**
- Concurrent donation testing (Soroban transactions are serial)

### Implementation Plan
1. Create a new test `test_stealth_donation_counter_monotonic` that calls `donate_stealth` three times and asserts IDs are 1, 2, and 3

### Expected Files or Components
- `contracts/indigopay-contract/src/donation/contract.rs`

### Acceptance Criteria
- Test passes
- Existing tests pass

### Testing Requirements
- One unit test

### CI Requirements
- Standard contract CI

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Test added and passing
- [ ] CI green

### References
- `contracts/indigopay-contract/src/donation/contract.rs` — `test_donate_stealth`
- `contracts/indigopay-contract/src/donation/storage.rs` — `get_stealth_counter`, `set_stealth_counter`

---

## Issue #009 — Escrow: Deduplicate the `Milestone` struct definition across `cfg` branches

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/improvement`, `priority/low`

### Summary
The `Milestone` struct in `contracts/escrow-contract/src/lib.rs` is defined twice with identical fields — once under `#[cfg(not(feature = "oracle-escrow"))]` and once under `#[cfg(feature = "oracle-escrow")]`. This duplication is a maintenance burden: any field change must be made in two places.

### Background
Both `Milestone` definitions have the same fields: `name`, `percentage`, `released`, `disputed`, `oracle`, `verified`, `proof_hash`. The `#[cfg]` gating was likely added during oracle feature development and never collapsed.

### Problem Statement
Two identical struct definitions mean any future field change to `Milestone` requires updating both branches. A mistake in one branch is a compile error in only one feature configuration, making it easy to miss.

### Objectives
- Remove the `#[cfg]` gating and keep a single `Milestone` definition
- Verify both build configurations compile

### Scope

**In Scope**
- Deduplicate `Milestone` struct in `lib.rs`

**Out of Scope**
- Other `#[cfg]` branches in the contract

### Implementation Plan
1. Remove `#[cfg(not(feature = "oracle-escrow"))]` and `#[cfg(feature = "oracle-escrow")]` attributes
2. Keep one `Milestone` struct definition
3. Build and test with both feature sets: `cargo test --features testutils` and `cargo test --features "testutils,oracle-escrow"`

### Expected Files or Components
- `contracts/escrow-contract/src/lib.rs`

### Acceptance Criteria
- Single `Milestone` struct definition remains
- Both `cargo build` and `cargo test` pass with and without `oracle-escrow` feature

### Testing Requirements
- Build verification with both feature configurations

### CI Requirements
- Standard contract CI (builds with default features)

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Struct deduplicated
- [ ] Both feature builds pass
- [ ] CI green

### References
- `contracts/escrow-contract/src/lib.rs` lines ~20-40

---

## Issue #010 — Attestation: Add unit tests for aggregate query helper functions

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/testing`, `priority/medium`

### Summary
The `attestation-contract` was recently merged with "on-chain donor aggregation queries" (`feat(attestation): implement on-chain donor aggregation queries`). The `src/lib.rs` and `src/fuzz_tests.rs` exist, but the aggregate query helpers lack dedicated unit tests verifying correctness of aggregation logic (sum, count, filtering by donor/project).

### Background
The attestation contract (`contracts/attestation-contract/src/lib.rs`) provides cross-chain donation attestation. Aggregate queries compute totals across attestations — these need tests to ensure sums are correct, empty result sets are handled, and filters work.

### Problem Statement
Aggregate queries that produce incorrect sums or counts would corrupt the on-chain attestation ledger without any test failing.

### Objectives
- Add unit tests for each aggregate query helper function
- Test with 0, 1, and multiple attestations
- Verify sums match expected values

### Scope

**In Scope**
- Unit tests in `contracts/attestation-contract/src/lib.rs` (or `tests/` directory)

**Out of Scope**
- Changing aggregate logic
- Integration tests

### Implementation Plan
1. Examine the existing aggregate helpers in `lib.rs`
2. Write tests that create attestations and call each aggregate function, asserting on the results
3. Run `cargo test --features testutils -p attestation-contract`

### Expected Files or Components
- `contracts/attestation-contract/src/lib.rs`
- `contracts/attestation-contract/src/fuzz_tests.rs`

### Acceptance Criteria
- At least 3 new unit tests for aggregate helpers
- All tests pass
- `cargo fmt` + `cargo clippy` clean

### Testing Requirements
- Unit tests only

### CI Requirements
- Standard contract CI

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Tests added for aggregate helpers
- [ ] CI green

### References
- `contracts/attestation-contract/src/lib.rs`
- `contracts/attestation-contract/src/fuzz_tests.rs`

---

## Issue #011 — Oracle: Add test coverage for slash event with stake boundary values

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/testing`, `priority/medium`

### Summary
The oracle contract (`contracts/oracle-contract/src/lib.rs`) has a staking and slashing mechanism for reporter accountability. The existing tests cover basic slash scenarios but may not cover edge cases: slashing exactly the full stake, slashing more than the stake (overflow), slashing when stake is 0.

### Background
Oracle reporters stake tokens as collateral; submitting an invalid price results in slashing. The slash function likely uses `checked_sub` or similar. Edge-case behavior (slashing 0 stake, slashing > full stake) needs explicit test coverage.

### Problem Statement
Without boundary tests, an off-by-one or overflow in the slash function could go undetected.

### Objectives
- Add tests for: slashing exactly the full stake, attempting to slash more than staked, and slashing when stake is 0

### Scope

**In Scope**
- New unit tests in `contracts/oracle-contract/src/lib.rs` (or test file)

**Out of Scope**
- Changing the slash logic
- Adding new oracle features

### Implementation Plan
1. Read `contracts/oracle-contract/src/lib.rs` to understand the slash mechanism
2. Write `#[should_panic]` or assertion tests for each boundary case
3. Run `cargo test --features testutils -p oracle-contract`

### Expected Files or Components
- `contracts/oracle-contract/src/lib.rs`

### Acceptance Criteria
- Tests for full-stake slash, over-stake slash, zero-stake slash
- All tests pass or panic as expected

### Testing Requirements
- Unit tests

### CI Requirements
- Standard contract CI

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Boundary tests added
- [ ] CI green

### References
- `contracts/oracle-contract/src/lib.rs`
- `contracts/oracle-contract/SECURITY.md`

---

## Issue #012 — IndigoPay: Add event emission for `scan_stealth_donations` to surface the number of donations scanned

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/improvement`, `priority/low`

### Summary
`scan_stealth_donations` returns a `Vec<StealthDonation>` but doesn't emit any event. For off-chain indexers that track donation scanning activity, an event would be useful to know when a project wallet scanned and how many donations were found.

### Background
The donation flow emits `StelthDn` events on donation. But project wallets calling `scan_stealth_donations` to discover their donations produce no observable on-chain side effect. Adding a lightweight event helps indexers and transparency tools.

### Objectives
- Emit a `StealthScan` event from `scan_stealth_donations` with the project wallet, number of donations found, and current ledger timestamp

### Scope

**In Scope**
- New event in `events.rs`
- Call from `scan_stealth_donations` in `contract.rs`

**Out of Scope**
- Changing the return type
- Modifying the scanning logic

### Implementation Plan
1. Add `emit_stealth_scan` to `events.rs`
2. Add the event call at the end of `scan_stealth_donations` before returning
3. Update `EVENTS.md` documentation

### Expected Files or Components
- `contracts/indigopay-contract/src/donation/events.rs`
- `contracts/indigopay-contract/src/donation/contract.rs`
- `contracts/EVENTS.md`

### Acceptance Criteria
- `StealthScan` event emitted
- `EVENTS.md` updated
- All tests pass

### Testing Requirements
- Update existing scan test to check event emission (if test framework supports it) or add a note

### CI Requirements
- Standard contract CI

### Deliverables
- Single commit with event + docs update
- Changelog entry

### Definition of Done
- [ ] Event added and emitted
- [ ] Docs updated
- [ ] CI green

### References
- `contracts/indigopay-contract/src/donation/events.rs`
- `contracts/EVENTS.md`

---

## Issue #013 — Backend: Add Zod validation schema for `POST /api/projects/:id/campaigns`

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/improvement`, `priority/medium`

### Summary
The campaign creation endpoint (`POST /api/projects/:id/campaigns` in `backend/src/routes/projects.js`) uses inline manual validation with `AppError("VALIDATION_ERROR", ...)` instead of the shared `validate(schema)` middleware used by the project creation endpoint. This is inconsistent and misses the automatic field-level Zod error details that other endpoints provide.

### Background
The codebase has a well-established pattern in `backend/src/middleware/validate.js` and `backend/src/validators/schemas.js` where Zod schemas validate request bodies and return structured `{ error: "Validation failed", details: [...] }` responses. The campaign route performs manual validation of `title`, `goalXLM`, `deadline`, and `description` but doesn't use this shared infrastructure.

### Problem Statement
- Inconsistent validation approach across routes
- Inline validation misses Zod's coercion, trimming, and rich error messages
- No shared schema means validation rules are duplicated if campaigns need validation elsewhere

### Objectives
- Define a `campaignSchema` in `backend/src/validators/schemas.js`
- Use `validate(campaignSchema)` middleware on the `POST /api/projects/:id/campaigns` route
- Remove the inline validation code
- Update any tests that depend on the old error shape

### Scope

**In Scope**
- New `campaignSchema` in `schemas.js`
- Route handler update in `projects.js`
- Test updates if needed

**Out of Scope**
- Other campaign endpoints (GET /campaigns)
- Frontend validation

### Implementation Plan
1. Add `campaignSchema` to `backend/src/validators/schemas.js` with Zod validation for `title` (3-120 chars), `goalXLM` (positive number string), `deadline` (ISO datetime string, future), `description` (optional, max 500)
2. Replace the manual validation block in `POST /:id/campaigns` with `validate(campaignSchema)`
3. Keep the project-exists check
4. Update the route to use `req.body` (already validated by middleware)
5. Run `npm test` to verify no breakage

### Expected Files or Components
- `backend/src/validators/schemas.js` — add `campaignSchema`
- `backend/src/routes/projects.js` — update `POST /:id/campaigns`
- `backend/src/routes/projects.test.js` — if tests exist for this endpoint

### Acceptance Criteria
- Campaign creation uses Zod schema validation
- Validation returns structured `details` on failure
- 5xx errors on validation failure no longer occur
- Existing tests pass (or are updated)

### Testing Requirements
- Verify existing test suite passes
- If no existing tests, add a basic validation-failure test

### CI Requirements
- `npm run lint`
- `npm test`
- `npm run migration:lint`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] `campaignSchema` defined
- [ ] Route uses `validate()` middleware
- [ ] CI green

### References
- `backend/src/routes/projects.js` ~line 225-270 (campaign creation)
- `backend/src/validators/schemas.js` — existing schemas for pattern reference
- `backend/src/middleware/validate.js`

---

## Issue #014 — Backend: Add `adminRequired` middleware to `GET /api/projects/admin/pending`

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/security`, `priority/high`

### Summary
`GET /api/projects/admin/pending` in `backend/src/routes/projects.js` returns unverified projects without requiring admin authentication. This endpoint is mounted at both `/api/projects/admin/pending` and `/api/v1/projects/admin/pending` with no auth middleware, unlike `POST /admin/register` and `POST /admin/confirm` which both use `adminRequired`.

### Background
The `admin/pending` endpoint lists unverified active projects for admin review. It exposes project metadata (name, description, category, wallet address) that should only be visible to authenticated administrators during the review process. The sibling `admin/register` and `admin/confirm` endpoints correctly apply `adminRequired`.

### Problem Statement
Unauthenticated access to the pending projects list leaks pre-verification project data. This is a security concern because project submissions may contain work-in-progress or unvetted information.

### Objectives
- Add `adminRequired` middleware to `GET /admin/pending` route
- Add/fix test to verify 401 response when unauthenticated

### Scope

**In Scope**
- One middleware addition
- Test verification

**Out of Scope**
- Changing the response shape

### Implementation Plan
1. Add `adminRequired` as the second argument to the route handler:
   ```js
   router.get("/admin/pending", adminRequired, async (req, res, next) => { ... });
   ```
2. Import `adminRequired` from `../middleware/auth` (already imported in the file)
3. Run tests to verify 401 response behavior

### Expected Files or Components
- `backend/src/routes/projects.js`
- `backend/src/routes/projects.test.js` (if pending endpoint tests exist)

### Acceptance Criteria
- `GET /api/projects/admin/pending` returns 401 without valid auth
- `GET /api/projects/admin/pending` returns 200 with valid auth
- Existing admin tests pass

### Testing Requirements
- Verify auth gate works for this endpoint
- Extend existing admin route test if needed

### CI Requirements
- `npm run lint`
- `npm test`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] `adminRequired` added to route
- [ ] Auth test covers this endpoint
- [ ] CI green

### References
- `backend/src/routes/projects.js` — `router.get("/admin/pending", ...)` ~line 400
- `backend/src/routes/projects.js` — `router.post("/admin/register", adminRequired, ...)` for comparison
- `backend/src/middleware/auth.js` — `adminRequired`

---

## Issue #015 — Backend: Add control-character and excessive-whitespace validation to donation message field

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/improvement`, `priority/medium`

### Summary
The `donationSchema` in `backend/src/validators/schemas.js` validates that `message` is at most 100 characters but doesn't strip or reject control characters, excessive whitespace, or zero-width characters. This could lead to display issues in the donation feed.

### Background
Donation messages appear in the public donation feed on the frontend. Messages with control characters like `\n`, `\t`, `\0`, or zero-width Unicode characters can disrupt the UI layout or be used for spoofing.

### Problem Statement
While the backend is not the primary UI layer, sanitizing donation messages server-side before storage prevents malformed data from entering the database and being served to all clients.

### Objectives
- Add a Zod `.refine()` or `.transform()` to `donationSchema.message` that strips or rejects control characters and trims excessive whitespace
- Ensure the message is trimmed and normalized before storage

### Scope

**In Scope**
- `donationSchema.message` refinement in `schemas.js`
- Backend-level sanitization

**Out of Scope**
- Frontend sanitization (separate concern)
- Historical data cleanup

### Implementation Plan
1. Add a `.transform((s) => s?.replace(/[\x00-\x1F\x7F]/g, "").replace(/\s+/g, " ").trim())` or similar to the message field in `donationSchema`
2. Ensure the transformed value is what gets stored
3. Add a test to `schemas.test.js` verifying control characters are stripped

### Expected Files or Components
- `backend/src/validators/schemas.js`
- `backend/src/validators/schemas.test.js`

### Acceptance Criteria
- Control characters stripped from donation messages
- Multiple spaces collapsed to single space
- Messages trimmed
- Test verifies the transformation

### Testing Requirements
- Unit test for schema refinement

### CI Requirements
- `npm run lint`
- `npm test`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Message sanitization added to schema
- [ ] Test added
- [ ] CI green

### References
- `backend/src/validators/schemas.js` — `donationSchema`
- `backend/src/validators/schemas.test.js`

---

## Issue #016 — Backend: Add cache invalidation for impact endpoints when project status changes

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/bug`, `priority/medium`

### Summary
When a project's status is updated via `PATCH /api/projects/:id/status`, the cache invalidation covers project detail, list, and global stats. However, the impact endpoint cache keys (`cache:v1:impact:project:<id>` and `cache:v1:impact:global`) are not invalidated, so the impact dashboard may serve stale data after a status change.

### Background
The cache invalidation logic is documented in `docs/api.md` under "Cache invalidation". The impact endpoints were added after the cache invalidation was initially designed, and their cache keys are not invalidated on project status changes.

### Problem Statement
Stale impact data is served for up to 300 seconds after a project is paused, completed, or rejected. For the transparency/impact dashboard, this is a data freshness bug.

### Objectives
- Add `cache:v1:impact:project:<id>` and `cache:v1:impact:global` to the invalidation list for `PATCH /api/projects/:id/status`

### Scope

**In Scope**
- Cache invalidation update in the project status update handler

**Out of Scope**
- Other mutation endpoints
- Changing cache TTLs

### Implementation Plan
1. Locate the status update handler in `backend/src/routes/projects.js` (the `PATCH /:id/status` route or equivalent)
2. Add `await invalidateCache(...)` calls for the impact cache keys
3. Verify with `backend/src/routes/projects.test.js`

### Expected Files or Components
- `backend/src/routes/projects.js`
- `docs/api.md` — update the cache invalidation table

### Acceptance Criteria
- Impact cache keys are invalidated on project status change
- Docs updated

### Testing Requirements
- Verify via test that cache is cleared after status change

### CI Requirements
- Standard backend CI

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Impact cache keys invalidated
- [ ] Docs updated
- [ ] CI green

### References
- `docs/api.md` — "Cache invalidation" section
- `backend/src/routes/projects.js`

---

## Issue #017 — Backend: Add `GEOCODING_ERROR` to `ERROR_CODES` taxonomy

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/improvement`, `priority/low`

### Summary
When geocoding fails in `POST /api/projects`, the backend logs a warning but doesn't return any structured error code to the client. The `ERROR_CODES` taxonomy in `backend/src/errors.js` doesn't include a geocoding-specific error code.

### Background
`backend/src/errors.js` has a comprehensive error code taxonomy with codes like `PROJECT_NOT_FOUND`, `INVALID_ADDRESS`, `TX_FAILED`, etc. Geocoding failures are handled silently — the project is created without coordinates but the client isn't informed.

### Problem Statement
Clients creating projects should know when geocoding failed so they can correct the location string, rather than discovering later that their project doesn't appear on the map.

### Objectives
- Add `GEOCODING_ERROR` to `ERROR_CODES` (status 400 or 422)
- Instead of silently swallowing geocoding errors, return a warning in the response body so the client can show it to the user
- Do NOT fail the project creation — just surface the warning

### Scope

**In Scope**
- New error code
- Warning in the project creation response when geocoding fails

**Out of Scope**
- Changing the geocoding service itself
- Retry logic

### Implementation Plan
1. Add `GEOCODING_ERROR: { status: 422, message: "Could not geocode the provided location" }` to `ERROR_CODES`
2. In the project creation handler, when geocoding returns null, add a `warnings: [{ code: "GEOCODING_ERROR", message: "..." }]` field to the response

### Expected Files or Components
- `backend/src/errors.js`
- `backend/src/routes/projects.js`

### Acceptance Criteria
- Geocoding failure returns a warning in the response
- Project is still created successfully
- Test verifies the warning field

### Testing Requirements
- Test the warning field in the 201 response when geocoding fails

### CI Requirements
- Standard backend CI

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Error code added
- [ ] Warning surfaced in response
- [ ] CI green

### References
- `backend/src/errors.js`
- `backend/src/routes/projects.js` — `POST /` handler
- `backend/src/services/geocoder.js`

---

## Issue #018 — Backend: Validate `tags` array length and individual tag length in project submission

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/improvement`, `priority/medium`

### Summary
The `projectSubmissionSchema` in `backend/src/validators/schemas.js` accepts `tags` as `z.array(z.string())` with no length constraints. An attacker could submit a project with thousands of tags or tags with excessively long strings, causing database bloat.

### Background
Tags are stored as a PostgreSQL text array (`tags TEXT[]`) and used in full-text search. The schema has no `.max()` on the array or `.max()` on individual tag strings.

### Problem Statement
Unbounded array input can cause:
- Database bloat (large text arrays)
- Search index bloat
- Potential DoS via memory exhaustion during tag processing

### Objectives
- Add `.max(10)` to the tags array and `.max(50)` to each tag string
- Add a `.refine()` to reject empty strings in tags

### Scope

**In Scope**
- `projectSubmissionSchema` tag validation
- Test updates

**Out of Scope**
- Frontend validation (handled by `submitProjectSchema` in `frontend/lib/validation.ts`)

### Implementation Plan
1. Update the `tags` field in `projectSubmissionSchema`:
   ```js
   tags: z.array(z.string().min(1).max(50)).max(10).optional().default([])
   ```
2. Add test cases in `schemas.test.js` for exceeding max tags and tag length

### Expected Files or Components
- `backend/src/validators/schemas.js`
- `backend/src/validators/schemas.test.js`

### Acceptance Criteria
- More than 10 tags rejected
- Individual tags > 50 chars rejected
- Empty tags rejected
- Tests pass

### Testing Requirements
- Unit tests for the schema

### CI Requirements
- Standard backend CI

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Tag validation added
- [ ] Tests added
- [ ] CI green

### References
- `backend/src/validators/schemas.js` — `projectSubmissionSchema`
- `frontend/lib/validation.ts` — `submitProjectSchema` for parity

---

## Issue #019 — Backend: Add rate limit configuration for attestations, oracle, and map endpoints

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/improvement`, `priority/medium`

### Summary
The rate limit configuration in `backend/src/services/rateLimitConfig.js` has per-endpoint tiers for core endpoints (donations, projects, profiles, etc.) but doesn't explicitly configure limits for newer endpoints: `/api/attestations`, `/api/oracle`, and `/api/map`. These fall back to the catch-all default, which may not be appropriate.

### Background
The rate limiting documentation in `docs/api.md` lists explicit configurations for map (`GET /api/map`, 60 req/60s) but the attestations and oracle endpoints are newer and may be using the catch-all default (150 req/900s). This is too permissive for potentially expensive attestation proof minting or oracle price serving.

### Objectives
- Add explicit rate limit entries for attestations and oracle endpoints
- Review and adjust the map endpoint rate limit if needed
- Update `docs/api.md` with new entries

### Scope

**In Scope**
- `rateLimitConfig.js` updates
- Documentation updates

**Out of Scope**
- Changing the rate limiting middleware itself

### Implementation Plan
1. Examine `backend/src/services/rateLimitConfig.js` (or wherever rate limit config is defined)
2. Add entries for:
   - `POST /api/attestations` — 10 req / 60s
   - `GET /api/attestations` — 60 req / 60s
   - `GET /api/oracle/price` — 60 req / 60s
3. Update `docs/api.md` table

### Expected Files or Components
- `backend/src/services/rateLimitConfig.js`
- `docs/api.md`

### Acceptance Criteria
- New endpoints have explicit rate limits
- Documentation matches implementation
- Existing rate limit tests pass

### Testing Requirements
- Verify rate limit is applied to new endpoints (extend rate limiter tests)

### CI Requirements
- Standard backend CI

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Rate limits configured
- [ ] Docs updated
- [ ] CI green

### References
- `docs/api.md` — rate limit table
- `backend/src/middleware/rateLimiter.js`

---

## Issue #020 — Backend: Standardize error response format in admin routes to use `sendAppError`

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/improvement`, `priority/low`

### Summary
Several admin route handlers in `backend/src/routes/admin.js` use inline `res.status().json()` for errors instead of the shared `sendAppError` helper, resulting in inconsistent error shapes. The main routes use `sendAppError` consistently, but some admin sub-routes don't.

### Background
`sendAppError(res, code, metadata)` from `backend/src/errors.js` produces a canonical error shape: `{ error: { code, message, ...metadata } }`. Some admin handlers return `{ error: "message" }` (a plain string) or `{ success: false, error: "..." }`.

### Problem Statement
Inconsistent error shapes make frontend error handling fragile. The `QueryErrorFallback` component and admin error handling rely on the `{ error: { code } }` shape.

### Objectives
- Replace inline error responses in admin routes with `sendAppError` calls
- Ensure all admin error responses have the canonical shape

### Scope

**In Scope**
- `backend/src/routes/admin.js` and admin sub-routers

**Out of Scope**
- Non-admin routes (already consistent)
- Changing error codes

### Implementation Plan
1. Audit admin routes for inline `res.status().json({ error: ... })` calls
2. Replace with `sendAppError(res, "CODE", { ... })` using appropriate error codes
3. Run admin route tests

### Expected Files or Components
- `backend/src/routes/admin.js`
- `backend/src/routes/admin/*.js`

### Acceptance Criteria
- All admin error responses use `sendAppError`
- Admin route tests pass
- Error shape is consistent

### Testing Requirements
- Existing admin route tests pass

### CI Requirements
- Standard backend CI

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Error responses standardized
- [ ] CI green

### References
- `backend/src/errors.js` — `sendAppError`
- `backend/src/routes/admin.js`

---

## Issue #021 — Backend: Add idempotency key format validation in donation recording middleware

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/improvement`, `priority/medium`

### Summary
The idempotency middleware (`backend/src/middleware/idempotency.js`) reads the `Idempotency-Key` header but doesn't validate its format. Malformed or excessively long keys could be stored in Redis and PostgreSQL without validation.

### Background
The frontend generates idempotency keys using `safeRandomUUID()` (`frontend/utils/uuid.ts`) which produces UUIDv4 values. The backend should validate that incoming keys look like UUIDs before storing them.

### Problem Statement
Without format validation, a misconfigured client or malicious actor could send arbitrary strings as idempotency keys, consuming Redis memory for non-standard keys.

### Objectives
- Add UUID format validation for the `Idempotency-Key` header
- Reject keys that don't match UUID format with a 400 response

### Scope

**In Scope**
- Idempotency middleware validation
- Test updates

**Out of Scope**
- Changing key generation on the frontend

### Implementation Plan
1. In the idempotency middleware, add a check: if the key doesn't match UUID format, return 400
2. Use the existing `UUID_RE` regex from `backend/src/validators/schemas.js`
3. Add a test case for invalid key format

### Expected Files or Components
- `backend/src/middleware/idempotency.js` (or wherever idempotency logic lives)
- `backend/__tests__/middleware/idempotency.test.js`

### Acceptance Criteria
- Non-UUID idempotency keys rejected with 400
- Valid UUID keys processed normally
- Test passes

### Testing Requirements
- Unit test for invalid key format

### CI Requirements
- Standard backend CI

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] UUID validation added
- [ ] Test added
- [ ] CI green

### References
- `backend/src/validators/schemas.js` — `UUID_RE`
- `backend/__tests__/middleware/idempotency.test.js`

---

## Issue #022 — Backend: Add periodic cleanup job for expired token blacklist entries

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/improvement`, `priority/medium`

### Summary
`blacklistAccessToken` in `backend/src/middleware/auth.js` inserts blacklist entries with `expires_at` matching the access token's natural expiry (15 minutes). Entries are filtered by `expires_at > NOW()` on lookup, but expired entries are never physically deleted. Over time, the `token_blacklist` table accumulates dead rows.

### Background
Token blacklisting is a defense-in-depth mechanism for admin logout. Each logout inserts one row; entries naturally expire after 15 minutes. With sufficient admin activity, this table grows continuously. The retention policy system already handles other tables, but `token_blacklist` is omitted.

### Problem Statement
Unbounded growth of the `token_blacklist` table wastes disk space and slows queries on the blacklist check (`isBlacklisted`).

### Objectives
- Add a retention policy for `token_blacklist` in `backend/src/config/retentionPolicies.js` to delete rows where `expires_at < NOW()` on a schedule (e.g., hourly)

### Scope

**In Scope**
- New retention policy entry
- Registration with the retention worker

**Out of Scope**
- Changing the token blacklist mechanism itself

### Implementation Plan
1. Add a policy to `retentionPolicies.js`:
   ```js
   {
     name: "token-blacklist-delete",
     table: "token_blacklist",
     strategy: "delete",
     retentionPeriod: { value: 0, unit: "hours" },
     schedule: { cron: "0 * * * *", timezone: "UTC" },
     condition: "expires_at < NOW()",
     description: "Purges expired access-token blacklist entries"
   }
   ```
2. Add `token_blacklist` to the table allow-list in `retentionWorker.js`
3. Add a test in `retentionWorker.test.js`

### Expected Files or Components
- `backend/src/config/retentionPolicies.js`
- `backend/src/services/retentionWorker.js`
- `backend/src/services/retentionWorker.test.js`

### Acceptance Criteria
- Expired token blacklist entries are purged on schedule
- Retention policy test passes
- Existing retention tests pass

### Testing Requirements
- Unit test for the new policy
- Integration test verifying rows are deleted

### CI Requirements
- Standard backend CI

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Retention policy added
- [ ] Table allow-listed
- [ ] Test added
- [ ] CI green

### References
- `backend/src/config/retentionPolicies.js`
- `backend/src/services/retentionWorker.js`
- `backend/src/middleware/auth.js` — `blacklistAccessToken`

---

## Issue #023 — Backend: Add minimum and maximum campaign duration validation

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/improvement`, `priority/low`

### Summary
Campaign creation (`POST /api/projects/:id/campaigns`) validates that the deadline is in the future but doesn't enforce a minimum or maximum campaign duration. A campaign with a deadline 5 minutes in the future or 100 years in the future would be accepted.

### Background
The campaign deadline is validated only as `deadlineDate.getTime() > Date.now()`. There's no minimum duration (a campaign ending in 1 minute makes no sense) and no maximum duration (a campaign ending in 2050 could cause UI issues).

### Problem Statement
Extreme campaign durations are nonsensical and could cause display issues in campaign progress bars, matching pool logic, or subscription reminders.

### Objectives
- Add a minimum campaign duration of 1 day and a maximum of 2 years
- Return clear validation errors when these bounds are violated

### Scope

**In Scope**
- Validation logic in `POST /:id/campaigns` (or better, in the Zod schema from Issue #013)

**Out of Scope**
- Changing the campaign model

### Implementation Plan
1. If Issue #013 is also being worked on, add the constraints to `campaignSchema`:
   - `deadline` must be at least 24 hours from now
   - `deadline` must be at most 730 days from now
2. Otherwise, add the checks inline
3. Add a test case for too-short and too-far deadlines

### Expected Files or Components
- `backend/src/validators/schemas.js` (if Issue #013 done)
- `backend/src/routes/projects.js`
- `backend/src/routes/projects.test.js` (if tests exist)

### Acceptance Criteria
- Deadlines < 24h from now rejected
- Deadlines > 2 years from now rejected
- Error messages clear

### Testing Requirements
- Test cases for boundary deadlines

### CI Requirements
- Standard backend CI

### Deliverables
- Single commit (can be combined with Issue #013)
- Changelog entry

### Definition of Done
- [ ] Duration validation added
- [ ] Tests added
- [ ] CI green

### References
- `backend/src/routes/projects.js` — campaign creation
- `backend/src/validators/schemas.js`

---

## Issue #024 — Backend: Add UUID validation for route parameters before database queries

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/improvement`, `priority/medium`

### Summary
Several route handlers extract path parameters (like `:id` or `:projectId`) and pass them directly to PostgreSQL queries without validating that they are valid UUIDs. PostgreSQL will reject malformed UUIDs, but the error surfaces as a generic 500 `DB_ERROR` instead of a clean 400 validation error.

### Background
The `uuid` validator from `backend/src/validators/schemas.js` is already imported in `projects.js` but only used in some places. Routes like `GET /api/projects/:id`, `POST /api/projects/:id/campaigns`, and `GET /api/jobs/:id` pass raw parameter values to SQL.

### Problem Statement
Malformed UUIDs in request paths cause 500 errors (with Sentry noise) instead of clean 400 validation errors.

### Objectives
- Add `validate(paramsSchema, "params")` middleware to routes that accept UUID path parameters, where `paramsSchema` validates the `id` field
- Or add inline checks using `uuidValidator.safeParse(req.params.id)`

### Scope

**In Scope**
- UUID validation on route params for projects, donations, jobs, updates, and milestones

**Out of Scope**
- Query parameters
- Body fields (already validated by Zod schemas)

### Implementation Plan
1. Define a reusable `uuidParamsSchema` in `schemas.js`:
   ```js
   const uuidParamsSchema = z.object({ id: uuid });
   ```
2. Apply `validate(uuidParamsSchema, "params")` to routes with `:id` params
3. Add tests that send malformed UUIDs and expect 400

### Expected Files or Components
- `backend/src/validators/schemas.js`
- `backend/src/routes/projects.js`
- `backend/src/routes/donations.js`
- `backend/src/routes/jobs.js`
- `backend/src/routes/updates.js`

### Acceptance Criteria
- Malformed UUID path params return 400 with structured validation error
- Valid UUIDs pass through unaffected
- Existing tests pass

### Testing Requirements
- Add malformed UUID test cases to existing route tests

### CI Requirements
- Standard backend CI

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] UUID validation added to all relevant routes
- [ ] Tests added
- [ ] CI green

### References
- `backend/src/validators/schemas.js` — `uuid`
- `backend/src/middleware/validate.js`

---

## Issue #025 — Backend: Add test for milestone cache invalidation on project status change

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/testing`, `priority/medium`

### Summary
Project milestones are cached in Redis (`cache:v1:projects:milestones:<id>`). When a project's status changes to `completed` or `paused`, the milestones cache should be invalidated so clients see the fresh status. There's no explicit test verifying that the milestones cache key is invalidated on status change.

### Background
The milestones cache has a 5-minute TTL. If a project is paused, its milestones should reflect that — but without cache invalidation, clients see stale milestone data for up to 5 minutes.

### Problem Statement
Cache invalidation bugs are easy to introduce and hard to notice. A test that explicitly verifies the cache key is deleted after a status change prevents regressions.

### Objectives
- Add a test (or extend an existing test) that verifies `cache:v1:projects:milestones:<id>` is deleted when project status is updated
- If the cache invalidation is missing, add it

### Scope

**In Scope**
- Test for milestone cache invalidation
- Fix if missing

**Out of Scope**
- Other cache keys

### Implementation Plan
1. Check if `PATCH /:id/status` already invalidates the milestones cache (read `backend/src/routes/projects.js`)
2. If missing, add `await invalidateCache(getProjectMilestonesCacheKey(id))` or equivalent
3. Add a test: put a value in the cache, call the status update, assert the cache key no longer exists

### Expected Files or Components
- `backend/src/routes/projects.js`
- `backend/src/routes/projects.test.js`

### Acceptance Criteria
- Milestone cache invalidated on status change
- Test verifies the invalidation

### Testing Requirements
- Integration test with Redis mock

### CI Requirements
- Standard backend CI

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Cache invalidation verified/fixed
- [ ] Test added
- [ ] CI green

### References
- `backend/src/routes/projects.js` — milestone endpoints and cache keys
- `backend/src/middleware/cache.js`

---

## Issue #026 — Frontend: Remove duplicate donation recording call in `DonateForm`

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/bug`, `priority/high`

### Summary
In `frontend/components/DonateForm.tsx`, the standard payment (non-contract) flow calls `recordDonationMutation.mutateAsync(...)` followed by a duplicate `recordDonation(...)` call. This causes two API calls per donation, potentially creating duplicate donation records (the backend deduplicates by transaction hash, but the second call is wasted).

### Background
The standard payment flow in `handleDonate` has this sequence:
```tsx
setStep("recording");
await recordDonationMutation.mutateAsync({...});  // first call
// ...
setStep("recording");   // <-- duplicate step
await recordDonation({...});                        // second (duplicate) call
```

The contract donation flow only calls `recordDonationMutation.mutateAsync` once. This inconsistency suggests the duplicate was introduced accidentally.

### Problem Statement
Every standard donation triggers two `POST /api/donations` calls. The backend deduplicates by `transactionHash`, so the second call is harmless but wasteful — it consumes network bandwidth, server resources, and rate limit budget.

### Objectives
- Remove the duplicate `recordDonation(...)` call
- Remove the duplicate `setStep("recording")` line
- Ensure only one recording call is made per donation

### Scope

**In Scope**
- `DonateForm.tsx` — standard payment flow in `handleDonate`

**Out of Scope**
- Contract donation flow (already correct)
- Offline donation flow

### Implementation Plan
1. Delete the second `setStep("recording")` and the `recordDonation(...)` call that follows it
2. Verify the flow still works: `recordDonationMutation.mutateAsync` is the canonical path

### Expected Files or Components
- `frontend/components/DonateForm.tsx`

### Acceptance Criteria
- Only one `POST /api/donations` call per standard donation
- Donation flow still completes successfully
- No visual or functional regression

### Testing Requirements
- Run existing DonateForm tests
- Manual smoke test: make a testnet donation and verify only one network call

### CI Requirements
- `npm run type-check`
- `npm run lint`
- `npm test`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Duplicate call removed
- [ ] CI green

### References
- `frontend/components/DonateForm.tsx` — `handleDonate` function, standard payment section
- `frontend/lib/api.ts` — `recordDonation`

---

## Issue #027 — Frontend: Add error handling for wallet disconnection during donation flow

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/bug`, `priority/medium`

### Summary
If the user's Freighter wallet disconnects or the user switches accounts mid-donation-flow, the `DonateForm` component doesn't handle the resulting error gracefully. The `signTransactionWithWallet` call will fail, and the error handling in the `catch` block shows a generic error message without distinguishing wallet-disconnection from other errors.

### Background
`signTransactionWithWallet` from `frontend/lib/wallet.ts` communicates with the Freighter browser extension. If the user closes Freighter, switches accounts, or the extension becomes unresponsive, the signing promise rejects. The current `catch` block shows the error message as-is without contextual guidance.

### Problem Statement
Users who accidentally disconnect mid-donation see an unhelpful error message ("An error occurred") and must reconnect manually. The flow should detect wallet disconnection and prompt reconnection.

### Objectives
- Detect Freighter disconnection in the `catch` block
- Show a specific message: "Wallet disconnected. Please reconnect and try again."
- Mark the step as `error` with clear recovery instructions

### Scope

**In Scope**
- `DonateForm.tsx` error handling
- Detection of wallet disconnection error

**Out of Scope**
- Auto-reconnection logic
- Other components

### Implementation Plan
1. In the `catch` block, check if the error message includes Freighter-specific disconnection strings (e.g., "not connected", "user rejected", "Freighter")
2. Set a specific error message for wallet disconnection
3. Set `step` to `error` and provide a "Reconnect" button or message

### Expected Files or Components
- `frontend/components/DonateForm.tsx`
- `frontend/lib/wallet.ts` (to check what error messages Freighter throws)

### Acceptance Criteria
- Wallet disconnection shows a specific, helpful error message
- User knows they need to reconnect
- Other errors show generic messages

### Testing Requirements
- Unit test mocking `signTransactionWithWallet` to throw a Freighter disconnection error
- Verify the error message is specific

### CI Requirements
- `npm run type-check`
- `npm run lint`
- `npm test`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Wallet disconnection handled
- [ ] Tests added
- [ ] CI green

### References
- `frontend/components/DonateForm.tsx` — `handleDonate`
- `frontend/lib/wallet.ts`

---

## Issue #028 — Frontend: Add ARIA live region announcements for donation form validation errors

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/a11y`, `priority/medium`

### Summary
The `DonateForm` has a hidden `aria-live="polite"` region that announces step changes ("Building transaction…", "Awaiting wallet signature…"). However, validation errors (invalid amount, message too long) are only shown visually and aren't announced to screen readers.

### Background
The form uses `useFormValidation` which returns `errors` (a map of field names to error messages). Errors are displayed below inputs with `role="alert"` but the donation amount error is shown with `aria-invalid` and no live announcement.

### Problem Statement
Screen reader users don't hear validation errors when they click "Donate" with invalid input. The button stays disabled, but there's no audible feedback about what's wrong.

### Objectives
- Add an `aria-live="assertive"` region that announces validation errors
- Update the region with error text when validation fails

### Scope

**In Scope**
- ARIA live region for validation errors in `DonateForm`

**Out of Scope**
- Other form components
- `FormField` component changes

### Implementation Plan
1. Add a hidden `<div aria-live="assertive" className="sr-only">` near the validation error display
2. Populate it with the first validation error message when validation fails
3. Use a `useEffect` to update the live region content

### Expected Files or Components
- `frontend/components/DonateForm.tsx`

### Acceptance Criteria
- Validation errors are announced by screen readers
- Live region updates when user clicks "Donate" with invalid input
- No visual change for sighted users

### Testing Requirements
- The project already has jest-axe configured. Run `npm test` to verify no a11y regressions
- Consider adding a test that checks the live region content

### CI Requirements
- `npm run type-check`
- `npm run lint`
- `npm test` (includes a11y checks via jest-axe)

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] ARIA live region added
- [ ] Tests pass
- [ ] CI green

### References
- `frontend/components/DonateForm.tsx` — existing `aria-live="polite"` pattern
- `frontend/components/FormField.tsx` — error display pattern

---

## Issue #029 — Frontend: Add debouncing for project search input on the projects page

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/improvement`, `priority/medium`

### Summary
The project search input on the projects listing page fires API requests on every keystroke without debouncing. This causes excessive API calls, wastes rate limit budget, and creates unnecessary load on the backend.

### Background
The search query is likely passed to `fetchProjects({ search: query })` or similar. Rapid typing (e.g., "reforestation") triggers 13 API calls in sequence. The backend has a generous rate limit for `GET /api/projects` (100 req/60s), but this is still wasteful.

### Problem Statement
Excessive API calls during search typing waste bandwidth, increase latency for all users, and unnecessarily consume rate limit budget.

### Objectives
- Add a 300ms debounce to the search input before triggering API calls
- Use a `useDebounce` hook or implement inline

### Scope

**In Scope**
- Projects listing page search input
- Global search modal (if applicable)

**Out of Scope**
- Other filters (category, status) — these are dropdown selections, not free-text

### Implementation Plan
1. Implement a `useDebouncedValue` hook (or use a library like `use-debounce` if already in dependencies)
2. Apply it to the search input's value before passing to the API call
3. Ensure the debounced value resets when the input is cleared

### Expected Files or Components
- `frontend/pages/projects/index.tsx` (or wherever the projects list/search lives)
- `frontend/components/GlobalSearchModal.tsx`

### Acceptance Criteria
- API call fires at most once per 300ms during fast typing
- No API call on every keystroke
- Search functionality unchanged

### Testing Requirements
- Unit test verifying debounce behavior
- Manual test: open Network tab, type quickly, verify fewer API calls

### CI Requirements
- `npm run type-check`
- `npm run lint`
- `npm test`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Debounce applied to search input
- [ ] Tests pass
- [ ] CI green

### References
- `frontend/pages/index.tsx` — main page with project listing
- `frontend/components/GlobalSearchModal.tsx`

---

## Issue #030 — Frontend: Move inline empty states to a shared `EmptyState` component

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/improvement`, `priority/low`

### Summary
Multiple pages render inline empty-state messages (e.g., "No projects found", "No donations yet", "No updates posted") using ad-hoc `<div>` markup. These should be consolidated into a single accessible `EmptyState` component that supports different variants (with icon, title, description, optional CTA).

### Background
The project already has shared components like `Skeleton`, `Navbar`, `FormField`, etc. An `EmptyState` component would reduce duplication and ensure all empty states are consistent and accessible.

### Problem Statement
Inconsistent empty states across pages create a fragmented user experience and duplicate markup that's harder to maintain.

### Objectives
- Create an `EmptyState` component with props: `icon?`, `title`, `description?`, `action?` (a ReactNode for a CTA button)
- Replace inline empty states in at least 3 pages/components

### Scope

**In Scope**
- New `EmptyState` component
- Replacement in 3+ pages

**Out of Scope**
- Full page-by-page audit and replacement of ALL empty states

### Implementation Plan
1. Create `frontend/components/EmptyState.tsx`
2. Support variants: `search` (no results), `empty` (no data), `error` (failed to load)
3. Add Storybook story
4. Replace inline empty states in: projects listing, donations feed, project updates

### Expected Files or Components
- `frontend/components/EmptyState.tsx` (new)
- `frontend/pages/index.tsx` (or projects page)
- `frontend/components/DonationFeed.tsx`
- `frontend/components/ProjectUpdates.tsx`

### Acceptance Criteria
- `EmptyState` component renders with icon, title, description, optional CTA
- At least 3 pages use the component
- Accessible (proper heading levels, semantic HTML)
- Storybook story exists

### Testing Requirements
- Add jest test for the component with basic props
- Storybook smoke build succeeds

### CI Requirements
- `npm run type-check`
- `npm run lint`
- `npm test`
- `npm run build-storybook`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Component created
- [ ] 3+ usages replaced
- [ ] Tests + Storybook added
- [ ] CI green

### References
- `frontend/components/Skeleton.tsx` — example of a shared presentational component
- `frontend/components/DonationFeed.tsx`

---

## Issue #031 — Frontend: Add keyboard accessibility for Leaflet map markers on `ProjectMap`

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/a11y`, `priority/medium`

### Summary
The `ProjectMap` component uses Leaflet to render an interactive map with project markers. Leaflet's default markers are `<img>` elements without keyboard focus or ARIA roles, making them inaccessible to keyboard-only users and screen readers.

### Background
`ProjectMap.tsx` renders markers using `react-leaflet`. The `ProjectMapMarker` component may have custom popups, but the markers themselves aren't keyboard-focusable.

### Problem Statement
Keyboard users can't navigate to map markers to view project details. The map is a primary discovery mechanism for projects, so this is a significant accessibility gap.

### Objectives
- Make map markers keyboard-focusable (add `tabIndex={0}`, `role="button"` to the marker's icon element)
- Add `aria-label` with the project name to each marker
- Add `Enter`/`Space` key handler to open the marker popup
- Ensure the existing keyboard navigation (zoom, pan) remains functional

### Scope

**In Scope**
- `ProjectMap.tsx` and/or `ProjectMapMarker.tsx`

**Out of Scope**
- Other Leaflet interactions (drawing, measuring)
- Map tile accessibility (handled by Leaflet)

### Implementation Plan
1. In the marker's `icon` configuration or the `divIcon` wrapper, add `tabIndex={0}` and `role="button"`
2. Add an `aria-label="View project: {project.name}"` attribute
3. Handle `onKeyDown` for Enter/Space to call the same handler as `onClick`
4. Use `react-leaflet`'s `eventHandlers` prop

### Expected Files or Components
- `frontend/components/ProjectMap.tsx`
- `frontend/components/ProjectMapMarker.tsx`

### Acceptance Criteria
- All project markers are keyboard-focusable
- Enter/Space opens the popup
- ARIA labels present on markers
- jest-axe pass on the map component
- Playwright a11y scan passes

### Testing Requirements
- Jest test with jest-axe verifying no a11y violations on map
- Manual keyboard navigation test

### CI Requirements
- `npm run type-check`
- `npm run lint`
- `npm test`
- `npm run a11y:scan`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Markers keyboard accessible
- [ ] ARIA labels added
- [ ] Tests + a11y scan pass
- [ ] CI green

### References
- `frontend/components/ProjectMap.tsx`
- `frontend/components/ProjectMapMarker.tsx`
- `frontend/scripts/axe-scan.mjs`

---

## Issue #032 — Frontend: Wrap interactive components in error boundaries to prevent cascade failures

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/improvement`, `priority/medium`

### Summary
Several interactive components (`DonationQRCode`, `WalletConnect`, `WalletAddressQRCode`, `WorldMap`) don't have their own error boundaries. If one of these throws during rendering, the error propagates to the page-level `ErrorBoundary`, taking down the entire page.

### Background
The project has an `ErrorBoundary` component (`frontend/lib/ErrorBoundary.tsx`) and a `QueryErrorFallback` component for data-fetching errors. But there's no component-level error boundary wrapping for isolated interactive widgets.

### Problem Statement
A rendering error in the `WalletConnect` button (e.g., due to a malformed Stellar address) shouldn't crash the entire page. Component-level error boundaries isolate failures so the rest of the page remains functional.

### Objectives
- Wrap `DonationQRCode`, `WalletConnect`, `WalletAddressQRCode`, and `WorldMap` in individual error boundaries
- Show a lightweight fallback UI ("This component could not be loaded") on error

### Scope

**In Scope**
- Error boundary wrapping for 4 components
- Simple fallback UI

**Out of Scope**
- Error recovery mechanisms
- Full-page error boundaries (already exist)

### Implementation Plan
1. Create (or reuse) a lightweight `ComponentErrorBoundary` that catches render errors and shows a fallback
2. Wrap each of the 4 components in their parent render with the error boundary
3. Test by intentionally breaking each component to verify isolation

### Expected Files or Components
- `frontend/lib/ErrorBoundary.tsx`
- `frontend/components/DonationQRCode.tsx`
- `frontend/components/WalletConnect.tsx`
- `frontend/components/WalletAddressQRCode.tsx`
- `frontend/components/WorldMap.tsx`

### Acceptance Criteria
- Component error doesn't crash the full page
- Fallback UI is shown for the failed component
- Rest of the page works normally

### Testing Requirements
- Unit test: render a broken child inside the error boundary, assert fallback renders
- Existing tests continue to pass

### CI Requirements
- `npm run type-check`
- `npm run lint`
- `npm test`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Components wrapped in error boundaries
- [ ] Fallback UI implemented
- [ ] Tests pass
- [ ] CI green

### References
- `frontend/lib/ErrorBoundary.tsx`
- `frontend/components/WalletConnect.tsx`

---

## Issue #033 — Frontend: Add retry configuration for React Query hooks based on endpoint characteristics

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/improvement`, `priority/medium`

### Summary
React Query hooks in `frontend/hooks/queries.ts` use default retry behavior (3 retries with exponential backoff) for all queries. This is inappropriate for 4xx errors (e.g., 404, 403, 422) which will never succeed on retry and waste resources.

### Background
The frontend uses `@tanstack/react-query` for data fetching. The default `retry` is 3, which applies to all failures including client errors. The `queryErrors.ts` module already classifies errors as retryable or not, but this classification isn't used in the React Query configuration.

### Problem Statement
Retrying 404s and 403s wastes bandwidth, increases latency, and creates unnecessary Sentry noise from failed retries.

### Objectives
- Configure React Query's `retry` to use the `classifyError` function from `queryErrors.ts`: retry network, 429, and 5xx errors; do NOT retry 4xx errors

### Scope

**In Scope**
- React Query default options configuration
- Integration with `classifyError`

**Out of Scope**
- Per-query retry overrides (can be done later)
- Mutation retry logic

### Implementation Plan
1. In the React Query `QueryClient` setup (likely in `_app.tsx` or a provider), add a `retry` function to the default options:
   ```ts
   retry: (failureCount, error) => {
     const classified = classifyError(error);
     if (!classified.retryable) return false;
     return failureCount < 3;
   }
   ```
2. Ensure `classifyError` is imported
3. Test: mock a 404 response, verify retries don't happen

### Expected Files or Components
- `frontend/pages/_app.tsx` (or wherever `QueryClientProvider` is configured)
- `frontend/lib/queryErrors.ts`

### Acceptance Criteria
- 4xx errors are NOT retried
- 5xx, 429, and network errors ARE retried (up to 3 times)
- No functional regression in data fetching

### Testing Requirements
- Unit test for the retry function
- Verify React Query behavior with mocked API

### CI Requirements
- `npm run type-check`
- `npm run lint`
- `npm test`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Retry logic configured
- [ ] Test added
- [ ] CI green

### References
- `frontend/lib/queryErrors.ts` — `classifyError`
- `frontend/hooks/queries.ts` (if exists, otherwise wherever queries are defined)

---

## Issue #034 — Frontend: Add i18n coverage audit and fill missing translation keys

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/improvement`, `priority/medium`

### Summary
The project supports English, French, and Spanish via `frontend/locales/{en,fr,es}.json`. As new components and features have been added, some UI strings may only exist in `en.json` and be missing from `fr.json` and `es.json`. The project already has a locale parity check script (`scripts/check-locale-parity.js`).

### Background
`frontend/scripts/check-locale-parity.js` checks that all locale files have the same keys. Running this script may reveal missing keys that need to be filled.

### Problem Statement
Missing translations cause fallback to English keys or empty strings in the French and Spanish UIs. This degrades the experience for non-English users.

### Objectives
- Run `check-locale-parity.js` and identify missing keys
- Add English fallback values for any truly new keys
- Mark missing translations with TODO comments for community translators
- Ensure all three locale files have identical key sets

### Scope

**In Scope**
- Running the parity check script
- Filling missing keys with English fallbacks

**Out of Scope**
- Translating ALL strings to French/Spanish (can be separate community efforts)
- Adding new languages

### Implementation Plan
1. Run `node scripts/check-locale-parity.js`
2. For each missing key in `fr.json` and `es.json`, add the key with the English value and a `// TODO: translate` comment
3. Re-run the script until it passes

### Expected Files or Components
- `frontend/locales/en.json`
- `frontend/locales/fr.json`
- `frontend/locales/es.json`
- `frontend/scripts/check-locale-parity.js`

### Acceptance Criteria
- `check-locale-parity.js` exits with 0 and no errors
- All three locale files have identical keys
- No broken UI in French/Spanish modes

### Testing Requirements
- Run `npm run test:i18n-parity`
- Manual smoke test: switch to French and Spanish, browse key pages

### CI Requirements
- `npm run type-check`
- `npm run lint`
- `npm run test:i18n-parity`
- `npm test`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Locale parity check passes
- [ ] CI green

### References
- `frontend/locales/en.json`
- `frontend/scripts/check-locale-parity.js`

---

## Issue #035 — Frontend: Add test coverage for offline donation queuing flow in DonateForm

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/testing`, `priority/medium`

### Summary
The `DonateForm` component has an offline donation queue flow that saves donations to localStorage when the user is offline. This flow is implemented but has no dedicated unit tests verifying correct behavior.

### Background
When `isOnline` is false, `handleDonate` calls `queueDonation(...)` from `frontend/lib/offlineDonationQueue.ts` instead of submitting to the network. The component tests (if they exist) likely mock `isOnline` as `true` and miss the offline path entirely.

### Problem Statement
Without test coverage, a regression in the offline queuing flow could silently break the offline donation experience for users with poor connectivity.

### Objectives
- Add a test case where `useOnlineStatus` returns `false`
- Verify `queueDonation` is called with the correct payload
- Verify the success message mentions offline queuing

### Scope

**In Scope**
- DonateForm test for offline flow

**Out of Scope**
- Testing the `offlineDonationQueue` module itself (separate issue)

### Implementation Plan
1. Find or create the DonateForm test file
2. Add a test: mock `useOnlineStatus` to return `false`, render DonateForm, fill in amount, click Donate, assert:
   - `queueDonation` was called
   - Error/success message mentions queuing
   - No network call was made

### Expected Files or Components
- `frontend/components/__tests__/DonateForm.test.tsx` (or wherever DonateForm tests live)
- `frontend/hooks/useOnlineStatus.ts`
- `frontend/lib/offlineDonationQueue.ts`

### Acceptance Criteria
- Test verifies offline queuing behavior
- Test passes
- Existing tests pass

### Testing Requirements
- One new unit test

### CI Requirements
- `npm test`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Offline queuing test added
- [ ] CI green

### References
- `frontend/components/DonateForm.tsx` — offline path in `handleDonate`
- `frontend/lib/offlineDonationQueue.ts`

---

## Issue #036 — Frontend: Implement project map marker clustering for performance

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/improvement`, `priority/medium`

### Summary
The `ProjectMap` component renders individual markers for every project. With a growing project database (100+ projects worldwide), rendering all markers simultaneously degrades map performance and creates visual clutter in dense areas.

### Background
`react-leaflet` supports marker clustering via `react-leaflet-cluster` (or `leaflet.markercluster`). The current implementation renders each project as an individual marker without clustering.

### Problem Statement
As the project count grows, the map becomes slow to render and navigate. Clusters of overlapping markers in popular regions (e.g., multiple reforestation projects in Brazil) are visually indecipherable.

### Objectives
- Integrate marker clustering into `ProjectMap`
- Projects within close proximity should be grouped into a cluster marker showing the count
- Clicking a cluster should zoom in to reveal individual markers
- Backward compatible: single markers should still show their popup

### Scope

**In Scope**
- `ProjectMap.tsx` clustering integration
- Cluster styling to match the app's design system

**Out of Scope**
- Server-side spatial indexing (can be future optimization)
- Heatmap visualization

### Implementation Plan
1. Install a clustering library compatible with `react-leaflet` v4
2. Wrap the markers list in a cluster component
3. Style clusters with the app's color palette
4. Test with 50+ mock projects to verify performance improvement

### Expected Files or Components
- `frontend/components/ProjectMap.tsx`
- `frontend/package.json` (dependency addition)

### Acceptance Criteria
- Markers cluster when zoomed out
- Clicking a cluster zooms in and reveals individual markers
- Single markers still show their popup on click
- Map performance is noticeably better with 50+ projects
- Playwright visual regression tests still pass

### Testing Requirements
- Unit test for clustering behavior
- Playwright test for map interaction

### CI Requirements
- `npm run type-check`
- `npm run lint`
- `npm test`
- `npm run test:e2e`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Marker clustering implemented
- [ ] Tests pass
- [ ] CI green

### References
- `frontend/components/ProjectMap.tsx`
- `frontend/components/ProjectMapMarker.tsx`

---

## Issue #037 — Frontend: Add TypeScript strict null checks in form validation hooks

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/improvement`, `priority/medium`

### Summary
The `useFormValidation` hook and form components access validation results without proper null guards. For example, `errors.message` might be accessed before validation has run, or undefined fields could cause runtime errors.

### Background
Zod schemas produce `SafeParseReturnType` which includes `.success` and `.error?.issues`. The hook likely uses `safeParse` and stores results in state. TypeScript strict mode might catch some issues, but the current `tsconfig.json` may not have `strictNullChecks: true`.

### Problem Statement
Accessing `.error.issues` or `.data.field` without checking `.success` first is a common source of runtime errors in form handling.

### Objectives
- Audit `useFormValidation` hook for null safety
- Add null guards before accessing parse results
- Ensure `tsconfig.json` has `strictNullChecks: true` (or add `// @ts-expect-error` comments with justification)

### Scope

**In Scope**
- `frontend/hooks/useFormValidation.ts`
- `frontend/components/DonateForm.tsx`
- `frontend/components/FormField.tsx`

**Out of Scope**
- Full strict mode migration

### Implementation Plan
1. Read `useFormValidation.ts` to understand the hook's return type
2. Add null guards in both the hook and its consumers
3. Verify type-check passes with `npm run type-check`

### Expected Files or Components
- `frontend/hooks/useFormValidation.ts`
- `frontend/components/DonateForm.tsx`
- `frontend/components/FormField.tsx`
- `frontend/tsconfig.json` (check `strictNullChecks`)

### Acceptance Criteria
- No runtime errors from null/undefined access in form validation
- `npm run type-check` passes
- Existing form tests pass

### Testing Requirements
- Type-check must pass
- Existing tests pass

### CI Requirements
- `npm run type-check`
- `npm test`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Null guards added
- [ ] Type-check passes
- [ ] CI green

### References
- `frontend/hooks/useFormValidation.ts`
- `frontend/tsconfig.json`

---

## Issue #038 — Frontend: Add test coverage for error boundary recovery paths

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/testing`, `priority/medium`

### Summary
The `ErrorBoundary` component (`frontend/lib/ErrorBoundary.tsx`) catches render errors and shows a fallback UI, but there are no tests verifying that the fallback renders correctly and that the "Try again" button resets the error state.

### Background
The `ErrorBoundary` is a class component (React error boundaries must be class components). Testing error boundaries requires intentionally throwing in a child component and asserting the fallback renders.

### Problem Statement
Without tests, a change to the ErrorBoundary's fallback rendering or reset logic could break without detection.

### Objectives
- Add a test that renders `ErrorBoundary` with a child that throws
- Assert the fallback UI is shown
- Assert the "Try again" button resets the error state and re-renders the child

### Scope

**In Scope**
- ErrorBoundary unit tests

**Out of Scope**
- Sentry integration testing

### Implementation Plan
1. Create a test file: `frontend/lib/__tests__/ErrorBoundary.test.tsx`
2. Render `<ErrorBoundary><ComponentThatThrows /></ErrorBoundary>`
3. Assert fallback renders
4. Click "Try again", assert error state is reset

### Expected Files or Components
- `frontend/lib/ErrorBoundary.tsx`
- `frontend/lib/__tests__/ErrorBoundary.test.tsx` (new)

### Acceptance Criteria
- Test verifies fallback renders on error
- Test verifies "Try again" resets the boundary
- Test passes

### Testing Requirements
- Unit test with `@testing-library/react`

### CI Requirements
- `npm test`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Error boundary tests added
- [ ] CI green

### References
- `frontend/lib/ErrorBoundary.tsx`
- `frontend/jest.setup.ts`

---

## Issue #039 — CI: Make contract WASM size threshold configurable via environment variable

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/ci`, `type/improvement`, `priority/low`

### Summary
The contracts CI workflow (`.github/workflows/contracts.yml`) hardcodes the WASM binary size threshold at 65536 bytes. As the contract grows (new features, multi-token support, oracle integration), this threshold may need adjustment. It should be configurable via a repository variable or environment variable rather than hardcoded.

### Background
The WASM size check runs after `wasm-opt -Oz` and fails the build if the optimized binary exceeds 64KB (the Soroban upload limit). The hardcoded value means any threshold change requires a PR to the workflow file.

### Problem Statement
Hardcoded thresholds in CI workflows create unnecessary friction when the contract binary size approaches the limit. A repository variable allows maintainers to adjust the threshold without workflow changes.

### Objectives
- Replace the hardcoded `65536` with `${{ vars.WASM_SIZE_LIMIT || 65536 }}`
- Update the error message to reference the variable

### Scope

**In Scope**
- `.github/workflows/contracts.yml`

**Out of Scope**
- Other hardcoded values in CI
- Changing the contract to reduce size

### Implementation Plan
1. Change `if [ $size -gt 65536 ]` to `if [ $size -gt ${WASM_SIZE_LIMIT:-65536} ]`
2. Set the env var from `vars.WASM_SIZE_LIMIT` in the workflow
3. Update the error message

### Expected Files or Components
- `.github/workflows/contracts.yml`

### Acceptance Criteria
- WASM size threshold is configurable via `vars.WASM_SIZE_LIMIT`
- Default remains 65536 when not set

### Testing Requirements
- CI job must still run and pass

### CI Requirements
- The change is in a CI workflow — verify by running the workflow on push

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Threshold configurable
- [ ] CI workflow runs successfully
- [ ] CI green

### References
- `.github/workflows/contracts.yml` — "Check WASM size" step

---

## Issue #040 — Testing: Add integration tests for `GET /api/map` endpoint

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/testing`, `priority/medium`

### Summary
The map endpoint (`GET /api/map`) serves project coordinates for the frontend map visualization. Despite being a public-facing endpoint with cache TTL of 600s, there are no dedicated integration tests for it in the test suite.

### Background
`GET /api/map` returns a list of projects with `latitude`, `longitude`, `name`, `id`, `category`, and `status`. It likely supports region filtering. The endpoint is mounted in `server.js` under the `map` route mount.

### Problem Statement
The map endpoint is untested. A regression that breaks the coordinates format or filters would go undetected by CI.

### Objectives
- Read `backend/src/routes/map.js` to understand the endpoint
- Add integration tests covering: basic response, geo-filtering, empty result set, caching headers

### Scope

**In Scope**
- Integration tests for `GET /api/map`

**Out of Scope**
- E2E tests for the map frontend

### Implementation Plan
1. Read `backend/src/routes/map.js`
2. Create `backend/src/routes/map.test.js` (if it doesn't exist)
3. Add tests:
   - Returns 200 with project coordinates
   - Filters by region/category
   - Returns empty array when no projects match
   - Response includes cache headers

### Expected Files or Components
- `backend/src/routes/map.js`
- `backend/src/routes/map.test.js` (new or updated)

### Acceptance Criteria
- At least 3 integration tests for the map endpoint
- Tests pass
- `npm test` passes

### Testing Requirements
- Integration tests with supertest and test database

### CI Requirements
- `npm run lint`
- `npm test`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Map endpoint tests added
- [ ] CI green

### References
- `backend/src/routes/map.js`
- `backend/src/routes/projects.test.js` — example of existing route tests

---

## Issue #041 — Testing: Add contract fuzz target for escrow milestone dispute resolution

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/testing`, `priority/medium`

### Summary
The escrow contract's fuzz test (`contracts/escrow-contract/src/escrow_fuzz.rs`) covers basic job lifecycle but doesn't fuzz the milestone-level dispute and resolution flow (`dispute_milestone` + `resolve_milestone_dispute`). This path involves complex state transitions that benefit from random input testing.

### Background
The milestone dispute flow allows the admin to dispute a single milestone (not the whole job), and later resolve it with `approve` or `reject`. The state transitions involve: `Escrowed -> Disputed -> PartiallyReleased/Completed` (depending on remaining milestones). Fuzzing this path with random milestone indices and approve/reject decisions would catch edge cases.

### Problem Statement
The milestone-level dispute flow is more complex than the whole-job dispute flow and hasn't been fuzzed. A fuzz target would increase confidence in the state machine.

### Objectives
- Add a fuzz target (or proptest) that randomly:
  1. Creates a job with 1-5 milestones
  2. Disputes a random milestone
  3. Resolves it with random approve/reject
  4. Asserts the final state is valid (no unreleased disputed milestones, etc.)

### Scope

**In Scope**
- New fuzz/proptest test

**Out of Scope**
- Full job lifecycle fuzzing (already exists)

### Implementation Plan
1. Extend `escrow_fuzz.rs` or create a new file
2. Use proptest strategies to generate milestone vectors and dispute/resolution sequences
3. Assert invariants after each step

### Expected Files or Components
- `contracts/escrow-contract/src/escrow_fuzz.rs`

### Acceptance Criteria
- Fuzz test exercises milestone dispute/resolution with >100 random sequences
- Test passes locally with `cargo test` (not skipped)
- CI doesn't run fuzz tests (uses `-- --skip fuzz`)

### Testing Requirements
- New fuzz/proptest test

### CI Requirements
- `cargo test --features testutils --workspace -- --skip fuzz` (fuzz tests excluded from CI)

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Fuzz test added
- [ ] Passes locally
- [ ] CI green (fuzz skipped)

### References
- `contracts/escrow-contract/src/escrow_fuzz.rs`
- `contracts/escrow-contract/proptest-regressions/escrow_fuzz.txt`

---

## Issue #042 — CI: Add husky pre-commit hook for Rust contract formatting

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/ci`, `type/improvement`, `priority/low`

### Summary
The project has a husky pre-commit hook (`.husky/pre-commit`) that runs checks before commits. The existing hook includes a Rust formatting check (`check-rust-fmt.sh`) but it may only exist as a stub. Ensure it runs `cargo fmt --all -- --check` on changed Rust files.

### Background
`.husky/pre-commit` runs shell commands before each commit. The `.husky/check-rust-fmt.sh` script should check formatting. If it's missing or not running, contributors can commit unformatted Rust code, which then fails in CI.

### Problem Statement
Unformatted Rust code committed locally causes CI failures that could have been caught pre-commit.

### Objectives
- Verify `.husky/check-rust-fmt.sh` is functional
- Ensure it only checks staged `.rs` files (or falls back to `cargo fmt --all -- --check`)
- If the script is missing, create it

### Scope

**In Scope**
- `.husky/check-rust-fmt.sh`
- `.husky/pre-commit`

**Out of Scope**
- Adding other Rust checks (clippy) to pre-commit (that's too slow)

### Implementation Plan
1. Read `.husky/check-rust-fmt.sh` to check its current state
2. If incomplete, implement: check that `cargo fmt --all -- --check` passes for the `contracts` directory
3. Ensure `pre-commit` calls this script

### Expected Files or Components
- `.husky/check-rust-fmt.sh`
- `.husky/pre-commit`

### Acceptance Criteria
- `cargo fmt` check runs on commit
- Unformatted Rust files are caught before commit
- Pre-commit hook doesn't slow down commits significantly

### Testing Requirements
- Manual test: make a formatting change to a `.rs` file, attempt to commit, verify hook blocks it

### CI Requirements
- Not applicable (pre-commit is local)

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Pre-commit hook catches Rust formatting issues
- [ ] CI green (no formatting failures)

### References
- `.husky/pre-commit`
- `.husky/check-rust-fmt.sh`
- `.github/workflows/contracts.yml` — formatting step

---

## Issue #043 — Testing: Add performance regression check for donation recording pipeline in CI

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/testing`, `type/improvement`, `priority/medium`

### Summary
The load test script (`scripts/load-test.js`) tests the donation recording pipeline with k6 but only runs manually. A lightweight performance smoke test should run in CI to catch regressions that would cause the p95 latency to degrade below the 500ms target.

### Background
`CONTRIBUTING.md` states the donations API must sustain 100 concurrent users with p95 < 500ms. The k6 script validates this but isn't part of CI. A shorter, lower-concurrency test (e.g., 10 VUs for 30s) could run in CI without adding significant runtime.

### Problem Statement
Performance regressions are only caught when someone manually runs `k6 run scripts/load-test.js`, which may not happen before PRs are merged.

### Objectives
- Add a CI job that runs a short load test against the backend (e.g., 10 VUs, 30s duration)
- Set a generous threshold (p95 < 2s) for CI — the purpose is regression detection, not precision
- The job should be informational (not block merge) initially

### Scope

**In Scope**
- CI job for performance smoke test
- k6 script with CI-friendly parameters

**Out of Scope**
- Full-scale load testing (still manual)
- Automated performance baselining

### Implementation Plan
1. Create a `scripts/load-test-ci.js` that runs fewer iterations with a higher threshold
2. Add a job to `.github/workflows/ci.yml` or a new workflow
3. Use `continue-on-error: true` so it doesn't block PRs initially

### Expected Files or Components
- `scripts/load-test-ci.js` (new)
- `.github/workflows/ci.yml`

### Acceptance Criteria
- Performance smoke test runs in CI
- Doesn't increase CI runtime by more than 2 minutes
- Failures are visible but don't block merges

### Testing Requirements
- Verify the CI job runs and reports results

### CI Requirements
- The new CI job must not fail CI (informational only initially)

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Performance smoke test in CI
- [ ] CI green

### References
- `scripts/load-test.js`
- `CONTRIBUTING.md` — performance expectations
- `docs/performance.md`

---

## Issue #044 — Testing: Add API response shape snapshot tests for core endpoints

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/testing`, `type/improvement`, `priority/medium`

### Summary
Core API endpoints (`GET /api/projects`, `GET /api/projects/:id`, `GET /api/leaderboard`, `GET /api/stats/global`) should have response shape snapshot tests to catch unintended changes to the JSON structure that could break frontend clients.

### Background
The backend has comprehensive integration tests that check HTTP status codes and sometimes data fields, but none use Jest snapshots to verify the entire response shape. A snapshot test would freeze the response structure and alert on any field additions/removals/renames.

### Problem Statement
API response shape changes (removing a field, renaming `raisedXLM` to `raised_xlm`, changing a type from string to number) could silently break the frontend. Snapshot tests catch these immediately.

### Objectives
- Add Jest snapshot tests for 4 core endpoints
- Use the test database with seeded data for deterministic responses

### Scope

**In Scope**
- Snapshot tests for `GET /api/projects`, `GET /api/projects/:id`, `GET /api/leaderboard`, `GET /api/stats/global`

**Out of Scope**
- Snapshot tests for all endpoints
- Snapshot tests for error responses

### Implementation Plan
1. Pick an existing integration test and add `.toMatchSnapshot()` on the response body
2. Seed the test database with known data so snapshots are deterministic
3. Exclude time-varying fields (`createdAt`, `updatedAt`) from snapshots or mock them

### Expected Files or Components
- `backend/src/routes/projects.test.js`
- `backend/src/routes/leaderboard.test.js`
- `backend/src/routes/stats.test.js`

### Acceptance Criteria
- 4 snapshot tests exist
- Snapshots are deterministic
- Changes to response shape cause test failures

### Testing Requirements
- Snapshot tests as part of the existing test suite

### CI Requirements
- `npm test`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Snapshot tests added
- [ ] Snapshots committed
- [ ] CI green

### References
- `backend/src/routes/projects.test.js`
- `backend/src/routes/leaderboard.test.js`

---

## Issue #045 — Tooling: Add `typedoc` generation check to CI for backend JSDoc coverage

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/ci`, `type/improvement`, `priority/low`

### Summary
The backend has a `npm run docs` script that generates TypeDoc documentation from JSDoc comments. This script is never run in CI, so undocumented exported functions or broken JSDoc syntax can go unnoticed.

### Background
`backend/package.json` has `"docs": "typedoc --options typedoc.json"` and `backend/typedoc.json` configures TypeDoc generation. Running this in CI would catch:
- Missing JSDoc on public API functions
- Malformed JSDoc syntax
- Type inconsistencies in JSDoc type annotations

### Problem Statement
Undocumented backend functions make it harder for contributors to understand the codebase. Adding a CI check ensures new code is documented.

### Objectives
- Add a CI step that runs `npm run docs` and fails if TypeDoc encounters errors
- Configure TypeDoc to treat warnings as errors for CI

### Scope

**In Scope**
- CI job addition
- TypeDoc configuration for CI

**Out of Scope**
- Adding JSDoc to all existing functions (can be done incrementally)

### Implementation Plan
1. Add `--treatWarningsAsErrors` (or equivalent) to the typedoc command in CI
2. Add a new job or step in `.github/workflows/ci.yml` to run `npm run docs`
3. Fix any existing TypeDoc warnings that would block CI

### Expected Files or Components
- `backend/typedoc.json`
- `.github/workflows/ci.yml`

### Acceptance Criteria
- TypeDoc runs in CI
- Warnings fail the build
- No existing warnings block the build after fixes

### Testing Requirements
- Verify the CI job runs and catches documentation issues

### CI Requirements
- New CI step must pass

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] TypeDoc CI check added
- [ ] CI green

### References
- `backend/typedoc.json`
- `backend/package.json` — `docs` script

---

## Issue #046 — Extension: Add graceful error handling for Freighter API version incompatibility

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/extension`, `type/bug`, `priority/medium`

### Summary
The browser extension (`extension/`) communicates with the Freighter wallet API. If the user has an older Freighter version that doesn't support a method the extension calls, the error handling should surface a clear "Please update Freighter" message instead of a generic error.

### Background
The extension's `manifest.json` and `popup.html` define a browser extension that facilitates donations. It calls Freighter API methods via `window.freighter`. If Freighter API changes (which it does across versions), the extension may call undefined methods.

### Problem Statement
Users with outdated Freighter versions see cryptic errors instead of actionable upgrade instructions.

### Objectives
- Add version detection for the Freighter API
- Show a clear upgrade message when the API version is incompatible
- Add minimum version requirement check

### Scope

**In Scope**
- Error handling for Freighter API calls
- Version check logic

**Out of Scope**
- Supporting very old Freighter versions (< 1.0)
- Extension UI overhaul

### Implementation Plan
1. Read `extension/` source files to find where Freighter API calls are made
2. Add a `try/catch` that detects `TypeError: window.freighter.someMethod is not a function`-style errors
3. Show a specific error message with a link to the Freighter update page

### Expected Files or Components
- `extension/popup.html` (or associated JS)
- `extension/manifest.json`

### Acceptance Criteria
- Outdated Freighter shows a specific, actionable error message
- Compatible Freighter works as before

### Testing Requirements
- Manual test with different Freighter versions
- Jest test mocking incompatible API

### CI Requirements
- `cd extension && npm test` (if tests exist)
- `cd extension && npm run lint`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Freighter API error handling improved
- [ ] CI green

### References
- `extension/manifest.json`
- `extension/package.json`

---

## Issue #047 — Mobile: Add biometric authentication fallback for devices without biometric sensors

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/mobile`, `type/improvement`, `priority/medium`

### Summary
The mobile app (`mobile/`) uses `expo-local-authentication` for biometric auth. The `useBiometricAuth` hook in `mobile/hooks/useBiometricAuth.ts` should gracefully handle devices that don't have biometric sensors by falling back to device PIN/passcode or skipping biometrics entirely.

### Background
`expo-local-authentication` returns `AuthenticationType` which includes `NONE` for devices without biometrics. The hook should detect this and either:
- Fall back to OS-level device credential (PIN/password/passcode)
- Skip biometric auth and proceed without it

### Problem Statement
Users with devices that lack biometric sensors (some budget Android devices, emulators) may be unable to use the app if biometric auth is required without a fallback.

### Objectives
- Check `supportedAuthenticationTypesAsync` before requiring biometrics
- If no biometric sensor is available, attempt `SECURITY_LEVEL_DEVICE_CREDENTIAL` fallback
- If device credential also unavailable, show a configurable bypass

### Scope

**In Scope**
- `mobile/hooks/useBiometricAuth.ts`
- Fallback authentication flow

**Out of Scope**
- Full auth architecture redesign
- Server-side changes

### Implementation Plan
1. Read `mobile/hooks/useBiometricAuth.ts`
2. Add a pre-check: `const types = await LocalAuthentication.supportedAuthenticationTypesAsync()`
3. If no biometric, try `LocalAuthentication.authenticateAsync({ disableDeviceFallback: false })` which falls back to PIN
4. If neither works, set a "biometricsUnavailable" flag

### Expected Files or Components
- `mobile/hooks/useBiometricAuth.ts`
- `mobile/lib/secureStore.ts`

### Acceptance Criteria
- App works on devices without biometric sensors
- Falls back to device PIN when biometric is unavailable
- Graceful message when no auth is available
- Typescript type-check passes

### Testing Requirements
- Test with `expo-local-authentication` mocked to return no biometric types
- Test with device credential fallback

### CI Requirements
- `cd mobile && npm run lint`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Biometric fallback implemented
- [ ] CI green

### References
- `mobile/hooks/useBiometricAuth.ts`
- `mobile/lib/secureStore.ts`
- `mobile/package.json`

---

## Issue #048 — Docs: Add JSDoc type documentation for key backend service functions

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/docs`, `type/improvement`, `priority/low`

### Summary
Several backend service modules lack JSDoc documentation, making it harder for contributors to understand their purpose, parameters, and return values. Targeted JSDoc additions to the most critical services would lower the contribution barrier.

### Background
The project already has TypeDoc configured (`backend/typedoc.json`) and some functions are documented (e.g., `projects.js` route handlers). Service modules like `projectionEngine.js`, `sorobanEventService.js`, `indexerService.js`, and `co2Verifier.js` would benefit from JSDoc.

### Problem Statement
Undocumented service functions increase onboarding time for new contributors and make code review harder.

### Objectives
- Add JSDoc `@param`, `@returns`, and `@description` to exported functions in key service modules
- At minimum: `projectionEngine.js`, `sorobanEventService.js`, `co2Verifier.js`

### Scope

**In Scope**
- JSDoc for exported functions in 3-5 service modules
- TypeDoc generation must still pass

**Out of Scope**
- Documenting all backend modules
- Inline code comments

### Implementation Plan
1. Select 5 service files with the most undocumented exported functions
2. Add JSDoc comments following the pattern in already-documented functions (see `projects.js`)
3. Run `npm run docs` to verify TypeDoc generation works

### Expected Files or Components
- `backend/src/services/projectionEngine.js`
- `backend/src/services/sorobanEventService.js`
- `backend/src/services/co2Verifier.js`
- `backend/src/services/indexerService.js`
- `backend/src/services/recurringDonationWorker.js`

### Acceptance Criteria
- Key exported functions have JSDoc
- `npm run docs` succeeds
- No TypeDoc warnings

### Testing Requirements
- `npm run docs` must exit 0

### CI Requirements
- `npm run lint`
- `npm run docs` (if Issue #045 is also being worked on)

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] JSDoc added to 5 service modules
- [ ] CI green

### References
- `backend/src/routes/projects.js` — examples of good JSDoc
- `backend/typedoc.json`

---

## Issue #049 — Backend: Add structured logging for all background worker startup and shutdown events

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/improvement`, `priority/medium`

### Summary
The backend starts many background workers (`summaryQueue`, `profileQueue`, `webhookQueue`, `pushQueue`, `indexerService`, `co2Verifier`, `recurringKeeper`, `guardianService`, etc.) in `server.js`. Some log their startup with `logger.info(...)` while others are wrapped in `try/catch` and only log on failure.

### Background
The startup sequence in `backend/src/server.js` uses a mix of `try/catch` blocks with `logger.error` on failure but missing `logger.info` on success for some workers (`oracleService`, `guardianService`, `recurringKeeper`). During graceful shutdown, some services are stopped in the lifecycle handlers without logging.

### Problem Statement
Inconsistent startup/shutdown logging makes it difficult to debug production issues. When a worker silently fails to start or gets stuck during shutdown, the logs don't provide enough information.

### Objectives
- Audit the startup sequence and ensure every service/worker logs a structured `{ event: "xxx_started" }` message on successful startup
- Ensure shutdown handlers log `{ event: "xxx_stopped" }` or `{ event: "xxx_shutdown_error" }` messages
- Use consistent log shape: `{ event: "<service>_started" }` and `{ event: "<service>_stopped" }`

### Scope

**In Scope**
- `backend/src/server.js` startup sequence
- Lifecycle shutdown handlers
- Worker service files (where appropriate)

**Out of Scope**
- Adding logging to every function call
- Changing log format

### Implementation Plan
1. Read `server.js` and identify every service that starts but doesn't log success
2. Add `logger.info({ event: "<service>_started" }, "<Service> started")` after each successful start
3. Add `logger.info({ event: "<service>_stopped" }, "<Service> stopped")` in shutdown handlers
4. Standardize the event naming convention

### Expected Files or Components
- `backend/src/server.js`
- Individual service files (if they manage their own lifecycle)

### Acceptance Criteria
- Every background worker logs startup and shutdown
- Event naming is consistent
- Log output is more informative during startup

### Testing Requirements
- Verify startup log output (inspect logs from a test run)

### CI Requirements
- `npm run lint`
- `npm test`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Startup/shutdown logging added
- [ ] CI green

### References
- `backend/src/server.js` — startup sequence
- `backend/src/logger.js`

---

## Issue #050 — Cross-Cutting: Standardize frontend and backend validation error response shapes

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/cross-cutting`, `type/improvement`, `priority/medium`

### Summary
The backend Zod validation errors return `{ error: "Validation failed", details: [{ path, message }] }` (in `validate.js`). The frontend `QueryErrorFallback` and API error handling expect `{ error: { code, message } }` (the `AppError.toJSON()` shape). These two error shapes are inconsistent, making it harder to build unified error-handling logic.

### Background
- Backend Zod validation (in `validate.js`): returns HTTP 400 with `{ error: "Validation failed", details: [...] }`
- Backend `AppError` (in `errors.js`): returns `{ error: { code, message, ...metadata } }`
- Backend `sendAppError`: returns `{ error: { code, message } }`
- Frontend `classifyError` in `queryErrors.ts`: expects Axios response with `status` property

The root issue: Zod validation bypasses `AppError` and returns a different shape. This means the frontend can't uniformly parse `response.data.error.code`.

### Problem Statement
Two different error shapes require two different error-handling code paths in the frontend. This increases complexity and the likelihood of unhandled error cases.

### Objectives
- Update `validate.js` to use `sendAppError(res, "SCHEMA_VALIDATION_ERROR", { details })` so the shape is consistent
- OR update the frontend to handle both shapes uniformly
- Update tests that assert on the old shape

### Scope

**In Scope**
- `backend/src/middleware/validate.js`
- OR `frontend/lib/queryErrors.ts` (if frontend-side change is preferred)
- Related tests

**Out of Scope**
- Changing error codes
- Full API error response redesign

### Implementation Plan
**Option A (Backend change):**
1. Change `validate.js` to return:
   ```js
   return res.status(422).json({
     error: { code: "SCHEMA_VALIDATION_ERROR", message: "Validation failed", details }
   });
   ```
   This nests `details` inside the `error` object, matching the `AppError.toJSON()` pattern.

2. Update all tests that assert on the old response shape.

**Option B (Frontend change):** Handle both shapes in `classifyError`.

### Expected Files or Components
- `backend/src/middleware/validate.js`
- `backend/src/routes/*.test.js` (tests that assert on validation error shape)
- Optionally: `frontend/lib/queryErrors.ts`

### Acceptance Criteria
- All error responses have the `{ error: { code, message, ... } }` shape
- Frontend can parse all error types uniformly
- Existing tests updated and passing

### Testing Requirements
- Update tests to match new error shape

### CI Requirements
- `npm run lint` (frontend and backend)
- `npm test` (frontend and backend)
- `npm run type-check`

### Deliverables
- Single commit
- Changelog entry

### Definition of Done
- [ ] Error shapes standardized
- [ ] Tests updated
- [ ] CI green

### References
- `backend/src/middleware/validate.js`
- `backend/src/errors.js` — `AppError.toJSON()`, `sendAppError`
- `frontend/lib/queryErrors.ts` — `classifyError`

---

## Appendix: Issue Type Distribution

| Type            | Count | Issue Numbers               |
| --------------- | ----- | --------------------------- |
| Bug Fix         | 9     | #001, #003, #004, #005, #014, #016, #026, #027, #046 |
| Testing         | 12    | #002, #006, #008, #010, #011, #025, #035, #038, #040, #041, #043, #044 |
| Improvement     | 25    | #007, #009, #012, #013, #015, #017, #018, #019, #020, #021, #022, #023, #024, #028, #029, #030, #031, #032, #033, #034, #036, #037, #045, #048, #049 |
| Security        | 1     | #014 (also listed as bug)  |
| Accessibility   | 2     | #028, #031                  |
| CI/Tooling      | 5     | #039, #042, #043, #045      |
| Cross-Cutting   | 1     | #050                        |
| Documentation   | 1     | #048                        |

## Appendix: Area Distribution

| Area            | Count | Issue Numbers               |
| --------------- | ----- | --------------------------- |
| Contracts       | 12    | #001-#012                   |
| Backend         | 13    | #013-#025                   |
| Frontend        | 13    | #026-#038                   |
| CI/Tooling      | 7     | #039-#045                   |
| Cross-Cutting   | 5     | #046-#050                   |
