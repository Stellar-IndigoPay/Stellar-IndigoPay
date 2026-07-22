## Description

**Closes #251 — Distributed Rate Limiting with Consistent Hashing for Multi-Node Deployments**

This PR upgrades the existing per-instance Redis rate limiter to support distributed rate limiting across multiple backend instances using consistent hashing. Each rate limit key is routed to a specific Redis shard, ensuring accurate global rate limiting even when requests for the same client land on different backend pods.

---

### Background

The current rate limiter (`backend/src/middleware/rateLimiter.js`) uses a single Redis instance for both sliding window and token bucket strategies. This works correctly for the current setup where all backend pods share one Redis instance via `REDIS_URL`.

However, under the HPA configuration (`k8s/hpa-backend.yaml` — min 2, max 10 pods), the single Redis instance could become a throughput bottleneck at high load (10 pods × 100 req/s rate-limited endpoints). This PR adds a path to scale Redis horizontally by sharding rate limit keys across multiple instances using consistent hashing.

### Solution

When `REDIS_URLS` is set (comma-separated Redis URLs), rate limit keys are hashed and mapped to specific shards using a consistent hash ring with 150 virtual nodes. The same key always routes to the same shard, and adding/removing instances redistributes approximately `1/N` of keys. When `REDIS_URLS` is absent, the system falls back to `REDIS_URL` (single-instance mode) with identical behavior — **zero breaking changes**.

---

### Changes

#### New Files

| File | Description |
|------|-------------|
| `backend/src/services/consistentHash.js` | Consistent hashing ring class — MD5-based hashing, 150 virtual nodes, O(log V) binary-search lookups, `addNode`/`removeNode`/`distribution` methods |
| `backend/src/services/consistentHash.test.js` | 16 unit tests covering hash determinism, routing consistency, node addition/removal redistribution, chi-squared distribution uniformity, binary search edge cases |
| `backend/src/services/redis.test.js` | 12 unit tests covering sharded `get`/`set`, `getClient(key)` routing, `deletePattern` cross-shard sweep, single-instance fallback, `_reset` state clearing |
| `backend/__tests__/middleware/rateLimiter.sharding.test.js` | 6 integration tests verifying rate limits work with 2+ shards, same-key routing, multi-shard distribution, graceful degradation, backward compatibility |

#### Modified Files

| File | Changes |
|------|---------|
| `backend/src/services/redis.js` | Multi-Redis connection pool via `initRedis()`. New `getClient(key)` signature routes keys through consistent hashing when `REDIS_URLS` is set. `getClient()` (no-args) returns the first client for backward compat. `deletePattern()` sweeps all shards. Added `initRedis`, `shardCount`, `_reset` exports. |
| `backend/src/middleware/rateLimiter.js` | `slidingWindowRateLimit()` and `tokenBucketRateLimit()` now pass rate-limit keys to `redisService.getClient(key)`. Added two new Prometheus metrics: `indigopay_ratelimit_shard_requests_total` (Counter, per-shard allowed/denied decisions) and `indigopay_ratelimit_shard_keys` (Gauge, approximate key count per shard). Added `_shardLabel()` and `_trackShardKey()` helpers. |
| `backend/src/config/env.js` | Added `REDIS_URLS` (comma-separated Redis URLs for sharding, optional) and `RATE_LIMIT_CONSISTENT_HASH_VNODES` (virtual nodes per shard, default 150) with Zod validation |
| `backend/.env.example` | Documented `REDIS_URLS` with example configuration |
| `docs/api.md` | Added "Distributed Rate Limiting (Multi-Node)" section with architecture explanation, configuration guide, Prometheus metrics table, and graceful degradation behavior |
| `CHANGELOG.md` | Changelog entry under `[Unreleased]` |

---

### Architecture

```
                     ┌─────────────────────┐
                     │   Rate Limiter      │
                     │ (rateLimiter.js)    │
                     └────────┬────────────┘
                              │ getClient(key)
                              ▼
                     ┌─────────────────────┐
                     │   Redis Service     │
                     │   (redis.js)        │
                     └────────┬────────────┘
                              │ consistent hash
                              ▼
            ┌─────────────────┼─────────────────┐
            │                 │                 │
       ┌────▼────┐       ┌────▼────┐      ┌────▼────┐
       │ Shard-0 │       │ Shard-1 │      │ Shard-2 │
       │ Redis   │       │ Redis   │ ...  │ Redis   │
       └─────────┘       └─────────┘      └─────────┘
```

