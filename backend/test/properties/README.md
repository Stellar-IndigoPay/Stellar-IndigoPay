# Property-based tests

Generative tests for the three financial-integrity components whose
regressions have the highest blast radius:

| Suite | Component | Invariant families |
| --- | --- | --- |
| `projection.properties.test.js` | `src/services/projectionEngine.js` | totals decompose per donor/project/globally, non-negativity, monotonicity under appended donations, bulk rebuild == incremental replay, idempotent re-projection, BigInt exactness past `2^53`, proportional CO2 distribution |
| `merkleTree.properties.test.js` | `src/services/merkleTree.js` | every leaf has a verifiable proof, any single-bit tamper of a leaf/sibling fails, tree shape follows the defined odd-leaf semantics, roots are deterministic, permutations and duplicate-last-leaf change the root |
| `auditChain.properties.test.js` | `src/services/auditChain.js` | append/verify round-trip, tampering any field/link breaks verification at that row, canonicalization injectivity (pipe-delimiter collision class), documented normalization equivalences, chain state deterministic from entry sequence |

`mutation-canary.test.js` re-runs the same predicates against deliberately
broken wrappers (off-by-one proof handling, corrupt verifier, over-permissive
chain verification) and asserts they are rejected **with a seed and minimal
counterexample** — proving the suite still catches regressions.

## No new dependencies

The repo had no property/generator library (`fast-check` et al.) and the issue
constraints forbid heavyweight additions without justification, so these suites
use a small purpose-built harness under `harness/` (~350 lines total):

- `rng.js` — mulberry32 PRNG. Built only from spec-exact operations
  (`Math.imul`, `>>>`), so sequences are identical across Node versions and
  platforms. No `Math.random()`, no crypto RNG, no clock.
- `generators.js` — bounded random values (exact decimal strings digit-by-digit,
  delimiter/unicode-laden text, hex, timestamps, arrays).
- `property.js` — `checkProperty({ name, seed, gen, predicate })`: generates N
  inputs, shrinks the first failure towards a **minimal counterexample**, and
  throws with seed + iteration + counterexample.
- `exactDecimal.js` — independent string-math decimal→BigInt oracle, so the
  oracle cannot silently inherit a bug from the code under test.
- `projectionTestDb.js` — in-memory pg client that applies the exact statements
  the four projection handlers emit (NUMERIC-exact BigInt arithmetic at the
  migration-defined scales), letting properties run against the REAL handlers
  without Docker.
- `soundness.js` — the invariant predicates shared by the suites and the
  mutation canaries.

## Seed / replay strategy

- **CI (deterministic):** `PROPERTY_SEED` is pinned in
  `docker-compose.test.yml` (`1337`) and `PROPERTY_ITERATIONS=120`; unset, the
  harness falls back to the fixed default base `20260824` and 100 iterations.
  Every suite derives its own seed deterministically from the base
  (`base + ordinal * 7919`), so one variable reproduces everything.
- **Replaying a failure:** the error message prints the base seed, suite seed,
  failing iteration and minimal counterexample. Reproduce locally with:

  ```sh
  PROPERTY_SEED=<base> npx jest test/properties/<file>
  ```

- **Nightly (broadened coverage):**
  `.github/workflows/property-nightly.yml` runs at 02:30 UTC with a fresh
  date-derived seed (logged in the step output) and `PROPERTY_ITERATIONS=2000`
  (`npm run test:properties:extended`). Manual dispatch accepts an explicit
  seed/iteration override for triage.

## Performance & scope guards

- Input sizes are bounded (≤40 donations, ≤64 leaves, ≤50 audit rows) so a CI
  run stays in the low seconds; nightly scales iterations, not sizes.
- Shrinking is budgeted (≤400 predicate runs) so worst-case failure reporting
  stays fast.
- Properties assert invariants only — production modules are required directly,
  never reimplemented. The one intentional exception is `exactDecimal.js`,
  kept independent on purpose so an oracle cannot mask a regression in the
  conversion helpers it checks.
