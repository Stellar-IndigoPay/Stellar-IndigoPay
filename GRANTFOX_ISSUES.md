# GrantFox OSS — 50 High-Value Implementation-Ready GitHub Issues

> Generated from direct inspection of the Stellar-IndigoPay codebase: all 4 Soroban contracts (17,499-line IndigoPay lib.rs with 137 error codes and 16 feature gates), escrow (milestone escrow, M-of-N governance, reputation), attestation (cross-chain bridge, batch record), oracle (TWAP with stake/slash, median-of-medians), the event-sourcing backend (projection engine with staged atomic rebuild), webhook delivery, AI summary pipeline, Horizon SSE + Soroban RPC indexers with DLQ, CO2 verification, Turrets donation matching, DSR export/erasure, recurring donation keeper, and the Kubernetes/Helm/ArgoCD/Prometheus production infrastructure. Every issue targets a genuine technical gap, security concern, or production-readiness requirement verified in the code.

---

## Issue #001 — IndigoPay: Migrate `Events::publish` to `#[contractevent]` pattern across all 4 contracts

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/architecture`, `priority/high`, `effort/large`

### Summary
All four Soroban contracts use the deprecated `env.events().publish()` API with `#![allow(deprecated)]` at the crate root. The `#[contractevent]` macro provides type-safe event emission with automatic XDR schema generation and structured topic indexing. The TODO `indigopay-272` at `contracts/indigopay-contract/src/lib.rs` line 4 has tracked this for over a year. Every contract suppresses the deprecation warning; 310+ total events use ad-hoc `symbol_short!()` topic strings.

### Problem Statement
1. **Deprecation risk**: The deprecated API may be removed in a future soroban-sdk release, blocking SDK upgrades.
2. **Type unsafety**: Manual tuple construction means adding or reordering event fields is a silent runtime bug — indexers receive garbled data with no compile error.
3. **Duplicate topic risk**: Two events using the same `symbol_short!()` string would silently collide and corrupt indexer data.
4. **310 total events** across 4 contracts — manual topic management is unsustainable.

### Objectives
- Replace all `env.events().publish(...)` calls with `#[contractevent]` structs and `env.events().publish(&event)`
- Remove `#![allow(deprecated)]` from each contract's crate root
- Update `contracts/EVENTS.md` to reflect the new `#[contractevent]` discriminants
- Ensure all existing event tests continue to pass (event count, topic names, data fields)

### Scope
**In Scope**
- `contracts/indigopay-contract/src/lib.rs` — all event emission sites
- `contracts/escrow-contract/src/lib.rs` — all event emission sites
- `contracts/attestation-contract/src/lib.rs` — all event emission sites
- `contracts/oracle-contract/src/lib.rs` — all event emission sites
- `contracts/EVENTS.md` — update event topic table
- Test modules in all 4 contracts — update event assertions

**Out of Scope**
- Changing event data payloads (keep identical)
- Adding new events
- Backend indexer changes (`sorobanEventService` already deserializes raw event data generically)

### Implementation Plan
1. Define one `#[contractevent]` struct per existing event (e.g., `DonatedEvent`, `NftMintEvent`, `ProjectRegisteredEvent`)
2. Replace each `env.events().publish((topic, ...), (data, ...))` with `env.events().publish(&EventName { ... })`
3. Run `cargo build --workspace --target wasm32v1-none --release` and verify no size regression against the 64 KB CI limit
4. Run `cargo test --features testutils --workspace` and fix any event assertion breakage
5. Run `cargo clippy --workspace -- -D warnings` and confirm no new warnings

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

### Deliverables
- Single PR touching all 4 contracts
- Changelog entry under `[Unreleased]`

### References
- `contracts/indigopay-contract/src/lib.rs` line 3-5 (`#![allow(deprecated)]`, TODO comment)
- `contracts/EVENTS.md`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #002 — IndigoPay: Implement batched storage TTL extension with `bump_ttl` and `get_ttl_stats` entrypoints

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/high`, `effort/large`

### Summary
Soroban persistent storage entries have a Time-To-Live (TTL) measured in ledgers. When TTL expires, the network archives the entry. The IndigoPay contract has ~40 `DataKey` variants, many storing persistent data (donation records, project data, donor stats, governance proposals, vesting schedules, refund requests, attestation settlements, ZK nullifiers). There is no systematic TTL extension mechanism beyond the existing `extend_all_ttl` entrypoint (which calls `ensure_min_ttl` on every key — a full scan that does not fit in a per-transaction resource budget for a grown contract). The `docs/gas-optimization.md` "Further Optimization Opportunities" section lists "Batched TTL extension" as a long-term item. `ZK_STORAGE_TTL_LEDGERS` (6,307,200 ledgers ≈ 1 year) demonstrates TTL awareness but only addresses the ZK nullifier case.

### Problem Statement
1. **Silent data loss**: After the default TTL, critical on-chain data (donation history, project registrations, governance proposals) becomes unreadable.
2. **No automated recovery**: No internal mechanism bumps TTLs during normal operation.
3. **Operator burden**: Every deployment requires an external cron/keeper to submit TTL extension transactions.
4. **`extend_all_ttl` does not scale**: it iterates every persistent key in one invocation, which exceeds Soroban's per-transaction resource budget once the contract has meaningful data.

### Objectives
- Implement a `bump_ttl(from: u32, count: u32)` entrypoint that extends the TTL of `count` persistent storage entries starting at index `from`, using a deterministic iteration order over `DataKey` variants
- Add `get_ttl_stats()` returning total persistent entries and the ledger at which the earliest entry expires
- Implement a "lazy bump" pattern: each state-mutating function bumps the TTL of the entries it touches during normal operation (amortized, zero additional transactions)

### Scope
**In Scope**
- New `bump_ttl` and `get_ttl_stats` entrypoints in IndigoPay contract
- Lazy TTL bump in `donate`, `register_project`, `vote_on_proposals`, `create_vesting_schedule` (via `donate_vested`), and other high-frequency mutators
- Unit tests verifying TTL extension
- Update `docs/gas-optimization.md` with benchmark data

**Out of Scope**
- TTL extension for companion contracts (escrow, attestation, oracle) — separate issues
- Off-chain keeper implementation (that is a backend service task)

### Implementation Plan
1. Add a `DataKey` iterator helper that yields all variant discriminants in a fixed order
2. Implement `bump_ttl(env, from, count)` — iterate from `from` for `count` entries, call `env.storage().persistent().extend_ttl(&key, threshold, extend_to)` on each
3. Implement `get_ttl_stats(env)` — scan all persistent keys, find minimum TTL, return `(total_entries, min_ttl_ledger, current_ledger)`
4. Add a `ttl_bump` event with `(from, count, extended_count)`
5. In `donate` and other hot paths, after writing persistent data, bump the specific keys just written
6. Benchmark and document the gas cost per entry and estimate batch sizes that fit within Soroban's per-transaction budget

### Acceptance Criteria
- `bump_ttl` extends TTL of the requested number of entries; `get_ttl_stats` returns accurate `(total, min_ttl)` data
- Lazy bump keeps recently-touched entries alive without separate transactions
- `cargo test --features testutils -p indigopay-contract` passes (new + existing)
- Gas benchmarks documented for batch sizes 10, 50, 100

### Testing Requirements
- Unit tests: bump 0 entries (no-op), bump within range, bump beyond range (panic), verify TTL after bump
- Integration test: create donation → verify TTL extended on donation record

### References
- `docs/gas-optimization.md` — "Further Optimization Opportunities" section
- `contracts/indigopay-contract/src/lib.rs` — `ZK_STORAGE_TTL_LEDGERS`, `DataKey` enum, `extend_all_ttl`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #003 — IndigoPay: Add donation message length cap and Unicode-normalization validation to bound event payloads

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/security`, `priority/medium`, `effort/small`

### Summary
`process_donation_token` emits the donation `msg_hash` (a u32 hash of the message) rather than the raw message, which bounds payload size. However the message-hashing path is inconsistent across the multi-token entrypoints: `donate_asset` and `donate_token` derive the hash from arbitrary-length `String` inputs, and `MAX_CHALLENGE_REASON_LEN` (200 bytes) bounds only challenge reasons, not donation messages. A donor can pass a maximally long message string that is hashed on-chain — the hash is constant-size, but the input string is read and hashed inside the contract, consuming CPU instructions and memory per byte with no upper bound enforced at the entrypoint.

### Problem Statement
1. **Unbounded input processing**: long message strings are hashed inside the contract; the cost is linear in message length with no documented cap.
2. **Inconsistent limits**: some entrypoints hash the message, others truncate before hashing; there is no single policy.
3. **Indexer ambiguity**: `msg_hash` is a u32; two different messages can collide (birthday bound ~2^16 with 10k donations) making the hash unsuitable as a message identity.

### Objectives
- Enforce a single `MAX_DONATION_MSG_LEN` cap (e.g. 140 bytes) applied consistently across all donate entrypoints before hashing
- Normalize message input (trim, reject control characters) so identical visible messages hash identically
- Document the `msg_hash` collision caveat in `contracts/EVENTS.md`

### Scope
- `contracts/indigopay-contract/src/lib.rs` — all donate entrypoints and the shared message-hash helper
- `contracts/EVENTS.md` — document `msg_hash` semantics

### Acceptance Criteria
- All donate paths enforce `MAX_DONATION_MSG_LEN` with a clear panic message
- Unit tests: boundary length, over-length rejection, control-character normalization
- No behavior change for existing valid messages

### References
- `contracts/indigopay-contract/src/lib.rs` — `process_donation_token`, `MAX_CHALLENGE_REASON_LEN`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #004 — Escrow: `claim_milestone` missing `job.freelancer == freelancer` verification (access-control gap)

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/security`, `priority/high`, `effort/small`

### Summary
`claim_milestone` at `contracts/escrow-contract/src/lib.rs` (~line 1062) calls `freelancer.require_auth()` but then checks `if job.freelancer != freelancer` — the check **was already added** in the current codebase. This issue tracks the **remaining** access-control gap in the same function family: `release_milestone` correctly checks `job.client == client`, and `claim_milestone` now checks `job.freelancer == freelancer`, but the deprecated job-level dispute functions (`dispute_job`, `resolve_dispute`) still use the older model and are documented in `docs/gas-optimization.md` as "remain callable but use the older job-level dispute model." Audit these legacy paths and either gate them with the same M-of-N admin checks used by `dispute_milestone`/`resolve_milestone_dispute` or remove them.

### Problem Statement
1. Legacy `dispute_job`/`resolve_dispute` may bypass the milestone-level access controls.
2. The escrow contract still has `#![allow(deprecated)]` and mixed governance models.

### Objectives
- Audit `dispute_job`, `resolve_dispute` and any other legacy entrypoints against the milestone-level equivalents
- Align their authorization with `require_admin` (M-of-N) or remove them with a documented deprecation path
- Add `#[should_panic]` tests for unauthorized callers on every remaining entrypoint

### Scope
- `contracts/escrow-contract/src/lib.rs` — legacy dispute paths, tests

### Acceptance Criteria
- No entrypoint mutates job state without matching the authorization of its modern equivalent
- Test coverage: wrong caller, insufficient admin signatures, disputed-state transitions

### References
- `contracts/escrow-contract/src/lib.rs` — `claim_milestone`, `dispute_job`, `resolve_dispute`, `docs/gas-optimization.md`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #005 — Oracle: Implement deviation-tolerance ramp to prevent TWAP deadlock during rapid market moves

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
The oracle contract's `report_price` deviation circuit breaker rejects any observation exceeding `max_deviation_bps` from the current TWAP. During rapid market movements (e.g. a 15% XLM price swing in minutes), all reporter observations get rejected because they all differ from the stale TWAP by more than the configured threshold. This creates a deadlock: the TWAP cannot update because new observations are rejected because they differ from the TWAP. The `OracleError::PriceDeviationExceedsThreshold` path has no recovery mechanism.

### Problem Statement
1. **Deadlock**: TWAP freezes at a stale value during volatility; `get_price` returns an outdated price that IndigoPay's USDC donation path depends on.
2. **Fallback dependency**: the only escape is the fallback price path, which is static and operator-managed.

### Objectives
- Implement a "slashing threshold ramp" that progressively relaxes the deviation tolerance when no valid observation has been accepted for N consecutive ledgers
- Bound the ramp so it cannot be exploited to push the TWAP through multiple thresholds faster than the market actually moves (cap total relaxation, require per-step minimums)

### Scope
- `contracts/oracle-contract/src/lib.rs` — `report_price`, `current_price_raw`, config storage
- New config fields: ramp start ledger, ramp step, ramp ceiling

### Acceptance Criteria
- Simulation test: inject stale TWAP, attempt rapid price change, verify ramp allows catch-up within a bounded number of ledgers
- Security test: verify the ramp cannot be gamed to move TWAP faster than the market (each accepted observation must still be within the *ramped* threshold and the ramp must reset on acceptance)

### References
- `contracts/oracle-contract/src/lib.rs` — `report_price`, `PriceDeviationExceedsThreshold`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #006 — IndigoPay: Add quadratic voting credit decay to prevent long-term voter credit hoarding

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
The governance system uses quadratic voting: voting power = sqrt(credits_spent), and credits are allocated based on badge tier via `voting_credits_from_badge`. Credits are never consumed beyond the single `vote_on_proposals` call, and badge tiers never decrease. A Seedling badge holder who never votes accumulates full voting power indefinitely. `update_voter_credits_on_badge_change` refreshes credits only on badge changes — there is no decay for inactive voters.

### Problem Statement
1. **Voting power hoarding**: long-term holders dominate governance regardless of recent participation.
2. **Sybil-incentive**: creating many low-tier accounts and waiting accrues the same weight as active participants.

### Objectives
- Implement exponential credit decay: credits earned more than N ledgers ago (configurable, default ~90 days) decay at X% per ledger
- Apply decay on read (`get_voting_credits`) so no background process is required; store `last_decay_ledger` per voter
- Ensure monotonic non-negative credits and that decay never enables credit *increases*

### Scope
- `contracts/indigopay-contract/src/lib.rs` — `VoterCredits`, `get_voting_credits`, `vote_on_proposals`, `update_voter_credits_on_badge_change`
- New config: `CREDIT_DECAY_RATE`, `CREDIT_DECAY_START_LEDGERS`

### Acceptance Criteria
- Unit test for decay calculation, property test for monotonic non-negative decay, integration test vote → wait → verify reduced credits
- Badge-change credit refresh must account for already-decayed credits (no credit resurrection)

### References
- `contracts/indigopay-contract/src/lib.rs` — `voting_credits_from_badge`, `update_voter_credits_on_badge_change`, `get_voting_credits`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #007 — Attestation: Add batched `record_attestations` with per-item validation and atomic rollback

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
The attestation contract has `MAX_BATCH_SIZE = 50` and a `BatchAttestationInput` struct, and the current code already implements a batch record path (`batch_rec` event exists). However the batch path processes inputs in a loop with per-item panic semantics: a single invalid item aborts the entire batch and no partial state is written (Soroban reverts the whole transaction). There is no way for the relayer to distinguish "rejected because one item was a replay" from "all items invalid" without resubmitting.

### Problem Statement
1. **Replay poisoning**: a batch containing one replayed `(source_chain, source_tx_hash)` fails the whole batch; the relayer must bisect manually.
2. **No per-item outcome reporting**: the relayer cannot see which items were accepted vs rejected without scanning storage.

### Objectives
- Add per-item validation that reports outcomes instead of panic-aborting the whole batch where safe (e.g. skip already-recorded hashes, emit a `batch_partial` event listing accepted/rejected indices)
- Preserve the "reject known-replay" guarantee (a replayed hash must never be double-credited)
- Keep `MAX_BATCH_SIZE = 50` enforcement

### Scope
- `contracts/attestation-contract/src/lib.rs` — batch record path, new outcome event, tests

### Acceptance Criteria
- Batch with one replay records the remaining items and reports the rejected index
- Batch of all-replays records nothing and reports all rejected
- `MAX_BATCH_SIZE` enforcement unchanged

### References
- `contracts/attestation-contract/src/lib.rs` — `MAX_BATCH_SIZE`, `BatchAttestationInput`, batch record path


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #008 — IndigoPay: Implement `get_donation_page` for efficient on-chain donation history reads

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
The contract stores donation records as individual `DataKey::DonationRecord(u32)` entries with a `DonationCount` counter. Reading donation history requires N separate `get_donation_record` calls — one per index. For projects with 10,000+ donations, this is O(n) RPC calls for any consumer (backend indexer reconciliation, transparency pages).

### Problem Statement
1. **O(n) RPC pattern**: any consumer that wants the full history issues one call per donation.
2. **No batch read**: there is a `batch` feature flag in Cargo.toml but it is disabled by default and unexercised for donation history.

### Objectives
- Implement `get_donation_page(env, from: u32, count: u32) -> Vec<DonationRecord>` that reads `count` entries starting at `from` in a single function call, with a cap (e.g. 50) to stay within Soroban's per-call resource budget
- Keep the existing single-read functions unchanged

### Scope
- `contracts/indigopay-contract/src/lib.rs` — new read function
- `contracts/indigopay-contract/src/donation/` — any shared record types

### Acceptance Criteria
- Unit tests for empty page, partial page (near end), full page, out-of-bounds `from`
- Gas benchmark documented comparing N+1 vs single-page read

### References
- `contracts/indigopay-contract/src/lib.rs` — `DataKey::DonationRecord`, `DonationCount`, `get_donation_record`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #009 — Escrow: Add `cleanup_completed_jobs` with grace-period archival to prevent `MAX_JOBS` exhaustion

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
The escrow contract enforces `MAX_JOBS = 256` in `create_job` but provides no mechanism to remove completed or disputed jobs from the `JobIds` vector or free their storage slots. Once 256 jobs are created, no new jobs can be created — even if 255 are long-completed. `docs/gas-optimization.md` documents `cleanup_*` functions as a storage-GC pattern, but the escrow contract has none.

### Problem Statement
1. **Permanent capacity ceiling**: completed jobs occupy slots forever; a freelancer marketplace will eventually hit 256 jobs.
2. **Storage bloat**: `Job` entries and the `JobIds` vector grow without bound and every TTL extension pays for them.

### Objectives
- Implement a permissionless `cleanup_completed_jobs` function that removes jobs with status `Completed` where `deadline + GRACE_PERIOD < current_ledger`
- Remove their `DataKey::Job` entries and drop them from `JobIds`
- Preserve `FreelancerReputation` even after job cleanup

### Scope
- `contracts/escrow-contract/src/lib.rs` — new `cleanup_completed_jobs`, `GRACE_PERIOD` constant

### Acceptance Criteria
- Unit test: create 256 jobs, complete 255, verify cleanup frees slots, verify the 257th job succeeds
- Security test: cleanup cannot remove in-flight (Escrowed/PartiallyReleased/Disputed) jobs

