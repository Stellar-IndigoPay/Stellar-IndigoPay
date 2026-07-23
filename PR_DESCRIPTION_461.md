# On-Chain Anomaly Detection with Circuit Breaker per Project

Closes #461

## Summary

Adds configurable anomaly-detection rules with sliding-window counters that automatically pause a project when any rule is violated. This provides automated defense against coordinated attacks (Sybil, wash donations) without relying on manual admin monitoring.

## Changes

### New types (`lib.rs`)

- `AnomalyMetric` enum — `DonationVolume`, `DonationCount`, `NewDonorRate`, `AverageDonationSize`
- `AnomalyRule` struct — `{ metric, threshold, window_ledgers }`
- `AnomalyWindow` struct — sliding-window accumulator per (project, rule_index)

### New storage keys

- `DataKey::AnomalyRules(String)` — per-project rule set (`Vec<AnomalyRule>`)
- `DataKey::AnomalyWindow(String, u32)` — sliding-window counter per (project, rule_index)

### New public functions

| Function | Auth | Description |
| --- | --- | --- |
| `set_anomaly_rules(signers, project_id, rules)` | M-of-N critical | Configure anomaly rules for a project; empty rules disables detection |
| `clear_anomaly(admin, project_id)` | Routine single-admin | Clear window counters and resume a paused project |
| `get_anomaly_rules(project_id)` | Read-only | Return configured rules for frontend display |

### Donation flow integration

`check_anomaly_rules()` is called after the external token transfer in `process_donation()`. For each configured rule:

1. Load or initialize the sliding-window counter
2. If the window has expired, reset counters
3. Increment count, volume, and (if applicable) new-donor tracking
4. Evaluate the rule threshold
5. If violated: persist the window, auto-pause the project, emit `anomaly_detected`, and return early

### Events

| Event | Topics | Data | When |
| --- | --- | --- | --- |
| `anomaly` | `["anomaly", project_id]` | `(metric_symbol, threshold, window_ledgers, rule_index)` | Rule violated |
| `anm_rule` | `["anm_rule", admin]` | `(project_id, rule_count)` | Rules configured |
| `anm_clr` | `["anm_clr", admin]` | `project_id` | Anomaly cleared |

### Tests

**Unit tests** (7):
- `test_anomaly_disabled_no_rules` — empty rules = no detection
- `test_anomaly_rule_volume_below_threshold` — donation below volume threshold
- `test_anomaly_rule_volume_above_threshold` — auto-pause on volume breach
- `test_anomaly_rule_count_below_threshold` — donation count below threshold
- `test_anomaly_rule_count_above_threshold` — auto-pause on count breach
- `test_anomaly_auto_pause_and_clear` — auto-pause then clear resumes project
- `test_anomaly_clear_only_resumes_paused` — clear on unpaused project is no-op
- `test_anomaly_cannot_donate_when_paused` — donation rejected after auto-pause

**Fuzz test** (1):
- `prop_anomaly_no_false_positive_below_threshold` — proptest verifies that donations whose cumulative volume stays below the threshold never trigger the circuit breaker

### Documentation

- `EVENTS.md` — 3 new events documented (#33–#35)
- `CHANGELOG.md` — feature entry added
- `SECURITY.md` — trust model, data model, metrics, known limitations

## Design Decisions

1. **Detection runs AFTER transfer** — consistent with CEI pattern; the donation is final and the circuit breaker acts on the next donation.
2. **No auto-unpause** — admin must call `clear_anomaly` explicitly; prevents attacker from triggering and clearing in one transaction.
3. **Per-project isolation** — each project has independent rules and windows; no cross-project correlation (out of scope per issue).
4. **`DEFAULT_ANOMALY_WINDOW = 720`** — fallback when `window_ledgers == 0` is rejected at rule configuration time (validated).
