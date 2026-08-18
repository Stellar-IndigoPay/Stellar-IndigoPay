# [GF-028] Frontend: Build an admin audit log viewer with filtering and CSV export

**Closes:** #83
**Branch:** `feat/admin-audit-log-viewer-83`

## Summary

This PR builds a comprehensive admin audit log viewer in the admin dashboard with filtering, full-text search, date range selection, pagination, and CSV export — critical for security reviews and compliance. The backend audit logging service already records every admin action, but there was no admin UI to view, search, or export the audit log.

## Changes

### ✨ New Files

| File | Description |
|------|-------------|
| `frontend/components/admin/AuditLogTable.tsx` | Reusable, fully-featured audit log table component with filter bar (actor, action, target type, date range, full-text search), paginated rows with expandable metadata popover, and CSV export button. Includes loading skeleton, empty state (with clear-filters prompt), and error state. Action dropdown groups actions by category (Verification, Projects, Admin, Matches, Webhooks) with color-coded badges. |
| `frontend/pages/admin/audit.tsx` | Admin audit log page that wires up `AuditLogTable` with live data fetching, debounced filter resets, CSV export download via blob, auth checking, and distinct action loading from stats API. |
| `frontend/components/__tests__/AuditLogTable.test.tsx` | 15 frontend test cases covering: rendering entries, pagination info display, filter input rendering, filter change callbacks (actor + action), export button click + disabled state, page change callbacks, Previous/Next button states, loading skeleton, error state, empty state (with and without active filters), action dropdown options, and metadata popover toggle. |

### 📝 Modified Files

| File | Changes |
|------|---------|
| `frontend/components/admin/AdminLayout.tsx` | Added `{ href: "/admin/audit", label: "Audit Log" }` to the admin navigation sidebar. |
| `CHANGELOG.md` | Added entry under `[Unreleased]` → Features documenting the audit log viewer. |

## Acceptance Criteria Checklist

- [x] Admin can view audit log with filters (actor, action, target, date range, search)
- [x] Pagination works (50 per page) with Previous/Next buttons and page number buttons
- [x] CSV export downloads all matching records with current filters applied
- [x] Action type filter shows all distinct actions from the database (fetched from stats API)
- [x] Non-admin requests correctly handled (auth check redirects to `/admin/login`)
- [x] Audit log table is readable on mobile/tablet (responsive column hiding: IP hidden on <lg, Target hidden on <md, metadata preview hidden on <xl)
- [x] Expandable metadata popover with scrollable JSON fields
- [x] Color-coded action badges (red for reject/deactivate, emerald for approve/login, blue for register/create)
- [x] Loading skeleton with animated pulse rows
- [x] Error state with retry option
- [x] `cd frontend && npm test` passes (15/15 AuditLogTable tests ✅)
- [x] `cd backend && npm test` passes (61/61 admin/audit tests ✅)
- [x] `cd frontend && npm run build` succeeds

## Testing

```bash
# Run all frontend tests
cd frontend && npm test

# Run backend audit/admin tests
cd backend && npx jest --testPathPattern 'audit|admin'

# TypeScript check
cd frontend && npm run type-check

# Lint
cd frontend && npm run lint

# Build
cd frontend && npm run build
```

### Test Results

**Frontend (AuditLogTable):** 15/15 passed ✅
- Renders entries, pagination info, and filter inputs
- Filter change callbacks fire correctly for actor + action
- Export button click + disabled when empty
- Page change callbacks + Previous/Next disabled states
- Loading skeleton renders animated pulse elements
- Error state shows message + retry option
- Empty state shows appropriate message (with/without active filters)
- Action dropdown shows distinct action options
- Metadata popover toggles on click (View metadata → Close metadata)

**Backend (admin/audit):** 61/61 passed ✅
- `src/routes/admin.test.js` — admin route tests
- `src/routes/admin/audit-export.test.js` — CSV/JSON export tests
- `src/routes/admin/audit-stats.test.js` — stats endpoint tests
- `src/routes/admin/webhooks.test.js` — webhook admin tests
- `src/routes/admin/documents.test.js` — document admin tests
- `src/routes/admin/queues.test.js` — queue admin tests
- `src/services/auditChain.test.js` — audit chain integrity tests

**Frontend Build:** ✅ (25 static pages, no errors)

## Manual Verification

1. Navigate to `/admin/audit` (must be authenticated as admin)
2. Verify the audit log table loads with entries
3. Apply filters (actor, action, target type, date range, search) and verify results update
4. Click "Details" on any row to view expandable metadata
5. Click "Export CSV" to download filtered results
6. Navigate between pages using pagination controls
7. Verify IP column is hidden on smaller viewports
8. Verify action badges have appropriate colors
