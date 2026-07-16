import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";

// ── Custom metrics ─────────────────────────────────────────────────────────

const donationLatency = new Trend("donation_latency", true);
const donationErrors = new Counter("donation_errors");
const donationSuccessRate = new Rate("donation_success_rate");

const analyticsLatency = new Trend("analytics_latency", true);
const analyticsErrors = new Counter("analytics_errors");
const analyticsRateLimitHits = new Counter("analytics_rate_limit_hits");
const analytics429Rate = new Rate("analytics_429_rate");

// ── Scenarios ───────────────────────────────────────────────────────────────
//
// sustained  — 100 VUs for 60 s (baseline, mirrors issue #149 acceptance criteria)
// ramp-up    — 0 → 100 VUs over 30 s, hold 60 s, ramp down 30 s
// token-burst — 5 VUs × 2 iterations simulating dashboard spikes on /api/analytics/*
//               (token-bucket: capacity=10, refillRate=0.5)
//
// Run baseline:        k6 run scripts/load-test.js
// Run ramp-up:         SCENARIO=ramp-up k6 run scripts/load-test.js
// Run token-burst:     SCENARIO=token-burst k6 run scripts/load-test.js

const SCENARIO = __ENV.SCENARIO || "sustained";

export const options = {
  scenarios: {
    sustained: {
      executor: "constant-vus",
      vus: 100,
      duration: "60s",
      startTime: "0s",
      ...(SCENARIO !== "sustained" && { exec: "_noop" }),
    },
    "ramp-up": {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { target: 100, duration: "30s" },
        { target: 100, duration: "60s" },
        { target: 0, duration: "30s" },
      ],
      ...(SCENARIO !== "ramp-up" && { exec: "_noop" }),
    },
    "token-burst": {
      executor: "per-vu-iterations",
      exec: "token_burst",
      vus: 5,
      iterations: 2,
      maxDuration: "60s",
      startTime: "0s",
      ...(SCENARIO !== "token-burst" && { exec: "_noop" }),
    },
  },
  thresholds: {
    // Donation endpoint thresholds
    donation_latency: ["p(95)<500"],
    donation_success_rate: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
    // Analytics / token-bucket thresholds
    analytics_latency: ["p(95)<500"],
    analytics_429_rate: ["rate<0.85"], // expect some 429s under burst
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:4000";

// Valid Stellar testnet public keys (G... 56-char base32)
const SAMPLE_ADDRESSES = [
  "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3A73ZFMZE",
  "GBVNNPOFVILBYQZLTDAL2QXAHVDYCSQXFMOUQ73XU3NKLHZB6KPRSEV",
  "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGBQH9L3BKQBFHV7HJZQZD",
  "GDNSSYSCSSRY3VWUQGGZXFPXDPWKJTMV6GCRXFCTQHK63CG4K5UEFSV",
  "GDQJUTQYK2MQX2CNYPCAETIQZRDZYOUC5RLAOBOVPPFBQ6TMHKCMB4PT",
];

// Deterministically generate unique-ish 64-char hex tx hashes per VU + iteration
// so the deduplication check in recordDonation doesn't collapse all requests to one.
function fakeTxHash(vuId, iter) {
  const base = `${vuId.toString(16).padStart(8, "0")}${iter.toString(16).padStart(8, "0")}`;
  return (base + "0".repeat(64)).slice(0, 64);
}

export function _noop() {}

// ── Default: donations load test ───────────────────────────────────────────

export default function () {
  const donor = SAMPLE_ADDRESSES[__VU % SAMPLE_ADDRESSES.length];
  const txHash = fakeTxHash(__VU, __ITER);
  const amountXLM = (Math.random() * 9 + 1).toFixed(7);

  const payload = JSON.stringify({
    projectId: `project-${((__VU + __ITER) % 10) + 1}`,
    amountXLM,
    donorAddress: donor,
    transactionHash: txHash,
    memo: "load-test",
  });

  const params = {
    headers: { "Content-Type": "application/json" },
    tags: { endpoint: "POST /api/donations" },
  };

  const res = http.post(`${BASE_URL}/api/donations`, payload, params);

  donationLatency.add(res.timings.duration);

  const ok = check(res, {
    "status is 2xx": (r) => r.status >= 200 && r.status < 300,
    "response has donationId or success": (r) => {
      try {
        const body = JSON.parse(r.body);
        return !!(body.donationId ?? body.data?.id ?? body.success);
      } catch {
        return false;
      }
    },
  });

  donationSuccessRate.add(ok ? 1 : 0);
  if (!ok) donationErrors.add(1);

  sleep(0.5 + Math.random() * 0.5);
}

// ── Token-bucket burst scenario: /api/analytics/* ──────────────────────────
//
// The analytics endpoint uses a token-bucket rate limiter:
//   capacity    = 10    (max burst)
//   refillRate  = 0.5   (1 token every 2 seconds → ~30 req/min sustained)
//
// This scenario simulates dashboard clients that:
//   1. Fire a rapid burst of requests (page-load spike)
//   2. Then settle into a steady polling cadence
//   3. Some requests are expected to be 429'd (exceeded burst)
//
// Each VU uses its own IP (from k6's perspective) so buckets are independent.

export function token_burst() {
  // Use VU-specific project IDs so each virtual user targets a distinct
  // analytics path → independent token bucket per VU.
  const projectSlug = `project-vu-${__VU}`;
  const wallet = SAMPLE_ADDRESSES[__VU % SAMPLE_ADDRESSES.length];
  const url = `${BASE_URL}/api/analytics/${projectSlug}?wallet=${wallet}`;

  const params = {
    headers: { "Content-Type": "application/json" },
    tags: {
      endpoint: "GET /api/analytics/*",
      strategy: "token-bucket",
    },
  };

  // ── Phase 1: Burst (fire 10 rapid requests to exhaust the bucket) ───
  for (let i = 0; i < 10; i++) {
    const res = http.get(url, params);
    analyticsLatency.add(res.timings.duration);

    if (res.status === 429) {
      analyticsRateLimitHits.add(1);
      analytics429Rate.add(1);
    } else {
      analytics429Rate.add(0);
    }

    if (res.status >= 400 && res.status !== 429) {
      analyticsErrors.add(1);
    }

    check(res, {
      "burst: status is 200 or 429": (r) =>
        r.status === 200 || r.status === 429,
      "burst: rate-limit headers present": (r) =>
        r.headers["X-RateLimit-Limit"] !== undefined &&
        r.headers["X-RateLimit-Remaining"] !== undefined,
    });
  }

  // ── Phase 2: Steady polling (pace requests at ~1 req / 2.5s) ────────
  // With refillRate=0.5 tokens/sec, 1 token refills every 2 seconds.
  // At 1 req / 2.5s we stay comfortably under the refill rate.
  for (let i = 0; i < 5; i++) {
    // Wait between requests to allow tokens to refill
    sleep(2.5 + Math.random() * 0.5);

    const res = http.get(url, params);
    analyticsLatency.add(res.timings.duration);

    const is429 = res.status === 429;
    if (is429) {
      analyticsRateLimitHits.add(1);
      analytics429Rate.add(1);
    } else {
      analytics429Rate.add(0);
    }

    if (res.status >= 400 && res.status !== 429) {
      analyticsErrors.add(1);
    }

    check(res, {
      "steady: status is 200": (r) => r.status === 200,
      "steady: remaining within capacity bounds": (r) => {
        const remaining = parseInt(r.headers["X-RateLimit-Remaining"] || "0", 10);
        // Remaining should never exceed capacity (10) after the burst
        return remaining >= 0 && remaining <= 10;
      },
      "steady: responds within 1s": (r) => r.timings.duration < 1000,
    });
  }

  // ── Phase 3: Deep burst (try to fire many rapid requests to hit 429) ─
  // This verifies the rate limiter holds up under extreme pressure.
  const rapidResults = http.batch([
    ["GET", url, null, params],
    ["GET", url, null, params],
    ["GET", url, null, params],
    ["GET", url, null, params],
    ["GET", url, null, params],
  ]);

  let rapid429Count = 0;
  for (const res of rapidResults) {
    analyticsLatency.add(res.timings.duration);
    if (res.status === 429) rapid429Count++;
  }

  analyticsRateLimitHits.add(rapid429Count);
  analytics429Rate.add(rapid429Count / rapidResults.length);

  check(rapidResults, {
    "deep-burst: at least 2 requests were rate-limited": (results) =>
      results.filter((r) => r.status === 429).length >= 2,
    "deep-burst: all responses have X-RateLimit-Reset header": (results) =>
      results.every((r) => r.headers["X-RateLimit-Reset"] !== undefined),
  });
}
