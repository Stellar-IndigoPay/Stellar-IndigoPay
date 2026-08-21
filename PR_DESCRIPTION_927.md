Closes #927

## Summary

Adds an OpenTelemetry pipeline for backend API requests and workers:

- Instruments HTTP requests, PostgreSQL queries, webhook/digest queues, the indexer, and recurring keeper.
- Propagates W3C `traceparent` through queue metadata.
- Adds bounded API head sampling and worker tail sampling.
- Enforces a PII-safe telemetry attribute allowlist.
- Adds OpenTelemetry Collector, Tempo, and Grafana provisioning as code.
- Adds dashboards for route latency/errors, queue depth/latency, and donation trace waterfalls.
- Adds CI validation for collector configuration and dashboard JSON.
- Adds an in-memory exporter test covering the API → queue → worker trace chain.
- Adds an on-call trace-correlation runbook with sampling, outage, and cardinality guidance.

## Testing

- 59 targeted tests passed across telemetry, DB pool, webhook queue, digest queue, and indexer.
- Dashboard validation passed for both dashboards.
- Modified files pass ESLint with no new errors.
- Collector YAML parses successfully.
- Exact collector binary validation is configured in CI but could not run locally because Docker Desktop was not running.

## Security

- Payload bodies, SQL statements, email addresses, wallet addresses, and arbitrary user fields are excluded.
- Queue context is propagated only through metadata.
- Span names are static and do not embed user input.
- Environment separation uses `deployment.environment.name`.

## Repository state

The `telemetryPipeline` branch was created after removing local changes and resetting `main` to the locally available `origin/main` reference at `b68460a`. Fetching the remote reference was unsuccessful because the configured GitHub SSH key was rejected.
