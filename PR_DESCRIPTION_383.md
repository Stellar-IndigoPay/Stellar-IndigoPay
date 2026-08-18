# feat(contracts): Multi-Token Escrow Contract Test Suite

Closes #383

## Summary

This PR delivers the **multi-token escrow contract test suite**, validating that the escrow contract correctly handles any Stellar token (XLM, USDC, or any Soroban token contract). The escrow contract's `Job` struct already stored a `token: Address` and all transfer operations (`release_milestone`, `claim_milestone`, `refund_expired_job`, `resolve_dispute`, `resolve_milestone_dispute`) already used `token::Client::new(&env, &job.token)` to perform token-aware transfers. No contract changes were needed — this PR adds the explicit integration tests that prove multi-token correctness and cross-token isolation.

### Problem

Freelancers and clients operate in different currencies. A freelancer in Brazil may prefer USDC, while a client in the EU funds projects in XLM. The escrow contract needed to be validated for non-XLM token flows to ensure production readiness.

### Solution

A comprehensive integration test file (`multi_token.rs`) exercises the full escrow lifecycle with a simulated USDC token, including creation, proportional milestone release, freelancer claiming, dispute resolution, and expired-job refunds — plus cross-token isolation tests proving that two jobs using different tokens never interfere.

---

## Changes

### Files Created (1 file, ~360 lines)

| File | Lines | Purpose |
|------|-------|---------|
| `contracts/escrow-contract/tests/multi_token.rs` | 360 | 7 integration tests covering USDC lifecycle + cross-token isolation |

### What Was Already Implemented (No Changes Required)

The escrow contract (`contracts/escrow-contract/src/lib.rs`) already had full multi-token support:

| Component | Implementation |
|-----------|---------------|
| `Job` struct | `token: Address` field stored per-job |
| `create_job()` | Accepts `token: Address` parameter; transfers the specified token from client to escrow |
| `release_milestone()` | Uses `token::Client::new(&env, &job.token)` to transfer the correct token to freelancer |
| `claim_milestone()` | Uses `token::Client::new(&env, &job.token)` for freelancer-initiated claims |
| `refund_expired_job()` | Uses `token::Client::new(&env, &job.token)` to return the correct token to client |
| `resolve_dispute()` | Uses `token::Client::new(&env, &job.token)` for dispute payouts |
| `resolve_milestone_dispute()` | Uses `token::Client::new(&env, &job.token)` for per-milestone dispute resolution |

All operations follow the **CEI (Checks-Effects-Interactions) pattern**: state is persisted before any external token transfer, preventing reentrancy vectors regardless of which token contract is used.

---

## Test Coverage

### Required Tests (per acceptance criteria)

| Test | Description | Lines |
|------|-------------|-------|
| `test_create_job_with_usdc` | Creates escrow job with USDC token address; verifies `Job.token`, `Job.amount`, status transitions, and client balance reaches zero after funding | 40 |
| `test_release_milestone_usdc` | Releases 3 milestones (50%/30%/20%) in sequence; verifies proportional USDC payouts at each step (5,000 → 8,000 → 10,000) and status transitions (Escrowed → PartiallyReleased → Completed) | 58 |
| `test_claim_milestone_usdc` | Freelancer claims 2 milestones (40%/60%) after release period; verifies USDC transfers (3,000 → 7,500) and status transitions | 54 |
| `test_refund_usdc_job` | Fast-forwards past `DEFAULT_DEADLINE_LEDGERS`, client refunds; verifies full 2,000 USDC returned to client | 34 |

### Bonus Tests (cross-token isolation + dispute + lifecycle)

| Test | Description | Lines |
|------|-------------|-------|
| `test_two_jobs_different_tokens_isolated` | Creates two jobs with different tokens ("XLM" and "USDC"); releases each independently; verifies freelancer balances are isolated — releasing the XLM job does not affect USDC balance and vice versa | 64 |
| `test_dispute_resolution_usdc` | Disputes a USDC job and resolves with `approve=true`; verifies freelancer receives the full 5,000 USDC in the correct token | 31 |
| `test_usdc_full_lifecycle_integration` | End-to-end walk: create → freelancer claims milestone 0 → client releases milestone 1 → freelancer claims milestone 2 → Completed; verifies 10,000 USDC total payout | 36 |

### Test Architecture

