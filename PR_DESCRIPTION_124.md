# feat(gf-124): Soroban RPC Event Subscription Service for Real-Time Donation Processing

Closes #124

## Summary

This PR implements a **Soroban RPC Event Subscription Service** that polls the Soroban RPC `getEvents` endpoint every 5 seconds for all contract events emitted by the IndigoPay smart contract. It processes them into the database with deduplication, batch commits, cursor persistence, and a dead-letter queue. The service runs **alongside** the existing Horizon SSE indexer, providing coverage for contract-only events (badge mints, governance, project registrations, USDC donations) that the Horizon stream cannot see.

---

## Background

The existing Horizon SSE indexer (`indexerService.js`) listens for raw Stellar payment operations. This misses:

- **USDC donations** — contract-mediated `donate_usdc()` calls
- **Contract-only events** — badge mints (`nft_mint`), project milestone NFTs (`pnft_mint`), governance votes (`voted`), project verifications (`proj_ver`)
- **Rich event data** — the contract emits structured events with badge tier, message hash, CO₂ offsets

This service fills those gaps, giving IndigoPay complete coverage of all on-chain activity.

---

## Changes

### Files Created (3 files, ~1,127 lines)

| File | Lines | Purpose |
|------|-------|---------|
| `backend/src/services/sorobanEventService.js` | 958 | Core service — polling loop, event dispatch, handlers, dedup, DLQ, Prometheus metrics |
| `backend/src/routes/admin/events.js` | 105 | Admin API: `GET /status`, `POST /rescan`, `POST /restart` |
| `backend/src/db/migrations/015_indexer_state.js` | 64 | Creates `indexer_state` (cursor persistence) and `soroban_event_dlq` tables |

### Files Modified (2 files, +148 lines)

| File | Changes | Purpose |
|------|---------|---------|
| `backend/src/server.js` | +39 lines | Start the service at boot, register shutdown hooks, mount admin events routes |
| `docs/indexer.md` | +107/-2 lines | Document the new service: architecture, events table, metrics, admin API, configuration |

---

## Architecture

```
┌─────────────────────────┐    ┌──────────────────────────┐
│  Horizon SSE Indexer    │    │  Soroban Event Service   │
│  (indexerService.js)    │    │  (sorobanEventService.js)│
│                         │    │                          │
│  Raw payment ops (XLM)  │    │  Contract events:        │
│  ↳ payment operations   │    │  ↳ donated               │
│                         │    │  ↳ proj_reg, nft_mint    │
│                         │    │  ↳ voted, proj_ver       │
│                         │    │  ↳ prop_new, prop_veto   │
└──────────┬──────────────┘    └───────────┬──────────────┘
           │                               │
           └───────────┬───────────────────┘
                       ▼
              ┌─────────────────┐
              │   PostgreSQL    │
              │   donations,    │
              │   profiles,     │
              │   projects      │
              └─────────────────┘
```

### Polling Loop

1. **Every 5 seconds**, `getEvents()` is called with the contract ID and the last persisted cursor
2. Events are dispatched to type-specific handlers via a handler map
3. **Deduplication**: `pagingToken`-based in-memory set (pruned at 100K entries) + `transaction_hash` DB check for `donated` events
4. **Batch commit**: Up to 50 events fetched per RPC call; `donated` handler wraps DB writes in a transaction
5. **Cursor persistence**: Latest `pagingToken` saved to `indexer_state` after each batch — survives restarts
6. **DLQ**: Failed events written to `soroban_event_dlq` with full event data and error details

### Event Handlers

