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

## Summary

This issue set was generated from direct code inspection and targets real, verifiable gaps in the Stellar-IndigoPay repository:

- **Contract correctness & security** (#001, #003–#015): deprecated-event migration, access control, re-entrancy, TTL, MMR proofs, fuzzing, formal verification
- **Backend reliability & observability** (#016–#030): pool metrics, cache invalidation, projection catch-up, CSRF rotation, circuit breakers, DLQ monitoring, sanitization, tracing, slow-query detection
- **Frontend performance & a11y** (#031–#035): offline donations, virtualization, E2E-encrypted messages, accessibility, query caching
- **Mobile & extension** (#036–#040): hardware-backed signing, offline+QR signing, deep links, CSP, donation presets
- **DevOps, monitoring, and CI** (#041–#047): canary analysis, SBOM gates, post-deploy verification, perf regression, restore checksums, synthetic monitoring, business dashboards
- **Cross-cutting** (#048–#050): Kani invariants, webhook key rotation, API fuzzing

Each issue includes the files/contracts/components to change, expected behavior, edge cases, acceptance criteria, and testing requirements, and each is objectively verifiable through code review, automated tests, CI, benchmarks, or demonstrable project behavior.

To contribute more to the project, join our Telegram group - [https://t.me/StellarIndigoPay/4](https://t.me/StellarIndigoPay/4)