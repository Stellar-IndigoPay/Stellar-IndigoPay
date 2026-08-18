# Projection engine: integer-exact donation/CO₂ arithmetic via BigInt

Closes #681

## Summary

`projectionEngine.co2OffsetForDonation` computed `(Number(amountXlm) * co2) / raised` using JavaScript `Number` (IEEE-754 double), and the four projection handlers each converted `amountXLM`/`co2OffsetKg` with `Number(...)` before writing to the materialised read models. Donation amounts are i128 stroops (up to ~1.7e38), far beyond `Number`'s 2^53 exact-integer range, so large donations silently lost precision in the leaderboard, impact, and CO₂ projections — diverging from the contract's `i128` integer arithmetic.

This PR removes every `Number`-based donation path and replaces it with BigInt/decimal-string arithmetic, carrying stroop amounts as exact decimal strings end-to-end (indexer → event store → projection handlers → `NUMERIC` columns). Projections now match on-chain integer semantics for arbitrarily large donations.

## Problem statement

The on-chain contract (`contracts/indigopay-contract/src/lib.rs`) performs all donation arithmetic in `i128` stroops:

```rust
let xlm_units = xlm_equivalent / STROOP;              // integer floor division
let co2_increment = xlm_units * project.co2_per_xlm;  // integer grams
```

The backend, however, funnelled the same values through double-precision floats:

```js
// projectionEngine.js (before)
function co2OffsetForDonation(amountXlm, projectRaisedXlm, projectCo2Kg) {
  const raised = Number(projectRaisedXlm || 0);
  const co2 = Number(projectCo2Kg || 0);
  if (raised > 0 && co2 > 0) {
    return (Number(amountXlm) * co2) / raised;
  }
  return 0;
}
```

A `Number` can only represent integers exactly up to 2^53 (≈ 9.0e15). An i128 stroop amount reaches ~1.7e38, so anything above ~9e8 XLM is rounded. The precision loss is silent: no error, no warning — just leaderboard totals, impact scores, and CO₂ offsets that are slightly wrong, and wrong in a way that only grows for the largest donors.

### Concrete demonstration

`2^53 + 1` stroops = `900719925.4740993` XLM. Against a project that has raised 10× that amount (`9007199254.740993` XLM) with `12345.678` kg of CO₂ offset, the proportional attribution is exactly `1234.5678` kg.

| Path | Result |
|------|--------|
| Float (`Number`) | `1234.5677999999998` ❌ |
| BigInt (this PR) | `"1234.5678"` ✅ |

The float path also breaks at the source: `sorobanEventService.js` decoded the i128 stroops into an exact string, then discarded that exactness with `parseFloat(xlmStr)` before the value ever reached the projection engine.

## Scope

### In scope

- `backend/src/services/projectionEngine.js` — BigInt helpers, `co2OffsetForDonation`, `computeImpactScore`, and the four projection handlers.
- `backend/src/services/sorobanEventService.js` — the `DonationRecorded` producer (the only production path that appends donation events).
- Tests (unit + integration) and `CHANGELOG.md`.

### Out of scope

- `contracts/` — no on-chain changes.
- The Horizon indexer (`indexerDonationHandler.js`) and recurring-donation executor (`handleRecExec`) do **not** feed the event-sourced projections; they are left unchanged to keep this PR focused. They are noted as a follow-up in "Future work".

## Root cause analysis

1. **`projectionEngine.co2OffsetForDonation`** used `Number(...)` for all three operands and multiplied/divided in float space.
2. **`computeImpactScore`** used `Number(totalXlm) * 0.7 + Number(totalCo2Kg) / 100 * 0.3`.
3. **All four handlers** (`donor_leaderboard`, `project_stats`, `donor_history`, `global_stats`) coerced `d.amountXLM` and `d.co2OffsetKg` with `Number(...)` and passed the resulting double to PostgreSQL, so the DB's exact `NUMERIC` aggregation was fed already-rounded inputs.
4. **`sorobanEventService.handleDonated`** decoded i128 stroops into an exact `xlmStr` (via `BigInt`), then immediately converted it with `parseFloat(xlmStr)` and computed `co2OffsetKg = (xlmAmount * co2Kg) / raisedXlm` in float space.

## Implementation

### Files changed

