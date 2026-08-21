# Trace correlation on-call flow

Use a single W3C trace ID to follow an API request through PostgreSQL-backed queues and workers. Payload bodies and user identifiers are intentionally absent from telemetry.

1. Copy the trace ID from the structured request log or the `traceparent` job metadata. For `traceparent=00-<trace-id>-<span-id>-<flags>`, use the 32-character `<trace-id>`.
2. In Grafana Explore, select Tempo and search by trace ID. Confirm the `HTTP request` span has the expected normalized `http.route` and environment resource attribute.
3. Follow its `* enqueue` child, then the linked `* worker` span restored from job metadata. A worker restart does not break the chain because context is stored in metadata, outside encrypted payload data.
4. Inspect `db.query` children by `db.operation.name`. SQL statements, payloads, wallet addresses, URLs, and e-mail addresses are never exported.
5. For scheduled indexer/keeper work, start at its worker root span and correlate to logs using the trace ID.

If no trace exists, check collector health and `otelcol_exporter_*`/`otelcol_processor_*` metrics. The SDK buffers 2,048 spans in memory, exports batches of 512 every five seconds, and drops new spans when bounded capacity is exhausted; application work must continue during a collector outage.

## Sampling and cardinality budgets

- API roots use 10% head sampling (`OTEL_API_SAMPLE_RATIO=0.1`). Raise only during a time-boxed incident.
- The collector always retains error traces and traces slower than two seconds, then keeps a 10% baseline. It holds at most 50,000 pending trace decisions for ten seconds.
- Environment is a resource attribute (`deployment.environment.name`), so traces cannot accidentally mix across environments.
- Span names are static and attributes pass a code-level allowlist. Never add user input, payload contents, transaction bodies, full URLs, SQL, e-mail, or wallet addresses.

## Staging verification

Point `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` at staging, submit a donation, copy its trace ID from logs, and verify the HTTP → enqueue → worker → DB waterfall plus the telemetry dashboard panels before promoting.
