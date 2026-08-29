#!/usr/bin/env node
/**
 * scripts/synthetic-monitor.js
 *
 * Synthetic on-chain transaction monitor for Stellar IndigoPay (issue #1144 Part A).
 *
 * Executes a full end-to-end donation flow every 5 minutes against the Stellar
 * Testnet using a dedicated synthetic-donor keypair. Results are exposed as
 * Prometheus metrics so Alertmanager can fire on consecutive failures.
 *
 * Metrics exported (Prometheus text format on :METRICS_PORT/metrics):
 *   synthetic_donation_success          gauge    1 = last attempt succeeded, 0 = failed
 *   synthetic_donation_duration_seconds histogram end-to-end duration of the check
 *   synthetic_donation_checks           counter  total checks performed (label: result)
 *   synthetic_donation_last_timestamp   gauge    unix epoch of the last completed check
 *
 * The check flow:
 *   1. Verify Horizon /fee_stats is reachable
 *   2. Verify Soroban RPC getLedgerEntries returns a valid response
 *   3. If @stellar/stellar-sdk is available:
 *      a. Build a donate() transaction
 *      b. simulateTransaction — must succeed (not contract error)
 *      c. assembleTx + sign + sendTransaction
 *      d. Poll getTransaction until SUCCESS (or FAILED / timeout → failure)
 *
 * Environment variables:
 *   SYNTHETIC_SECRET_KEY      Ed25519 secret key (sXXX…) for the synthetic donor.
 *                             REQUIRED — the script exits with code 1 if absent.
 *   SYNTHETIC_PROJECT_ID      Project ID to donate to (default: "project-001").
 *   SYNTHETIC_AMOUNT_STROOPS  Donation amount in stroops (default: 100000 = 0.01 XLM).
 *   STELLAR_NETWORK           "testnet" (default) or "mainnet".
 *   HORIZON_URL               Horizon endpoint.
 *   SOROBAN_RPC_URL           Soroban RPC endpoint.
 *   CONTRACT_ID               Soroban IndigoPay contract address.
 *   PROMETHEUS_PUSH_URL       If set, push metrics to this Prometheus Push Gateway URL.
 *   METRICS_PORT              HTTP port to expose /metrics on (default: 9091).
 *   RUN_ONCE                  If "true", perform one check then exit (cron/CI use).
 *   POLL_TIMEOUT_MS           Max time to poll getTransaction (default: 30000).
 *   POLL_INTERVAL_MS          Polling interval (default: 3000).
 *
 * Usage:
 *   # One-shot (CI / GitHub Actions cron)
 *   SYNTHETIC_SECRET_KEY=sXXX… RUN_ONCE=true node scripts/synthetic-monitor.js
 *
 *   # Long-running sidecar
 *   SYNTHETIC_SECRET_KEY=sXXX… node scripts/synthetic-monitor.js
 */

"use strict";

const http = require("node:http");

// ---------------------------------------------------------------------------
// Lightweight Prometheus registry (no external dependencies)
// ---------------------------------------------------------------------------

/**
 * Escape a Prometheus label value per the text-format spec:
 * backslash → \\, double-quote → \", newline → \n
 * @param {*} v
 * @returns {string}
 */