```
contracts/escrow-contract/tests/
├── common/
│   └── mod.rs              ← Shared helpers (setup, fund, create_token, create_simple_job, 
│                              token_balance, three_milestones)
├── create_job.rs           ← Job creation tests (existing)
├── release_escrow.rs       ← Milestone release tests (existing)
├── claim.rs                ← Claim tests (existing)
├── dispute.rs              ← Dispute tests (existing)
└── multi_token.rs          ← ★ NEW: Multi-token integration tests
```

All tests reuse the existing `common` module helpers (`setup`, `fund`, `create_token`, `create_simple_job`, `token_balance`, `three_milestones`) and follow the same patterns as the existing test files.

---

## Architecture

```
                         ┌──────────────────────────────┐
                         │     EscrowContract            │
                         │                              │
                         │  Job {                       │
                         │    token: Address,  ◄── stores which token
                         │    amount: i128,              │
                         │    milestones: Vec<Milestone>,│
                         │    ...                        │
                         │  }                            │
                         │                              │
                         │  create_job(token, amount)    │
                         │    └─► token_client.transfer( │
                         │          client→escrow)       │
                         │                              │
                         │  release_milestone()          │
                         │    └─► TokenClient(token)     │
                         │         .transfer(            │
                         │           escrow→freelancer)  │
                         │                              │
                         │  claim_milestone()            │
                         │    └─► TokenClient(token)     │
                         │         .transfer(            │
                         │           escrow→freelancer)  │
                         │                              │
                         │  refund_expired_job()         │
                         │    └─► TokenClient(token)     │
                         │         .transfer(            │
                         │           escrow→client)      │
                         └──────────────────────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          │                         │                         │
          ▼                         ▼                         ▼
   ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
   │  XLM Token   │         │  USDC Token  │         │  Any Token   │
   │  Contract    │         │  Contract    │         │  Contract    │
   └──────────────┘         └──────────────┘         └──────────────┘

One escrow contract handles ALL tokens. Each job maps 1:1 to one token.
Cross-token isolation is guaranteed because each TokenClient targets a 
specific token contract address.
```

### Cross-Token Isolation Proof

The `test_two_jobs_different_tokens_isolated` test proves there is **no cross-token leakage**:

```
Step 1: Create Job A (XLM, 1,000) + Job B (USDC, 2,000)
        Freelancer balances: XLM=0, USDC=0

Step 2: Release Job A milestone
        Freelancer balances: XLM=1,000, USDC=0  ← no USDC leaked

Step 3: Release Job B milestone
        Freelancer balances: XLM=1,000, USDC=2,000  ← XLM unchanged
```

---

## Acceptance Criteria Checklist

- [x] Job created with USDC token → funded with USDC → milestones released in USDC
- [x] Job created with XLM (existing behavior) → works unchanged (all existing tests pass)
- [x] Dispute resolution returns correct token
- [x] Two jobs with different tokens do not interfere (cross-token isolation)
- [x] All 4 required tests present: `test_create_job_with_usdc`, `test_release_milestone_usdc`, `test_claim_milestone_usdc`, `test_refund_usdc_job`
- [x] All existing escrow tests continue to pass (21 tests in `lib.rs` + 16 in integration test files + 7 new = 44 total)
- [x] CI compliance: `cargo fmt --all -- --check`, `cargo clippy --workspace -- -D warnings`, `cargo test --features testutils -p escrow-contract`

---

## Testing

### Run the tests

```bash
# Escrow contract only
cd contracts && cargo test --features testutils -p escrow-contract

# Full workspace
cd contracts && cargo test --features testutils --workspace -- --skip fuzz
```

### CI verification

```bash
cd contracts

# Format check
cargo fmt --all -- --check

# Clippy
cargo clippy --workspace -- -D warnings

# Tests
cargo test --features testutils --workspace -- --skip fuzz
```

---

## Scope

### In Scope
- Multi-token escrow integration tests (USDC lifecycle, cross-token isolation, dispute, refund)
- Backward compatibility validation (no contract changes, all existing tests pass)
- Reuse of existing test helpers (`common` module)

### Out of Scope
- Multi-token jobs (one job = one token, not a basket of tokens)
- Automatic currency conversion between tokens
- Contract-level changes (already implemented)

---

## References

- Issue: #383
- Escrow contract: `contracts/escrow-contract/src/lib.rs`
- Existing test helpers: `contracts/escrow-contract/tests/common/mod.rs`
- Token-agnostic transfer pattern: `contracts/indigopay-contract/src/donation/contract.rs` (`donate_stealth`)
- CI workflow: `.github/workflows/contracts.yml`
- CEI pattern: `docs/adr/ADR-004-cei-pattern.md`
