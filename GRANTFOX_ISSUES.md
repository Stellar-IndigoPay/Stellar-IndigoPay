# GrantFox OSS — 50 High-Value Implementation-Ready GitHub Issues

> Generated from deep analysis of the Stellar-IndigoPay codebase across all 4 Soroban contracts (IndigoPay 17,499-line lib.rs with 136 error codes, 16 feature gates), escrow contract (milestone-based fund release with M-of-N governance, reputational tracking), attestation contract (cross-chain bridge with on-chain donor/chain aggregation), oracle contract (TWAP with stake/slash, median-of-medians aggregation), backend event-sourcing pipeline (projection engine with 4 read models, idempotent replay), webhook delivery (6-attempt backoff, DLQ, HMAC-SHA256 signing), AI summary pipeline (Anthropic Claude with retry/fallback/caching), indexer with backfill/reconcile/DLQ, CO2 verification pipeline (Gold Standard, Verra, GFW satellite integration), and full Kubernetes/Helm/ArgoCD/prometheus/Alertmanager production infrastructure. Every issue targets a genuine technical gap, architectural weakness, security concern, or production-readiness requirement.

---

## Issue #001 — IndigoPay: Migrate `Events::publish` to `#[contractevent]` pattern across all 4 contracts

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/architecture`, `priority/high`, `effort/large`

### Summary
All four Soroban contracts use the deprecated `env.events().publish()` API with `#![allow(deprecated)]` at the crate root. The `#[contractevent]` macro provides type-safe event emission with automatic XDR schema generation, structured topic indexing, and elimination of ad-hoc `symbol_short!()` topic strings. The TODO `indigopay-272` in `contracts/indigopay-contract/src/lib.rs` line 4 has tracked this migration for over a year.

### Background
Every contract suppresses the deprecation warning via `#![allow(deprecated)]` at the crate root. Events use `env.events().publish((topic_symbol, ...), (data, ...))` with manually constructed tuples. The `#[contractevent]` macro was stabilized in soroban-sdk 20.x and provides:
- Compile-time schema validation for event topic and data types
- Automatic `symbol_short!()` derivation from the event struct name
- Guaranteed uniqueness of event discriminants within a contract
- Cleaner indexer consumption (SDK-generated event schemas vs reverse-engineered tuple layouts)

### Problem Statement
1. **Deprecation risk**: The deprecated API may be removed in a future soroban-sdk release, blocking SDK upgrades.
2. **Type unsafety**: Manual tuple construction means adding or reordering event fields is a silent runtime bug — indexers receive garbled data with no compile error.
3. **Duplicate topic risk**: Two events using the same `symbol_short!()` string accidentally would silently collide and corrupt indexer data.
4. **310 total events** across 4 contracts — manual topic management is unsustainable as the contract family grows.

### Objectives
- Replace all `env.events().publish(...)` calls across all 4 contracts with `#[contractevent]` structs and `env.events().publish(&event)`
- Update the `symbol_short!` topic references in `contracts/EVENTS.md` to reflect the new `#[contractevent]` discriminants
- Remove `#![allow(deprecated)]` from each contract's crate root
- Ensure all existing event tests continue to pass (event count, topic names, data fields)

### Scope
**In Scope**
- `contracts/indigopay-contract/src/lib.rs` — all event emission sites (estimated 50+ publish calls)
- `contracts/escrow-contract/src/lib.rs` — all event emission sites
- `contracts/attestation-contract/src/lib.rs` — all event emission sites
- `contracts/oracle-contract/src/lib.rs` — all event emission sites
- `contracts/EVENTS.md` — update event topic table
- Test modules in all 4 contracts — update event assertions

**Out of Scope**
- Changing event data payloads (keep identical)
- Adding new events
- Backend indexer changes (the `sorobanEventService` already deserializes raw event data generically)

### Implementation Plan
1. Define one `#[contractevent]` struct per existing event (e.g., `DonatedEvent`, `NftMintEvent`, `ProjectRegisteredEvent`)
2. Replace each `env.events().publish((topic, ...), (data, ...))` with `env.events().publish(&EventName { field1, field2, ... })`
3. Run `cargo build --workspace --target wasm32v1-none --release` and verify no size regression against the 64 KB CI limit
4. Run `cargo test --features testutils --workspace` and fix any event assertion breakage
5. Run `cargo clippy --workspace -- -D warnings` and confirm no new warnings (old `#![allow(deprecated)]` removed)

### Expected Files or Components
- `contracts/indigopay-contract/src/lib.rs`
- `contracts/escrow-contract/src/lib.rs`
- `contracts/attestation-contract/src/lib.rs`
- `contracts/oracle-contract/src/lib.rs`
- `contracts/EVENTS.md`

### Acceptance Criteria
- Zero `env.events().publish(tuple)` calls remain in any contract
- `#![allow(deprecated)]` removed from all 4 crate roots
- `cargo build --target wasm32v1-none --release` passes with WASM sizes within CI budget (64 KB per contract)
- All 2,400+ existing tests pass
- `contracts/EVENTS.md` updated with new event discriminants
- CI green on `contracts.yml` workflow

### Testing Requirements
- All existing event-related unit tests must pass
- `cargo test --features testutils --workspace` full pass
- Manual verification that `stellar contract invoke` still emits expected event topics on testnet

### CI Requirements
- `contracts.yml` workflow: `cargo fmt --all -- --check`, `cargo clippy --workspace -- -D warnings`, `cargo test --features testutils --workspace -- --skip fuzz`, WASM size check (< 64 KB)

### Deliverables
- Single PR touching all 4 contracts
- Changelog entry under `[Unreleased]`

### Definition of Done
- [ ] All `publish()` calls migrated to `#[contractevent]`
- [ ] Deprecation allows removed
- [ ] All tests pass
- [ ] WASM sizes within budget
- [ ] EVENTS.md updated
- [ ] CI green

