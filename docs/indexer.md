# IndigoPay Indexing Services

IndigoPay runs two complementary indexing services that together provide
complete coverage of on-chain activity:

1. **Horizon SSE Indexer** — listens for raw Stellar payment operations (XLM and USDC).
2. **Soroban RPC Event Service** — polls contract events from the Soroban RPC for
   contract-only activity (badge mints, governance, project registrations, USDC donations).

---

## Soroban RPC Event Service

The Soroban event service (`sorobanEventService.js`) polls the Soroban RPC
`getEvents` endpoint every **5 seconds** for all events emitted by the
IndigoPay contract. It complements the Horizon SSE indexer by capturing
contract-only events that the Horizon stream cannot see.

### Events Processed

| Event       | Source                | Handler Action                                      |
| ----------- | --------------------- | --------------------------------------------------- |
| `donated`   | `donate()` / `donate_usdc()` | Insert donation record into DB, update project + donor profile |
| `proj_reg`  | `register_project()`  | Logged for audit                                    |
| `nft_mint`  | Auto-mint on badge upgrade | Logged for audit                                    |
| `pnft_mint` | Project milestone NFT | Logged for audit                                    |
| `voted`     | `vote_verify_project()`| Logged for audit                                    |
| `proj_ver`  | Governance resolution | Updates `projects.on_chain_verified = TRUE`         |
| `prop_rej`  | Proposal rejection    | Logged for audit                                    |
| `prop_veto` | Admin veto            | Logged for audit                                    |
| `prop_new`  | Proposal creation     | Logged for audit                                    |
| `deact_all` | Bulk deactivation     | Logged for audit                                    |
| `co2_rate`  | CO₂ rate update       | Logged for audit                                    |
| `prj_pause` | Project paused        | Logged for audit                                    |
| `prj_resm`  | Project resumed       | Logged for audit                                    |
| `usdc_set`  | USDC token configured | Logged for audit                                    |
| `sub_creat` | Subscription created  | Logged for audit (future)                           |
| `sub_canc`  | Subscription canceled | Logged for audit (future)                           |

### Cursor Persistence

- The latest event `pagingToken` is persisted to the `indexer_state` table
  (`key = 'soroban_event_cursor'`) after every successful batch.
- On restart, the service resumes from the last persisted cursor — no events
  are missed during downtime.

### Deduplication

- An in-memory `Set<string>` tracks all pagingTokens processed in the current
  session, pruned to a maximum of 100,000 entries.
- The `donated` handler additionally checks the `donations.transaction_hash`
  column to prevent double-inserting if the Horizon indexer already recorded the
  same donation.

### Dead-Letter Queue

- Events that fail processing are written to the `soroban_event_dlq` table with
  full event data, error message, and stack trace.
- DLQ entries are not automatically retried but can be inspected and replayed
  via the admin API.

### Batch Commit

- Events are fetched with `limit: 50` per RPC call.
- The `donated` handler wraps its DB writes in a PostgreSQL transaction
  (`BEGIN` / `COMMIT` / `ROLLBACK`).
- Non-mutating handlers (log-only) do not require transactions.

### Prometheus Metrics

| Metric                                      | Type    | Labels            | Description                                   |
| ------------------------------------------- | ------- | ----------------- | --------------------------------------------- |
| `indigopay_soroban_events_processed_total`  | Counter | `event_type`, `outcome` | Events processed by type and outcome (success/failed/skipped) |
| `indigopay_soroban_events_lag_ledgers`      | Gauge   | —                 | Ledger lag for event processing               |
| `indigopay_soroban_events_running`          | Gauge   | —                 | 1 if the polling loop is running, 0 otherwise |
| `indigopay_soroban_events_batch_duration_seconds` | Gauge | —            | Duration of the last batch processing cycle   |

### Admin API

| Endpoint                             | Method | Auth  | Description                                   |
| ------------------------------------ | ------ | ----- | --------------------------------------------- |
| `/api/v1/admin/events/status`        | GET    | Admin | Returns service status (running, cursor, etc.) |
| `/api/v1/admin/events/rescan`        | POST   | Admin | Triggers re-scan from provided or start cursor |
| `/api/v1/admin/events/restart`       | POST   | Admin | Stops and restarts the polling loop            |

