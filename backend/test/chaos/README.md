# Worker Chaos Harness

Crash-safety and partial-failure recovery testing for backend queue workers.

## What it tests

Worker recovery paths — webhook re-pickup, outbox replay, lease expiry, DLQ
reprocessing — are tested in isolation by the normal unit/integration suite.
The chaos harness tests the *crash scenarios* those mechanisms exist for:

| Scenario | Fault injected | Recovery path exercised | Invariant |
|---|---|---|---|
| A | kill after claim before commit | Lease expiry + reclaim sweep | Work reclaimed, processed once |
| B | kill after DB commit before queue ack | Outbox dispatcher + idempotency guard | No double-processing |
| C | Queue store unavailable during dispatch | Backoff + retry on queue restore | No permanent loss |
| D | Two recovery paths race on stranded job | Idempotency guard (DB UNIQUE constraint) | Single processing despite race |
| E | Idempotency guard deliberately removed | Duplicate-detection assertion fires | Regression is caught |
| F | Crash during DLQ replay itself | Second replay attempt + idempotency guard | No loss after nested fault |
| G | Batch of N jobs, lease expiry per cycle | Full lease reclaim + re-process | No loss, no duplicates in batch |
| H | Job exhausts retries → DLQ | Targeted DLQ replay | Poison isolation + exact-once replay |

## Recovery invariants

1. **At-least-once delivery with idempotent consumers** — no job is permanently
   lost after a crash.
2. **Lease expiry reclaims stranded work** — a job claimed by a crashed worker
   is reclaimed and reprocessed.
3. **Outbox rows re-dispatch after crash** — un-dispatched outbox rows are
   replayed by the outbox dispatcher on restart.
4. **DLQ poison events isolated** — exhausted jobs land in the DLQ and are not
   re-queued automatically; only targeted replay via `replayFromDLQ` re-admits
   them.
5. **No double-processing without idempotent dedupe** — the `chaos_processed`
   table (mirroring `webhook_deliveries.status='delivered'` and
   `idempotency_keys`) ensures at-most-once execution.

## File layout

```
backend/test/chaos/
  faultInjector.js     — deterministic crash-point injector (CHAOS_TEST=1 guard)
  invariantHelpers.js  — FakeConsumer + per-invariant assertion helpers
  workerChaos.test.js  — the eight scenarios
```

## Running locally

```bash
cd backend
CHAOS_TEST=1 npx jest --testPathPattern="test/chaos/workerChaos" --forceExit --verbose
```

The suite uses **testcontainers-node** to spin up a disposable PostgreSQL
instance — Docker must be running. If Docker is unavailable, each scenario
prints a skip warning and the suite still exits 0.

Expected output (all passing):

```
Worker chaos harness — crash-safety and partial-failure recovery
  ✓ Scenario A — kill after claim, lease reclaim restores work
  ✓ Scenario B — DB commit before queue ack, idempotent consumer dedupes
  ✓ Scenario C — queue store unavailable, backoff and resume
  ✓ Scenario D — two recovery paths race on stranded job, single processing
  ✓ Scenario E — removed idempotency guard is caught by duplicate-detection assertion
  ✓ Scenario F — crash during DLQ replay, second attempt succeeds idempotently
  ✓ Scenario G — batch of jobs, all processed under lease expiry cycles (no loss, no dup)
  ✓ Scenario H — DLQ poison isolation and targeted replay
```

## CI

The `chaos` job in `.github/workflows/ci.yml` runs the full harness on every
push/PR with a **10-minute bounded timeout**. It sets `CHAOS_TEST=1` and runs:

```yaml
CHAOS_TEST=1 npx jest --testPathPattern="test/chaos/workerChaos" --forceExit --ci --verbose
```

The chaos job is independent of the normal `backend` job — it does not use
docker-compose and does not require the full backend migration set.

## Safety guardrails

- `FaultInjector` throws at construction unless `CHAOS_TEST=1` — it cannot be
  accidentally instantiated in production.
- The harness uses its own `chaos_*` tables (not the production schema).
- Each scenario truncates its tables in `beforeEach` for full isolation.
- Fault injection is entirely in-process: no signals are sent to real PIDs, no
  production queues or databases are touched.

## How fault injection works

`FaultInjector` wraps a `pg.Pool` and intercepts `query()` calls. After the
real DB write succeeds, it throws a `FaultInjectionError` at the configured
crash point:

```js
const injector = new FaultInjector(realPool);
injector.armAt(CrashPoint.AFTER_CLAIM, {
  afterQuery: /UPDATE chaos_jobs.*SET status = 'claimed'/,
});

// The DB write happens; then FaultInjectionError is thrown.
await claimJob(injector, 'worker-1');  // throws

injector.disarm();
```

This models a `kill -9` that hits the process after the DB write but before
the worker has a chance to proceed — the most dangerous crash window for
at-least-once delivery systems.

For queue-store outages, `wrapBossWithQueueFault(boss, injector)` returns a
Proxy that throws on `send`, `work`, and `fetch` while `QUEUE_UNAVAILABLE` is
armed.

## Adding new scenarios

1. Write a `test()` block in `workerChaos.test.js`.
2. Use `FaultInjector` to inject the fault at a deterministic crash point.
3. Use `FakeConsumer` + the assertion helpers to verify the invariants.
4. Do **not** use `setTimeout` for timing — use `waitUntil()` with polling
   instead. Deterministic fault points and polling keep the suite stable across
   CI environments.