### References
- `contracts/indigopay-contract/src/lib.rs` line 3-5 (`#![allow(deprecated)]`, TODO comment)
- `contracts/indigopay-contract/src/lib.rs` — all `env.events().publish(` sites
- `contracts/EVENTS.md` — current event table
- Soroban SDK docs: `#[contractevent]` macro

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #002 — IndigoPay: Implement storage TTL extension batching for all persistent keys

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/high`, `effort/large`

### Summary
Soroban persistent storage entries have a Time-To-Live (TTL) measured in ledgers. When TTL expires, the network archives the entry and it becomes unavailable until restored. The IndigoPay contract has ~40 `DataKey` variants, many storing persistent data (donation records, project data, donor stats, governance proposals, vesting schedules, refund requests, attestation settlements, ZK nullifiers). Currently there is no systematic TTL extension mechanism beyond the commented-out `extend_all_ttl` benchmark in `docs/gas-optimization.md`. A deployed contract with archival entries becomes non-functional until a restore transaction is submitted.

### Background
The `docs/gas-optimization.md` "Further Optimization Opportunities" section lists "Batched TTL extension" as a long-term item. The `ZK_STORAGE_TTL_LEDGERS` constant (6,307,200 ledgers ≈ 1 year) in `lib.rs` demonstrates awareness of the TTL problem but only addresses the ZK nullifier case. No general-purpose TTL extension function exists. Soroban's `env.storage().persistent().extend_ttl()` can extend individual keys, and `env.storage().persistent().extend_ttl_for_all()` extends all keys — but the latter may exceed the per-transaction resource budget for large contracts.

### Problem Statement
Without a TTL extension mechanism:
1. **Silent data loss**: After ~120 days (default TTL), critical on-chain data (donation history, project registrations, governance proposals) becomes unreadable.
2. **No automated recovery**: The contract has no internal mechanism to bump TTLs during normal operation.
3. **Operator burden**: Every deployment requires an external cron job or keeper to periodically submit TTL extension transactions.
4. **ZK nullifier risk**: If a ZK nullifier's TTL lapses and is restored, there's a theoretical window where the nullifier could be reused (mitigated by the 1-year window, but not eliminated).

### Objectives
- Implement a `bump_ttl(from: u32, count: u32)` entrypoint that extends the TTL of `count` persistent storage entries starting at index `from`, using a deterministic iteration order over `DataKey` variants
- Add a `get_ttl_stats()` read function returning the total number of persistent entries and the ledger at which the earliest entry expires
- Integrate TTL extension into the `extend_all_ttl` benchmark entrypoint (already documented in gas-optimization.md)
- Add Prometheus metrics or event emission so operators can monitor TTL health off-chain
- Implement a "lazy bump" pattern: each state-mutating function bumps the TTL of the entries it touches during normal operation (amortized, zero additional transactions)

### Scope
**In Scope**
- New `bump_ttl` and `get_ttl_stats` entrypoints in IndigoPay contract
- Lazy TTL bump in `donate`, `register_project`, `vote_verify_project`, `create_vesting_schedule`, and other high-frequency mutators
- Unit tests verifying TTL extension
- Update `docs/gas-optimization.md` with benchmark data

**Out of Scope**
- TTL extension for companion contracts (escrow, attestation, oracle) — separate issues
- Changing Soroban host TTL defaults
- Off-chain keeper implementation (that's a backend service task)

### Implementation Plan
1. Add a `DataKey` iterator helper that yields all variant discriminants in a fixed order
2. Implement `bump_ttl(env, from, count)` — iterate from `from` for `count` entries, call `env.storage().persistent().extend_ttl(&key, threshold, extend_to)` on each
3. Implement `get_ttl_stats(env)` — scan all persistent keys, find minimum TTL, return (total_entries, min_ttl_ledger, current_ledger)
4. Add `emit_ttl_event` to emit a `ttl_bump` event with (from, count, extended_count)
5. In `donate` and other hot paths, after writing persistent data, call `bump_written_keys()` on the specific keys just written
6. Benchmark and document the gas cost per-entry and estimate batch sizes that fit within Soroban's per-transaction budget

### Expected Files or Components
- `contracts/indigopay-contract/src/lib.rs` — new entrypoints, lazy bump integration
- `contracts/indigopay-contract/src/donation/contract.rs` — lazy bump in donate paths
- `docs/gas-optimization.md` — TTL section update

### Acceptance Criteria
- `bump_ttl` extends TTL of the requested number of entries
- `get_ttl_stats` returns accurate (total, min_ttl) data
- Lazy bump keeps recently-touched entries alive without separate transactions
- `cargo test --features testutils -p indigopay-contract` passes (new + existing)
- Gas benchmarks documented for batch sizes 10, 50, 100

### Testing Requirements
- Unit tests: bump 0 entries (no-op), bump within range, bump beyond range (panic), verify TTL after bump
- Integration test: create donation → verify TTL extended on donation record
- Fuzz test: random sequences of bump calls with varying from/count

### CI Requirements
- Standard contract CI + WASM size check

### Deliverables
- Single PR
- Changelog entry

### Definition of Done
- [ ] `bump_ttl` and `get_ttl_stats` implemented
- [ ] Lazy bump integrated into hot paths
- [ ] Tests pass
- [ ] Gas benchmarks documented
- [ ] CI green

### References
- `docs/gas-optimization.md` — "Further Optimization Opportunities" section
- `contracts/indigopay-contract/src/lib.rs` — `ZK_STORAGE_TTL_LEDGERS` constant
- `contracts/indigopay-contract/src/lib.rs` — `DataKey` enum
- Soroban docs: Storage TTL and archival

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)
## Issue #003 — IndigoPay: Implement ceiling division for CO₂ offset calculation to credit sub-stroop donations

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/medium`, `effort/medium`

The `FUZZ_FINDINGS.md` documents that sub-stroop donations (< 1 XLM) generate zero CO₂ offset due to integer floor division: `xlm_units = amount / STROOP` produces 0 for `amount < 10,000,000`. While this is mathematically correct, it means micro-donations produce zero on-chain climate impact — a product concern for accessibility. Implement an optional ceiling division mode (round up) configurable via admin, or switch the core calculation to use ceiling division universally. This requires careful analysis of overflow behavior: `(amount + STROOP - 1) / STROOP` must not overflow `amount + STROOP - 1` for `amount` near `i128::MAX`.

**Files:** `contracts/indigopay-contract/src/donation/contract.rs`, `contracts/indigopay-contract/src/lib.rs`, `FUZZ_FINDINGS.md`
**Tests:** Unit test for sub-stroop amounts, property test for CO₂ monotonicity with ceiling division, regression test for MAX donation overflow guard.
**Security:** Verify that ceiling division does not enable CO₂ inflation attacks (many tiny donations claiming disproportionate offset).

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #004 — Escrow: Implement `claim_milestone` access control check (caller must be job.freelancer)

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/bug`, `priority/high`, `effort/small`

The `claim_milestone` function calls `freelancer.require_auth()` but never verifies `job.freelancer == freelancer`. Unlike `release_milestone` (checks `job.client == client`) and `submit_milestone_proof` (checks `job.freelancer == freelancer`), `claim_milestone` accepts any authenticated address. While funds are sent to `job.freelancer` (the stored address), an unauthorized caller can prematurely mark milestones as released and transfer tokens to the genuine freelancer without client consent, disrupting the escrow workflow.

**Files:** `contracts/escrow-contract/src/lib.rs` — `claim_milestone` function (~line 500-560)
**Tests:** `#[should_panic]` test with wrong freelancer address
**Security:** This is an access-control bypass — unauthorized state mutation of escrow milestones.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #005 — Oracle: Implement slashing threshold ramp to prevent reporter griefing during network volatility

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/medium`, `effort/medium`

The oracle contract's `report_price` deviation circuit breaker rejects any observation exceeding `max_deviation_bps` from the current TWAP. During rapid market movements (e.g., a 15% XLM price swing in 5 minutes), ALL reporter observations would be rejected because they all differ from the stale TWAP by more than the configured threshold. This creates a deadlock: the TWAP can't update because new observations are rejected because they differ from the TWAP. Implement a "slashing threshold ramp" that progressively relaxes the deviation tolerance when no valid observation has been accepted for N consecutive ledgers, allowing the TWAP to catch up to the new market price.

**Files:** `contracts/oracle-contract/src/lib.rs` — `report_price`, `current_price_raw`
**Tests:** Simulation test: inject stale TWAP, attempt rapid price change, verify ramp allows catch-up
**Security:** Ensure the ramp cannot be exploited to push the TWAP through multiple thresholds faster than the market actually moves.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #006 — IndigoPay: Add quadratic voting credit decay to prevent long-term voter credit hoarding

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/medium`, `effort/medium`

The governance system uses quadratic voting: voting power = sqrt(credits_spent), and credits are allocated based on badge tier. Credits are never consumed or decayed — a Seedling badge holder who never votes accumulates voting power indefinitely. This creates a "voting power hoarding" dynamic where long-term holders dominate governance regardless of recent participation. Implement exponential credit decay: credits earned more than N ledgers ago (configurable, default ~90 days) decay at a rate of X% per ledger, so voters must stay active to maintain influence.

**Files:** `contracts/indigopay-contract/src/lib.rs` — `VoterCredits`, `vote_verify_project`
**Tests:** Unit test for decay calculation, property test for monotonic non-negative decay, integration test with vote → wait → verify reduced credits.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #007 — Attestation: Add batched `settle_attestation` to reduce cross-contract call overhead for high-volume bridges

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/medium`, `effort/medium`

The IndigoPay contract's `settle_attestation` processes one cross-chain attestation at a time via a cross-contract call to the attestation contract's `get_attestation`. For high-volume bridges (Ethereum mainnet finality windows produce batches of 50+ attestations), settling individually costs ~15,000 stroops × N where N may be 50+. Implement `batch_settle_attestations(env, attestation_ids: Vec<u64>)` that reads multiple attestations in one cross-contract call, amortizing the ~2,000 stroop cross-contract overhead across the batch.

**Files:** `contracts/indigopay-contract/src/lib.rs` — `settle_attestation`, `AttestationInterface`
**Tests:** Unit test for single-settle parity with batch-settle, gas comparison benchmark
**Security:** Ensure double-settlement guard (`SettlementKey::SettledAttestation`) works correctly in batch mode.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #008 — IndigoPay: Implement `DonationRecord` pagination contract-side to enable efficient indexer queries

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/medium`, `effort/medium`

