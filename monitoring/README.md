# Monitoring and Alerting

This directory contains the monitoring configuration for Stellar-IndigoPay, including Prometheus alert rules, SLO definitions, and validation tools.

## Overview

The monitoring system consists of:

1. **Alert Rules** (`alert-rules.yml`): Prometheus alerting rules for operational signals
2. **SLO Definitions** (`slos.yml`): Service Level Objectives with burn-rate alerting
3. **Validation Tools**: Scripts to ensure rule quality and prevent misconfigurations
4. **Tests**: Automated tests for validators and generators

## Service Level Objectives (SLOs)

### What are SLOs?

Service Level Objectives (SLOs) are explicit promises about the availability and latency of critical user journeys. They define:

- **Objective**: The target reliability (e.g., 99.5% availability)
- **Window**: The time period over which reliability is measured (e.g., 30 days)
- **Error Budget**: The allowed failure rate (e.g., 0.5% error budget = 100% - 99.5%)

### SLO Configuration (`slos.yml`)

The `slos.yml` file defines SLOs for:

1. **Donation Submission Availability** (99.5%)
   - Success metric: POST /api/donations with non-5xx responses
   - Error budget: 0.5%

2. **Project Browsing Availability** (99.9%)
   - Success metric: GET /api/projects* with non-5xx responses
   - Error budget: 0.1%

3. **Donation Submission Latency** (99% < 3s)
   - Success metric: P99 latency for POST /api/donations
   - Target: 3 seconds

4. **Webhook Delivery Freshness** (99% < 60s)
   - Success metric: P99 webhook delivery time
   - Target: 60 seconds

### Burn-Rate Alerting

SLOs use **multi-window burn-rate alerts** based on the [Google SRE Workbook](https://sre.google/workbook/alerting-on-slos/):

- **Fast Burn (1h window, 14.4x rate)**: Pages immediately for severe incidents
  - At 14.4x consumption rate, the entire 30-day error budget exhausts in ~2 days
  - Severity: `page`
  
- **Slow Burn (6h window, 3x rate)**: Warns about sustained degradation
  - At 3x consumption rate, gradual erosion of reliability
  - Severity: `warn`

### Generating SLO Alerts

Alert rules are **generated** from `slos.yml` to ensure consistency:

```bash
# Generate and inject SLO alerts into alert-rules.yml
node scripts/generate-slo-alerts.js

# Dry-run (print without modifying files)
node scripts/generate-slo-alerts.js --dry-run
```

**Important**: Never hand-edit the `stellar-indigopay-slo-burn-rate` group in `alert-rules.yml`. It is automatically generated. To modify SLO alerts, edit `slos.yml` and re-run the generator.

## Alert Rules Validation

The `scripts/validate-alert-rules.js` validator checks:

1. **YAML Syntax**: Valid YAML structure
2. **Expression Syntax**: Basic Prometheus expression validation (balanced parentheses, metric names)
3. **Alert Name Uniqueness**: No duplicate alert names across groups
4. **Severity Allowlist**: Only `page`, `warn`, or `critical` severities
5. **Required Annotations**: All alerts must have `summary`
6. **Recommended Annotations**: Warns if `description` or `runbook` is missing
7. **Runbook URLs**: Validates format and checks for embedded credentials
8. **Duration Format**: Validates `for` field syntax

### Running the Validator

```bash
# Validate the default alert rules file
node scripts/validate-alert-rules.js

# Validate a specific file
node scripts/validate-alert-rules.js path/to/custom-rules.yml
```

The validator runs automatically in CI (see `.github/workflows/ci.yml`).

## Alert Rule Structure

### Required Fields

Every alert rule must include:

```yaml
- alert: AlertName
  expr: prometheus_expression
  for: 5m
  labels:
    severity: page  # or warn, critical
  annotations:
    summary: "Short description of the alert"
    description: "Detailed explanation (optional but recommended)"
    runbook: "https://github.com/org/repo/wiki/Runbook-AlertName"
```

### Severity Levels

- **`page`**: Wake someone up immediately (SLO fast burns, critical operational failures)
- **`warn`**: Review during business hours (SLO slow burns, degraded performance)
- **`critical`**: Alternative to `page` for compatibility with some alerting systems

### Runbook Linkage

All alerts should reference a runbook (per [Issue #116](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/116)). Runbooks provide:

- Root cause investigation steps
- Mitigation procedures
- Escalation paths
- Related metrics and dashboards

Runbook URLs:
- Must use `https://` protocol
- Must NOT contain credentials (tokens, API keys, passwords)

## Testing

### Validator Tests

```bash
node monitoring/tests/validate-alert-rules.test.js
```

Tests cover:
- Valid rules pass
- Duplicate names detected
- Invalid severity rejected
- Missing annotations flagged
- Malformed expressions caught
- Invalid `for` durations rejected
- Empty expressions caught

### SLO Generation Tests

```bash
node monitoring/tests/generate-slo-alerts.test.js
```

Tests cover:
- Generation script runs successfully
- Generated YAML is valid
- Burn-rate calculations are correct
- SLO group properly injected
- Generation is deterministic
- All SLOs have alerts

## Continuous Integration

The CI pipeline (`.github/workflows/ci.yml`) includes a dedicated `alert-rules-validation` job:

1. Validates alert rules syntax and conventions
2. Verifies SLO configuration is valid YAML
3. Tests SLO alert generation (dry-run)
4. Runs validator test suite
5. Runs SLO generation test suite

Builds fail if:
- Alert rules have validation errors (not warnings)
- SLO generation fails
- Tests fail

## Prometheus Configuration

The `prometheus.yml` file configures:

- Scrape targets (backend API, postgres-exporter)
- Rule file loading (`alert-rules.yml`, `recording-rules.yml`)
- Alertmanager integration

To reload Prometheus after rule changes:

```bash
# Send SIGHUP to Prometheus (Kubernetes)
kubectl exec -n stellar-indigopay prometheus-0 -- killall -HUP prometheus

# Or use Prometheus HTTP API
curl -X POST http://prometheus:9090/-/reload
```

## Metric Allowlist

Some metrics referenced in alerts may not exist yet (e.g., `webhook_delivery_duration_seconds_bucket` for the webhook worker). These are documented in the validator's `ALLOWLISTED_METRICS` set.

Warnings are issued for allowlisted metrics, but validation still passes.

## Security Considerations

1. **No Secrets in Expressions**: Alert expressions must never embed credentials
2. **No Secrets in Annotations**: Runbook URLs and descriptions must not include internal URLs with credentials
3. **Bearer Token Protection**: Prometheus scrape endpoints use `PROMETHEUS_BEARER_TOKEN` (configured via Kubernetes Secret)

## References

- [Google SRE Workbook: Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/)
- [Issue #913: Add SLO-based burn-rate alerting](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/913)
- [Issue #116: Runbook linkage requirement](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/116)
- [Prometheus Alerting Best Practices](https://prometheus.io/docs/practices/alerting/)

## Contributing

When adding new alerts:

1. Define the alert in the appropriate group in `alert-rules.yml`
2. Include all required fields (`summary`, `runbook`)
3. Run the validator: `node scripts/validate-alert-rules.js`
4. Test in a Prometheus dev environment before merging
5. Document the alert in the relevant runbook

When modifying SLOs:

1. Edit `monitoring/slos.yml`
2. Regenerate alerts: `node scripts/generate-slo-alerts.js`
3. Run tests: `node monitoring/tests/generate-slo-alerts.test.js`
4. Commit both `slos.yml` and the updated `alert-rules.yml`
