# Fuzz Test Findings

This document logs bugs and edge cases discovered during property-based
fuzzing of the IndigoPay Soroban contract.

---

## Finding #1: Sub-Stroop CO₂ Offset Floor Division

**Discovered**: 2026-07-18
**Severity**: Informational
**Property**: CO₂ Offset Monotonicity (Property 6)
**Status**: Expected behavior — documented

### Description

Donations below 1 XLM (amount < STROOP = 10,000,000 stroops) produce zero
CO₂ offset due to integer floor division in the CO₂ calculation:

```rust
let xlm_units = amount / STROOP;  // 0 for amount < STROOP
let co2_increment = xlm_units.checked_mul(project.co2_per_xlm as i128);  // 0 * N = 0
```

This is technically correct behavior (the contract uses checked arithmetic
and never underflows), but it means that micro-donations below 1 XLM
generate zero on-chain CO₂ impact. The property `global_co2_offset never
decreases` holds, but CO₂ offset may not increase for sub-stroop donations.

### Recommendation

This is a product decision rather than a bug. The contract could optionally
round up (ceiling division) instead of floor, but that would require a
design decision about whether micro-donations should claim CO₂ offset.

### Test: `corpus::replay_min_stroop_donation`

---

## Finding #2: Vote Weight Edge Case — None Tier

**Discovered**: 2026-07-18
**Severity**: Low (panic-guarded)
**Property**: Vote Integrity (Property 5)
**Status**: Expected behavior — verified by test

### Description

Voters with `BadgeTier::None` are correctly rejected with a panic:
`"Only badge holders (Seedling or above) can vote"`. This is proper
authorization. However, if a donor donates enough to reach Seedling,
votes, and then... (no — badges never downgrade, per Property 2).

The fuzzer did not find a path where a voter's weight could be manipulated
after casting their vote. The `HasVoted` check correctly prevents
double-voting, and the `proposal.resolved` flag prevents post-resolution
modification.

### Test: `test_badge_weighted_voting_none_tier_panics`

---

## Finding #3: Pause/Resume Idempotency Guards Hold

**Discovered**: 2026-07-18
**Severity**: None (guards working correctly)
**Property**: Pause/Resume Idempotency (Property 7)
**Status**: Verified

### Description

All three idempotency guards were fuzzed and confirmed working:

1. **Pausing an already-paused project**: panics with `"Project is already paused"`
2. **Resuming an unpaused project**: panics with `"Project is not paused"`
3. **Pausing a deactivated project**: panics with `"Cannot pause a deactivated project"`

No bypass was discovered. The `pause_project` / `resume_project` functions
are correctly NOT gated by `require_not_paused` (allowing admin operations
during a contract-wide pause), which is intentional.

### Test: `prop_pause_resume_idempotency`

---

## Finding #4: Global Stats Consistency After Mixed Operations

**Discovered**: 2026-07-18
**Severity**: None
**Property**: Global Stats Consistency (Property 4)
**Status**: Verified

### Description

The fuzzer executed random sequences mixing donations, project
registrations, pauses, resumes, voting, and proposal resolutions.
After each sequence, `get_global_stats().total_raised` matched
`sum(project.total_raised for all projects)` within the test's
expected totals.

One observation: if a donation panics (e.g., rate limit exceeded,
project paused), the global counters are correctly NOT updated.
This is verified by the CEI pattern (ADR-004): effects happen
before interactions, but if checks fail, no effects occur.

### Test: `fuzz_action_sequence_consistency`

---

## Finding #5: CO₂ Offset Calculation for Min-Stroop Donations

**Discovered**: 2026-07-18
**Severity**: Informational
**Property**: CO₂ Offset Monotonicity (Property 6)
**Status**: Expected behavior

### Description

When `co2_per_xlm = 100` and `amount = 1` (1 stroop), the calculation
produces:
- `xlm_units = 1 / 10_000_000 = 0`
- `co2_increment = 0 * 100 = 0`

For `amount = STROOP` (exactly 1 XLM), the calculation produces:
- `xlm_units = 1`
- `co2_increment = 100` grams

The floor division creates a step-function behavior where no CO₂ is
credited until a full XLM is donated. This is consistent and monotonic.

### Test: `regression_sub_stroop_co2_no_underflow`

---

## Summary

| Finding | Severity    | Property | Bug? |
|---------|------------|----------|------|
| #1      | Info       | CO₂      | No   |
| #2      | Low        | Vote     | No   |
| #3      | None       | Pause    | No   |
| #4      | None       | Stats    | No   |
| #5      | Info       | CO₂      | No   |

### Conclusion

The IndigoPay contract's arithmetic guards (`checked_add`, `checked_mul`,
explicit panic messages) are working correctly across all fuzzed
combinatorial paths. No arithmetic overflow panics, badge downgrades,
governance manipulation, or global stat inconsistencies were found.

The contract's CEI pattern (ADR-004) and explicit panic guards provide
robust defense against the edge cases explored by the fuzzer.

### Corpus Files

Corpus entries for reproducible regression testing are maintained in:
- `contracts/indigopay-contract/fuzz_corpus/`
- `contracts/indigopay-contract/proptest-regressions/` (auto-generated by proptest)

Deterministic replay tests are in:
- `fuzz_tests.rs::corpus::replay_*`
- `fuzz_tests.rs::regression_*`
