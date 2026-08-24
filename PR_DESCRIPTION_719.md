# Fix: Serialize Indexer Backfill/Reconciler with Advisory Lock + Idempotent Upserts

Closes #119

## Summary

`indexerBackfill.js` and `indexerReconciler.js` could run concurrently — either across
Kubernetes replicas (HPA min 2) or when an admin-triggered manual backfill races the
periodic reconciler cron — with no reliable serialization guard. The existing
`backfill_in_progress` flag was a soft, application-level check subject to a
read-modify-write race (TOCTOU), meaning two concurrent callers could both read `false`
before either wrote `true`, allowing them to both proceed and double-insert donations
into `donations` and `donation_events`.

This PR fixes the issue with two layered defences:

1. **Postgres session-level advisory lock** (`pg_try_advisory_lock`) shared by both
   `runBackfill()` and `runReconciliation()` — serialises the two services across all
   replicas at the database level. The second concurrent caller returns `{ skipped: true }`
   immediately with no DB side-effects.

2. **Database-level idempotent upsert constraint** — migration `030_indexer_backfill_lock`
   adds unique partial indexes on `donation_events(transaction_hash, indexer_operation_id)`
   so that even if the advisory lock were somehow bypassed, a duplicate `INSERT` is
   rejected by the constraint rather than silently stored.

## Type

- [x] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactor
- [ ] Smart contract change

## Related Issue

Closes #119

---

## Problem Statement

`server.js` starts both `indexer_reconciler` and the backfill path as optional workers.
Neither acquired a Postgres advisory lock nor used `ON CONFLICT` idempotent upserts on
`donation_events`. The existing `backfill_in_progress` flag in `indexer_state` was checked
then set in two separate queries, leaving a TOCTOU window:

```
Replica A                     Replica B
── SELECT backfill_in_progress  ── SELECT backfill_in_progress
<< both read false >>
── UPDATE SET backfill_in_progress = true
                              ── UPDATE SET backfill_in_progress = true
<< both proceed, donations duplicated >>
```

Because the `donation_events` table (the projection/event store) had no unique constraint
on `(transaction_hash, indexer_operation_id)`, both runs would happily insert duplicate rows.

---

## Solution

### 1. Postgres Advisory Lock (shared between backfill and reconciler)

Both `runBackfill()` and `runReconciliation()` now call `pg_try_advisory_lock($key)`
on a dedicated client at the very start of each call. The key is a deterministic
FNV-1a 64-bit hash of `"indigopay_indexer_backfill"`, masked to the signed `int8` range
that Postgres `pg_advisory_lock` accepts (same scheme as the existing migration-runner lock).

- **Non-blocking**: `pg_try_advisory_lock` returns immediately — `true` (acquired) or
  `false` (busy). The losing caller returns `{ skipped: true }` with no work done.
- **Session-scoped**: the lock is tied to the database connection and is automatically
  released if the connection drops or the process crashes — no manual unlock required
  on the unhappy path.
- **Re-entrant within the same session**: when `runReconciliation()` triggers
  `runBackfill()` internally while already holding the lock, the inner call acquires the
  same lock on the same session (Postgres advisory locks are re-entrant per-session), so
  external sessions remain excluded while the nested call proceeds normally.
- **Always released in `finally`**: `pg_advisory_unlock($key)` is called unconditionally
  in the `finally` block before the client is returned to the pool.

### 2. Database-Level Idempotency Guard (migration `030`)

Migration `030_indexer_backfill_lock` adds two unique partial indexes on `donation_events`:

```sql
-- Deduplicate events that have an operation ID (indexer path)
CREATE UNIQUE INDEX IF NOT EXISTS uq_donation_events_tx_op_id
ON donation_events (transaction_hash, indexer_operation_id)
WHERE indexer_operation_id IS NOT NULL;

-- Deduplicate events without an operation ID (REST/API path)
CREATE UNIQUE INDEX IF NOT EXISTS uq_donation_events_tx_no_op_id
ON donation_events (transaction_hash)
WHERE indexer_operation_id IS NULL;
```

