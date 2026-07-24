# Add Oracle Reporter Staking and Slashing

**Closes #446**

## Summary

Adds cryptoeconomic security to the Soroban oracle contract. Allow-listed
reporters must maintain a configurable minimum token stake to submit prices.
Administrators can slash provably bad reporters, with slashed funds transferred
to a configured treasury and an immutable on-chain audit history.

## Type

- [ ] Bug fix
- [x] New feature
- [x] Documentation
- [ ] Refactor
- [x] Smart contract change

## Changes

- Added staking token, minimum stake, treasury, and cooldown configuration.
- Added reporter stake balances and cooldown tracking.
- Added append-only per-reporter slash history.
- Added `stake`, `unstake`, and admin-authorized `slash` entrypoints.
- Added stake gating to `report_price`.
- Added read-only stake and slash-history queries.
- Added `stake_dep`, `stake_wdr`, and `stake_slash` events.
- Transfers slashed funds to the configured treasury.
- Uses checks-effects-interactions ordering for every token transfer.
- Preserves backward compatibility until staking is explicitly configured.
- Documented administrator and token trust assumptions.

## Testing

- `test_stake`
- `test_report_without_stake_panics`
- `test_slash_reduces_stake`
- `test_unstake_after_cooldown`
- `test_unstake_before_cooldown_panics`
- `test_slash_event`
- `prop_stake_never_negative`

The branch is monitored against the repository's complete CI suite after push.

## Screenshots

Not applicable; this PR contains no UI changes.