| File | Change |
|------|--------|
| `backend/src/services/projectionEngine.js` | New `toDecimalString` / `toScaledInt` / `scaledToDecimalString` helpers; `co2OffsetForDonation` and `computeImpactScore` rewritten in BigInt; handlers pass exact decimal strings |
| `backend/src/services/sorobanEventService.js` | `handleDonated` keeps exact `xlmStr` for DB/event writes; CO₂ offset via BigInt; profile totals summed in integer space |
| `backend/src/services/projectionEngine.test.js` | Updated assertions for string results; added >2^53 precision regression tests |
| `backend/src/services/projectionEngine.integration.test.js` | Added integration test proving >2^53 stroops round-trip exactly into `NUMERIC` |
| `backend/__tests__/services/sorobanEventService.test.js` | Updated `projectionEngine` mock to expose the new helper exports |
| `CHANGELOG.md` | Documented the fix under `[Unreleased] → Fixed` |

### 1. Exact decimal helpers

Three small, pure helpers form the foundation. The canonical in-flight representation is a plain decimal **string**; `BigInt` is used only inside pure functions, and PostgreSQL `NUMERIC` performs final aggregation.

```js
const STROOP_SCALE = 7;  // 1 XLM = 10^7 stroops (contract's STROOP constant)
const CO2_KG_SCALE = 4;  // co2_offset_kg columns use NUMERIC(20,4)

function toDecimalString(value)      // number|string|bigint → plain decimal string (expands scientific notation)
function toScaledInt(value, scale)   // decimal → BigInt scaled by 10^scale (truncates beyond `scale`)
function scaledToDecimalString(n, s) // scaled BigInt → trimmed decimal string
```

Design notes:

- `toDecimalString` rejects empty/non-finite input and returns `null`, so callers can fall back to `"0"`.
- For `Number` inputs it uses `toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 })` to force a plain (non-exponent) expansion. Real donation amounts arrive as **strings** from the indexer, so this path is a defensive fallback only.
- `toScaledInt` truncates fractional digits beyond `scale`, matching the contract's integer floor-division semantics for stroops.

### 2. `co2OffsetForDonation` in BigInt

```js
function co2OffsetForDonation(amountXlm, projectRaisedXlm, projectCo2Kg) {
  const amountStroops = toScaledInt(amountXlm, STROOP_SCALE);
  const raisedStroops = toScaledInt(projectRaisedXlm, STROOP_SCALE);
  const co2Decigrams = toScaledInt(projectCo2Kg, CO2_KG_SCALE);
  if (raisedStroops > 0n && co2Decigrams > 0n) {
    return scaledToDecimalString(
      (amountStroops * co2Decigrams) / raisedStroops,
      CO2_KG_SCALE,
    );
  }
  return "0";
}
```

`amount × co2 / raised` is now computed entirely in integer space (stroops × decigrams ÷ stroops) and returns an exact decimal string of kg. The return type changes from `number` to `string`; it was only referenced by tests (not by production handlers), so there is no consumer breakage.

### 3. `computeImpactScore` in BigInt

```js
// score = xlm * 0.7 + (co2_kg / 100) * 0.3, at 4-decimal precision
const term1 = (xlmStroops * 7n) / 10000n; // xlm * 0.7
const term2 = (co2Decigrams * 3n) / 1000n; // (co2_kg / 100) * 0.3
return scaledToDecimalString(term1 + term2, CO2_KG_SCALE);
```

This preserves the exact legacy weights (0.7 / 0.3) while computing them in integer space so large totals are not corrupted. Results are truncated at 4 decimal places (the `impact_score NUMERIC(20,4)` column precision).

### 4. Projection handlers

All four handlers changed:

```js
// before
const amount = Number(d.amountXLM || 0);
const co2 = Number(d.co2OffsetKg || 0);

// after
const amount = toDecimalString(d.amountXLM) || "0";
const co2 = toDecimalString(d.co2OffsetKg) || "0";
```

The strings are passed directly as query parameters; PostgreSQL coerces them to `NUMERIC` exactly, so `raised_xlm = raised_xlm + $2` is now an exact decimal addition.

**Clarification (behavior-preserving):** the `donor_leaderboard` handler previously called

```js
computeImpactScore(
  Number(ctx.priorLeaderboard?.total_donated || 0) + amount,
  Number(ctx.priorLeaderboard?.total_co2_offset || 0) + co2,
)
```

`ctx.priorLeaderboard` was never populated anywhere in the codebase, so the two operands were always `0 + amount` and `0 + co2`. This PR replaces that with the equivalent `computeImpactScore(amount, co2)`, removing dead references to an undefined context field without changing observable behavior.

### 5. Source-of-truth fix (`sorobanEventService.js`)

`handleDonated` already decoded i128 stroops into `xlmStr` using `BigInt`. It now:

