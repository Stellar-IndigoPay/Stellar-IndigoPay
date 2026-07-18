## Summary

This PR implements an automated integration test suite to validate the full Soroban contract upgrade lifecycle from v1 to v2, ensuring backward compatibility of on-chain state, event emission continuity, and indexer compatibility.

Key details:
- **V1 feature-flag & layout simulation**: Added a `v1` feature flag in `contracts/indigopay-contract` to conditionally compile `Project` without the `paused` field, simulating the legacy v1 contract.
- **DataKey variant additions**: Appended `NewFeature` to the end of the `DataKey` enum to guarantee backward compatibility without layout collisions.
- **Rust Upgrade integration tests**: Created `contracts/tests/upgrade_test.rs` which registers v1 WASM, seeds data (project, donations, proposal, and vote), tests upgrade proposals, cancellation, timelock enforcement (fails execution before 34,560 ledgers), executes the upgrade to v2 WASM, and verifies state continuity and v2 feature execution.
- **V2 WASM Fixture**: Created a test-only v2 fixture contract under `contracts/indigopay-contract/tests/v2_fixture.rs` (with Cargo configuration) to simulate the updated contract post-upgrade.
- **Indexer Compatibility suite**: Created `backend/__tests__/contractUpgrade.test.js` verifying that the backend indexer manages cursor progress across upgrades, gracefully ignores or logs new event types, and handles parsing failures via the DLQ.
- **CI Integration & Docs**: Integrated the test suite into the CI runner workflow `.github/workflows/contracts.yml` and updated `UPGRADE.md` and `CHANGELOG.md`.

## Type

- [ ] Bug fix
- [x] New feature
- [x] Documentation
- [ ] Refactor
- [x] Smart contract change

## Related Issue

Closes #152

## Testing

- [ ] Tested locally on Testnet
- [x] No TypeScript / Rust errors
- [x] Docs updated if needed

## Screenshots (if UI change)

N/A
