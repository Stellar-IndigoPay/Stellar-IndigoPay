# GrantFox OSS — Smart Contract Implementation Issues

---

## Issue #420 — Implement Donation Matching Pool with On-Chain Fund Custody

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: high`, `area: indigopay-contract`

### Summary

Implement an on-chain donation matching pool in `indigopay-contract` that allows a sponsor to deposit funds into the contract, which are then proportionally matched to project donations within a configurable window. This builds on the existing `DataKey::ProjectContractBalance(String, Address)` ledger introduced for contract-held funds and must integrate with the existing `donate_with_privacy` and `donate_usdc` paths without breaking backward compatibility.

### Background

The project already supports direct-to-project-wallet donations recorded on-chain. Several community sponsors have requested the ability to pre-fund a matching pool that automatically boosts donations during matching rounds. The `DataKey::ProjectContractBalance(String, Address)` variant was added to `DataKey` specifically as the canonical per-project per-token balance ledger for contract-held funds (see `EVENTS.md` § Coordination Note for #277 and `SECURITY.md`). This issue implements the full matching pool lifecycle on top of that foundation.

The contract currently tracks `ProjectContractBalance` as a storage key but no logic reads or writes to it — all donations currently go directly to project wallets. The matching pool requires the contract to hold funds in escrow temporarily.

### Problem Statement

Donors and projects lack an on-chain mechanism for matching sponsors to amplify donations. Without on-chain matching, sponsors must trust off-chain accounting, and donors cannot independently verify that matching funds were distributed fairly.

### Objectives

1. Allow an admin (M-of-N) to deposit sponsor funds into the contract under a matching pool.
2. Track the matching pool balance per-project, per-token via `DataKey::ProjectContractBalance`.
3. Automatically match a configurable percentage of each donation from the pool during active matching rounds.
4. Emit a `matched` event that indexers and the frontend can consume.
5. Allow the sponsor/admin to withdraw unspent matching funds after the round ends.
6. Enforce a hard cap on per-donation matching to prevent pool exhaustion by a single large donor.

### Scope

**In Scope:**
- New `deposit_matching_funds(env, signers, project_id, token, amount)` — M-of-N admin deposits funds into the contract. Increments `ProjectContractBalance(project_id, token)` and calls `token::Client::transfer(&signer, &contract_addr, &amount)`.
- New `set_matching_config(env, signers, project_id, match_ratio_bps, max_match_per_donation, start_ledger, end_ledger)` — configures a matching round. `match_ratio_bps` is the basis-point match rate (e.g., 10000 = 1:1 match, 5000 = 0.5:1). `max_match_per_donation` caps the matching amount per individual donation.
- Modification to `donate_with_privacy` and `donate_usdc`: after the existing donation flow, if a matching round is active for the project, compute the match amount (`min(donation_amount * match_ratio_bps / 10000, max_match_per_donation, remaining_pool_balance)`), transfer that amount from the contract to the project wallet, decrement `ProjectContractBalance`, and emit a `matched` event.
- New `withdraw_matching_funds(env, signers, project_id, token, amount)` — M-of-N admin withdraws unspent matching funds back to a sponsor wallet. Panics if the matching round is still active unless `force=true`.
- New getter: `get_matching_pool_balance(project_id, token) -> i128`.
- New getter: `get_matching_config(project_id) -> MatchingConfig`.
- New `MatchingConfig` struct (stored per project): `match_ratio_bps: u32`, `max_match_per_donation: i128`, `start_ledger: u32`, `end_ledger: u32`, `total_deposited: i128`, `total_matched: i128`.

**Out of Scope:**
- Multi-project matching pools (one pool funding multiple projects).
- Quadratic matching formulas (see Issue #424).
- Automatic pool rebalancing across projects.
- Sponsor identity verification — sponsors are identified by the admin who calls `deposit_matching_funds`.

### Detailed Implementation Requirements

#### 1. New DataKey variants

Add to the `DataKey` enum in `contracts/indigopay-contract/src/lib.rs`:

```rust
MatchingConfig(String),     // per-project matching configuration
MatchingPoolActive(bool),   // global flag: is any matching pool active?
```

#### 2. New contract types

```rust
#[contracttype]
#[derive(Clone, Debug)]
pub struct MatchingConfig {
    pub match_ratio_bps: u32,        // 0–10000 (10000 = 100%)
    pub max_match_per_donation: i128, // cap per individual donation
    pub start_ledger: u32,
    pub end_ledger: u32,
    pub total_deposited: i128,
    pub total_matched: i128,
    pub sponsor_wallet: Address,      // where withdrawn funds go
}
```

#### 3. Deposit flow (CEI ordering)

```rust
pub fn deposit_matching_funds(env: Env, signers: Vec<Address>, project_id: String, token: Address, amount: i128) {
    require_admin_for_critical(&env, &signers);
    require_not_paused(&env);
    if amount <= 0 { panic!("Amount must be positive"); }

    // Effects first
    let key = DataKey::ProjectContractBalance(project_id.clone(), token.clone());
    let current: i128 = env.storage().instance().get(&key).unwrap_or(0);
    env.storage().instance().set(&key, &(current.checked_add(amount).expect("overflow")));

    // Update MatchingConfig.total_deposited
    // ...

    // Emit event
    env.events().publish((symbol_short!("match_dep"), signers.get(0).unwrap(), project_id), (token, amount));

    // Interaction last
    let token_client = token::Client::new(&env, &token);
    let contract_addr = env.current_contract_address();
    // The signer whose auth was verified should transfer the tokens
    token_client.transfer(&signers.get(0).unwrap(), &contract_addr, &amount);
}
```

#### 4. Donation augmentation in `donate_with_privacy`

After the existing `donate_with_privacy` logic completes (post-token-transfer), add a matching step:

```rust
// After the existing donation flow completes:
if let Some(config) = get_matching_config_opt(&env, &project_id) {
    let current = env.ledger().sequence();
    if current >= config.start_ledger && current <= config.end_ledger {
        let pool_key = DataKey::ProjectContractBalance(project_id.clone(), token.clone());
        let pool_balance: i128 = env.storage().instance().get(&pool_key).unwrap_or(0);
        if pool_balance > 0 {
            let match_amount = compute_match(amount, &config, pool_balance);
            if match_amount > 0 {
                // Effects
                env.storage().instance().set(&pool_key, &(pool_balance - match_amount));
                // Update MatchingConfig.total_matched
                // ...
                // Interaction
                let contract_addr = env.current_contract_address();
                token_client.transfer(&contract_addr, &project.wallet, &match_amount);
                // Event
                env.events().publish(
                    (symbol_short!("matched"), project_id.clone()),
                    (donor, amount, match_amount),
                );
            }
        }
    }
}
```

#### 5. Edge cases

- **Pool exhaustion**: `compute_match` must never return more than the pool balance. Use `min(match_amount, pool_balance)`.
- **Round not started / ended**: Skip matching silently (not an error — donations should still succeed).
- **Zero match ratio**: Skip matching when `match_ratio_bps == 0`.
- **Self-donation**: Matching applies regardless of donor identity.
- **Multi-token**: The pool is per-token. A project can have separate XLM and USDC matching pools.
- **Concurrent donations**: Soroban transactions are atomic per-invocation — no race condition between two `donate_with_privacy` calls.
- **Contract pause**: `deposit_matching_funds` and `withdraw_matching_funds` should be pause-gated. Matching within `donate` naturally inherits the existing pause gate.

### Expected Architecture

```
Sponsor → deposit_matching_funds() → ProjectContractBalance += amount
                                           ↓
Donor → donate_with_privacy() → [existing flow] → [matching step]
                                           ↓
                              ProjectContractBalance -= match_amount
                              Token transfer: contract → project wallet
                              Event: matched(donor, donation, match)
```

The contract holds matching funds in its own balance. The `token::Client::transfer` from contract to project wallet happens atomically within the donate invocation.

### Acceptance Criteria

- [ ] `deposit_matching_funds` correctly transfers tokens from admin to contract and increments `ProjectContractBalance`.
- [ ] `set_matching_config` persists all config fields and emits an event.
- [ ] Donations during an active matching round trigger proportional matching.
- [ ] Matching never exceeds `max_match_per_donation` or remaining pool balance.
- [ ] Donations before `start_ledger` or after `end_ledger` do not trigger matching.
- [ ] `withdraw_matching_funds` correctly transfers tokens back and decrements the balance.
- [ ] `withdraw_matching_funds` panics during active round unless `force=true`.
- [ ] All new functions follow CEI ordering (effects before external calls).
- [ ] Existing donation flow is unchanged when no matching config exists (backward compatible).
- [ ] Rate limiting still applies to matched donations (the donor's rate limit counts the original donation, not the match).

### Testing Requirements

- **Unit tests**: `test_deposit_matching_funds_success`, `test_deposit_matching_funds_overflow`, `test_matching_during_round`, `test_matching_skipped_before_start`, `test_matching_skipped_after_end`, `test_matching_respects_max_per_donation`, `test_matching_pool_exhaustion`, `test_withdraw_matching_funds`, `test_withdraw_during_active_round_panics`, `test_force_withdraw_during_active_round`, `test_donation_without_config_no_matching`, `test_zero_match_ratio`, `test_matching_with_privacy`.
- **Integration tests**: Full lifecycle: deposit → configure → donate (matched) → donate (pool exhausts) → withdraw remaining → verify all balances.
- **Fuzz tests** (add to `indigopay-contract/src/fuzz_tests.rs`): `prop_matching_never_exceeds_pool`, `prop_matching_respects_config`.
- **Multi-token tests**: Separate XLM and USDC matching pools do not interfere.

### CI Requirements

- All existing tests must pass (`cargo test --features testutils` from `contracts/`).
- WASM binary must remain under 64 KB (`cargo build --target wasm32v1-none --release` + size check).
- New clippy warnings are disallowed (`cargo clippy -- -D warnings`).
- `cargo fmt --check` must pass.

### Deliverables

1. Implementation in `contracts/indigopay-contract/src/lib.rs` (new functions, types, DataKey variants).
2. Unit + integration tests in the same file (inline `#[cfg(test)] mod tests`).
3. Fuzz test additions in `contracts/indigopay-contract/src/fuzz_tests.rs`.
4. Updated `contracts/EVENTS.md` documenting the new `match_dep`, `match_cfg`, `matched`, `match_wdr` events.
5. Updated `contracts/indigopay-contract/SECURITY.md` with matching pool trust model.
6. Updated `contracts/indigopay-contract/UPGRADE.md` with new storage keys.

### Definition of Done

- All acceptance criteria met.
- All tests pass (`cargo test --features testutils`).
- WASM builds under 64 KB.
- All CI checks green.
- Code reviewed and approved by at least one maintainer.

### References

- `contracts/indigopay-contract/src/lib.rs` — main contract with `DataKey::ProjectContractBalance`, `donate_with_privacy`, CEI ordering pattern.
- `contracts/EVENTS.md` — Coordination Note for #277.
- `contracts/indigopay-contract/SECURITY.md` — trust model, `ProjectContractBalance` as canonical balance ledger.
- `contracts/indigopay-contract/UPGRADE.md` — storage compatibility, adding new keys.

---

## Issue #421 — Multi-Token Donation Support with Dynamic Token Registry

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: high`, `area: indigopay-contract`

### Summary

Extend the `indigopay-contract` to support donations in any Stellar asset beyond the current XLM and USDC paths. Replace the single `DataKey::USDCTokenAddress` with a dynamic token registry that admins can populate, and add a generic `donate_token` entrypoint that works with any registered token and its associated oracle price feed.

### Background

The contract currently hard-codes two donation paths: `donate` (XLM, via `donate_with_privacy`) and `donate_usdc` (USDC with oracle conversion). Each project that wants to accept a different asset (e.g., yXLM, USDT, BTC-representative tokens) requires a new code path and a new oracle. The `DataKey::USDCTokenAddress` is a single-address field; no registry pattern exists.

The contract already has `DataKey::OracleAddress` (a single oracle), `DataKey::NativeTokenAddress`, and the concept of a token registry was sketched in `OPTIMIZATION.md` and the ROADMAP section on multi-currency.

### Problem Statement

Climate projects receive donations from donors worldwide who hold diverse Stellar assets. Hard-coding each token is unsustainable. A token registry with per-token oracle configuration enables the contract to support any Stellar asset without a contract upgrade.

### Objectives

1. Replace `DataKey::USDCTokenAddress` with a token registry supporting N registered tokens.
2. Add `register_token(env, admin, token_address, oracle_address, symbol)` — admin-only, registers a token with its oracle.
3. Add `remove_token(env, admin, token_address)` — admin-only.
4. Add a generic `donate_token(env, token, donor, project_id, amount, msg_hash)` entrypoint that works for any registered token.
5. Convert the donation amount to XLM-equivalent using the token's oracle for CO₂ calculation and global stats.
6. Keep `donate` (XLM) and `donate_usdc` as thin wrappers around `donate_token` for backward compatibility.

### Scope

**In Scope:**
- New `TokenConfig` struct: `{ token: Address, oracle: Address, symbol: Symbol, active: bool }`.
- New `DataKey::TokenConfig(Address)` — stores per-token config.
- New `DataKey::TokenList` — `Vec<Address>` enumeration of all registered tokens.
- New `register_token`, `remove_token` admin functions.
- New `donate_token` entrypoint that abstracts the common donation logic.
- Refactor `donate_with_privacy` and `donate_usdc` to delegate to `donate_token`.
- Rate limiting must be per-token (separate rate limit windows for XLM vs USDC vs other tokens).

**Out of Scope:**
- Automatic token discovery — tokens must be explicitly registered by admins.
- Cross-token path payments (use existing `donate_asset` for that).
- Token de-registration that affects historical donation records.
- Native XLM exception handling (XLM doesn't need an oracle since it's the base unit).

### Detailed Implementation Requirements

#### 1. TokenConfig struct

```rust
#[contracttype]
#[derive(Clone, Debug)]
pub struct TokenConfig {
    pub token: Address,
    pub oracle: Address,
    pub symbol: Symbol,
    pub active: bool,
    pub registered_at: u32,
}
```

#### 2. New DataKey variants

Remove `DataKey::USDCTokenAddress` (or keep it and have `donate_usdc` read from `TokenConfig`). Add:

```rust
TokenConfig(Address),  // per-token configuration
TokenList,             // Vec<Address> of registered tokens
```

#### 3. Refactored donation entrypoint

The `donate_token` function should:

1. Look up `TokenConfig` for the provided token address — panic if not found or inactive.
2. If the token address is the native XLM token, skip oracle conversion (amount is already in XLM).
3. Otherwise, call the token's oracle to get the XLM-equivalent price and compute `xlm_equivalent = (amount * price) / PRICE_SCALE`.
4. Proceed with the existing donation logic (rate limiting, CO₂ calculation, stats updates, badge minting, global counters) using `xlm_equivalent` for CO₂ and global totals.
5. Transfer the actual token (not the XLM equivalent) to the project wallet.
6. Record the donation with the token's symbol in the `DonationRecord`.

#### 4. Rate limiting per-token

The existing `DataKey::DonorRateLimit(Address, String)` keys on (donor, project_id). Change to `DataKey::DonorRateLimit(Address, String, Address)` — (donor, project_id, token_address). Each token gets independent rate limit windows.

Migration path: the old two-argument key can coexist — `donate` and `donate_usdc` continue to use the old key until all callers migrate to `donate_token`. The new `donate_token` always uses the three-argument key.

#### 5. Backward compatibility

- `donate_with_privacy` and `donate_usdc` remain as public entrypoints but internally call `donate_token`.
- Existing `set_usdc_token` and `set_oracle` functions remain but also register into the token registry.
- The first time `set_usdc_token` is called after upgrade, it auto-registers the USDC token in the registry.
- `get_donor_stats` return format is unchanged.

### Acceptance Criteria

- [ ] `register_token` persists the `TokenConfig` and appends to `TokenList`.
- [ ] `remove_token` removes from `TokenList` and sets `active = false` (or removes the `TokenConfig` entry).
- [ ] `donate_token` works with XLM (no oracle), USDC (with oracle), and any registered custom token (with its oracle).
- [ ] XLM-equivalent calculation is correct for CO₂ offset and global stats.
- [ ] Actual token transfer uses the donor's token, not XLM.
- [ ] Rate limiting is per-token: donating XLM doesn't consume USDC rate limit budget.
- [ ] `donate_with_privacy` and `donate_usdc` still work identically (backward compatible).
- [ ] Existing tests pass without modification.
- [ ] WASM size remains under 64 KB.

### Testing Requirements

- **Unit tests**: `test_register_token`, `test_register_duplicate_token_panics`, `test_remove_token`, `test_donate_token_xlm`, `test_donate_token_usdc`, `test_donate_token_custom`, `test_donate_token_unregistered_panics`, `test_donate_token_inactive_panics`, `test_rate_limit_per_token_isolation`, `test_backward_compat_donate_with_privacy`, `test_backward_compat_donate_usdc`.
- **Integration tests**: Register 3 tokens (XLM, USDC, custom), donate with each to the same project, verify all balances and global stats.
- **Fuzz tests**: `prop_donate_token_random_token` (ensure only registered tokens work), `prop_xlm_equivalent_calculation`.

### CI Requirements

- `cargo test --features testutils` — all tests pass.
- `cargo build --target wasm32v1-none --release` — WASM under 64 KB.
- `cargo clippy -- -D warnings` — no new warnings.
- `cargo fmt --check` — formatting clean.

### Deliverables

1. Token registry types and DataKey variants in `lib.rs`.
2. `register_token`, `remove_token`, `donate_token` functions with full auth and pause gates.
3. Refactored `donate_with_privacy` and `donate_usdc` as wrappers.
4. Updated rate limiting to be per-token.
5. Migration of existing `USDCTokenAddress` data to the registry.
6. Unit, integration, and fuzz tests.
7. Updated `EVENTS.md`, `SECURITY.md`, `UPGRADE.md`.
8. Updated `docs/contract-integration.md` with `donate_token` usage examples.

### Definition of Done

- All acceptance criteria met.
- All tests pass.
- WASM under 64 KB.
- CI green.
- At least one maintainer approval.

### References

- `contracts/indigopay-contract/src/lib.rs` — current `donate_with_privacy`, `donate_usdc`, `DataKey::USDCTokenAddress`, `DataKey::OracleAddress`, `DataKey::NativeTokenAddress`.
- `contracts/indigopay-contract/src/donation/contract.rs` — `DonationContract` with stealth donation pattern, demonstrates working with arbitrary tokens.
- `contracts/indigopay-contract/UPGRADE.md` — storage key compatibility requirements.
- `docs/contract-integration.md` — existing integration patterns.

---

## Issue #422 — On-Chain Keeper Incentive Mechanism for Recurring Donations

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: high`, `area: indigopay-contract`

### Summary

Implement a keeper network incentive mechanism for recurring donations in `indigopay-contract`. Currently, the recurring donation system stores schedules on-chain but does not provide a decentralized execution mechanism. A keeper (any Stellar account) should be able to trigger the execution of a matured recurring donation and receive a configurable incentive for doing so, funded from the donor's pre-committed balance or from a keeper reward pool.

### Background

The contract already has `RecurringDonation` structs with a `keeper_incentive` field and `DataKey::RecurringDonation(Address, u32)` / `DataKey::DonorRecurringCount(Address)`. The `donate_recurring` entrypoint creates a schedule. However, there is no `execute_recurring` function — the expectation is that an off-chain service triggers donations. This centralized approach is a single point of failure.

The event `rec_exec` (Recurring Executed) is already documented in `EVENTS.md` (topic 29) with the signature `["rec_exec", keeper, donor]`, anticipating a keeper-based execution model.

### Problem Statement

Without an on-chain keeper mechanism, recurring donations depend on a centralized off-chain scheduler. If that scheduler goes down, recurring donations stop. A decentralized keeper network where anyone can trigger matured donations and earn a fee ensures liveness and aligns with web3 principles.

### Objectives

1. Add `execute_recurring(env, keeper, donor, recurring_id)` — any account can call this to trigger a matured recurring donation.
2. The keeper receives `keeper_incentive` stroops from the donor's pre-committed balance.
3. The recurring donation amount is transferred from donor to project wallet.
4. The `next_execution_ledger` is advanced by `interval_ledgers`.
5. If the donor's balance is insufficient, the schedule is paused (`active = false`) and a `rec_paused` event is emitted.
6. Keeeper incentives must be pre-funded — either by locking extra tokens at schedule creation or by requiring the donor to maintain a minimum balance.

### Scope

**In Scope:**
- New `execute_recurring(env, keeper: Address, donor: Address, recurring_id: u32)` entrypoint.
- Keeper incentive transfer: `token::Client::transfer(&donor, &keeper, &incentive)`.
- Donation transfer: `token::Client::transfer(&donor, &project.wallet, &amount)`.
- Update `RecurringDonation.next_execution_ledger += interval_ledgers`.
- Pause schedule when donor balance is insufficient.
- New `rec_paused` event.
- New `rec_resumed` event when donor manually resumes a paused schedule.
- New `resume_recurring(env, donor, recurring_id)` entrypoint (donor-only).
- Add balance check before execution: call `token::Client::new(&env, &token).balance(&donor)` and ensure `balance >= amount + incentive`.

**Out of Scope:**
- Keeper reputation or staking — this issue implements only the incentive transfer.
- Priority ordering for keepers (first-come-first-served is acceptable).
- Batch execution of multiple schedules.
- Automatic retry for failed executions.

### Acceptance Criteria

- [ ] `execute_recurring` transfers `amount` to project wallet and `keeper_incentive` to keeper.
- [ ] `execute_recurring` panics if called before `next_execution_ledger`.
- [ ] `execute_recurring` panics if schedule is not active.
- [ ] `execute_recurring` pauses schedule when donor balance is insufficient, emits `rec_paused`.
- [ ] `resume_recurring` reactivates a paused schedule (donor-only, requires auth).
- [ ] `next_execution_ledger` is correctly advanced after execution.
- [ ] Keeper incentive is configurable at schedule creation time (already supported via `keeper_incentive` field).
- [ ] All state mutations follow CEI ordering (effects before external token transfers).
- [ ] Events `rec_exec` and `rec_paused` are emitted with correct topics and data.

### Testing Requirements

