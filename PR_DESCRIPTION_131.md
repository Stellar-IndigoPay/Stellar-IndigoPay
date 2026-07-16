## Summary

Closes #131 — Real-Time Push Notification Infrastructure

Implements the remaining pieces of the production-grade push notification system: governance proposal notifications, recurring donation reminders, notification preference management (with DND hours), stale token auto-detection, and a mobile notification settings screen.

> **Note:** Much of the infrastructure was already in place from prior work (GF-049). This PR fills the remaining gaps identified in #131.

---

## What Already Existed

| Component | Status | File |
|---|---|---|
| Expo Push API service (`sendPushNotification`, `sendDonationReceipt`, `sendMilestoneReachedNotifications`, `sendProjectUpdateNotifications`) | ✅ | `backend/src/services/pushService.js` |
| pg-boss queued delivery worker | ✅ | `backend/src/services/pushQueue.js` |
| Donation receipt trigger | ✅ | `backend/src/routes/donations.js` |
| Milestone reached trigger | ✅ | `backend/src/services/webhook.js` |
| Project update trigger (email + push) | ✅ | `backend/src/routes/updates.js` |
| Device token registration (follow/unfollow/unread-count) | ✅ | `backend/src/routes/notifications.js` |
| `device_tokens` + `project_follows` tables | ✅ | `backend/src/db/migrations/001_initial_schema.js` |
| `notification_preferences` + `push_notifications` (delivery tracking) tables | ✅ | `backend/src/db/migrations/005_push_notifications.js` |
| Mobile notification helpers (permissions, tokens, badge, listeners) | ✅ | `mobile/utils/notifications.ts` |
| Notification handler in root layout | ✅ | `mobile/app/_layout.tsx` |

---

## What This PR Adds

### Backend — Push Service (`backend/src/services/pushService.js`)

**New notification functions:**
- `sendGovernanceProposalNotifications({ proposalId, title, description, endsAt })` — Broadcasts governance proposal alerts to all wallet-linked active devices. Uses a single batched JOIN query (same pattern as `sendProjectUpdateNotifications`) to avoid N+1 DB round-trips. Respects per-user category preferences.
- `sendRecurringReminder({ donorAddress, projectName, amount, currency, ... })` — Sends a reminder 24 hours before a scheduled recurring donation is processed.

**DND enforcement:**
- `isInDndWindow(walletAddress)` — Checks `profiles.notification_dnd` JSONB column against the current time in the configured timezone. Supports both same-day windows (e.g., 08:00–22:00) and overnight windows (e.g., 22:00–08:00). Defaults to "not suppressing" on any error.
- Integrated into `shouldSendPush()` so DND is enforced for **all** push types (donation receipts, milestones, updates, governance, reminders).

**Auto-stale-token detection:**
- When Expo's push API returns `DeviceNotRegistered` for a ticket, the token is automatically marked `is_active = false` in `device_tokens` so it won't be retried on future sends.

**Active-token filtering:**
- All device token queries now include `AND is_active = true` so inactive/stale tokens are never used.

### Backend — Push Queue (`backend/src/services/pushQueue.js`)

Two new job handlers in the pg-boss worker dispatch table:
- `governance_proposal` — calls `pushService.sendGovernanceProposalNotifications`
- `recurring_reminder` — calls `pushService.sendRecurringReminder`

### Backend — Notification Routes (`backend/src/routes/notifications.js`)

| Endpoint | Method | Description |
|---|---|---|
| `/api/notifications/preferences` | `GET` | Fetch per-category push preferences + DND settings for a wallet |
| `/api/notifications/preferences` | `PUT` | Upsert category toggles + DND hours. Uses DELETE+INSERT pattern for portability (avoids partial unique index ON CONFLICT subtleties) |
| `/api/notifications/unregister` | `POST` | Mark a device token as inactive (keeps the row for audit trail) |

The existing `/register` endpoint now sets `is_active = true` on re-registration (so a user reinstalling the app re-activates their token).

### Backend — Migration (`backend/src/db/migrations/014_device_token_active.js`)

- Adds `is_active BOOLEAN NOT NULL DEFAULT true` to `device_tokens`
- Creates partial index `idx_device_tokens_active` on `(wallet_address, is_active) WHERE is_active = true`
- Adds `notification_dnd JSONB` column to `profiles`

