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

## Rate Limiting

The API uses a Redis-backed rate limiter with **two strategies**, configured
per-endpoint via policies in `rateLimitConfig.js`. Every response includes
standard rate-limit headers so clients can self-throttle.

When Redis is unavailable the rate limiter degrades gracefully to pass-through
(all requests are allowed), and a warning is emitted. This ensures the API
stays available during a cache-layer outage.

### Strategies

| Strategy        | Description                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------- |
| Sliding window  | The default. Counts requests in a rolling time window. Limits to `points` req / `duration`s. |
| Token bucket    | Burst-tolerant. Bucket holds up to `capacity` tokens. Tokens refill at `refillRate`/sec.     |

### Response headers

Every response carries the following headers:

| Header                  | Description                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `X-RateLimit-Limit`     | Maximum requests allowed in the window (or bucket capacity).   |
| `X-RateLimit-Remaining` | Requests remaining in the current window (or tokens left).     |
| `X-RateLimit-Reset`     | Epoch seconds when the limit resets (or next token available). |

When the limit is exceeded (HTTP 429) an additional header is sent:

| Header        | Description                                      |
| ------------- | ------------------------------------------------ |
| `Retry-After` | Seconds to wait before retrying.                 |

### 429 response body

```json
{
  "error": "Too many requests — Try again later.",
  "retryAfter": 1742169602
}
```

### Per-endpoint tiers

| Method | Path pattern                              | Strategy       | Limit                        |
| ------ | ----------------------------------------- | -------------- | ---------------------------- |
| POST   | `/api/donations`                          | Sliding window | 10 req / 60 s                |
| POST   | `/api/verification-requests`              | Sliding window | 10 req / 900 s (15 min)      |
| POST   | `/api/projects`                           | Sliding window | 5 req / 60 s                 |
| PATCH  | `/api/projects/*`                         | Sliding window | 20 req / 60 s                |
| POST   | `/api/profiles`                           | Sliding window | 10 req / 60 s                |
| PATCH  | `/api/profiles/*`                         | Sliding window | 10 req / 60 s                |
| POST   | `/api/ratings`                            | Sliding window | 10 req / 60 s                |
| POST   | `/api/uploads`                            | Sliding window | 10 req / 60 s                |
| *      | `/api/admin/*`                            | Sliding window | 30 req / 60 s                |
| POST   | `/api/admin/*`                            | Sliding window | 20 req / 60 s                |
| GET    | `/api/projects/*`                         | Sliding window | 100 req / 60 s               |
| GET    | `/api/leaderboard`                        | Sliding window | 60 req / 60 s                |
| GET    | `/api/stats`                              | Sliding window | 60 req / 60 s                |
| GET    | `/api/impact/*`                           | Sliding window | 60 req / 60 s                |
| GET    | `/api/map`                                | Sliding window | 60 req / 60 s                |
| GET    | `/api/analytics/*`                        | **Token bucket** | Capacity: 10, Refill: 0.5/s (~30 req / min sustained) |
| POST   | `/api/notifications`                      | Sliding window | 30 req / 60 s                |
| POST   | `/api/subscriptions`                      | Sliding window | 20 req / 60 s                |
| *      | *(catch-all default)*                     | Sliding window | 150 req / 900 s (15 min)     |

The **token bucket** strategy on the analytics endpoint allows short bursts
of up to 10 requests while the sustained rate is ~30 requests per minute.
This is ideal for dashboards that may spike on page load.

### Redis failure fallback

If Redis is unreachable the rate limiter enters **degraded mode**:
- All requests pass through to the route handler.
- `X-RateLimit-Limit` and `X-RateLimit-Remaining` headers are still set
  with the configured limit.
- A warning is logged for observability.

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

## Badge Tiers

| Tier       | Threshold   | Emoji |
| ---------- | ----------- | ----- |
| `seedling` | ≥ 10 XLM    | 🌱    |
| `tree`     | ≥ 100 XLM   | 🌳    |
| `forest`   | ≥ 500 XLM   | 🌲    |
| `earth`    | ≥ 2,000 XLM | 🌍    |