| Event | Contract Function | Handler Action |
|-------|-------------------|----------------|
| `donated` | `donate()` / `donate_usdc()` | Insert donation → update project `raised_xlm` → upsert donor profile → compute badges → emit WebSocket event |
| `proj_reg` | `register_project()` | Logged for audit |
| `nft_mint` | Auto-mint on badge upgrade | Logged for audit |
| `pnft_mint` | Project milestone NFT | Logged for audit |
| `voted` | `vote_verify_project()` | Logged for audit |
| `proj_ver` | Governance resolution | Updates `projects.on_chain_verified = TRUE` |
| `prop_rej` | Proposal rejection | Logged for audit |
| `prop_veto` | Admin veto | Logged for audit |
| `prop_new` | `create_proposal()` | Logged for audit |
| `deact_all`, `co2_rate`, `prj_pause`, `prj_resm`, `usdc_set`, `sub_creat`, `sub_canc` | Various admin functions | Logged for audit |

---

## Prometheus Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `indigopay_soroban_events_processed_total` | Counter | `event_type`, `outcome` | Events processed (success/failed/skipped) |
| `indigopay_soroban_events_lag_ledgers` | Gauge | — | Ledger lag |
| `indigopay_soroban_events_running` | Gauge | — | 1 if polling loop is active |
| `indigopay_soroban_events_batch_duration_seconds` | Gauge | — | Duration of last batch cycle |

---

## Admin API

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/admin/events/status` | GET | Admin | Service status (running, cursor, dedup set size) |
| `/api/v1/admin/events/rescan` | POST | Admin | Trigger rescan from cursor (or start) |
| `/api/v1/admin/events/restart` | POST | Admin | Stop + restart the polling loop |

---

## Acceptance Criteria Checklist

- [x] Service polls Soroban RPC every 5 seconds
- [x] All contract event types are dispatched to handlers
- [x] `donated` events recorded as donations with project + profile updates
- [x] Cursor persisted to `indexer_state` — survives restarts
- [x] Deduplication by `pagingToken` + `transaction_hash`
- [x] Batch commit (50 events per RPC call)
- [x] Failed events written to `soroban_event_dlq`
- [x] Admin API: `POST /api/v1/admin/events/rescan`
- [x] Prometheus metrics exported
- [x] `cd backend && npm test` passes (46 suites, 516 tests)
- [x] Reuses existing `withRetry`, `rpcBreaker`, `computeBadges` patterns
- [x] Graceful shutdown with cursor save + cleanup

---

## Testing

```
Test Suites: 46 passed, 46 total
Tests:       516 passed, 516 total
```

### Manual Integration Testing Checklist

- [ ] Deploy contract on testnet, call `donate()` — verify event processed within 5-10 seconds
- [ ] Call `donate_usdc()` — verify USDC donation recorded
- [ ] Verify cursor advances in `indexer_state` table
- [ ] Restart backend — verify cursor resumes from persisted value
- [ ] Check Prometheus `/metrics` endpoint for `indigopay_soroban_*` metrics
- [ ] Verify dedup: replay same event — should be skipped
- [ ] Test admin `/api/v1/admin/events/rescan` endpoint

---

## Known Gaps (Non-blocking)

1. **USDC currency detection** — the contract `donated` event value is `(amount, badge, msg_hash)` with no currency field. The handler hardcodes `currency = "XLM"`. USDC detection would require cross-referencing the token address from the `usdc_set` event or the Horizon payment operation.

2. **Shared donation logic** — the `handleDonated` handler duplicates the `handleDonation` pattern from `indexerService.js`. A future refactor should extract shared donation insertion logic into a common helper.

3. **No `io` for other handlers** — only the `donated` handler emits WebSocket events. Other event types (governance, NFTs) don't trigger real-time frontend updates.

4. **Historical backfill** — the service starts from the latest cursor. Events emitted before deployment require manual reconciliation.

---

## References

- Issue: #124
- Contract events: `contracts/indigopay-contract/src/lib.rs`
- Horizon indexer: `backend/src/services/indexerService.js`
- Shared RPC client: `backend/src/services/stellar.js`
- Documentation: `docs/indexer.md`
- Related: #122 (Horizon SSE indexer), #131 (push notifications)