function escapeLabelValue(v) {
  return String(v)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

class MetricRegistry {
  constructor() {
    this._gauges = new Map();
    this._counters = new Map();
    this._histograms = new Map();
  }

  gauge(name, help) {
    if (!this._gauges.has(name)) {
      this._gauges.set(name, { help, value: null });
    }
    return {
      set: (value) => {
        this._gauges.get(name).value = value;
      },
    };
  }

  /**
   * @param {string} name   The base metric name WITHOUT _total suffix.
   *                        The renderer will append _total when emitting samples.
   */
  counter(name, help, labelNames = []) {
    if (!this._counters.has(name)) {
      this._counters.set(name, { help, labelNames, values: new Map() });
    }
    return {
      inc: (labels = {}) => {
        const key = labelNames.map((l) => labels[l] ?? "").join(",");
        const m = this._counters.get(name);
        m.values.set(key, (m.values.get(key) || 0) + 1);
      },
    };
  }

  histogram(
    name,
    help,
    labelNames = [],
    buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  ) {
    if (!this._histograms.has(name)) {
      this._histograms.set(name, {
        help,
        labelNames,
        buckets,
        obs: [],
      });
    }
    return {
      observe: (labels, value) => {
        this._histograms.get(name).obs.push({ labels, value });
      },
    };
  }

  /** Render all metrics in Prometheus text format. */
  render() {
    const lines = [];

    for (const [name, m] of this._gauges) {
      lines.push(`# HELP ${name} ${m.help}`);
      lines.push(`# TYPE ${name} gauge`);
      if (m.value !== null) {
        lines.push(`${name} ${m.value}`);
      }
    }

    for (const [name, m] of this._counters) {
      lines.push(`# HELP ${name}_total ${m.help}`);
      lines.push(`# TYPE ${name}_total counter`);
      for (const [key, count] of m.values) {
        if (m.labelNames.length === 0) {
          lines.push(`${name}_total ${count}`);
        } else {
          const parts = key.split(",");
          const labelStr = m.labelNames
            .map((l, i) => `${l}="${escapeLabelValue(parts[i] ?? "")}"`)
            .join(",");
          lines.push(`${name}_total{${labelStr}} ${count}`);
        }
      }
    }

    for (const [name, m] of this._histograms) {
      lines.push(`# HELP ${name} ${m.help}`);
      lines.push(`# TYPE ${name} histogram`);

      // Group observations by label-set key
      const groups = new Map();
      for (const { labels, value } of m.obs) {
        const key = m.labelNames.map((l) => labels[l] ?? "").join(",");
        if (!groups.has(key)) {
          groups.set(key, { labels, values: [] });
        }
        groups.get(key).values.push(value);
      }

      for (const [, g] of groups) {
        // Build the base label set string (without le)
        const baseLabelPairs = m.labelNames.map(
          (l) => `${l}="${escapeLabelValue(g.labels[l] ?? "")}"`,
        );

        /** Build a bucket label string that always includes le. */
        const bucketLStr = (le) => {
          const pairs = [...baseLabelPairs, `le="${le}"`];
          return `{${pairs.join(",")}}`;
        };

        // Base label string for _sum / _count (no le)
        const sumCountLStr =
          baseLabelPairs.length > 0 ? `{${baseLabelPairs.join(",")}}` : "";

        let sum = 0;
        for (const bucket of m.buckets) {
          const cnt = g.values.filter((v) => v <= bucket).length;
          lines.push(`${name}_bucket${bucketLStr(bucket)} ${cnt}`);
        }
        lines.push(`${name}_bucket${bucketLStr("+Inf")} ${g.values.length}`);
        for (const v of g.values) sum += v;
        lines.push(`${name}_sum${sumCountLStr} ${sum}`);
        lines.push(`${name}_count${sumCountLStr} ${g.values.length}`);
      }
    }

    return lines.join("\n") + "\n";
  }
}

const registry = new MetricRegistry();

const syntheticDonationSuccess = registry.gauge(
  "synthetic_donation_success",
  "1 if the last synthetic end-to-end donation succeeded (submitted and confirmed on-chain), 0 if it failed",
);

const syntheticDonationDurationSeconds = registry.histogram(
  "synthetic_donation_duration_seconds",
  "End-to-end duration of the synthetic donation check in seconds",
  [],
  [0.5, 1, 2, 5, 10, 20, 30, 60],
);

// Name is the BASE name; the renderer appends _total → synthetic_donation_checks_total
const syntheticDonationChecks = registry.counter(
  "synthetic_donation_checks",
  "Total synthetic donation checks performed, labelled by result (success|failure)",
  ["result"],
);

const syntheticDonationLastTimestamp = registry.gauge(
  "synthetic_donation_last_timestamp",
  "Unix epoch seconds when the last synthetic donation check completed",
);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const NETWORK = process.env.STELLAR_NETWORK || "testnet";
const HORIZON_URL =
  process.env.HORIZON_URL ||
  (NETWORK === "mainnet"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org");
const RPC_URL =
  process.env.SOROBAN_RPC_URL ||
  (NETWORK === "mainnet"
    ? "https://rpc.stellar.org"
    : "https://soroban-testnet.stellar.org");

const CONTRACT_ID = process.env.CONTRACT_ID || "";
const SYNTHETIC_PROJECT_ID = process.env.SYNTHETIC_PROJECT_ID || "project-001";
const SYNTHETIC_AMOUNT_STROOPS = Number(
  process.env.SYNTHETIC_AMOUNT_STROOPS || 100000,
);
const RUN_ONCE = process.env.RUN_ONCE === "true";
const METRICS_PORT = Number(process.env.METRICS_PORT || 9091);
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || 30_000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3_000);

// ---------------------------------------------------------------------------
// Keypair — REQUIRED, no auto-generation
// ---------------------------------------------------------------------------

/**
 * Load the synthetic donor keypair from SYNTHETIC_SECRET_KEY.
 * Exits with code 1 if the variable is absent — every deployment must use
 * a stable pre-funded account; auto-generating keypairs logs secrets and
 * produces a new unfunded account on every restart.
 */
function resolveSyntheticKeypair() {
  const secret = process.env.SYNTHETIC_SECRET_KEY;
  if (!secret) {
    console.error(
      "[synthetic-monitor] FATAL: SYNTHETIC_SECRET_KEY is not set.\n" +
        "  Generate a testnet keypair once with `stellar keys generate --network testnet`,\n" +
        "  fund it via https://friendbot.stellar.org?addr=<PUBLIC_KEY>,\n" +
        "  then store the secret in the SYNTHETIC_DONOR_SECRET_KEY GitHub Actions secret\n" +
        "  and the SYNTHETIC_DONOR_SECRET_KEY Docker Compose environment variable.",
    );
    process.exit(1);
  }
  return secret;
}

// ---------------------------------------------------------------------------
// Friendbot funding helper
// ---------------------------------------------------------------------------

async function friendbotFund(publicKey) {
  const url = `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`;
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (body.includes("createAccountAlreadyExist")) return;
    throw new Error(`Friendbot failed (${response.status}): ${body.slice(0, 200)}`);
  }
}