The contract stores donation records as individual `DataKey::DonationRecord(u32)` entries with a `DonationCount` counter. Reading donation history requires N separate `get_donation_record` calls — one per index. For projects with 10,000+ donations, this is O(n) RPC calls. Implement `get_donation_page(env, from: u32, count: u32) -> Vec<DonationRecord>` that reads `count` entries starting at `from` in a single function call, with a cap (e.g., 50) to stay within Soroban's per-call resource budget.

**Files:** `contracts/indigopay-contract/src/lib.rs` — new read function
**Tests:** Unit tests for empty page, partial page (near end), full page, out-of-bounds `from`.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #009 — Escrow: Add `MAX_JOBS` enforcement with grace-period archival for completed/disputed jobs

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/medium`, `effort/medium`

The escrow contract has `MAX_JOBS = 256` but provides no mechanism to remove completed or disputed jobs from the `JobIds` vector or free their storage slots. Once 256 jobs are created, no new jobs can be created — even if 255 are long-completed. Implement a `cleanup_completed_jobs` permissionless function that removes jobs with status `Completed` where `deadline + GRACE_PERIOD < current_ledger`, freeing their `DataKey::Job` entries and removing them from `JobIds`. The `FreelancerReputation` must be preserved even after job cleanup.

**Files:** `contracts/escrow-contract/src/lib.rs` — new `cleanup_completed_jobs`, `GRACE_PERIOD` constant
**Tests:** Unit test: create 256 jobs, complete 255, verify cleanup frees slots, verify 257th job succeeds
**Security:** Ensure cleanup cannot be used to censor or remove in-flight (Escrowed/PartiallyReleased/Disputed) jobs.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #010 — Oracle: Implement multi-source oracle health monitoring with automatic failover

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/high`, `effort/large`

The `get_aggregated_price` function queries all registered source oracles and computes a median. However, it silently skips oracles that return errors or invalid values. A compromised oracle consistently returning 0 or panicking is simply skipped — no event is emitted, no alarm is raised. Implement a per-source-oracle health tracking system: track the last N (e.g., 20) response outcomes per source, emit a `src_unhealthy` event when a source exceeds a configurable failure threshold, and provide a `get_source_health(source) -> SourceHealth` read function for off-chain monitoring.

**Files:** `contracts/oracle-contract/src/lib.rs` — `get_aggregated_price`, new health tracking storage and entrypoints
**Tests:** Simulate failing source, verify health event emission after threshold, verify healthy source recovery resets counters
**Security:** A temporarily unhealthy source that recovers must not be permanently excluded — health must be reversible.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #011 — IndigoPay: Add Merkle Mountain Range (MMR) proof verification for batched impact certificate inclusion

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/high`, `effort/large`

The impact verification system (`#[cfg(feature = "impact")]`) supports Merkle tree proofs via `verify_impact_inclusion`, but uses a flat Merkle tree that requires O(log n) recomputation per proof. MMRs (Merkle Mountain Ranges) support efficient append-only proofs and are better suited for streaming impact data where new leaves are continuously added. The contract already has `ImpactRoot` archiving with period rotation. Implement MMR-based proof verification: `verify_impact_mmr(env, project_id, leaf, mmr_proof) -> bool` that verifies a leaf's inclusion in the current MMR root using the MMR proof structure. The MMR must support incremental updates as new impact data arrives without recomputing the entire tree.

**Files:** `contracts/indigopay-contract/src/lib.rs` — new MMR verification logic, `ImpactRoot` struct extension
**Tests:** Unit tests for MMR append, proof generation/verification, edge cases (empty MMR, single leaf, multiple peaks)
**Security:** Verify that a proof for a non-existent leaf cannot be constructed. Verify MMR consistency across period boundaries.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #012 — IndigoPay: Implement cross-contract re-entrancy guard for escrow and attestation settlement calls

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/security`, `priority/high`, `effort/medium`

The IndigoPay contract makes cross-contract calls to the escrow contract (`EscrowClient`) and attestation contract (`AttestationClient`). While the CEI pattern (Checks-Effects-Interactions) is followed within the IndigoPay contract, a malicious escrow or attestation contract (if upgraded through admin compromise) could call back into IndigoPay during the cross-contract invocation. Soroban prevents direct re-entrancy (a contract cannot call itself recursively), but cross-contract re-entrancy through a chain of trusted contracts is possible. Implement a `REENTRANCY_GUARD` instance-storage flag set before and cleared after each cross-contract call, panicking if entered while the guard is set.

**Files:** `contracts/indigopay-contract/src/lib.rs` — `setup_campaign_escrow`, `fund_escrow`, `release_escrow_milestone`, `settle_attestation`
**Tests:** Mock re-entrant attestation contract that attempts callback, verify guard panics
**Security:** This is a defense-in-depth measure — no known exploit exists, but the guard protects against future vulnerabilities.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #013 — Escrow: Add milestone-level oracle proof verification timeout to prevent indefinite blocking

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/bug`, `priority/medium`, `effort/medium`

When a milestone has an `oracle` configured (behind the `oracle-escrow` feature), `release_milestone` checks `milestone.verified` before allowing release. If the oracle never calls `verify_milestone`, the milestone is permanently blocked — neither client nor freelancer can unblock it. The only escape is admin dispute resolution (`dispute_milestone` + `resolve_milestone_dispute`). Implement a timeout: if `proof_hash` was set more than N ledgers ago and the oracle hasn't verified, the milestone's oracle requirement is waived (the `oracle` field behavior becomes "optional verification within timeout, not permanent gate"). The timeout should be configurable per-milestone at `create_job` time.

**Files:** `contracts/escrow-contract/src/lib.rs` — `create_job` (new Milestone field), `release_milestone` (timeout check)
**Tests:** Create job with oracle milestone, advance ledger past timeout, verify release succeeds without oracle verification
**Security:** The timeout must not be shorter than a reasonable oracle response time (minimum 1,000 ledgers ≈ 83 minutes).

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #014 — IndigoPay: Implement `get_donor_history_paginated` to replace N+1 query pattern in frontend

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/performance`, `priority/medium`, `effort/medium`

The frontend donor dashboard calls `get_donor_stats` (1 RPC) plus `get_donation_record(i)` for each of the donor's N donations (N RPCs). For a donor with 200 donations, this is 201 RPC calls to render one page. The contract has no batched donor-history read. Implement `get_donor_history(env, donor, from: u32, count: u32) -> Vec<DonationRecord>` that returns a page of donation records for a specific donor in one RPC call. This requires a new storage index: `DataKey::DonorDonationIndex(Address, u32) -> u32` mapping per-donor sequential indices to global donation indices.

**Files:** `contracts/indigopay-contract/src/lib.rs` — new read function, `donation/mod.rs` — index update on donate
**Tests:** Unit test for paginated donor history, gas benchmark comparison vs N+1 approach
**Storage:** Adding a per-donor index increases storage writes per donation by 1 entry — document the gas impact.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #015 — All Contracts: Add comprehensive fuzz testing for cross-contract call sequences

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/testing`, `priority/high`, `effort/large`

