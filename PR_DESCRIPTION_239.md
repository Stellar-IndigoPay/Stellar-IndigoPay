# Soroban Contract Fuzzing Harness with Property-Based Testing Framework

Closes #239

## Summary

Build a comprehensive fuzzing harness for the IndigoPay Soroban contract using property-based testing with `proptest`. The harness discovers edge cases in donation arithmetic overflow, badge tier transitions, governance vote counting, CO₂ offset calculations, and multi-currency conversion paths through random action-sequence fuzzing.

## Background

The IndigoPay contract (`contracts/indigopay-contract/src/lib.rs`, ~1,800 lines) handles financial operations (donations in XLM and USDC), badge tier calculations, governance voting, project lifecycle management, admin security functions, and upgrade timelocks. The existing test suite covers happy paths but does not systematically explore edge cases.

The contract already had a fuzzing test stub at `fuzz_template.rs` and `fuzz_tests.rs` with basic property tests, but these lacked formal property definitions for several critical invariants and had no action-sequence based randomized testing.

## Changes

### Files Changed

| File | Additions | Deletions | Description |
|------|-----------|-----------|-------------|
| `contracts/indigopay-contract/src/fuzz_tests.rs` | +1,018 | -6 | Main fuzzing harness rewrite |
| `contracts/indigopay-contract/src/fuzz_template.rs` | +37 | 0 | Updated template docs with new patterns |
| `.github/workflows/contracts.yml` | +13 | -6 | Enhanced CI fuzz job |
| `CHANGELOG.md` | +11 | 0 | Documented changes |
| `FUZZ_FINDINGS.md` | +131 | 0 | New file: fuzz discovery log |
| `contracts/indigopay-contract/fuzz_corpus/.gitkeep` | +10 | 0 | New corpus directory |

### 1. Seven Formal Property-Based Fuzz Tests

Each property defines an invariant that must hold across all randomly generated input sequences:

#### Property 1 — Donation Totals Consistency
`prop_donation_totals_consistency` — For any sequence of donations to multiple projects, verifies:
- `global_total == sum(expected_totals)` across all projects
- `global_co2 == sum(expected_co2)` across all projects (per-project CO₂ offset consistency)
- Every project's `total_raised` never decreases and never goes negative

**Strategy**: Generates 1–50 random (project_idx, amount, donor_idx) tuples with amounts from 1 stroop to 100K XLM.

#### Property 2 — Badge Monotonicity
`prop_badge_monotonicity_sequence` — A donor's badge tier never decreases across any random donation sequence. Tracks the best rank (0–4) seen for each donor and asserts `current_rank >= best_rank` after every donation.

**Strategy**: Generates 1–30 random donations across 3 projects and 5 donors.

#### Property 3 — Donor Count Accuracy
`prop_donor_count_accuracy` — `project.donor_count == count(distinct donor_address)`. Tracks unique donors per project independently and asserts the contract's `donor_count` matches after every operation.

**Strategy**: Generates 1–40 random donations across 3 projects and 8 donors, tracking per-project unique donor sets.

#### Property 4 — Global Stats Consistency
`prop_global_stats_consistency` — Uses the batched `get_global_stats()` call and asserts:
- `GlobalStats.total_raised == sum(project.total_raised)` for all projects
- `GlobalStats.donation_count == total_donations` (exact equality, not >=)
- `GlobalStats.project_count >= number_of_registered_projects`
- All stats are non-negative

**Strategy**: Generates 1–30 random donations across 4 projects and 6 donors.

#### Property 5 — Vote Integrity
`prop_vote_integrity` — After `resolve_proposal()`:
- `proposal.resolved == true`
- `votes_for + votes_against == sum(voter_weights)` (weighted voting)
- Post-resolution votes panic with "Proposal already resolved"
- Proposal state is immutable after resolution (votes unchanged after failed re-vote)

**Strategy**: Generates 1–10 donors with random donation amounts and approve/reject votes, advances ledger past deadline, resolves, and verifies immutability.

#### Property 6 — CO₂ Offset Monotonicity
`prop_co2_offset_monotonicity` — `global_co2_offset` never decreases across any sequence of donations. Also verifies that `get_global_co2()` matches `GlobalStats.co2_offset_grams` from the batched getter.

**Strategy**: Generates 1–30 random donations, asserting monotonic increasing CO₂ after each operation.

#### Property 7 — Pause/Resume Idempotency
`prop_pause_resume_idempotency` — Fuzzes all three idempotency guards:
- Pausing an already-paused project panics ("Project is already paused")
- Resuming an unpaused project panics ("Project is not paused")
- Pausing a deactivated project panics ("Cannot pause a deactivated project")
- Valid pause → resume → double-resume panics cycle
- Valid path through deactivated → pause panic

**Strategy**: Randomly selects between pause-before-deactivate sequences using `proptest::bool::ANY`.

### 2. ContractAction-Based Action-Sequence Fuzzing

A new `ContractAction` enum models every state-mutating contract call as a variant:

```rust
enum ContractAction {
    Donate { project_idx, donor_idx, amount },
    DonateUsdc { project_idx, donor_idx, usdc_amount },
    RegisterProject { name, co2_rate },
    PauseProject { project_idx },
    ResumeProject { project_idx },
    CreateProposal { project_idx, duration_ledgers },
    Vote { project_idx, voter_idx, approve },
    ResolveProposal { project_idx },
}
```

Weighted strategy (`contract_action_strategy`) biases toward donations (10:1) while also exercising project registration, pause/resume, and governance paths.

