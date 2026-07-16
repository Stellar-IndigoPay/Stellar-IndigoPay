# IndigoPay Soroban Contract

This Soroban smart contract provides **on-chain transparency** for every climate donation on Stellar IndigoPay.

## What it does

Every donation is recorded permanently on the Stellar blockchain. Anyone can query project totals, donor statistics, CO₂ offsets, and badge tiers — with no central authority controlling the data.

## Functions

| Function                                                       | Who calls it              | Description                                                                      |
| -------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------- |
| `initialize(admin)`                                            | Deployer                  | One-time setup                                                                   |
| `register_project(admin, id, name, wallet, co2_per_xlm)`       | Admin                     | Register a verified project                                                      |
| `batch_register_projects(admin, projects)`                     | Admin                     | Register many projects in one call                                               |
| `update_project_co2_rate(admin, id, co2_per_xlm)`              | Admin                     | Update a project's CO₂ offset rate                                               |
| `pause_project(admin, id)`                                     | Admin                     | Pause donations to a single project                                              |
| `resume_project(admin, id)`                                    | Admin                     | Lift a per-project pause                                                         |
| `deactivate_project(admin, id)`                                | Admin                     | Stop new donations to a project                                                  |
| `deactivate_all_projects(admin)`                               | Admin                     | Deactivate every registered project (incident response)                          |
| `donate(token, donor, project_id, amount, msg_hash)`           | Donor                     | Send XLM + record donation                                                       |
| `donate_usdc(usdc_token, donor, project_id, amount, msg_hash)` | Donor                     | Send USDC + record donation (XLM-equivalent via oracle)                          |
| `mint_impact_nft(donor, tier)`                                 | Donor                     | Mint an Impact NFT for the donor's current badge                                 |
| `mint_project_nft(donor, project_id)`                          | Donor                     | Mint a milestone NFT for ≥ 100 XLM cumulative to one project                     |
| `create_proposal(admin, project_id, duration_ledgers)`         | Admin                     | Open a community-vote proposal (0 = default 7 days)                              |
| `vote_verify_project(voter, project_id, approve)`              | Badge holder (≥ Seedling) | Cast a vote                                                                      |
| `resolve_proposal(project_id)`                                 | Anyone (after deadline)   | Finalize the proposal                                                            |
| `veto_proposal(admin, project_id)`                             | Admin                     | Immediate veto of an open proposal                                               |
| `set_usdc_token(admin, usdc_token)`                            | Admin                     | Configure the USDC token for `donate_usdc`                                       |
| `set_oracle(admin, oracle)`                                    | Admin                     | Configure the price oracle for `donate_usdc`                                     |
| **`transfer_admin(admin, new_admin)`**                         | **Admin**                 | **Phase A: step 1 of two-step admin handoff**                                    |
| **`accept_admin()`**                                           | **Proposed admin**        | **Phase A: step 2 — promotes the pending admin**                                 |
| **`cancel_admin_transfer(admin)`**                             | **Admin**                 | **Phase A: drop a pending admin proposal**                                       |
| **`pause_contract(admin)`**                                    | **Admin**                 | **Phase A: pause every state-mutating function**                                 |
| **`unpause_contract(admin)`**                                  | **Admin**                 | **Phase A: lift the contract-level pause**                                       |
| **`propose_upgrade(admin, new_wasm_hash)`**                    | **Admin**                 | **Phase A: step 1 of 48h upgrade timelock**                                      |
| **`execute_upgrade()`**                                        | **Anyone (after 48h)**    | **Phase A: step 2 — swap the WASM**                                              |
| **`cancel_upgrade(admin)`**                                    | **Admin**                 | **Phase A: drop a pending upgrade**                                              |
| `get_project(id)`                                              | Anyone                    | Read project stats                                                               |
| `get_donor_stats(donor)`                                       | Anyone                    | Read donor stats + badge                                                         |
| `get_badge(donor)`                                             | Anyone                    | Get current badge tier                                                           |
| `get_global_total()`                                           | Anyone                    | Total XLM raised platform-wide                                                   |
| `get_global_co2()`                                             | Anyone                    | Total CO₂ offset in grams                                                        |
| `get_global_stats()`                                           | Anyone                    | All four global counters in one call                                             |
| `get_donation_count()`                                         | Anyone                    | Total donations recorded                                                         |
| `get_project_count()`                                          | Anyone                    | Total registered projects                                                        |
| `get_donation_record(index)`                                   | Anyone                    | Read a donation by index                                                         |
| `get_admin()`                                                  | Anyone                    | Current admin address                                                            |
| **`get_pending_admin()`**                                      | **Anyone**                | **Phase A: pending admin (None if no transfer in flight)**                       |
| **`is_contract_paused()`**                                     | **Anyone**                | **Phase A: contract-level pause state**                                          |
| **`get_pending_upgrade()`**                                    | **Anyone**                | **Phase A: pending `(hash, effective_at)` tuple (None if no upgrade pending)**   |
| **`get_last_executed_upgrade()`**                              | **Anyone**                | **Phase A: hash of the most-recently executed upgrade (None if never upgraded)** |
| `get_voter_list(project_id)`                                   | Anyone                    | Voter list for a governance proposal                                             |
| `get_proposal(project_id)`                                     | Anyone                    | Read a governance proposal                                                       |
| `get_usdc_token()`                                             | Anyone                    | Configured USDC token address (or `None`)                                        |
| `get_oracle()`                                                 | Anyone                    | Configured price oracle address (or `None`)                                      |