### Configuration

| Variable               | Default                                | Description                             |
| ---------------------- | -------------------------------------- | --------------------------------------- |
| `SOROBAN_RPC_URL`      | `https://soroban-testnet.stellar.org`  | Soroban RPC endpoint                    |
| `CONTRACT_ID`          | —                                      | IndigoPay contract address              |
| `SOROBAN_RPC_MAX_RETRIES` | `3`                                 | Max retries per RPC call (exponential backoff) |
| Poll interval          | 5 seconds                              | —                                       |
| Batch size             | 50 events                              | —                                       |

### Code Reference

| File                                          | Purpose                                              |
| --------------------------------------------- | ---------------------------------------------------- |
| `backend/src/services/sorobanEventService.js` | Core service — polling, dispatch, dedup, DLQ, metrics |
| `backend/src/routes/admin/events.js`          | Admin endpoints (status, rescan, restart)            |
| `backend/src/db/migrations/015_indexer_state.js` | Creates `indexer_state` and `soroban_event_dlq` tables |
| `backend/src/services/stellar.js`             | Shared `rpcServer`, `withRetry`, `rpcBreaker`        |
| `backend/src/server.js`                       | Starts the service and registers shutdown hooks      |

---

## Horizon Indexer Service (Legacy header preserved)

---

## How It Works

### SSE Stream

