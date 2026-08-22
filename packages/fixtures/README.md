# @stellar-indigopay/fixtures

Shared deterministic fixture factory for the Stellar-IndigoPay frontend, mobile, and extension test suites.

## Purpose

This package eliminates duplicated, divergent test data across client suites by providing:

- **Typed builders** for all canonical domain objects (Project, Donation, DonationMatch, etc.)
- **Seeded RNG** so tests are deterministic given the same seed
- **Scenario builders** composing primitives into realistic multi-object states (offline replay, idempotent retry, stale price, conflict)
- **OpenAPI compatibility** — fixture output validates against the API spec

## Usage

```ts
import {
  project,
  donation,
  match,
  offlineReplayScenario,
  idempotentRetryScenario,
} from "@stellar-indigopay/fixtures";

// Build individual objects
const p = project({ name: "Amazon Reforestation", seed: 42 });
const d = donation({ projectId: p.id, amountXLM: "10" });
const m = match({ projectId: p.id, multiplier: 2 });

// Build scenarios
const offline = offlineReplayScenario({ seed: 42 });
// offline.project, offline.cachedDonations, offline.pendingItems

const retry = idempotentRetryScenario({ seed: 42 });
// retry.originalDonation, retry.retryDonation, retry.idempotencyKey
```

## Determinism

Same seed → identical objects every time. The seeded mulberry32 PRNG has no external dependencies. OpenAPI schema validation (the `validation` entrypoint) uses `ajv` and `js-yaml`.

```ts
const a = project({ seed: 42 });
const b = project({ seed: 42 });
expect(a).toEqual(b); // always passes
```

## Wiring

Each consumer suite maps the import path via Jest `moduleNameMapper`:

```js
moduleNameMapper: {
  "^@stellar-indigopay/fixtures$": "<rootDir>/../packages/fixtures/dist/index",
}
```

## Testing

```bash
cd packages/fixtures && npm test
```

## API Compatibility

The `openapi-compatibility.test.ts` validates fixture output against the OpenAPI schemas. If the API spec changes shape, this test will fail until the fixtures are updated — preventing drift.
