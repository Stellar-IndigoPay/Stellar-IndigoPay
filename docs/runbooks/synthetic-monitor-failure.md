---
title: Synthetic Monitor and Transaction Failure Incident Response
severity: page
owners:
  - "@platform-team"
symptoms:
  - "SyntheticDonationCheckFailing or SyntheticMonitorSilent alert active"
  - "End-to-end synthetic donation check failed >= 2 times in 15 minutes"
  - "Synthetic monitor heartbeat missing in > 15 minutes"
steps:
  - "Check Stellar infrastructure status on https://status.stellar.org and testnet health endpoints."
  - "Inspect synthetic monitor logs in GitHub Actions or via `kubectl logs -n stellar-indigopay -l app=synthetic-monitor`."
  - "Verify IndigoPay contract responsiveness with `stellar contract invoke`."
  - "Check synthetic donor account balance on testnet and refund via Friendbot if depleted."
  - "Execute manual synthetic check via `node scripts/synthetic-monitor.js`."
verification:
  - "Confirm synthetic donation check runs successfully and `synthetic_donation_checks_total{result='success'}` increments."
  - "Confirm `SyntheticDonationCheckFailing` and `SyntheticMonitorSilent` alerts resolve in Alertmanager."
rollback:
  - "If RPC or testnet is degraded, silence alerts temporarily or failover to alternative Soroban RPC provider."
---

# Synthetic Monitor Failure Runbook

**Alert:** `SyntheticDonationCheckFailing` / `SyntheticMonitorSilent`
**Severity:** page / warn
**Owner:** Platform team

---

## What is the synthetic monitor?

`scripts/synthetic-monitor.js` is an active health probe that executes a
complete end-to-end donation check every 5 minutes:

1. Calls `GET /fee_stats` on Horizon to verify the Horizon endpoint is reachable
2. Calls `getLedgerEntries` on the Soroban RPC to verify the RPC endpoint is live
3. If `@stellar/stellar-sdk` is available:
   - Builds a `donate()` transaction
   - Calls `simulateTransaction` — failure here is a hard failure
   - Assembles, signs, and submits the transaction via `sendTransaction`
   - Polls `getTransaction` until the transaction reaches `SUCCESS` or `FAILED`
   - `FAILED`, `TIMEOUT`, or any submission error → check fails

The probe reports `synthetic_donation_success = 1` only when the donation
transaction is **confirmed on-chain** (status = `SUCCESS`).

**Alert condition:** `SyntheticDonationCheckFailing` fires when 2 or more
completed failure check events appear in the counter within a 15-minute window
(`increase(synthetic_donation_checks_total{result="failure"}[15m]) >= 2`).
A single transient failure does **not** alert.

---

## SyntheticDonationCheckFailing

**Condition:** `increase(synthetic_donation_checks_total{job="synthetic-monitor",result="failure"}[15m]) >= 2`
(at least 2 completed failure check events in 15 minutes — covers 2 × 5-minute cron runs).

**This means:** Two or more synthetic checks have completed and failed within the last 15 minutes.
A single transient failure does not alert. Real donors may already be affected.

### Step 1 — Check Stellar infrastructure status

- [Stellar Status Page](https://status.stellar.org) — look for Horizon or Soroban RPC incidents
- [Horizon Testnet Health](https://horizon-testnet.stellar.org/fee_stats) — should return 200
- [Soroban RPC Testnet](https://soroban-testnet.stellar.org) — try a `curl` or Postman POST

### Step 2 — Check the synthetic monitor itself

**GitHub Actions (scheduled workflow):**

```bash
# View recent runs
gh run list --workflow=synthetic-monitor.yml --repo Stellar-IndigoPay/Stellar-IndigoPay

# View failing run logs
gh run view <RUN_ID> --log
```

**Kubernetes CronJob:**

```bash
kubectl get cronjobs -n stellar-indigopay
kubectl get jobs -n stellar-indigopay -l app=synthetic-monitor
kubectl logs -n stellar-indigopay -l app=synthetic-monitor --tail=50
```

### Step 3 — Verify the contract is responsive

```bash
stellar contract invoke \
  --id CCG3QSD7FWTZ5W7NG2N7UDYWYVXF3I2NY5JGT3QPTZ6KHOIKUHMMJ6BT \
  --source deployer --network testnet \
  -- get_global_stats
```

If this fails, the Soroban RPC or contract itself is degraded.

### Step 4 — Check the synthetic donor account

```bash
# Replace with SYNTHETIC_DONOR_PUBLIC_KEY
curl "https://horizon-testnet.stellar.org/accounts/<PUBLIC_KEY>"
```

If the account doesn't exist or has zero XLM, refund it:

```bash
curl "https://friendbot.stellar.org?addr=<PUBLIC_KEY>"
```

### Step 5 — Manual synthetic check

```bash
cd /path/to/Stellar-IndigoPay
RUN_ONCE=true \
  SYNTHETIC_SECRET_KEY=<secret> \
  CONTRACT_ID=CCG3QSD7FWTZ5W7NG2N7UDYWYVXF3I2NY5JGT3QPTZ6KHOIKUHMMJ6BT \
  node scripts/synthetic-monitor.js
```

Exit 0 = check passed. Exit 1 = check failed (inspect stdout/stderr).

---

## SyntheticMonitorSilent

**Condition:** `absent(synthetic_donation_last_timestamp)` OR last timestamp > 15 minutes ago.

**This means:** The monitor itself has stopped emitting metrics. This is a monitor-of-the-monitor failure.

### Steps

1. Check the GitHub Actions scheduled workflow — it should run every 5 minutes.
   If it's not running, check if the workflow was disabled or the repo is out of quota.

2. Check the Prometheus Push Gateway target (if configured):
   `curl $PROMETHEUS_PUSH_URL/metrics/job/synthetic-monitor`

3. Check the Kubernetes CronJob:
   ```bash
   kubectl get cronjobs -n stellar-indigopay synthetic-monitor
   kubectl describe cronjob synthetic-monitor -n stellar-indigopay
   ```

4. Check Prometheus scrape targets: open `http://prometheus:9090/targets?job=synthetic-monitor`
   and verify the target is UP.

5. If the Docker Compose monitoring stack is in use:
   ```bash
   docker compose -f monitoring/docker-compose.monitoring.yml logs synthetic-monitor
   ```

---

## SyntheticDonationCheckSlow

**Condition:** p99 duration > 30 s for 15 consecutive minutes.

**This means:** Checks are completing (not failing) but taking a very long time — indicative of
Horizon/RPC degradation under load, not a full outage.

### Steps

1. Check `synthetic_donation_duration_seconds` histogram in the Business Overview dashboard.
2. Compare against Horizon and Soroban RPC p99 latency trends.
3. Check for scheduled Stellar network maintenance at https://status.stellar.org.
4. If p99 approaches the 60s scrape interval, consider increasing the `POLL_TIMEOUT_MS`
   environment variable or investigating Horizon/RPC latency. Do not adjust
   `SYNTHETIC_AMOUNT_STROOPS` to fix duration issues — it controls the donation amount,
   not any request timeout.

---

## Escalation

If Stellar Testnet infrastructure is confirmed degraded and beyond our control:
1. Silence the alert for 2 hours via Alertmanager or `amtool silence add`.
2. Open a [Stellar Discord](https://discord.gg/stellardev) or [GitHub issue](https://github.com/stellar/stellar-core/issues) if the degradation persists > 1 hour.

For production (Mainnet) failures, escalate immediately to the platform team on-call via PagerDuty.