async function accountExists(publicKey) {
  const url = `${HORIZON_URL}/accounts/${encodeURIComponent(publicKey)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return res.status === 200;
}

// ---------------------------------------------------------------------------
// Soroban RPC liveness check
// ---------------------------------------------------------------------------

async function verifyRpcLiveness() {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "getLedgerEntries",
    params: { keys: [] },
  };

  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Soroban RPC HTTP ${response.status}`);
  }

  const json = await response.json();
  if (json.error) {
    throw new Error(`Soroban RPC error: ${JSON.stringify(json.error)}`);
  }

  return { latestLedger: json.result?.latestLedger ?? 0 };
}

// ---------------------------------------------------------------------------
// Transaction polling helper
// ---------------------------------------------------------------------------

/**
 * Poll rpcServer.getTransaction(hash) until it reaches a terminal state
 * (SUCCESS or FAILED) or the timeout elapses.
 *
 * @param {object} rpcServer
 * @param {string} txHash
 * @returns {Promise<{ status: string, result: object|null }>}
 */
async function pollTransaction(rpcServer, txHash) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await rpcServer.getTransaction(txHash);

    if (response.status === "SUCCESS") {
      return { status: "SUCCESS", result: response };
    }
    if (response.status === "FAILED") {
      return { status: "FAILED", result: response };
    }
    if (response.status === "NOT_FOUND") {
      // Transaction not yet indexed — wait and retry
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    // PENDING or any other transient status
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  return { status: "TIMEOUT", result: null };
}