Each contract has isolated fuzz tests (`escrow_fuzz.rs`, `fuzz_tests.rs` in indigopay and attestation), but no fuzz harness tests cross-contract call sequences: IndigoPay → Escrow (campaign escrow lifecycle), IndigoPay → Attestation (settlement), IndigoPay → Oracle (USDC donation pricing). Cross-contract bugs are the hardest class of Soroban vulnerabilities — state inconsistencies across contracts caused by partial failures, re-entrancy patterns, or mismatched state transitions. Implement a workspace-level fuzz harness that deploys all 4 contracts and exercises random sequences of cross-contract calls, asserting global invariants (e.g., sum of project balances across contracts matches total donated minus total withdrawn).

**Files:** New `contracts/cross_contract_fuzz.rs` or expanded `fuzz_tests.rs`
**Tests:** The harness itself IS the test — must run 10,000+ iterations of random sequences
**Invariants to check:** Global total consistency, escrow balance + project balance = donations, attestation settlement deduplication.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #016 — Backend: Implement adaptive webhook retry backoff with jitter and success-rate feedback

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/feature`, `priority/medium`, `effort/medium`

The webhook delivery system (`backend/src/services/webhookQueue.js`) uses a fixed 6-attempt backoff: 30s → 2m → 10m → 30m → 2h → 6h. This static schedule doesn't adapt to receiver behavior. A receiver that's consistently fast to recover gets the same backoff as one that's consistently slow, and a receiver that's permanently down ties up a pg-boss job slot for hours. Implement adaptive backoff: maintain a per-endpoint success-rate EMA, use shorter initial delays for historically reliable endpoints, and add configurable jitter (±20%) to avoid thundering-herd retries when many webhooks target the same receiver.

**Files:** `backend/src/services/webhookQueue.js`, `backend/src/services/webhook.js`
**Tests:** Unit test for jitter distribution, mock receiver with configurable failure rate, verify EMA-convergent behavior
**Config:** Expose `WEBHOOK_ADAPTIVE_ENABLED`, `WEBHOOK_JITTER_PCT`, `WEBHOOK_EMA_ALPHA` env vars.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #017 — Backend: Implement database connection pool metrics with per-query latency histograms

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/observability`, `priority/medium`, `effort/medium`

The backend uses `pg` (node-postgres) with a pool. While the Prometheus metrics at `/metrics` expose overall request latencies, there are no database-level metrics: pool utilization, idle connection count, waiting client count, or per-query-type latency histograms. The Grafana dashboard has a "Pool panels" section referenced in the burn-rate alert runbook, but those panels have no data source. Implement pg-pool metrics collection: expose `pool_total`, `pool_idle`, `pool_waiting` gauges and per-operation histograms (`db_query_duration_seconds` with `operation` label for SELECT/INSERT/UPDATE/DELETE) via the existing Prometheus metrics endpoint.

