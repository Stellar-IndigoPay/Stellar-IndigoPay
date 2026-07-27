/**
 * scripts/load-test-ci.js
 *
 * CI performance smoke test for the donation recording pipeline.
 *
 * Purpose  : Catch latency regressions early — not precision benchmarking.
 * VUs      : 10  (vs 100 in load-test.js — keeps CI runtime under 2 min)
 * Duration : 30s
 * Threshold: p95 < 2 000 ms  (generous to avoid false positives; the full
 *            load-test.js enforces the production target of p95 < 500 ms)
 *
 * Usage (manual):
 *   k6 run scripts/load-test-ci.js
 *
 * Usage (override target):
 *   BASE_URL=http://staging:4000 k6 run scripts/load-test-ci.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";

// ── Custom metrics ─────────────────────────────────────────────────────────

const donationLatency = new Trend("donation_latency", true);
const donationErrors = new Counter("donation_errors");
const donationSuccessRate = new Rate("donation_success_rate");

// ── Options ────────────────────────────────────────────────────────────────

export const options = {
  // 10 virtual users for 30 seconds — lightweight enough for CI while still
  // producing a statistically meaningful p95 sample (~300–600 requests).
  scenarios: {
    ci_smoke: {
      executor: "constant-vus",
      vus: 10,
      duration: "30s",
    },
  },
  thresholds: {
    // Regression gate: if p95 crosses 2 s the pipeline has degraded.
    // The job uses continue-on-error: true so this never blocks a merge —
    // it surfaces as a visible warning in CI instead.
    donation_latency: ["p(95)<2000"],
    // Keep error rate low; a surge here signals a hard regression.
    donation_success_rate: ["rate>0.95"],
    http_req_failed: ["rate<0.05"],
  },
};

// ── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || "http://localhost:4000";

// Valid-format Stellar testnet public keys used to populate donation payloads.
const SAMPLE_ADDRESSES = [
  "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3A73ZFMZE",
  "GBVNNPOFVILBYQZLTDAL2QXAHVDYCSQXFMOUQ73XU3NKLHZB6KPRSEV",
  "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGBQH9L3BKQBFHV7HJZQZD",
  "GDNSSYSCSSRY3VWUQGGZXFPXDPWKJTMV6GCRXFCTQHK63CG4K5UEFSV",
  "GDQJUTQYK2MQX2CNYPCAETIQZRDZYOUC5RLAOBOVPPFBQ6TMHKCMB4PT",
];

/**
 * Generates a deterministic, unique-looking 64-char hex transaction hash
 * per (VU, iteration) pair so the backend deduplication logic treats each
 * request as a distinct donation.
 */
function fakeTxHash(vuId, iter) {
  const base = `${vuId.toString(16).padStart(8, "0")}${iter.toString(16).padStart(8, "0")}`;
  return (base + "0".repeat(64)).slice(0, 64);
}

// ── Default function (executed once per VU per iteration) ──────────────────

export default function () {
  const donor = SAMPLE_ADDRESSES[__VU % SAMPLE_ADDRESSES.length];
  const txHash = fakeTxHash(__VU, __ITER);
  const amountXLM = (Math.random() * 9 + 1).toFixed(7);

  const payload = JSON.stringify({
    projectId: `project-${((__VU + __ITER) % 10) + 1}`,
    amountXLM,
    donorAddress: donor,
    transactionHash: txHash,
    memo: "ci-smoke-test",
  });

  const params = {
    headers: { "Content-Type": "application/json" },
    tags: { endpoint: "POST /api/donations", scenario: "ci_smoke" },
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

  // Small think-time between requests; mirrors pacing in load-test.js.
  sleep(0.5 + Math.random() * 0.5);
}
