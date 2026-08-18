# Add SLO-based burn-rate alerting and rules validator

## Description

This PR implements **Service Level Objective (SLO)** tracking with **multi-window burn-rate alerting** following the Google SRE Workbook methodology, plus an automated **alert rules validator** to prevent malformed configurations from reaching production.

Closes #913

## Problem Statement

The existing `monitoring/alert-rules.yml` contains threshold-based alerts (5xx rate, p99 latency, rate-limit exhaustion), but lacks:

1. **Formal SLO definitions**: No explicit availability/latency promises for critical user journeys
2. **Proportional alerting**: Short, high-intensity errors and long, low-level degradation are treated the same
3. **Validation**: No CI checks for malformed rules, leading to potential evaluation-time failures

## Solution Overview

### 1. SLO Configuration (`monitoring/slos.yml`)

Defines Service Level Objectives for critical user journeys:

| SLO | Objective | Window | Error Budget |
|-----|-----------|--------|--------------|
| Donation submission availability | 99.5% | 30d | 0.5% |
| Project browsing availability | 99.9% | 30d | 0.1% |
| Donation submission latency (p99) | < 3s | 30d | 1% violations |
| Webhook delivery freshness (p99) | < 60s | 30d | 1% violations |

### 2. Burn-Rate Alerts (Generated)

Each SLO has **two burn-rate alerts** (following Google SRE pattern):

- **Fast Burn (1h window, 14.4x rate)**: Pages immediately for severe incidents
  - At 14.4x consumption, entire 30-day budget exhausts in ~2 days
  - Severity: `page`
  
- **Slow Burn (6h window, 3x rate)**: Warns about sustained degradation
  - At 3x consumption, gradual erosion of reliability
  - Severity: `warn`

**Total**: 8 new alert rules (4 SLOs × 2 windows)

### 3. Alert Generation Script (`scripts/generate-slo-alerts.js`)

Generates Prometheus alert rules from `slos.yml` to ensure:
- Single source of truth (no hand-editing drift)
- Correct burn-rate threshold calculations
- Consistent annotation structure (runbook links, descriptions)

```bash
# Generate and inject into alert-rules.yml
node scripts/generate-slo-alerts.js

# Preview without modifying files
node scripts/generate-slo-alerts.js --dry-run
```

### 4. Alert Rules Validator (`scripts/validate-alert-rules.js`)

CI-ready validator checking:

| Check | Severity | Description |
|-------|----------|-------------|
| YAML syntax | Error | Valid YAML structure |
| Alert name uniqueness | Error | No duplicates across groups |
| Severity allowlist | Error | Only `page`, `warn`, `critical` |
| Required annotations | Error | All alerts must have `summary` |
| Expression syntax | Error | Balanced parentheses, valid metric names |
| Duration format | Error | Valid `for` field (e.g., `5m`, `1h`) |
| Runbook URLs | Error | HTTPS only, no embedded credentials |
| Recommended annotations | Warning | Missing `description` or `runbook` |
| Metric existence | Warning | References allowlisted not-yet-implemented metrics |

```bash
node scripts/validate-alert-rules.js [path/to/rules.yml]
```

### 5. CI Integration

New `alert-rules-validation` job in `.github/workflows/ci.yml`:

1. Validates alert rules syntax and conventions
2. Verifies SLO configuration is valid YAML
3. Tests SLO alert generation (dry-run)
4. Runs validator test suite (7 tests)
5. Runs SLO generation test suite (6 tests)

**Build fails on**: Validation errors (not warnings), test failures

## Files Changed

### New Files

- `monitoring/slos.yml` — Versioned SLO definitions (4 SLOs, 8 burn-rate windows)
- `scripts/generate-slo-alerts.js` — Alert rule generator (dry-run support)
- `scripts/validate-alert-rules.js` — CI-ready validator (8 validation checks)
- `monitoring/tests/validate-alert-rules.test.js` — Validator test suite (7 tests)
- `monitoring/tests/generate-slo-alerts.test.js` — Generator test suite (6 tests)
- `monitoring/README.md` — Complete documentation (SLOs, burn-rate alerting, usage)

### Modified Files

- `monitoring/alert-rules.yml` — Added `stellar-indigopay-slo-burn-rate` group (8 rules)
- `.github/workflows/ci.yml` — Added `alert-rules-validation` job

## Testing

### Validator Tests (7/7 passing)

```bash
$ node monitoring/tests/validate-alert-rules.test.js

🧪 Running alert rules validator tests...

✅ Test passed: Valid rules pass
✅ Test passed: Duplicate alert names detected
✅ Test passed: Invalid severity rejected
✅ Test passed: Missing annotations flagged
✅ Test passed: Malformed expression caught
✅ Test passed: Invalid for duration rejected
✅ Test passed: Empty expression caught

✨ All tests passed!
```

### SLO Generation Tests (6/6 passing)

```bash
$ node monitoring/tests/generate-slo-alerts.test.js

🧪 Running SLO alert generation tests...

✅ Test passed: Generation script runs successfully
✅ Test passed: Generated rules are valid YAML
✅ Test passed: Burn-rate calculations are correct
✅ Test passed: SLO group properly injected
✅ Test passed: Generation is deterministic
✅ Test passed: All SLOs have burn-rate alerts

✨ All tests passed!
```

### Validator Output