**Files:** `backend/src/services/metrics.js` (or new `backend/src/services/dbMetrics.js`), `backend/src/db/pool.js`
**Tests:** Verify metrics endpoint exposes pool gauges, verify histogram buckets cover p50/p95/p99 ranges
**Config:** `DB_METRICS_ENABLED`, `DB_METRICS_SAMPLE_RATE` env vars for production sampling.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #018 — Backend: Implement event-based cache invalidation instead of TTL-only for all read models

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/architecture`, `priority/high`, `effort/large`

The backend caching layer (`backend/src/services/cache.js`, `cacheManager.js`) uses TTL-based expiration exclusively. The documentation at `docs/api.md` mentions cache invalidation on project status changes, but multiple issues (like #016 in the old GrantFox list) revealed that invalidation is manual and inconsistent — new endpoints are added without updating invalidation logic. Implement a publish-subscribe cache invalidation system: mutation handlers publish invalidation events to Redis pub/sub channels, and cache subscribers listen for events to invalidate relevant keys. Every mutation endpoint should fire an invalidation event with affected resource types and IDs, and a single `invalidationRouter` maps resource types to cache key patterns.

**Files:** `backend/src/services/cacheManager.js` (rewrite with pub/sub), `backend/src/routes/*.js` (add invalidation events to all mutation handlers)
**Tests:** Integration test: create project → verify cache miss → update project → verify cache invalidated, subscription test with Redis pub/sub
**Migration:** Backward-compatible — if Redis pub/sub is unavailable, fall back to TTL-only with a warning log.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #019 — Backend: Add idempotent replay for the projection engine on partial failure during event processing

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/bug`, `priority/high`, `effort/medium`

The projection engine (`backend/src/services/projectionEngine.js`) processes events in a transaction: append event to `donation_events`, then update all 4 projections (`projection_donor_leaderboard`, `projection_project_stats`, `projection_donor_history`, `projection_global_stats`). If the transaction fails after appending the event but before updating one projection, the event is persisted but that projection is stale. The `rebuildAllProjections` recovery mechanism requires admin intervention. The `projection_lag_events` metric tracks this gap. Implement automatic catch-up: if `projection_lag_events > 0` at process startup or after a configurable idle period, the engine should automatically replay missed events into lagging projections without admin intervention.

**Files:** `backend/src/services/projectionEngine.js` — add auto-catch-up, `backend/src/services/sorobanEventService.js` — startup check
**Tests:** Simulate partial failure (mock one projection to throw), verify auto-catch-up restores consistency, verify `projection_lag_events` returns to 0
**Config:** `PROJECTION_AUTO_CATCHUP_ENABLED`, `PROJECTION_AUTO_CATCHUP_MAX_LAG` env vars.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #020 — Backend: Implement CSRF token rotation and binding to prevent replay attacks

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/security`, `priority/high`, `effort/medium`

The backend uses `csurf` middleware and has CSRF test coverage (`backend/src/routes/csrf.test.js`). However, CSRF tokens are single-use per session with no rotation — the same token works for the entire session lifetime. If a token is leaked (e.g., via `Referer` header in a cross-origin request), the attacker can use it for the session's duration. Implement token rotation: issue a new CSRF token after each successful validated request, binding each token to the specific HTTP method + path combination it was issued for. Store used tokens in Redis with a short TTL (5 minutes) to prevent replay of rotated tokens.

**Files:** `backend/src/middleware/csrf.js`, `backend/src/routes/csrf.test.js`
**Tests:** Unit test for token rotation, replay test (old token rejected after rotation), binding test (token for POST rejected on PUT)
**Security:** This is defense-in-depth — the primary CSRF defense is SameSite cookies, but token rotation prevents token-leak exploitation.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #021 — Backend: Implement graceful degradation for the CO₂ verification pipeline when external APIs are unavailable

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/reliability`, `priority/medium`, `effort/medium`

The CO₂ verification pipeline (`backend/src/services/co2Verifier.js`) queries Gold Standard, Verra, and Global Forest Watch APIs. If any of these APIs are down or rate-limited, the verification cron job (weekly, via pg-boss) fails silently for affected projects. The `co2_verification_runs` table records outcomes, but there's no retry logic, no partial-degradation mode, and no alert when a data source is persistently unavailable. Implement: (1) per-source circuit breakers with half-open probing, (2) fallback verification using only available sources with a `degraded: true` flag, (3) Prometheus counter `indigopay_co2_verification_source_errors` per source, (4) Alertmanager rule firing when any source has >3 consecutive failures.

**Files:** `backend/src/services/co2Verifier.js`, `backend/src/services/circuitBreaker.js`
**Tests:** Mock API failures, verify degraded verification still produces results, verify circuit breaker opens/closes correctly
**Config:** `CO2_VERIFIER_CIRCUIT_BREAKER_THRESHOLD`, `CO2_VERIFIER_CIRCUIT_BREAKER_TIMEOUT_MS` env vars.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #022 — Backend: Add database migration linting to CI for backward-incompatible changes

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/ci`, `priority/medium`, `effort/medium`

The backend has a `migration-policy.test.js` that validates migration naming conventions. However, there's no automated detection of backward-incompatible migration patterns: DROP COLUMN, RENAME COLUMN, changing a column type, removing a NOT NULL constraint — all of which can cause downtime or data loss during rolling deployments. Implement a migration linter (as a Jest test or standalone script) that parses SQL migration files and flags: (1) destructive operations (DROP, RENAME), (2) type changes that may lose data, (3) missing CONCURRENTLY on index creation, (4) missing IF NOT EXISTS on CREATE operations, (5) long-running operations without `lock_timeout` setting.

**Files:** `backend/__tests__/migration-policy.test.js` (extend), new `scripts/lint-migrations.js`
**Tests:** The linter IS the test — add sample bad migrations to verify detection
**CI:** Add `npm run migration:lint` step to `ci.yml` backend job.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #023 — Backend: Implement Redis sentinel/failover support for the caching and session layers

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/reliability`, `priority/high`, `effort/large`

The backend connects to Redis for caching, session storage, idempotency keys, and Socket.IO adapter. The Redis connection is configured via a single `REDIS_URL` environment variable with no sentinel, cluster, or failover support. If the Redis instance goes down, cache goes cold (performance degradation) and Socket.IO rooms disconnect (functional degradation — admin real-time features break). Implement Redis sentinel support: accept `REDIS_SENTINELS` (comma-separated host:port list) and `REDIS_SENTINEL_MASTER_NAME` env vars, configure `ioredis` with sentinel support, and handle sentinel failover events gracefully (log, emit metric, reconnect).

**Files:** `backend/src/services/redis.js`, `backend/src/config/env.js`
**Tests:** Integration test with `redis-memory-server` or dockerized sentinel cluster, verify automatic failover reconnection
**Config:** Backward-compatible — if `REDIS_SENTINELS` is not set, fall back to single-instance `REDIS_URL`.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #024 — Backend: Implement query plan analysis and slow-query detection with automatic EXPLAIN logging

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/performance`, `priority/medium`, `effort/medium`

The `analyticsQueryPlans.integration.test.js` suggests awareness of query performance, but production has no automated slow-query detection beyond PostgreSQL's `log_min_duration_statement`. Slow queries in the leaderboard (`GET /api/leaderboard`) or donation history (`GET /api/donations/project/:id`) degrade under load (the SLO requires p95 < 500ms). Implement a pg query wrapper that: (1) logs any query taking > `SLOW_QUERY_THRESHOLD_MS` (default 200ms) with the full query text and parameter values, (2) runs EXPLAIN ANALYZE on the query and logs the plan, (3) increments a Prometheus counter `db_slow_queries_total` with the query operation label, (4) samples 1% of fast queries to build a baseline latency histogram.

**Files:** `backend/src/db/queryWrapper.js` (new), `backend/src/db/pool.js` (integrate wrapper)
**Tests:** Mock slow query, verify EXPLAIN log output, verify metric increment
**Config:** `SLOW_QUERY_THRESHOLD_MS`, `SLOW_QUERY_SAMPLE_RATE` env vars.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #025 — Backend: Add OpenTelemetry distributed tracing across all backend service boundaries

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/observability`, `priority/medium`, `effort/large`

The backend uses Sentry for error tracking and Prometheus for metrics, but lacks distributed tracing. When a donation request takes 800ms (exceeding the p95 target), there's no way to trace which component contributed the latency: Stellar RPC, database query, webhook enqueue, projection update, or cache write. Implement OpenTelemetry tracing: instrument Express routes with auto-instrumentation, add manual spans for Stellar Horizon calls, pg-boss job enqueue/dequeue, Redis operations, and external API calls. Export traces to an OTLP-compatible collector (configurable endpoint). Preserve the existing `X-Request-Id` header as the trace ID for correlation with Pino logs.

**Files:** `backend/src/server.js` (add OTel middleware), `backend/src/services/stellar.js`, `backend/src/services/webhookQueue.js`, `backend/src/services/projectionEngine.js` — add spans
**Tests:** Verify span context propagation across async boundaries, verify trace ID matches X-Request-Id
**Config:** `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_SAMPLE_RATE` env vars.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #026 — Backend: Implement rate-limit aware request queuing with priority lanes for critical endpoints

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/performance`, `priority/medium`, `effort/medium`

The rate limiter (`backend/src/middleware/rateLimiter.js`) returns 429 when limits are exceeded — the client must retry. For donation recording (`POST /api/donations`), a 429 means the donor's transaction hash may not be recorded, requiring a retry (supported by the `Idempotency-Key` header). During high-traffic events (campaign launches, matching rounds), the rate limiter becomes a hard wall. Implement a request queuing system: when rate limit is approaching (e.g., 80% consumed), subsequent requests are placed in a priority queue with configurable timeout instead of being rejected. Critical endpoints (donations) get higher priority than non-critical (leaderboard, profile reads). Requests that time out in the queue still get a 429, but most complete within the rate limit window.

**Files:** `backend/src/middleware/rateLimiter.js`, new `backend/src/services/requestQueue.js`
**Tests:** Load test simulating rate limit approach, verify queued requests succeed, verify priority ordering
**Config:** `RATE_LIMIT_QUEUE_ENABLED`, `RATE_LIMIT_QUEUE_TIMEOUT_MS`, `RATE_LIMIT_QUEUE_MAX_SIZE` env vars.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #027 — Backend: Add audit-chain verification endpoint for external integrity checking

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/feature`, `priority/medium`, `effort/medium`

The audit chain (`backend/src/services/auditChain.js`) creates a hash chain for database rows: each row's hash includes the previous row's hash, creating a tamper-evident log. The `auditRetention` service manages retention. However, there's no public endpoint for external parties to verify the chain's integrity. A third-party auditor cannot independently confirm that the chain hasn't been tampered with without direct database access. Implement `GET /api/audit/verify/:table` and `GET /api/audit/chain/:table?from=X&to=Y` endpoints that return chain segments with hashes, allowing anyone to recompute and verify the hash chain's integrity.

**Files:** `backend/src/routes/admin.js` or new `backend/src/routes/audit.js`, `backend/src/services/auditChain.js`
**Tests:** Verify chain segment integrity, verify tampered chain detection, verify pagination
**Security:** Audit endpoints must be rate-limited but do NOT require authentication (public verifiability is the point).

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #028 — Backend: Implement connection pooling and retry logic for the Stellar Horizon/Soroban RPC client

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/reliability`, `priority/high`, `effort/medium`

The `backend/src/services/stellar.js` service calls Horizon and Soroban RPC endpoints. During network congestion or RPC provider issues, requests can hang or fail with 5xx errors. There's no connection pooling, no retry with backoff for transient failures, and no circuit breaker. A single slow RPC call blocks the donation recording pipeline (Horizon transaction submission), causing cascading latency spikes. Implement: (1) connection pooling with configurable max sockets, (2) automatic retry with exponential backoff for 5xx and network errors (max 3 attempts), (3) circuit breaker that opens after N consecutive failures and half-opens after a cooldown period, (4) Prometheus metrics for RPC call latency/errors per endpoint.

**Files:** `backend/src/services/stellar.js`, `backend/src/services/circuitBreaker.js`
**Tests:** Mock RPC failures, verify retry/backoff, verify circuit breaker opens/closes, verify metrics
**Config:** `STELLAR_RPC_MAX_RETRIES`, `STELLAR_RPC_RETRY_BACKOFF_MS`, `STELLAR_RPC_CIRCUIT_BREAKER_THRESHOLD` env vars.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #029 — Backend: Add comprehensive input sanitization middleware for all text fields across all endpoints

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/security`, `priority/medium`, `effort/medium`

The Zod schemas validate types and lengths but don't sanitize against injection or XSS vectors: Unicode homoglyph attacks (confusable characters), bidirectional text override characters (U+202E), zero-width joiners, HTML/JavaScript fragments in text fields that could be stored and later rendered by the frontend. The donation message field was partially addressed, but project names, descriptions, profile bios, and update bodies all accept arbitrary Unicode. Implement a shared `sanitize` Zod transform that: (1) strips bidirectional control characters, (2) normalizes Unicode to NFC, (3) strips HTML tags from plain-text fields, (4) truncates at the schema-defined max length rather than rejecting.

**Files:** `backend/src/validators/schemas.js` — add `.transform(sanitize)` to all text fields, new `backend/src/validators/sanitize.js`
**Tests:** Unit tests for each sanitization rule, verify NFC normalization, verify HTML stripping
**Security:** The sanitization must be applied server-side even if the frontend also sanitizes — defense in depth.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #030 — Backend: Implement pg-boss job dead-letter queue monitoring and automatic reprocessing

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/reliability`, `priority/medium`, `effort/medium`

pg-boss dead-letter queues accumulate failed jobs (webhook deliveries, AI summaries, profile enrichment, CO₂ verification, digest generation). The `webhookQueue` worker has a DLQ, and the `indexerDLQWorker.js` handles indexer dead letters, but there's no unified DLQ monitoring, no automatic reprocessing strategy, and no alert when the DLQ grows beyond a threshold. Implement: (1) a `GET /api/admin/queue/dlq` endpoint listing all DLQ entries across all queues with age, retry count, and error message, (2) `POST /api/admin/queue/dlq/reprocess` to manually retry specific failed jobs, (3) a Prometheus gauge `pgboss_dlq_size` per queue, (4) an Alertmanager rule when any DLQ exceeds 50 entries.

**Files:** `backend/src/services/queueMetrics.js` (extend), `backend/src/routes/admin.js` (add DLQ endpoints)
**Tests:** Verify DLQ listing, reprocessing, and metric emission
**Config:** `PGBOSS_DLQ_ALERT_THRESHOLD` env var.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #031 — Frontend: Implement Service Worker with offline-first donation queue and background sync

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/feature`, `priority/high`, `effort/large`

The frontend requires an active internet connection to sign and submit Stellar transactions. If a donor is in a low-connectivity area (common for the climate projects the platform serves), they cannot donate. Implement a Service Worker with: (1) offline page caching for the project browse/dashboard shell, (2) a donation queue stored in IndexedDB that holds unsigned transaction parameters, (3) Background Sync API integration to submit queued donations when connectivity returns, (4) push notification when a queued donation is confirmed on-chain. The user builds the donation (amount, project, anonymous flag) offline, the SW queues it, and when online, it prompts the user to sign in Freighter (which also works offline for signing).

**Files:** `frontend/public/sw.js` (new), `frontend/lib/offlineQueue.ts` (new), `frontend/pages/_app.tsx` (register SW)
**Tests:** E2E test with Playwright: simulate offline → queue donation → go online → verify submission
**Security:** Queued donations must not store private keys. The SW must only store unsigned transaction parameters.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #032 — Frontend: Implement virtualized donation feed with infinite scroll and cursor-based pagination

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/performance`, `priority/medium`, `effort/medium`

The donation feed (real-time ticker on the landing page and project pages) renders all visible donations as DOM nodes. Socket.IO events push new donations in real-time, and the feed grows without bound during a session. For a popular project with 5,000+ donations during a campaign, the DOM node count causes scroll jank and memory pressure. Implement: (1) `react-window` or `@tanstack/virtual` for virtualized list rendering, (2) cursor-based pagination from the API (already supported by `GET /api/donations/project/:id?cursor=`), (3) infinite scroll that loads older pages as the user scrolls up, (4) real-time items appended at the top without disrupting scroll position.

**Files:** `frontend/components/DonationFeed.tsx`, `frontend/hooks/useDonationFeed.ts`
**Tests:** Unit test for virtual list rendering, E2E test for infinite scroll loading
**A11y:** Ensure virtualized list is keyboard-navigable and screen-reader accessible.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #033 — Frontend: Add end-to-end encryption for donation message field using recipient's public key

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/feature`, `priority/medium`, `effort/medium`

Donation messages are stored in plaintext in the backend database and are publicly visible in the donation feed. Donors who want to send a private message to the project owner (e.g., personal encouragement, contact information) have no option to do so privately. Implement optional message encryption: when the donor checks "Private message", the frontend encrypts the message using the project wallet's Stellar public key via `nacl.box` (Curve25519-XSalsa20-Poly1305), stores the ciphertext in the `message` field with an `encrypted: true` flag, and only the project wallet owner (who holds the corresponding secret key) can decrypt it. Non-encrypted messages work as before.

**Files:** `frontend/lib/encryption.ts` (new), `frontend/components/DonationForm.tsx`, `frontend/hooks/useDonationMessage.ts`
**Tests:** Unit test for encrypt/decrypt roundtrip, verify ciphertext format, verify backward compatibility with plaintext messages
**Security:** The encryption key is the project's public key — only the project wallet can decrypt. The donor does not need the project's secret key.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #034 — Frontend: Implement comprehensive keyboard navigation and screen-reader accessibility audit pass

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/accessibility`, `priority/high`, `effort/large`

The frontend has `@axe-core/playwright` integrated in E2E tests and `jest-axe` for unit-level accessibility checks. However, the existing tests only catch ~30% of WCAG 2.1 AA violations. Missing coverage areas: (1) focus management during route transitions (Next.js client-side navigation doesn't announce page changes), (2) keyboard trap prevention in modals and drawers, (3) skip-to-content link, (4) ARIA labels on dynamically-updated content (real-time donation ticker, leaderboard), (5) color contrast in dark mode, (6) focus indicators on interactive elements, (7) form error announcement via `aria-live` regions. Implement a systematic audit: add `@axe-core/playwright` to every E2E test page, fix all violations, add a `a11y-nightly.yml` CI workflow that runs axe against all pages.

**Files:** `frontend/components/**/*.tsx`, `frontend/pages/**/*.tsx`, `frontend/e2e/**/*.spec.ts`, `.github/workflows/a11y-nightly.yml`
**Tests:** Extend existing Playwright tests with `axe` checks on every page, add keyboard navigation E2E tests
**CI:** `a11y-nightly.yml` runs full accessibility scan weekly, blocks PRs on new critical violations.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #035 — Frontend: Implement IndexedDB-backed optimistic UI with server state reconciliation for all mutation endpoints

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/performance`, `priority/medium`, `effort/large`

