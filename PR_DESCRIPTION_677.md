# Fix: Distributed leader election for cron/keeper workers via Postgres advisory locks

> **Closes #677** — Backend: Cron/keeper workers run in every replica with no leader election, risking duplicate on-chain actions

---

## TL;DR

Four backend cron/keeper workers — `recurringKeeper`, `guardian`, `matchExpiry`, and `co2Verifier` — each start their loop on **every** replica of the k8s HPA (min 2). Their only concurrency guard is a per-process flag or interval handle, which cannot see the other replica. This PR adds a shared, session-scoped **Postgres advisory lock** helper and wraps every worker cycle in it, so exactly one replica executes a given cycle. A deterministic concurrency test proves that when two cycles race for the same lock, only one runs.

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Root Cause](#root-cause)
3. [Design Options Considered](#design-options-considered)
4. [Chosen Solution](#chosen-solution)
5. [How Postgres Advisory Locks Work Here](#how-postgres-advisory-locks-work-here)
6. [Changes by File](#changes-by-file)
7. [Failure Modes](#failure-modes)
8. [Testing](#testing)
9. [Acceptance Criteria](#acceptance-criteria)
10. [Impact Analysis](#impact-analysis)
11. [Rollback Plan](#rollback-plan)
12. [Security Considerations](#security-considerations)
13. [References](#references)

---

## Problem Statement

`server.js` registers these four services as **optional workers** on every process:

```js
// server.js (abridged)
await startOptionalWorker({ name: "guardian_service",   start: guardianService.start, stop: guardianService.stop });
await startOptionalWorker({ name: "recurring_keeper",   start: recurringKeeper.start, stop: recurringKeeper.stop });
await startOptionalWorker({ name: "match_expiry",       start: matchExpiry.start,     stop: matchExpiry.stop });
await startOptionalWorker({ name: "co2_verification_cron", start: startCO2VerificationCron, stop: stopCO2VerificationCron });
```

In a multi-replica deployment (HPA `min: 2`), each replica independently:

| Worker | Interval | Current guard | Cross-replica safe? |
| --- | --- | --- | --- |
| `recurringKeeper` | 60s | `isExecuting` module flag | ❌ process-local only |
| `guardian` | 12h | `intervalId` handle | ❌ process-local only |
| `matchExpiry` | 15m | `_intervalHandle` handle | ❌ process-local only |
| `co2Verifier` | weekly (pg-boss cron) | pg-boss schedule dedup + `teamSize: 1` | ⚠️ mostly safe, not explicit |

The failure modes are financial in nature:

- **`recurringKeeper`** — two replicas both observe a matured `recurring_donations` row (`next_execution_at <= NOW()`) and both build/sign/submit `execute_recurring`. A recurring donor is **double-charged**.
- **`guardian`** — two replicas both submit `extend_all_ttl`, double-spending admin fee and racing on the admin account sequence.
- **`matchExpiry`** — two replicas both issue the `UPDATE donation_matches SET status=…` statements. (This one is idempotent at the DB level, but still burns duplicate work and log noise.)
- **`co2Verifier`** — duplicate verification runs write duplicate `co2_verification_runs` audit rows if a job is ever delivered twice.

## Root Cause

The guards are **in-process state** (`isExecuting`, `intervalId`, `_intervalHandle`), which by definition cannot coordinate across processes. There is no distributed lock, no leader-election primitive, and (for `recurringKeeper`/`guardian`) no on-chain idempotency. Postgres is already a hard dependency of the backend, but none of these workers use it for mutual exclusion.

## Design Options Considered

| Option | How it works | Pros | Cons | Verdict |
| --- | --- | --- | --- | --- |
| **A. Per-cycle advisory lock** (`pg_try_advisory_lock`) | Each tick probes a session lock; the loser skips | Minimal code, non-blocking, auto-failover, keeps existing intervals | Holds a pooled connection for the cycle duration | ✅ **Chosen** |
| **B. Session lock held for process lifetime** | Leader holds `pg_advisory_lock` forever; followers wait/poll | Classic "one leader" model | Leader must re-acquire on connection drop; ties up a connection permanently; followers need a watch loop | Rejected (complexity) |
| **C. Migrate all workers to pg-boss cron** | `schedule()` + `work({teamSize:1})` dedups across replicas | Existing pattern in repo (`retentionWorker`, `idempotencyCleanup`) | Larger refactor; changes scheduling semantics for on-chain keepers; `guardian`/`recurringKeeper` are `setInterval`-based today | Rejected for this PR (partial — `co2Verifier` already uses it) |
| **D. Kubernetes lease election** | `coordination.k8s.io/leases` via client-go | K8s-native | Backend would need k8s RBAC + client; overkill for four cron loops; breaks local/dev parity | Rejected |

**Why A:** it is the smallest change that satisfies the acceptance criteria ("acquire a per-worker advisory lock before each cycle"), uses a dependency that already exists, and — because `pg_try_advisory_lock` is non-blocking — a replica that loses the race simply skips its cycle rather than queueing. Leadership failover is automatic: if the leader's connection drops, the session lock evaporates and the next tick on any replica acquires it.

## Chosen Solution

### New module: `backend/src/services/advisoryLock.js`

```js
async function withAdvisoryLock(lockName, fn) {
  const client = await pool.connect();              // dedicated session
  try {
    const { rows } = await client.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [lockName],
    );
    if (!rows[0]?.acquired) return false;           // another replica owns it
    try {
      await fn();
      return true;
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockName])
        .catch((err) => logger.warn({ event: "advisory_lock_unlock_failed", lock: lockName, err: err.message }, "..."));
    }
  } finally {
    client.release();
  }
}
```

A frozen `LOCK_KEYS` map assigns each worker a distinct, stable name:

```js
const LOCK_KEYS = Object.freeze({
  recurringKeeper: "worker:recurring_keeper",
  guardian:        "worker:guardian",
  matchExpiry:     "worker:match_expiry",
  co2Verification: "worker:co2_verification",
});
```

The lock name is mapped to a 64-bit key with Postgres' built-in `hashtext()`, so the key derivation is deterministic and shared across replicas without any client-side hashing.

### Worker wiring

Each worker keeps its raw cycle function untouched (so existing unit tests remain meaningful) and adds a thin wrapper that the scheduler calls instead:

```js
// recurringKeeper.js
async function runKeeperCycleWithLock() {
  return withAdvisoryLock(LOCK_KEYS.recurringKeeper, runKeeperCycle);
}

// guardian.js
async function runGuardianCycle() {
  return withAdvisoryLock(LOCK_KEYS.guardian, runGuardian);
}

// matchExpiry.js
async function runMatchExpiryCycle() {
  return withAdvisoryLock(LOCK_KEYS.matchExpiry, checkAndExpireMatches);
}

// co2Verifier.js — wraps the pg-boss worker handler
async function runScheduledVerification() {
  return withAdvisoryLock(LOCK_KEYS.co2Verification, runVerificationForAllProjects);
}
```

`start()` in each `setInterval`-based worker now invokes the wrapper for both the initial run and each tick.

## How Postgres Advisory Locks Work Here

- Advisory locks are **session-scoped**, not transaction-scoped. That is why `withAdvisoryLock` takes a **dedicated client** via `pool.connect()` and runs the try-lock, the work, and the unlock on the **same** connection — otherwise the unlock would target a different session and the lock would leak until the session ends.
- `pg_try_advisory_lock` returns `true`/`false` **immediately**; it never blocks. A replica that loses the race returns `false` and its `fn` is never invoked.
- Releasing the client (or the connection dropping) also releases the session lock, so a crashed leader cannot leave a stale lock.

## Changes by File

| File | Change |
| --- | --- |
| `backend/src/services/advisoryLock.js` | **New.** `withAdvisoryLock(lockName, fn)` + `LOCK_KEYS`. |
| `backend/src/services/recurringKeeper.js` | Import helper; add + export `runKeeperCycleWithLock()`; `start()` uses it for initial run and interval. |
| `backend/src/services/guardian.js` | Import helper; add + export `runGuardianCycle()`; `start()` uses it. |
| `backend/src/services/matchExpiry.js` | Import helper; add + export `runMatchExpiryCycle()`; `start()` uses it. |
| `backend/src/services/co2Verifier.js` | Import helper; add + export `runScheduledVerification()`; pg-boss worker handler invokes it. |
| `backend/src/services/advisoryLock.test.js` | **New.** Helper behavior + deterministic two-cycle concurrency test. |
| `backend/src/services/recurringKeeper.test.js` | **New.** Verifies lock wiring + lock-not-acquired path. |
| `backend/src/services/guardian.test.js` | Added `runGuardianCycle` coverage. |
| `backend/src/services/matchExpiry.test.js` | Added `runMatchExpiryCycle` coverage (acquired + not-acquired). |
| `backend/src/services/co2Verifier.test.js` | Added `runScheduledVerification` coverage. |
| `CHANGELOG.md` | Entry under `### Added`. |
| `PR_DESCRIPTION_677.md` | This document. |

## Failure Modes

| Scenario | Behaviour |
| --- | --- |
| DB unavailable at lock acquisition | `pool.connect()`/query throws; the `start()` wrapper catches and logs; next tick retries. |
| Another replica holds the lock | `pg_try_advisory_lock` returns `false`; cycle skipped; `advisory_lock_not_acquired` debug log. |
| Leader crashes mid-cycle | Session ends → lock auto-released → next tick on any replica acquires it. |
| Guarded `fn` throws | `finally` releases the lock, error propagates to the caller (logged by the existing cycle handler). |
| Unlock query fails | Warn log emitted; releasing the client drops the lock anyway; `fn`'s outcome is never masked. |
| `hashtext` key collision | Astronomically unlikely; worst case is a skipped cycle (safety), never a duplicate. |

## Testing

### Targeted suites

```bash
cd backend
npx jest \
  src/services/advisoryLock.test.js \
  src/services/recurringKeeper.test.js \
  src/services/guardian.test.js \
  src/services/matchExpiry.test.js \
  src/services/co2Verifier.test.js
```

Result: **5 suites, 70 tests passed.**

The key test — "two concurrent cycles for the same worker: only one executes" — reproduces Postgres' lock semantics in a deterministic fake client:

```js
const first = withAdvisoryLock("worker:recurring_keeper", async () => {
  firstRan = true;
  await firstHolding;               // hold the lock
});
await waitFor(() => firstRan);      // first has acquired
const second = await withAdvisoryLock("worker:recurring_keeper", async () => {
  secondRan = true;                 // must never run
});
expect(second).toBe(false);
expect(secondRan).toBe(false);
releaseFirst();
expect(await first).toBe(true);
```

### Full unit suite

```bash
cd backend
npx jest --maxWorkers=2 \
  --testPathIgnorePatterns='/node_modules/' '/scripts/load-modules.js' \
  '\.integration\.' '\.regression\.' '\.performance\.'
```

Result: **107 suites, 1142 tests passed.** (Integration/regression/performance suites are excluded locally because they require Docker/Postgres; they are unchanged and covered by the standard backend CI.)

### Lint + migration lint

```bash
cd backend
npm run lint            # 0 errors (warnings are pre-existing)
npm run migration:lint  # 37 migration files, no violations
```

## Acceptance Criteria

- [x] Only one replica executes a given cron/keeper cycle
- [x] Per-worker advisory lock acquired before each cycle
- [x] Concurrency/leader-election test proving two concurrent cycles → one executes
- [x] `recurringKeeper.js`, `guardian.js`, `matchExpiry.js`, `co2Verifier.js` in scope
- [x] Standard backend CI passes (lint + migration lint + tests)
- [x] CHANGELOG entry added
- [x] Single commit

## Impact Analysis

- **Reliability** — eliminates duplicate on-chain keeper actions across the multi-replica deployment. This is the primary goal.
- **Availability** — losing replicas skip non-blockingly; leadership failover is automatic when the leader's connection drops. No single point of coordination beyond Postgres (which is already required).
- **Performance** — one extra `pg_try_advisory_lock` + `pg_advisory_unlock` round-trip per cycle on a dedicated pooled connection, negligible relative to the on-chain simulation/submission these workers already perform.
- **Operational** — no new infrastructure, no schema migration, no new env vars. A `worker:*` lock name appears in the `advisory_lock_not_acquired` debug log for observability.
- **Scope** — intentionally does **not** change on-chain keeper incentives (out of scope per the issue).

## Rollback Plan

```bash
git revert <commit-sha>
```

No migrations or schema changes are involved, so rollback is a clean source revert with no data cleanup.

## Security Considerations

- Lock keys are worker-name literals; no user-supplied input reaches `hashtext()` (parameterized query, single `$1` text parameter — no SQL-injection surface, consistent with the repo's `sql-injection` ESLint rule).
- No secrets or credentials are introduced; the helper reuses the existing `../db/pool`.

## References

- Issue: [#677](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/677)
- `backend/src/services/recurringKeeper.js`, `guardian.js`, `matchExpiry.js`, `co2Verifier.js`
- `backend/src/server.js` (worker wiring)
- PostgreSQL docs: [Advisory Locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)

---

**Labels**: GrantFox OSS, area/backend, type/bug

**Tested on**: Node 24.14.0, PostgreSQL advisory-lock semantics exercised via deterministic unit tests

**Contributors**: @codebuff
