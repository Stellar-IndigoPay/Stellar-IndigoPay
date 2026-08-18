# Fix: Durable Deduplication for Soroban Event Processing

Closes #679

## Summary

Implements database-level deduplication and atomic cursor commit for `sorobanEventService` to prevent double-application of projection updates during crash/restart scenarios.

## Problem

The previous implementation used an in-memory `Set` to track processed events by `pagingToken`, while the cursor was persisted separately in `indexer_state`. If the service crashed between event processing and cursor update, a restart would re-read already-processed events (the in-memory set is lost), leading to double-applied projections.

## Solution

### 1. Database-Level Deduplication
- Added `soroban_processed_events` table with unique constraint on `paging_token`
- Replaced in-memory `processedTokens Set` with persistent DB storage
- Automatic cleanup of events older than 30 days to prevent unbounded growth

### 2. Atomic Transaction
- Wrapped event processing + cursor update in single DB transaction
- Ensures cursor is only advanced when event is successfully processed and marked
- Re-processing of same `pagingToken` is now idempotent (skipped on dedup check)

### 3. Enhanced Dead-Letter Queue
- Added `soroban_event_dlq` table for failed event tracking
- Includes `paging_token` field for better troubleshooting
- Failed events are marked as processed to avoid infinite retry loops

## Changes

### Migration: `028_soroban_event_dedup.js`
- Creates `soroban_processed_events` table with unique index on `paging_token`
- Creates `soroban_event_dlq` table for failed event tracking
- Adds indexes for efficient cleanup and lookup queries

### Service: `backend/src/services/sorobanEventService.js`
- Removed in-memory `processedTokens Set` and `MAX_DEDUP_SET_SIZE`
- Added `isEventProcessed()` - checks DB for already-processed events
- Added `markEventProcessed()` - inserts processed event record
- Added `cleanupOldProcessedEvents()` - removes events older than 30 days
- Updated `pollEvents()` - uses DB transaction for atomic processing
- Updated `saveCursor()` - accepts optional client for transaction
- Updated `writeToDLQ()` - includes `paging_token` field
- Updated `rescan()` - clears processed events table for full rescan
- Updated `getStatus()` - removed `processedTokenCount` (no longer in-memory)

### Tests: `backend/__tests__/services/sorobanEventService.test.js`
- ✅ Processes new event and marks as processed in DB
- ✅ Skips already-processed event (redelivery idempotency)
- ✅ Atomic cursor update with event processing
- ✅ Writes failed event to DLQ and still marks as processed
- ✅ Processes multiple events in sequence
- ✅ Handles transaction rollback on error
- ✅ Extracts event types correctly
- ✅ Cleanup runs probabilistically

### Documentation: `CHANGELOG.md`
- Added entry under `### Fixed` section

## Testing

### Unit Tests
```bash
npm test -- sorobanEventService.test.js
```

### Manual Testing
1. Start the service and process events
2. Simulate crash (kill process)
3. Restart service
4. Verify events are not double-processed (check logs for "already processed - skipping")
5. Check `soroban_processed_events` table for deduplication records

### Migration Testing
```bash
npm run db:migrate
```

## Acceptance Criteria

- [x] DB-level unique index on event's pagingToken
- [x] Event insert + cursor update wrapped in one transaction
- [x] Redelivery idempotency test added
- [x] Re-processing a pagingToken does not double-apply projections
- [x] Standard backend CI passes
- [x] CHANGELOG entry added

## Impact

- **Performance**: Minimal overhead - one additional DB insert per event (within same transaction)
- **Storage**: `soroban_processed_events` table grows with event volume but auto-cleans after 30 days
- **Reliability**: Eliminates double-application bug, making event ingestion truly idempotent

## Rollback Plan

If issues arise:
```bash
npm run db:rollback  # Reverts migration 028
git revert d6ca0f6  # Reverts code changes
```

## Related Issues

- Closes #679 - Backend: `sorobanEventService` in-memory dedup set + separate cursor commit creates a double-process window

---

**Labels**: GrantFox OSS, Official Campaign, area/backend, type/bug, priority/medium

**Tested on**: Development environment with PostgreSQL 15

**Contributors**: @senmalong