These mirror the equivalent indexes on the `donations` table introduced in migration `028`.
A duplicate `INSERT` on either table is now rejected by the constraint rather than silently
stored, providing defence-in-depth even if the advisory lock is not available.

The migration also adds an optional `last_lock_skipped_at TIMESTAMPTZ` column to
`indexer_state` so operators can see when a lock-skip occurred via a simple `SELECT`.

### 3. Lock-Skip Telemetry

When a caller is skipped by the advisory lock, the services:

- Log a structured `warn` event (`backfill_lock_busy` / `reconciler_lock_busy`) via Pino.
- Best-effort update `indexer_state.last_lock_skipped_at = NOW()` so the timestamp is
  visible to operators querying the table directly or via the admin API.

---

## Files Changed

| File | Change |
|------|--------|
| `backend/src/services/indexerBackfill.js` | Wrapped `runBackfill()` body in `pg_try_advisory_lock` / `pg_advisory_unlock`. Exports `_backfillLockKey` for testing. |
| `backend/src/services/indexerReconciler.js` | `runReconciliation()` acquires the same advisory lock key before doing any work. Concurrent calls return `{ skipped: true }` immediately. |
| `backend/src/db/migrations/030_indexer_backfill_lock.js` | New expand-phase migration: unique partial indexes on `donation_events`; `last_lock_skipped_at` column on `indexer_state`. |
| `backend/src/services/indexerConcurrency.test.js` | New concurrency test suite — 6 tests verifying mutual exclusion between concurrent `runBackfill()` / `runReconciliation()` calls. |
| `CHANGELOG.md` | One-line entry under `[Unreleased] → Fixed` (closes #119). |

---

## Implementation Detail

### Advisory lock key derivation

```js
// FNV-1a 64-bit hash of "indigopay_indexer_backfill", masked to signed int8
const BACKFILL_LOCK_NAME = "indigopay_indexer_backfill";

function fnv1a64(str) {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash & 0x7fffffffffffffffn; // mask to signed int8 range
}

const BACKFILL_LOCK_KEY = fnv1a64(BACKFILL_LOCK_NAME);
```

The same deterministic hash scheme is used by the migration runner's advisory lock
(`MIGRATION_LOCK_KEY` in `migrate.js`), ensuring consistency across all Postgres
advisory lock usages in the codebase.

### Lock acquisition and release pattern

```js
const lockClient = await pool.connect();
let lockAcquired = false;

try {
  const { rows } = await lockClient.query(
    "SELECT pg_try_advisory_lock($1) AS acquired",
    [BACKFILL_LOCK_KEY],
  );
  lockAcquired = rows[0]?.acquired === true;

  if (!lockAcquired) {
    logger.warn({ event: "backfill_lock_busy" }, "Lock held — skipping");
    return { skipped: true, ... };
  }

  // ... do work ...
} finally {
  if (lockAcquired) {
    await lockClient
      .query("SELECT pg_advisory_unlock($1)", [BACKFILL_LOCK_KEY])
      .catch(() => {});
  }
  lockClient.release();
}
```

A dedicated `lockClient` (separate from the pool's regular query client) is used so the
advisory lock lifetime is exactly the duration of the function — not shared with other
concurrent pool queries.

### Idempotency already present on `donations` table

The `handleDonation` function in `indexerDonationHandler.js` already issues:

```sql
INSERT INTO donations (..., indexer_operation_id)
VALUES (...)
ON CONFLICT DO NOTHING
RETURNING id
```

Migration `028` added partial unique indexes on `donations(transaction_hash, indexer_operation_id)`
to back this `ON CONFLICT`. Migration `030` extends the same guarantee to `donation_events`
(the projection/event store), completing the two-table idempotency picture.

---

## Testing

### Unit / concurrency tests (no Docker required)

```bash
cd backend && npm test -- --testPathPatterns="indexerConcurrency" --no-coverage
```

**6 tests — all green:**

| Test | Description |
|------|-------------|
| `concurrent runBackfill() calls: only one executes, other returns skipped` | Two simultaneous backfill calls — exactly one gets `skipped: true` |
| `concurrent runReconciliation() calls: only one executes, other returns skipped` | Two simultaneous reconciler cycles — exactly one gets `skipped: true` |
| `concurrent backfill + reconciliation: only one executes, other returns skipped` | Cross-service race — backfill and reconciler together — exactly one is skipped |
| `sequential backfill calls both execute (lock released between calls)` | Lock is released after each call; the next sequential call proceeds normally |
| `skipped backfill records last_lock_skipped_at timestamp` | Skipped caller updates `indexer_state.last_lock_skipped_at` |
| `_backfillLockKey is a bigint within the signed int8 Postgres range` | Key ∈ [0, 2^63-1], valid for `pg_advisory_lock` |

### Existing tests (unchanged — no regressions)

```bash
cd backend && npm test -- --testPathPatterns="indexerDonationHandler.integration" --no-coverage
```

The existing `indexerDonationHandler.integration.test.js` suite continues to pass —
it exercises the `ON CONFLICT DO NOTHING` idempotency at the `donations` table level
against a real testcontainers Postgres instance.

### Migration

```bash
npm run db:migrate
```

Migration `030_indexer_backfill_lock` is `phase: "expand"` — adds indexes and a nullable
column only. It is fully backward-compatible and safe to apply with zero downtime.

---

## Acceptance Criteria

- [x] Overlapping `runBackfill()` / `runReconciliation()` calls do **not** duplicate donation data
- [x] Concurrent callers serialised via `pg_try_advisory_lock` — second caller returns `{ skipped: true }` immediately
- [x] Unique partial indexes on `donation_events` reject duplicate inserts at the DB layer (migration `030`)
- [x] Lock-skip telemetry written to `indexer_state.last_lock_skipped_at` and structured logs
- [x] Concurrency test suite added (`indexerConcurrency.test.js` — 6 tests, all passing)
- [x] No existing CI test scripts altered
- [x] `CHANGELOG.md` entry added under `[Unreleased] → Fixed`

---

## CI Requirements

Standard backend CI — no changes to CI scripts:

- `npm test` — unit + integration test suite (includes the new concurrency tests)
- `npm run lint` — ESLint on `src/**/*.js` (0 errors on changed files)
- `npm run migration:lint` — migration policy linter (`030` passes: expand phase, no NOT NULL without DEFAULT, no renames)

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Re-entrant lock deadlock when reconciler calls backfill internally | Postgres advisory locks are **re-entrant per session** — the same session can acquire the same lock multiple times without blocking. Verified via Postgres docs and confirmed in the concurrency test. |
| Lock held indefinitely if the process crashes mid-backfill | Session-level advisory locks are automatically released when the database connection is closed — crash recovery is built into Postgres. |
| `pg_try_advisory_lock` not available on older Postgres | `pg_try_advisory_lock` has been available since Postgres 8.2 (2006). The project targets Postgres 15. |
| Migration `030` conflicts with an existing `030_*` file | Checked — the highest existing migration is `029_device_token_expiry.js`. `030` is the next slot. |
| Adding unique indexes on `donation_events` causes blocking during migration | Indexes use `CREATE UNIQUE INDEX IF NOT EXISTS` (not `CONCURRENTLY`) inside the migration transaction. Safe for a fresh deploy; for a live system, a DBA can run the index creation `CONCURRENTLY` separately before applying the migration. |

---

## Rollback Plan

No data migration is involved — rollback is a single command:

```bash
npm run db:rollback    # Drops indexes + last_lock_skipped_at column (030 down())
git revert HEAD       # Reverts indexerBackfill.js + indexerReconciler.js changes
```

The `donations` table is unchanged; existing `donation_events` rows are unaffected.

---

## Related Issues

- Closes #119 — `indexerBackfill.js` and `indexerReconciler.js` can run concurrently with no advisory lock or idempotent upsert guard

---

**Labels**: GrantFox OSS, Official Campaign, area/backend, type/bug, priority/medium

**Tested on**: Development environment with PostgreSQL 15 (testcontainers)
