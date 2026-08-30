---
title: Horizon Indexer Lag and Worker Freshness Incident Response
severity: page
owners:
  - "@oncall-team"
symptoms:
  - "IndexerLagHigh or IndexerStreamDown alert active"
  - "Stellar Horizon indexer lag exceeding threshold (>50 ledgers)"
  - "Stale oracle prices or queue depth buildup"
steps:
  - "Check connectivity between backend indexer worker and Stellar Horizon RPC endpoint."
  - "Inspect worker logs via `kubectl logs -n stellar-indigopay -l app=backend,role=worker`."
  - "Restart indexer stream worker if connection is hung."
  - "Trigger auto-backfill for missed ledger range if required."
verification:
  - "Confirm `indigopay_indexer_lag_ledgers` returns to <10 ledgers."
rollback:
  - "Switch to backup Horizon node provider."
---

# Indexer Lag Runbook

## Overview
Triggered when the Horizon blockchain event indexer falls behind current ledger sequence.