### References
- `contracts/escrow-contract/src/lib.rs` — `MAX_JOBS`, `create_job`, `JobIds`, `FreelancerReputation`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #010 — Oracle: Add per-source health tracking with `src_unhealthy` events and `get_source_health`

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/high`, `effort/large`

### Summary
`get_aggregated_price` queries all registered source oracles and computes a median-of-medians. It silently skips oracles that return errors or invalid values (`SourceOracleUnresponsive`, `SourceOracleReturnedInvalidPrice`). A compromised oracle consistently returning 0 or panicking is simply skipped — no event is emitted, no alarm is raised, and the source stays in the allowlist forever.

### Problem Statement
1. **No observability**: failing sources are invisible to operators.
2. **No automatic exclusion**: a persistently failing source is still queried every call, wasting gas and skewing the median if it intermittently returns garbage.

### Objectives
- Track the last N (e.g. 20) response outcomes per source
- Emit a `src_unhealthy` event when a source exceeds a configurable failure threshold; emit `src_recover` when it recovers
- Provide `get_source_health(source) -> SourceHealth` read function
- Health must be reversible — a recovered source must be re-included automatically

### Scope
- `contracts/oracle-contract/src/lib.rs` — new health storage, `get_aggregated_price` integration, new events

### Acceptance Criteria
- Simulate failing source → verify health event after threshold; verify healthy-source recovery resets counters
- Excluded sources are skipped in aggregation (documented gas savings)
- Full test suite passes

### References
- `contracts/oracle-contract/src/lib.rs` — `get_aggregated_price`, `SourceOracleUnresponsive`, `SourceOracleReturnedInvalidPrice`

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #011 — IndigoPay: Add Merkle Mountain Range accumulation and proof verification for streaming impact data

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/high`, `effort/large`

### Summary
The impact verification system (`#[cfg(feature = "impact")]`) supports Merkle tree proofs via `verify_impact_inclusion` and `ImpactRoot` archiving with period rotation. But it uses a flat Merkle tree that requires O(log n) recomputation per proof and O(n) recomputation when a new leaf is appended. MMRs (Merkle Mountain Ranges) support efficient append-only proofs and are better suited for streaming impact data where new leaves are continuously added without recomputing the entire tree. The `ImpactLeaf` struct already has `donor`, `donation_index`, `co2_kg`, `trees`, and `hectares` — all the fields needed.

### Problem Statement
1. **O(n) append cost**: adding one leaf to a flat Merkle tree rebuilds the entire tree.
2. **No incremental proofs**: every proof must refer to a specific tree root; mid-period reports require a new root per batch.

### Objectives
- Implement an MMR structure with `append_impact_leaf` that maintains peak hashes in persistent storage
- Implement `verify_impact_mmr(env, project_id, leaf, mmr_proof) -> bool` that verifies a leaf's inclusion in the current MMR root
- The MMR must support incremental updates without recomputing the entire tree

### Scope
- `contracts/indigopay-contract/src/lib.rs` — new MMR functions, `ImpactRoot` extension, new events
- Unit tests for MMR append, proof generation/verification, edge cases (empty MMR, single leaf, multiple peaks)

### Acceptance Criteria
- MMR proof for included leaf verifies; proof for excluded leaf fails
- MMR consistency across period boundaries (archiving one period's root doesn't invalidate the next)

### References
- `contracts/indigopay-contract/src/lib.rs` — `ImpactLeaf`, `ImpactRoot`, `verify_impact_inclusion`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #012 — IndigoPay: Add cross-contract re-entrancy guard for escrow and attestation settlement calls

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/security`, `priority/high`, `effort/medium`

### Summary
The IndigoPay contract makes cross-contract calls to the escrow contract (`EscrowClient` for campaign escrow lifecycle) and attestation contract (`AttestationClient` for `settle_attestation`). While CEI (Checks-Effects-Interactions) ordering is followed within IndigoPay, a malicious escrow or attestation contract (if upgraded through admin compromise) could call back into IndigoPay during the cross-contract invocation. Soroban prevents direct self-re-entrancy, but cross-contract re-entrancy through a chain of trusted contracts is possible if all use `#![no_std]` and the host's re-entrancy prevention only covers same-address recursion.

### Problem Statement
1. **Cross-contract re-entrancy risk**: if any companion contract is upgraded maliciously, it could re-enter IndigoPay mid-flow.
2. **No guard**: there is no `REENTRANCY_GUARD` flag in instance storage.

### Objectives
- Implement a `REENTRANCY_GUARD` instance-storage flag set before and cleared after each cross-contract call, panicking if entered while set
- Apply to `setup_campaign_escrow`, `fund_escrow`, `release_campaign_milestone`, `claim_campaign_milestone`, and `settle_attestation`
- Emit a `reentrancy_blocked` event if the guard triggers, for operator visibility

### Scope
- `contracts/indigopay-contract/src/lib.rs` — escrow and attestation call paths
- Test with a mock re-entrant contract that attempts callback, verify guard panics

### Acceptance Criteria
- All cross-contract calls set/clear the guard; guard panics on re-entry attempt
- No measurable gas regression on standard donation path (guard check is a single instance-storage read)

### References
- `contracts/indigopay-contract/src/lib.rs` — `setup_campaign_escrow`, `fund_escrow`, `release_campaign_milestone`, `settle_attestation`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #013 — Escrow: Add oracle-verification timeout to prevent indefinite milestone blocking

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/bug`, `priority/medium`, `effort/medium`

### Summary
When a milestone has an `oracle` configured (behind `oracle-escrow` feature), `release_milestone` checks `milestone.verified` before allowing release. If the oracle never calls `verify_milestone`, the milestone is permanently blocked — neither client nor freelancer can unblock it. The only escape is admin dispute resolution. `docs/gas-optimization.md` documents this pattern but offers no solution.

### Problem Statement
1. **Permanent block**: a non-responsive oracle freezes the escrow forever.
2. **No automatic fallback**: the `oracle` field becomes a permanent gate if the oracle is unresponsive.

### Objectives
- Implement a timeout: if `proof_hash` was set more than N ledgers ago and the oracle hasn't verified, the milestone's oracle requirement is waived
- The timeout should be configurable per-milestone at `create_job` with a floor of 1,000 ledgers (~83 minutes)
- `Milestone` struct gets a new `oracle_timeout_ledgers` field (appended for backward compat)

### Scope
- `contracts/escrow-contract/src/lib.rs` — `create_job` (new field), `release_milestone` (timeout check), tests

### Acceptance Criteria
- Create job with oracle milestone, advance ledger past timeout, verify release succeeds without oracle verification
- ORACLE_TIMEOUT_FLOOR of 1,000 ledgers enforced

### References
- `contracts/escrow-contract/src/lib.rs` — `release_milestone`, Milestone struct, `oracle-escrow` feature


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #014 — IndigoPay: Implement `get_donor_history_paginated` with per-donor sequential indexing

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/performance`, `priority/medium`, `effort/medium`

### Summary
The frontend donor dashboard calls `get_donor_stats` (1 RPC call) plus `get_donation_record(i)` for each of the donor's N donations (N RPC calls via `DonationRecord` key enumeration). For a donor with 200 donations, this is 201 RPC calls to render one page. The contract has no batched donor-history read function.

### Problem Statement
1. **N+1 query pattern**: O(n) RPC calls for donor history in the frontend and backend.
2. **No per-donor index**: donations are indexed by global index only.

### Objectives
- Implement `get_donor_history(env, donor, from: u32, count: u32) -> Vec<DonationRecord>`
- Add `DataKey::DonorDonationIndex(Address, u32) -> u32` mapping per-donor sequential indices to global donation indices
- Update the `donate` path to append this index entry

### Scope
- `contracts/indigopay-contract/src/lib.rs` — new read function, new DataKey variant, donation path update

### Acceptance Criteria
- Paginated donor history returns the same records as N individual calls
- Gas-cost comparison documented (N+1 vs single page)
- Storage-write cost per donation increases by 1 entry — document in `docs/gas-optimization.md`

### References
- `contracts/indigopay-contract/src/lib.rs` — `DataKey::DonorStats`, `DataKey::DonationRecord`, `get_donor_stats`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #015 — All Contracts: Add cross-contract fuzz harness deploying all 4 contracts together

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/testing`, `priority/high`, `effort/large`

### Summary
Each contract has isolated fuzz tests (`escrow_fuzz.rs`, `indigopay-contract/src/fuzz_tests.rs`, `attestation-contract/src/fuzz_tests.rs`). There is no fuzz harness that exercises cross-contract call sequences: IndigoPay → Escrow (campaign escrow lifecycle via `setup_campaign_escrow` → `fund_escrow` → `release/claim_campaign_milestone`), IndigoPay → Attestation (`settle_attestation`), IndigoPay → Oracle (`donate_usdc` price lookup). Cross-contract bugs are the hardest class of Soroban vulnerabilities — state inconsistencies across contracts caused by partial failures or mismatched state transitions.

### Problem Statement
1. **No cross-contract fuzzing**: isolated unit/fuzz tests cannot catch state drift across contract boundaries.
2. **Invariant violations**: e.g., IndigoPay's `CampaignEscrowMilestones` and the escrow's `Job` state can desynchronize.

### Objectives
- Implement a workspace-level fuzz harness deploying all 4 contracts and exercising random sequences of cross-contract calls
- Assert global invariants: sum of project balances across contracts matches total donated minus total withdrawn; attestation settlement deduplication holds; escrow balance + project balance = donations

### Scope
- New `contracts/cross_contract_fuzz.rs` or expanded fuzz tests in the workspace
- Must run 10,000+ iterations of random cross-contract sequences in CI nightly

### Acceptance Criteria
- The harness catches at least one real cross-contract invariant violation before merging
- CI nightly job runs 10,000 iterations

### References
- `contracts/indigopay-contract/src/fuzz_tests.rs`, `contracts/escrow-contract/src/escrow_fuzz.rs`, `contracts/attestation-contract/src/fuzz_tests.rs`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #016 — Backend: Add database connection-pool metrics with per-operation latency histograms

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/observability`, `priority/medium`, `effort/medium`

### Summary
The backend uses `pg` (node-postgres) with a pool (`backend/src/db/pool.js`). Prometheus metrics at `/metrics` expose overall request latencies, but there are no database-level metrics: pool utilization, idle connection count, waiting client count, or per-query-type latency histograms. The `monitoring/grafana` dashboards have no DB-level panels from which to diagnose slow-query root causes.

### Problem Statement
1. **No DB-level observability**: when p95 latency spikes, there is no way to attribute it to pool exhaustion vs slow queries vs RPC time.
2. **Pool exhaustion invisible**: if all connections are in use, the next request waits indefinitely with no metric emitted.

### Objectives
- Expose `db_pool_total`, `db_pool_idle`, `db_pool_waiting` gauges via the Prometheus metrics endpoint
- Add per-operation histograms (`db_query_duration_seconds` with `operation` label for SELECT/INSERT/UPDATE/DELETE)
- Integrate with the existing `backend/src/services/metrics.js` pattern

### Scope
- `backend/src/db/pool.js` — integrate metrics, new `backend/src/services/dbMetrics.js`
- Sample rate via `DB_METRICS_SAMPLE_RATE` env var (default 1.0 for production)

### Acceptance Criteria
- `GET /metrics` exposes pool gauges and query histograms
- Histogram buckets cover p50/p95/p99 ranges (e.g., 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2s, 5s)
- Tests verify gauge values change under load

### References
- `backend/src/db/pool.js`, `backend/src/services/metrics.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #017 — Backend: Implement event-driven cache invalidation with Redis pub/sub

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/architecture`, `priority/high`, `effort/large`

### Summary
The backend caching layer uses TTL-based expiration exclusively (`backend/src/services/cacheManager.js`, `backend/src/services/cache.js`). Mutation endpoints do not invalidate related cache keys. The docs mention cache invalidation on project status changes, but it is manual and inconsistent — new endpoints are added without updating invalidation logic.

### Problem Statement
1. **Stale reads under mutation**: project updates, donation recording, and governance resolution all leave stale cache entries for their TTL duration.
2. **Inconsistent invalidation**: some endpoints manually invalidate; most do not.

### Objectives
- Implement a pub/sub cache-invalidation system: mutation handlers publish invalidation events to Redis channels; subscribers listen and invalidate relevant keys
- Build an `invalidationRouter` mapping resource types to cache key patterns
- Fall back to TTL-only if Redis pub/sub is unavailable (graceful degradation)

### Scope
- `backend/src/services/cacheManager.js` — add pub/sub, rewrite invalidation dispatch
- All mutation route handlers — add invalidation events
- `backend/src/services/redis.js` — pub/sub subscriber integration

### Acceptance Criteria
- Integration test: create project → cache miss → update project → cache invalidated immediately
- Subscription test verifies Redis pub/sub delivery; fallback test verifies TTL fallback path
- No migration required; backward-compatible

### References
- `backend/src/services/cacheManager.js`, `backend/src/services/cache.js`, `backend/src/routes/donations.js`, `backend/src/routes/admin.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #018 — Backend: Idempotent auto-catch-up for the projection engine on partial failure

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/bug`, `priority/high`, `effort/medium`

### Summary
The projection engine (`backend/src/services/projectionEngine.js`) processes events in a transaction: append event to `donation_events`, then update all 4 projections. If the transaction fails after appending the event but before updating one projection, the event is persisted but that projection is stale. The `rebuildAllProjections` recovery mechanism requires admin intervention, and `projectionLagEvents` tracks this gap but does not trigger automatic recovery.

### Problem Statement
1. **Admin-dependent recovery**: lagging projections wait for an operator to call the rebuild endpoint.
2. **Silent drift**: the lag metric increases but no automated catch-up runs.

### Objectives
- At process startup and after a configurable idle period, the engine auto-replays missed events into lagging projections
- Use the existing staging-schema atomic swap pattern (`projection_stage` schema → `public`) so live reads see consistent state during catch-up
- Bound the auto-catch-up: if lag exceeds `PROJECTION_AUTO_CATCHUP_MAX_LAG`, log and alert instead of attempting

### Scope
- `backend/src/services/projectionEngine.js` — auto-catch-up logic
- `backend/src/services/sorobanEventService.js` — startup check
- `backend/src/services/metrics.js` — new metric `projectionAutoCatchupRuns`

### Acceptance Criteria
- Simulate partial failure (mock one projection to throw) → verify auto-catch-up restores consistency → `projectionLagEvents` returns to 0
- Auto-catch-up respects `PROJECTION_AUTO_CATCHUP_MAX_LAG` bound
- CI test verifies the full recovery path

### References
- `backend/src/services/projectionEngine.js` — `rebuildAllProjections`, `projectionLagEvents`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #019 — Backend: CSRF token rotation with method+path binding and replay prevention

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/security`, `priority/high`, `effort/medium`

### Summary
The backend CSRF middleware has test coverage (`backend/src/routes/csrf.test.js`) but uses single-use-per-session tokens with no rotation. If a token is leaked (e.g., via `Referer` header), the attacker can use it for the session's duration. The recent commit "replace per-request CSP nonce with cache-safe SHA-256 hash" demonstrates awareness of token-replay attacks but CSRF rotation was not addressed.

### Problem Statement
1. **Session-lifetime replay**: a leaked CSRF token works until the session expires.
2. **No binding**: the same token works for any endpoint and any method.

### Objectives
- Implement token rotation: issue a new CSRF token after each successful validated request
- Bind each token to the specific HTTP method + path it was issued for
- Store used tokens in Redis with a short TTL (5 minutes) to prevent replay of rotated tokens

### Scope
- `backend/src/middleware/csrf.js` (or wherever csrf is implemented), `backend/src/routes/csrf.test.js`

### Acceptance Criteria
- Unit test for token rotation, replay test (old token rejected after rotation), binding test (token for POST rejected on PUT)
- No regression on existing CSRF tests

### References
- `backend/src/routes/csrf.test.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #020 — Backend: Implement circuit-breaker integrated retry for the Stellar Horizon/RPC client

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/reliability`, `priority/high`, `effort/medium`

### Summary
`backend/src/services/stellar.js` exports `rpcBreaker` (a `CircuitBreaker` instance) and `withRetry` but the `withRetry` function uses a generic retry wrapper that retries any error — including non-transient failures. `circuitBreaker.js` implements a clean state machine but is not universally integrated across all Stellar RPC calls. `sorobanEventService.js` has its own `withRetry` wrapper, `recurringKeeper.js` uses `simulateTransactionWithRetry`, and the `turrets.js` file has no retry at all.

### Problem Statement
1. **Inconsistent retry**: three different retry implementations with no shared policy.
2. **No circuit breaker on Horizon calls**: the Horizon SSE stream (`indexerService.js`) does not use `rpcBreaker`.
3. **Non-transient errors retried**: `withRetry` may exhaust all allocates on a permission error.

### Objectives
- Unify all Stellar RPC/Horizon calls under `stellar.js`'s circuit breaker + retry combination
- `withRetry` must distinguish transient (5xx, network error, timeout) from non-transient (4xx, bad request) and not retry the latter
- Add Prometheus metrics for RPC call latency and failures per endpoint

### Scope
- `backend/src/services/stellar.js` — unified retry, `circuitBreaker.js` — integrate across all callers
- `backend/src/services/sorobanEventService.js`, `backend/src/services/recurringKeeper.js`, `backend/src/services/turrets.js` — adopt unified retry

### Acceptance Criteria
- Mock RPC failures, verify retry with backoff on 5xx, no retry on 4xx
- Circuit breaker opens after 5 consecutive failures, half-opens after cooldown
- Tests pass with the unified implementation

### References
- `backend/src/services/stellar.js`, `backend/src/services/circuitBreaker.js`, `backend/src/services/sorobanEventService.js`

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #021 — Backend: Graceful degradation for the CO₂ verification pipeline with per-source circuit breakers

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/reliability`, `priority/medium`, `effort/medium`

### Summary
`backend/src/services/co2Verifier.js` queries Gold Standard, Verra, and Global Forest Watch APIs, falling back to static `CATEGORY_BENCHMARKS` and IPCC emission factors. If any of these APIs are down or rate-limited, the verification cron (weekly, via pg-boss) fails silently for affected projects. There's no retry logic, no partial-degradation mode, and no alert when a data source is persistently unavailable. The `circuitBreaker.js` utility exists but is not used by this service.

### Problem Statement
1. **Silent degradation**: API failures produce `co2_verification_runs` rows with errors but no alarm.
2. **No circuit breaking**: a rate-limited API is hammered every weekly run.

### Objectives
- Integrate per-source circuit breakers (Gold Standard, Verra, GFW) using the existing `CircuitBreaker` class
- Implement fallback verification using only available sources with a `degraded: true` flag
- Add Prometheus counter `indigopay_co2_verification_source_errors` per source
- Add Alertmanager rule firing when any source has >3 consecutive failures

### Scope
- `backend/src/services/co2Verifier.js`, `backend/src/services/circuitBreaker.js`
- `monitoring/alert-rules.yml` — new rule

### Acceptance Criteria
- Mock API failures, verify degraded verification still produces results
- Verify circuit breaker opens/closes correctly and metrics increment
- Config: `CO2_VERIFIER_CIRCUIT_BREAKER_THRESHOLD`, `CO2_VERIFIER_CIRCUIT_BREAKER_TIMEOUT_MS`

### References
- `backend/src/services/co2Verifier.js`, `backend/src/services/circuitBreaker.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #022 — Backend: Add migration linting to CI for backward-incompatible database changes

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/ci`, `priority/medium`, `effort/medium`