The frontend uses a mix of `useEffect` + `fetch` for server state with no optimistic updates and no offline support beyond what the browser cache provides. For the donation flow: the user signs in Freighter → transaction is submitted to Stellar → frontend calls `POST /api/donations` to record it → waits for 201 → updates UI. This means a 2-3 second delay between clicking "Donate" and seeing the confirmation. Implement a state management layer using `@tanstack/react-query` with: (1) optimistic mutation updates (show donation in feed immediately, rollback on error), (2) IndexedDB persistence for offline resilience, (3) automatic background refetch on window focus, (4) mutation retry with exponential backoff.

**Files:** New `frontend/lib/queryClient.ts`, update all data-fetching hooks in `frontend/hooks/`, update mutation callers in components
**Tests:** Unit test for optimistic update + rollback, E2E test for offline → online flow
**Migration:** Incremental — convert one endpoint at a time, starting with donations.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #036 — Mobile: Implement biometric-secured transaction signing with Secure Enclave/Keystore integration

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/mobile`, `type/security`, `priority/high`, `effort/large`

The mobile app uses `expo-secure-store` for storing sensitive data and `useBiometricAuth` for authentication. However, Stellar transaction signing still happens in JavaScript using the `stellar-sdk` Keypair class — meaning the secret key must be loaded into JS memory to sign. On a compromised or jailbroken device, this secret key is extractable. Implement hardware-backed signing: store the Stellar secret key in the iOS Secure Enclave or Android Keystore (via `expo-crypto` or native module), and perform Ed25519 signing inside the hardware security module so the secret key never enters JavaScript memory. The `useBiometricAuth` hook should gate access to the signing operation.

**Files:** `mobile/lib/secureStore.ts`, `mobile/lib/stellarSigner.ts` (new), `mobile/hooks/useBiometricAuth.ts`
**Tests:** Verify signing succeeds with valid biometric, verify signing fails with invalid biometric, verify secret key never appears in JS heap
**Security:** This is the highest-impact security improvement for the mobile surface — it eliminates the JS-memory attack vector for key extraction.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #037 — Mobile: Add offline transaction building and QR-based air-gapped signing for low-connectivity areas

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/mobile`, `type/feature`, `priority/medium`, `effort/medium`

