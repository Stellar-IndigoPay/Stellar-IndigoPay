# API Reference — Stellar-IndigoPay

Base URL: `http://localhost:4000`

All responses: `{ "success": true, "data": {...} }` or `{ "error": "..." }`

---

## Versioning

All API routes are served under a version prefix: **`/api/v1`**. The version
prefix lets us ship breaking changes in a future `/api/v2` without disrupting
existing clients.

**Policy**

- Resource routes live under `/api/v1/<resource>` (e.g. `/api/v1/projects`).
- `/health` is unversioned (infrastructure/liveness check).
- New non-breaking fields may be added to a version without a bump. Breaking
  changes (removing/renaming fields, changing semantics) introduce a new
  version (`/api/v2`) and the previous version is supported until deprecated.
- **Legacy redirect:** unversioned `/api/v1/*` requests are answered with a
  `308 Permanent Redirect` to their `/api/v1/*` equivalent and carry a
  `Deprecation: true` header plus a
  `Link: </api/v1>; rel="successor-version"` header. The `308` status
  preserves the HTTP method and body, so existing `POST`/`PATCH` clients keep
  working. New clients should call `/api/v1` directly.

---

## Health

`GET /health` — Server status check.

---

## Projects

| Method | Endpoint            | Description                          |
| ------ | ------------------- | ------------------------------------ |
| GET    | `/api/projects`     | List projects with cursor pagination |
| GET    | `/api/projects/:id` | Get single project                   |

### GET /api/projects — query parameters

| Parameter  | Type    | Default | Description                                               |
| ---------- | ------- | ------- | --------------------------------------------------------- |
| `limit`    | integer | `20`    | Page size (max 100)                                       |
| `cursor`   | string  | —       | Opaque cursor from `next_cursor` in a previous response   |
| `category` | string  | —       | Filter by category (e.g. `Reforestation`)                 |
| `status`   | string  | —       | Filter by status (`active`, `completed`, `paused`)        |
| `verified` | `true`  | —       | Return only verified projects                             |
| `search`   | string  | —       | Full-text search across name, description, location, tags |

### Pagination

The list endpoint uses **keyset (cursor) pagination** on `(created_at DESC, id DESC)`.
The first request is made without a `cursor`. Subsequent pages pass the `next_cursor`
value from the previous response.

**First page**

```
GET /api/projects?limit=20&status=active
```

```json
{
  "success": true,
  "data": [ ...20 projects... ],
  "next_cursor": "eyJjcmVhdGVkX2F0Ij...",
  "has_more": true
}
```

**Next page**

```
GET /api/projects?limit=20&status=active&cursor=eyJjcmVhdGVkX2F0Ij...
```

When `has_more` is `false` (or `next_cursor` is `null`), you have reached the last page.
Cursors are stable: inserting new projects does not shift pages already in flight.

### Project object

```json
{
  "id": "uuid",
  "name": "Amazon Reforestation Initiative",
  "description": "...",
  "category": "Reforestation",
  "location": "Brazil, South America",
  "walletAddress": "GABC...XYZ",
  "goalXLM": "50000.0000000",
  "raisedXLM": "18420.0000000",
  "donorCount": 147,
  "co2OffsetKg": 245000,
  "status": "active",
  "verified": true,
  "tags": ["reforestation", "amazon"],
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

---

## Donations

| Method | Endpoint                             | Description                           |
| ------ | ------------------------------------ | ------------------------------------- |
| POST   | `/api/v1/donations`                  | Record a donation after on-chain tx   |
| GET    | `/api/v1/donations/project/:id`      | Donations for a project (`?limit=20`) |
| GET    | `/api/v1/donations/donor/:publicKey` | A donor's full history                |

### POST /api/v1/donations

```json
{
  "projectId": "uuid",
  "donorAddress": "GABC...XYZ",
  "amountXLM": "25.0000000",
  "message": "For the Amazon 🌳",
  "transactionHash": "abc123...64hexchars"
}
```

Donations are **deduplicated by transactionHash** — safe to retry.

---

## Profiles

| Method | Endpoint                      | Description                |
| ------ | ----------------------------- | -------------------------- |
| GET    | `/api/v1/profiles/:publicKey` | Get donor profile + badges |
| POST   | `/api/v1/profiles`            | Create or update profile   |

---

## Leaderboard

| Method | Endpoint              | Description                           |
| ------ | --------------------- | ------------------------------------- |
| GET    | `/api/v1/leaderboard` | Top donors by total XLM (`?limit=20`) |

### Leaderboard entry

```json
{
  "rank": 1,
  "publicKey": "GABC...XYZ",
  "displayName": "Alice",
  "totalDonatedXLM": "2500.0000000",
  "projectsSupported": 4,
  "topBadge": "earth"
}
```

---

## Project Updates

| Method | Endpoint                     | Description                 |
| ------ | ---------------------------- | --------------------------- |
| GET    | `/api/v1/updates/:projectId` | Updates posted by a project |

---

## Project Analytics 🔒

| Method | Endpoint                              | Description                                |
| ------ | ------------------------------------- | ------------------------------------------ |
| GET    | `/api/v1/projects/:id/analytics`      | Get project analytics (owner only)         |

### GET /api/v1/projects/:id/analytics

Returns aggregated donor demographics, donation trends, milestone progress,
campaign performance, and rating summary. Access restricted to the project's
wallet owner via the `wallet` query parameter.

**Query parameters**

| Parameter | Type   | Required | Description                         |
| --------- | ------ | -------- | ----------------------------------- |
| `wallet`  | string | Yes      | Stellar public key of project owner |

**Rate limit:** 5 requests per minute per IP.

**Error responses**

| Status | Meaning                                |
| ------ | -------------------------------------- |
| 403    | `wallet` does not match project owner  |
| 404    | Project not found                      |
| 429    | Rate limit exceeded                    |

---

## Recurring Donations

### `POST /api/v1/recurring-donations`

Create an on-chain recurring donation subscription.

**Request Body:**
```json
{
  "donorAddress": "G...",
  "projectId": "proj_001",
  "amount": 100,
  "intervalLedgers": 432000,
  "maxPayments": 12,
  "signedXDR": "AAAA..." // optional, if pre-signed by donor
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "subscriptionId": 1,
    "donorAddress": "G...",
    "projectId": "proj_001",
    "amountStroops": 1000000000
  }
}
```

### `GET /api/v1/recurring-donations/:donorAddress`

List all recurring donations for a donor.

### `DELETE /api/v1/recurring-donations/:id`

Cancel a recurring donation (off-chain). Requires `donorAddress` in body.

---

## Badge Tiers

| Tier       | Threshold   | Emoji |
| ---------- | ----------- | ----- |
| `seedling` | ≥ 10 XLM    | 🌱    |
| `tree`     | ≥ 100 XLM   | 🌳    |
| `forest`   | ≥ 500 XLM   | 🌲    |
| `earth`    | ≥ 2,000 XLM | 🌍    |