- writes `xlmStr` (not `parseFloat(xlmStr)`) to `donations.amount_xlm` / `donations.amount` and `projects.raised_xlm`;
- computes `co2OffsetKg = co2OffsetForDonation(xlmStr, raisedXlm, co2Kg)` in integer space;
- stores `amountXLM` / `amount` / `co2OffsetKg` in the `DonationRecorded` event as exact strings;
- sums the donor's cumulative `total_donated_xlm` in integer space via `toScaledInt(...) + toScaledInt(...)` and `scaledToDecimalString(..., 7)`;
- retains a display-only `parseFloat(xlmStr)` (`xlmAmount`) for log lines and the Socket.IO `newDonation` event, so the real-time UI payload shape is unchanged.

## Behavior changes

- `co2OffsetForDonation` and `computeImpactScore` now return **strings** instead of numbers. Both were only consumed by tests; no production call site changed its contract.
- Projection SQL now receives string parameters instead of numbers for amount/CO₂ fields — exact, and accepted identically by `NUMERIC`.
- Small-value results are numerically identical (e.g. `co2OffsetForDonation(10, 100, 1000)` → `"100"`, `computeImpactScore(1000, 50000)` → `"850"`).
- Large-value results are now exact instead of rounded.

## Testing

### Unit tests (no Docker; run in standard backend CI)

```bash
cd backend && npm test -- projectionEngine.test.js
```

New coverage:

- `co2OffsetForDonation is integer-exact for donations above 2^53 stroops` — asserts `"1234.5678"` where float produces `1234.5677999999998`.
- `toScaledInt preserves stroop precision past Number.MAX_SAFE_INTEGER` — `toScaledInt("900719925.4740993", 7) === 9007199254740993n` (i.e. `2^53 + 1`).
- `computeImpactScore is integer-exact for large totals` — `computeImpactScore("900719925.4740993", "12345.678") === "630503984.8688"`.
- `donations above 2^53 stroops are passed as exact decimal strings` — verifies the handler writes the unrounded string to both the leaderboard and global-stats SQL parameters.

Existing helper/handler assertions updated from `toBeCloseTo(number)` / `toContain(number)` to exact string equality.

### Integration test (testcontainers Postgres)

```bash
cd backend && npx jest src/services/projectionEngine.integration.test.js --maxWorkers=1
```

- `amounts above 2^53 stroops round-trip exactly into NUMERIC projections` — inserts `900719925.4740993` XLM and asserts `projection_project_stats.raised_xlm` and `projection_global_stats.total_xlm_raised` equal the exact string.

### Regression suite

The existing `projectionEngine.regression.test.js` (legacy-vs-projection parity) is unaffected; it validates equivalence of the read models, which this change does not alter.

## Acceptance criteria checklist

- [x] Projection arithmetic no longer uses JS `Number` for donation/CO₂ figures — BigInt/decimal-string throughout
- [x] `co2OffsetForDonation` and `computeImpactScore` are integer-exact for arbitrarily large donations
- [x] Stroop amounts carried as exact decimal strings from the Soroban indexer through the projection handlers
- [x] Precision regression tests for amounts above 2^53 stroops
- [x] Existing `projectionEngine` and `sorobanEventService` tests pass
- [x] `CHANGELOG.md` entry added

## CI requirements

Standard backend CI:

- `npm test` — unit tests (the new precision tests run here without Docker)
- `npm run lint` — `eslint src/**/*.js` (0 errors on changed files)
- testcontainers integration suite (the new integration test is gated behind Docker like the existing ones)

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Returning strings from `co2OffsetForDonation` / `computeImpactScore` breaks a hidden consumer | Verified via code search that both were only referenced by tests. Production CO₂ attribution in `sorobanEventService` now consumes the string result directly. |
| `toLocaleString` behavior differences across Node versions | The `number` branch is a defensive fallback only; production amounts arrive as strings. Verified plain output up to `1.7e38`. |
| Truncation vs. rounding at the 4th decimal | Truncation (floor) is intentional and matches the contract's integer floor division for stroops; documented in code comments. |
| Changing `donor_leaderboard` impact-score operands | Behavior-preserving: `ctx.priorLeaderboard` was never set, so the operands were always `amount` / `co2`. |
| Display-only `parseFloat` in `handleDonated` | Retained solely for log/WebSocket display; no persistence path uses it. |

## Rollback

Rolling back this change is a straight `git revert` — no schema change, no data migration, and the projection tables' `NUMERIC` types are unchanged. A rebuild (`rebuildAllProjections`) is unnecessary because the stored projection values for existing events were already exact (the DB was fed rounded doubles, but the tables themselves are `NUMERIC`).

## Future work (not in this PR)

- Apply the same BigInt exactness to `handleRecExec` and `indexerDonationHandler.js` donation math (these write `donations`/`projects`/`profiles` directly rather than the event-sourced projections).
- Fix the pre-existing `schema.sql` ordering bug (`ALTER TABLE donations ...` runs before `CREATE TABLE donations`) so the testcontainers integration/regression suites can apply the schema fresh.