The mobile app targets donors in regions where internet connectivity is intermittent (rural areas near climate projects). Currently, donations require an active connection to Horizon for account sequence number lookup and transaction submission. Implement offline transaction building: (1) cache the account sequence number and latest ledger, (2) allow building and signing transactions offline, (3) generate a QR code containing the signed transaction XDR, (4) provide a "Submit Later" queue that submits when connectivity returns. This pairs with the browser extension's ability to scan QR codes for wallet-address detection, enabling a fully offline → online donation flow.

**Files:** `mobile/lib/offlineTx.ts` (new), `mobile/app/scan.tsx`, `mobile/components/QRDonation.tsx`
**Tests:** Build transaction offline, verify XDR is valid, simulate online submission, verify sequence number sync
**Edge cases:** Sequence number staleness (account made another transaction while offline → tx rejected, must retry with new sequence).

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #038 — Mobile: Implement deep-link routing for all donation flows with universal link fallback

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/mobile`, `type/feature`, `priority/medium`, `effort/medium`

The mobile app uses `expo-router` for file-based navigation and supports deep links for wallet connections (`freighter://tx?xdr=...`). However, project donation deep links (e.g., `indigopay://donate/project-001?amount=100`) are not implemented. A donor scanning a project QR code on a poster at a climate event should be taken directly to the donation screen with the project pre-selected. Implement: (1) `indigopay://donate/:projectId` deep link with optional `?amount=X` query param, (2) `indigopay://project/:projectId` to open the project detail page, (3) universal link (`https://stellarindigopay.com/donate/:projectId`) as fallback for devices without the app installed, (4) `app.json` configuration for associated domains.

**Files:** `mobile/app/donate/[projectId].tsx` (new), `mobile/app.config.ts`, `mobile/.well-known/apple-app-site-association` (new)
**Tests:** Deep link integration test, verify pre-filled amount, verify fallback to web
**Documentation:** Update `docs/mobile-pinning.md` with deep link URL scheme.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #039 — Extension: Add content-security-policy compliance and remove inline scripts for Manifest V3

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/extension`, `type/security`, `priority/high`, `effort/medium`

The Chrome Web Store now enforces stricter Manifest V3 CSP requirements. The extension's `manifest.json` specifies `manifest_version: 3` but the popup HTML (`popup.html`) may contain inline scripts or event handlers that violate CSP. The Firefox manifest (`manifest.firefox.json`) has different CSP rules. Implement: (1) audit all HTML files for inline scripts and event handlers (`onclick`, `onload`), (2) move all logic to bundled JS files loaded via `<script src="...">`, (3) add a strict CSP to both manifests: `"content_security_policy": { "extension_pages": "script-src 'self'; object-src 'none'" }`, (4) verify the extension passes Chrome Web Store review requirements.

**Files:** `extension/popup.html`, `extension/settings.html`, `extension/manifest.json`, `extension/manifest.firefox.json`, `extension/src/`
**Tests:** CSP validation test (parse manifest, verify no inline-script allowances), E2E test in browser environment
**CI:** Add CSP lint step to `extension.yml` workflow.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #040 — Extension: Implement configurable donation presets with keyboard shortcuts for power users

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/extension`, `type/feature`, `priority/low`, `effort/small`

The extension popup currently requires the user to enter a custom amount for each donation. Power users (repeat donors) would benefit from configurable preset amounts with keyboard shortcuts. Implement: (1) settings page with 4 configurable preset amounts (stored in `chrome.storage.sync`), (2) popup UI showing preset buttons (e.g., "10 XLM", "50 XLM", "100 XLM", "Custom"), (3) keyboard shortcuts: Ctrl+1 through Ctrl+4 for presets, Enter to confirm, (4) a "Quick Donate" mode that sends the default preset in one click when a Stellar address is detected on the current page.

**Files:** `extension/src/popup.ts`, `extension/src/settings.ts`, `extension/settings.html`, `extension/popup.html`
**Tests:** Unit test for preset storage/retrieval, E2E test for keyboard shortcut behavior
**UX:** Presets must be clearly labeled with XLM amounts and approximate fiat values.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #041 — CI/CD: Implement automated canary deployment analysis with Prometheus metrics comparison

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/devops`, `type/feature`, `priority/high`, `effort/large`

The gitops configuration (`gitops/argo-rollouts-canary.yaml`) sets up Argo Rollouts for canary deployments with Prometheus success-rate analysis. However, the analysis template is not actually configured — the file references a non-existent `AnalysisTemplate`. Implement: (1) an `AnalysisTemplate` resource that queries Prometheus for error rate and p95 latency of the canary vs stable pods over a 10-minute window, (2) automated rollback if the canary's error rate exceeds 1.5x the stable baseline or p95 latency increases by >20%, (3) a Grafana dashboard panel showing canary-vs-stable metrics side-by-side during rollout, (4) Slack notification on canary promotion or rollback.

**Files:** `gitops/argo-rollouts-canary.yaml`, new `gitops/analysis-template.yaml`, `monitoring/recording-rules.yml` (add canary-specific rules)
**Tests:** Dry-run validation with `helm template`, manual canary test on staging
**Dependencies:** Prometheus must already be scraping per-pod metrics with pod name labels.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #042 — CI/CD: Add SBOM vulnerability scanning with severity-based CI gating

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/devops`, `type/security`, `priority/high`, `effort/medium`

The `.github/workflows/sbom.yml` workflow generates an SBOM and the `.github/workflows/image-scan.yml` runs Trivy, but there's no CI gate based on vulnerability severity. A critical CVE in a base image or npm dependency can be merged and deployed without blocking CI. Implement: (1) Trivy scan with `--severity CRITICAL,HIGH --exit-code 1` in the CI pipeline, (2) a `.trivyignore` file with documented exceptions for false positives or accepted risks, (3) a weekly SBOM diff job that compares the current SBOM against the previous release and flags new dependencies, (4) automated GitHub issue creation for new CRITICAL CVEs (using a GitHub Actions workflow).

**Files:** `.github/workflows/image-scan.yml`, `.github/workflows/sbom.yml`, `.trivyignore`
**Tests:** Verify CI fails on critical CVE, verify `.trivyignore` exceptions work
**Process:** New CVEs in the `.trivyignore` file must be reviewed and approved in PR.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #043 — CI/CD: Implement contract deployment verification with post-deploy invariant checks on testnet

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/devops`, `type/testing`, `priority/medium`, `effort/medium`

The `.github/workflows/contract-deploy.yml` workflow deploys contracts to testnet but does not verify post-deployment correctness beyond checking the deploy transaction succeeded. There's no automated verification that: (1) the deployed WASM hash matches the build artifact, (2) `initialize` was called with the correct admin set, (3) `register_project` succeeds, (4) `donate` succeeds and emits the expected event, (5) `get_global_stats` returns zero-state values. Implement a post-deploy verification script that runs a smoke-test sequence against the freshly deployed contract, asserting each step's outcome and event emissions.

**Files:** `.github/workflows/contract-deploy.yml`, new `scripts/verify-deployment.sh`
**Tests:** The verification script IS the test.
**CI:** Runs automatically after `contract-deploy.yml` deployment step, fails the workflow if verification fails.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #044 — CI/CD: Add k6 load test results to CI as a PR comment with regression detection

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/devops`, `type/ci`, `priority/medium`, `effort/medium`