The `fuzz_action_sequence_consistency` test generates 1–100 random action sequences across 5 projects and 10 donors, asserting all seven properties hold throughout. After the sequence completes, it performs a final global consistency check: `sum(project.totals) == global_total`.

`DonateUsdc` actions use the `MockOracle` (8 XLM/USDC rate) and a separate USDC token, covering the multi-currency conversion path.

### 3. Setup Infrastructure

- **`setup()`** — Single project, single XLM token (existing, unchanged)
- **`setup_with_admin()`** — Single project with admin reference (existing, unchanged)
- **`setup_usdc()`** — Single project with USDC token and oracle (existing, unchanged)
- **`setup_multi()`** — **New**: Multi-project, multi-donor environment with both XLM and USDC tokens, oracle, and pre-funded donors for action-sequence fuzzing. Returns an 8-element tuple.

All existing tests continue to work unchanged. New fuzz tests use either the appropriate existing setup or the new `setup_multi()`.

### 4. Fuzz Corpus & Regression Tests

#### Corpus Module (4 replayable deterministic tests)
- **CORPUS-001**: Minimum stroop donation (1 stroop) — verifies floor division CO₂ behavior
- **CORPUS-002**: Sub-stroop donation zero CO₂ — verifies `amount < STROOP` produces 0 CO₂
- **CORPUS-003**: Full pause/resume lifecycle — donate → pause → reject → resume → donate
- **CORPUS-004**: Vote → resolve → verify immutability — post-resolution vote panics, state unchanged

#### Regression Tests (3 tests derived from fuzzed edge cases)
- **REGRESSION-001**: Sub-stroop CO₂ no underflow — verifies global CO₂ never goes negative
- **REGRESSION-002**: Multi-project donor count independence — same donor, two projects, each with `donor_count = 1`
- **REGRESSION-003**: Zero CO₂ rate update rejected — verifies `update_project_co2_rate(0)` panics

### 5. CI Integration

The existing `.github/workflows/contracts.yml` fuzz job was enhanced:
- Renamed to "Fuzz Tests (property-based, 60s)" for clarity
- Added `--test-threads=1 --nocapture` for deterministic output
- Added 2-minute per-step timeout
- Added a **corpus regression step**: `cargo test --features testutils -- corpus regression`
- Reduced overall job timeout from 20 to 10 minutes

### 6. Documentation

- **`FUZZ_FINDINGS.md`** — Documents 5 findings from fuzz testing, including:
  - Finding #1: Sub-stroop CO₂ offset floor division (informational)
  - Finding #2: Vote weight edge case — None tier (verified guard)
  - Finding #3: Pause/resume idempotency guards confirmed (verified)
  - Finding #4: Global stats consistency after mixed operations (verified)
  - Finding #5: CO₂ offset calculation for min-stroop donations (documented)
  - Summary table and conclusion: no exploitable arithmetic bugs found

- **`fuzz_template.rs`** — Updated with:
  - Expanded invariant checklist (3 new invariants)
  - Action-sequence fuzzing pattern documentation
  - Corpus management workflow instructions

## Acceptance Criteria Checklist

- [x] At least 7 property-based fuzz tests defined and passing
- [x] Fuzz harness generates 100+ random action sequences per run
- [x] All properties hold for random sequences on current contract code
- [x] Fuzz tests in CI with dedicated job configured
- [x] At least one corpus entry replayable as deterministic regression test (4 provided)
- [x] FUZZ_FINDINGS.md documents all discoveries
- [x] Fuzz tests use existing module structure for consistency
- [x] Regression tests derived from edge case analysis
- [x] CHANGELOG updated
- [x] Existing contract tests continue to pass (no changes to lib.rs)

## Fuzz Test Execution

```bash
# Run all fuzz tests with default 1,500 iterations
cargo test --features testutils -- fuzz

# Run with custom iteration count
FUZZ_ITERATIONS=100000 cargo test --features testutils -- fuzz

# Run only corpus regression tests
cargo test --features testutils -- corpus

# Run only regression tests
cargo test --features testutils -- regression

# Run action-sequence fuzz with single thread for reproducibility
cargo test --features testutils -- fuzz_action_sequence -- --test-threads=1 --nocapture
```

## Key Design Decisions

1. **`std::panic::catch_unwind` for expected panics**: The contract uses `panic!()` for guard clauses (overflow, auth, state transitions). Tests wrap calls in `catch_unwind` to distinguish expected panics from unexpected ones, allowing the fuzzer to explore paths where some operations are expected to fail.

2. **Pre-funded donors in `setup_multi`**: Donors are minted 10M XLM and 10M USDC-equivalent at setup to avoid running out during long action sequences (>100 actions).

3. **Weighted action strategy**: Donations are weighted 10:1 over admin/governance actions to focus fuzz exploration on the most common and arithmetic-sensitive paths.

4. **Floor division handling**: Sub-stroop donations produce zero CO₂ (documented in FUZZ_FINDINGS.md, not a bug).

5. **Existing tests preserved**: All 25+ existing fuzz and deterministic tests remain unchanged. New tests are additive.

## No Bugs Discovered

The IndigoPay contract's arithmetic guards (`checked_add`, `checked_mul`, explicit panic messages) are working correctly across all fuzzed combinatorial paths. The CEI pattern (ADR-004) provides robust defense. No exploitable arithmetic overflow panics, badge downgrades, governance manipulation, or global stat inconsistencies were found.