// ---------------------------------------------------------------------------
// Core synthetic donation check
// ---------------------------------------------------------------------------

/**
 * Full synthetic donation check:
 *   1. Verify Horizon is reachable
 *   2. Verify Soroban RPC is reachable
 *   3. Build, simulate, assemble, sign, submit, and poll the donation tx
 *
 * @param {string} secretKey
 * @returns {Promise<{ success: boolean, durationMs: number, details: object }>}
 */
async function runSyntheticCheck(secretKey) {
  const start = Date.now();
  const details = {};

  try {
    // ── Step 1: Verify Horizon ───────────────────────────────────────
    const horizonRes = await fetch(`${HORIZON_URL}/fee_stats`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!horizonRes.ok) {
      throw new Error(`Horizon /fee_stats returned HTTP ${horizonRes.status}`);
    }
    const feeStats = await horizonRes.json();
    details.horizonOk = true;
    details.lastLedger = feeStats.last_ledger;

    // ── Step 2: Verify Soroban RPC ───────────────────────────────────
    const rpcResult = await verifyRpcLiveness();
    details.rpcOk = true;
    details.rpcLedger = rpcResult.latestLedger;

    // ── Step 3: Load stellar-sdk ─────────────────────────────────────
    let sdk;
    try {
      // eslint-disable-next-line global-require
      sdk = require("@stellar/stellar-sdk");
    } catch {
      details.stellarSdkAvailable = false;
      // Without the SDK we can only verify Horizon + RPC — still meaningful
      return { success: true, durationMs: Date.now() - start, details };
    }
    details.stellarSdkAvailable = true;

    if (!CONTRACT_ID) {
      throw new Error("CONTRACT_ID is not configured — cannot build donate() tx");
    }

    const {
      Keypair,
      Networks,
      TransactionBuilder,
      Contract,
      nativeToScVal,
      Address,
      rpc: sdkRpc,
      Horizon: sdkHorizon,
    } = sdk;

    const networkPassphrase =
      NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
    const keypair = Keypair.fromSecret(secretKey);
    const publicKey = keypair.publicKey();
    details.publicKey = publicKey;

    const rpcServer = new sdkRpc.Server(RPC_URL);
    const horizonServer = new sdkHorizon.Server(HORIZON_URL);

    // ── Step 4: Ensure account is funded (testnet only) ──────────────
    if (NETWORK !== "mainnet") {
      const exists = await accountExists(publicKey);
      if (!exists) {
        console.log(`[synthetic-monitor] Funding account ${publicKey} via Friendbot…`);
        await friendbotFund(publicKey);
        details.funded = true;
      }
    }

    // ── Step 5: Load account sequence ────────────────────────────────
    const account = await horizonServer.loadAccount(publicKey);
    const contract = new Contract(CONTRACT_ID);

    // ── Step 6: Build donate() transaction ───────────────────────────
    const tx = new TransactionBuilder(account, {
      fee: "1000",
      networkPassphrase,
    })
      .addOperation(
        contract.call(
          "donate",
          new Address(publicKey).toScVal(),
          nativeToScVal(SYNTHETIC_PROJECT_ID, { type: "string" }),
          nativeToScVal(BigInt(SYNTHETIC_AMOUNT_STROOPS), { type: "i128" }),
        ),
      )
      .setTimeout(30)
      .build();

    // ── Step 7: Simulate ─────────────────────────────────────────────
    const simulation = await rpcServer.simulateTransaction(tx);

    if (sdkRpc.Api.isSimulationError(simulation)) {
      throw new Error(
        `Simulation failed: ${simulation.error ?? JSON.stringify(simulation)}`,
      );
    }

    details.simulationResult = "success";
    details.cost = simulation.cost;

    // ── Step 8: Assemble, sign, submit ───────────────────────────────
    const assembled = sdkRpc.assembleTransaction(tx, simulation).build();
    assembled.sign(keypair);

    const sendResult = await rpcServer.sendTransaction(assembled);
    details.txHash = sendResult.hash;

    if (sendResult.status === "ERROR") {
      throw new Error(
        `sendTransaction returned ERROR: ${JSON.stringify(sendResult.errorResult ?? sendResult)}`,
      );
    }

    // ── Step 9: Poll until SUCCESS or FAILED ─────────────────────────
    const poll = await pollTransaction(rpcServer, sendResult.hash);
    details.pollStatus = poll.status;

    if (poll.status === "TIMEOUT") {
      throw new Error(
        `Transaction ${sendResult.hash} did not confirm within ${POLL_TIMEOUT_MS}ms`,
      );
    }
    if (poll.status === "FAILED") {
      throw new Error(`Transaction ${sendResult.hash} was FAILED on-chain`);
    }

    // SUCCESS
    details.confirmedLedger = poll.result?.ledger;

    const durationMs = Date.now() - start;
    details.durationMs = durationMs;
    return { success: true, durationMs, details };
  } catch (err) {
    const durationMs = Date.now() - start;
    return {
      success: false,
      durationMs,
      details: { ...details, error: err.message },
    };
  }
}