The `scripts/load-test.js` k6 script enforces p95 < 500ms as a hard threshold. However, the load test only runs manually or in a CI smoke test (10 VUs, 10s). There's no automated regression detection: a PR that increases p50 from 82ms to 150ms (still below the 500ms threshold) would be merged without flagging the 83% degradation. Implement: (1) a nightly load test run (100 VUs, 60s) that posts results as a JSON artifact, (2) a PR workflow that compares current load test results against the `main` branch baseline and posts a PR comment with the diff, (3) a `LATENCY_REGRESSION_THRESHOLD_PCT` config (default 20%) — PRs exceeding this threshold get a warning comment but are not blocked.

**Files:** `.github/workflows/ci.yml` (add nightly load test job), new `.github/workflows/perf-regression.yml`
**Tests:** Verify regression comment appears on PR, verify baseline comparison logic
**Data:** Store baseline results as a GitHub Release artifact or in a dedicated `perf-results` branch.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #045 — CI/CD: Implement database restore drill with data integrity checksum validation

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/devops`, `type/reliability`, `priority/high`, `effort/medium`

The `.github/workflows/restore-drill.yml` workflow runs monthly and asserts row counts after restore. Row counts alone don't catch silent data corruption — a restore that truncates all `TEXT` columns to empty strings would pass the row count check. Implement: (1) a `pg_dump` checksum: compute SHA-256 of sorted, canonical-form row data for critical tables (donations, projects, donation_events) during backup, (2) during the restore drill, recompute checksums and compare against the backup checksum, (3) if any checksum mismatches, fail the drill and alert via the existing `RestoreDrillFailed` Alertmanager rule, (4) add a `restore_drill_checksum_mismatch` Prometheus gauge.

**Files:** `.github/workflows/restore-drill.yml`, `.github/workflows/database-backup.yml`, new `scripts/verify-restore-checksum.sh`
**Tests:** Intentional corruption test (alter one row after restore), verify checksum mismatch detection
**Metrics:** `restore_drill_checksum_mismatch` gauge (0 = passed, 1 = failed).

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #046 — Monitoring: Add synthetic transaction monitoring with on-chain donation simulation

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/monitoring`, `type/observability`, `priority/high`, `effort/large`

All existing monitoring (Prometheus metrics, Sentry errors, Alertmanager rules) is passive — it observes real user traffic. There's no synthetic monitoring that proactively verifies the end-to-end donation flow. If all real users are sleeping (off-peak hours) and the Soroban RPC goes down, the first alert fires when the first real donation fails — potentially hours later. Implement a synthetic monitoring agent: (1) a dedicated Stellar testnet account with pre-funded XLM, (2) a cron job (every 5 minutes) that executes a full donation flow (build tx → sign → submit → verify on-chain event → verify backend recording), (3) Prometheus gauge `synthetic_donation_success` (1 = last attempt succeeded, 0 = failed), (4) `synthetic_donation_duration_seconds` histogram, (5) Alertmanager rule firing if 2 consecutive synthetic checks fail.

**Files:** New `scripts/synthetic-monitor.js`, `monitoring/alert-rules.yml` (new alert), `.github/workflows/synthetic-monitor.yml`
**Tests:** Verify synthetic donation succeeds end-to-end, verify alert fires on failure
**Security:** The synthetic donor account must be funded automatically from a faucet or pre-funded pool.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #047 — Monitoring: Implement business-level metrics dashboard: donation volume, project health, donor retention

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/monitoring`, `type/observability`, `priority/medium`, `effort/medium`

The existing Grafana dashboards focus on infrastructure (CPU, memory, request latency, error rates). There's no business-level visibility: daily donation volume by project, donor retention cohort analysis, conversion rate (wallet-connect → donation), project health scores, AI summary generation costs, or CO₂ offset totals by category. Implement: (1) Prometheus recording rules that pre-compute business metrics from the PostgreSQL projection tables (exposed via a metrics SQL query), (2) a new "Business Overview" Grafana dashboard with panels for daily/monthly donation volume, active donors, top projects, retention cohorts, (3) a `business_metrics_exporter` cronjob that runs queries and exposes results as Prometheus gauges.

**Files:** `monitoring/recording-rules.yml` (new rules), new `scripts/business-metrics-exporter.js`, new Grafana dashboard JSON
**Tests:** Verify metric values match database queries, verify dashboard renders
**Data sensitivity:** Aggregate metrics only — no individual donor data exposed in Prometheus.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #048 — Docs: Add formal specification for all contract state invariants with Kani verification

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/testing`, `priority/high`, `effort/large`

The Kani formal verification scaffold exists at `contracts/indigopay-contract/verification/kani/` with CI integration in `.github/workflows/contracts.yml`. However, the harness only verifies basic arithmetic properties — it doesn't verify contract-level state invariants. Document and verify: (1) `GlobalTotalRaised == sum(project.total_raised for all projects)` invariant, (2) `DonationCount == number of DonationRecord entries` invariant, (3) badge monotonicity (badge tier never decreases), (4) project count consistency (`ProjectCount == ProjectIds.len()`), (5) escrow balance consistency (contract token balance >= sum of unreleased milestone amounts). Each invariant must be expressed as a Kani proof harness.

**Files:** `contracts/indigopay-contract/verification/kani/` — new harness files, `contracts/indigopay-contract/VERIFICATION.md` — update with invariants
**Tests:** `cargo kani --harness invariant_global_total` etc.
**CI:** Kani verification already runs in `contracts.yml` — add the new harnesses.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #049 — Cross-cutting: Implement end-to-end encryption key rotation for webhook signing secrets

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/security`, `priority/high`, `effort/medium`

Webhook delivery signs payloads with HMAC-SHA256 using `signingSecretProvider` (`backend/src/services/signingSecretProvider.js`). The secret rotation workflow exists (`.github/workflows/secret-rotation.yml`) but only rotates Kubernetes secrets — there's no multi-version secret support in the signing provider itself. During rotation, there's a window where the old secret's signatures are no longer valid but the new secret hasn't propagated to all webhook receivers. Implement: (1) dual-version signing: sign with both current and previous secret, include a `kid` (key ID) header in the signature, (2) multi-version verification: accept signatures from the current, previous, and next secrets (3-version window), (3) `GET /api/webhooks/keys` endpoint for receivers to discover active key IDs, (4) automatic key version expiry after rotation + 7-day grace period.

**Files:** `backend/src/services/signingSecretProvider.js`, `backend/src/services/webhook.js`, `.github/workflows/secret-rotation.yml`
**Tests:** Verify dual-version signing, verify verification with previous secret, verify key rotation with 3-version window
**Security:** The previous secret must be securely deleted after the grace period — implement via Kubernetes Secret update + pod restart.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

## Issue #050 — Cross-cutting: Add comprehensive fuzz testing for the backend API with automatic OpenAPI schema conformance

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/testing`, `priority/high`, `effort/large`

The backend has 1,069 unit tests with 99.5% coverage, but no fuzz testing of the API layer. Edge cases in request parsing, parameter validation, concurrent request handling, and error-recovery paths are untested. Implement a fuzz testing framework: (1) parse the OpenAPI spec at `docs/api/openapi.yaml` to extract endpoint schemas, (2) generate random valid and invalid requests for each endpoint (including edge cases: max-length strings, boundary numbers, Unicode, missing required fields, extra unknown fields, concurrent identical requests), (3) verify that all responses conform to the OpenAPI response schema, (4) verify that no 5xx errors occur for invalid input (should be 4xx), (5) run as a Jest test suite with 10,000+ iterations per endpoint, integrated into CI.

**Files:** New `backend/__tests__/fuzz/` directory with fuzz harnesses, `scripts/validate-openapi.js` (extend with fuzz mode)
**Tests:** The fuzz harness IS the test suite — must catch at least one real bug before merging.
**CI:** Run a fast subset (100 iterations) in PR CI, full run (10,000 iterations) nightly.

---

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