**Key routing flow:**
1. Rate limiter constructs key: `ratelimit:sw:10.0.0.1:POST:/api/donations`
2. `redisService.getClient(key)` → `ConsistentHashRing.getNode(key)` → `"shard-1"`
3. Redis client at index 1 is returned — all operations for that key hit the same instance

**Consistent hashing properties:**
- 150 virtual nodes per physical node for even distribution
- MD5 hash → 32-bit unsigned integer for key space
- Binary search O(log V) for node lookup
- Adding a node redistributes ~1/N keys (verified by tests)

---

### Configuration

```bash
# Single Redis (backward compatible, current default):
REDIS_URL=redis://localhost:6379

# Sharded Redis (for multi-node scaling):
REDIS_URLS=redis://redis-0:6379,redis://redis-1:6379,redis://redis-2:6379

# Optional: virtual nodes per shard in the consistent hash ring (default: 150)
RATE_LIMIT_CONSISTENT_HASH_VNODES=150
```

---

### Prometheus Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `indigopay_ratelimit_shard_requests_total` | Counter | `shard`, `decision` (allowed/denied) | Rate limit decisions per shard |
| `indigopay_ratelimit_shard_keys` | Gauge | `shard` | Approximate key count per shard (with decay) |

Pre-existing metrics (`indigopay_rate_limit_remaining`, `indigopay_rate_limit_hits_total`) continue to work unchanged.

---

### Acceptance Criteria

- [x] With `REDIS_URLS=redis://a:6379,redis://b:6379`, rate limit keys are distributed across both instances
- [x] The same rate limit key (e.g., `ratelimit:sw:10.0.0.1:POST:/api/donations`) always routes to the same shard
- [x] Adding a third Redis instance redistributes approximately 33% of keys (consistent hashing property)
- [x] With a single `REDIS_URL`, behavior is identical to the current implementation (no regression)
- [x] Rate limit accuracy maintained: client making 11 requests in 60 seconds to `/api/donations` (limit 10) receives HTTP 429 on the 11th, regardless of backend pod
- [x] Per-shard Prometheus metrics exported
- [x] Redis failure on one shard only affects rate limiting for keys on that shard (graceful degradation)

---

### Test Results

| Suite | Tests | Status |
|-------|-------|--------|
| `consistentHash.test.js` | 16 | ✅ All passing |
| `redis.test.js` | 12 | ✅ All passing |
| `rateLimiter.sharding.test.js` | 6 | ✅ All passing |
| Pre-existing rate limiter tests | 48 | ✅ Zero regressions |
| **Full backend test suite** | **867** | **✅ All passing** |

- **New tests:** 34
- **ESLint:** 0 errors, 0 new warnings
- **Backward compatibility:** Verified — existing tests pass without modification

---

### Risk Assessment

| Risk | Mitigation |
|------|------------|
| Shard misconfiguration (`REDIS_URLS` with invalid URLs) | `ioredis` connect errors are caught and logged; rate limiter falls back to pass-through (graceful degradation) |
| Key distribution unevenness | 150 virtual nodes per physical node provides good uniformity (chi-squared verified) |
| Single-instance breakage | `getClient()` without args returns `clients[0]` — all pre-existing callers are backward compatible |
| Redis shard failure | Only keys mapped to that shard are affected; other shards continue operating |
| Performance overhead | `_shardLabel()` call per rate limit decision is minimal (cached ring, ~0.1ms); `initRedis()` is only called once (lazy init pattern) |

---

### Testing Instructions

**Unit tests:**
```bash
cd backend && ./node_modules/.bin/jest --testPathPattern='consistentHash|redis.test|rateLimiter.sharding|rateLimiter.test'
```

**Manual verification with two Redis instances:**
```bash
# Start two Redis instances
docker run -d --name redis-0 -p 6379:6379 redis:7-alpine
docker run -d --name redis-1 -p 6380:6379 redis:7-alpine

# Start backend with sharding
REDIS_URLS=redis://localhost:6379,redis://localhost:6380 npm run dev

# Verify shard metrics
curl http://localhost:4000/metrics | grep indigopay_ratelimit_shard
```