### Mobile — Notification Settings (`mobile/app/settings/notifications.tsx` — new file)

Full notification preferences management screen:
- 5 category toggles: Donation Confirmations, Project Updates, Milestone Alerts, Governance Proposals, Recurring Reminders
- DND hours configuration with start/end time inputs
- Uses `useAuth()` context for wallet address; shows connect prompt when no wallet
- Preferences are persisted to the backend via `PUT /api/notifications/preferences`

### Mobile — Other

- **`mobile/app/settings.tsx`** — Added "Notification Preferences" link row navigating to `/settings/notifications`
- **`mobile/app/_layout.tsx`** — Registered `settings/notifications` Stack.Screen
- **`mobile/utils/notifications.ts`** — `setupNotificationResponseListener` now handles `governance_proposal` notification type for deep-linking

---

## Testing Summary

### Backend Tests
```
Test Suites: 46 passed, 46 total
Tests:       516 passed, 516 total
```

New test coverage added:
- `pushService.test.js` — 6 new tests: `sendGovernanceProposalNotifications` (3 tests), `sendRecurringReminder` (2 tests), plus 1 existing test updated for DND. All existing pushService tests updated to account for the extra DND profiles query in `shouldSendPush`.
- `pushQueue.test.js` — 2 new handler dispatch tests: `governance_proposal` and `recurring_reminder`
- `notifications.test.js` — 10 new tests: `GET /preferences` (3), `PUT /preferences` (3), `POST /unregister` (3), plus existing tests updated for `is_active` re-activation

### Manual Testing Required
- Physical device test: Push delivery within 10 seconds of donation
- Background/killed state: Notification received when app is backgrounded
- Deep-link: Tapping a notification navigates to the correct screen
- DND: Notifications suppressed during configured window
- Stale token: `DeviceNotRegistered` response marks token inactive

---

## Deliverables Checklist

| Item | Status | Notes |
|---|---|---|
| `backend/src/services/pushNotification.js` | ✅ | Named `pushService.js` (existing convention) |
| `backend/src/routes/devices.js` | ✅ | Covered by `routes/notifications.js` (register/unregister/follow/unfollow) |
| Migration for device tokens | ✅ | `001_initial_schema.js` (table) + `014_device_token_active.js` (is_active + DND) |
| Trigger: donation confirmation | ✅ | Already in `routes/donations.js` via `enqueuePushNotification` |
| Trigger: project updates | ✅ | Already in `routes/updates.js` via `enqueuePushNotification` |
| Trigger: milestones (25/50/75/100%) | ✅ | Already in `services/webhook.js` via `checkAndDeliverMilestones` |
| Trigger: governance proposals | ✅ | New: `sendGovernanceProposalNotifications` ready for governance API |
| Trigger: recurring reminders | ✅ | New: `sendRecurringReminder` ready for recurring scheduler |
| Notification preferences API | ✅ | `GET/PUT /api/notifications/preferences` |
| Mobile notification settings screen | ✅ | `mobile/app/settings/notifications.tsx` |
| DND hours support | ✅ | Backend enforcement + mobile UI |
| Stale token auto-marked inactive | ✅ | On `DeviceNotRegistered` + manual `/unregister` |
| Deep link from notification | ✅ | Project detail + governance proposal handling |
| Badge count updates | ✅ | Already in `mobile/utils/notifications.ts` |
| Unit + integration tests | ✅ | 516 passing |
| Firebase configuration docs | ⚠️ | Expo Push API wraps both FCM and APNs — no Firebase-specific config needed. Documentation in repo README/docs. |

---

## Files Changed

| File | ± |
|---|---|
| `backend/src/services/pushService.js` | +186 |
| `backend/src/services/pushService.test.js` | +154 |
| `backend/src/services/pushQueue.js` | +29 |
| `backend/src/services/pushQueue.test.js` | +56 |
| `backend/src/routes/notifications.js` | +140 |
| `backend/src/routes/notifications.test.js` | +165 |
| `backend/src/db/migrations/014_device_token_active.js` | +39 (new) |
| `mobile/app/settings/notifications.tsx` | +332 (new) |
| `mobile/app/settings.tsx` | +33 |
| `mobile/app/_layout.tsx` | +4 |
| `mobile/utils/notifications.ts` | +6 / −13 |

**Total: +1,144 / −13 across 11 files**