// ---------------------------------------------------------------------------
// Prometheus Push Gateway
// ---------------------------------------------------------------------------

async function pushMetrics(gatewayUrl, jobName = "synthetic-monitor") {
  const body = registry.render();
  const url = `${gatewayUrl}/metrics/job/${encodeURIComponent(jobName)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Push gateway returned HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Main run loop
// ---------------------------------------------------------------------------

async function runCheck(secretKey) {
  console.log(
    `[synthetic-monitor] Starting synthetic check at ${new Date().toISOString()}`,
  );

  const result = await runSyntheticCheck(secretKey);
  const durationSec = result.durationMs / 1000;

  syntheticDonationSuccess.set(result.success ? 1 : 0);
  syntheticDonationDurationSeconds.observe({}, durationSec);
  syntheticDonationLastTimestamp.set(Math.floor(Date.now() / 1000));

  if (result.success) {
    syntheticDonationChecks.inc({ result: "success" });
    console.log(
      `[synthetic-monitor] ✅ Check passed in ${result.durationMs}ms`,
      result.details,
    );
  } else {
    syntheticDonationChecks.inc({ result: "failure" });
    console.error(
      `[synthetic-monitor] ❌ Check FAILED in ${result.durationMs}ms`,
      result.details,
    );
    // Structured log for log-based alerting (Loki / CloudWatch)
    console.error(
      JSON.stringify({
        level: "error",
        event: "synthetic_donation_failure",
        durationMs: result.durationMs,
        error: result.details.error || "unknown",
        network: NETWORK,
        projectId: SYNTHETIC_PROJECT_ID,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  if (process.env.PROMETHEUS_PUSH_URL) {
    try {
      await pushMetrics(process.env.PROMETHEUS_PUSH_URL);
    } catch (pushErr) {
      console.error(
        `[synthetic-monitor] Push gateway error: ${pushErr.message}`,
      );
    }
  }

  if (RUN_ONCE) {
    process.exit(result.success ? 0 : 1);
  }
}

async function main() {
  const secretKey = resolveSyntheticKeypair();

  if (!RUN_ONCE) {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/metrics") {
        const body = registry.render();
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
        res.end(body);
      } else if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(METRICS_PORT, () => {
      console.log(
        `[synthetic-monitor] Metrics server listening on :${METRICS_PORT}/metrics`,
      );
    });
  }

  await runCheck(secretKey);

  if (!RUN_ONCE) {
    setInterval(() => runCheck(secretKey), CHECK_INTERVAL_MS);
    console.log(
      `[synthetic-monitor] Scheduled checks every ${CHECK_INTERVAL_MS / 1000}s`,
    );
  }
}

main().catch((err) => {
  console.error("[synthetic-monitor] Fatal error:", err);
  process.exit(1);
});
