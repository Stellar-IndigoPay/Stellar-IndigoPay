# Chaos Engineering Suite

Fault-injection tests for the Stellar-IndigoPay resilience guarantees
(issue #1147, Part B). The platform has always unit-tested its resilience
patterns (circuit breakers, retries, idempotency, cache fallback) in
isolation; this suite exercises them **together, under real faults** —
crashing/restarting Redis and Postgres, and serving 503/timeout from a
fault-injecting Horizon + Soroban RPC stub.

## Scenarios

| ID | Fault injected | Verifies |
|----|----------------|----------|
| 01 | Redis container stopped mid donation-spike | Cache degrades to no-op (reads return `null`, no throws); donations keep persisting to Postgres; no data loss; cache restored after restart |
| 02 | Postgres container stopped/restarted during donation | Donation fails cleanly with zero partial writes; the connection pool recovers; re-submitting the same tx hash is idempotent — **no double-records**, totals unchanged |
| 03 | Horizon + Soroban RPC answer HTTP 503 | Donation fails cleanly (no fake data); the recurring keeper cycle degrades gracefully and preserves the due schedule (**no data loss**); `withRetry` retries with exponential backoff and the shared circuit breaker opens; after recovery the same donation records (**eventual recording**), replays don't double-record, and the breaker returns to CLOSED |
| 04 | Soroban RPC delays then fails (timeout stand-in) | Transient failures are retried with backoff; sustained timeouts trip the circuit breaker (calls fast-fail while OPEN); after the fault clears the same call succeeds (**eventual success**) and the breaker closes |

## How it works

```
test/chaos/
├── driver.js            # in-container runner: executes the 4 scenarios, writes summary.json
├── run-chaos.sh         # host orchestrator: topology up/down + Redis/Postgres crash injection
├── lib/harness.js       # markers, stub fault API, DB seeding, recordDonation shim
├── scenarios/           # one file per scenario (see table above)
└── stub/server.js       # zero-dependency Horizon (REST) + Soroban RPC (JSON-RPC) fault stub
```

Topology (`docker-compose.chaos.yml`): `postgres` + `redis` (same images as
`docker-compose.test.yml`) + `chaos-stub` + `backend`. The backend image is
the same `indigopay-backend-test:ci` image `ci.yml` builds; the container
mounts `./backend/src` over BOTH `/app/src` (where `npm run db:migrate`
resolves migrations from WORKDIR `/app`) and `/backend/src` (where the
driver requires the app modules), plus `./test/chaos` and a shared
`./.chaos-run` marker directory, then runs
`npm run db:migrate && node /chaos/driver.js`. Migrations and the code
under test therefore always come from the same checked-out revision.

`run-chaos.sh` preserves `.chaos-run/summary.json` across its own teardown
(only transient marker files are cleaned), so the nightly workflow can
upload the results as an artifact and write them to the job summary after
the script exits.

Fault coordination:

- **Scenarios 01/02** — the driver writes `NN.ready`; the host runs
  `docker compose stop <service>`; the driver asserts mid-fault behaviour,
  writes `NN.during`; the host runs `docker compose start <service>` and
  writes `NN.recovered`; the driver asserts recovery.
- **Scenarios 03/04** — the driver injects faults itself through the stub's
  admin API (`POST /__chaos/fault { target, mode: "503"|"timeout" }`), so no
  host involvement is needed.

The stub emulates only what the exercised code paths touch: Horizon
`/transactions/:hash` (donation tx verification), `/accounts/:id` (keeper
`loadAccount`), `/fee_stats` (readiness), and Soroban JSON-RPC
(`getLatestLedger`, `simulateTransaction`, `sendTransaction`, `getEvents`).
Because the app's `rpc.Server` refuses plain HTTP, the Soroban-RPC
resilience assertions drive the real `withRetry`/`rpcBreaker` exports from
`backend/src/services/stellar.js` against a stub-bound client with
`allowHttp: true`.

> Note on "timeout" mode: a true TCP hang is indistinguishable from a dead
> peer to axios/fetch (no short client timeout), so the stub holds the
> request for ~800ms and then fails it with HTTP 503. That deterministically
> exercises the retry + backoff + breaker path that a real timeout would.

## Running

```bash
bash test/chaos/run-chaos.sh
```

The script builds the backend test image on first run, brings the topology
up, coordinates the host-injected faults, and exits 0 only when every
scenario passed. Results land in `.chaos-run/summary.json`.

CI: `.github/workflows/chaos-nightly.yml` runs the suite nightly (03:00 UTC,
plus manual `workflow_dispatch`) with the GHA-cached image build, uploads
`.chaos-run/` as an artifact, and writes the summary to the job page.

## Adding a scenario

1. Create `scenarios/NN-name.js` exporting `run()` (see `lib/harness.js` for
   `setFault`, marker helpers, DB seeding, and the `recordDonation` shim).
2. Register it in `driver.js`'s `scenarios` array.
3. If it needs a host-injected container fault, add a `fault_dance` call in
   `run-chaos.sh`.