### Summary
The backend has a `migration-policy.test.js` (referenced in the repo) that validates migration naming conventions. There's no automated detection of backward-incompatible migration patterns: DROP COLUMN, RENAME COLUMN, changing a column type, removing a NOT NULL constraint — all of which can cause downtime during rolling deployments. The migration files in `backend/src/db/migrations/` follow a numbered convention and the `migrate.js` runner applies them in order.

### Problem Statement
1. **Downtime risk**: destructive operations slip through code review.
2. **No CI gate**: nothing parses migration SQL for dangerous patterns.

### Objectives
- Implement a migration linter (Jest test or standalone script) that parses SQL migration files and flags:
  - destructive operations (DROP, RENAME)
  - type changes that may lose data
  - missing CONCURRENTLY on index creation
  - missing IF NOT EXISTS on CREATE operations
  - long-running operations without `lock_timeout`

### Scope
- Extend `backend/__tests__/migration-policy.test.js`, new `scripts/lint-migrations.js`
- CI: add `npm run migration:lint` step to `ci.yml`

### Acceptance Criteria
- Linter flags a sample bad migration in tests
- Existing migrations pass the linter (or documented exceptions)

### References
- `backend/src/db/migrations/`, `backend/src/db/migrate.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #023 — Backend: Redis Sentinel/failover support for cache, session, idempotency, and Socket.IO layers

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/reliability`, `priority/high`, `effort/large`

### Summary
The backend connects to Redis (`backend/src/services/redis.js`) for caching, session storage, idempotency keys, and the Socket.IO adapter. The connection is configured via a single `REDIS_URL` with no sentinel, cluster, or failover support. If Redis goes down, cache goes cold and Socket.IO rooms disconnect (admin real-time features break).

### Problem Statement
1. **Single point of failure**: a Redis restart causes socket disconnects and cold cache.
2. **No failover**: no automatic reconnection to a promoted replica.

### Objectives
- Accept `REDIS_SENTINELS` (comma-separated host:port list) and `REDIS_SENTINEL_MASTER_NAME` env vars
- Configure `ioredis` with sentinel support
- Handle sentinel failover events gracefully (log, emit metric, reconnect)
- Fall back to single-instance `REDIS_URL` when sentinels are unset

### Scope
- `backend/src/services/redis.js`, `backend/src/config/env.js`
- Tests with `redis-memory-server` or a dockerized sentinel cluster

### Acceptance Criteria
- Automatic failover reconnection verified in integration test
- Backward-compatible: single-instance config unchanged when sentinels unset

### References
- `backend/src/services/redis.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #024 — Backend: Slow-query detection with automatic EXPLAIN logging and baseline histogram

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/performance`, `priority/medium`, `effort/medium`

### Summary
The SLO requires p95 < 500ms. Leaderboard (`GET /api/leaderboard`) and donation history (`GET /api/donations/project/:id`) degrade under load. There's no automated slow-query detection beyond PostgreSQL's `log_min_duration_statement`. The `analyticsQueryPlans.integration.test.js` test suggests awareness of query performance but there's no production instrumentation.

### Problem Statement
1. **No slow-query attribution**: when p95 degrades, there's no way to identify the exact SQL.
2. **No baseline**: no latency histogram exists to compare regressions.

### Objectives
- Implement a pg query wrapper that:
  - logs any query taking > `SLOW_QUERY_THRESHOLD_MS` (default 200ms) with full query text and parameters
  - runs EXPLAIN ANALYZE on the query and logs the plan
  - increments a Prometheus counter `db_slow_queries_total` with the query operation label
  - samples 1% of fast queries to build a baseline latency histogram

### Scope
- `backend/src/db/queryWrapper.js` (new), integrate in `backend/src/db/pool.js`

### Acceptance Criteria
- Mock slow query, verify EXPLAIN log output, verify metric increment
- Config: `SLOW_QUERY_THRESHOLD_MS`, `SLOW_QUERY_SAMPLE_RATE`

### References
- `backend/src/db/pool.js`, `backend/src/services/analyticsService.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #025 — Backend: Add OpenTelemetry distributed tracing across all service boundaries

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/observability`, `priority/medium`, `effort/large`

### Summary
The backend uses Sentry for error tracking and Prometheus for metrics, but lacks distributed tracing. When a donation request takes 800ms (exceeding p95), there's no way to trace which component contributed the latency: Stellar RPC, database query, webhook enqueue, projection update, or cache write.

### Problem Statement
1. **No cross-component latency attribution**: the donation pipeline spans Horizon, RPC, pg-boss, and projections.
2. **No trace correlation**: `X-Request-Id` header exists but is not correlated with spans.

### Objectives
- Instrument Express routes with OTel auto-instrumentation
- Add manual spans for Stellar Horizon calls, pg-boss job enqueue/dequeue, Redis operations, and external API calls
- Preserve `X-Request-Id` as the trace ID for correlation with Pino logs
- Export to a configurable OTLP endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT`)

### Scope
- `backend/src/server.js` — OTel middleware, `backend/src/services/stellar.js`, `backend/src/services/webhookQueue.js`, `backend/src/services/projectionEngine.js`

### Acceptance Criteria
- Span context propagates across async boundaries; trace ID matches `X-Request-Id`
- Config: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_SAMPLE_RATE`

### References
- `backend/src/server.js`, `backend/src/services/stellar.js`, `backend/src/middleware/requestId.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #026 — Backend: Rate-limit aware request queuing with priority lanes

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/performance`, `priority/medium`, `effort/medium`

### Summary
The rate limiter (`backend/src/middleware/rateLimiter.js`) returns 429 when limits are exceeded. For donation recording (`POST /api/donations`), a 429 means the donor's transaction hash may not be recorded. During high-traffic events (campaign launches, matching rounds), the rate limiter becomes a hard wall, and the `turrets.js` matching path is also subject to the same limiter.

### Problem Statement
1. **Hard 429 wall**: legitimate donation requests are rejected during campaign peaks.
2. **No prioritization**: leaderboard reads compete with donation writes.

### Objectives
- When rate limit is approaching (e.g. 80% consumed), place requests in a priority queue with configurable timeout instead of rejecting
- Critical endpoints (donations) get higher priority than reads
- Requests that time out in queue still get 429

### Scope
- `backend/src/middleware/rateLimiter.js`, new `backend/src/services/requestQueue.js`

### Acceptance Criteria
- Load test simulating rate-limit approach, verify queued requests succeed, verify priority ordering
- Config: `RATE_LIMIT_QUEUE_ENABLED`, `RATE_LIMIT_QUEUE_TIMEOUT_MS`, `RATE_LIMIT_QUEUE_MAX_SIZE`

### References
- `backend/src/middleware/rateLimiter.js`, `backend/src/middleware/rateLimitConfig.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #027 — Backend: Public audit-chain verification endpoints

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
The audit chain (`backend/src/services/auditChain.js`) creates a hash chain for database rows; each row's hash includes the previous row's hash, creating a tamper-evident log. `auditRetention` manages retention. There's no public endpoint for external parties to verify the chain's integrity. The recent commits "re-anchor audit hash chain so verification survives retention" show the chain has a verification story internally, but it's not exposed.

### Problem Statement
1. **No public verifiability**: a third-party auditor cannot independently confirm chain integrity.
2. **No chain segment reads**: no way to fetch a chain segment with hashes for offline recomputation.

### Objectives
- Implement `GET /api/audit/verify/:table` and `GET /api/audit/chain/:table?from=X&to=Y` endpoints
- Return chain segments with hashes so anyone can recompute and verify
- Rate-limit but do NOT require authentication (public verifiability is the point)

### Scope
- New `backend/src/routes/audit.js`, `backend/src/services/auditChain.js`

### Acceptance Criteria
- Verify chain segment integrity, verify tampered chain detection, verify pagination
- Rate-limited public access without auth

### References
- `backend/src/services/auditChain.js`, `backend/src/services/auditAnchor.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #028 — Backend: Input sanitization middleware for Unicode/homoglyph/HTML injection across all text fields

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/security`, `priority/medium`, `effort/medium`

### Summary
The Zod schemas (`backend/src/validators/schemas.js`) validate types and lengths but don't sanitize against injection or XSS vectors: Unicode homoglyph attacks (confusable characters), bidirectional text override characters (U+202E), zero-width joiners, HTML/JavaScript fragments in text fields that could be stored and later rendered by the frontend. Project names, descriptions, profile bios, update bodies, and donation messages all accept arbitrary Unicode.

### Problem Statement
1. **XSS vector**: stored HTML/JS fragments can execute in the frontend if rendered unescaped.
2. **Spoofing**: homoglyph project names can impersonate real projects in the donation feed.
3. **Bidi override**: U+202E can reorder displayed text and disguise malicious links.

### Objectives
- Implement a shared `sanitize` Zod transform that:
  - strips bidirectional control characters
  - normalizes Unicode to NFC
  - strips HTML tags from plain-text fields
  - truncates at the schema-defined max length rather than rejecting
- Apply to all text fields in `backend/src/validators/schemas.js`

### Scope
- `backend/src/validators/schemas.js`, new `backend/src/validators/sanitize.js`

### Acceptance Criteria
- Unit tests for each sanitization rule: NFC normalization, HTML stripping, bidi removal
- Server-side only; frontend sanitization is defense-in-depth but not required

### References
- `backend/src/validators/schemas.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #029 — Backend: Unified pg-boss DLQ monitoring with reprocess endpoint and alerting

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/reliability`, `priority/medium`, `effort/medium`

### Summary
pg-boss dead-letter queues accumulate failed jobs across webhook deliveries, AI summaries, profile enrichment, CO₂ verification, and digest generation. `webhookQueue` has its own DLQ, `indexerDLQWorker.js` handles indexer dead letters, and `sorobanEventService.js` quarantines poison events. There's no unified DLQ monitoring, no automatic reprocessing strategy, and no alert when the DLQ grows beyond a threshold. The `queueMetrics.js` service tracks queue sizes but not DLQ health.

### Problem Statement
1. **Siloed DLQs**: each queue manages dead letters independently with no unified view.
2. **No reprocessing UI**: operators can't manually retry a specific failed job without DB access.
3. **No alerting**: DLQ growth is invisible until it impacts delivery.

### Objectives
- Implement `GET /api/admin/queue/dlq` listing DLQ entries across all queues with age, retry count, and error message
- Implement `POST /api/admin/queue/dlq/reprocess` to retry specific failed jobs
- Add Prometheus gauge `pgboss_dlq_size` per queue
- Add Alertmanager rule when any DLQ exceeds 50 entries

### Scope
- `backend/src/services/queueMetrics.js` (extend), `backend/src/routes/admin.js` (DLQ endpoints)

### Acceptance Criteria
- Verify DLQ listing, reprocessing, and metric emission
- Config: `PGBOSS_DLQ_ALERT_THRESHOLD` (default 50)

### References
- `backend/src/services/queueMetrics.js`, `backend/src/routes/admin.js`, `backend/src/services/indexerDLQWorker.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #030 — Backend: ConsistentHash-aware webhook delivery for sharded receivers

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/architecture`, `priority/medium`, `effort/medium`

### Summary
`backend/src/services/consistentHash.js` implements a consistent-hash ring but the webhook delivery path (`webhookQueue.js`) does not use it. If the backend ever scales to multiple instances, webhook deliveries are not pinned to a specific instance, which can cause duplicate deliveries or out-of-order delivery when multiple workers pick up the same job. The existence of `consistentHash.js` suggests it was built for a purpose (session stickiness, key routing) that is not yet wired in.

### Problem Statement
1. **Unused infrastructure**: `consistentHash.js` has no production caller.
2. **Delivery ordering risk**: multiple workers can process the same endpoint's deliveries concurrently.

### Objectives
- Wire consistent hashing into webhook delivery so that deliveries for the same receiver (endpoint) are processed by a single worker
- Preserve the existing 6-attempt backoff and DLQ behavior
- Keep the change backward-compatible for single-instance deployments

### Scope
- `backend/src/services/webhookQueue.js`, `backend/src/services/consistentHash.js`

### Acceptance Criteria
- Two simulated workers process the same endpoint's jobs without overlap
- Existing webhook delivery tests still pass

### References
- `backend/src/services/consistentHash.js`, `backend/src/services/webhookQueue.js`

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #031 — Frontend: Implement Service Worker with offline-first donation queue and Background Sync

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/feature`, `priority/high`, `effort/large`

### Summary
The frontend requires an active internet connection to sign and submit Stellar transactions. Donors in low-connectivity areas (common for climate projects) cannot donate. The `frontend/components/OfflineFallback.tsx` and `ConnectivityBanner.tsx` components detect offline state but don't queue donations, and `frontend/hooks/useOnlineStatus.ts` only toggles UI — no donation queue exists.

### Problem Statement
1. **No offline donation path**: donors in low-connectivity areas are excluded.
2. **Offline detection is UI-only**: `ConnectivityBanner` shows a banner but doesn't buffer work.

### Objectives
- Implement a Service Worker with offline-page caching for the project shell
- Implement an IndexedDB-backed donation queue (`frontend/lib/offlineQueue.ts` or hook) storing unsigned transaction parameters
- Integrate Background Sync API to submit queued donations when connectivity returns
- Show push notification when a queued donation is confirmed on-chain

### Scope
- `frontend/public/sw.js` (new), `frontend/lib/offlineQueue.ts` (new), `frontend/pages/_app.tsx` (register SW)
- `frontend/hooks/useOnlineStatus.ts` (extend), `frontend/components/OfflineFallback.tsx` (extend)

### Acceptance Criteria
- E2E test: simulate offline → queue donation → go online → verify submission
- SW must not store private keys; only unsigned transaction parameters

### References
- `frontend/components/OfflineFallback.tsx`, `frontend/hooks/useOnlineStatus.ts`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #032 — Frontend: Virtualized donation feed with infinite scroll and cursor-based pagination

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/performance`, `priority/medium`, `effort/medium`

### Summary
The donation feed (`frontend/components/DonationFeed.tsx`, `LiveDonationTicker.tsx`) renders all visible donations as DOM nodes. Socket.IO events push new donations in real-time, and the feed grows without bound during a session. For a popular project with 5,000+ donations, the DOM node count causes scroll jank and memory pressure.

### Problem Statement
1. **DOM bloat**: unbounded DOM growth during active sessions.
2. **No pagination**: the feed loads all donations at mount.

### Objectives
- Implement `@tanstack/virtual` or `react-window` for virtualized list rendering
- Integrate cursor-based pagination from the API
- Infinite scroll loading older pages on scroll-up
- Real-time items appended at the top without disrupting scroll position

### Scope
- `frontend/components/DonationFeed.tsx`, `frontend/components/LiveDonationTicker.tsx`
- A11y: virtualized list must be keyboard-navigable and screen-reader accessible

### Acceptance Criteria
- Unit test for virtual list rendering, E2E test for infinite scroll loading
- Memory profile shows bounded DOM node count

### References
- `frontend/components/DonationFeed.tsx`, `frontend/components/LiveDonationTicker.tsx`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #033 — Frontend: E2E encryption for donation message field using project's Stellar public key

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
Donation messages are stored in plaintext and are publicly visible in the donation feed (`DonationFeed.tsx`). Donors who want to send a private message to the project owner have no option to do so privately. The frontend's `DonateForm.tsx` accepts a message field without any encryption option.

### Problem Statement
1. **No private messaging**: all donation messages are public on-chain/off-chain.
2. **Donor friction**: donors may avoid adding a message because it's public.

### Objectives
- Add a "Private message" checkbox to `DonateForm.tsx`
- When checked, encrypt the message using the project wallet's Stellar public key via `nacl.box` (Curve25519-XSalsa20-Poly1305)
- Store the ciphertext in the `message` field with an `encrypted: true` flag
- Only the project wallet owner (who holds the corresponding secret key) can decrypt

### Scope
- `frontend/lib/encryption.ts` (new), `frontend/components/DonateForm.tsx`
- Backend: message column already accepts binary; flag via existing JSON or new column

### Acceptance Criteria
- Unit test for encrypt/decrypt roundtrip, backward compatibility with plaintext messages
- The encryption key is the project's public key — donor does not need the project's secret key

### References
- `frontend/components/DonateForm.tsx`, `frontend/components/DonationFeed.tsx`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #034 — Frontend: Full keyboard-navigation and screen-reader WCAG 2.1 AA audit

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/accessibility`, `priority/high`, `effort/large`