The indexer uses the [Stellar SDK](https://github.com/stellar/js-stellar-sdk) `OperationsCallBuilder` to open a **Server-Sent Events (SSE)** connection to Horizon. The stream delivers real-time operations as they are included in ledgers.

```js
stellarServer.operations().cursor(cursor).stream({ onmessage, onerror });
```

- The `operations()` endpoint returns all operations on the network.
- Only `type === "payment"` operations are processed.
- Two asset types are accepted:
  - **Native XLM** (`asset_type === "native"`)
  - **USDC** (`asset_type === "credit_alphanum4"`, `asset_code === "USDC"`, and `asset_issuer` matching the configured `USDC_TOKEN_ADDRESS`)
- A filter matches the payment recipient (`op.to`) against an in-memory cache of active project wallets.

### Cursor Tracking

The cursor is **persisted in PostgreSQL** via the `indexer_state` table:

| Column                   | Type        | Description                                      |
| ------------------------ | ----------- | ------------------------------------------------ |
| `key`                    | TEXT (PK)   | Always `'primary'` (reserved for future sharding) |
| `last_processed_ledger`  | INTEGER     | Highest ledger sequence processed                 |
| `last_processed_at`      | TIMESTAMPTZ | When the cursor was last updated                  |
| `backfill_in_progress`   | BOOLEAN     | Whether a backfill is currently running           |
| `backfill_target_ledger` | INTEGER     | Target ledger for the current backfill (optional) |
| `reconciled_at`          | TIMESTAMPTZ | When the last reconciliation check ran            |

- After a restart, the indexer reads `last_processed_ledger` from the DB and resumes from that point — **zero donation loss**.
- The cursor is updated **atomically within the same transaction** as the donation insert, so the cursor advancement and the donation record are never out of sync.

### Reconnection Backoff

The indexer uses **custom exponential backoff** for SSE reconnection, independent of the SDK's built-in reconnect:

| Attempt | Delay |
| ------- | ----- |
| 1       | 1 s   |
| 2       | 2 s   |
| 3       | 4 s   |
| 4       | 8 s   |
| 5       | 16 s  |
| 6+      | 32 s (capped) |

- The backoff counter resets to 0 on a successful reconnection.
- Each reconnection event is logged and recorded in the `indexer_stream_reconnects_total` Prometheus metric.

### Donation Processing Pipeline

When a matching payment arrives:

1. **Currency detection** — Determines if the payment is XLM or USDC based on `asset_type` and `asset_issuer`.
2. **Amount normalization** — For USDC, the raw amount is stored in the `amount` column; `amount_xlm` is left `null`. The XLM-equivalent is computed using `USDC_TO_XLM_RATE` for `raised_xlm` increment and donor profile updates.
3. **Deduplication** — Checks if the `transaction_hash` already exists in the `donations` table.
4. **Insert donation** — Writes a new row with `project_id`, `donor_address`, `amount_xlm` (null for USDC), `amount`, `currency`, `transaction_hash`.
5. **Update project** — Increments `raised_xlm` by the XLM-equivalent amount and recalculates `donor_count`.
6. **Upsert donor profile** — Computes new `total_donated_xlm`, `projects_supported`, and badge tiers.
7. **Persist cursor** — Updates `indexer_state.last_processed_ledger` in the same transaction.
8. **Emit WebSocket event** — Notifies the frontend in real time via Socket.io with a `currency` field.

All database writes are wrapped in a PostgreSQL transaction (`BEGIN` / `COMMIT` / `ROLLBACK`).

### Wallet Cache

- A `Map<wallet_address, project_id>` is built from the `projects` table at startup.
- The cache is refreshed every **10 minutes** via `setInterval`.
- Only projects with `status = 'active'` are included.

### USDC Token Address Resolution

The USDC token address is resolved at startup inside `updateProjectWallets()`:

1. First, check `process.env.USDC_TOKEN_ADDRESS`.
2. If unset, attempt a Soroban RPC call to `get_usdc_token()` on the deployed contract.
3. If neither succeeds, log a warning and skip USDC indexing (non-fatal).

---

## Backfill Mode

The backfill mode replays historical Horizon operations from a given ledger forward to the current tip. It is provided by `indexerBackfill.js`.

### Triggers

1. **Automatic (via reconciler)** — When the reconciler detects a ledger lag greater than `INDEXER_MAX_LEDGER_LAG` (default 60 ledgers ≈ 5 min), it triggers a backfill automatically.
2. **Manual (admin API)** — `POST /api/v1/admin/indexer/backfill` with optional `fromLedger`, `toLedger`, and `force` parameters.

### How Backfill Works

1. Fetches all active project wallets into a local Map.
2. Paginates through Horizon operations from the start ledger using `order("asc")`.
3. For each payment operation matching a project wallet, calls `handleDonation()` with `isBackfill: true`.
4. Pauses `BACKFILL_PAUSE_MS` (default 100 ms) between pages to avoid Horizon rate limiting.
5. Updates `indexer_state.last_processed_ledger` to the highest processed ledger on completion.

### Backfill Metrics

- `indexer_backfills_total{outcome="success|failed|noop"}` — tracks backfill runs.

---

## Reconciliation

The reconciliation service (`indexerReconciler.js`) runs **every 30 minutes** and:

1. Reads the `last_processed_ledger` from `indexer_state`.
2. Fetches the latest ledger sequence from Horizon.
3. Computes the **ledger lag** (behind = latest - processed).
4. If lag exceeds `INDEXER_MAX_LEDGER_LAG` (default 60), triggers an automatic backfill.
5. Updates `indexer_state.reconciled_at`.
6. Emits Prometheus metrics for lag and duration.

| Env Variable                    | Default   | Description                           |
| ------------------------------- | --------- | ------------------------------------- |
| `INDEXER_RECONCILE_INTERVAL_MS` | 1800000   | 30 min — how often to check           |
| `INDEXER_MAX_LEDGER_LAG`        | 60        | Max allowed ledger lag before backfill |

---

## Dead-Letter Queue

The DLQ worker (`indexerDLQWorker.js`) handles donation processing failures:

### How it works

1. When `handleDonation()` throws, the error is caught and an entry is inserted into `indexer_dlq` with the transaction hash, ledger, and error message.
2. The DLQ worker polls every `INDEXER_DLQ_POLL_INTERVAL_MS` (default 60 s) for unresolved entries.
3. For each entry, it re-fetches the transaction from Horizon and re-attempts processing.
4. On success, the entry is marked `resolved_at = NOW()`.
5. On failure, `retry_count` is incremented and `next_retry_at` is set using exponential backoff.

### DLQ Table

| Column             | Type        | Description                                  |
| ------------------ | ----------- | -------------------------------------------- |
| `id`               | SERIAL PK   | Auto-incrementing ID                         |
| `ledger`           | INTEGER     | Ledger sequence where the operation occurred |
| `transaction_hash` | TEXT        | Unique transaction hash (UNIQUE constraint)  |
| `error_message`    | TEXT        | The error that caused the failure            |
| `retry_count`      | INTEGER     | Number of retry attempts so far              |
| `max_retries`      | INTEGER     | Maximum retries before giving up (default 5) |
| `next_retry_at`    | TIMESTAMPTZ | When the next retry should be attempted      |
| `created_at`       | TIMESTAMPTZ | When the entry was created                   |
| `resolved_at`      | TIMESTAMPTZ | When the entry was successfully resolved     |

### DLQ Backoff Schedule

| Retry # | Delay     |
| ------- | --------- |
| 0       | 1 min     |
| 1       | 2 min     |
| 2       | 4 min     |
| 3       | 8 min     |
| 4       | 16 min    |
| 5+      | ~8 hours (capped) |

---

## Health Check

The enhanced `/health` endpoint now includes indexer status:

```json
{
  "status": "ok",
  "service": "stellar-indigopay-api",
  "network": "testnet",
  "uptimeSeconds": 1234,
  "indexer": {
    "isRunning": true,
    "lastProcessedLedger": 12345678,
    "projectWalletsCount": 15,
    "usdcTokenConfigured": true,
    "usdcToXlmRate": 8.0,
    "reconnectAttempt": 0,
    "timestamp": "2025-01-15T10:30:00.000Z"
  },
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

The admin status endpoint at `GET /api/admin/indexer/status` includes additional detail:

```json
{
  "success": true,
  "data": {
    "indexer": { ... },
    "cursor": {
      "lastProcessedLedger": 12345678,
      "backfillInProgress": false,
      "reconciledAt": "2025-01-15T10:28:00.000Z"
    },
    "dlq": {
      "pendingCount": 0,
      "exhaustedCount": 0
    },
    "reconciler": {
      "isRunning": true,
      "intervalMs": 1800000,
      "maxLedgerLag": 60
    }
  }
}
```

---

## Prometheus Metrics

| Metric                                      | Type    | Labels                         | Description                                         |
| ------------------------------------------- | ------- | ------------------------------ | --------------------------------------------------- |
| `indexer_lag_seconds`                       | Gauge   | —                              | Seconds between latest on-chain ledger and now       |
| `indexer_running`                           | Gauge   | —                              | 1 if the indexer is running, 0 otherwise             |
| `indexer_donations_processed_total`         | Counter | `currency`, `source`           | Total donations processed (stream or backfill)       |
| `indexer_stream_reconnects_total`           | Counter | `reason`                       | Total SSE stream reconnections                       |
| `indexer_backfills_total`                   | Counter | `outcome`                      | Total backfill runs                                  |
| `indexer_ledger_lag`                        | Gauge   | —                              | Current ledger lag (ledgers behind Horizon tip)      |
| `indexer_reconciliation_duration_seconds`   | Gauge   | —                              | Duration of the last reconciliation cycle            |

---

## Failure Modes & Resilience

### SSE Disconnect

The indexer now uses **custom exponential backoff** reconnection (1 s → 2 s → 4 s … 32 s max). The cursor is persisted to the DB, so after reconnection the stream resumes from the last confirmed ledger — **no donation loss**.

### Duplicate Events

Horizon may deliver the same operation more than once. Deduplication checks `transaction_hash` in the `donations` table before inserting — duplicates are silently skipped.

### Horizon Rate Limiting

Backfill mode includes a `BACKFILL_PAUSE_MS` (default 100 ms) pause between pages to avoid rate limits. The stream itself honors Horizon's pacing.

### Process Restart

The cursor in `indexer_state` persists across restarts. On startup, the indexer reads the last processed ledger and resumes — **zero donation loss**.

### Database Connection Failure

If the database is unreachable during `handleDonation`, the transaction rolls back, the error is logged, and the operation is **enqueued to the DLQ** for automatic retry.

### Exception in `onmessage`

An error in a single operation's processing is caught, logged, the DB rolls back, and the operation is **enqueued to the DLQ**. The stream continues processing subsequent operations.

---

## Configuration

| Variable                          | Default                                   | Description                                         |
| --------------------------------- | ----------------------------------------- | --------------------------------------------------- |
| `HORIZON_URL`                     | `https://horizon-testnet.stellar.org`     | Horizon server endpoint                             |
| `DATABASE_URL`                    | —                                         | PostgreSQL connection string                         |
| `USDC_TOKEN_ADDRESS`              | —                                         | Stellar address of the USDC token (required for USDC)|
| `USDC_TO_XLM_RATE`                | `8.0`                                     | Conversion rate: 1 USDC = N XLM                     |
| `INDEXER_BACKFILL_BATCH_SIZE`     | `200`                                     | Operations per backfill page                         |
| `INDEXER_BACKFILL_PAUSE_MS`       | `100`                                     | Pause between backfill pages (ms)                    |
| `INDEXER_RECONCILE_INTERVAL_MS`   | `1800000`                                 | 30 min — reconciliation interval                    |
| `INDEXER_MAX_LEDGER_LAG`          | `60`                                      | Max ledger lag before auto-backfill                  |
| `INDEXER_DLQ_POLL_INTERVAL_MS`    | `60000`                                   | 1 min — DLQ polling interval                         |
| `INDEXER_DLQ_BATCH_SIZE`          | `10`                                      | DLQ entries to process per poll cycle                |
| Wallet cache refresh              | 10 minutes                                | Interval for refreshing project wallets              |

---

## Admin API

### Trigger Backfill

```
POST /api/v1/admin/indexer/backfill
Content-Type: application/json

{
  "fromLedger": 12345000,
  "toLedger": 12346000,
  "force": false
}
```

Response (202):
```json
{
  "success": true,
  "data": {
    "message": "Backfill completed",
    "result": {
      "processed": 42,
      "errors": 0,
      "fromLedger": 12345000,
      "toLedger": 12345678
    }
  }
}
```

### Get Indexer Status

```
GET /api/v1/admin/indexer/status
```

Response includes indexer, cursor, DLQ, and reconciler state.

---

## Code Reference

| File                                       | Purpose                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `backend/src/services/indexerService.js`   | Core indexer — SSE stream, persistent cursor, custom backoff, DLQ integration              |
| `backend/src/services/indexerBackfill.js`  | Backfill mode — paginated Horizon operations replay from cursor to tip                      |
| `backend/src/services/indexerReconciler.js`| Periodic reconciliation — checks ledger lag, auto-triggers backfill, emits metrics          |
| `backend/src/services/indexerDLQWorker.js` | Dead-letter queue worker — polls and retries failed donations with exponential backoff      |
| `backend/src/services/stellar.js`          | Exports the `Horizon.Server` instance and `getOnChainUsdcToken()` used by the indexer       |
| `backend/src/server.js`                    | Calls `startIndexer()`, `startReconciler()`, and `startDLQWorker()` during server boot      |
| `backend/src/routes/health.js`             | Exposes `getStatus()` in the `/health` response with full indexer state                     |
| `backend/src/routes/admin/indexer.js`      | Admin API for backfill trigger and indexer status                                           |
| `backend/src/routes/admin.js`              | Mounts the admin indexer route at `/api/admin/indexer`                                      |
| `backend/src/db/migrations/015_indexer_state.js` | Migration creating `indexer_state` and `indexer_dlq` tables                               |
| `backend/src/services/metrics.js`          | Prometheus metric definitions for indexer health and throughput                             |
| `backend/src/services/store.js`            | `computeBadges()` used to assign donor tiers                                                |
| `backend/src/db/pool.js`                   | PostgreSQL connection pool                                                                  |