- **Unit tests**: `test_execute_recurring_success`, `test_execute_recurring_before_maturity_panics`, `test_execute_recurring_paused_schedule_panics`, `test_execute_recurring_insufficient_balance_pauses`, `test_resume_recurring`, `test_resume_recurring_not_donor_panics`, `test_keeper_incentive_transferred`, `test_execution_advances_next_ledger`, `test_execute_nonexistent_schedule_panics`.
- **Integration tests**: Create recurring schedule, fast-forward ledger, keeper executes, verify donor balance decreased by `amount + incentive`, project wallet increased by `amount`, keeper increased by `incentive`.
- **Fuzz tests**: `prop_recurring_execution_never_overpays` (sum of all transfers ≤ donor's committed amount).

### CI Requirements

- `cargo test --features testutils` — all tests pass.
- `cargo build --target wasm32v1-none --release` — WASM under 64 KB.
- `cargo clippy -- -D warnings`.
- `cargo fmt --check`.

### Deliverables

1. `execute_recurring` and `resume_recurring` functions in `lib.rs`.
2. Balance check logic with proper error messages.
3. `rec_paused` and `rec_resumed` event emissions.
4. Unit, integration, and fuzz tests.
5. Updated `EVENTS.md` with `rec_paused` and `rec_resumed`.
6. Updated `SECURITY.md` with keeper trust model.

### Definition of Done

- All acceptance criteria met.
- All tests pass.
- WASM under 64 KB.
- CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `RecurringDonation` struct, `donate_recurring` function, `DataKey::RecurringDonation`.
- `contracts/EVENTS.md` — topics 27 (`rec_cr`), 28 (`rec_can`), 29 (`rec_exec`).
- `ROADMAP.md` — v2.2 "Recurring donation scheduler on-chain".

---

## Issue #423 — Vesting Schedule Partial Claim with Early Exit Penalty

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: high`, `area: indigopay-contract`

### Summary

Enhance the existing vesting donation system (`VestingSchedule`, `donate_vested`, `claim_vested_installment`, `cancel_vesting`) to support partial early exit with a configurable penalty. Currently, `cancel_vesting` returns all unvested funds to the donor immediately with no penalty. Add an `early_exit_vesting` path that allows the donor to accelerate the release of remaining installments in exchange for a penalty (e.g., 10% of unvested amount) that is donated to the project immediately, incentivizing donors to honor long-term commitments while providing an escape hatch.

### Background

The contract's `VestingSchedule` struct and related functions were added in #386. The current flow is:
- `donate_vested`: donor locks tokens, first installment transfers immediately.
- `claim_vested_installment`: anyone can claim the next installment after the interval elapses.
- `cancel_vesting`: donor cancels, receives all unvested tokens back. No penalty.

Events `vest_crt` (30), `vest_clm` (31), and `vest_can` (32) are documented in `EVENTS.md`.

### Problem Statement

Without an early exit penalty, donors have no disincentive to cancel long-term vesting commitments. This undermines the trust of projects that rely on predictable vesting schedules. An early exit with penalty provides a fair middle ground: donors retain flexibility, but projects receive compensation for the broken commitment.

### Objectives

1. Add `early_exit_vesting(env, donor, schedule_id)` — donor-initiated early exit that calculates remaining unvested amount, applies a penalty percentage, sends penalty to project wallet, returns remainder to donor.
2. Add `set_vesting_penalty_bps(env, signers, penalty_bps)` — M-of-N admin configures the global early exit penalty in basis points (0–5000, max 50%). Default 1000 (10%).
3. Emit a new `vest_early` event distinct from `vest_can`.
4. The penalty amount must be considered a donation — it updates project `total_raised`, donor stats, and global CO₂ counters.
5. Existing `cancel_vesting` remains unchanged (returns all funds, no penalty) as the "no-fault" cancellation path for schedules that haven't started releasing installments.
6. `early_exit_vesting` panics if no installments have been released yet (use `cancel_vesting` instead).

### Scope

**In Scope:**
- New `early_exit_vesting(env, donor, schedule_id)` function.
- New `set_vesting_penalty_bps(env, signers, penalty_bps)` admin function.
- New `DataKey::VestingPenaltyBps` storage key.
- Penalty amount calculation: `penalty = remaining_unvested * penalty_bps / 10000`.
- Penalty is transferred to project wallet and treated as a donation (updates all donation stats).
- Remaining unvested amount (minus penalty) is transferred back to donor.
- Schedule is marked as completed/cancelled.
- New `vest_early` event.
- CEI ordering: all state updates before token transfers.

**Out of Scope:**
- Per-schedule penalty overrides (only global config).
- Graduated penalty that decreases over time.
- Penalty distribution to multiple recipients.

### Acceptance Criteria

- [ ] `early_exit_vesting` transfers penalty to project wallet, remainder to donor.
- [ ] Penalty is recorded as a donation (updates `project.total_raised`, `donor_stats`, `GlobalTotalRaised`, `GlobalCO2OffsetGrams`).
- [ ] Penalty respects the global `VestingPenaltyBps` configuration.
- [ ] `early_exit_vesting` panics if no installments have been released (suggest `cancel_vesting` in error message).
- [ ] `set_vesting_penalty_bps` requires M-of-N admin auth.
- [ ] `set_vesting_penalty_bps` enforces maximum of 5000 (50%).
- [ ] All token transfers follow CEI ordering.
- [ ] `vest_early` event is emitted with correct topics: `["vest_early", donor, project_id]`.

### Testing Requirements

- **Unit tests**: `test_early_exit_with_penalty`, `test_early_exit_no_installments_released_panics`, `test_early_exit_penalty_as_donation`, `test_set_vesting_penalty_bps`, `test_set_vesting_penalty_bps_exceeds_max_panics`, `test_cancel_vesting_no_penalty`, `test_early_exit_full_calculation`.
- **Integration tests**: Create vesting schedule, release 3 of 10 installments, early exit, verify project receives penalty, donor receives remainder, donation stats updated.
- **Fuzz tests**: `prop_early_exit_never_overpays` (penalty + donor_refund + already_released = total_amount).

### CI Requirements

- `cargo test --features testutils` — all tests pass.
- `cargo build --target wasm32v1-none --release` — WASM under 64 KB.
- `cargo clippy -- -D warnings`.
- `cargo fmt --check`.

### Deliverables

1. `early_exit_vesting` and `set_vesting_penalty_bps` functions.
2. `DataKey::VestingPenaltyBps` storage handling.
3. Penalty-as-donation logic integration with existing stats update code.
4. Unit, integration, and fuzz tests.
5. Updated `EVENTS.md` with `vest_early`.
6. Updated `SECURITY.md` with penalty trust model.

### Definition of Done

- All acceptance criteria met. All tests pass. WASM under 64 KB. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `VestingSchedule` struct, `donate_vested`, `claim_vested_installment`, `cancel_vesting`.
- `contracts/EVENTS.md` — topics 30–32 (vesting events).
- `contracts/indigopay-contract/SECURITY.md` — badge permanence on refund (similar trust model consideration).

---

## Issue #424 — Quadratic Voting for Community Governance

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

Replace the current linear-weight voting system (`voting_weight_from_badge`) with quadratic voting. In quadratic voting, the cost (or weight) of each additional vote grows quadratically: a voter with N voting credits can cast `√N` votes on a proposal, making Sybil-resistant collective decision-making more expressive. This requires restructuring the `VoteProposal` struct and the `vote_verify_project` function.

### Background

The governance system currently gives each badge tier a fixed voting weight:
- None: 0, Seedling: 100, Tree: 141, Forest: 173, EarthGuardian: 200

This is linear — if you have EarthGuardian tier, you always cast 200 votes. Quadratic voting would allow an EarthGuardian donor to spread their 200 "voting credits" across multiple proposals, with the cost per vote on a single proposal being `votes_cast²`. For example, casting 1 vote costs 1 credit, 2 votes costs 4 credits, 10 votes costs 100 credits.

The contract already tracks `DataKey::VoteDelegation(Address)` and `DataKey::DelegatedWeight(Address)` for vote delegation (#delegation feature). Quadratic voting must compose with delegation.

### Problem Statement

Linear voting disproportionately advantages large donors and offers no mechanism for voters to express intensity of preference across multiple proposals. Quadratic voting is widely recognized in DAO governance as a fairer mechanism that better captures community preferences while still weighting by stake.

### Objectives

1. Replace the `votes_for` / `votes_against` counters in `VoteProposal` with quadratic vote accounting.
2. Each donor receives "voting credits" equal to their `voting_weight_from_badge` (as is), but they spend credits quadratically: `credits_spent = votes_cast²`.
3. A single `vote_verify_project` call can allocate votes across multiple proposals, spending from the donor's credit pool.
4. The final tally for a proposal is `Σ sqrt(credits_spent_by_each_voter)` for "for" and "against" sides separately.
5. Add `get_voting_credits(donor) -> u32` to query remaining credits.
6. Voting credits refresh when badge tier changes (donation event) — consume previous allocation, grant new credits.
7. Compose with existing vote delegation: delegated credits are added to the delegate's pool.

### Scope

**In Scope:**
- New `VoteAllocation` struct: `{ proposal_id: String, votes_for: u32, votes_against: u32, credits_spent: u32 }`.
- New `DataKey::VoterCredits(Address)` — tracks remaining voting credits per donor.
- Refactored `VoteProposal` struct: replace `votes_for: u32, votes_against: u32` with per-voter allocations. The tally is derived from `Σ sqrt(credits)`.
- New `vote_on_proposals(env, voter, allocations: Vec<VoteAllocation>)` — cast votes on multiple proposals in one call.
- Updated `create_proposal` to initialize quadratic vote storage.
- Updated badge upgrade logic: when donor's badge changes, recalculate `VoterCredits` and reset.
- Updated vote delegation: delegated credits transfer to delegate's `VoterCredits`.
- `get_proposal_tally(project_id) -> (for_votes, against_votes)` computes quadratic tally on-the-fly.

**Out of Scope:**
- Conviction voting (time-weighted).
- Ranked-choice or pairwise voting.
- Proposal types beyond project verification (this issue scoped to existing `vote_verify_project`).
- Snapshot-based voting (we use live badge tiers).

### Acceptance Criteria

- [ ] Voting credits are calculated as `voting_weight_from_badge(donor.badge)`.
- [ ] `vote_on_proposals` deducts credits as `Σ(votes_for² + votes_against²)` across all allocations.
- [ ] `vote_on_proposals` panics if total credits required exceed donor's available credits.
- [ ] Proposal tally is correctly computed as `Σ sqrt(per_voter_credits_spent)`.
- [ ] Badge upgrade grants new credits equal to the new tier's weight (resets, not additive).
- [ ] Vote delegation transfers credits correctly.
- [ ] Backward compatible: existing `create_proposal` and read functions work with the new tally method.
- [ ] `get_voting_credits` returns the correct remaining credit balance.

### Testing Requirements

- **Unit tests**: `test_quadratic_voting_single_proposal`, `test_quadratic_voting_multiple_proposals`, `test_voting_credits_exhausted_panics`, `test_voting_tally_computation`, `test_badge_upgrade_resets_credits`, `test_credits_after_donation`, `test_delegated_credits_added`, `test_zero_badge_no_credits`.
- **Integration tests**: Full governance flow: register project, create proposal, two donors vote with different credit allocations, verify tally, badge upgrade mid-cycle, re-verify tally.
- **Fuzz tests**: `prop_credits_never_negative`, `prop_tally_bounded_by_total_credits`.

### CI Requirements

- `cargo test --features testutils` — all tests pass.
- `cargo build --target wasm32v1-none --release` — WASM under 64 KB.
- `cargo clippy -- -D warnings`. `cargo fmt --check`.

### Deliverables

1. Quadratic voting logic in `lib.rs` (refactored `VoteProposal`, new `VoteAllocation`, `vote_on_proposals`, tally computation).
2. `DataKey::VoterCredits` storage management.
3. Updated vote delegation integration.
4. Unit, integration, and fuzz tests.
5. Updated `EVENTS.md` with new vote event formats.
6. Updated `docs/contract-integration.md` with governance section.

### Definition of Done

- All acceptance criteria met. All tests pass. WASM under 64 KB. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `VoteProposal`, `voting_weight_from_badge`, `create_proposal`, `vote_verify_project`, `DataKey::Proposal`, `DataKey::VoteDelegation`, `DataKey::DelegatedWeight`.
- `contracts/EVENTS.md` — existing governance events.
- `ROADMAP.md` — v2.1 DAO Governance.

---

## Issue #425 — Configurable Badge Tier Thresholds with Admin Governance

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

Replace the hard-coded badge tier thresholds in `calculate_badge()` with admin-configurable thresholds stored on-chain. Currently, the thresholds are constants in the contract code: Seedling ≥ 10 XLM, Tree ≥ 100, Forest ≥ 500, EarthGuardian ≥ 2000. These cannot be adjusted without a contract upgrade. This issue makes thresholds configurable via M-of-N admin governance, with bounds to prevent abuse.

### Background

The `calculate_badge` function is defined in `lib.rs`:

```rust
pub fn calculate_badge(total_stroops: i128) -> BadgeTier {
    let xlm = total_stroops / STROOP;
    if xlm >= 2000 { BadgeTier::EarthGuardian }
    else if xlm >= 500 { BadgeTier::Forest }
    else if xlm >= 100 { BadgeTier::Tree }
    else if xlm >= 10 { BadgeTier::Seedling }
    else { BadgeTier::None }
}
```

The badge tiers themselves (`BadgeTier` enum) are hard-coded: `None`, `Seedling`, `Tree`, `Forest`, `EarthGuardian`.

### Problem Statement

As the platform scales, the appropriate thresholds for badge tiers may change (e.g., due to XLM price fluctuations or community governance decisions). A contract upgrade to change constants is heavy-weight. Configurable thresholds enable the DAO to adjust badge economics through governance.

### Objectives

1. Store badge thresholds on-chain in instance storage.
2. Add `set_badge_thresholds(env, signers, thresholds: Vec<BadgeThreshold>)` — M-of-N admin.
3. Each `BadgeThreshold` specifies a tier and its minimum XLM requirement.
4. `calculate_badge` reads thresholds from storage instead of using constants.
5. Default thresholds at initialization match the current hard-coded values.
6. Enforce bounds: thresholds must be strictly increasing, minimum Seedling threshold ≥ 1 XLM, maximum EarthGuardian threshold ≤ 1,000,000 XLM.
7. New `DataKey::BadgeThresholds` storage key.
8. Emit `badge_cfg` event when thresholds are updated.

### Scope

**In Scope:**
- New `BadgeThreshold` struct: `{ tier: BadgeTier, min_xlm: u32 }`.
- New `DataKey::BadgeThresholds`.
- New `set_badge_thresholds(env, signers, thresholds)` — M-of-N admin.
- Updated `calculate_badge` to iterate thresholds from storage.
- Default thresholds set in `initialize()`.
- `get_badge_thresholds() -> Vec<BadgeThreshold>` getter.

**Out of Scope:**
- Adding new badge tiers beyond the four existing ones.
- Removing existing tiers.
- Per-project badge tiers.
- Dynamic badge tiers based on donation frequency or recency.

### Acceptance Criteria

- [ ] `set_badge_thresholds` persists thresholds and emits `badge_cfg`.
- [ ] `set_badge_thresholds` enforces strictly increasing thresholds.
- [ ] `set_badge_thresholds` enforces bounds (1 ≤ Seedling, EarthGuardian ≤ 1,000,000).
- [ ] `calculate_badge` correctly reads from stored thresholds.
- [ ] Default thresholds match current hard-coded values.
- [ ] Existing badge assignment tests pass with default config.
- [ ] M-of-N auth required for threshold updates.
- [ ] Pause gate applies to `set_badge_thresholds`.

### Testing Requirements

- **Unit tests**: `test_default_thresholds_match_current`, `test_set_thresholds_custom`, `test_set_thresholds_non_increasing_panics`, `test_set_thresholds_out_of_bounds_panics`, `test_calculate_badge_with_custom_thresholds`, `test_badge_threshold_update_idempotent`.
- **Integration tests**: Initialize contract, change thresholds, donate to reach a custom threshold, verify badge assigned correctly.
- **Fuzz tests**: `prop_calculate_badge_uses_stored_thresholds`.

### CI Requirements

- Same as previous issues: all tests, WASM under 64 KB, clippy, fmt.

### Deliverables

1. `BadgeThreshold` type and `DataKey::BadgeThresholds`.
2. `set_badge_thresholds` function.
3. Refactored `calculate_badge`.
4. Unit, integration, and fuzz tests.
5. Updated `SECURITY.md` noting that badge threshold changes are governed by M-of-N.

### Definition of Done

- All acceptance criteria met. All tests pass. WASM under 64 KB. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `BadgeTier`, `calculate_badge`, `STROOP`.
- `contracts/indigopay-contract/SECURITY.md` — Phase B multi-sig admin.

---

## Issue #426 — Campaign-to-Escrow Integration: Milestone-Based Project Fund Release

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: high`, `area: indigopay-contract`, `area: escrow-contract`

### Summary

Bridge the `indigopay-contract` campaign system with the `escrow-contract` to enable milestone-based fund release for climate projects. When a project creates a fundraising campaign and reaches its goal, the funds should not be released all at once. Instead, the project should define milestones, and funds should be released incrementally through the escrow contract after donor or admin verification of milestone completion.

### Background

The `indigopay-contract` has `CampaignStatus` and campaign functions (`create_campaign`, `extend_campaign`, `close_campaign`). When a campaign reaches its goal, `apply_campaign_goal_progress` sets `CampaignStatus::GoalReached`. Currently, this does not trigger any escrow logic — funds are already sent directly to the project wallet at donation time.

The `escrow-contract` provides job creation, milestone-based release, claim, and dispute resolution. The `Job` struct has `client`, `freelancer`, `token`, `amount`, and `milestones`.

The ROADMAP mentions "Deeper Stellar DEX integration" and escrow for "milestone-based project payouts" under v2.1.

### Problem Statement

Direct-to-wallet donations (ADR-002) mean projects receive funds immediately, which is great for trust-minimization but provides no mechanism for donors to ensure funds are used for specific milestones. An escrow integration would allow campaigns to optionally route funds through the escrow contract, with milestone releases gated by admin verification, creating accountability without full platform custody.

### Objectives

1. Add a `campaign_escrow_job_id` field to the `Project` struct (or a separate storage key).
2. When a campaign is created with an escrow option, donations are routed to the escrow contract instead of directly to the project wallet.
3. The escrow contract holds funds until milestones are released.
4. Admin (or a designated verifier) calls `release_milestone` on the escrow contract after verifying milestone completion.
5. Add `create_campaign_with_escrow(env, admin, project_id, goal, deadline, milestones: Vec<EscrowMilestone>)` — creates both a campaign and an escrow job atomically.
6. Cross-contract call: `indigopay-contract` calls `escrow-contract.create_job(...)`.

### Scope

**In Scope:**
- New `EscrowMilestone` input type with `name: String`, `percentage: u32`.
- `create_campaign_with_escrow` — validates milestones sum to 100%, creates campaign, calls escrow contract to create job.
- Modified `donate_with_privacy` path for escrow campaigns: donate to escrow contract address instead of project wallet.
- `release_campaign_milestone(env, admin, project_id, milestone_index)` — admin calls escrow `release_milestone`.
- `claim_campaign_milestone(env, project_wallet, project_id, milestone_index)` — project wallet claims a released milestone.
- `dispute_campaign_milestone(env, admin, project_id, milestone_index)` — admin disputes.
- Integration tests exercising the full cross-contract flow.

**Out of Scope:**
- Retroactive escrow for existing campaigns.
- Donor voting on milestone releases.
- Partial escrow (some funds direct, some escrowed).
- Multi-token escrow campaigns (use single token).

### Acceptance Criteria

- [ ] `create_campaign_with_escrow` creates a campaign on indigopay-contract and a job on escrow-contract.
- [ ] Donations to escrow campaigns route funds to the escrow contract.
- [ ] Campaign `total_raised` reflects escrowed amounts.
- [ ] `release_campaign_milestone` successfully calls escrow `release_milestone`.
- [ ] `claim_campaign_milestone` successfully calls escrow `claim_milestone`.
- [ ] Dispute flow works end-to-end.
- [ ] Campaign cannot be created with milestones that don't sum to 100%.
- [ ] Escrow contract events surface through the campaign contract.
- [ ] Campaign closure after all milestones released transitions to `Closed`.

### Testing Requirements

- **Unit tests**: `test_create_campaign_with_escrow`, `test_escrow_campaign_milestone_validation`, `test_donate_to_escrow_campaign`, `test_release_escrow_campaign_milestone`, `test_claim_escrow_campaign_milestone`, `test_dispute_escrow_campaign_milestone`.
- **Integration tests**: Full lifecycle — create escrow campaign, accept donations to goal, release milestones, verify project wallet receives funds, close campaign.
- **Cross-contract tests**: Deploy both contracts in test env, exercise all flows.

### CI Requirements

- Both contract test suites pass.
- WASM sizes under 64 KB each.
- No cross-contract panics in integration tests.

### Deliverables

1. `create_campaign_with_escrow` and associated functions in `indigopay-contract/src/lib.rs`.
2. Escrow contract address configuration (`DataKey::EscrowContractAddress` or constructor parameter).
3. Cross-contract call patterns following CEI ordering.
4. Unit and integration tests in both contracts.
5. Updated `EVENTS.md` with campaign escrow events.
6. Updated `docs/architecture.md` with escrow integration diagram.

### Definition of Done

- All acceptance criteria met, all tests pass, WASM sizes under 64 KB, CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `CampaignStatus`, `create_campaign`, `apply_campaign_goal_progress`.
- `contracts/escrow-contract/src/lib.rs` — `Job`, `create_job`, `release_milestone`, `claim_milestone`.
- `docs/ADR-002-why-direct-to-wallet-payments-over-platform-custody.md` — trust model context.
- `docs/contract-integration.md` — cross-contract call patterns.

---

## Issue #427 — Donation Streaming: Per-Second Linear Vesting via Block Timestamps

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

Implement a Sablier-style donation streaming mechanism where a donor commits a lump sum that is released to the project linearly over time, second by second. The donor can cancel the stream at any time and receive back the unstreamed portion. This is distinct from the existing installment-based `VestingSchedule` — streaming is continuous, not discrete.

### Background

The existing `VestingSchedule` releases funds in discrete installments with fixed intervals. For projects that need continuous funding (e.g., ongoing reforestation labor costs), a streaming model where funds drip continuously is more appropriate. The contract already tracks `env.ledger().timestamp()` (Unix timestamp) which can be used for time-based calculations.

### Problem Statement

Climate projects with ongoing operational costs benefit from predictable, continuous funding. The current vesting model's discrete interval-based releases create lumpy cash flows. A streaming model provides smoother funding and allows donors to commit capital with the ability to withdraw unspent portions.

### Objectives

1. Add `DonationStream` struct: `{ donor, project_id, token, total_amount, started_at_ledger, duration_ledgers, amount_per_ledger, withdrawn: i128, active: bool }`.
2. Add `create_donation_stream(env, donor, project_id, token, total_amount, duration_ledgers)` — donor transfers total_amount to contract, stream starts immediately.
3. Add `withdraw_stream(env, project_wallet, stream_id)` — project wallet withdraws streamed but unclaimed amount. Computed as: `min(total_amount, (current_ledger - started_at_ledger) * total_amount / duration_ledgers) - withdrawn`.
4. Add `cancel_stream(env, donor, stream_id)` — donor cancels stream, receives back `total_amount - withdrawable`.
5. Streamed amounts are recorded as donations when withdrawn, updating project totals, donor stats, and global CO₂ counters.
6. One stream per (donor, project_id, token) at a time to keep storage bounded.

### Scope

**In Scope:**
- New types, functions, events as described.
- Stream creation with full token transfer to contract.
- Stream withdrawal with on-chain time calculation.
- Stream cancellation with refund.
- Donation recording at withdrawal time (not at creation time).
- `DataKey::DonationStream(Address)` and `DataKey::StreamCount`.

**Out of Scope:**
- Multiple concurrent streams per donor-project pair.
- Stream pausing and resuming.
- Stream NFT or transferability.
- Auto-compounding streams.

### Acceptance Criteria

- [ ] `create_donation_stream` transfers total amount to contract and records stream state.
- [ ] `withdraw_stream` transfers correct proportional amount based on elapsed ledgers.
- [ ] `withdraw_stream` updates donation stats only for the withdrawn portion.
- [ ] `cancel_stream` correctly calculates and returns unstreamed portion to donor.
- [ ] Stream withdrawal is idempotent — calling twice before new ledgers elapse transfers nothing and doesn't corruption.
- [ ] A cancelled stream cannot be withdrawn from.
- [ ] A completed stream (100% streamed) cannot be cancelled.
- [ ] Events emitted for create, withdraw, cancel.

### Testing Requirements

- **Unit tests**: `test_create_stream`, `test_withdraw_partial`, `test_withdraw_all`, `test_withdraw_idempotent`, `test_cancel_stream_refunds`, `test_cancel_completed_stream_panics`, `test_withdraw_cancelled_stream_panics`, `test_stream_donation_stats_on_withdraw`.
- **Integration tests**: Create stream, advance ledger 50%, withdraw, advance to 100%, withdraw remainder, verify project wallet and donation stats.
- **Fuzz tests**: `prop_stream_withdraw_never_exceeds_elapsed`, `prop_stream_cancel_refund_is_exact`.

### CI Requirements

- Standard: tests pass, WASM under 64 KB, clippy, fmt.

### Deliverables

1. `DonationStream` type, `DataKey` variants, and streaming functions in `lib.rs`.
2. Donation stats integration at withdrawal time.
3. Unit, integration, and fuzz tests.
4. Updated `EVENTS.md`.
5. Updated `SECURITY.md` with stream trust model (contract holds funds).

### Definition of Done

- All acceptance criteria met. All tests pass. WASM under 64 KB. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `VestingSchedule`, token transfer patterns, `DataKey::ProjectContractBalance`.
- `contracts/EVENTS.md` — vesting events as model for stream events.

---

## Issue #428 — Emergency Withdrawal Multi-Token Batch Execution

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

The existing emergency withdrawal system (`initiate_emergency_withdrawal`, `execute_emergency_withdrawal`, `cancel_emergency_withdrawal`) only supports one withdrawal at a time per project because `DataKey::EmergencyWithdrawal(String)` is keyed by `project_id` only. This means a project with both XLM and USDC contract-held balances must execute two sequential 7-day withdrawal cycles. Add batch emergency withdrawal support so all tokens can be withdrawn in a single 7-day timelock.

### Background

The `EmergencyWithdrawal` struct is defined as:
```rust
pub struct EmergencyWithdrawal {
    pub new_wallet: Address,
    pub amount: i128,
    pub token: Address,
    pub initiated_at: u32,
    pub executable_at: u32,
}
```

And `DataKey::EmergencyWithdrawal(String)` stores one withdrawal per project. The comment in the code acknowledges: "One per project at a time (keyed by project_id only — a project holding multiple tokens must execute withdrawals sequentially, not in parallel)."

### Problem Statement

During a real emergency (e.g., project wallet key compromise), the admin needs to evacuate ALL project funds to a new wallet as quickly as possible. The current sequential 7-day cycle means a project with 3 token balances needs 21 days to fully evacuate, leaving funds at risk for 14 extra days.

### Objectives

1. Change `DataKey::EmergencyWithdrawal` to support multiple concurrent withdrawals per project by adding a token discriminator: `DataKey::EmergencyWithdrawal(String, Address)` — `(project_id, token_address)`.
2. Update `initiate_emergency_withdrawal` to accept and store per-token withdrawals.
3. Update `execute_emergency_withdrawal` to execute one specific withdrawal.
4. Add `execute_all_emergency_withdrawals(env, project_id)` — batch-executes all ready withdrawals for a project in one call.
5. Add `cancel_all_emergency_withdrawals(env, signers, project_id)` — batch-cancels all pending withdrawals for a project.
6. Emit events per withdrawal, with an additional `ew_batch` event when batch-executing.

### Scope

**In Scope:**
- Change `DataKey` variant to `EmergencyWithdrawal(String, Address)`.
- Update all three existing functions to use the new key scheme.
- New `execute_all_emergency_withdrawals` and `cancel_all_emergency_withdrawals`.
- Backward-compatible: the old key without token discriminator should be migrated on first access.
- Each withdrawal still follows the 7-day individual timelock.

**Out of Scope:**
- Reducing the 7-day timelock.
- Partial emergency withdrawals per token.
- Automatic trigger conditions for emergency withdrawal.

### Acceptance Criteria

- [ ] Multiple emergency withdrawals can be initiated for the same project with different tokens.
- [ ] Each withdrawal has its own independent 7-day timelock.
- [ ] `execute_all_emergency_withdrawals` executes all ready withdrawals in one call.
- [ ] `cancel_all_emergency_withdrawals` cancels all pending withdrawals for a project.
- [ ] Old single-withdrawal key is migrated on first access.
- [ ] Each withdrawal correctly transfers the specified token from contract to new wallet.

### Testing Requirements

- **Unit tests**: `test_initiate_multiple_ew_tokens`, `test_execute_ew_single_token`, `test_execute_all_ew`, `test_cancel_all_ew`, `test_ew_migration_from_v1_key`, `test_ew_staggered_timelocks`.
- **Integration tests**: Deposit XLM and USDC to contract, initiate EW for both, fast-forward 7 days, batch-execute, verify both tokens transferred.
- **Fuzz tests**: `prop_ew_batch_never_exceeds_balance`.

### CI Requirements

- Standard.

### Deliverables

1. Updated `DataKey::EmergencyWithdrawal(String, Address)` and migration.
2. Updated emergency withdrawal functions.
3. Batch execution and cancellation functions.
4. Unit, integration, and fuzz tests.
5. Updated `EVENTS.md`.

### Definition of Done

- All criteria met. Tests pass. WASM under 64 KB. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `EmergencyWithdrawal` struct, `initiate_emergency_withdrawal`, `execute_emergency_withdrawal`, `cancel_emergency_withdrawal`.
- `contracts/EVENTS.md` — topics 13–15 (emergency withdrawal events).

---

## Issue #429 — Refund Request Escalation Path with Multi-Sig Timelock

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

Enhance the donation refund system (#290) with an escalation path for cases where the project wallet refuses to co-sign a refund. Currently, `approve_refund` requires both admin authorization AND project wallet co-signature. If the project wallet is adversarial, honest-mistake refunds cannot be processed. Add a multi-sig admin timelock override that can force-approve a refund after a 72-hour waiting period.

### Background

The `RefundRequest` system (from #290) works as follows:
- Donor calls `request_refund` within 24 hours of donation.
- Admin + project wallet call `approve_refund` — token transfer happens atomically.
- Admin calls `reject_refund` to deny.

The `SECURITY.md` Refund section notes: "If the project wallet does not co-sign, the approval reverts entirely... The fourth scenario (project found to be fraudulent) is unresolvable on-chain without escrow."

### Problem Statement

When a project is found to be fraudulent after donations are made, the project wallet will not co-sign refunds. Donors have no on-chain recourse. An M-of-N admin override with a timelock provides a safety valve while preventing single-admin abuse.

### Objectives

1. Add `force_approve_refund(env, signers: Vec<Address>, refund_id: u32)` — M-of-N admin can initiate a force-approval.
2. The force-approval is not immediate — it has a 72-hour timelock (`FORCE_REFUND_TIMELOCK_LEDGERS = 51_840`).
3. During the 72-hour window, any admin can call `cancel_force_refund(env, admin, refund_id)` to cancel the escalation.
4. After the timelock, anyone can call `execute_force_refund(env, refund_id)` to complete the refund.
5. The refund transfers tokens from the project wallet to the donor — this requires the contract to have a token approval or the project wallet to have pre-approved the contract. Since the project wallet won't co-sign, the force-refund path must use a different mechanism: the contract calls `token::Client::transfer` with the project wallet as the source, but this requires the project wallet to have approved the contract as a spender. Alternative: use admin-controlled contract-held funds as a refund pool.
6. New `DataKey::ForceRefund(u32)` — stores pending force-refund with effective-at ledger.
7. New events: `rfnd_force_init`, `rfnd_force_exec`, `rfnd_force_cncl`.

### Scope

**In Scope:**
- M-of-N force-approval initiation and timelock.
- Event emissions for the escalation lifecycle.
- Refund amount + CO₂ reversal as in normal refunds.
- Integration with existing `RefundRequest` — force-approved refund sets `status = Approved` and processes the transfer.

**Out of Scope:**
- Automated fraud detection triggers.
- Donor collateral requirements.
- Partial force-refunds.

### Acceptance Criteria

- [ ] M-of-N admins can initiate force-approval.
- [ ] Force-approval requires 72-hour timelock before execution.
- [ ] Any admin can cancel during timelock.
- [ ] After timelock, anyone can execute the force-refund.
- [ ] Force-refund correctly transfers tokens and reverses donation stats.
- [ ] Single admin cannot force-approve (M-of-N required).
- [ ] Normal refund flow is unchanged.

### Testing Requirements

- **Unit tests**: `test_force_approve_refund_m_of_n`, `test_force_approve_single_admin_panics`, `test_execute_force_refund_before_timelock_panics`, `test_execute_force_refund_after_timelock`, `test_cancel_force_refund`, `test_cancel_force_refund_after_execution_panics`.
- **Integration tests**: Full refund → force escalation → timelock → execute → verify balances.
- **Fuzz tests**: `prop_force_refund_requires_m_of_n`.

### CI Requirements

- Standard.

### Deliverables

1. Force-refund functions, types, DataKeys, and events in `lib.rs`.
2. Unit, integration, and fuzz tests.
3. Updated `SECURITY.md` with force-refund trust model.
4. Updated `EVENTS.md`.

### Definition of Done

- All criteria met. Tests pass. WASM under 64 KB. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `RefundRequest`, `request_refund`, `approve_refund`, `reject_refund`.
- `contracts/indigopay-contract/SECURITY.md` — Refund section, known limitation for adversarial project wallets.

---

## Issue #430 — Impact Certificate Merkle Mountain Range for Gas-Efficient Batch Verification

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

Replace the current single-root Merkle tree impact certificate system (#382, behind `#[cfg(feature = "impact")]`) with a Merkle Mountain Range (MMR) that supports append-only root updates without rebuilding the entire tree. This allows incremental impact reporting periods where each period's root is appended to the MMR, and a donor can prove inclusion against any period's root using a single unified proof.

### Background

The current impact certificate system uses:
- `verify_merkle_proof(env, leaf, proof, root, index)` — verifies a single Merkle proof against a known root.
- `compute_impact_leaf_hash` — hashes an `ImpactLeaf` for proof verification.
- `impact_merkle_key` — computes storage key from `(project_id, report_id)`.
- `ImpactKey::ImRoot(BytesN<32>)` — stores a single Merkle root.

This is a flat Merkle tree model: each reporting period has a separate root. Proving impact across multiple periods requires separate proofs.

### Problem Statement

For projects with multiple reporting periods (monthly impact reports), the current single-root model requires donors to store and verify multiple proofs. An MMR enables a single cumulative proof that covers all historical reporting periods with logarithmic proof size, reducing on-chain verification costs and off-chain proof storage.

### Objectives

1. Implement an append-only Merkle Mountain Range in the contract.
2. Store the MMR peak hashes on-chain.
3. `append_impact_root(env, admin, project_id, new_root)` — append a new period's Merkle root to the MMR.
4. `verify_impact_inclusion(env, project_id, leaf, proof, leaf_index, mmr_index) -> bool` — verify that a leaf is included in the MMR at position `mmr_index` using the MMR proof.
5. Maintain backward compatibility with existing single-root Merkle verification.
6. Proof format: `(siblings: Vec<BytesN<32>>, peak_indices: Vec<u32>)` following the MMR proof standard.

### Scope

**In Scope:**
- MMR implementation (append, peak calculation, proof verification).
- New `DataKey::ImpactMMRPeaks(String)` — stores peak hashes per project.
- New `DataKey::ImpactMMRSize(String)` — number of leaves in the MMR per project.
- New `append_impact_root` and `verify_impact_inclusion` functions.
- Backward compatibility with existing `ImpactKey::ImRoot`.

**Out of Scope:**
- MMR pruning or compaction.
- Proof aggregation across projects.
- ZK-proof integration with MMR.

### Acceptance Criteria

- [ ] MMR correctly computes peak hashes on append.
- [ ] `verify_impact_inclusion` returns true for valid proofs.
- [ ] `verify_impact_inclusion` returns false for invalid proofs.
- [ ] Proof size is logarithmic in the number of leaves.
- [ ] Existing single-root merkle verification still works.
- [ ] MMR supports at least 2^20 leaves.

### Testing Requirements

- **Unit tests**: `test_mmr_append_single`, `test_mmr_append_multiple`, `test_mmr_proof_verification`, `test_mmr_proof_invalid`, `test_mmr_peak_calculation`, `test_mmr_large_tree`.
- **Integration tests**: Build MMR off-chain, append roots to contract, generate proof, verify on-chain.
- **Fuzz tests**: `prop_mmr_proof_verification_random_tree`.

### CI Requirements

- Standard.

### Deliverables

1. MMR module in `lib.rs` behind `#[cfg(feature = "impact")]`.
2. New DataKey variants and storage management.
3. `append_impact_root`, `verify_impact_inclusion` functions.
4. Unit, integration, and fuzz tests.
5. Updated `EVENTS.md`.

### Definition of Done

- All criteria met. Tests pass. WASM under 64 KB (MMR code gated by `impact` feature). CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `verify_merkle_proof`, `compute_impact_leaf_hash`, `impact_merkle_key`, `ImpactLeaf`, `ImpactKey`.
- `contracts/indigopay-contract/VERIFICATION.md` — formal verification approach.

---

## Issue #431 — Sub-Project Aggregate Metrics and Hierarchical Rollup

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

Implement on-chain hierarchical metrics aggregation for parent-child project relationships. Currently, sub-projects (created via `register_sub_project`, tracked in `DataKey::SubProjectIds(String)`) are independent entities — their `total_raised`, `donor_count`, and impact metrics are isolated from the parent. Add a rollup mechanism that maintains parent-level aggregate metrics updated atomically on every child donation.

### Background

The sub-project system (from #391) introduced `Project.parent_project_id` and `DataKey::SubProjectIds(String)`. A parent project can have many sub-projects. Deactivation cascades from parent to children. However, the parent project's `total_raised` and `donor_count` do not roll up from children — each project's stats are independent.

### Problem Statement

Donors who view a parent project (e.g., "Amazon Rainforest") should see the total impact across all sub-projects (e.g., "Amazon-Brazil", "Amazon-Peru", "Amazon-Colombia"). Without rollup, the parent shows only direct donations to the parent, underreporting total impact.

### Objectives

1. Add `DataKey::ParentProject(String)` — reverse index from child to parent.
2. On every donation to a sub-project, atomically update the parent chain's aggregate metrics all the way to the root.
3. New aggregate fields on `Project`: `aggregate_total_raised: i128`, `aggregate_donor_count: u32`, `aggregate_co2: i128`.
4. `get_project_aggregate(project_id) -> ProjectAggregate` — returns both direct and rolled-up metrics.
5. Deactivation/activation cascading already exists — extend it to freeze/restore aggregate updates.
6. Recursive vs iterative walk: use iterative walk up the parent chain to avoid Soroban recursion limits.
7. Handle cycles: `register_sub_project` must validate that the new sub-project's parent chain does not create a cycle (walk up to root, check for equality with new project_id).

### Scope

**In Scope:**
- Parent-chain aggregate update on donation.
- `get_project_aggregate` query.
- Cycle detection in registration.
- Cascade on deactivation/activation.
- Events for aggregate updates.

**Out of Scope:**
- Multi-parent projects (DAG structure).
- Aggregation across unrelated projects.
- Time-windowed aggregate queries.

### Acceptance Criteria

- [ ] Donation to a sub-project updates all ancestor aggregates.
- [ ] `get_project_aggregate` returns direct + rollup metrics.
- [ ] Cycle detection prevents circular parent relationships.
- [ ] Deactivating a parent cascades to children and freezes aggregate updates.
- [ ] Aggregate updates are atomic with donations.
- [ ] Maximum parent chain depth is bounded (e.g., 10 levels).

### Testing Requirements

- **Unit tests**: `test_sub_project_aggregate_update`, `test_deep_chain_aggregate`, `test_cycle_detection_panics`, `test_max_depth_panics`, `test_deactivated_parent_freeze`.
- **Integration tests**: Create parent, create 3 children at different levels, donate to deepest child, verify all ancestor aggregates.
- **Fuzz tests**: `prop_aggregate_equals_sum_of_children`.

### CI Requirements

- Standard.

### Deliverables

1. Aggregate tracking on `Project` struct (new fields appended for backward compatibility).
2. Parent-chain update logic in donation path.
3. Cycle detection in `register_sub_project`.
4. `get_project_aggregate` query.
5. Unit, integration, and fuzz tests.
6. Updated `UPGRADE.md` with new Project fields.

### Definition of Done

- All criteria met. Tests pass. WASM under 64 KB. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `Project` struct (with `parent_project_id` appended), `register_sub_project`, `deactivate_project` (cascade), `DataKey::SubProjectIds`.
- `contracts/indigopay-contract/UPGRADE.md` — appending new fields for backward compatibility.

---

## Issue #432 — ZK-SNARK Anonymous Donation Proof Verification

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: high`, `area: indigopay-contract`

### Summary

Implement on-chain verification of zero-knowledge proofs for anonymous donations. The contract already has `DataKey::ZkVerificationKey` and `DataKey::Nullifier(BytesN<32>)` for zk-SNARK anonymous donations (#390). This issue implements the actual proof verification logic and integrates it with the donation flow, enabling donors to prove they made a donation without revealing their identity or the exact amount, while the contract verifies the proof and records the anonymized donation.

### Background

The `DataKey::Nullifier(BytesN<32>)` is present in the codebase but no proof verification logic exists. The existing anonymous donation mechanism (`anonymous: true` in `donate_with_privacy`) only hides the donor's address from public queries (uses zero-address placeholder) — the donation is still linkable on-chain because the transaction sender is visible.

A zk-SNARK approach would allow the donor to submit a proof that:
1. They made a valid donation to a registered project.
2. The amount is within valid bounds.
3. A nullifier prevents double-spending of the same proof.

Without revealing the donor's address or the exact amount.

### Problem Statement

Current anonymous donations use a zero-address placeholder for public queries but remain linkable to the transaction sender via Stellar ledger analysis. True anonymity requires cryptographic proof that the donation happened without linking it to a specific address. ZK-SNARKs provide this while maintaining on-chain verifiability.

### Objectives

1. Implement a Groth16 proof verifier in the Soroban contract (or simpler: use Poseidon hashes for a simpler ZK-friendly hash-based approach if WASM size is a concern).
2. `set_zk_verification_key(env, signers, vk: Bytes)` — M-of-N admin sets the verification key (circuit-specific).
3. `donate_anonymous_zk(env, proof: Bytes, public_inputs: Vec<BytesN<32>>, nullifier: BytesN<32>, project_id: String)` — verifies proof, checks nullifier uniqueness, records donation.
4. The public inputs to the proof include: `project_id_hash`, `amount_commitment`, `nullifier`.
5. The contract records the donation without linking to a donor address. Donation stats for global/project totals are updated; donor-specific stats are NOT updated (the donor is anonymous even to the contract).
6. Nullifier check: `DataKey::Nullifier(nullifier)` must not already exist.

### Scope

**In Scope:**
- Groth16 verifier or Poseidon-based commitment scheme for ZK proofs.
- Nullifier double-spend prevention.
- Anonymous donation recording (global stats only, no donor stats).
- Verification key management by M-of-N admins.
- WASM size-conscious implementation (feature-gated behind `#[cfg(feature = "zk")]`).

**Out of Scope:**
- Circuit design (the ZK circuit is implemented off-chain).
- Proof generation (off-chain concern).
- Multiple circuit support.
- Recursive proof aggregation.

### Acceptance Criteria

- [ ] `set_zk_verification_key` stores the VK with M-of-N auth.
- [ ] `donate_anonymous_zk` verifies a valid proof and records donation.
- [ ] `donate_anonymous_zk` panics on invalid proof.
- [ ] `donate_anonymous_zk` panics on reused nullifier.
- [ ] Donation updates project totals and global stats.
- [ ] Donor stats are NOT updated (anonymous even to contract).
- [ ] Proper events emitted for indexers.
- [ ] WASM size remains under 64 KB with `zk` feature enabled (use minimal curve implementation).

### Testing Requirements

- **Unit tests**: `test_zk_verify_valid_proof`, `test_zk_reject_invalid_proof`, `test_zk_nullifier_reuse_panics`, `test_zk_donation_stats_update`, `test_zk_set_vk`, `test_zk_set_vk_not_admin_panics`.
- **Integration tests**: Generate test proof off-chain (using test keys), submit to contract, verify donation recorded.
- **Fuzz tests**: `prop_zk_nullifier_uniqueness`.

### CI Requirements

- Standard with `--features "testutils,zk"`.

### Deliverables

1. ZK proof verification in `lib.rs` behind `#[cfg(feature = "zk")]`.
2. Nullifier tracking.
3. Anonymous donation entrypoint.
4. Unit, integration, and fuzz tests.
5. Updated `SECURITY.md` with ZK trust model.
6. Updated `EVENTS.md`.

### Definition of Done

- All criteria met. Tests pass with `zk` feature. WASM under 64 KB. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `DataKey::ZkVerificationKey`, `DataKey::Nullifier(BytesN<32>)`.
- `contracts/EVENTS.md` — anonymous donation event (topic 1) with zero-address placeholder.
- `contracts/indigopay-contract/SECURITY.md` — anonymous donation privacy model.

---

## Issue #433 — Storage Garbage Collection for Expired Proposals and Vesting Schedules

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

Implement a storage garbage collection mechanism to clean up expired governance proposals and completed/cancelled vesting schedules. Soroban instance storage grows monotonically; without cleanup, stale data increases state bloat and TTL extension costs. This issue adds cleanup functions callable by anyone after a grace period, with appropriate event emissions for indexer reconciliation.

### Background

The contract stores:
- `DataKey::Proposal(String)` — `VoteProposal` structs, which include `resolved: bool`.
- `DataKey::HasVoted(String, Address)` — per-voter per-proposal flags.
- `DataKey::VoterList(String)` — per-proposal voter lists.
- `DataKey::VestingSchedule(Address, u32)` — vesting schedules.
- `DataKey::DonorVestingCount(Address)` — per-donor vesting count.

Once a proposal is resolved or a vesting schedule is completed/cancelled, these storage entries are no longer needed for contract logic but remain in storage, consuming state and requiring TTL extension payments.

### Problem Statement

Unbounded storage growth increases operational costs and eventual state bloat. The contract should provide a permissionless cleanup mechanism that removes stale data after a grace period (e.g., 30 days after resolution/completion) to allow indexers to catch up.

### Objectives

1. Add `cleanup_proposal(env, project_id)` — anyone can call after `resolved_at + GRACE_PERIOD` ledgers. Removes `Proposal`, `HasVoted` entries, and `VoterList`.
2. Add `cleanup_vesting_schedule(env, donor, schedule_id)` — anyone can call after vesting schedule is completed/cancelled and grace period elapsed.
3. `GRACE_PERIOD_LEDGERS = 518_400` (30 days @ 5s/ledger).
4. Add `resolved_at: u32` field to `VoteProposal` (appended for backward compatibility).
5. Add `completed_at: u32` field to `VestingSchedule` (appended for backward compatibility).
6. Emit `prop_clean` and `vest_clean` events so indexers can reconcile.
7. The cleanup function must be permissionless so anyone can help keep the chain lean.

### Scope

**In Scope:**
- Proposal cleanup (remove proposal, voter list, individual votes).
- Vesting schedule cleanup (completed or cancelled schedules).
- Configurable grace period (default 30 days).
- Permissionless invocation.
- Event emissions for indexers.

**Out of Scope:**
- Automated or scheduled cleanup (no cron-like on-chain mechanism).
- Cleanup of donation records (these are immutable).
- Cleanup of project data (even deactivated projects).
- Batching multiple cleanups in one call.

### Acceptance Criteria

- [ ] `cleanup_proposal` removes proposal and all associated vote data after grace period.
- [ ] `cleanup_proposal` panics if proposal is not resolved.
- [ ] `cleanup_proposal` panics if grace period has not elapsed.
- [ ] `cleanup_vesting_schedule` removes schedule data after grace period.
- [ ] Events emitted with cleaned item identifiers.
- [ ] Cleanup reduces storage footprint (verifiable via `env.storage().instance().has()`).

### Testing Requirements

- **Unit tests**: `test_cleanup_resolved_proposal`, `test_cleanup_unresolved_panics`, `test_cleanup_before_grace_period_panics`, `test_cleanup_vesting_completed`, `test_cleanup_vesting_active_panics`, `test_cleanup_idempotent`.
- **Integration tests**: Create proposal, resolve it, fast-forward 30 days, cleanup, verify storage keys removed.
- **Fuzz tests**: `prop_cleanup_only_removes_stale_data`.

### CI Requirements

- Standard.

### Deliverables

1. Cleanup functions and grace period constant in `lib.rs`.
2. `resolved_at` on `VoteProposal`, `completed_at` on `VestingSchedule`.
3. Events `prop_clean`, `vest_clean`.
4. Unit, integration, and fuzz tests.
5. Updated `EVENTS.md` and `UPGRADE.md`.

### Definition of Done

- All criteria met. Tests pass. WASM under 64 KB. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `VoteProposal`, `VestingSchedule`, `DataKey` variants.
- `contracts/indigopay-contract/UPGRADE.md` — appending fields for backward compatibility.

---

## Issue #434 — Platform Fee Distribution with Configurable Splits

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

Enhance the platform fee system (#385, behind `#[cfg(feature = "fees")]`) to support configurable fee splits to multiple recipients. Currently, `split_fee` splits into (project_amount, fee_amount) with the fee going to a single `PlatformTreasury`. Allow the admin to configure N recipients each receiving a percentage of the fee, enabling DAO treasury, developer fund, and climate offset fund splits.

### Background

The fee system uses:
- `DataKey::PlatformFeeBps` — fee in basis points.
- `DataKey::PlatformTreasury` — single treasury address.
- `split_fee(amount, fee_bps) -> (project_amount, fee_amount)`.
- `set_platform_fee(env, signers, fee_bps)` and `set_platform_treasury(env, signers, treasury)`.

The fee is transferred to a single treasury. Many platforms split fees across multiple stakeholders (e.g., 50% to operations, 30% to developer fund, 20% to carbon offset purchase fund).

### Problem Statement

A single treasury address limits fee distribution flexibility. Community-governed fee splits require a multi-recipient system where each recipient's share is configurable and all splits sum to 100%.

### Objectives

1. Replace `DataKey::PlatformTreasury` with `DataKey::PlatformFeeRecipients` (a `Vec<FeeRecipient>`).
2. `FeeRecipient` struct: `{ address: Address, share_bps: u32 }` — shares must sum to 10000 (100%).
3. Update `set_platform_fee_recipients(env, signers, recipients: Vec<FeeRecipient>)` — M-of-N admin.
4. Update `split_fee` to distribute the fee among recipients proportionally.
5. Update donation code to iterate recipients and transfer each share.
6. Backward compatibility: if old `PlatformTreasury` exists and new `PlatformFeeRecipients` doesn't, treat the old treasury as 100% recipient.
7. Migration: first call to `set_platform_fee_recipients` reads old treasury and creates a single-recipient list.

### Scope

**In Scope:**
- Multi-recipient fee distribution.
- Recipient share validation (sum to 100%).
- Backward compatibility and migration from single treasury.
- Per-recipient transfer in donation flow (within CEI ordering).
- Events updated to include recipient breakdown.

**Out of Scope:**
- Dynamic fee splits based on donation amount.
- Per-project fee overrides.
- Fee recipient staking or governance.

### Acceptance Criteria

- [ ] `set_platform_fee_recipients` stores recipients and validates share sum.
- [ ] Fee distributed proportionally to all recipients.
- [ ] Each recipient receives the correct share (no rounding errors larger than 1 stroop).
- [ ] Old single-treasury config is migrated correctly.
- [ ] Sum of all transfers equals total fee amount.
- [ ] M-of-N auth required for recipient changes.

### Testing Requirements

- **Unit tests**: `test_multi_recipient_fee_split`, `test_recipient_shares_dont_sum_to_100_panics`, `test_single_recipient_migration`, `test_fee_distribution_exact_sum`.
- **Integration tests**: Configure 3 recipients (50/30/20), donate, verify each recipient balance.
- **Fuzz tests**: `prop_fee_sum_equals_total`.

### CI Requirements

- Standard with `--features "testutils,fees"`.

### Deliverables

1. `FeeRecipient` type, updated `DataKey`, updated fee split logic.
2. Migration from old treasury.
3. Unit, integration, and fuzz tests.
4. Updated `EVENTS.md` and `SECURITY.md`.

### Definition of Done

- All criteria met. Tests pass. WASM under 64 KB. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `split_fee`, `read_platform_fee_bps`, `DataKey::PlatformFeeBps`, `DataKey::PlatformTreasury`, fee transfer in `donate_with_privacy`.

---

## Issue #435 — Per-Token Rate Limit Configuration

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: low`, `area: indigopay-contract`

### Summary

Extend the donation rate limiting system to support per-token rate limit configurations. Currently, `DataKey::DonationRateLimitMax` and `DataKey::DonationRateLimitWindow` are global constants applied to all donations regardless of token. With multi-token support (#421), different tokens should have different rate limiting policies (e.g., XLM might allow 10/hr, USDC might allow 5/hr due to different value profiles).

### Background

Rate limiting uses:
- `DataKey::DonationRateLimitMax` — max donations per window (`DEFAULT_DONATION_RATE_LIMIT_MAX = 10`).
- `DataKey::DonationRateLimitWindow` — window size in ledgers (`DEFAULT_DONATION_RATE_LIMIT_WINDOW = 720`).
- `DataKey::DonorRateLimit(Address, String)` — per-donor per-project sliding window.

The current system applies the same limits to all tokens.

### Problem Statement

Different tokens have different value densities (1 XLM ≈ $0.10 vs 1 USDC = $1.00). A rate limit of 10 donations per hour might be appropriate for XLM but overly permissive for USDC. Per-token configuration enables appropriate risk management per asset.

### Objectives

1. Add `DataKey::TokenRateLimitMax(Address)` — max donations per window for a specific token.
2. Add `DataKey::TokenRateLimitWindow(Address)` — window size for a specific token.
3. Add `set_token_rate_limit(env, admin, token, max, window)` — routine admin action.
4. When a donation is processed, check token-specific limits first; fall back to global defaults if not configured.
5. Updated rate limit key: `DataKey::DonorRateLimit(Address, String, Address)` — adds token discriminator.

### Scope

**In Scope:**
- Per-token rate limit configuration.
- Fallback to global defaults.
- Updated rate limit key with token discriminator.
- Admin management functions.
- `get_token_rate_limit(token) -> (max: u32, window: u32)` getter.

**Out of Scope:**
- Per-project rate limit overrides.
- Donor-specific rate limit tiers.
- Dynamic rate limits based on donation volume.

### Acceptance Criteria

- [ ] Per-token rate limits can be configured independently.
- [ ] Donations are rate-limited per the token-specific config.
- [ ] Global defaults used when no token-specific config exists.
- [ ] Rate limit key migration from 2-arg to 3-arg is handled.
- [ ] Admin routine auth sufficient for configuration.

### Testing Requirements

- **Unit tests**: `test_per_token_rate_limit`, `test_per_token_rate_limit_fallback`, `test_per_token_rate_limit_isolation`, `test_set_token_rate_limit`, `test_rate_limit_key_migration`.

### CI Requirements

- Standard.

### Deliverables

1. New DataKey variants and functions.
2. Updated rate limiting logic in donation path.
3. Unit tests.
4. Updated `UPGRADE.md` with storage key migration.

### Definition of Done

- All criteria met. Tests pass. WASM under 64 KB. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — rate limit constants, `DonorRateLimit` key, donation rate limit checks.

---

## Issue #436 — Multi-Round Governance Voting with Proposal Lifecycle States

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

Extend the governance proposal system from a single voting round to a multi-round lifecycle. Currently, `VoteProposal` has one round: create → vote → resolved (by reaching threshold or deadline). Add draft, deliberation, voting, and execution phases with configurable durations per phase, enabling community discussion before voting begins.

### Background

The current `VoteProposal` struct:
```rust
pub struct VoteProposal {
    pub project_id: String,
    pub votes_for: u32,
    pub votes_against: u32,
    pub deadline_ledger: u32,
    pub resolved: bool,
}
```

Voting starts immediately upon creation and has a single deadline. The `create_proposal` function sets `deadline_ledger` and the proposal auto-resolves when passed.

### Problem Statement

Immediate voting without a deliberation period can lead to uninformed decisions. Multi-round governance with distinct phases (submission → deliberation → voting → execution) is standard in mature DAOs and improves decision quality.

### Objectives

1. Add `ProposalPhase` enum: `Draft`, `Deliberation`, `Voting`, `Passed`, `Rejected`, `Executed`.
2. Add phase transition timestamps to `VoteProposal`: `deliberation_end: u32`, `voting_end: u32`.
3. Update `create_proposal` to accept deliberation and voting durations.
4. Add `advance_proposal_phase(env, project_id)` — anyone can call to auto-advance to next phase if current phase deadline has passed.
5. Voting only possible during `Voting` phase.
6. If a proposal passes, add an `execution_delay` before it can be finalized (timelock for safety).
7. `execute_proposal(env, project_id)` — finalize a passed proposal after execution delay.
8. Emit phase transition events: `prop_phase(project_id, old_phase, new_phase)`.

### Scope

**In Scope:**
- Multi-phase proposal lifecycle.
- Phase transition automation.
- Voting gated by `Voting` phase.
- Execution delay for passed proposals.
- Phase transition events.

**Out of Scope:**
- Proposal amendments during deliberation.
- Proposal bundling.
- Conditional execution based on external data.

### Acceptance Criteria

- [ ] Proposal moves through Draft → Deliberation → Voting automatically.
- [ ] Voting only succeeds during Voting phase.
- [ ] Passed proposals have execution delay before finalization.
- [ ] Phase transitions emit events.
- [ ] `advance_proposal_phase` is idempotent and permissionless.
- [ ] Phase durations are configurable per proposal.
- [ ] Existing single-round behavior is preserved as default (deliberation = 0).

### Testing Requirements

- **Unit tests**: `test_proposal_phase_progression`, `test_vote_during_deliberation_panics`, `test_vote_during_voting_succeeds`, `test_execute_before_delay_panics`, `test_execute_after_delay`, `test_advance_idempotent`.
- **Integration tests**: Full lifecycle with phase transitions.
- **Fuzz tests**: `prop_phase_transition_invariants`.

### CI Requirements

- Standard.

### Deliverables

1. `ProposalPhase` enum, updated `VoteProposal`, phase transition logic.
2. `advance_proposal_phase`, `execute_proposal` functions.
3. Phase transition events.
4. Tests.
5. Updated `EVENTS.md`.

### Definition of Done

- All criteria met. Tests pass. WASM under 64 KB. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `VoteProposal`, `create_proposal`, `vote_verify_project`.
- `contracts/EVENTS.md` — governance events.

---

## Issue #437 — On-Chain Project Verification Oracle Network

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: high`, `area: indigopay-contract`, `area: oracle-contract`

### Summary

Create an on-chain project verification oracle that aggregates verification attestations from multiple trusted verifiers. Currently, project registration is purely admin-driven — the admin calls `register_project` and the project is active. There is no on-chain verification status beyond the `active` boolean. This issue builds a multi-verifier attestation system where N-of-M verifiers must attest to a project's legitimacy before it can accept donations.

### Background

The governance system allows badge holders to vote on project verification, but this is a slow, community-driven process. The `attestation-contract` demonstrates a pattern for recording cross-chain attestations from a relayer. This issue applies a similar pattern for project verification: designated verifiers (auditors, domain experts) submit attestations on-chain, and when a threshold is met, the project is marked as verified.

The oracle-contract shows a reporter management pattern that can be adapted for verifier management.

### Problem Statement

Admin-only project registration creates a trust bottleneck. A multi-verifier attestation system distributes trust across independent verifiers and provides on-chain proof of verification that donors can query.

### Objectives

1. Add verifier management to indigopay-contract: `add_verifier(env, signers, verifier)`, `remove_verifier(env, signers, verifier)` — M-of-N admin.
2. Add `DataKey::VerifierSet` and `DataKey::VerificationThreshold`.
3. Add `DataKey::ProjectVerification(String)` — stores per-project verification state: `{ attestations: Vec<Attestation>, status: VerificationStatus }`.
4. `VerificationStatus`: `Unverified`, `Pending(u32)` (count of attestations), `Verified`, `Rejected`.
5. Add `attest_project(env, verifier, project_id, evidence_hash: BytesN<32>)` — verifier submits a signed attestation.
6. When attestation count reaches threshold, project status auto-transitions to `Verified`.
7. Add `revoke_verification(env, signers, project_id)` — M-of-N admin can revoke in case of fraud.
8. A project must be `Verified` (or `Unverified` with `VerificationThreshold == 0`) to accept donations.
9. Events: `proj_attest`, `proj_verified`, `proj_verf_rev`.

### Scope

**In Scope:**
- Verifier set management (M-of-N).
- Multi-attestation project verification.
- Auto-transition to Verified on reaching threshold.
- Verification revocation by M-of-N admins.
- Donation gate based on verification status.
- Events for all state transitions.

**Out of Scope:**
- Verifier reputation or staking.
- Attestation evidence validation (only hash stored on-chain).
- Time-bound verification expiry.
- Integration with external identity oracles.

### Acceptance Criteria

- [ ] Verifiers can be added/removed by M-of-N admins.
- [ ] Verifiers can submit attestations for projects.
- [ ] Threshold met → auto `Verified`.
- [ ] Donations rejected for non-Verified projects (when threshold > 0).
- [ ] Admin revocation clears verification state.
- [ ] Duplicate verifier attestations are rejected.
- [ ] Events emitted for all state changes.

### Testing Requirements

- **Unit tests**: `test_verifier_management`, `test_attest_project`, `test_reach_threshold_auto_verify`, `test_duplicate_attestation_panics`, `test_revoke_verification`, `test_donate_to_unverified_project_panics`, `test_donate_to_verified_project_succeeds`.
- **Integration tests**: Register 3 verifiers with threshold 2, attest from 2 verifiers, project auto-verifies, donation succeeds.
- **Fuzz tests**: `prop_verification_requires_threshold`.

### CI Requirements

- Standard.

### Deliverables

1. Verifier management, attestation, and verification logic in `lib.rs`.
2. Donation gate based on verification status.
3. Tests.
4. Updated `EVENTS.md` and `SECURITY.md`.

### Definition of Done

- All criteria met. Tests pass. WASM under 64 KB. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `register_project`, `Project`, admin management pattern.
- `contracts/attestation-contract/src/lib.rs` — relayer pattern for attestation submission.
- `contracts/oracle-contract/src/lib.rs` — reporter management pattern.

---

## Issue #438 — Impact NFT Metadata Standard and Token URI

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: low`, `area: indigopay-contract`

### Summary

Enrich the Impact NFT system with standard metadata following the Soroban token metadata standard. Currently, `ImpactNFT` and `ProjectMilestoneNFT` structs store minimal data (owner, tier, amount, ledger). Add metadata fields that enable rich NFT display in wallets and marketplaces, including a token URI, image reference, and attributes array.

### Background

Current NFT structs:
```rust
pub struct ImpactNFT {
    pub owner: Address,
    pub tier: BadgeTier,
    pub total_donated: i128,
    pub minted_at_ledger: u32,
}

pub struct ProjectMilestoneNFT {
    pub owner: Address,
    pub project_id: String,
    pub amount_donated: i128,
    pub co2_offset_grams: i128,
    pub minted_at_ledger: u32,
}
```

These are functional but not compatible with standard NFT metadata display in wallets.

### Problem Statement

Impact NFTs currently lack display metadata, making them invisible in NFT wallets and marketplaces. Adding standard metadata fields and a URI reference enables rich display and makes impact achievements shareable as recognizable NFTs.

### Objectives

1. Add `metadata_uri: String` field to both `ImpactNFT` and `ProjectMilestoneNFT` (appended for backward compatibility).
2. Add `Attributes` struct for key-value metadata pairs.
3. Add `set_nft_metadata_uri(env, admin, nft_key, uri)` — admin sets the URI for a batch of NFTs by tier.
4. Add `DataKey::NFTMetadataBaseURI` — base URI for constructing token URIs.
5. Add `DataKey::NFTMetadata(BadgeTier)` — tier-specific metadata (name, description, image).
6. Add `get_nft_metadata(donor, tier) -> NFTMetadata` query.
7. Emit `nft_meta` event when metadata is updated.

### Scope

**In Scope:**
- Metadata structs and storage.
- Admin-configurable metadata.
- Query functions for frontend/wallet integration.
- Backward-compatible field appending.

**Out of Scope:**
- Fully on-chain SVG generation.
- Dynamic metadata updates based on donation history.
- NFT transfer functionality (impact NFTs are soulbound).
- SEP-0041 token interface compliance.

### Acceptance Criteria

- [ ] Metadata can be configured per badge tier.
- [ ] URI can reference off-chain metadata JSON.
- [ ] Query returns full metadata for display.
- [ ] Existing NFT storage is backward compatible.
- [ ] Events emitted on metadata update.

### Testing Requirements

- **Unit tests**: `test_set_nft_metadata`, `test_get_nft_metadata`, `test_metadata_uri_resolution`, `test_backward_compatible_nft_storage`.

### CI Requirements

- Standard.

### Deliverables

1. Metadata types, DataKeys, and functions.
2. Admin configuration endpoints.
3. Tests.
4. Updated `EVENTS.md`.

### Definition of Done

- All criteria met. Tests pass. WASM under 64 KB. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `ImpactNFT`, `ProjectMilestoneNFT`, `BadgeTier`.

---

## Issue #439 — Cross-Contract Donation Attestation Settlement

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: high`, `area: indigopay-contract`, `area: attestation-contract`

### Summary

Create a settlement bridge between `attestation-contract` and `indigopay-contract` so that verified cross-chain donation attestations automatically update donation stats on the main contract. Currently, the attestation contract records cross-chain donations independently — they do not affect the main contract's project totals, donor stats, or global CO₂ counters. This issue implements cross-contract settlement where a verified attestation triggers a donation recording in the main contract.

### Background

The `attestation-contract` provides:
- `record_attestation` — relayer records a cross-chain donation.
- `verify_attestation` — anyone verifies it.
- `Attestation` struct with `donor: Address`, `project_id: String`, `amount_usd: i128`, `amount_xlm: i128`.

The `indigopay-contract` provides full donation tracking but only for Stellar-native donations.

### Problem Statement

Cross-chain donations recorded in the attestation contract do not contribute to the main contract's project fundraising totals, donor leaderboard, or global impact metrics. This creates a fragmented view where Stellar-native and cross-chain donations are reported separately.

### Objectives

1. Add a settlement function `settle_attestation(env, attestation_contract: Address, attestation_id: u64)` on `indigopay-contract`.
2. The function calls `attestation_contract.get_attestation(attestation_id)` to read the attestation.
3. Only `Verified` attestations can be settled. Panics on `Pending` or `Revoked`.
4. Settlement records the donation on the main contract: updates project `total_raised`, donor stats, global counters, using the `amount_xlm` for CO₂ calculation.
5. Mark the attestation as settled: store `DataKey::SettledAttestation(u64)` to prevent double-settlement.
6. If the project wallet in the attestation matches a registered project, route the donation to that project. If no matching project, panic.
7. Emit `att_settle` event.

### Scope

**In Scope:**
- Cross-contract call from indigopay to attestation contract.
- Settlement gate (only Verified attestations).
- Double-settlement prevention.
- Donation stats update on main contract.
- Project matching validation.

**Out of Scope:**
- Automatic settlement triggering (must be called explicitly).
- Batch settlement.
- Reverse lookup (attestation → donation record mapping).

### Acceptance Criteria

- [ ] `settle_attestation` reads attestation from attestation contract.
- [ ] Only Verified attestations are settled.
- [ ] Settlement updates all donation stats on main contract.
- [ ] Double-settlement is prevented.
- [ ] Attestation project must match a registered project.
- [ ] Cross-contract call follows CEI ordering.
- [ ] Events emitted on settlement.

### Testing Requirements

- **Unit tests**: `test_settle_verified_attestation`, `test_settle_pending_attestation_panics`, `test_settle_revoked_attestation_panics`, `test_settle_double_panics`, `test_settle_unmatched_project_panics`.
- **Integration tests**: Deploy both contracts, record attestation, verify it, settle it, verify main contract stats updated.
- **Cross-contract integration**: Full attestation → verification → settlement flow.

### CI Requirements

- Standard.

### Deliverables

1. `settle_attestation` function in `indigopay-contract/src/lib.rs`.
2. `DataKey::SettledAttestation(u64)`.
3. Cross-contract call pattern using `env.invoke_contract()` or contract client.
4. Tests (unit + integration).
5. Updated `EVENTS.md` and `docs/contract-integration.md`.

### Definition of Done

- All criteria met. Tests pass. WASM sizes under 64 KB. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — donation recording path, `DonationRecord`, project/donor stats.
- `contracts/attestation-contract/src/lib.rs` — `Attestation`, `verify_attestation`, `get_attestation`.
- `docs/contract-integration.md` — cross-contract call patterns.

---

## Issue #440 — Escrow Multi-Sig Admin with Configurable Release Periods

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: high`, `area: escrow-contract`

### Summary

Upgrade the `escrow-contract` from a single-admin model (`DataKey::Admin`) to a multi-signature admin model with M-of-N threshold signatures, matching the pattern already implemented in `indigopay-contract` (Phase B in SECURITY.md). Also add per-job configurable release periods instead of a single global constant.

### Background

The escrow contract currently has:
- `DataKey::Admin` — single `Address`.
- Single-admin checks in `dispute_job`, `dispute_milestone`, `resolve_milestone_dispute`.
- Global `RELEASE_AFTER_LEDGERS = 10` constant.

The `indigopay-contract` has a mature multi-sig admin system (`DataKey::AdminSet`, `DataKey::AdminThreshold`, `verify_m_of_n`, `require_admin_for_critical`/`require_admin_for_routine`). The escrow contract should adopt the same pattern.

### Problem Statement

A single compromised admin key in the escrow contract could freeze all funds by disputing every job. Multi-sig raises the security bar. Additionally, a fixed 10-ledger release period is too short for many real-world escrow scenarios — different jobs need different release periods.

### Objectives

1. Replace `DataKey::Admin` with `DataKey::AdminSet` (Vec<Address>) and `DataKey::AdminThreshold` (u32).
2. Implement `verify_m_of_n` on escrow contract (mirror indigopay pattern).
3. Update all admin-gated functions to use multi-sig verification.
4. Add `release_after: u32` parameter to `create_job` — each job can specify its own release period.
5. Keep `RELEASE_AFTER_LEDGERS` as the minimum (not default) — jobs cannot specify a release period shorter than this minimum.
6. Add `update_release_after(env, signers, job_id, new_release_after)` — M-of-N admin can extend the release period.
7. Add admin management functions: `add_admin`, `remove_admin`, `update_threshold`.

### Scope

**In Scope:**
- Multi-sig admin for all admin-gated functions.
- Per-job configurable release period.
- Minimum release period enforcement.
- Admin management functions.
- Backward compatibility for existing single-admin deployments (treat as 1-of-1).

**Out of Scope:**
- Different release periods per milestone within a job.
- Dynamic release period adjustment based on milestone completion.
- Admin timelock or two-step transfer.

### Acceptance Criteria

- [ ] Multi-sig admin verification works for all admin functions.
- [ ] Threshold enforcement: M-of-N required, deduplication prevents replay.
- [ ] Single-admin backward compatibility (initialize with `vec![admin]` and threshold=1).
- [ ] `create_job` accepts per-job `release_after` parameter.
- [ ] `release_after` minimum is enforced.
- [ ] `claim_milestone` respects per-job release period.

### Testing Requirements

- **Unit tests**: `test_multi_sig_admin_initialize`, `test_multi_sig_dispute`, `test_single_admin_threshold_panics`, `test_insufficient_signatures_panics`, `test_per_job_release_after`, `test_release_after_below_minimum_panics`, `test_update_release_after`, `test_admin_management`.
- **Integration tests**: Initialize with 3-of-5, dispute a job, release with per-job period.
- **Fuzz tests**: `prop_escrow_m_of_n_dedup`.

### CI Requirements

- Standard for escrow-contract.

### Deliverables

1. Multi-sig admin in `escrow-contract/src/lib.rs`.
2. Per-job `release_after` and management functions.
3. Admin management functions.
4. Tests.
5. Updated docs.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/escrow-contract/src/lib.rs` — current admin model, `RELEASE_AFTER_LEDGERS`.
- `contracts/indigopay-contract/src/lib.rs` — `verify_m_of_n`, `AdminSet`, `AdminThreshold` (model to follow).
- `contracts/indigopay-contract/SECURITY.md` — Phase B multi-sig documentation.

---

## Issue #441 — Escrow Partial Milestone Release with Proportional Fund Distribution

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: escrow-contract`

### Summary

Add partial milestone release functionality to the escrow contract. Currently, a milestone is either fully released or not released — the entire percentage amount transfers at once. Allow a client to release a partial percentage of a milestone (e.g., 50% of a 40% milestone = 20% of total funds), enabling more granular payment schedules.

### Background

The `release_milestone` function releases the full proportional amount of a milestone:
```rust
let proportion = milestone.percentage as i128;
let release_amount = (job.amount * proportion) / 100i128;
```

There is no partial release concept. The milestone transitions from `released: false` to `released: true` atomically.

### Problem Statement

Real-world freelancer payments often involve partial milestone completion (e.g., "design is 80% done"). Without partial releases, clients must either pay the full milestone amount for incomplete work or delay all payment. Partial releases provide granularity and reduce disputes.

### Objectives

1. Add `partial_release_percentage: u32` field to `Milestone` (0–100, where 100 = fully released).
2. Update `release_milestone` to accept `release_pct: u32` — the percentage of THIS milestone to release.
3. A milestone is fully released when `partial_release_percentage == 100`.
4. `compute_remaining_funds` must account for partial releases: only the unreleased portion counts as remaining.
5. `claim_milestone` must respect partial releases — only the remaining portion can be claimed.
6. Update job status calculation: a job is `Completed` only when ALL milestones are 100% released.
7. Add `release_milestone_partial` as an alias or overload of `release_milestone` with a percentage parameter.

### Scope

**In Scope:**
- Partial milestone release logic.
- Updated `Milestone` struct with `partial_release_percentage`.
- Updated `compute_remaining_funds`.
- Updated job status calculation.
- Claim and dispute compatibility with partially-released milestones.

**Out of Scope:**
- Releasing funds to multiple recipients from one milestone.
- Auto-release schedules based on time.
- Partial dispute of a milestone (dispute is still all-or-nothing for a milestone).

### Acceptance Criteria

- [ ] `release_milestone` with `release_pct=50` releases 50% of the milestone's proportional amount.
- [ ] Subsequent release of the remaining 50% completes the milestone.
- [ ] `release_pct=0` panics (must be > 0).
- [ ] `release_pct` that would exceed 100% total panics.
- [ ] `claim_milestone` claims only the unreleased portion.
- [ ] `compute_remaining_funds` correctly excludes partially released amounts.
- [ ] Job transitions to Completed only when all milestones at 100%.

### Testing Requirements

- **Unit tests**: `test_partial_release_50pct`, `test_partial_release_then_remaining`, `test_partial_release_exceeds_100_panics`, `test_partial_release_compute_remaining`, `test_claim_after_partial_release`, `test_job_completed_only_at_full_release`.
- **Integration tests**: Create job with 3 milestones, partially release each, verify proportional transfers.
- **Fuzz tests**: `prop_partial_release_sum_equals_full`.

### CI Requirements

- Standard for escrow-contract.

### Deliverables

1. Updated `Milestone` struct, `release_milestone`, `compute_remaining_funds`, job status logic.
2. Tests.
3. Updated event documentation.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/escrow-contract/src/lib.rs` — `Milestone`, `release_milestone`, `claim_milestone`, `compute_remaining_funds`.

---

## Issue #442 — Escrow Multi-Token Support with On-Chain Token Registry

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: escrow-contract`

### Summary

Enhance the escrow contract to maintain an on-chain token registry of supported tokens, with admin management. Currently, any token address can be passed to `create_job` — the contract blindly trusts the caller. Add a token allow-list so the admin can control which tokens are accepted for escrow jobs, preventing malicious tokens from being used to exploit the contract.

### Background

The escrow contract's `create_job` accepts `token: Address` without validation. The CEI ordering mitigates reentrancy concerns, but a malicious token contract could still have unexpected behavior (fees on transfer, rebasing, callbacks). An allow-list provides defense-in-depth.

The multi-token tests in `multi_token.rs` already test XLM and USDC flows, demonstrating the need for multiple token support.

### Problem Statement

Without a token allow-list, anyone can create an escrow job with a non-standard or malicious token. While CEI ordering protects against reentrancy, other token behaviors (fee-on-transfer, rebasing) can cause accounting mismatches between the job's `amount` and the actual contract balance.

### Objectives

1. Add `DataKey::AllowedToken(Address)` — boolean flag per token.
2. Add `DataKey::TokenList` — `Vec<Address>` of allowed tokens.
3. Add `add_allowed_token(env, admin, token)` — single admin adds a token.
4. Add `remove_allowed_token(env, admin, token)` — single admin removes (doesn't affect existing jobs).
5. Gate `create_job` to only allow tokens in the allow-list. If allow-list is empty (initial state), allow all tokens (backward compatible).
6. Add `DataKey::TokenListInit` flag to distinguish "empty = allow all" from "empty = deny all".
7. Add `get_allowed_tokens() -> Vec<Address>` query.

### Scope

**In Scope:**
- Token allow-list management.
- Allow-list gating on `create_job`.
- Backward-compatible "allow all" when list is empty.
- Query function.

**Out of Scope:**
- Per-token fee configuration.
- Token-specific release periods.
- Automatic token validation against external registry.

### Acceptance Criteria

- [ ] Empty allow-list allows all tokens (backward compatible).
- [ ] Non-empty allow-list restricts to listed tokens.
- [ ] `create_job` with unlisted token panics when allow-list is populated.
- [ ] Admin can add/remove tokens.
- [ ] Token removal doesn't affect existing jobs.
- [ ] Events emitted on token list changes.

### Testing Requirements

- **Unit tests**: `test_allow_all_when_empty`, `test_block_unlisted_token`, `test_add_remove_token`, `test_existing_jobs_unaffected_by_removal`.
- **Integration tests**: Create allow-list, create jobs with allowed and blocked tokens.

### CI Requirements

- Standard.

### Deliverables

1. Token allow-list storage and management functions.
2. `create_job` gate.
3. Tests.
4. Updated events.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/escrow-contract/src/lib.rs` — `create_job`, token handling.
- `contracts/escrow-contract/tests/multi_token.rs` — multi-token test patterns.
- `contracts/attestation-contract/src/lib.rs` — allow-list pattern (`AllowedChain`).

---

## Issue #443 — Escrow Job Amendment Protocol: Milestone Reordering and Modification

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: escrow-contract`

### Summary

Add a job amendment protocol that allows the client (with freelancer co-signature) to modify a job's milestones after creation, as long as no milestones have been released. This enables scope changes without requiring a new escrow job and token transfer.

### Background

Once a job is created with `create_job`, its milestones are immutable. If the scope changes (e.g., a milestone is split into two, percentages are reallocated), the client must create a new job, transfer new funds, and potentially lose the original job's locked funds (until `refund_expired_job`).

### Problem Statement

Immutable milestones force rigid project planning. Real-world projects often require scope adjustments. An amendment protocol with dual authorization (client + freelancer) enables flexibility while protecting both parties.

### Objectives

1. Add `amend_job_milestones(env, client, freelancer, job_id, new_milestones: Vec<Milestone>)` — requires auth from both client AND freelancer.
2. Amendment only allowed if NO milestones have been released (`JobStatus == Escrowed`).
3. New milestones must sum to 100%.
4. The total `amount` cannot change (amendment reallocates percentages, not value).
5. Milestone count can change (add, remove, reorder).
6. Emit `job_amend` event with old and new milestone summaries.
7. Add `get_job_amendment_count(job_id) -> u32` to track amendment history.

### Scope

**In Scope:**
- Dual-authorization amendment.
- Milestone replacement with validation.
- Amendment gated to unreleased jobs.
- Event emission and amendment counter.

**Out of Scope:**
- Partial amendment of a subset of milestones.
- Amendment after partial release (requires new job).
- Amendment without freelancer consent.
- Amendment that changes the total amount.

### Acceptance Criteria

- [ ] Both client and freelancer must authorize.
- [ ] Amendment rejected if any milestone is released.
- [ ] New milestones must sum to 100%.
- [ ] Total `amount` unchanged after amendment.
- [ ] Amendment count incremented.
- [ ] `job_amend` event emitted.

### Testing Requirements

- **Unit tests**: `test_amend_unreleased_job`, `test_amend_released_job_panics`, `test_amend_wrong_sum_panics`, `test_amend_only_client_panics`, `test_amend_only_freelancer_panics`, `test_amend_count_increments`.
- **Integration tests**: Create job, amend milestones, release new milestones, verify.
- **Fuzz tests**: `prop_amend_preserves_amount`.

### CI Requirements

- Standard.

### Deliverables

1. `amend_job_milestones` function.
2. Amendment counter storage.
3. Dual-auth pattern.
4. Tests.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/escrow-contract/src/lib.rs` — `Job`, `Milestone`, `create_job`.

---

## Issue #444 — Escrow Freelancer Reputation On-Chain

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: escrow-contract`

### Summary

Add an on-chain reputation system for freelancers in the escrow contract. Track completed jobs, on-time delivery rate, dispute rate, and total value completed. This creates a trust-minimized reputation layer that clients can query before creating a job.

### Background

The escrow contract tracks jobs per `job_id` and `DataKey::JobIds` but has no freelancer-centric data. Freelancer identity is just an `Address` with no associated reputation data.

### Problem Statement

Clients selecting a freelancer for an escrow job have no on-chain data to evaluate trustworthiness. An on-chain reputation system provides immutable, verifiable freelancer history that cannot be fabricated by off-chain platforms.

### Objectives

1. Add `FreelancerReputation` struct: `{ total_jobs: u32, completed_jobs: u32, disputed_jobs: u32, total_value_completed: i128, on_time_completions: u32, created_at: u32 }`.
2. Add `DataKey::FreelancerReputation(Address)`.
3. Auto-update reputation on job completion (when `status` transitions to `Completed`).
4. Auto-update on dispute and dispute resolution.
5. Add `get_freelancer_reputation(freelancer) -> FreelancerReputation` query.
6. Reputation is append-only (no admin override) — immutable once written.
7. Jobs completed via `refund_expired_job` do NOT count as completed (freelancer did no work).

### Scope

**In Scope:**
- Freelancer reputation tracking.
- Auto-update on job lifecycle transitions.
- Read-only query.
- Immutable reputation data.

**Out of Scope:**
- Client reputation.
- Weighted or time-decayed reputation.
- Reputation-based job filtering (off-chain concern).
- Slashing or collateral based on reputation.

### Acceptance Criteria

- [ ] Reputation auto-updates when job completes.
- [ ] Disputed jobs counted separately.
- [ ] On-time completions tracked (job completed before deadline).
- [ ] Refunded jobs do not count as completed.
- [ ] Reputation is queryable by freelancer address.
- [ ] Reputation data is immutable (no admin override).

### Testing Requirements

- **Unit tests**: `test_reputation_on_completion`, `test_reputation_on_dispute`, `test_reputation_on_refund`, `test_reputation_query`.
- **Integration tests**: Full lifecycle with reputation checks at each step.
- **Fuzz tests**: `prop_reputation_counts_consistent`.

### CI Requirements

- Standard.

### Deliverables

1. `FreelancerReputation` type and storage.
2. Auto-update hooks in job lifecycle functions.
3. Query function.
4. Tests.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/escrow-contract/src/lib.rs` — `Job`, `JobStatus`, `create_job`, `release_milestone`, `claim_milestone`.

---

## Issue #445 — Oracle Median Price Mode and Multi-Asset Support

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: oracle-contract`

### Summary

Enhance the `oracle-contract` to support a configurable median price mode (in addition to TWAP) and multi-asset price feeds. Currently, the oracle only tracks one asset (XLM/USDC) using TWAP. Add median price calculation mode and expand to track multiple asset pairs simultaneously.

### Background

The oracle contract's `get_price` computes TWAP from the last 10 observations. The `PriceObservation` struct includes `price: i128` and `ledger: u32`. The contract stores observations in a circular buffer but has no asset discriminator — there's one buffer for one price feed.

### Problem Statement

TWAP is resistant to flash loan manipulation but slow to react to genuine price movements. A median price mode provides faster price discovery while still being manipulation-resistant (an attacker would need to control > 50% of reporters). Additionally, as the platform adds more tokens (#421), the oracle needs to track multiple asset pairs.

### Objectives

1. Add `OracleMode` enum: `Twap`, `Median`.
2. Add `set_mode(env, admin, mode: OracleMode)` — admin switches between TWAP and median.
3. Implement median price calculation: sort recent observations, return the middle value.
4. Add asset pair discriminator: `DataKey::Observations(u32, Symbol)` — `(index, asset_pair)` where `asset_pair` is e.g., `"XLM/USDC"`.
5. Add `report_price(env, reporter, price, asset_pair: Symbol)` — updated to include asset pair.
6. Add `get_price(env, asset_pair: Symbol) -> i128` — get price for a specific pair.
7. Backward compatibility: existing single-asset `get_price()` without argument defaults to `"XLM/USDC"`.
8. Reporter authorization is global — a reporter can report for any asset pair.

### Scope

**In Scope:**
- Median price calculation mode.
- Multi-asset pair support.
- Asset pair discriminator.
- Backward-compatible API.
- Mode switching by admin.

**Out of Scope:**
- Per-asset-pair reporter sets.
- Per-asset-pair mode configuration.
- Weighted median (use simple median).
- Outlier rejection in median mode.

### Acceptance Criteria

- [ ] Median mode returns the middle value of recent observations.
- [ ] TWAP mode continues to work as before.
- [ ] Multiple asset pairs can be tracked simultaneously.
- [ ] Each pair has independent observation buffers.
- [ ] Backward compatibility for single-asset callers.
- [ ] Admin can switch between modes.

### Testing Requirements

- **Unit tests**: `test_median_mode`, `test_median_with_even_observations`, `test_median_flash_loan_resistance`, `test_multi_asset_tracking`, `test_asset_pair_isolation`, `test_mode_switch`, `test_backward_compat`.
- **Integration tests**: Two asset pairs, 5 reporters, verify independent price feeds.
- **Fuzz tests**: `prop_median_within_range`.

### CI Requirements

- Standard for oracle-contract.

### Deliverables

1. Median calculation logic.
2. Multi-asset pair storage.
3. Updated `report_price`, `get_price`.
4. Tests.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/oracle-contract/src/lib.rs` — `PriceObservation`, `report_price`, `get_price` (TWAP), `DataKey`, `MAX_OBSERVATIONS`.

---

## Issue #446 — Oracle Reporter Stake and Slashing Mechanism

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: high`, `area: oracle-contract`

### Summary

Implement a reporter staking and slashing mechanism for the oracle contract. Reporters must stake tokens to be authorized, and if they report prices that deviate significantly from the eventual consensus (TWAP or median), their stake is slashed. This cryptoeconomic security mechanism aligns reporter incentives with accurate price reporting.

### Background

The oracle currently has a simple allow-list for reporters (`DataKey::Reporter(Address)`). Reporters are trusted — there's no economic penalty for inaccurate reporting. An attacker who compromises a reporter key can submit extreme prices that distort TWAP (mitigated by time-weighting, but still impactful for median mode).

### Problem Statement

Without economic incentives, reporter accuracy relies entirely on trust. A stake-and-slash mechanism ensures reporters have "skin in the game" — they lose money if they submit prices that deviate significantly from consensus, making manipulation economically irrational.

### Objectives

1. Add `stake_token: Address` configuration — the token used for staking.
2. Add `min_stake: i128` — minimum stake required to be a reporter.
3. Add `DataKey::ReporterStake(Address)` — tracks each reporter's staked amount.
4. Add `stake(env, reporter, amount)` — reporter stakes tokens (transferred to contract).
5. Add `unstake(env, reporter)` — reporter withdraws stake after a cooldown period.
6. Add `slash(env, admin, reporter, amount, reason)` — admin slashes a reporter's stake for bad behavior. Slashed tokens go to a treasury or are burned.
7. Add `report_price` check: reporter must have `ReporterStake >= min_stake` to report.
8. Add `DataKey::SlashHistory(Address)` — records slash events for transparency.
9. Emit events: `stake_dep`, `stake_wdr`, `stake_slash`.

### Scope

**In Scope:**
- Staking mechanism with token transfer.
- Slashing by admin.
- Minimum stake gating.
- Cooldown for unstaking.
- Event emissions.

**Out of Scope:**
- Automated slashing based on price deviation (requires on-chain consensus computation).
- Slashing insurance or bonds.
- Delegated staking.
- Staking rewards (separate concern).

### Acceptance Criteria

- [ ] Reporter must stake ≥ min_stake to report prices.
- [ ] Admin can slash a reporter's stake.
- [ ] Slashed tokens are transferred to a treasury address.
- [ ] Reporter can unstake after cooldown.
- [ ] Unstaking reduces ReporterStake below min_stake → reporter can't report.
- [ ] Events for all stake operations.
- [ ] CEI ordering for all token transfers.

### Testing Requirements

- **Unit tests**: `test_stake`, `test_report_without_stake_panics`, `test_slash_reduces_stake`, `test_unstake_after_cooldown`, `test_unstake_before_cooldown_panics`, `test_slash_event`.
- **Integration tests**: Stake, report, get slashed, verify can't report.
- **Fuzz tests**: `prop_stake_never_negative`.

### CI Requirements

- Standard.

### Deliverables

1. Staking and slashing functions.
2. Stake-gated reporting.
3. Cooldown mechanism.
4. Tests.
5. Updated `SECURITY.md` with oracle cryptoeconomic model.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/oracle-contract/src/lib.rs` — `report_price`, reporter auth, token client patterns.

---

## Issue #447 — Oracle Price Aggregation from Multiple External Sources

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: oracle-contract`

### Summary

Add an oracle aggregation mechanism that combines price data from multiple external oracle contracts. Currently, the oracle contract is a standalone price feed. This issue enables it to query other oracle contracts on Stellar and aggregate their prices (e.g., median of medians), providing a more robust price feed that is resilient to individual oracle failure.

### Background

The `indigopay-contract` has an `OracleInterface` trait:
```rust
pub trait OracleInterface {
    fn get_price(env: Env) -> i128;
}
```

Any contract implementing `get_price` can serve as an oracle. The oracle-contract itself could aggregate multiple such oracles.

### Problem Statement

A single oracle is a single point of failure for price data. If the oracle-contract's reporters are compromised or go offline, the entire platform's price feed is affected. Aggregating from multiple independent oracle sources provides redundancy and makes manipulation exponentially harder.

### Objectives

1. Add `DataKey::SourceOracle(Address)` — tracks registered external oracle contracts.
2. Add `DataKey::SourceOracleList` — `Vec<Address>` of source oracles.
3. Add `add_source_oracle(env, admin, oracle_address)` — admin registers an external oracle.
4. Add `remove_source_oracle(env, admin, oracle_address)`.
5. Add `get_aggregated_price(env) -> i128` — queries all source oracles, collects their prices, returns the median.
6. Fallback: if no source oracles are registered, fall back to the contract's own internal price (TWAP or median).
7. Staleness: skip source oracles whose response indicates stale data (if they support staleness checks).
8. Minimum sources: require at least 1 source oracle to use aggregation, or configurable `min_sources`.
9. Gas limit: cap the number of source oracles to a reasonable limit (e.g., 7) to bound `get_aggregated_price` gas cost.

### Scope

**In Scope:**
- External oracle registration.
- Cross-contract price queries.
- Median aggregation.
- Fallback to internal oracle.
- Source count limits.

**Out of Scope:**
- Weighted aggregation.
- Per-source trust scores.
- Cross-contract circuit breaker on source failure.
- Asynchronous aggregation.

### Acceptance Criteria

- [ ] `get_aggregated_price` returns median of all source oracles' prices.
- [ ] Falls back to internal price when no sources registered.
- [ ] Source oracle limit enforced.
- [ ] Unresponsive source excluded from median (skip, don't panic).
- [ ] Admin can add/remove source oracles.
- [ ] Cross-contract calls use `env.invoke_contract()`.

### Testing Requirements

- **Unit tests**: `test_aggregate_single_source`, `test_aggregate_multiple_sources_median`, `test_aggregate_fallback`, `test_source_limit_enforced`, `test_add_remove_source`.
- **Integration tests**: Deploy 3 oracle contracts, register them as sources, verify aggregated price.

### CI Requirements

- Standard.

### Deliverables

1. Source oracle management and aggregation logic.
2. Cross-contract price query via `OracleInterface`.
3. Tests.
4. Updated docs.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/oracle-contract/src/lib.rs` — current oracle implementation.
- `contracts/indigopay-contract/src/lib.rs` — `OracleInterface` trait.

---

## Issue #448 — Oracle TWAP Window and Staleness Configurability

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: low`, `area: oracle-contract`

### Summary

Make the TWAP window size and staleness threshold configurable by the oracle admin instead of being hard-coded constants. Currently, `TWAP_WINDOW = 10` and `STALENESS_THRESHOLD = 720` are constants in the contract. Allow the admin to adjust these based on market conditions and network latency.

### Background

The oracle contract uses:
```rust
const MAX_OBSERVATIONS: u32 = 20;
const TWAP_WINDOW: u32 = 10;
const STALENESS_THRESHOLD: u32 = 720;
```

These are compile-time constants. Different assets may benefit from different TWAP windows (e.g., volatile assets need shorter windows, stable assets can use longer windows for greater manipulation resistance).

### Problem Statement

Hard-coded TWAP parameters cannot adapt to changing market conditions or different asset characteristics. An admin-configurable window enables parameter tuning without contract upgrades.

### Objectives

1. Replace constants with storage values initialized to current defaults.
2. Add `set_twap_window(env, admin, window: u32)` — admin sets TWAP window. Bounds: `1 <= window <= MAX_OBSERVATIONS`.
3. Add `set_staleness_threshold(env, admin, threshold: u32)` — admin sets staleness threshold. Bounds: `TWAP_WINDOW <= threshold <= u32::MAX`.
4. Initialize with current constant values for backward compatibility.
5. Add getters: `get_twap_window() -> u32`, `get_staleness_threshold() -> u32`.
6. Emit events on parameter changes.

### Scope

**In Scope:**
- Configurable TWAP window and staleness threshold.
- Bounds enforcement.
- Default initialization.
- Getter functions.
- Events.

**Out of Scope:**
- Per-asset-pair configuration (uses global config).
- Dynamic auto-adjustment based on volatility.
- Maximum observations configurability.

### Acceptance Criteria

- [ ] TWAP window can be changed and takes effect immediately.
- [ ] Staleness threshold can be changed and takes effect immediately.
- [ ] Bounds enforced on both parameters.
- [ ] Default values match current constants.
- [ ] Only admin can change parameters.
- [ ] Events emitted on change.

### Testing Requirements

- **Unit tests**: `test_set_twap_window`, `test_set_staleness_threshold`, `test_twap_window_bounds`, `test_staleness_bounds`, `test_default_values`, `test_non_admin_set_panics`.

### CI Requirements

- Standard.

### Deliverables

1. Configurable parameters with bounds checking.
2. Admin setter functions.
3. Getter functions.
4. Tests.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/oracle-contract/src/lib.rs` — constants, `get_price`, admin auth pattern.

---

## Issue #449 — Attestation Batch Recording with Gas Optimization

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: attestation-contract`

### Summary

Add a batch attestation recording function to the attestation contract, allowing the relayer to record multiple cross-chain donations in a single contract invocation. Currently, each attestation requires a separate `record_attestation` call, which is gas-inefficient when processing batches of donations from the same source chain.

### Background

The `attestation-contract` has `record_attestation` which processes one attestation at a time. Each call:
1. Validates the relayer.
2. Checks pause status.
3. Validates lengths and amounts.
4. Checks replay protection.
5. Writes attestation record.
6. Updates counters.
7. Updates donor index.

For a batch of 100 Ethereum donations, this means 100 separate Soroban invocations.

### Problem Statement

Processing cross-chain donation batches one at a time is gas-inefficient and slow. A batch recording function amortizes validation costs across multiple attestations, improving throughput for relayers processing high-volume source chains.

### Objectives

1. Add `record_attestation_batch(env, relayer, attestations: Vec<BatchAttestationInput>) -> Vec<u64>` — records N attestations in one call.
2. `BatchAttestationInput` struct: `{ source_chain, source_tx_hash, donor, project_id, amount_usd, amount_xlm, message_hash }`.
3. Returns the assigned IDs for all attestations.
4. Shared validation (relayer auth, pause check, allow-list check for source chain) is done once per batch, not per attestation.
5. Per-attestation validation (replay guard, positive amounts) is done individually.
6. If any attestation in the batch fails validation, the entire batch reverts (atomic).
7. Gas limit: batch size capped at `MAX_BATCH_SIZE = 50`.
8. Events: emit one `att_batch` event with batch metadata, plus individual `att_new` events per attestation.

### Scope

**In Scope:**
- Batch recording with atomic semantics.
- Shared validation optimization.
- Batch size limit.
- Individual + batch events.

**Out of Scope:**
- Partial batch success (all-or-nothing).
- Cross-chain batch recording (multiple source chains in one batch).
- Parallel processing of attestations within batch.

### Acceptance Criteria

- [ ] `record_attestation_batch` records N attestations atomically.
- [ ] All IDs returned are sequential.
- [ ] Batch fails entirely if any attestation is invalid.
- [ ] Batch size limit enforced.
- [ ] Counters updated correctly (total + N, pending + N).
- [ ] Donor indexes updated for each attestation.
- [ ] Individual `att_new` events emitted for indexer compatibility.
- [ ] Batch event emitted with (count, first_id, last_id).

### Testing Requirements

- **Unit tests**: `test_batch_recording_success`, `test_batch_replay_panics`, `test_batch_size_limit`, `test_batch_invalid_amount_panics`, `test_batch_atomicity`, `test_batch_events`.
- **Integration tests**: Record batch of 50, verify all attestations individually queryable.
- **Fuzz tests**: `prop_batch_counter_consistency`.

### CI Requirements

- Standard for attestation-contract.

### Deliverables

1. `record_attestation_batch` function.
2. `BatchAttestationInput` type.
3. Batch size constant.
4. Tests.
5. Updated events.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/attestation-contract/src/lib.rs` — `record_attestation`, `Attestation`, event emission patterns.

---

## Issue #450 — Attestation Light Client Proof Verification for EVM Chains

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: high`, `area: attestation-contract`

### Summary

Replace the trusted relayer model in the attestation contract with on-chain light client proof verification for EVM-compatible source chains. Instead of trusting a single relayer address, the contract verifies a Merkle-Patricia proof that a transaction was included in a finalized EVM block, against a stored block hash that is updated by a decentralized validator set or bridge.

### Background

The current attestation contract trusts a single `relayer` address to record attestations. This is centralized — if the relayer key is compromised, fraudulent attestations can be recorded. The contract already has replay protection (`SourceTxSeen`) and an allow-list for source chains.

### Problem Statement

A single trusted relayer is a security bottleneck. Light client proof verification enables trustless cross-chain attestations where the contract independently verifies that a source-chain transaction occurred, without trusting any single entity.

### Objectives

1. Add `LightClientProof` type: `{ block_header: Bytes, receipt_proof: Bytes, tx_index: u32, chain_id: u32 }`.
2. Add `set_light_client_validators(env, admin, validators: Vec<Address>, threshold: u32)` — M-of-N admin sets validator set for a chain.
3. Add `submit_block_hash(env, validator, chain_id, block_number, block_hash: BytesN<32>)` — validators submit finalized block hashes.
4. Add `record_attestation_with_proof(env, relayer, source_chain, proof: LightClientProof, donor, project_id, amount_usd, amount_xlm, message_hash)` — verifies the proof, records the attestation.
5. Proof verification: verify that `receipt_proof` proves `source_tx_hash` was included in `block_header`, and that `block_header` matches a stored `block_hash` submitted by validators.
6. Fallback: if no validators are configured for a chain, fall back to relayer-trusted mode (backward compatible).
7. Store validated block hashes: `DataKey::BlockHash(u32, u64)` — `(chain_id, block_number)`.

### Scope

**In Scope:**
- Light client proof types and verification.
- Validator set management.
- Block hash submission by validators.
- Dual-mode operation (proof or relayer-trusted).
- EVM receipt proof verification (RLP decoding + Merkle-Patricia trie proof).

**Out of Scope:**
- Full light client (no consensus verification, assumes validator honesty).
- Non-EVM chain light clients.
- Block hash finality detection (validators determine finality).
- Automatic validator rotation.

### Acceptance Criteria

- [ ] Valid proof results in successful attestation recording.
- [ ] Invalid proof panics with clear error.
- [ ] Block hash not submitted → proof verification fails.
- [ ] Validator threshold enforcement for block hash submission.
- [ ] Relayer-trusted fallback when no validators configured.
- [ ] Proof verification is gas-feasible (WASM size aware).

### Testing Requirements

- **Unit tests**: `test_proof_verification_valid`, `test_proof_verification_invalid`, `test_proof_wrong_block_hash`, `test_validator_threshold`, `test_fallback_relayer_mode`.
- **Integration tests**: Submit block hash via validators, record attestation with proof, verify recorded.
- **Fuzz tests**: `prop_proof_verification_only_valid_succeeds`.

### CI Requirements

- Standard. WASM size under 64 KB with proof verification code.

### Deliverables

1. Light client proof verification logic.
2. Validator set management.
3. Block hash submission.
4. Updated `record_attestation` to support proof mode.
5. Tests.
6. Updated `SECURITY.md` with trust model.

### Definition of Done

- All criteria met. Tests pass. WASM under 64 KB. CI green.

### References

- `contracts/attestation-contract/src/lib.rs` — current relayer model, `record_attestation`.
- `contracts/indigopay-contract/src/lib.rs` — multi-sig pattern for validators.

---

## Issue #451 — Attestation Cross-Chain Finality Tracking

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: attestation-contract`

### Summary

Add cross-chain finality tracking to the attestation contract. Different source chains have different finality mechanisms (Ethereum: ~12 confirmations, Polygon: ~256 blocks, Arbitrum: ~10 minutes). Track the perceived finality status of each attestation and auto-transition from Pending to Verified after a configurable number of confirmations specific to each chain.

### Background

The attestation lifecycle is: `Pending → Verified / Revoked`. Verification is currently manual — someone must call `verify_attestation(id)`. This is a manual trust step even when the source transaction is objectively finalized.

### Problem Statement

Manual verification creates an operational burden and a time lag between source-chain finality and on-chain attestation verification. Auto-finality tracking based on chain-specific confirmation requirements automates this process and reduces trust assumptions.

### Objectives

1. Add `chain_confirmations_required: u32` per allowed chain (`DataKey::ChainConfirmations(String)`).
2. Add `set_chain_confirmations(env, admin, chain, confirmations)` — admin sets required confirmations.
3. Add `report_confirmation(env, relayer, attestation_id, current_confirmations: u32)` — relayer reports the number of confirmations observed on the source chain.
4. When `current_confirmations >= chain_confirmations_required`, auto-verify the attestation.
5. Add `DataKey::AttestationConfirmations(u64)` — tracks reported confirmations per attestation.
6. The relayer can report confirmations multiple times (idempotent — only the highest reported count matters).
7. Emit `att_conf` event when confirmations are reported.

### Scope

**In Scope:**
- Chain-specific confirmation requirements.
- Confirmation reporting by relayer.
- Auto-verification on reaching threshold.
- Idempotent confirmation reporting.

**Out of Scope:**
- Automated confirmation counting (requires source-chain RPC integration — off-chain concern).
- Different confirmation counting methods per chain (e.g., probabilistic vs deterministic).
- Reorg detection and confirmation rollback.

### Acceptance Criteria

- [ ] Confirmation requirements are configurable per chain.
- [ ] Relayer can report confirmations for an attestation.
- [ ] Auto-verification triggers when threshold met.
- [ ] Confirmations can be reported multiple times (highest count wins).
- [ ] Only Pending attestations can have confirmations reported.
- [ ] Events emitted for confirmation updates and auto-verification.

### Testing Requirements

- **Unit tests**: `test_set_chain_confirmations`, `test_report_confirmations`, `test_auto_verify_on_threshold`, `test_confirmations_on_verified_panics`, `test_highest_confirmation_count_used`.
- **Integration tests**: Set chain confirmations to 12, report 8 (no verify), report 15 (auto-verify), verify attestation is Verified.

### CI Requirements

- Standard.

### Deliverables

1. Chain confirmation configuration.
2. Confirmation reporting and auto-verification logic.
3. Tests.
4. Updated events.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/attestation-contract/src/lib.rs` — `verify_attestation`, `AttestationStatus`, `AllowedChain`.

---

## Issue #452 — Attestation Donor Aggregation and Leaderboard Query

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: low`, `area: attestation-contract`

### Summary

Add on-chain donor aggregation queries to the attestation contract. Currently, `get_by_donor` returns a list of attestations for a donor, but there is no aggregation (total bridged, count per chain, total USD value). Add aggregate query functions that enable the frontend to display cross-chain donation summaries without iterating all attestations off-chain.

### Background

The attestation contract has `get_by_donor(donor) -> Vec<Attestation>` which returns raw attestations. The frontend or backend must iterate and aggregate these to show "Total cross-chain donations: $500 across 3 chains."

### Problem Statement

Iterating all attestations off-chain for aggregation is inefficient for donors with many cross-chain donations. On-chain aggregation with counter-based tracking enables O(1) queries for summary statistics.

### Objectives

1. Add `DonorAggregate` struct: `{ total_attestations: u64, total_usd: i128, total_xlm: i128, chains: Vec<ChainCount> }`.
2. Add `ChainCount` struct: `{ chain: String, count: u64 }`.
3. Add `DataKey::DonorAggregate(Address)` — stores running totals.
4. Update donor aggregate on every `record_attestation` and `verify_attestation`.
5. Add `get_donor_aggregate(donor) -> DonorAggregate` query.
6. Add `get_chain_aggregate(chain) -> ChainAggregate` query.
7. Aggregate counts should distinguish between Pending, Verified, and Revoked attestations.

### Scope

**In Scope:**
- Per-donor and per-chain aggregates.
- Auto-update on attestation lifecycle.
- Query functions for aggregates.
- Distinction by status.

**Out of Scope:**
- Time-windowed aggregates.
- Project-specific aggregates.
- Leaderboard ranking (off-chain concern).

### Acceptance Criteria

- [ ] `get_donor_aggregate` returns correct totals and chain breakdown.
- [ ] Aggregates update on record, verify, and revoke.
- [ ] Pending vs Verified counts are tracked separately.
- [ ] `get_chain_aggregate` returns total attestations per chain.

### Testing Requirements

- **Unit tests**: `test_donor_aggregate_on_record`, `test_donor_aggregate_on_verify`, `test_chain_aggregate`, `test_aggregate_with_revoked`.

### CI Requirements

- Standard.

### Deliverables

1. Aggregate types, DataKeys, and update logic.
2. Query functions.
3. Tests.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/attestation-contract/src/lib.rs` — `get_by_donor`, `Attestation`, `DataKey::DonorAttestations`.

---

## Issue #453 — Contract Upgrade Dry-Run Simulation in Test Environment

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

Add an on-chain upgrade dry-run capability that simulates a proposed upgrade against the current contract state without actually executing it. The dry-run executes `migrate()` against a copy of the current storage, validates that all storage keys remain accessible, and reports any issues. This provides a pre-upgrade safety check that can be called by anyone during the 48-hour timelock window.

### Background

The upgrade system has a 48-hour timelock (`propose_upgrade` → wait → `execute_upgrade`). During the timelock, there is no on-chain mechanism to validate that the proposed WASM will work correctly with the current storage state. The `UPGRADE.md` recommends running a dry-run "to a testnet address with the same storage" manually.

### Problem Statement

Manual dry-run testing is error-prone and requires replicating mainnet state on testnet, which is operationally complex. An on-chain simulation (read-only, no state changes) allows anyone to validate a pending upgrade during the timelock window, increasing confidence and reducing upgrade risk.

### Objectives

1. Add `simulate_upgrade(env) -> SimulationResult` — read-only function that simulates applying the pending upgrade.
2. `SimulationResult` struct: `{ success: bool, storage_keys_before: u32, storage_keys_after: u32, errors: Vec<String> }`.
3. The simulation: creates a temporary snapshot of instance storage, applies `migrate()`, verifies all expected storage keys are accessible, rolls back (no persistent changes).
4. The function panics if no pending upgrade exists.
5. Since Soroban doesn't natively support storage snapshots, the simulation validates storage key compatibility by reading all keys with the current code and verifying the proposed migration path would not break them.
6. Practical approach: validate that `CURRENT_STORAGE_VERSION` in the proposed WASM is ≥ the current version, and that any added migration steps transform (not destroy) existing keys.

### Scope

**In Scope:**
- Storage compatibility validation.
- Migration path validation.
- Read-only simulation with result reporting.
- Accessible by anyone during timelock.

**Out of Scope:**
- Full storage snapshot and rollback (not supported by Soroban host).
- Gas cost estimation for migration.
- Automated rollback on simulation failure.

### Acceptance Criteria

- [ ] `simulate_upgrade` returns a detailed result.
- [ ] Reports storage key count before and after simulated migration.
- [ ] Identifies keys that would become inaccessible.
- [ ] Panics if no pending upgrade exists.
- [ ] Callable by anyone (no auth required).

### Testing Requirements

- **Unit tests**: `test_simulate_upgrade_valid`, `test_simulate_upgrade_no_pending_panics`, `test_simulate_upgrade_incompatible_keys`.
- **Integration tests**: Propose upgrade, simulate, verify result.

### CI Requirements

- Standard.

### Deliverables

1. `simulate_upgrade` function and `SimulationResult` type.
2. Storage validation logic.
3. Tests.
4. Updated `UPGRADE.md` with dry-run instructions.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `propose_upgrade`, `execute_upgrade`, `migrate`, `STORAGE_VERSION_KEY`.
- `contracts/indigopay-contract/UPGRADE.md` — upgrade process and regression testing.
- `contracts/indigopay-contract/SECURITY.md` — 48-hour timelock model.

---

## Issue #454 — Multi-Contract Coordinated Upgrade with Atomic Pause

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`, `area: escrow-contract`, `area: attestation-contract`

### Summary

Implement a coordinated upgrade mechanism across all IndigoPay contracts (indigopay, escrow, attestation). When any contract needs an upgrade, all contracts should be atomically paused before any upgrade executes, ensuring state consistency across the contract family. After all upgrades complete, all contracts are atomically unpaused.

### Background

Each contract has independent upgrade timelocks:
- `indigopay-contract`: `propose_upgrade` / `execute_upgrade` with 48h timelock.
- `attestation-contract`: same pattern, independent.
- `escrow-contract`: no upgrade mechanism currently (only `initialize` once).

There is no coordination between contracts. If `indigopay-contract` upgrades to a new donation schema but `attestation-contract` still uses the old settlement interface, cross-contract calls may break.

### Problem Statement

Independent contract upgrades risk cross-contract incompatibility during the upgrade window. A coordinated pause-and-upgrade protocol ensures all contracts upgrade atomically from the perspective of external callers.

### Objectives

1. Add `DataKey::CoordinatedUpgrade` to all three contracts — a shared coordination flag.
2. Add `propose_coordinated_upgrade(env, signers, new_wasm_hashes: Vec<(Address, BytesN<32>)>)` on indigopay-contract — proposes upgrades for multiple contracts and pauses all of them.
3. During a coordinated upgrade, all contracts reject state-mutating calls with "Coordinated upgrade in progress".
4. After all upgrades execute, call `complete_coordinated_upgrade(env)` to unpause all contracts.
5. Any admin can cancel a coordinated upgrade via `cancel_coordinated_upgrade(env, signers)`.
6. Read-only calls continue to work during coordinated upgrades.

### Scope

**In Scope:**
- Coordinated pause across all contracts.
- Batch upgrade proposal.
- Coordinated unpause after all upgrades complete.
- Cancel mechanism.
- Cross-contract pause status queries.

**Out of Scope:**
- Automatic detection of upgrade completion.
- Rollback of partial upgrades (if one contract upgrade fails).
- Cross-contract migration coordination.

### Acceptance Criteria

- [ ] Coordinated pause prevents writes on all contracts.
- [ ] Reads continue to work during pause.
- [ ] All upgrades must complete before unpause.
- [ ] Cancel path restores all contracts.
- [ ] Events emitted for pause/unpause across all contracts.

### Testing Requirements

- **Unit tests**: `test_coordinated_pause_blocks_writes`, `test_coordinated_pause_allows_reads`, `test_complete_upgrade_unpauses`, `test_cancel_restores`.
- **Integration tests**: Deploy all three contracts, propose coordinated upgrades, verify all paused, execute each upgrade, complete, verify all unpaused.

### CI Requirements

- All contract test suites pass.

### Deliverables

1. Coordinated upgrade logic in all three contracts.
2. Cross-contract pause flag.
3. Tests across all contracts.

### Definition of Done

- All criteria met. All tests pass. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `pause_contract`, `propose_upgrade`, `execute_upgrade`.
- `contracts/attestation-contract/src/lib.rs` — `pause`, `propose_upgrade`, `execute_upgrade`.
- `contracts/escrow-contract/src/lib.rs` — single `initialize`, no upgrade mechanism.

---

## Issue #455 — On-Chain Donation Receipt Generation with Cryptographic Commitment

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

Add on-chain donation receipt generation where each donation produces a cryptographically signed receipt that the donor can export and use for tax purposes. The receipt includes a commitment to the donation details (amount, project, timestamp, CO₂ offset) signed by the contract's implicit identity, verifiable off-chain without querying the full donation history.

### Background

The contract already stores `DonationRecord` with all relevant fields and emits `donated` events. However, there is no explicit receipt generation mechanism — donors must query their donation history via `get_donor_stats` or index events off-chain.

### Problem Statement

For tax purposes, donors need verifiable receipts that prove the amount, recipient, date, and impact of their donation. While on-chain data is inherently verifiable, producing a compact, signed receipt reduces the verification burden to checking a single signature rather than replaying the full event history.

### Objectives

1. Add `generate_receipt(env, donor, donation_index) -> DonationReceipt` — donor-only query that produces a receipt for a specific donation.
2. `DonationReceipt` struct: `{ donation_index: u32, donor: Address, project_id: String, amount: i128, co2_offset: i128, ledger: u32, currency: Symbol, contract_signature: Bytes }`.
3. The `contract_signature` is a hash of all receipt fields signed using `env.crypto().ed25519_sign()` (or an equivalent commitment using SHA-256): `env.crypto().sha256(&receipt_data)`.
4. Receipt verification off-chain: recompute SHA-256 of receipt fields and compare with stored signature.
5. Receipts are deterministic — calling `generate_receipt` twice for the same donation returns the same receipt.
6. Add `verify_receipt(env, receipt: DonationReceipt) -> bool` — anyone can verify a receipt against on-chain data.
7. Only the donor (or anyone, if receipt is public) can generate the receipt.

### Scope

**In Scope:**
- Receipt generation with cryptographic commitment.
- Receipt verification function.
- Deterministic receipt generation.
- Donor-gated access (or public access if anonymous=false).

**Out of Scope:**
- PDF generation (off-chain concern).
- Receipt revocation.
- Merkle-based receipt aggregation.
- Tax jurisdiction compliance logic.

### Acceptance Criteria

- [ ] `generate_receipt` returns a deterministic receipt with SHA-256 commitment.
- [ ] `verify_receipt` returns true for valid receipts.
- [ ] `verify_receipt` returns false for tampered receipts.
- [ ] Non-donor cannot generate receipt (donor auth required).
- [ ] Receipt includes all relevant donation fields.

### Testing Requirements

- **Unit tests**: `test_generate_receipt`, `test_receipt_deterministic`, `test_verify_valid_receipt`, `test_verify_tampered_receipt`, `test_non_donor_generate_panics`.
- **Integration tests**: Donate, generate receipt, verify off-chain, verify on-chain.
- **Fuzz tests**: `prop_receipt_commitment_unique`.

### CI Requirements

- Standard.

### Deliverables

1. `DonationReceipt` type, `generate_receipt`, `verify_receipt` functions.
2. Tests.
3. Updated `contract-integration.md` with receipt usage examples.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `DonationRecord`, `donate_with_privacy`, SHA-256 usage in Merkle proof verification.

---

## Issue #456 — Automated Fund Distribution for Campaign Goal Completion

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

Implement automated fund distribution when a time-bound campaign reaches its goal. Currently, when `apply_campaign_goal_progress` sets `CampaignStatus::GoalReached`, no automatic action is taken — funds have already been sent to the project wallet at donation time. For escrow-based campaigns (#426), reaching the goal should automatically trigger the first milestone release or unlock the escrow funds according to a pre-configured distribution schedule.

### Background

Campaign goal progression is handled by `apply_campaign_goal_progress` which transitions `Active → GoalReached` when `total_raised >= goal`. This function currently only sets the status and emits a `camp_goal` event.

### Problem Statement

For escrow-based campaigns, reaching the goal is the trigger to begin fund distribution. Without automated distribution, the admin must manually release milestones after the goal is reached, introducing delay and potential for human error or abuse.

### Objectives

1. Add `distribution_schedule` to campaign configuration: `Vec<DistributionStep>` where each step specifies `{ percentage: u32, delay_ledgers: u32 }`.
2. When campaign reaches goal, auto-queue the first distribution step.
3. Add `claim_distribution(env, project_wallet, project_id)` — project wallet claims the currently available distribution step after its delay has elapsed.
4. Distributions are tracked per campaign: `DataKey::CampaignDistribution(String)` — stores `{ steps: Vec<DistributionStep>, claimed: Vec<bool>, goal_reached_at: u32 }`.
5. Distribution steps sum to 100% (validated at campaign creation).
6. Only applicable for escrow-based campaigns — for direct-to-wallet campaigns, goal reached is informational only.
7. The distribution transfers funds from escrow contract to project wallet.

### Scope

**In Scope:**
- Distribution schedule configuration.
- Auto-queue on goal reached.
- Time-delayed claiming.
- Sum validation of distribution steps.
- Integration with escrow campaigns.

**Out of Scope:**
- Non-escrow campaign distributions.
- Variable distribution based on total raised vs goal.
- Donor voting on distribution timing.

### Acceptance Criteria

- [ ] Distribution steps sum to 100%.
- [ ] First step queued on goal reached.
- [ ] `claim_distribution` only succeeds after delay has elapsed.
- [ ] Each step can only be claimed once.
- [ ] Distribution events emitted per step.
- [ ] Campaign transitions to Closed after all steps claimed.

### Testing Requirements

- **Unit tests**: `test_distribution_schedule_validation`, `test_auto_queue_on_goal`, `test_claim_distribution`, `test_claim_before_delay_panics`, `test_claim_all_steps`, `test_double_claim_panics`.
- **Integration tests**: Create escrow campaign with distribution, donate to goal, claim steps with ledger advances.

### CI Requirements

- Standard.

### Deliverables

1. `DistributionStep` type, campaign distribution logic.
2. Integration with campaign goal detection.
3. Tests.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `apply_campaign_goal_progress`, `CampaignStatus`, `create_campaign`.

---

## Issue #457 — Time-Locked Donation Challenge/Response Protocol

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

Implement a challenge/response protocol for high-value donations. When a donation exceeds a configurable threshold, it enters a 24-hour challenge period during which community members (badge holders) can flag it for admin review. If no challenge is raised, the donation auto-finalizes. If challenged, the admin reviews and either approves or rejects (refunds) the donation.

### Background

The refund system (#290) allows donors to request refunds within 24 hours. However, there is no community oversight mechanism for suspicious donations (e.g., money laundering via large climate donations). The platform currently relies on off-chain monitoring.

### Problem Statement

High-value donations to climate projects could be used for money laundering (deposit illicit funds → get clean donation receipt → withdraw from project). A challenge period where badge holders can flag suspicious donations adds a community oversight layer without blocking legitimate donations.

### Objectives

1. Add `challenge_threshold: i128` — minimum donation amount that enters challenge period (configurable by M-of-N admin).
2. Add `DataKey::DonationChallenge(u32)` — stores challenge state for donation index.
3. `DonationChallenge` struct: `{ challenged: bool, challenger: Address, challenged_at: u32, resolved: bool, approved: bool }`.
4. When a donation exceeds the threshold, it enters `Challenged` state for `CHALLENGE_WINDOW_LEDGERS` (24 hours).
5. `challenge_donation(env, challenger, donation_index, reason)` — badge holders (≥ Seedling) can challenge a donation during the window.
6. After challenge, admin reviews and calls `resolve_challenge(env, admin, donation_index, approve)`.
7. If resolved with `approve=false`, the donation is refunded (similar to force-refund flow).
8. If no challenge within window, donation auto-finalizes (no action needed — already recorded).
9. During challenge period, the donation is recorded normally — challenge is a post-donation oversight mechanism.
10. Challenge threshold of 0 disables the challenge system (backward compatible).

### Scope

**In Scope:**
- Challenge threshold configuration.
- Challenge submission by badge holders.
- Admin resolution of challenges.
- Auto-finalization after window.
- Events for challenge lifecycle.

**Out of Scope:**
- Automated challenge triggers.
- Challenge bonds or staking.
- Anonymous challenge submissions.

### Acceptance Criteria

- [ ] Donations above threshold enter challenge period.
- [ ] Badge holders can challenge within window.
- [ ] Non-badge-holders cannot challenge.
- [ ] Admin can resolve challenges (approve/refund).
- [ ] Unchallenged donations auto-finalize.
- [ ] Threshold of 0 disables the system.
- [ ] Events for challenge, resolve, auto-finalize.

### Testing Requirements

- **Unit tests**: `test_challenge_donation`, `test_challenge_non_badge_holder_panics`, `test_challenge_below_threshold_not_triggered`, `test_resolve_challenge_approve`, `test_resolve_challenge_reject`, `test_auto_finalize`, `test_threshold_zero_disables`.
- **Integration tests**: Set threshold, donate above threshold, challenge, resolve, verify refund.
- **Fuzz tests**: `prop_challenge_only_badge_holders`.

### CI Requirements

- Standard.

### Deliverables

1. Challenge types, DataKeys, and functions.
2. Integration with donation flow.
3. Admin resolution functions.
4. Tests.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — refund system (#290), badge tiers, `BadgeTier`.

---

## Issue #458 — Donor Privacy Set Management with Stealth Addresses

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`, `area: donation-contract`

### Summary

Integrate the existing stealth address donation infrastructure (`DonationContract` in `donation/contract.rs`) with the main `indigopay-contract` to provide a unified privacy-preserving donation flow. Currently, stealth donations use a separate contract with independent state — they don't update the main contract's project totals, donor stats, or global CO₂ counters.

### Background

The `DonationContract` provides:
- `generate_stealth_address` — deterministic stealth address from project wallet + ephemeral key.
- `donate_stealth` — records a stealth donation with persistent storage.
- `scan_stealth_donations` — project wallet scans for donations using viewing key.

The main `IndigoPayContract` has no integration with stealth donations. Stealth donations are tracked entirely separately.

### Problem Statement

Stealth donations bypass the main contract's impact tracking, creating a fragmented donation record. A donor who makes stealth donations for privacy cannot see their contributions reflected in the global impact dashboard, and the project's total raised is underreported.

### Objectives

1. Add `donate_stealth_integrated(env, ...)` to `IndigoPayContract` — wraps `DonationContract.donate_stealth()` and also updates main contract stats.
2. Stealth donations to the main contract record the donation with `anonymous: true` and a zero-address donor (or a dedicated stealth pool address).
3. CO₂ offset is still calculated and attributed to the global totals (but not to any specific donor).
4. Project totals are updated.
5. Add `DataKey::StealthDonationContract` — stores the address of the deployed DonationContract for cross-contract calls.
6. Add `set_stealth_donation_contract(env, admin, contract_address)` — admin configures.
7. Stealth donations do NOT affect donor-specific stats (consistent with anonymous model).

### Scope

**In Scope:**
- Cross-contract integration between IndigoPay and DonationContract.
- Stealth donation recording with main contract stats updates.
- Project totals and global CO₂ updates.
- Admin configuration of stealth contract address.

**Out of Scope:**
- Merging DonationContract into IndigoPayContract (separate contracts maintained).
- Stealth donation badge tracking.
- Viewing key management (handled by DonationContract).

### Acceptance Criteria

- [ ] `donate_stealth_integrated` records donation in Both contracts.
- [ ] Project total_raised updated on main contract.
- [ ] Global CO₂ counters updated.
- [ ] Donor stats NOT updated (privacy preserved).
- [ ] Events emitted on main contract for indexers.
- [ ] Backward compatible — existing DonationContract usage unaffected.

### Testing Requirements

- **Unit tests**: `test_stealth_integrated_stats`, `test_stealth_integrated_donor_stats_not_updated`, `test_stealth_integrated_project_total`.
- **Integration tests**: Deploy both contracts, configure integration, make stealth donation, verify main contract stats.

### CI Requirements

- Standard.

### Deliverables

1. `donate_stealth_integrated` in `lib.rs`.
2. Cross-contract configuration.
3. Tests.
4. Updated `SECURITY.md` with privacy model.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/indigopay-contract/src/donation/contract.rs` — `DonationContract`, `donate_stealth`, `scan_stealth_donations`.
- `contracts/indigopay-contract/src/donation/types.rs` — `StealthDonation`.
- `contracts/indigopay-contract/src/lib.rs` — main donation path, anonymous donation model.

---

## Issue #459 — Project Impact Verification with Off-Chain Oracle Attestation

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

Add an impact verification system where designated off-chain verifiers (e.g., satellite monitoring services, independent auditors) can submit signed attestations of a project's actual CO₂ impact. The contract compares claimed impact (from `co2_per_xlm` × total_raised) with verified impact and adjusts the project's CO₂ rate or flags discrepancies.

### Background

The current CO₂ offset calculation is based on `co2_per_xlm` set at project registration. This is a self-reported rate that could be inflated. The backend has an automated verification pipeline (`docs/architecture.md` § Automated CO₂ Offset Rate Verification) that checks against scientific databases, but this is off-chain.

### Problem Statement

Self-reported CO₂ rates have no on-chain verification, enabling greenwashing. An on-chain verification attestation system where independent auditors submit signed impact reports creates accountability and allows donors to trust the impact numbers.

### Objectives

1. Add `DataKey::ImpactVerifier(Address)` — authorized verifier addresses (M-of-N admin managed).
2. Add `ImpactReport` struct: `{ project_id, verifier, report_id: String, verified_co2_per_xlm: u32, evidence_hash: BytesN<32>, reported_at: u32 }`.
3. Add `submit_impact_report(env, verifier, project_id, verified_co2_per_xlm, evidence_hash)` — verifier submits a signed report.
4. After N reports (configurable threshold), the project's `co2_per_xlm` is auto-adjusted to the median of verified values.
5. Add `DataKey::ImpactVerificationThreshold` and `DataKey::ImpactReports(String)`.
6. If verified rate deviates ≥ 50% from claimed rate, flag the project (`impact_flagged: bool`).
7. Add `get_impact_verification_status(project_id) -> ImpactVerificationStatus` query.
8. Events for report submission and rate adjustment.

### Scope

**In Scope:**
- Verifier set management.
- Impact report submission.
- Median-based rate adjustment.
- Deviation flagging.
- Query functions.

**Out of Scope:**
- Automated verifier selection or rotation.
- Reputation-weighted verifier scores.
- Real-time satellite data integration (off-chain).
- Historical impact report archive queries beyond the latest.

### Acceptance Criteria

- [ ] Verifiers can submit impact reports.
- [ ] Auto-adjustment triggers after threshold reports.
- [ ] Rate adjusted to median of verified values.
- [ ] Deviation ≥ 50% flags the project.
- [ ] Non-verifier cannot submit reports.
- [ ] Duplicate report from same verifier updates (not duplicates).
- [ ] Events for report and adjustment.

### Testing Requirements

- **Unit tests**: `test_submit_impact_report`, `test_auto_adjust_rate`, `test_deviation_flag`, `test_threshold_not_met_no_adjust`, `test_non_verifier_panics`.
- **Integration tests**: Register 3 verifiers, submit 2 reports (no adjust), submit 3rd (auto-adjust), verify co2_per_xlm updated.
- **Fuzz tests**: `prop_median_adjustment_within_verified_range`.

### CI Requirements

- Standard.

### Deliverables

1. Impact verifier management and report submission.
2. Auto-adjustment logic.
3. Deviation flagging.
4. Tests.
5. Updated `SECURITY.md` with impact verification model.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `Project.co2_per_xlm`, `update_project_co2_rate`, `MAX_CO2_PER_XLM`.
- `docs/architecture.md` — Automated CO₂ Offset Rate Verification pipeline.

---

## Issue #460 — Configurable Cooldown and Timelock Parameters via Governance

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: low`, `area: indigopay-contract`

### Summary

Move the hard-coded timelock and cooldown constants to governance-configurable storage values. Currently, all timelocks (48h upgrade, 7-day emergency withdrawal, 24h refund cooldown, voting windows) are compile-time constants. Allow the DAO (M-of-N admins) to adjust these parameters within bounded ranges.

### Background

Hard-coded constants:
```rust
const UPGRADE_TIMELOCK_LEDGERS: u32 = 34_560;       // 48h
const EMERGENCY_WITHDRAWAL_TIMELOCK: u32 = 120_960;  // 7 days
const REFUND_COOLDOWN_LEDGERS: u32 = 17_280;         // 24h
const VOTING_WINDOW_LEDGERS: u32 = 120_960;          // 7 days
const MIN_VOTING_WINDOW_LEDGERS: u32 = 720;
const MAX_VOTING_WINDOW_LEDGERS: u32 = 518_400;
```

These affect critical security properties of the contract.

### Problem Statement

Timelocks that are appropriate at launch may become inappropriate as network conditions change (e.g., ledger times changing from 5s to 3s). Governance-configurable parameters with hard bounds allow the community to adapt without contract upgrades while preventing abuse.

### Objectives

1. Replace each constant with a storage value initialized at the current constant.
2. Add `set_upgrade_timelock(env, signers, ledgers)` — M-of-N admin. Bounds: 17_280 (24h) ≤ ledgers ≤ 518_400 (30 days).
3. Add `set_emergency_withdrawal_timelock(env, signers, ledgers)` — M-of-N. Bounds: 34_560 (48h) ≤ ledgers ≤ 518_400 (30 days).
4. Add `set_refund_cooldown(env, signers, ledgers)` — M-of-N. Bounds: 720 (1h) ≤ ledgers ≤ 120_960 (7 days).
5. Add `set_default_voting_window(env, signers, ledgers)` — M-of-N. Bounds: within existing MIN/MAX.
6. Each setter emits a corresponding event.
7. Add getters for each parameter.
8. All existing logic reads from storage instead of constants.

### Scope

**In Scope:**
- Configurable timelocks and cooldowns.
- Bounded ranges for each parameter.
- M-of-N admin governance.
- Events and getters.

**Out of Scope:**
- Per-project parameter overrides.
- Dynamic adjustment based on network conditions.
- Timelock changes affecting already-pending operations (use new value for new proposals only).

### Acceptance Criteria

- [ ] Each parameter is independently configurable.
- [ ] Bounds enforced for all parameters.
- [ ] New values apply to future operations only (not retroactive).
- [ ] Default values match current constants.
- [ ] M-of-N required for all changes.
- [ ] Events emitted per parameter change.

### Testing Requirements

- **Unit tests**: Test each setter with valid/invalid values, verify getters, verify new operations use new values.
- **Integration tests**: Change upgrade timelock, propose upgrade, verify new timelock used.
- **Fuzz tests**: `prop_bounds_enforced_for_all_parameters`.

### CI Requirements

- Standard.

### Deliverables

1. Configurable parameter storage and setters.
2. Bounds enforcement.
3. Updated logic to read from storage.
4. Tests.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — all constants, upgrade lifecycle, emergency withdrawal, refund, voting.

---

## Issue #461 — Donation Anomaly Detection with On-Chain Circuit Breaker

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

Implement an on-chain circuit breaker that detects anomalous donation patterns (e.g., sudden spike in donation volume to a single project, donations just below the challenge threshold) and can automatically pause a project or trigger admin review. This provides automated defense against coordinated attacks or money laundering attempts.

### Background

The contract has rate limiting (`DonorRateLimit`) and project pausing (`pause_project`), but both require manual admin action. There is no automated detection of anomalous patterns.

### Problem Statement

Manual monitoring cannot react quickly enough to coordinated attacks (e.g., a Sybil attack using many wallets each donating just below rate limits). An on-chain circuit breaker with configurable anomaly rules provides automated defense.

### Objectives

1. Add `AnomalyRule` struct: `{ metric: AnomalyMetric, threshold: i128, window_ledgers: u32 }`.
2. `AnomalyMetric` enum: `DonationVolume` (total stroops in window), `DonationCount` (number of donations in window), `NewDonorRate` (percentage of first-time donors), `AverageDonationSize`.
3. Add `set_anomaly_rules(env, signers, project_id, rules: Vec<AnomalyRule>)` — M-of-N admin configures rules per project.
4. On each donation, check all anomaly rules for the project. If any rule is violated, auto-pause the project and emit `anomaly_detected` event.
5. Add `DataKey::AnomalyRules(String)` and `DataKey::AnomalyWindow(String)` (sliding window counters).
6. Admins can `clear_anomaly(env, admin, project_id)` to reset counters and resume project.
7. Circuit breaker trigger also emits a high-severity event that indexers can relay to monitoring systems.
8. Anomaly detection can be disabled per project (empty rules).

### Scope

**In Scope:**
- Configurable anomaly rules per project.
- Automatic pause on rule violation.
- Sliding window counters.
- Admin clearance.
- Events.

**Out of Scope:**
- ML-based anomaly detection (too complex for on-chain).
- Cross-project anomaly correlation.
- Automatic un-pausing after cooldown.

### Acceptance Criteria

- [ ] Rules can be configured per project.
- [ ] Auto-pause triggers when rule violated.
- [ ] `anomaly_detected` event emitted with rule details.
- [ ] Admin can clear anomaly and resume project.
- [ ] No rules = no anomaly detection (backward compatible).
- [ ] Counters reset after clearance.

### Testing Requirements

- **Unit tests**: `test_anomaly_rule_volume`, `test_anomaly_rule_count`, `test_anomaly_auto_pause`, `test_anomaly_clear`, `test_anomaly_disabled_no_rules`.
- **Integration tests**: Configure rules, simulate anomaly, verify auto-pause, clear, verify resume.
- **Fuzz tests**: `prop_anomaly_detection_no_false_positive_below_threshold`.

### CI Requirements

- Standard.

### Deliverables

1. Anomaly rule types and detection logic.
2. Auto-pause integration.
3. Tests.
4. Updated `SECURITY.md`.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `pause_project`, `RateLimitWindow` (sliding window pattern), donation flow.

---

## Issue #462 — Recurring Donation Pause/Resume with Auto Catch-Up

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

Add a pause/resume capability to recurring donations with an optional auto catch-up mechanism. Donors should be able to temporarily pause their recurring donation schedule (e.g., during financial hardship) and later resume it. On resume, the donor can optionally catch up on missed donations or simply continue from the current schedule.

### Background

The `RecurringDonation` struct has `active: bool` but no explicit pause function — the only way to stop is `cancel_recurring` (#422 doesn't address pause). The `rec_can` event is for cancellation, not pausing.

### Problem Statement

Donors who experience temporary financial constraints should not have to cancel and recreate their recurring donation. A pause mechanism preserves the schedule and allows resumption, with an optional catch-up for missed cycles.

### Objectives

1. Add `pause_recurring(env, donor, recurring_id)` — donor-only, sets `active = false` and records `paused_at: u32`.
2. Add `resume_recurring(env, donor, recurring_id, catch_up: bool)` — donor-only.
3. If `catch_up = true`, calculate missed cycles: `(current_ledger - paused_at) / interval_ledgers`. Execute the missed donations in a single batch transfer (donor → project wallet for the sum of missed amounts).
4. Update `next_execution_ledger` to the next future cycle.
5. Add `paused_at: u32` to `RecurringDonation` (appended field).
6. Emit `rec_pause` and `rec_resume` events.
7. Keeper incentive: missed catch-up donations do NOT pay keeper incentives (only regular executions do).

### Scope

**In Scope:**
- Pause and resume with state tracking.
- Optional catch-up on resume.
- Batch catch-up transfer.
- Events.
- Keeper incentive exclusion for catch-up.

**Out of Scope:**
- Auto-pause on insufficient balance (covered by #422).
- Partial catch-up (all or nothing).
- Pausing for a specific duration (indefinite pause only).

### Acceptance Criteria

- [ ] `pause_recurring` sets active=false and records paused_at.
- [ ] `resume_recurring` with catch_up=true transfers missed donations.
- [ ] `resume_recurring` with catch_up=false continues from next cycle.
- [ ] Paused schedules are not executable by keepers.
- [ ] Catch-up amount calculation is correct.
- [ ] Only the donor can pause/resume.
- [ ] Events emitted.

### Testing Requirements

- **Unit tests**: `test_pause_recurring`, `test_resume_with_catch_up`, `test_resume_without_catch_up`, `test_keep_cannot_execute_paused`, `test_non_donor_pause_panics`, `test_catch_up_amount_calculation`.
- **Integration tests**: Create recurring donation, let 2 cycles execute, pause for 3 cycles, resume with catch-up, verify project wallet received 5 donations total.
- **Fuzz tests**: `prop_catch_up_amount_exact`.

### CI Requirements

- Standard.

### Deliverables

1. `pause_recurring`, `resume_recurring` functions.
2. `paused_at` field, catch-up calculation.
3. Tests.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `RecurringDonation`, `donate_recurring`, `cancel_recurring`.

---

## Issue #463 — Escrow Dispute Arbitration with Multi-Round Evidence Submission

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: escrow-contract`

### Summary

Add a multi-round dispute arbitration protocol to the escrow contract. Currently, dispute resolution is a single-step process: admin disputes → admin resolves. Real disputes require evidence submission from both parties and possibly multiple rounds of negotiation before admin resolution. Add an evidence submission phase with configurable rounds.

### Background

The current dispute flow:
1. `dispute_milestone(admin, job_id, milestone_index)` — admin disputes.
2. `resolve_milestone_dispute(admin, job_id, milestone_index, approve)` — admin resolves.

There is no mechanism for client or freelancer to submit evidence or respond to the dispute.

### Problem Statement

Single-step admin resolution gives no voice to the disputing parties and provides no on-chain record of the evidence considered. A multi-round protocol with evidence submission creates a fairer process and an auditable dispute history.

### Objectives

1. Add `Dispute` struct: `{ milestone_index: u32, initiator: Address, initiated_at: u32, rounds: Vec<DisputeRound>, status: DisputeStatus }`.
2. `DisputeRound` struct: `{ submitter: Address, evidence_hash: BytesN<32>, submitted_at: u32 }`.
3. `DisputeStatus` enum: `Open`, `AwaitingResponse`, `UnderReview`, `Resolved`.
4. Add `initiate_dispute(env, initiator, job_id, milestone_index, evidence_hash)` — client or freelancer initiates with evidence.
5. Add `respond_to_dispute(env, responder, job_id, milestone_index, evidence_hash)` — the other party responds.
6. Admin resolves after both parties have submitted (or after timeout).
7. Max rounds: `MAX_DISPUTE_ROUNDS = 3` (initiation + response + optional surrebuttal).
8. Add `DataKey::Dispute(String, u32)` — `(job_id, milestone_index)`.
9. Add `timeout_dispute(env, job_id, milestone_index)` — anyone can close dispute if responder doesn't respond within `DISPUTE_RESPONSE_WINDOW`.
10. Events for each dispute action.

### Scope

**In Scope:**
- Multi-round evidence submission.
- Configurable rounds and timeouts.
- Auto-timeout for unresponsive parties.
- Admin resolution after rounds complete.
- Dispute history query.

**Out of Scope:**
- Decentralized arbitration (jury of peers).
- Evidence content validation (only hashes stored).
- Appeal process.

### Acceptance Criteria

- [ ] Client or freelancer can initiate dispute with evidence.
- [ ] Other party can respond with evidence.
- [ ] Admin resolves after both parties submit.
- [ ] Timeout mechanism for unresponsive parties.
- [ ] Max rounds enforced.
- [ ] Dispute history queryable.
- [ ] Events for each round.

### Testing Requirements

- **Unit tests**: `test_initiate_dispute`, `test_respond_to_dispute`, `test_resolve_after_rounds`, `test_timeout_dispute`, `test_max_rounds_enforced`, `test_dispute_history`.
- **Integration tests**: Full 3-round dispute flow with evidence hashes.
- **Fuzz tests**: `prop_dispute_rounds_bounded`.

### CI Requirements

- Standard for escrow-contract.

### Deliverables

1. `Dispute`, `DisputeRound`, `DisputeStatus` types.
2. Initiate, respond, resolve, timeout functions.
3. Tests.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/escrow-contract/src/lib.rs` — `dispute_milestone`, `resolve_milestone_dispute`, `Milestone`.

---

## Issue #464 — Oracle Price Deviation Circuit Breaker

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: oracle-contract`

### Summary

Add a price deviation circuit breaker to the oracle contract. If a new price observation deviates more than a configurable percentage from the current TWAP or median, the observation is rejected and a circuit breaker event is emitted. This prevents extreme price manipulation from a compromised reporter, even before the TWAP/median averaging mitigates it.

### Background

The TWAP mechanism mitigates flash loan manipulation by time-weighting, but a series of extreme reports from compromised reporters can still skew the price. Currently, any reporter can submit any positive price.

### Problem Statement

Without a deviation check, a compromised reporter (or set of reporters) can gradually shift the TWAP by submitting increasingly extreme prices. A circuit breaker that rejects observations beyond a deviation threshold caps the per-observation impact, complementing the TWAP's time-based resistance.

### Objectives

1. Add `max_price_deviation_bps: u32` — max allowed deviation from current price in basis points (e.g., 500 = 5%).
2. Add `set_max_price_deviation(env, admin, deviation_bps)` — admin configures.
3. In `report_price`, after validating the reporter, compute current price (TWAP or median). Check if new observation deviates by more than `max_price_deviation_bps`. If so, reject with "Price deviation exceeds limit" and emit `price_rejected` event.
4. The deviation check should be bypassable if `max_price_deviation_bps == 0` (backward compatible — no circuit breaker).
5. The deviation check is skipped if there are fewer than 2 observations (no baseline to compare).
6. Emit `price_rejected(reporter, submitted_price, current_price, deviation_bps)` event on rejection.

### Scope

**In Scope:**
- Configurable deviation threshold.
- Deviation check in `report_price`.
- Event on rejection.
- Backward compatible (disabled by default).

**Out of Scope:**
- Adaptive deviation thresholds.
- Per-asset deviation thresholds.
- Temporary reporter banning on repeated violations.

### Acceptance Criteria

- [ ] Observations exceeding deviation threshold are rejected.
- [ ] `price_rejected` event emitted.
- [ ] Threshold of 0 disables check.
- [ ] Fewer than 2 observations skips check.
- [ ] Admin can configure threshold.
- [ ] Deviation calculated correctly as `|new - current| / current` in bps.

### Testing Requirements

- **Unit tests**: `test_deviation_reject`, `test_deviation_accept_within_bounds`, `test_deviation_disabled_zero`, `test_deviation_skip_few_observations`, `test_set_deviation_threshold`.
- **Fuzz tests**: `prop_deviation_calculation_correct`.

### CI Requirements

- Standard.

### Deliverables

1. Deviation check in `report_price`.
2. `set_max_price_deviation` admin function.
3. `price_rejected` event.
4. Tests.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/oracle-contract/src/lib.rs` — `report_price`, `get_price` (TWAP), `MAX_OBSERVATIONS`.

---

## Issue #465 — Attestation Revocation with Donor Notification Grace Period

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: attestation-contract`

### Summary

Enhance the attestation revocation mechanism with a grace period and on-chain notification. Currently, `revoke_attestation` immediately sets status to `Revoked`. Add a `RevocationPending` intermediate state with a configurable grace period during which the original attester (donor or relayer) can challenge the revocation by submitting counter-evidence.

### Background

The current revocation flow:
```rust
pub fn revoke_attestation(env: Env, admin: Address, id: u64) {
    // ... validates admin ...
    record.status = AttestationStatus::Revoked;
    // ...
}
```

Revocation is immediate and irreversible.

### Problem Statement

Immediate revocation without a challenge period could be abused by a malicious admin to censor legitimate cross-chain donations. A grace period with challenge capability provides due process.

### Objectives

1. Add `AttestationStatus::RevocationPending` variant.
2. Add `DataKey::RevocationChallenge(u64)` — stores challenge state.
3. Change `revoke_attestation` to set status to `RevocationPending` instead of `Revoked`, with a deadline: `revocation_deadline = current_ledger + REVOCATION_GRACE_PERIOD` (7 days).
4. Add `challenge_revocation(env, challenger, attestation_id, evidence_hash)` — the original relayer or donor can challenge with evidence during the grace period.
5. After grace period, anyone can call `finalize_revocation(env, attestation_id)` to finalize the revocation.
6. If a challenge is submitted, admin reviews and calls `resolve_revocation_challenge(env, admin, attestation_id, uphold_revocation)`.
7. Events: `att_rev_pending`, `att_rev_challenged`, `att_rev_finalized`, `att_rev_overturned`.

### Scope

**In Scope:**
- Grace period between pending and finalized revocation.
- Challenge mechanism for affected parties.
- Admin resolution of challenges.
- Finalization by anyone after grace period.
- Events for all state transitions.

**Out of Scope:**
- Multi-round challenge process.
- Automated challenge triggers.
- Compensation for wrongfully revoked attestations.

### Acceptance Criteria

- [ ] Revocation enters `RevocationPending` with deadline.
- [ ] Challenge can be submitted during grace period.
- [ ] Admin resolves challenge (uphold or overturn).
- [ ] Unchallenged revocation finalizes after grace period.
- [ ] Challenged revocation requires admin resolution.
- [ ] Events for all transitions.
- [ ] Grace period configurable by admin.

### Testing Requirements

- **Unit tests**: `test_revocation_pending`, `test_challenge_revocation`, `test_finalize_after_grace`, `test_resolve_challenge_uphold`, `test_resolve_challenge_overturn`, `test_challenge_after_grace_panics`.
- **Integration tests**: Attest → revoke → challenge → resolve → verify final state.

### CI Requirements

- Standard.

### Deliverables

1. Revocation grace period and challenge logic.
2. Updated `AttestationStatus` enum.
3. Challenge and resolution functions.
4. Tests.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/attestation-contract/src/lib.rs` — `revoke_attestation`, `AttestationStatus`, `verify_attestation`.

---

## Issue #466 — Impact Certificate Merkle Root Rotation and Periodic Archiving

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

Add a periodic Merkle root rotation mechanism for impact certificates that archives old roots and enables verification against historical reporting periods. Each reporting period (e.g., monthly) generates a new Merkle root. Old roots are archived with metadata (period start/end, total impact) rather than overwritten. Donors can prove impact against any historical period.

### Background

The impact certificate system uses `ImpactKey::ImRoot(BytesN<32>)` for a single Merkle root. When a new reporting period's root is published, the old root is overwritten (or needs a different `report_id`). Issuing #430 (MMR) addresses this partially, but a simpler archiving approach may be preferable for projects with discrete reporting periods.

### Problem Statement

Overwriting the current root makes historical impact verification impossible without replaying event logs. Archiving historical roots with period metadata enables permanent verifiability of any past reporting period.

### Objectives

1. Replace single `ImRoot` with `ImpactRoot` struct: `{ root: BytesN<32>, period_start: u32, period_end: u32, total_co2_kg: u32, total_trees: u32, total_hectares: u32 }`.
2. Add `DataKey::ImpactRootArchive(String, u32)` — `(project_id, period_index)`.
3. Add `DataKey::ImpactRootCount(String)` — number of archived periods per project.
4. Add `publish_impact_root(env, admin, project_id, root, period_start, period_end, totals)` — M-of-N admin publishes a new root (archives the previous one).
5. Add `verify_impact_inclusion(env, project_id, period_index, leaf, proof, leaf_index) -> bool` — verify against a specific archived period.
6. Add `get_impact_periods(project_id) -> Vec<ImpactPeriodSummary>` — returns list of archived periods with metadata.
7. Retention: archive up to `MAX_ARCHIVED_PERIODS = 48` (4 years of monthly reports). Oldest periods drop off.

### Scope

**In Scope:**
- Periodic root archiving with metadata.
- Per-period impact totals.
- Verification against any archived period.
- Period listing query.
- Archive retention policy (circular).

**Out of Scope:**
- Automatic root generation (off-chain Merkle tree construction).
- Cross-period aggregation queries.
- Storage rent optimization for old periods.

### Acceptance Criteria

- [ ] `publish_impact_root` archives the previous root with metadata.
- [ ] `verify_impact_inclusion` works for any archived period.
- [ ] `get_impact_periods` returns correct period summaries.
- [ ] Archive capped at MAX_ARCHIVED_PERIODS.
- [ ] Period index increments correctly.
- [ ] Admin M-of-N required for publishing.

### Testing Requirements

- **Unit tests**: `test_publish_root_archives_previous`, `test_verify_against_archived_period`, `test_archive_rotation`, `test_max_periods_enforced`, `test_get_impact_periods`.
- **Integration tests**: Publish 3 periods, verify proofs against each, verify listing.
- **Fuzz tests**: `prop_archive_index_sequential`.

### CI Requirements

- Standard.

### Deliverables

1. Root archiving and rotation logic.
2. Per-period verification.
3. Period listing query.
4. Tests.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `ImpactKey::ImRoot`, `verify_merkle_proof`, `ImpactLeaf`.

---

## Issue #467 — Donation Batching with Atomic Multi-Project Distribution

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: medium`, `area: indigopay-contract`

### Summary

Add a batch donation function that allows a donor to split a single token transfer across multiple projects atomically. Currently, a donor must make N separate `donate_with_privacy` calls to donate to N projects, paying gas for each. A batch function amortizes gas and ensures atomicity — either all donations succeed or none do.

### Background

The current donation path processes one project at a time. A donor wanting to split 100 XLM across 10 projects makes 10 separate Soroban invocations.

### Problem Statement

Multi-project donations are gas-inefficient and lack atomicity. If a donor wants to distribute funds across several climate projects, they must make separate transactions. If one fails (e.g., project paused), the others still execute, leaving an inconsistent donation state.

### Objectives

1. Add `BatchDonation` input struct: `{ project_id: String, amount: i128, msg_hash: u32 }`.
2. Add `donate_batch(env, token, donor, donations: Vec<BatchDonation>, anonymous: bool)` — atomic batch donation.
3. Validate all donations first (all projects active, all amounts positive, rate limits not exceeded for any project).
4. If any donation fails validation, the entire batch reverts with a clear error indicating which project failed.
5. On success, execute all donations in sequence, updating stats and transferring tokens.
6. Token transfer: sum all amounts and transfer once from donor to contract, then distribute to each project wallet. This reduces token transfer operations from N to N+1 but amortizes Soroban invocation cost.
7. CO₂ calculation: compute per-project as normal.
8. Events: emit one `donate_batch` event plus individual `donated` events per project.
9. Batch size limit: `MAX_BATCH_SIZE = 20`.

### Scope

**In Scope:**
- Atomic batch donation.
- Pre-validation of all donations.
- Single token transfer with distribution.
- Batch size limit.
- Individual + batch events.

**Out of Scope:**
- Cross-token batch donations.
- Partial batch success.
- Donation scheduling within batch.

### Acceptance Criteria

- [ ] All donations in batch succeed or all revert.
- [ ] Pre-validation catches invalid projects before any state change.
- [ ] Rate limits respected across all donations in batch.
- [ ] Total token transfer matches sum of all donations.
- [ ] Each project receives correct amount.
- [ ] Events emitted correctly.
- [ ] Batch size limit enforced.

### Testing Requirements

- **Unit tests**: `test_donate_batch_success`, `test_donate_batch_invalid_project_reverts_all`, `test_donate_batch_rate_limit_reverts_all`, `test_donate_batch_size_limit`, `test_donate_batch_token_transfer_sum`.
- **Integration tests**: Register 5 projects, batch donate to all, verify each project stats.
- **Fuzz tests**: `prop_batch_atomicity`, `prop_batch_sum_conservation`.

### CI Requirements

- Standard.

### Deliverables

1. `donate_batch` function and `BatchDonation` type.
2. Pre-validation and atomic execution logic.
3. Tests.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `donate_with_privacy`, token transfer patterns, rate limiting.

---

## Issue #468 — Contract State Merkleization and Trustless State Proofs

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: high`, `area: indigopay-contract`

### Summary

Implement a state Merkleization mechanism that produces a cryptographic commitment to the contract's full state, enabling trustless state proofs that can be verified by light clients or other contracts. This is a building block for cross-chain bridging, layer-2 scaling, and trustless frontend state verification.

### Background

Soroban contracts store state in instance storage accessible via `env.storage().instance()`. There is currently no mechanism to produce a compact cryptographic proof of a subset of the contract's state that can be verified externally without trusting the RPC node.

### Problem Statement

Frontend applications trust Soroban RPC nodes to return correct contract state. A malicious or compromised RPC node could return fabricated state. State Merkleization enables trustless verification where the frontend can independently verify state against a known state root.

### Objectives

1. Implement a state Merkle tree over all `DataKey` variants, updated atomically with every state mutation.
2. Add `DataKey::StateRoot` — stores the current Merkle root of all contract state.
3. Add `get_state_proof(env, key: DataKey) -> StateProof` — returns a Merkle proof for a specific storage key against the current state root.
4. `StateProof` struct: `{ key: DataKey, value: Bytes, proof: Vec<BytesN<32>>, root: BytesN<32> }`.
5. Update state root after every state mutation (function-level hook).
6. The state root is part of the contract's public interface — anyone can query it.
7. Off-chain verifiers can independently reconstruct the state root from known key-value pairs and verify proofs.
8. Feature-gated behind `#[cfg(feature = "state-proofs")]` due to gas overhead.

### Scope

**In Scope:**
- State Merkle tree over all DataKey variants.
- State root tracking and updates.
- Proof generation for individual keys.
- Feature-gated for gas-conscious deployment.

**Out of Scope:**
- Incremental state root updates (full recomputation per mutation is acceptable for now).
- Proof aggregation (batch proofs).
- Cross-contract state proof verification.

### Acceptance Criteria

- [ ] State root updates after every state mutation.
- [ ] `get_state_proof` returns valid Merkle proof for any existing key.
- [ ] `get_state_proof` panics for nonexistent keys.
- [ ] Proof can be verified off-chain using SHA-256.
- [ ] State root is publicly queryable.
- [ ] Gas overhead is documented and feature-gated.

### Testing Requirements

- **Unit tests**: `test_state_root_after_init`, `test_state_root_after_donation`, `test_state_proof_valid`, `test_state_proof_invalid_key_panics`, `test_state_root_deterministic`.
- **Integration tests**: Init → donate → get state proof for donor stats → verify off-chain.
- **Fuzz tests**: `prop_state_root_consistent_with_storage`.

### CI Requirements

- Standard with `--features "testutils,state-proofs"`.

### Deliverables

1. State Merkle tree implementation.
2. State root tracking hook.
3. `get_state_proof` function.
4. Tests.
5. Updated `SECURITY.md` with trust model.

### Definition of Done

- All criteria met. Tests pass. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — `DataKey` enum, all state mutations, Merkle proof verification (`verify_merkle_proof`).
- `contracts/indigopay-contract/VERIFICATION.md` — formal verification of invariants.

---

## Issue #469 — Hash Time-Locked Contract (HTLC) for Cross-Chain Donation Settlement

**Labels:** `GrantFox OSS`, `Official Campaign`, `area: contracts`, `type: feature`, `priority: high`, `area: indigopay-contract`

### Summary

Implement Hash Time-Locked Contracts (HTLCs) for atomic cross-chain donation settlement. A donor on an external chain (e.g., Ethereum) can lock funds in an HTLC. A relayer or the project can claim the HTLC by revealing a preimage on Stellar, which triggers donation recording on the IndigoPay contract. If the HTLC expires without being claimed, funds are refundable on the source chain. This enables trustless cross-chain donations.

### Background

The `attestation-contract` provides cross-chain attestation but requires a trusted relayer. An HTLC-based approach removes the relayer trust for the fund transfer: the donor creates an HTLC on Ethereum with hash H, the project reveals preimage P (where SHA-256(P) = H) on Stellar to claim the donation recording, and the donor uses the revealed preimage to claim funds on Ethereum.

### Problem Statement

Cross-chain donations currently require trust in the relayer (attestation contract) or the donor to complete the Stellar-side transaction after the source-chain transaction. An HTLC enables atomic cross-chain settlement where the donor provides a hash-locked proof of commitment, and funds flow only when the preimage is revealed on both chains.

### Objectives

1. Add `Htlc` struct: `{ id: u64, hash_lock: BytesN<32>, donor: Address, project_id: String, token: Address, amount: i128, expires_at: u32, claimed: bool, refunded: bool }`.
2. Add `create_htlc(env, donor, project_id, token, amount, hash_lock, expires_ledger) -> u64` — donor locks funds in the contract with a hash lock.
3. Add `claim_htlc(env, claimer, htlc_id, preimage: BytesN<32>)` — anyone with the preimage can claim, recording the donation and transferring funds to project wallet.
4. Add `refund_htlc(env, donor, htlc_id)` — donor refunds after expiry if unclaimed.
5. The contract verifies `SHA-256(preimage) == hash_lock` before processing the claim.
6. Emit `htlc_created`, `htlc_claimed`, `htlc_refunded` events.
7. Donation recording on claim: updates project totals, donor stats, global CO₂ counters (same as `donate_with_privacy`).
8. HTLC expiration must be at least 24 hours in the future (`MIN_HTLC_DURATION`).
9. Maximum HTLC duration: 30 days (`MAX_HTLC_DURATION`).

### Scope

**In Scope:**
- HTLC creation, claim, and refund.
- SHA-256 preimage verification.
- Donation recording on claim.
- Expiry enforcement.
- Events.

**Out of Scope:**
- Cross-chain HTLC coordination (the source-chain HTLC is off-chain from this contract's perspective).
- HTLC batching.
- Multiple claimants.
- HTLC transfer or sale.

### Acceptance Criteria

- [ ] `create_htlc` locks funds with hash lock.
- [ ] `claim_htlc` with correct preimage records donation and transfers funds.
- [ ] `claim_htlc` with wrong preimage panics.
- [ ] `refund_htlc` returns funds to donor after expiry.
- [ ] `refund_htlc` before expiry panics.
- [ ] Double-claim prevented.
- [ ] Donation stats updated on valid claim.
- [ ] HTLC duration bounded (min 24h, max 30 days).
- [ ] Events emitted for all state transitions.

### Testing Requirements

- **Unit tests**: `test_create_htlc`, `test_claim_htlc_valid_preimage`, `test_claim_htlc_wrong_preimage_panics`, `test_refund_htlc_after_expiry`, `test_refund_htlc_before_expiry_panics`, `test_double_claim_panics`, `test_htlc_duration_bounds`, `test_htlc_donation_stats`.
- **Integration tests**: Create HTLC, claim with preimage, verify project wallet receives funds and donation recorded.
- **Fuzz tests**: `prop_htlc_preimage_verification`, `prop_htlc_expiry_enforced`.

### CI Requirements

- Standard.

### Deliverables

1. `Htlc` type, `create_htlc`, `claim_htlc`, `refund_htlc` functions.
2. SHA-256 verification using `env.crypto().sha256()`.
3. Donation recording integration.
4. Tests.
5. Updated `SECURITY.md` with HTLC trust model.
6. Updated `docs/contract-integration.md` with HTLC cross-chain flow.

### Definition of Done

- All criteria met. Tests pass. WASM under 64 KB. CI green.

### References

- `contracts/indigopay-contract/src/lib.rs` — SHA-256 usage in `verify_merkle_proof`, donation recording path, token transfer patterns.
- `contracts/attestation-contract/src/lib.rs` — cross-chain attestation model.