### Summary
The frontend has `@axe-core/playwright` in E2E tests and `jest-axe` for unit-level checks, plus `frontend/components/SkipToContent.tsx`. However, missing coverage: focus management during route transitions (Next.js client-side navigation doesn't announce page changes), keyboard trap prevention in modals and drawers, ARIA labels on dynamically-updated content (`LiveDonationTicker.tsx`, `LeaderboardTable.tsx`), color contrast in dark mode (`ThemeToggle.tsx`), focus indicators, and form error announcement via `aria-live` regions. The `a11y-nightly.yml` workflow exists but likely only runs smoke tests.

### Problem Statement
1. **Partial audit**: only ~30% of WCAG 2.1 AA violations are caught.
2. **Dynamic content**: real-time components have no ARIA live-region updates.
3. **Focus management**: route transitions are silent to screen readers.

### Objectives
- Add `@axe-core/playwright` checks to every E2E page test
- Fix all violations found
- Implement focus management on route transitions, keyboard trap prevention in all modals
- Add `aria-live` regions to `LiveDonationTicker`, `LeaderboardTable`
- Extend `a11y-nightly.yml` to run full axe scan against all pages

### Scope
- `frontend/components/**/*.tsx`, `frontend/pages/**/*.tsx`, `frontend/e2e/**/*.spec.ts`
- `.github/workflows/a11y-nightly.yml`

### Acceptance Criteria
- Zero critical/medium axe violations across all pages in CI
- Keyboard navigation through all interactive elements without trap

### References
- `frontend/components/SkipToContent.tsx`, `.github/workflows/a11y-nightly.yml`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #035 — Frontend: Refactor server-state management with `@tanstack/react-query` and optimistic updates

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/performance`, `priority/medium`, `effort/large`

### Summary
The frontend uses a mix of `useEffect` + `fetch` for server state with no optimistic updates and no offline support. The donation flow: user signs in Freighter → transaction submitted to Stellar → frontend calls `POST /api/donations` → waits for 201 → updates UI. This means a 2-3 second delay between clicking "Donate" and seeing confirmation. The `frontend/hooks/queries.ts` file suggests some query abstraction but is minimal. `frontend/hooks/useAsyncData.ts` is a generic async wrapper without caching.

### Problem Statement
1. **No optimistic UI**: every mutation waits for the server response before updating the UI.
2. **No stale-while-revalidate**: every page mount refetches data unconditionally.
3. **Manual cache management**: each component manages its own cache with `useState`.

### Objectives
- Implement `@tanstack/react-query` with:
  - optimistic mutation updates (show donation in feed immediately, rollback on error)
  - IndexedDB persistence for offline resilience
  - automatic background refetch on window focus
  - mutation retry with exponential backoff
- Convert incrementally, starting with donations

### Scope
- New `frontend/lib/queryClient.ts`, update all data-fetching hooks in `frontend/hooks/`, update mutation callers

### Acceptance Criteria
- Unit test for optimistic update + rollback
- E2E test for offline → online flow
- No regression on existing data-fetching behavior

### References
- `frontend/hooks/queries.ts`, `frontend/hooks/useAsyncData.ts`, `frontend/components/DonationForm.tsx`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #036 — Mobile: Biometric-secured transaction signing with hardware-backed key storage

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/mobile`, `type/security`, `priority/high`, `effort/large`

### Summary
The mobile app uses `expo-secure-store` (`mobile/lib/secureStore.ts`) for sensitive-data storage and `useBiometricAuth` (`mobile/hooks/`). However, Stellar transaction signing happens in JavaScript using the `stellar-sdk` Keypair class — the secret key must be loaded into JS memory to sign. On a compromised or jailbroken device, this secret key is extractable. The `mobile/lib/wallet/` directory contains wallet-management code.

### Problem Statement
1. **Key in JS memory**: the Stellar secret key is exposed to any JS-memory scanner.
2. **No hardware signing**: neither iOS Secure Enclave nor Android Keystore is used for Ed25519 operations.

### Objectives
- Store the Stellar secret key in iOS Secure Enclave / Android Keystore (via `expo-crypto` or native module)
- Perform Ed25519 signing inside the HSM so the secret key never enters JS memory
- `useBiometricAuth` hook gates access to the signing operation

### Scope
- `mobile/lib/secureStore.ts`, new `mobile/lib/stellarSigner.ts`, `mobile/hooks/useBiometricAuth.ts`

### Acceptance Criteria
- Signing succeeds with valid biometric; fails with invalid biometric
- Verify secret key never appears in JS heap (memory profiling test)

### References
- `mobile/lib/secureStore.ts`, `mobile/lib/wallet/`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #037 — Mobile: Offline transaction building with QR-based air-gapped signing

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/mobile`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
The mobile app targets donors where internet connectivity is intermittent. `mobile/lib/offlineCache.ts` and `mobile/lib/connectivity.ts` handle offline data caching and connectivity detection, but donations still require an active connection to Horizon for account sequence number lookup and transaction submission. The `mobile/lib/offlineQueue.ts` file exists for queueing actions but does not handle Stellar transaction building.

### Problem Statement
1. **Online-only donations**: sequence-number lookup requires connectivity.
2. **No air-gapped signing**: no way to sign offline and submit later via another device.

### Objectives
- Cache the account sequence number and latest ledger from the last online state
- Allow building and signing transactions offline (the sequence number may be stale — handle this gracefully on submission)
- Generate a QR code containing the signed transaction XDR
- Provide a "Submit Later" queue that submits when connectivity returns

### Scope
- `mobile/lib/offlineTx.ts` (new), `mobile/lib/offlineCache.ts`, `mobile/lib/offlineQueue.ts`
- Edge cases: sequence number staleness → tx rejected, retry with new sequence

### Acceptance Criteria
- Build transaction offline, verify XDR is valid, simulate online submission
- Stale sequence rejected with clear retry UX

### References
- `mobile/lib/offlineCache.ts`, `mobile/lib/connectivity.ts`, `mobile/lib/offlineQueue.ts`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #038 — Mobile: Deep-link routing for donation flows with universal-link fallback

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/mobile`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
The mobile app uses `expo-router` for file-based navigation and supports deep links for wallet connections (`freighter://tx?xdr=...`). However, project donation deep links (e.g., `indigopay://donate/project-001?amount=100`) are not implemented. `mobile/app/` directories suggest the app has donation and project pages but no deep-link registration. The `mobile/.well-known/` directory exists for universal link configuration.

### Problem Statement
1. **No project deep links**: scanning a project QR code at an event doesn't open the app to the donation screen.
2. **No universal links**: users without the app installed see a broken link.

### Objectives
- Implement `indigopay://donate/:projectId` with optional `?amount=X` query param
- Implement `indigopay://project/:projectId` for the project detail page
- Add universal link (`https://stellarindigopay.com/donate/:projectId`) as fallback
- Configure `app.json` associated domains

### Scope
- `mobile/app/donate/[projectId].tsx` (new), `mobile/app.config.ts`
- `mobile/.well-known/apple-app-site-association` (new)

### Acceptance Criteria
- Deep link integration test, pre-filled amount verified, fallback to web verified

### References
- `mobile/app/`, `mobile/.well-known/`, `mobile/app.json`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #039 — Extension: CSP compliance for Manifest V3 with inline-script removal

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/extension`, `type/security`, `priority/high`, `effort/medium`

### Summary
The Chrome Web Store enforces stricter Manifest V3 CSP requirements. The extension's `extension/manifest.json` specifies `manifest_version: 3` but `extension/popup.html` and `extension/settings.html` may contain inline scripts or event handlers violating CSP. The Firefox manifest (`manifest.firefox.json`) has different CSP rules. `extension/src/` contains the bundled source, and `extension/webpack.config.js` handles bundling.

### Problem Statement
1. **CSP violation risk**: inline scripts may cause Chrome Web Store rejection.
2. **Dual-manifest divergence**: Firefox and Chrome manifests may have different CSP policies.

### Objectives
- Audit `popup.html`, `settings.html` for inline scripts and event handlers (`onclick`, `onload`)
- Move all logic to bundled JS files loaded via `<script src="...">`
- Add strict CSP: `"content_security_policy": { "extension_pages": "script-src 'self'; object-src 'none'" }` to both manifests
- Add CSP lint step to `.github/workflows/extension.yml`

### Scope
- `extension/popup.html`, `extension/settings.html`, `extension/manifest.json`, `extension/manifest.firefox.json`

### Acceptance Criteria
- CSP validation test (parse manifest, verify no inline-script allowances)
- Chrome Web Store compliance review passes

### References
- `extension/manifest.json`, `extension/manifest.firefox.json`, `extension/popup.html`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #040 — Extension: Configurable donation presets with keyboard shortcuts

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/extension`, `type/feature`, `priority/low`, `effort/small`

### Summary
The extension popup (`extension/popup.html`, `extension/src/popup.ts`) requires the user to enter a custom donation amount each time. Power users (repeat donors) would benefit from configurable preset amounts with keyboard shortcuts. `extension/settings.html` and `extension/src/settings.ts` provide a settings UI ready for extension.

### Problem Statement
1. **No presets**: every donation requires manual amount entry.
2. **No keyboard shortcuts**: no power-user efficiency for the extension surface.

### Objectives
- Settings page with 4 configurable preset amounts stored in `chrome.storage.sync`
- Popup UI showing preset buttons ("10 XLM", "50 XLM", "100 XLM", "Custom")
- Keyboard shortcuts: Ctrl+1 through Ctrl+4 for presets, Enter to confirm
- "Quick Donate" mode: one-click donation of default preset when a Stellar address is detected

### Scope
- `extension/src/popup.ts`, `extension/src/settings.ts`, `extension/settings.html`, `extension/popup.html`

### Acceptance Criteria
- Unit test for preset storage/retrieval, E2E test for keyboard shortcut behavior
- Presets labeled with XLM amounts and approximate fiat values

### References
- `extension/src/popup.ts`, `extension/src/settings.ts`, `extension/popup.html`

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #041 — CI/CD: Implement automated canary analysis with a real `AnalysisTemplate` for Argo Rollouts

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/devops`, `type/feature`, `priority/high`, `effort/large`

### Summary
`gitops/argo-rollouts-canary.yaml` sets up Argo Rollouts for canary deployments with Prometheus analysis, but the file references an `AnalysisTemplate` that does not exist in `gitops/`. The canary promotion therefore relies on manual review or default step logic rather than automated success criteria.

### Problem Statement
1. **Missing AnalysisTemplate**: canary analysis is not actually configured.
2. **No automated rollback**: canary regressions require human detection.

### Objectives
- Create a real `AnalysisTemplate` resource in `gitops/`
- Query Prometheus for error rate and p95 latency of canary vs stable pods over a 10-minute window
- Automated rollback if canary error rate exceeds 1.5x stable baseline or p95 increases by >20%
- Add a Grafana dashboard panel showing canary-vs-stable metrics during rollout

### Scope
- `gitops/analysis-template.yaml` (new), `gitops/argo-rollouts-canary.yaml`
- `monitoring/recording-rules.yml` — canary-specific recording rules

### Acceptance Criteria
- `helm template` dry-run validates both manifests
- Manual canary test on staging verifies promotion/rollback based on analysis

### References
- `gitops/argo-rollouts-canary.yaml`, `monitoring/prometheus.yml`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #042 — CI/CD: Severity-gated SBOM vulnerability scanning with `.trivyignore` exceptions

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/devops`, `type/security`, `priority/high`, `effort/medium`

### Summary
The `.github/workflows/sbom.yml` generates an SBOM and `.github/workflows/image-scan.yml` runs Trivy, but there's no CI gate based on vulnerability severity. A critical CVE in a base image or npm dependency can be merged without blocking CI. A `.trivyignore` file exists but its semantics are not enforced as a reviewable process.

### Problem Statement
1. **No severity gate**: CRITICAL/HIGH CVEs don't fail CI.
2. **No exception process**: `.trivyignore` entries aren't reviewed or time-boxed.

### Objectives
- Run Trivy with `--severity CRITICAL,HIGH --exit-code 1` in CI
- Document `.trivyignore` exceptions with justification and review requirement
- Add a weekly SBOM diff job comparing current SBOM against previous release, flagging new dependencies
- Auto-create GitHub issues for new CRITICAL CVEs

### Scope
- `.github/workflows/image-scan.yml`, `.github/workflows/sbom.yml`, `.trivyignore`

### Acceptance Criteria
- CI fails on critical CVE; `.trivyignore` exceptions work as documented
- New CVEs in `.trivyignore` require PR review

### References
- `.github/workflows/image-scan.yml`, `.github/workflows/sbom.yml`, `.trivyignore`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #043 — CI/CD: Post-deploy contract verification with invariant smoke tests on testnet

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/devops`, `type/testing`, `priority/medium`, `effort/medium`

### Summary
`.github/workflows/contract-deploy.yml` deploys contracts to testnet but does not verify post-deployment correctness beyond checking the deploy transaction succeeded. There's no automated verification that: (1) the deployed WASM hash matches the build artifact, (2) `initialize` was called with the correct admin set, (3) `register_project` succeeds, (4) `donate` succeeds and emits the expected event, (5) `get_global_stats` returns zero-state values.

### Problem Statement
1. **Deploy ≠ correct**: a successful deploy transaction doesn't prove the contract works.
2. **No regression signal**: contract-breaking changes reach testnet without smoke verification.

### Objectives
- Implement a post-deploy verification script running a smoke-test sequence against the freshly deployed contract
- Assert each step's outcome and event emissions
- Fail the workflow if verification fails

### Scope
- `.github/workflows/contract-deploy.yml`, new `scripts/verify-deployment.sh`

### Acceptance Criteria
- Verification script runs automatically after deployment; fails workflow on mismatch

### References
- `.github/workflows/contract-deploy.yml`, `contracts/indigopay-contract/README.md`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #044 — CI/CD: k6 load-test regression detection with PR comments and baseline comparison

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/devops`, `type/ci`, `priority/medium`, `effort/medium`

### Summary
`scripts/load-test.js` k6 script enforces p95 < 500ms as a hard threshold. The load test only runs manually or in a CI smoke test (10 VUs, 10s). There's no automated regression detection: a PR that increases p50 from 82ms to 150ms (still below the 500ms threshold) merges without flagging the 83% degradation.

### Problem Statement
1. **No baseline comparison**: only hard thresholds, no relative regression detection.
2. **Manual-only full runs**: 100 VU runs require an operator.

### Objectives
- Add a nightly load test run (100 VUs, 60s) posting results as a JSON artifact
- Add a PR workflow comparing current results against the `main` baseline and posting a PR comment with the diff
- Config: `LATENCY_REGRESSION_THRESHOLD_PCT` (default 20%) — PRs exceeding it get a warning comment but are not blocked

### Scope
- `.github/workflows/ci.yml` (nightly load-test job), new `.github/workflows/perf-regression.yml`

### Acceptance Criteria
- Verify regression comment appears on PR; baseline comparison logic tested

### References
- `scripts/load-test.js`, `.github/workflows/ci.yml`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #045 — CI/CD: Database restore drill with data-integrity checksum validation

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/devops`, `type/reliability`, `priority/high`, `effort/medium`

### Summary
`.github/workflows/restore-drill.yml` runs monthly and asserts row counts after restore. Row counts alone don't catch silent data corruption — a restore that truncates all `TEXT` columns to empty strings would pass the row-count check. `scripts/backup-db.sh` handles the backup (pg_dump + S3/GCS upload) but doesn't compute a checksum of canonical row data.

### Problem Statement
1. **Row count ≠ integrity**: silent corruption passes the drill.
2. **No checksum**: backups have no content hash to compare against after restore.

### Objectives
- Compute SHA-256 of sorted, canonical-form row data for critical tables (donations, projects, donation_events) during backup
- During restore drill, recompute checksums and compare against the backup checksum
- Fail the drill and alert via the existing `RestoreDrillFailed` Alertmanager rule on mismatch
- Add a `restore_drill_checksum_mismatch` Prometheus gauge

### Scope
- `.github/workflows/restore-drill.yml`, `.github/workflows/database-backup.yml`, new `scripts/verify-restore-checksum.sh`

### Acceptance Criteria
- Intentional-corruption test (alter one row after restore) detected by checksum mismatch

### References
- `.github/workflows/restore-drill.yml`, `scripts/backup-db.sh`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #046 — Monitoring: Synthetic transaction monitoring with on-chain donation simulation

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/monitoring`, `type/observability`, `priority/high`, `effort/large`

### Summary
All existing monitoring (Prometheus metrics, Sentry errors, Alertmanager rules) is passive. If all real users are sleeping (off-peak) and the Soroban RPC goes down, the first alert fires when the first real donation fails — potentially hours later. The `monitoring/` directory has alert rules but no synthetic monitoring.

### Problem Statement
1. **Passive-only detection**: outages are detected by user impact, not proactive checks.
2. **No end-to-end signal**: the full donation path (build tx → sign → submit → verify on-chain event → verify backend recording) is unmonitored.

### Objectives
- Implement a synthetic monitoring agent: dedicated Stellar testnet account with pre-funded XLM
- Cron job (every 5 minutes) executing a full donation flow
- Prometheus gauge `synthetic_donation_success` (1 = last attempt succeeded, 0 = failed)
- `synthetic_donation_duration_seconds` histogram
- Alertmanager rule firing on 2 consecutive synthetic-check failures

### Scope
- New `scripts/synthetic-monitor.js`, `monitoring/alert-rules.yml` (new alert), `.github/workflows/synthetic-monitor.yml`

### Acceptance Criteria
- Verify synthetic donation succeeds end-to-end; verify alert fires on failure
- Synthetic donor account funded automatically from faucet/pool

### References
- `monitoring/alert-rules.yml`, `backend/src/services/stellar.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #047 — Monitoring: Business-level metrics dashboard (donation volume, project health, donor retention)

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/monitoring`, `type/observability`, `priority/medium`, `effort/medium`

### Summary
Existing Grafana dashboards (`monitoring/grafana/`) focus on infrastructure (CPU, memory, latency, error rates). There's no business-level visibility: daily donation volume by project, donor retention cohort analysis, conversion rate (wallet-connect → donation), project health scores, AI summary generation costs, or CO₂ offset totals by category. The `monitoring/recording-rules.yml` has only infra rules.

### Problem Statement
1. **No business KPIs**: donation volume, retention, conversion are invisible in dashboards.
2. **No precomputed metrics**: SQL-level business queries run ad hoc.

### Objectives
- Add Prometheus recording rules precomputing business metrics from the projection tables
- New "Business Overview" Grafana dashboard: daily/monthly donation volume, active donors, top projects, retention cohorts
- `business_metrics_exporter` cronjob querying Postgres and exposing Prometheus gauges

### Scope
- `monitoring/recording-rules.yml`, new `scripts/business-metrics-exporter.js`, new Grafana dashboard JSON

### Acceptance Criteria
- Metric values match database queries; dashboard renders
- Aggregate metrics only — no individual donor data in Prometheus

### References
- `monitoring/recording-rules.yml`, `monitoring/grafana/`, `backend/src/services/analyticsService.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #048 — Contracts: Kani formal verification of contract-level state invariants

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/testing`, `priority/high`, `effort/large`

### Summary
The Kani verification scaffold exists at `contracts/indigopay-contract/verification/kani/` and the current harness (`verify_badge_threshold_disjointness`) only verifies basic arithmetic properties. It does not verify contract-level state invariants, and the escrow/oracle/attestation contracts have no Kani harness at all.

### Problem Statement
1. **Narrow harness**: only badge-threshold disjointness is proven.
2. **No state invariants**: `GlobalTotalRaised == sum(project.total_raised)` and similar invariants are unproven.
3. **No coverage of companion contracts**: escrow payout arithmetic and oracle TWAP math are unverified.

### Objectives
- Prove `GlobalTotalRaised == sum(project.total_raised for all projects)` with a Kani harness
- Prove `DonationCount == number of DonationRecord entries`
- Prove badge monotonicity (badge tier never decreases)
- Prove escrow payout arithmetic: `compute_proportional_payout` never overflows and `sum(released) <= amount`
- Prove oracle TWAP: weighted average never exceeds max observed price
- Update `contracts/indigopay-contract/VERIFICATION.md`

### Scope
- `contracts/indigopay-contract/verification/kani/` — new harnesses
- New harnesses for escrow and oracle contracts

### Acceptance Criteria
- `cargo kani --harness invariant_global_total` passes
- Kani verification runs in CI (`contracts.yml`)

### References
- `contracts/indigopay-contract/verification/kani/src/lib.rs`, `contracts/indigopay-contract/VERIFICATION.md`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #049 — Cross-cutting: Dual-version webhook signing-secret rotation with `kid` header

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/security`, `priority/high`, `effort/medium`

### Summary
Webhook delivery signs payloads with HMAC-SHA256 using `signingSecretProvider` (`backend/src/services/signingSecretProvider.js`). The secret-rotation workflow exists (`.github/workflows/secret-rotation.yml`, `scripts/workflow/rotate_secrets.py` or similar) but there's no multi-version secret support in the signing provider. During rotation, there's a window where the old secret's signatures are no longer valid but the new secret hasn't propagated to all webhook receivers.

### Problem Statement
1. **Rotation gap**: signatures from the old secret become invalid before receivers learn the new one.
2. **No versioning**: `signingSecretProvider` returns a single secret with no key ID.

### Objectives
- Dual-version signing: sign with both current and previous secret; include a `kid` (key ID) header in the signature
- Multi-version verification: accept signatures from current, previous, and next secrets (3-version window)
- `GET /api/webhooks/keys` endpoint for receivers to discover active key IDs
- Automatic key-version expiry after rotation + 7-day grace period

### Scope
- `backend/src/services/signingSecretProvider.js`, `backend/src/services/webhook.js`, `.github/workflows/secret-rotation.yml`

### Acceptance Criteria
- Verify dual-version signing, verification with previous secret, 3-version window
- Previous secret securely deleted after grace period (Kubernetes Secret update + pod restart)

### References
- `backend/src/services/signingSecretProvider.js`, `.github/workflows/secret-rotation.yml`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---
## Issue #050 — Cross-cutting: API fuzz testing with automatic OpenAPI schema conformance

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/testing`, `priority/high`, `effort/large`

### Summary
The backend has extensive unit tests but no fuzz testing of the API layer. `scripts/validate-openapi.js` validates the OpenAPI spec, and `docs/api/openapi.yaml` defines endpoint schemas, but there is no fuzzing that generates random requests and verifies responses conform to the schema. Edge cases in request parsing, parameter validation, concurrent request handling, and error-recovery paths are untested.

### Problem Statement
1. **No API fuzzing**: malformed but schema-plausible inputs are untested.
2. **No conformance gate**: responses aren't machine-verified against the OpenAPI spec.
3. **5xx on invalid input**: some endpoints may 500 instead of 4xx on garbage input.

### Objectives
- Parse the OpenAPI spec to extract endpoint schemas
- Generate random valid and invalid requests per endpoint (max-length strings, boundary numbers, Unicode, missing required fields, extra unknown fields, concurrent identical requests)
- Verify all responses conform to the OpenAPI response schema
- Verify no 5xx errors occur for invalid input (should be 4xx)
- Run as a Jest test suite with 10,000+ iterations per endpoint, integrated into CI

### Scope
- New `backend/__tests__/fuzz/` directory, `scripts/validate-openapi.js` (extend with fuzz mode)

### Acceptance Criteria
- Fuzz harness catches at least one real bug before merging
- CI: fast subset (100 iterations) in PR CI, full run (10,000 iterations) nightly

### References
- `docs/api/openapi.yaml`, `scripts/validate-openapi.js`, `backend/src/routes/donations.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Summary — Batch 1 (#001–#050)

This first issue set was generated from direct code inspection and targets real, verifiable gaps in the Stellar-IndigoPay repository:

- **Contract correctness & security** (#001, #003–#015): deprecated-event migration, access control, re-entrancy, TTL, MMR proofs, fuzzing, formal verification
- **Backend reliability & observability** (#016–#030): pool metrics, cache invalidation, projection catch-up, CSRF rotation, circuit breakers, DLQ monitoring, sanitization, tracing, slow-query detection
- **Frontend performance & a11y** (#031–#035): offline donations, virtualization, E2E-encrypted messages, accessibility, query caching
- **Mobile & extension** (#036–#040): hardware-backed signing, offline+QR signing, deep links, CSP, donation presets
- **DevOps, monitoring, and CI** (#041–#047): canary analysis, SBOM gates, post-deploy verification, perf regression, restore checksums, synthetic monitoring, business dashboards
- **Cross-cutting** (#048–#050): Kani invariants, webhook key rotation, API fuzzing

Each issue includes the files/contracts/components to change, expected behavior, edge cases, acceptance criteria, and testing requirements, and each is objectively verifiable through code review, automated tests, CI, benchmarks, or demonstrable project behavior.

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

# GrantFox OSS — Batch 2: 50 Additional High-Value Issues (#051–#100)

> Second batch generated from further deep inspection of the Stellar-IndigoPay codebase: all 4 Soroban contracts (17,499-line IndigoPay lib.rs), the event-sourcing backend, webhook delivery, CO₂ verification, Turrets donation matching, DEX path-payment integration, recurring donation keeper, off-chain Merkle tree service, idempotency middleware, device-integrity mobile gate, offline donation queue, and the full Kubernetes/Helm/ArgoCD production infrastructure.

---

## Issue #051 — Backend: Nonce-based replay protection for `donorAuth` Ed25519 signature challenge

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/security`, `priority/high`, `effort/medium`

### Summary
`backend/src/middleware/donorAuth.js` authenticates donors by verifying an Ed25519 signature of a UNIX timestamp passed in `X-Timestamp`. The 5-minute timestamp window mitigates clock skew but does not prevent replay within that window — an attacker who observes a valid `(timestamp, signature)` pair can replay it to any endpoint until the window expires. The signature payload is only the timestamp string, with no nonce, no request body binding, and no per-endpoint binding.

### Problem Statement
1. **Replay within window**: the same signed timestamp works on any endpoint for 5 minutes.
2. **No request binding**: a signature obtained for `GET /api/donor/stats` can be replayed against `POST /api/donor/delete-account` or any other donor-authed endpoint.
3. **No nonce tracking**: server has no way to detect that a (timestamp, signature) has already been consumed.

### Objectives
- Implement a server-issued challenge: `GET /api/auth/challenge` returns `{ nonce: "<random>", expiresAt: "<ISO8601>" }`
- Donor signs `nonce + method + path` and sends `X-Donor-Address`, `X-Donor-Nonce`, `X-Donor-Signature`
- Server stores consumed nonces in Redis with the same TTL as their expiration (60 seconds)
- Reject replayed nonces with 401 "Nonce already consumed"

### Scope
- `backend/src/middleware/donorAuth.js` — rewrite challenge-response flow
- New `GET /api/auth/challenge` in existing routes
- Config: `DONOR_AUTH_NONCE_TTL_MS` (default 60_000)

### Acceptance Criteria
- Replay test: capture valid signature, replay within window → 401
- Binding test: signature for GET rejected on POST with same nonce
- No regression: existing donor-authed endpoints continue to work

### References
- `backend/src/middleware/donorAuth.js`, `backend/src/routes/donations.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #052 — Backend: Idempotency-key race condition — INSERT without ON CONFLICT

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/bug`, `priority/high`, `effort/small`

### Summary
`backend/src/middleware/idempotency.js` inserts a placeholder row before processing the request and later updates it with the actual response. But the INSERT uses a plain `INSERT INTO idempotency_keys …` without `ON CONFLICT (key) DO NOTHING`. Two concurrent requests with the same `Idempotency-Key` header both read-and-miss the SELECT check, then both execute INSERT — the second one hits a uniqueness violation on `key` (the primary key) and throws a 500 error, which `catch (err) { next(err); }` propagates to the client.

### Problem Statement
1. **Race window**: concurrent requests with same key can 500 instead of returning the first request's response.
2. **No locking**: no `SELECT … FOR UPDATE` or advisory lock to serialize concurrent idempotency probes.

### Objectives
- Change the INSERT to `INSERT INTO idempotency_keys … ON CONFLICT (key) DO NOTHING RETURNING key`
- If RETURNING returns no row (another request won the race), re-read the idempotency row and return the stored response
- Add integration test with two concurrent POST requests sharing an idempotency key

### Scope
- `backend/src/middleware/idempotency.js`
- `backend/__tests__/idempotency.integration.test.js` (new or extend)

### Acceptance Criteria
- Concurrent test: fire two requests simultaneously with same key → both get 201, only one donation record created
- No race-condition 500s in 1,000-iteration stress test

### References
- `backend/src/middleware/idempotency.js`, `backend/src/db/schema.sql` (idempotency_keys table)


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #053 — Backend: Socket.IO donation batcher — add backpressure, metrics, and graceful overflow

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/reliability`, `priority/medium`, `effort/medium`

### Summary
`backend/src/services/donationBatcher.js` batches Socket.IO donation events with a 500ms window and a 50-item cap. But it has no backpressure: if the `io.emit("donation_batch", batch)` call blocks or the Socket.IO adapter (Redis-based) is slow, batched donations accumulate in memory without any bound. There is no prometheus metric tracking batch sizes, flush latency, or dropped batches, making the donation feed's observability entirely dependent on client-side metrics.

### Problem Statement
1. **No memory bound**: the `donations` array grows unboundedly if emit is slow.
2. **No observability**: batch size distribution, flush latency, and dropped batches are invisible to operators.
3. **No graceful overflow**: when Redis adapter is disconnected, batches are silently emitted with no fallback.

### Objectives
- Add a hard cap (`maxPendingDonations`, default 500) — beyond this, oldest donations are dropped with a `donation_batcher_drop` prometheus counter increment
- Emit prometheus histogram `donation_batch_size` and `donation_batch_flush_duration_seconds`
- When Socket.IO Redis adapter is disconnected, log an error and stop accumulating (graceful degradation)
- Add `getStats()` method exposing pending count, total flushed, total dropped

### Scope
- `backend/src/services/donationBatcher.js`, `backend/src/services/metrics.js`

### Acceptance Criteria
- Overload test: simulate slow IO, verify drops and counter
- Metrics test: verify histogram buckets populated
- Disconnect test: Redis down → batcher pauses, Redis up → resumes

### References
- `backend/src/services/donationBatcher.js`, `backend/src/services/metrics.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #054 — Contracts: Upgrade path verification — test the `propose_upgrade`/`execute_upgrade` flow against a real testnet deployment

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/testing`, `priority/high`, `effort/medium`

### Summary
The IndigoPay contract has a full two-step upgrade flow: `propose_upgrade` (M-of-N admin signatures required), 48-hour `UPGRADE_TIMELOCK_LEDGERS` delay, then `execute_upgrade` (single admin signature). `cancel_upgrade` can abort during the timelock. `LastExecutedUpgrade` and `UpgradeEffectiveAt` storage keys are maintained. However, none of this is tested against a real deployed contract on testnet — it is only tested in the Soroban SDK's test environment where `env.deployer().update_current_contract_wasm()` is not an actual on-chain operation.

### Problem Statement
1. **Test environment != production**: the SDK test harness's `testutils` host does not exercise the real network's WASM deployment lifecycle.
2. **No integration test**: the upgrade flow that will be used in production has never been exercised against a live testnet deployment.

### Objectives
- Deploy V1 contract to testnet, then propose and execute an upgrade to a V2 (no-op change with a new constant, same interface)
- Verify `LastExecutedUpgrade` is readable after upgrade
- Verify `propose_upgrade` with insufficient signatures (below threshold) is rejected
- Verify `execute_upgrade` before timelock is rejected
- Verify `cancel_upgrade` works during timelock
- Script entire flow in CI (`contract-deploy.yml`)

### Scope
- `.github/workflows/contract-deploy.yml`, new `scripts/test-upgrade-flow.sh`, test-only V2 contract variant

### Acceptance Criteria
- Full upgrade lifecycle validated on testnet
- Upgrade test runs on every merge to main

### References
- `contracts/indigopay-contract/src/lib.rs` — `propose_upgrade`, `execute_upgrade`, `cancel_upgrade`, `UPGRADE_TIMELOCK_LEDGERS`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #055 — Backend: Admin session-management endpoint for forced logout of specific sessions

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/security`, `priority/medium`, `effort/small`

### Summary
`backend/src/middleware/auth.js` already implements `listActiveSessions(adminId)` and `revokeRefreshFamily(family, adminId)` — the full infrastructure for session management exists. But there is no admin endpoint to list all sessions for an admin user or to revoke a specific session family. An admin who notices an unrecognized session has no way to terminate it short of rotating their credentials.

### Problem Statement
1. **No session visibility**: admins cannot see their active sessions.
2. **No targeted revocation**: if one device is compromised, all sessions must be killed.

### Objectives
- `GET /api/admin/sessions` — list active sessions for the authenticated admin
- `DELETE /api/admin/sessions/:family` — revoke a specific session family
- `DELETE /api/admin/sessions` — revoke ALL sessions except the current one (identified by the cookie's refresh token family)

### Scope
- New `backend/src/routes/admin/sessions.js`, `backend/src/middleware/auth.js` (minor exports)

### Acceptance Criteria
- Integration test: create 2 sessions, list both, revoke one, verify only that one is revoked
- Revoke-all test: 3 sessions, revoke-all-except-current, verify 2 revoked

### References
- `backend/src/middleware/auth.js` — `listActiveSessions`, `revokeRefreshFamily`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #056 — Contracts: Implement per-token pause for selective emergency gating

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
The contract has a global `ContractPaused` flag that gates all state-mutating functions. But there is no per-token pause: if only the USDC oracle is compromised, the admin must pause the entire contract (blocking XLM donations too). The `TokenConfig` struct already has an `active` field — but it gates new donations, not an emergency pause. An emergency affecting only USDC should gate USDC flows while leaving XLM fully operational.

### Problem Statement
1. **All-or-nothing pause**: a USDC-only incident blocks XLM donations.
2. **No granular control**: the `TokenConfig.active` flag is not a pause, it's a registration lifecycle flag.

### Objectives
- Add `TokenConfig.suspended: bool` (appended for backward compatibility)
- `suspend_token(admin, token_address)` and `resume_token(admin, token_address)` entrypoints
- `donate_token` and `donate_usdc` check `suspended` in addition to `active`
- Emit `token_suspended`/`token_resumed` events

### Scope
- `contracts/indigopay-contract/src/lib.rs` — TokenConfig, new entrypoints, donation paths

### Acceptance Criteria
- Suspend USDC token → XLM donations succeed, USDC donations reject with error
- Resume → USDC donations work again
- `cargo test --features testutils -p indigopay-contract` passes

### References
- `contracts/indigopay-contract/src/lib.rs` — `TokenConfig`, `ContractPaused`, `donate_token`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #057 — Frontend: Implement `DonateForm.tsx` overhaul — real-time fee estimation, max-button, impact preview

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/feature`, `priority/high`, `effort/large`

### Summary
`frontend/src/components/DonateForm.overhaul.md` documents a planned overhaul of `DonateForm.tsx` with real-time balance display, a "Max" button (balance minus fees minus reserve), fee estimation using stellar-sdk transaction building, amount presets, and an impact preview. None of this is implemented — the TODO has been sitting in the overhaul doc without progress. The current `DonateForm.tsx` accepts basic amount input only.

### Problem Statement
1. **No fee estimation**: donors have no visibility into Stellar transaction fees before signing.
2. **No max button**: donors must manually calculate how much they can send.
3. **No impact preview**: donors don't see estimated CO₂ offset before donating.

### Objectives
- Implement real-time balance polling via `useWallet()` hook
- Implement "Max" button using `stellar-sdk` transaction build to estimate fees and XLM reserve
- Implement fee estimator showing stroops and estimated USD value
- Implement amount presets (10, 50, 100, 250 XLM)
- Show estimated CO₂ impact inline using `project.co2_per_xlm`
- Respect `prefers-reduced-motion` for animations

### Scope
- `frontend/components/DonateForm.tsx` — full rewrite per overhaul plan
- `frontend/components/AnimatedNumber.tsx` — use for balance and CO₂
- `frontend/__tests__/DonateForm.test.tsx` — new tests

### Acceptance Criteria
- All goals from `DonateForm.overhaul.md` are met
- Unit tests for validation, max button calculation, and preset selection
- Accessibility: keyboard navigation, `role="alert"` on errors

### References
- `frontend/src/components/DonateForm.overhaul.md`, `frontend/components/DonateForm.tsx`, `frontend/lib/WalletProvider.tsx`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #058 — Frontend: Implement `DonationModal.tsx` — animated confirmation, sharing, donate-again flow

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
`frontend/src/components/DonationModal.overhaul.md` documents the planned `DonationModal.tsx` with animated confirmation (checkmark + thank-you fade), a share section (Twitter, copy link, download certificate via `ImpactCertificate.tsx`), and a "Donate Again" flow back to the form. This TODO is unimplemented.

### Problem Statement
1. **No post-donation UX**: donors get a basic success message with no share or re-engagement.
2. **No viral loop**: sharing a donation drives no new donors.

### Objectives
- Implement `DonationModal.tsx` per overhaul plan: animated checkmark, share via `ShareButton.tsx`, download impact certificate via `ImpactCertificate.tsx`, donate-again button
- Use `framer-motion` if already in dependencies; CSS animation fallback
- Ensure focus management and reduced-motion support

### Scope
- `frontend/components/DonationModal.tsx` — new component
- `frontend/__tests__/DonationModal.test.tsx`

### Acceptance Criteria
- Animated confirmation renders after donation
- Share button generates correct Twitter/copy-link payloads
- "Donate Again" resets the form
- A11y: focus moves to modal on open, trapped within modal on keyboard navigation

### References
- `frontend/src/components/DonationModal.overhaul.md`, `frontend/components/ShareButton.tsx`, `frontend/components/ImpactCertificate.tsx`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #059 — Contracts: `unwrap_or` panics in non-test code paths — audit and replace with error handling

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/security`, `priority/high`, `effort/medium`

### Summary
The contract's `get_donation_record`, `get_donor_stats`, and `get_global_stats` read functions use `.unwrap_or(default_value)` — safe unwrap patterns. But `read_admin_set` and `read_admin_threshold` at lines in `lib.rs` use `.expect("Not initialized")` and `.expect("Admin threshold not set")` respectively — these are plain panics that would crash the WASM if storage is corrupted or missing. Additionally, `reverse_donation_accounting` uses multiple `.unwrap_or_else(|| panic_with_error!(...))` which is the correct pattern, but the helper `get_donation_record` at line ~98 in `donation/contract.rs` uses `.unwrap()` directly on a `Vec::get()` result.

### Problem Statement
1. **Unrecoverable panics**: `.unwrap()` in non-test paths crash the contract with no event.
2. **No error surfacing**: a corrupted DonationCount leads to a WASM panic, not a `ContractError`.

### Objectives
- Audit all `.unwrap()`, `.expect()`, and `panic!()` in non-test code paths across all 4 contracts
- Replace with `panic_with_error!(env, ContractError::...)` or `if let Some(...)` graceful handling
- Ensure every read from storage that could be absent returns a meaningful error

### Scope
- `contracts/indigopay-contract/src/lib.rs`, `contracts/indigopay-contract/src/donation/contract.rs`
- Same audit for escrow, attestation, oracle contracts

### Acceptance Criteria
- Zero `.unwrap()` or `.expect()` calls in non-test paths that read from storage
- `cargo test --features testutils --workspace` passes
- `cargo clippy --workspace -- -D clippy::unwrap_used` passes (configured to allow only in test modules)

### References
- `contracts/indigopay-contract/src/lib.rs` — `read_admin_set`, `read_admin_threshold`
- `contracts/indigopay-contract/src/donation/contract.rs` — `get_donation_record`, test unwraps


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #060 — Backend: Turrets matching — idempotency guard and retry for `submitMatchingPayment`

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/bug`, `priority/high`, `effort/medium`

### Summary
`backend/src/services/turrets.js` `submitMatchingPayment()` builds, signs, and submits a matching payment transaction. There is no idempotency guard: if the transaction is submitted to Horizon successfully but the response is lost (network timeout), the caller has no way to know whether the payment went through. A retry would double-spend the matcher's funds. There is also no `withRetry` wrapping for the Horizon submission — if Horizon returns a transient 503, the matching payment is silently dropped.

### Problem Statement
1. **No idempotency**: lost submission responses can lead to double-payments or missed matching.
2. **No retry**: transient Horizon failures silently drop matching.

### Objectives
- Derive an idempotency key from the `originalTxHash` + `matchId` and check/set in `idempotency_keys` before submission
- Wrap Horizon submission with the unified `withRetry` from `stellar.js`
- If the transaction hash is already recorded, skip the submission and return the stored result
- Add `matchRetry` metrics

### Scope
- `backend/src/services/turrets.js` — `submitMatchingPayment`, `matchDonationTxFunction`

### Acceptance Criteria
- Integration test: mock Horizon timeout, verify no double-submit on retry
- Metrics test: verify `matchRetry` counter increments on retry

### References
- `backend/src/services/turrets.js`, `backend/src/services/stellar.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #061 — Backend: Recurring keeper — dynamic fee estimation instead of hardcoded 100,000 stroops

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/performance`, `priority/medium`, `effort/small`

### Summary
`backend/src/services/recurringKeeper.js` line ~155 builds the `execute_recurring` transaction with a hardcoded fee of `"100000"` stroops (0.01 XLM). During network congestion, this may be too low for inclusion. During low-fee periods, it overspends. The contract uses `TransactionBuilder` with a fixed fee rather than querying `server.fetchBaseFee()` or using the Soroban RPC's `getTransaction` fee estimation.

### Problem Statement
1. **No congestion adaptivity**: 100k stroops may be too low during congestion.
2. **No fee optimization**: overspending during normal operation.

### Objectives
- Query `stellarServer.fetchBaseFee()` before building the transaction
- Apply a configurable multiplier (`RECURRING_KEEPER_FEE_MULTIPLIER`, default 1.5) for inclusion margin
- Cap at a configurable max (`RECURRING_KEEPER_FEE_MAX_STROOPS`, default 500_000)
- Log the fee used and emit a prometheus histogram `recurring_keeper_fee_stroops`

### Scope
- `backend/src/services/recurringKeeper.js` — `executeSchedule`
- Config: `RECURRING_KEEPER_FEE_MULTIPLIER`, `RECURRING_KEEPER_FEE_MAX_STROOPS`

### Acceptance Criteria
- Test: mock base fee at 100 stroops → fee becomes 150 (×1.5); mock at 1,000,000 → capped at 500,000
- No regression on existing keeper integration test

### References
- `backend/src/services/recurringKeeper.js`, `backend/src/services/stellar.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #062 — Backend: Merkle tree service — streaming support for large audit-chain datasets

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/performance`, `priority/medium`, `effort/medium`

### Summary
`backend/src/services/merkleTree.js` `buildMerkleTree()` loads all entries into memory, computes all leaf hashes, then iteratively builds all tree levels. For the audit chain with hundreds of thousands of rows, this is O(n) memory in both the input array and the full tree structure. A large audit-verification request could exhaust the Node.js heap.

### Problem Statement
1. **Memory-bound**: thousands of audit entries consume significant heap.
2. **No streaming**: the entire tree must be built before any proof can be generated.

### Objectives
- Implement `buildMerkleTreeStreaming(entryIterator)` that accepts an async iterator and builds the tree level-by-level, discarding lower levels as higher ones are built
- Leverage pinned `Buffer` pooling to avoid temporary-object GC pressure
- Keep the existing `buildMerkleTree` as a simpler API for small datasets
- Add a memory-usage test with 100,000 entries

### Scope
- `backend/src/services/merkleTree.js` — new streaming API, Buffer pool

### Acceptance Criteria
- 100,000-entry tree builds without exceeding 256 MB heap
- Proofs from streaming tree match proofs from regular tree for the same inputs

### References
- `backend/src/services/merkleTree.js`, `backend/src/services/auditChain.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #063 — Backend: Donation endpoint — validate `transaction_hash` format before database insert

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/security`, `priority/medium`, `effort/small`

### Summary
The `POST /api/donations` endpoint accepts a `transaction_hash` field that is stored in the `donations` table and used for deduplication (unique index `uq_donations_tx`). The Zod validation schema only checks that `transaction_hash` is a string — it does not validate that it is a valid Stellar transaction hash (64 hex characters). A malformed hash can be stored, creating an unusable dedup key. A malicious caller could submit a short string like "abc" and block the unique index for the real transaction hash, requiring admin cleanup.

### Problem Statement
1. **No format validation**: any string can be stored as a `transaction_hash`.
2. **Dedup pollution**: a short-string hash can block the real hash from being recorded.

### Objectives
- Add a `.refine()` to the Zod schema checking `transaction_hash` is a 64-character lowercase hex string
- Reject invalid hashes with 400 "Invalid transaction hash format"
- Backfill: log (don't reject) existing rows with invalid hashes for audit

### Scope
- `backend/src/validators/schemas.js` — donation schema

### Acceptance Criteria
- Valid 64-char hex accepted, any deviation rejected with 400
- No regression on donation integration tests

### References
- `backend/src/validators/schemas.js`, `backend/src/routes/donations.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #064 — Frontend: DEX path-payment donation — cache `findBestPath` results with TTL

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/performance`, `priority/medium`, `effort/small`

### Summary
`frontend/lib/dex.ts` `findBestPath()` queries Horizon `/paths/strict-send` on every call. When a donor holds multiple non-native assets and is browsing the donation UI, each asset selection triggers a fresh Horizon query for the same `(source_asset, source_amount)` pair. Horizon path-finding is a relatively expensive API call — caching results with a short TTL (30 seconds) would eliminate redundant queries without risking stale data.

### Problem Statement
1. **Redundant queries**: same path recomputed on re-render.
2. **Rate-limit risk**: rapid asset switching can trigger Horizon rate limits.

### Objectives
- Implement an in-memory LRU cache (max 100 entries) with a 30-second TTL
- Key: `${sourceAssetCode}:${sourceAssetIssuer}:${sourceAmount}`
- Expose `invalidatePathCache()` for testing
- Cache expiry handled on read (lazy)

### Scope
- `frontend/lib/dex.ts` — new cache, exported cache control functions

### Acceptance Criteria
- Cache hit: second call with same params within TTL returns cached result without Horizon call
- Cache miss: TTL expired → fresh query
- No behavior change for callers

### References
- `frontend/lib/dex.ts` — `findBestPath`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #065 — Backend: Redis client — implement health-check probe and readiness gate

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/reliability`, `priority/high`, `effort/small`

### Summary
`backend/src/services/redis.js` connects to Redis and is used by the cache layer, session store, Socket.IO adapter, and idempotency keys. But the health check endpoint `GET /api/health` does not verify Redis connectivity — it only returns `{ status: "ok" }`. If Redis is down, the health check still passes, Kubernetes sends traffic, and every request that touches Redis fails with runtime errors.

### Problem Statement
1. **No Redis readiness check**: K8s liveness/readiness probes don't detect Redis failures.
2. **Cascading failures**: a Redis outage causes 500s on cache-dependent endpoints.

### Objectives
- Add a Redis PING to the health check and return degraded status if Redis is unreachable
- Add a Redis-specific readiness endpoint: `GET /api/health/redis`
- Emit prometheus gauge `redis_up` (1 = connected, 0 = disconnected)
- Wire into existing metrics.js pattern

### Scope
- `backend/src/routes/health.js`, `backend/src/routes/readiness.js`, `backend/src/services/redis.js`

### Acceptance Criteria
- Health check returns 200 when Redis is up; returns 503 with `{ status: "degraded", redis: "disconnected" }` when Redis is down
- `redis_up` gauge reflects connectivity
- Existing health-check tests updated

### References
- `backend/src/routes/health.js`, `backend/src/routes/readiness.js`, `backend/src/services/redis.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #066 — Frontend: Replace `useEffect`+`fetch` data-fetching with `@tanstack/react-query` for leaderboard and project detail pages

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/performance`, `priority/high`, `effort/large`

### Summary
`frontend/hooks/queries.ts` provides a minimal query abstraction, but leaderboard and project detail pages use raw `useEffect`+`fetch` patterns with no caching, no stale-while-revalidate, no background refetch, and no retry. Each page navigation refetches data, showing spinners unnecessarily when the data hasn't changed. `frontend/hooks/useAsyncData.ts` is a generic async wrapper without caching. `frontend/lib/queryRetry.ts` defines a retry policy but it's not wired into the actual data-fetching hooks.

### Problem Statement
1. **No caching**: every page visit refetches data.
2. **No SWR**: stale data is discarded, forcing spinners.
3. **Incomplete abstraction**: `queries.ts` has partial coverage only.

### Objectives
- Install `@tanstack/react-query` and create a `QueryClient` with IndexedDB persistence (`persistQueryClient`)
- Convert leaderboard, project detail, donations feed, and dashboard pages to use `useQuery`
- Wire `queryRetryPolicy` as the default retry function
- Use `staleTime: 30_000` for project data (30 second SWR window)
- Preserve existing `QueryErrorFallback` component integration

### Scope
- `frontend/lib/queryClient.ts` (new), `frontend/hooks/queries.ts` (extend), `frontend/pages/leaderboard.tsx`, `frontend/pages/projects/[id].tsx`

### Acceptance Criteria
- Route A → B → back to A: data served from cache with background refetch, no spinner flash
- Offline test: cached data renders without network; stale indicator shown
- No regression on existing page behavior

### References
- `frontend/hooks/queries.ts`, `frontend/lib/queryRetry.ts`, `frontend/lib/queryErrors.ts`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #067 — Backend: Push notification — implement delivery receipts and retry tracking

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
`backend/src/services/pushService.js`, `pushQueue.js`, and `pushProviders.js` handle push notification delivery via FCM and APNs. Notifications are sent but there is no delivery receipt tracking: the system does not know if a notification was actually delivered to the device, opened, or silently dropped. The `device_tokens` table stores device tokens but has no per-notification delivery status.

### Problem Statement
1. **No delivery confirmation**: operators can't measure notification deliverability.
2. **No retry for transient failures**: FCM/APNs transient errors may drop notifications.

### Objectives
- Add `notification_deliveries` table: `id`, `device_token_id`, `notification_id`, `status` (sent/delivered/failed/opened), `provider_response`, `attempts`, `created_at`
- Parse FCM/APNs delivery receipts (webhook or polling) to update status
- Add `push_delivery_rate` prometheus gauge by platform
- Retry failed deliveries up to 3 times with exponential backoff

### Scope
- `backend/src/services/pushService.js`, `backend/src/services/pushProviders.js`, new migration

### Acceptance Criteria
- Integration test: send notification → verify delivery record → verify status transitions
- Gauge shows accurate delivery rate

### References
- `backend/src/services/pushService.js`, `backend/src/services/pushProviders.js`, `backend/src/db/schema.sql` (device_tokens)


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #068 — Frontend: Offline donation queue — conflict resolution when queued donation was already submitted online

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/bug`, `priority/medium`, `effort/medium`

### Summary
`frontend/lib/offlineDonationQueue.ts` implements an IndexedDB-backed queue for offline donations. When connectivity returns, `syncQueuedDonations` calls a processor function for each queued item and removes it if the processor returns `true`. But the processor does not check whether the same donation (identified by `idempotencyKey` or `transactionHash`) was already recorded — either by a Service Worker Background Sync attempt or by another browser tab. This can result in a duplicate donation submission.

### Problem Statement
1. **Duplicate risk**: offline queue may re-submit already-processed donations.
2. **No idempotency-key reuse detection**: the processor ignores the `idempotencyKey` field already in `DonationQueuePayload`.

### Objectives
- Before calling the processor for each queued item, check `GET /api/donations/check-idempotency/:key` (new or existing) for the item's `idempotencyKey`
- If the server already has this idempotency key, skip submission and remove from queue
- Show a toast notification for conflicts: "This donation was already processed while you were offline"

### Scope
- `frontend/lib/offlineDonationQueue.ts` — `syncQueuedDonations`, `Backend/src/routes/donations.js` — new endpoint or reuse existing

### Acceptance Criteria
- E2E test: queue donation offline, submit same donation online via another tab, go online → queued donation skipped with conflict toast
- No duplicate donation records in database

### References
- `frontend/lib/offlineDonationQueue.ts`, `frontend/components/ConnectivityBanner.tsx`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #069 — Contracts: Add configurable deviation-threshold per token in the oracle contract

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
The oracle contract has a `max_deviation_bps` configuration applied globally to all price observations. But XLM/USDC and XLM/BTC have vastly different volatility profiles — a 500 bps (5%) threshold that is appropriate for BTC would falsely reject legitimate USDC observations (which are stablecoin-pegged and shouldn't deviate >1%). Conversely, a 50 bps threshold for USDC would make the BTC price feed unusable.

### Problem Statement
1. **One-size-fits-all threshold**: the same deviation tolerance applies to all assets.
2. **Cannot support both stablecoins and volatile assets**: adding a new asset requires choosing a threshold that's wrong for one of them.

### Objectives
- Add `token_max_deviation_bps: Map<Address, u32>` config storage
- `report_price` reads the per-token threshold, falling back to the global default if unset
- Add `set_token_deviation(admin, token, bps)` entrypoint
- Add `get_token_config(token) -> TokenOracleConfig` read function

### Scope
- `contracts/oracle-contract/src/lib.rs` — new storage, entrypoints, read path

### Acceptance Criteria
- Set per-token threshold of 50 bps for USDC, 500 bps for BTC → each token follows its own threshold
- Fallback to global default when per-token threshold is unset
- `cargo test --features testutils -p oracle-contract` passes

### References
- `contracts/oracle-contract/src/lib.rs` — `report_price`, `max_deviation_bps`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #070 — Backend: CO₂ verification pipeline — mock-server test harness for Gold Standard, Verra, and GFW APIs

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/testing`, `priority/high`, `effort/medium`

### Summary
`backend/src/services/co2Verifier.js` queries external APIs (Gold Standard, Verra, Global Forest Watch) but the test file `co2Verifier.test.js` likely mocks at the HTTP client level rather than testing with realistic API response shapes. If any external API changes its response schema, the verifier silently breaks — and it won't be caught until the weekly cron runs on production.

### Problem Statement
1. **No contract testing**: API schema changes go undetected.
2. **No CI coverage**: the weekly verification pipeline is untested in CI.

### Objectives
- Implement mock HTTP servers for Gold Standard, Verra, and GFW using `nock` or a test server fixture with real response schemas
- Test the full `verifyProjectCO2Rate` pipeline end-to-end with mock responses
- Test edge cases: empty results, rate-limit responses (429), malformed JSON, timeout
- Add a CI step that runs these integration tests against the mock servers

### Scope
- `backend/__tests__/co2Verifier.integration.test.js` (new)
- New `backend/__tests__/fixtures/` with sample API responses

### Acceptance Criteria
- All major code paths in `co2Verifier.js` exercised via mock servers
- Rate-limit path, empty-results path, and malformed-response path all tested

### References
- `backend/src/services/co2Verifier.js`, `backend/src/services/co2Verifier.test.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #071 — Frontend: Visual regression testing with Storybook + Chromatic or Playwright screenshot comparison

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/testing`, `priority/medium`, `effort/large`

### Summary
The frontend has 11 Storybook stories (`*.stories.tsx`) and Playwright E2E tests, but no visual regression testing. A CSS change that breaks the donation form layout or a dark-mode regression passes CI because unit and E2E tests don't capture visual regressions. The `frontend/__tests__/` directory has DOM-based tests but no screenshot diffing.

### Problem Statement
1. **No visual regression detection**: CSS/layout bugs pass CI silently.
2. **Dark mode untested visually**: `ThemeToggle` changes are not verified.

### Objectives
- Add Playwright screenshot comparison tests for all critical pages (home, project detail, leaderboard, donate, governance, dashboard) in both light and dark modes
- Configure a baseline storage strategy (local or Chromatic)
- Add a CI job (`frontend-visual.yml`) that diffs against approved baselines
- Document baseline-update process for intentional design changes

### Scope
- `frontend/e2e/visual/` (new), `.github/workflows/frontend-visual.yml` (new)

### Acceptance Criteria
- Intentional layout change → CI fails with visual diff → approved baseline → CI passes
- Both light and dark mode screenshots cover all critical pages

### References
- `frontend/playwright.config.ts`, `frontend/e2e/`, `frontend/components/`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #072 — Backend: Rate limiter — per-endpoint granular configuration

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
`backend/src/middleware/rateLimitConfig.js` defines global rate-limit windows and max requests. But a single rate limit applies to all endpoints: donation recording (`POST /api/donations`) shares the same budget as project listing (`GET /api/projects`). A user browsing the project catalog should not consume budget that the donation endpoint needs. The rate limiter is configurable but not per-route.

### Problem Statement
1. **One budget for all**: reads and writes share the same limit.
2. **Cannot protect critical endpoints independently**: donations and project creation need separate budgets.

### Objectives
- Extend `rateLimitConfig.js` to support per-route overrides via path-pattern matching
- `POST /api/donations` → stricter limit (e.g., 10/min)
- `GET /api/projects` → generous limit (e.g., 100/min)
- `POST /api/admin/*` → admin endpoints with separate budget
- Config stays backward-compatible: routes without specific overrides use the global default

### Scope
- `backend/src/middleware/rateLimitConfig.js`, `backend/src/middleware/rateLimiter.js`

### Acceptance Criteria
- Rate-limit test: hit donation endpoint 10 times → 429 on 11th; project listing still works
- Config test: verify path-pattern matching, default fallback

### References
- `backend/src/middleware/rateLimiter.js`, `backend/src/middleware/rateLimitConfig.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #073 — Mobile: Automated EAS Update over-the-air (OTA) deployment with version gating

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/mobile`, `type/devops`, `priority/medium`, `effort/medium`

### Summary
The mobile app uses `expo-updates` (configured in `app.json`) but there is no CI/CD pipeline for EAS Update OTA deployments. Every fix requires a full app-store build and review. The `eas.json` file configures build profiles but has no `updates` configuration. OTA updates would allow pushing JavaScript-layer fixes to users' devices immediately without app-store review.

### Problem Statement
1. **No OTA pipeline**: every JS fix requires a full build + store review.
2. **No version gating**: an OTA update could be pushed to incompatible native builds.

### Objectives
- Add `eas update` configuration to CI: on merge to main, run `eas update --branch production --message "$(git log -1 --oneline)"`
- Implement runtime version check: refuse to apply updates if the native runtime version is incompatible (semver major mismatch)
- Add a staged rollout: `eas update --branch staging` first, then promote
- Add mobile OTA deployment job to `.github/workflows/mobile.yml`

### Scope
- `mobile/app.json`, `mobile/eas.json`, `.github/workflows/mobile.yml`

### Acceptance Criteria
- Merge to main triggers OTA update to "staging" channel
- Manual promotion from staging to production via workflow dispatch
- Incompatible native version rejects the update gracefully

### References
- `mobile/app.json`, `mobile/eas.json`, `.github/workflows/mobile.yml`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #074 — Backend: Dry-run mode for migration runner with rollback plan generation

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/reliability`, `priority/medium`, `effort/medium`

### Summary
`backend/src/db/migrate.js` applies migrations sequentially in a transaction (where DDL supports transactional DDL). But there is no dry-run mode: the operator cannot preview what a migration will do before it runs. There is no rollback plan generation — if a migration corrupts data, the only fallback is database restore.

### Problem Statement
1. **No dry-run**: migration side effects are invisible until execution.
2. **No rollback plan**: every migration is forward-only.

### Objectives
- `npm run migrate:dry-run` — parses migration SQL and logs the DDL statements without executing them
- `npm run migrate:plan-rollback` — for the LAST applied migration, generate a best-effort rollback SQL (DROP for CREATE, re-add for DROP, etc.)
- Document the limitations: rollback plan is a starting point, not a guarantee

### Scope
- `scripts/migrate-dry-run.js` (new), `scripts/migrate-plan-rollback.js` (new), `backend/src/db/migrate.js`

### Acceptance Criteria
- `migrate:dry-run` outputs all pending DDL without executing
- `migrate:plan-rollback` outputs a rollback for the most recent migration
- Both scripts exit 0 but output warnings for destructive operations

### References
- `backend/src/db/migrate.js`, `backend/src/db/migrations/`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #075 — Frontend: WalletConnect — multi-wallet support beyond Freighter (Albedo, xBull, Ledger via WalletConnect)

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/feature`, `priority/high`, `effort/large`

### Summary
`frontend/components/WalletConnect.tsx` and `frontend/lib/WalletProvider.tsx` only support Freighter. `frontend/lib/wallets/` suggests a multi-wallet abstraction is planned but not implemented. The Stellar ecosystem has several popular wallets (Albedo, xBull, Rabet, Lobstr) but donors must use Freighter or cannot donate. Freighter's ~20% adoption among Stellar users means 80% of potential donors are excluded.

### Problem Statement
1. **Single-wallet lock-in**: only Freighter users can donate.
2. **No wallet abstraction**: `WalletProvider.tsx` is Freighter-specific.

### Objectives
- Implement a wallet adapter abstraction supporting Freighter, Albedo, xBull, and WalletConnect (for mobile wallets)
- Use `@stellar/wallet-sdk` or a Stellar-compatible wallet adapter pattern
- `WalletConnect.tsx` shows a wallet-picker modal with all supported wallets
- Each wallet sign transaction via its own API; the rest of the flow is wallet-agnostic

### Scope
- `frontend/lib/WalletProvider.tsx` — refactor to adapter pattern
- `frontend/components/WalletConnect.tsx` — multi-wallet picker
- `frontend/lib/wallets/` — per-wallet adapter modules

### Acceptance Criteria
- Integration test: connect with Freighter, Albedo (mock), and xBull (mock)
- Donate flow works with each wallet
- Network/account switching handled per-wallet

### References
- `frontend/components/WalletConnect.tsx`, `frontend/lib/WalletProvider.tsx`, `frontend/lib/wallets/`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #076 — Contracts: IndigoPay `DataKey` enum — document and enforce ordering invariants for backward compatibility

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/security`, `priority/high`, `effort/medium`

### Summary
The `DataKey` enum has 60+ variants. The comment on `DonorRateLimitPerToken` says it is "Appended to preserve the discriminants of all previously deployed DataKey variants" — but there is no CI gate that detects accidental reordering of `DataKey` variants. A maintainer could insert a variant in the middle instead of at the end, shifting all subsequent discriminants by 1 and silently corrupting every storage entry that uses those variants on upgraded contracts. There is no test that asserts the ordering is strictly append-only.

### Problem Statement
1. **No ordering guard**: a mid-insert corrupts all storage silently.
2. **No deterministic discriminant test**: tests don't assert specific discriminant values.

### Objectives
- Add a compile-time or test-time assertion that every `DataKey` variant appears in a specific order and no variant is inserted before existing ones
- Generate variant discriminants from the enum definition and compare against a committed golden file (`DataKey.discriminants.txt`)
- Add a CI step in `contracts.yml` that fails if discriminants change in any way other than append-only

### Scope
- `contracts/indigopay-contract/src/lib.rs` — new test, golden file
- `.github/workflows/contracts.yml` — new step

### Acceptance Criteria
- CI fails when a variant is inserted in the middle of DataKey
- CI passes when a variant is appended at the end (and golden file is updated)
- No runtime overhead (compile-time or test-time only)

### References
- `contracts/indigopay-contract/src/lib.rs` — `DataKey` enum, UPGRADE.md


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #077 — Backend: Webhook delivery — exponential backoff with jitter for retry scheduling

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/reliability`, `priority/medium`, `effort/small`

### Summary
`backend/src/services/webhookQueue.js` manages webhook delivery jobs with pg-boss. The current retry configuration likely uses pg-boss's default retry backoff (fixed delay or simple exponential). But during a receiver outage, synchronized retries from multiple donors hitting the same endpoint create a thundering herd — all retries fire at the same time, overwhelming the receiver again. Adding jitter (randomized delay) spreads retries across the backoff window.

### Problem Statement
1. **No jitter**: synchronous retries create thundering herds.
2. **No per-endpoint retry budget**: a single failing endpoint can consume all retry capacity.

### Objectives
- Configure pg-boss webhook jobs with `retryBackoff: true` and implement a custom backoff function: `delay = min(base * 2^attempt, maxDelay) * (0.5 + random() * 0.5)` (full jitter)
- Add per-endpoint retry budget: max 6 attempts per endpoint per window before DLQ
- Emit `webhook_retry_count` and `webhook_jitter_seconds` metrics

### Scope
- `backend/src/services/webhookQueue.js`, `backend/src/services/webhook.js`

### Acceptance Criteria
- Test: mock receiver returns 503 for 3 attempts → verify each attempt's delay includes jitter (variance > 0)
- Thundering herd test: 10 simultaneous failing webhooks → retries spread across backoff window

### References
- `backend/src/services/webhookQueue.js`, `backend/src/services/webhook.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #078 — Frontend: Leaderboard — time-window filtering with historical trend charts

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
The leaderboard page (`frontend/pages/leaderboard.tsx`) shows all-time donation rankings. There is no time-window filter (this week, this month, this year) and no historical trend visualization. A donor who discovers the platform can only see all-time totals, which makes the leaderboard appear static and discourages new donors who can never catch up.

### Problem Statement
1. **Static all-time rankings only**: no time-window context.
2. **No trend visualization**: no charts showing donation patterns over time.

### Objectives
- Add time-window tabs: All-time, This Month, This Week
- Add a `DonationGrowthChart` showing the selected time window's donation volume trend
- Backend: add `GET /api/leaderboard?window=month|week|all` with `startDate`/`endDate`
- Project leaderboards too: which projects raised the most this month

### Scope
- `frontend/pages/leaderboard.tsx`, `frontend/components/LeaderboardTable.tsx`, `frontend/components/DonationGrowthChart.tsx`
- `backend/src/routes/leaderboard.js` — new query params

### Acceptance Criteria
- Time-window tabs change leaderboard rankings correctly
- Chart renders donation trend for selected window
- Backend window parameter filters donations by `created_at`

### References
- `frontend/pages/leaderboard.tsx`, `frontend/components/LeaderboardTable.tsx`, `backend/src/routes/leaderboard.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #079 — Contracts: Escrow — implement `get_job_page` for paginated job listing

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
The escrow contract stores jobs indexed by `JobIds` (a `Vec<String>`) with a `MAX_JOBS = 256` limit. Reading all jobs requires N individual `get_job` calls — one per `JobId` entry. There is no paginated read. Backend indexers and frontend freelancer marketplaces must issue up to 256 RPC calls to fetch all jobs followed by individual `get_job` reads.

### Problem Statement
1. **O(n) RPC calls**: listing all jobs is inefficient.
2. **No pagination**: every consumer incurs the full scan.

### Objectives
- Implement `get_job_page(env, from: u32, count: u32) -> Vec<Job>` that reads `count` jobs starting at `from` in the `JobIds` vector
- Cap `count` at `MAX_PAGE_SIZE` (e.g., 50) to stay within resource budget
- Keep existing `get_job` single-read function unchanged

### Scope
- `contracts/escrow-contract/src/lib.rs` — new read function

### Acceptance Criteria
- Unit test for empty page, partial page, full page, out-of-bounds `from`
- Gas comparison: N+1 single reads vs single page read, documented

### References
- `contracts/escrow-contract/src/lib.rs` — `JobIds`, `MAX_JOBS`, `get_job`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #080 — Frontend: Accessibility — `aria-live` regions for `LiveDonationTicker`, `LeaderboardTable`, and `DonationFeed`

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/accessibility`, `priority/high`, `effort/medium`

### Summary
The `LiveDonationTicker.tsx` uses Socket.IO to push real-time donations and animates them into the DOM. Screen readers receive no announcement of new donations. `LeaderboardTable.tsx` updates rankings live — screen readers cannot detect ranking changes. Both are dynamic regions with no `aria-live` attributes, making the real-time experience invisible to screen-reader users.

### Problem Statement
1. **No screen-reader announcements**: live updates are silent to AT.
2. **Dynamic content invisible**: ranking changes and new donations go unannounced.

### Objectives
- Add `aria-live="polite"` region wrapping `LiveDonationTicker` content with announcements like "New donation: 50 XLM to Project X"
- Add `aria-live="polite"` region wrapping `LeaderboardTable` with announcements when a donor changes rank
- Debounce announcements: max 1 per 2 seconds to avoid overwhelming screen readers
- Ensure `DonationFeed` new items receive `aria-label` with donor/amount/project

### Scope
- `frontend/components/LiveDonationTicker.tsx`, `frontend/components/LeaderboardTable.tsx`, `frontend/components/DonationFeed.tsx`

### Acceptance Criteria
- Screen-reader test (jest-axe + manual): new donation announced within 2 seconds
- Axe audit passes on all three components (no `aria-live` violations)

### References
- `frontend/components/LiveDonationTicker.tsx`, `frontend/components/LeaderboardTable.tsx`, `frontend/components/DonationFeed.tsx`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #081 — CI/CD: Contract WASM size regression alerting in CI

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/devops`, `type/ci`, `priority/high`, `effort/small`

### Summary
The Soroban network enforces a 64 KB contract WASM size limit. The CI `contracts.yml` builds WASM artifacts but does not track WASM size across commits. A dependency update or new feature could silently approach the 64 KB limit, and the first warning would be a failed deploy (or worse, a failed mainnet upgrade proposal). There is no budget tracking and no alerting.

### Problem Statement
1. **No size budget**: WASM size regressions are invisible until hitting the hard cap.
2. **No historical tracking**: operators don't know the current WASM size without manual inspection.

### Objectives
- Add a CI step that records WASM sizes (wasm-opt stripped) to a JSON artifact on every PR
- Compare against the `main` branch baseline: flag a warning comment on PR if size increases by >5%
- Fail CI if any contract exceeds 60 KB (leaving 4 KB budget headroom)
- Publish sizes to a small GitHub Pages or artifact dashboard for trending

### Scope
- `.github/workflows/contracts.yml` — new step
- `scripts/check-wasm-size.js` (new)

### Acceptance Criteria
- PR adds a large dependency → CI comment: "IndigoPay WASM size increased by 8% (52 KB → 56 KB). Review before merging."
- Any contract over 60 KB fails CI

### References
- `.github/workflows/contracts.yml`, `contracts/indigopay-contract/Cargo.toml`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #082 — Backend: Horizon indexer — checkpoint/restart from specific ledger

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/reliability`, `priority/medium`, `effort/medium`

### Summary
`backend/src/services/indexerService.js` and `sorobanEventService.js` stream events from Horizon SSE and Soroban RPC. If the indexer crashes or is restarted, it starts from the last processed cursor (stored in the database). But there is no way to force-restart from a specific ledger — for example, to re-process a ledger range after a bug fix. Operators must manually manipulate the cursor in the database.

### Problem Statement
1. **No manual rescan**: re-indexing a ledger range requires DB manipulation.
2. **No checkpoint verification**: the last-processed cursor may be corrupted silently.

### Objectives
- `POST /api/admin/indexer/rescan` — accepts `{ fromLedger: number, toLedger: number }` and re-processes the range
- `GET /api/admin/indexer/checkpoint` — returns the current cursor ledger and timestamp
- Store checkpoints with a CRC/hash of the cursor value to detect corruption

### Scope
- `backend/src/services/indexerService.js`, `backend/src/services/sorobanEventService.js`, `backend/src/routes/admin.js`

### Acceptance Criteria
- Rescan test: inject events for ledgers 100-105, rescan 100-103 → only those 4 re-processed
- Checkpoint verification test: corrupt cursor → detected on next read

### References
- `backend/src/services/indexerService.js`, `backend/src/services/sorobanEventService.js`, `backend/src/services/indexerReconciler.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #083 — Frontend: Project detail page — skeleton loading states with `ProjectDetailSkeleton`

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/performance`, `priority/low`, `effort/small`

### Summary
`frontend/components/ProjectDetailSkeleton.tsx` and `DashboardSkeleton.tsx` already exist but are not consistently used. Project detail pages still show a full-page spinner or unstyled loading state rather than layout-matching skeleton screens. This causes layout shift when data loads, reducing perceived performance.

### Problem Statement
1. **Inconsistent loading states**: some pages use spinners, some use skeletons.
2. **Layout shift**: spinner → content causes a jarring re-layout.

### Objectives
- Wire `ProjectDetailSkeleton` into the project detail page
- Wire `DashboardSkeleton` into the dashboard page
- Add `LeaderboardSkeleton` (already exists) to leaderboard page
- Add `DonorProfileSkeleton` (already exists) to donor profile page
- Ensure all skeletons match the exact dimensions of the loaded content to eliminate layout shift

### Scope
- `frontend/pages/projects/[id].tsx`, `frontend/pages/dashboard.tsx`, `frontend/pages/leaderboard.tsx`
- `frontend/components/ProjectDetailSkeleton.tsx`, etc.

### Acceptance Criteria
- Page navigates → skeleton renders immediately → content fades in with zero layout shift
- Verified via Playwright: measure element positions before/after content load

### References
- `frontend/components/ProjectDetailSkeleton.tsx`, `frontend/pages/projects/[id].tsx`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #084 — Backend: Auth — add email/password admin login as alternative to wallet-based auth for operators

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
Admin authentication supports JWT access tokens + refresh tokens, and X-Admin-Key header authentication. But there is no password-based initial authentication — admins must have a pre-shared API key. For admin dashboards and operator tooling, a standard email/password login with MFA would be more practical than managing API keys. The JWT infrastructure already exists; only the initial credential exchange is missing.

### Problem Statement
1. **No password auth**: admins can only use pre-shared API keys.
2. **No MFA**: no second factor for admin operations.

### Objectives
- Add `admins` table: `id`, `email`, `password_hash` (bcrypt), `mfa_secret`, `created_at`
- `POST /api/admin/auth/login` — email + password → access + refresh tokens
- `POST /api/admin/auth/mfa/setup` — generate TOTP secret and QR code
- `POST /api/admin/auth/mfa/verify` — verify TOTP code, enable MFA
- `POST /api/admin/auth/login` — if MFA enabled, require TOTP code
- Keep existing X-Admin-Key path for CI/bot access

### Scope
- New migration, `backend/src/routes/admin/auth.js`, `backend/src/middleware/auth.js` (extend)

### Acceptance Criteria
- Email/password login works; MFA setup + verification roundtrip succeeds
- Both auth methods coexist; existing admin-key auth unchanged

### References
- `backend/src/middleware/auth.js`, `backend/src/routes/admin.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #085 — Frontend: Internationalization (i18n) — complete the `es.json` and `fr.json` locale files

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/feature`, `priority/medium`, `effort/large`

### Summary
`frontend/locales/es.json` and `frontend/locales/fr.json` have sparse translations — most UI strings fall back to English. The `LanguageSwitcher.tsx` component lets users select a language that is only partially translated, resulting in a mix of Spanish/French navigation labels and English content. The i18n infrastructure (next-i18next or similar) exists but the locale files are incomplete.

### Problem Statement
1. **Partial translations**: language switcher gives a broken mixed-language experience.
2. **No RTL support**: no Hebrew, Arabic, or other RTL language support.

### Objectives
- Complete `es.json` and `fr.json` with translations for all UI strings (navigation, forms, buttons, error messages, notifications)
- Add `frontend/lib/i18n.tsx` RTL detection and CSS direction switching
- Add a CI step verifying that all locale files have the same key set as `en.json`
- Add translation coverage metric

### Scope
- `frontend/locales/es.json`, `frontend/locales/fr.json`, `frontend/lib/i18n.tsx`
- `.github/workflows/frontend.yml` — locale parity check

### Acceptance Criteria
- Zero fallback-to-English strings in es/fr on all pages
- CI fails when a key is present in `en.json` but missing in other locales
- RTL layout test: mock Arabic locale → page renders right-to-left

### References
- `frontend/locales/es.json`, `frontend/locales/fr.json`, `frontend/locales/en.json`, `frontend/components/LanguageSwitcher.tsx`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #086 — Backend: Database failover — automated health-check and primary promotion for PostgreSQL streaming replication

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/devops`, `type/reliability`, `priority/high`, `effort/large`

### Summary
The k8s manifests (`k8s/postgres.yaml`, `k8s/postgres-standby.yaml`, `k8s/postgres-failover-job.yaml`) set up a primary + standby PostgreSQL topology with failover scripts. `scripts/setup-replication.sh` configures streaming replication. But the failover job is a Kubernetes CronJob that runs periodically — it doesn't react to primary failure in real-time. If the primary crashes between cron ticks, the platform runs with a read-only (or fully unavailable) database until the next cron execution.

### Problem Statement
1. **Periodic failover, not reactive**: failover only happens on the cron schedule.
2. **No health-check-driven promotion**: the standby doesn't auto-promote on primary failure.

### Objectives
- Implement a sidecar container or daemon that runs alongside PostgreSQL, continuously health-checking the primary via `pg_isready`
- On primary failure (3 consecutive failed checks), trigger the failover: promote the standby, update the service selector to point to the new primary
- Implement a split-brain prevention mechanism using a Kubernetes Lease or ConfigMap lock
- Add Prometheus alert when failover occurs (it should be an exceptional event)

### Scope
- `k8s/postgres-failover-job.yaml` — replace/supplement with daemon, `scripts/setup-replication.sh`

### Acceptance Criteria
- Simulate primary crash → standby promoted within 30 seconds → service routes to new primary
- Split-brain test: two nodes both attempt promotion → only one succeeds (lock held)

### References
- `k8s/postgres.yaml`, `k8s/postgres-standby.yaml`, `k8s/postgres-failover-job.yaml`, `scripts/setup-replication.sh`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #087 — Contracts: Oracle — implement `get_price_at_ledger` for historical TWAP queries

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
The oracle contract stores individual `PriceObservation` entries indexed by ledger and provides `get_price()` returning the current TWAP. But there is no historical price lookup — `get_price_at_ledger(ledger)` would allow attestation settlement and dispute resolution to reference the exact price at the time of a donation rather than the current price, eliminating a source of settlement-time arbitrage.

### Problem Statement
1. **No historical prices**: all queries return current TWAP only.
2. **Settlement-time mismatch**: attestation settlement uses current price, not donation-time price.

### Objectives
- Implement `get_price_at_ledger(env, ledger: u32) -> Option<i128>` returning the TWAP computed up to and including `ledger`
- Walk back through `PriceObservation` entries from most recent to `ledger`, computing the TWAP over the window
- Return `None` if no observations exist on or before `ledger`

### Scope
- `contracts/oracle-contract/src/lib.rs` — new read function

### Acceptance Criteria
- Unit test: record observations at ledgers 10, 20, 30 → `get_price_at_ledger(15)` returns TWAP over ledgers [10, 20]
- Edge case: `get_price_at_ledger(5)` returns None (no observations)

### References
- `contracts/oracle-contract/src/lib.rs` — `PriceObservation`, `get_price`, `current_price_raw`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #088 — Frontend: `GlobalSearchModal` — integrate with PostgreSQL full-text search for project discovery

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/performance`, `priority/medium`, `effort/medium`

### Summary
`frontend/components/GlobalSearchModal.tsx` provides a project search interface, but it currently relies on client-side filtering of fetched project data or a simple `ILIKE` query on the backend. The database already has a `projects_search_idx` GIN index on `search_vector` (a tsvector column maintained by a trigger) and `ts_rank` capability. But the search endpoint doesn't use it — substring matching is slower and less relevant than full-text search with ranking.

### Problem Statement
1. **No full-text search**: `ILIKE` substring matching ignores relevance ranking.
2. **Unused infrastructure**: the GIN index and tsvector trigger are already built.

### Objectives
- Update `GET /api/projects?q=...` to use `ts_rank` + `ts_query` against `search_vector` when a query is present
- `GlobalSearchModal.tsx` shows results ranked by relevance with highlighted matching terms
- Debounce search input by 300ms to avoid hammering the endpoint

### Scope
- `backend/src/routes/projects.js` — update query, `frontend/components/GlobalSearchModal.tsx`

### Acceptance Criteria
- Search "forest restoration" returns projects matching "forest" OR "restoration", ranked by relevance
- Partial-word search still works (via `to_tsquery` prefix matching: `forest:*`)
- Response time < 100ms (GIN-indexed)

### References
- `frontend/components/GlobalSearchModal.tsx`, `backend/src/routes/projects.js`, `backend/src/db/schema.sql`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #089 — Backend: Stellar transaction — add fee-bump support for stuck donations

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/feature`, `priority/low`, `effort/medium`

### Summary
During network congestion, a submitted donation transaction may sit in the mempool for minutes without inclusion because the fee is too low. Stellar supports fee bumps (a separate account can pay additional fee to accelerate an existing transaction). The backend's `recurringKeeper` submits transactions with hardcoded fees and `turrets.js` has no fee-bump capability. If a recurring donation gets stuck, it fails silently.

### Problem Statement
1. **No fee bump**: stuck transactions stay stuck.
2. **No mempool monitoring**: the keeper doesn't know if its transaction was included.

### Objectives
- After submitting a transaction, poll `horizon.transactions().transaction(hash)` for up to 60 seconds
- If not included after 30 seconds, build and submit a fee-bump transaction with a higher fee
- Cap at 3 fee-bump attempts before logging as failed
- Integration with the keeper and matching services

### Scope
- `backend/src/services/stellar.js` — `submitWithFeeBump`, `recurringKeeper.js`, `turrets.js`

### Acceptance Criteria
- Mock: submit tx → not included after 30s → fee-bump submitted → inclusion verified
- Cap at 3 attempts; no infinite fee escalation

### References
- `backend/src/services/stellar.js`, `backend/src/services/recurringKeeper.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #090 — Frontend: Storybook — add interaction tests for interactive components

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/testing`, `priority/medium`, `effort/medium`

### Summary
The frontend has 11 Storybook stories but all are display-only (autodocs). There are no `play` functions for interaction testing: clicking buttons, filling forms, toggling theme, opening modals. Storybook's `@storybook/test` and `@storybook/testing-library` support click, type, and assertion interactions directly in stories — but none are used.

### Problem Statement
1. **No interaction testing**: stories are catalog-only, not behavior verification.
2. **Unused Storybook capability**: `play` functions and test runner not wired.

### Objectives
- Add `play` functions to interactive stories: `DonateForm` (fill form, submit), `WalletConnect` (click connect), `ThemeToggle` (click toggle), `DonationModal` (open, click share)
- Add Storybook test runner to CI (`frontend.yml`): `npx test-storybook`
- Stories serve as both documentation and behavior tests

### Scope
- `frontend/components/*.stories.tsx`, `.github/workflows/frontend.yml`

### Acceptance Criteria
- CI runs storybook tests: 11 stories pass with interaction assertions
- New interactive stories added for DonateForm, WalletConnect, ThemeToggle, DonationModal

### References
- `frontend/components/DonateForm.stories.tsx`, `frontend/components/WalletConnect.stories.tsx`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #091 — Backend: Admin audit log — record all admin actions with before/after state

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/security`, `priority/high`, `effort/medium`

### Summary
Admin actions (project verification approval, admin key rotation, contract upgrades, emergency withdrawals) mutate critical state. But there is no audit log recording who performed which action, when, and what changed. The existing `auditChain.js` records data changes via hash chains but only covers automated donation events — not admin-initiated changes. An insider threat or compromised admin key could make silent changes with no traceability.

### Problem Statement
1. **No admin action log**: admin mutations are invisible in audit.
2. **No before/after state**: hash chains don't capture the semantic change.

### Objectives
- Create `admin_audit_log` table: `id`, `admin_id`, `action` (string), `resource_type`, `resource_id`, `before_state` (JSONB), `after_state` (JSONB), `ip_address`, `user_agent`, `created_at`
- Middleware or service wrapper that records audit entries on every admin mutation
- `GET /api/admin/audit-log?from=X&to=Y` endpoint for review
- Immutable: no UPDATE/DELETE on `admin_audit_log` — append-only

### Scope
- New migration, `backend/src/services/adminAudit.js` (new), `backend/src/routes/admin.js`

### Acceptance Criteria
- Admin approves verification → audit row recorded with before (pending) and after (approved)
- Audit endpoint returns paginated log
- No UPDATE/DELETE possible on the audit log table

### References
- `backend/src/services/auditChain.js`, `backend/src/routes/admin.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #092 — Contracts: Attestation — implement `get_pending_attestations_by_chain` for relayer efficiency

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/performance`, `priority/medium`, `effort/medium`

### Summary
The attestation contract stores all attestations indexed by `id` (sequential). A relayer that monitors only Ethereum (source_chain = "ethereum") must call `get_attestation(i)` for every `i` from 1 to `total_count` to find pending Ethereum attestations — O(n) RPC calls. There is no chain-filtered pagination.

### Problem Statement
1. **O(n) chain filtering**: relayers waste RPC calls scanning all chains.
2. **No per-chain index**: attestations are only indexed by global id.

### Objectives
- Add `DataKey::ChainIndex(source_chain, attestation_id) -> u64` mapping
- Add `get_pending_attestations_by_chain(env, source_chain, from, count) -> Vec<Attestation>`
- Update `record_attestation` to append to the chain index

### Scope
- `contracts/attestation-contract/src/lib.rs` — new index, read function, record path update

### Acceptance Criteria
- Record attestations on ethereum and polygon → get_pending by ethereum returns only ethereum
- Gas cost comparison: O(n) scan vs O(1) chain-filtered page

### References
- `contracts/attestation-contract/src/lib.rs` — `record_attestation`, `get_attestation`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #093 — Frontend: `ProjectMap` — cluster markers and lazy-load map tiles

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/frontend`, `type/performance`, `priority/medium`, `effort/medium`

### Summary
`frontend/components/ProjectMap.tsx` renders all project markers on a world map. For 100+ projects, every marker is rendered as a DOM node (or canvas element), and the map becomes unresponsive. There is no marker clustering (grouping nearby markers into a single numbered cluster at low zoom) and no lazy tile loading.

### Problem Statement
1. **No marker clustering**: 100+ markers cause jank.
2. **Eager tile loading**: all tiles load regardless of viewport.

### Objectives
- Implement marker clustering (using `supercluster` or leaflet.markercluster) — nearby markers merge into a numbered cluster badge at low zoom levels
- Implement lazy tile loading: tiles outside the viewport are not fetched
- Add `ProjectMapMarker.tsx` (already exists) for individual project popups

### Scope
- `frontend/components/ProjectMap.tsx`, `frontend/components/ProjectMapMarker.tsx`

### Acceptance Criteria
- 200 markers at zoom level 3 → ~10 cluster badges, not 200 individual markers
- Zoom into cluster → markers fan out
- Map renders within 2 seconds with 200 projects

### References
- `frontend/components/ProjectMap.tsx`, `frontend/components/ProjectMapMarker.tsx`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #094 — Backend: Email service — DKIM/SPF/DMARC validation for outbound emails

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/reliability`, `priority/medium`, `effort/medium`

### Summary
`backend/src/services/email.js` sends transactional emails (digest, project updates, subscription notifications). There is no check that the sending domain has valid SPF/DKIM/DMARC records configured. Emails from misconfigured domains land in spam folders or are silently rejected by receiving mail servers — and operators have no visibility into deliverability.

### Problem Statement
1. **No domain validation**: misconfigured DNS means emails go to spam.
2. **No deliverability metrics**: no bounce tracking or spam-report monitoring.

### Objectives
- At startup (or on a health-check endpoint), verify the MAIL FROM domain has SPF and DKIM records
- Warn on missing records; the service still runs but logs a prominent warning
- Add a `email_delivery_status` table tracking bounces and complaints via SNS/webhook or SMTP DSN
- `GET /api/admin/email/deliverability` showing sent/delivered/bounced/complained counts

### Scope
- `backend/src/services/email.js`, new migration, new admin endpoint

### Acceptance Criteria
- Startup check: missing SPF → warning logged, service starts
- Bounce webhook integration: Gmail bounce → `email_delivery_status` row recorded

### References
- `backend/src/services/email.js`, `backend/src/services/notificationService.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #095 — Mobile: Push notification — deep-link payload handling and notification grouping

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/mobile`, `type/feature`, `priority/medium`, `effort/medium`

### Summary
The mobile app receives push notifications via `expo-notifications` but the notification tap handler does not parse deep links: tapping a "New donation on Project X" notification opens the home screen, not the project detail page. Additionally, multiple notifications from the same project are not grouped — the notification tray shows separate entries instead of a single expandable group.

### Problem Statement
1. **No deep-link handling**: notification taps don't navigate to the relevant screen.
2. **No grouping**: notification tray clutter.

### Objectives
- Implement notification tap handler parsing `data.screen` and `data.params` payload
- Navigate to the correct Expo Router screen: `donate/[projectId]`, `projects/[id]`, `leaderboard`, etc.
- Implement Android notification grouping using `expo-notifications` category/group identifiers per project
- iOS: use `thread-id` for grouping

### Scope
- `mobile/app/_layout.tsx` — notification tap handler, `mobile/app/notifications.tsx`

### Acceptance Criteria
- Tap notification → navigates to the correct screen with params
- Multiple notifications from same project → grouped on Android and iOS

### References
- `mobile/app/_layout.tsx`, `mobile/app/notifications.tsx`, `mobile/components/`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #096 — Backend: API versioning — deprecation headers and sunset timeline

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/architecture`, `priority/medium`, `effort/medium`

### Summary
`backend/src/middleware/apiVersion.js` handles version routing but has no deprecation mechanism. If a v1 endpoint is superseded by v2, there is no way to inform API consumers: no `Deprecation` or `Sunset` HTTP headers, no warning in responses. Consumers discover the change when v1 breaks.

### Problem Statement
1. **No deprecation signal**: API consumers can't detect upcoming changes.
2. **No sunset policy**: no documented lifecycle for API versions.

### Objectives
- Add `Deprecation: true` and `Sunset: <ISO8601 date>` headers to deprecated endpoints
- Add warning in response body: `{"warning": "This endpoint is deprecated and will be removed on 2026-12-31. Use POST /api/v2/donations instead."}`
- `GET /api/versions` listing active, deprecated, and sunset API versions with documentation links
- Document API version lifecycle policy in `docs/api.md`

### Scope
- `backend/src/middleware/apiVersion.js`, `backend/src/routes/metrics.js`, `docs/api.md`

### Acceptance Criteria
- Request to deprecated endpoint returns deprecation + sunset headers and body warning
- `GET /api/versions` returns complete version inventory

### References
- `backend/src/middleware/apiVersion.js`, `docs/api.md`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #097 — Contracts: IndigoPay — feature-gated test that validates every `DataKey` variant is readable after migration

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/contracts`, `type/testing`, `priority/medium`, `effort/medium`

### Summary
The contract's `migrate()` function (behind `#![cfg(feature = "upgrade")]`) handles schema migrations when the storage version changes. But there is no exhaustive test that: (1) writes a value to every `DataKey` variant, (2) bumps the storage version, (3) calls `migrate()`, and (4) verifies every value is still readable. A new storage version that accidentally corrupts a rarely-used variant (e.g., `ForceRefund` or `PathPaymentAttester`) would only be discovered when that feature is first used in production.

### Problem Statement
1. **No migration coverage for rare variants**: rarely-used keys may corrupt silently.
2. **No full-enum coverage test**: existing migration tests only cover common paths.

### Objectives
- Write a test that exercises all feature-gated `DataKey` variants by enabling all features in the test build
- For every variant: write a value, bump version, call `migrate()`, read back, assert equality
- Assert the number of tested variants equals the total number of `DataKey` variants (so adding a new variant without a test entry fails CI)

### Scope
- `contracts/indigopay-contract/src/lib.rs` — new `#[cfg(test)]` module

### Acceptance Criteria
- Adding a new `DataKey` variant without adding a test entry fails the assertion on variant count
- Migration test covers all 60+ variants
- `cargo test --features testutils --all-features -p indigopay-contract` passes

### References
- `contracts/indigopay-contract/src/lib.rs` — `DataKey`, `migrate()`, `CURRENT_STORAGE_VERSION`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #098 — Backend: Admin — parameterized query builder for safe analytics exports

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/backend`, `type/security`, `priority/medium`, `effort/medium`

### Summary
`backend/src/services/analyticsService.js` and `analyticsQueryPlans.integration.test.js` suggest analytics queries are hand-crafted with parameterized inputs. But with growing admin reporting needs, there's risk of ad-hoc SQL construction leading to injection vulnerabilities. A parameterized query builder that restricts to a safe subset of SQL operations (SELECT-only, whitelisted columns, mandatory parameterization) would prevent this.

### Problem Statement
1. **Ad-hoc SQL risk**: future analytics queries may introduce injection.
2. **No guardrail**: any admin endpoint can execute arbitrary SQL if not careful.

### Objectives
- Implement a `SafeQueryBuilder` that:
  - Accepts only SELECT queries (rejects INSERT/UPDATE/DELETE/DROP/ALTER)
  - Requires a whitelisted set of columns per table
  - Requires parameterized `$1, $2, ...` placeholders (rejects string interpolation)
  - Enforces `LIMIT` and `OFFSET` bounds
  - Logs all executed queries to admin audit log
- Refactor `analyticsService.js` to use it

### Scope
- `backend/src/services/safeQueryBuilder.js` (new), `backend/src/services/analyticsService.js`

### Acceptance Criteria
- SafeQueryBuilder accepts `SELECT * FROM donations WHERE project_id = $1 LIMIT $2`
- SafeQueryBuilder rejects `DROP TABLE donations`
- SafeQueryBuilder rejects `SELECT * FROM donations WHERE project_id = '${unsafe}'`

### References
- `backend/src/services/analyticsService.js`, `backend/src/db/pool.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #099 — Mobile: Biometric-gated wallet recovery phrase backup with Shamir's Secret Sharing

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/mobile`, `type/security`, `priority/high`, `effort/large`

### Summary
The mobile app stores wallet keys in `expo-secure-store` with optional biometric-gated access (`mobile/lib/secureStore.ts`). But there is no recovery mechanism: if the user loses their device, the wallet is unrecoverable because the secret key was never exported. A Shamir's Secret Sharing scheme would split the recovery phrase into N shares (stored in separate locations: iCloud, email, printed QR codes), requiring K-of-N shares to reconstruct.

### Problem Statement
1. **No wallet recovery**: device loss = wallet loss.
2. **No user-controlled backup**: the app doesn't help users create recoverable backups.

### Objectives
- Implement SSS key splitting: split the Stellar secret key into N shares (default 3-of-5)
- Store shares in: SecureStore (share 1), iCloud/Google Drive (share 2), user's email (share 3)
- Recovery flow: collect K shares → reconstruct key → verify against stored public key hash
- Biometric-gated: splitting and recovery both require biometric authentication

### Scope
- `mobile/lib/wallet/recovery.ts` (new), `mobile/lib/secureStore.ts`, `mobile/app/settings/recovery.tsx` (new)

### Acceptance Criteria
- Split → store 5 shares → destroy original → recover with any 3 shares → key matches
- Recovery fails with 2 shares
- All operations biometric-gated

### References
- `mobile/lib/secureStore.ts`, `mobile/lib/wallet/`, `mobile/hooks/useBiometricAuth.ts`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Issue #100 — Cross-cutting: Chaos engineering test suite — fault injection for donation pipeline resilience

**Labels:** `GrantFox OSS`, `Official Campaign`, `area/testing`, `type/testing`, `priority/high`, `effort/large`

### Summary
The platform has extensive unit and integration tests but no chaos engineering: there's no test that verifies the system's behavior under Redis failure, PostgreSQL primary crash, Stellar Horizon unavailability, Soroban RPC timeout, or network partition between backend and indexer. The `docker-compose.test.yml` spins up dependencies but doesn't inject faults. The resilience patterns (circuit breakers, retries, DLQ, projection catch-up) are individually tested but never tested together under cascading failures.

### Problem Statement
1. **No fault injection**: resilience patterns are tested in isolation, not under realistic cascading failures.
2. **No recovery verification**: the system may recover from individual failures but fail under multiple simultaneous failures.

### Objectives
- Implement a chaos test suite using `docker-compose.test.yml` + fault injection (pause containers, introduce latency, drop packets, kill processes)
- Test scenarios:
  1. Redis crash during donation spike → verify cache degradation, no data loss
  2. PostgreSQL primary failover during donation recording → verify no double-records, idempotency holds
  3. Horizon 503 for 30s during recurring keeper cycle → verify retry + backoff, circuit breaker opens
  4. Soroban RPC timeout during donation → verify retry, eventual recording
- Run as a nightly CI job; results posted to a dashboard

### Scope
- `test/chaos/` (new), `docker-compose.chaos.yml` (new), `.github/workflows/chaos-nightly.yml` (new)

### Acceptance Criteria
- All 4 scenarios pass: system recovers, no data loss, no double-records
- CI nightly job runs chaos tests and reports results

### References
- `docker-compose.test.yml`, `.github/workflows/ci.yml`, `backend/src/services/circuitBreaker.js`


To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)

---

## Summary — Batch 2 (#051–#100)

This second issue set targets additional real, verifiable gaps discovered through deeper code inspection:

- **Backend security & correctness** (#051–#055, #060, #063, #065, #067, #072, #077, #084, #089, #091, #094, #096, #098): donorAuth replay protection, idempotency race condition, admin session management, Turrets idempotency, transaction_hash validation, Redis health check, push delivery receipts, per-endpoint rate limiting, webhook jitter, email auth, fee bumps, admin audit log, DKIM validation, API deprecation headers, safe query builder
- **Contract security & testing** (#054, #056, #059, #069, #076, #079, #087, #092, #097): upgrade flow integration tests, per-token pause, unwrap audit, per-token deviation thresholds, DataKey discriminant ordering, escrow job pagination, historical price queries, chain-filtered attestation indexing, migration full-enum coverage test
- **Frontend features & performance** (#057, #058, #064, #066, #071, #075, #078, #080, #083, #085, #088, #090, #093): DonateForm overhaul, DonationModal, DEX path caching, React Query adoption, visual regression tests, multi-wallet support, leaderboard time windows, aria-live regions, skeleton loading, i18n completion, full-text search, Storybook interaction tests, map marker clustering
- **Mobile features** (#073, #095, #099): EAS OTA deployment, push notification deep links, Shamir's Secret Sharing wallet recovery
- **DevOps & infrastructure** (#074, #081, #082, #086): migration dry-run + rollback plans, WASM size regression alerting, indexer checkpoint/rescan, automated PostgreSQL failover
- **Cross-cutting testing** (#100): chaos engineering fault injection suite

Each issue includes the files/contracts/components to change, expected behavior, edge cases, acceptance criteria, and testing requirements, and each is objectively verifiable through code review, automated tests, CI, benchmarks, or demonstrable project behavior.

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)