## Badge Tiers

| Badge          | Emoji | Threshold   |
| -------------- | ----- | ----------- |
| Seedling       | 🌱    | ≥ 10 XLM    |
| Tree           | 🌳    | ≥ 100 XLM   |
| Forest         | 🌲    | ≥ 500 XLM   |
| Earth Guardian | 🌍    | ≥ 2,000 XLM |

## Build & Test

```bash
cargo build --target wasm32v1-none --release
cargo test
```

## Fuzz Testing

The contract includes property-based fuzz tests for every state-mutating
function, verifying invariants such as:
- Global total_raised and CO₂ offset never decrease
- Per-project totals never decrease
- Donation counts are monotonically increasing
- Donor badges only upgrade (never downgrade)
- Deactivated/paused projects reject donations
- Contract-level pause/unpause gating works correctly
- Multi-project global consistency (global total = sum of project totals)
- Admin transfer two-step handoff
- USDC donations with oracle price conversion

### Running fuzz tests

```bash
# Default: 10 000 iterations
cargo test --features testutils -- fuzz

# CI-level: 100 000 iterations
FUZZ_ITERATIONS=100000 cargo test --features testutils -- fuzz

# Nightly deep fuzz: 1 000 000 iterations
FUZZ_ITERATIONS=1000000 cargo test --features testutils -- fuzz
```

The `FUZZ_ITERATIONS` environment variable is read by the fuzz test harness
and passed to proptest as the case count. When unset, the default is 10 000.

### Adding fuzz tests for new functions

See `fuzz_template.rs` for a reusable template with property-definition
patterns and input-generation strategies. Key steps:
1. Copy the template block into `fuzz_tests.rs` inside the `proptest!` macro
2. Replace dummy strategies with real parameter ranges
3. Assert at least one invariant (counters monotonic, state validity, etc.)

### Coverage

Coverage is measured with `cargo-tarpaulin` and enforced in CI:

```bash
cargo install cargo-tarpaulin
cargo tarpaulin --config .tarpaulin.toml
```

When opening a PR, the coverage job runs and uploads an HTML report.
The minimum coverage threshold is 70% (configurable in `.tarpaulin.toml`).
PRs that drop coverage below the threshold will fail CI.

## Deploy

```bash
chmod +x ../../scripts/deploy-contract.sh
../../scripts/deploy-contract.sh testnet alice
```

## Register a Project

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source alice \
  --network testnet \
  -- register_project \
  --admin <ADMIN_ADDRESS> \
  --project_id "amazon-001" \
  --name "Amazon Reforestation" \
  --wallet <PROJECT_WALLET> \
  --co2_per_xlm 8500
```

`co2_per_xlm` = estimated grams of CO₂ offset per XLM donated (8,500 ≈ 8.5 kg per XLM)

## Roadmap

- **v1.3** — Impact NFT minting on badge achievement
- **v2.1** — DAO governance voting for project verification