```bash
$ node scripts/validate-alert-rules.js

🔍 Validating Prometheus alert rules...

📄 Rules file: /path/to/monitoring/alert-rules.yml
📋 Loaded 8 rule group(s)

════════════════════════════════════════════════════════════
📊 Validation Summary
════════════════════════════════════════════════════════════

⚠️  Warnings: 29
   ⚠️  Alert 'BackendHigh5xxRate' is missing recommended annotation: 'runbook'
   ⚠️  Alert 'BackendHighP99Latency' is missing recommended annotation: 'runbook'
   [... existing alerts missing runbooks ...]
   ℹ️  Alert 'WebhookDeliveryFreshnessBurnRate1h' references allowlisted metric 'webhook_delivery_duration_seconds_bucket' (may not exist yet)

════════════════════════════════════════════════════════════

✅ Validation passed. The alert rules file is valid.
```

> **Note**: Warnings for existing alerts (missing runbooks) are pre-existing technical debt and do not fail CI. New SLO alerts have complete annotations.

## Example Generated Alert

```yaml
- alert: DonationSubmissionAvailabilityBurnRate1h
  expr: |-
    (
      1 - (
        (sum(rate(http_requests_total{job="stellar-indigopay-backend",route="/api/donations",method="POST",status_code!~"5.."}[1h])))
          /
        (sum(rate(http_requests_total{job="stellar-indigopay-backend",route="/api/donations",method="POST"}[1h])))
      )
    ) > 0.072000
  for: 2m
  labels:
    severity: page
    slo_id: donation-submission-availability
    slo_window: 1h
  annotations:
    summary: Donation submission SLO fast burn detected
    description: |-
      The donation submission API is consuming error budget at 14.4x the normal rate
      over the last hour. At this rate, the entire 30-day error budget will be
      exhausted in ~2 days. Investigate 5xx errors and contract failures immediately.
    runbook: https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/wiki/Runbook-Donation-Submission-SLO
    slo_name: Donation Submission Availability
    slo_objective: 99.5%
```

## Security Considerations

1. **No Secrets in Expressions**: Validator checks that alert expressions never embed credentials
2. **No Secrets in Annotations**: Runbook URLs validated to prevent credential leakage (`@`, `token=`, `key=` patterns)
3. **Allowlisted Metrics**: `webhook_delivery_duration_seconds_bucket` allowlisted (will be added with webhook worker)

## Compatibility

- **Backward Compatible**: All existing alert rules remain unchanged
- **Additive Only**: New `stellar-indigopay-slo-burn-rate` group appended to `alert-rules.yml`
- **No Breaking Changes**: Existing alert names, severities, and routing preserved

## Edge Cases Handled

1. **Metrics Not Yet Implemented**: Validator allowlists `webhook_delivery_duration_seconds_bucket` (warns but passes)
2. **Label Cardinality**: SLO expressions use low-cardinality labels (`job`, `route`, `method`)
3. **Alert Fatigue**: `page` severity reserved for fast burns and critical operational signals
4. **Evaluation Interval Coherence**: SLO group uses 30s interval matching Prometheus global setting

## Documentation

Complete documentation added in `monitoring/README.md`:

- SLO overview and configuration
- Burn-rate alerting methodology
- Validator usage and checks
- Testing instructions
- CI integration details
- Security considerations
- Contribution guidelines

## References

- [Google SRE Workbook: Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/)
- [Prometheus Alerting Best Practices](https://prometheus.io/docs/practices/alerting/)
- Issue #913: Add SLO-based burn-rate alerting
- Issue #116: Runbook linkage requirement

## Acceptance Criteria

- [x] SLO definitions in versioned config (`monitoring/slos.yml`)
- [x] Multi-window burn-rate alerts (fast + slow) for each SLO
- [x] Alert rules validator (syntax, uniqueness, severity, annotations, expressions)
- [x] CI integration (fails on validation errors)
- [x] Tests for validator and generator (100% pass rate)
- [x] Burn-rate rules generated from SLO config (single source of truth)
- [x] Documentation (README with usage, methodology, contribution guide)
- [x] Runbook links in all new alerts (per Issue #116)
- [x] Existing alert rules unchanged (backward compatible)
- [x] No secrets in expressions or annotations

## How to Review

1. **SLO Definitions**: Review `monitoring/slos.yml` for appropriate objectives and error budgets
2. **Generated Rules**: Check `monitoring/alert-rules.yml` → `stellar-indigopay-slo-burn-rate` group
3. **Validator Logic**: Review `scripts/validate-alert-rules.js` for completeness of checks
4. **Tests**: Run test suites locally:
   ```bash
   node monitoring/tests/validate-alert-rules.test.js
   node monitoring/tests/generate-slo-alerts.test.js
   ```
5. **CI Integration**: Check `.github/workflows/ci.yml` → `alert-rules-validation` job
6. **Documentation**: Review `monitoring/README.md` for clarity and completeness

## Next Steps (Future Work)

1. **Runbook Creation**: Create wiki pages for each SLO runbook (linked in annotations)
2. **Grafana Dashboards**: Add SLO dashboards showing error budget consumption
3. **Alertmanager Routing**: Configure routing for SLO alerts (PagerDuty for fast burns)
4. **Backfill Existing Alerts**: Add runbooks to pre-existing operational alerts
5. **Webhook Metrics**: Implement `webhook_delivery_duration_seconds` histogram (remove from allowlist)

## Author

**morelucks** (luckykamshak@gmail.com)

---

**Ready for Review** ✅

This PR is complete, tested, and ready for merge. All CI checks pass locally. Looking forward to feedback!
