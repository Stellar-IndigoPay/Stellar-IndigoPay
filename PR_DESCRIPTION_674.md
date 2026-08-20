# Fix: `mint_impact_nft` can mint previously-earned lower badge tiers

Closes #674

## Summary

`mint_impact_nft` previously required an **exact** match between the requested tier and the donor's current badge (`stats.badge != tier` → panic). Because `stats.badge` always holds the donor's *highest* tier, lower tiers became permanently unmintable once a donor progressed. This PR replaces the equality check with a **rank-order** comparison so a donor may mint any tier they have already reached (`tier ≤ current badge`), while preserving the invariant of **one NFT per tier**.

## Background

Impact NFTs are modeled as **per-tier** artifacts, not a single "current badge" artifact:

- `BadgeTier` (rank order): `None` → `Seedling` → `Tree` → `Forest` → `EarthGuardian`.
- `DataKey::ImpactNFT(Address, BadgeTier)` keys each NFT by `(donor, tier)`.
- `has_nft(donor, tier)` queries that per-tier key.
- `mint_impact_nft(donor, tier)` writes `ImpactNFT { owner, tier, total_donated, minted_at_ledger }` under that key and rejects if the key already exists.

The donation path already auto-mints the tier an upgrade *crosses into* (e.g. reaching `Tree` mints the `Tree` NFT), but it does not mint the lower tiers the donor has already passed through. `mint_impact_nft` was the manual entry point intended to let donors claim those earlier tiers — and its exact-match check defeated that purpose.

## Problem

A donor's badge is the **highest** tier they have ever reached, computed from cumulative donations:

| Cumulative XLM | Badge       |
| -------------- | ----------- |
| < 10           | `None`      |
| ≥ 10           | `Seedling`  |
| ≥ 100          | `Tree`      |
| ≥ 500          | `Forest`    |
| ≥ 2000         | `EarthGuardian` |

### Concrete scenario

1. Donor donates 10 XLM → badge becomes `Seedling`.
2. Donor donates another 90 XLM (100 total) → badge becomes `Tree`.
3. Donor calls `mint_impact_nft(donor, Seedling)`.

**Expected:** the `Seedling` NFT they already earned should mint.

**Actual (bug):** `stats.badge == Tree`, `tier == Seedling`, so `stats.badge != tier` triggers:

```rust
panic!("Tier does not match donor's current badge");
```

The donor can **only** ever mint `Tree` (their single current tier), and once they progress again, `Tree` is lost too. The per-tier NFT model — which the storage key, `has_nft`, and the one-NFT-per-tier dedup all encode — was effectively unusable.

## Root cause

```rust
// before
if stats.badge != tier {
    panic!("Tier does not match donor's current badge");
}
```

This exact-equality test conflates "current (highest) badge" with "eligible tier". It should have been an *ordering* test: a tier is eligible iff the donor has *reached* it, i.e. `rank(tier) ≤ rank(stats.badge)`.

## Solution

Add a rank mapping and flip the check from "not equal" to "above":

```rust
/// Rank-order of a badge tier. `None` is lowest, `EarthGuardian` highest.
#[cfg(feature = "impact")]
fn badge_rank(badge: &BadgeTier) -> u32 {
    match badge {
        BadgeTier::None => 0,
        BadgeTier::Seedling => 1,
        BadgeTier::Tree => 2,
        BadgeTier::Forest => 3,
        BadgeTier::EarthGuardian => 4,
    }
}
```

```rust
// after
if badge_rank(&tier) > badge_rank(&stats.badge) {
    panic!("Tier exceeds donor's current badge");
}
```

### Invariants preserved

| Guard | Behavior |
| ----- | -------- |
| `tier == BadgeTier::None` | Still rejected ("Cannot mint NFT for None tier") |
| `stats.badge == BadgeTier::None` | Still rejected ("No badge tier reached yet") |
| `rank(tier) > rank(stats.badge)` | **New** — rejects tiers not yet earned |
| `DataKey::ImpactNFT(donor, tier)` already present | Still rejected ("NFT already minted for this tier") — one NFT per tier |

No change to the automatic badge-upgrade minting path (`donate`, `donate_usdc`, batch, xchain settle), which continues to mint only the newly-crossed tier.

## Changes

### Contract — `contracts/indigopay-contract/src/lib.rs`

- **Added** `badge_rank(&BadgeTier) -> u32` (free function, `#[cfg(feature = "impact")]`, placed next to the `BadgeTier` enum).
- **Changed** `mint_impact_nft` tier guard from exact equality to rank-order `>` with a clearer panic message.

### Tests — `contracts/indigopay-contract/src/lib.rs`

- **Added** `set_donor_badge` test helper to inject an arbitrary `BadgeTier` into `DataKey::DonorStats` directly (bypassing the donation path) so tier progression can be exercised deterministically.
- **`test_mint_impact_nft_allows_previously_earned_lower_tiers`** — donor at `Forest` mints `Seedling`, `Tree`, and `Forest`; asserts all three `has_nft(...)` and that `EarthGuardian` is **not** minted.
- **`test_mint_impact_nft_rejects_tier_above_current_badge`** — donor at `Tree` attempts `Forest` and panics.
- **`test_mint_impact_nft_rejects_duplicate_tier`** — donor at `Forest` mints `Tree` twice; second mint panics.

### Documentation

- **`CHANGELOG.md`** — added entry under `[Unreleased]` → `### Fixed`.
- **`PR_DESCRIPTION_674.md`** — this document.

## Testing

### Unit tests

```bash
cd contracts
cargo test --features testutils -p indigopay-contract mint_impact_nft -- --skip fuzz
```

Result: `3 passed; 0 failed`.

### Full contract CI (all green)

```bash
cd contracts
cargo fmt --all -- --check
cargo clippy --workspace -- -D warnings
cargo test --features testutils --workspace -- --skip fuzz   # 360 indigopay tests, 0 failed
cargo build --workspace --target wasm32v1-none --release --no-default-features
```

Toolchain: Rust 1.91.0, soroban-sdk 27.0.0 (matching `.github/workflows/contracts.yml`).

## Acceptance Criteria

- [x] A donor can mint any tier ≤ their current badge, once each
- [x] Minting a tier above the current badge is still rejected
- [x] One NFT per tier is still enforced (duplicate mint rejected)
- [x] `None` tier and "no badge reached" guards preserved
- [x] Unit tests for tier progression added
- [x] Standard contract CI passes (fmt, clippy, tests, slim WASM build)
- [x] CHANGELOG entry added

## Impact

- **Behavior** — restores the intended per-tier NFT model: donors can retroactively claim every tier they earned.
- **Storage** — no layout or key changes; reuses `DataKey::ImpactNFT(donor, tier)` and the existing dedup guard.
- **Backward compatibility** — no change to existing storage keys, struct layouts, or the auto-mint upgrade path. Already-minted NFTs are unaffected.
- **Performance** — negligible: one `match` on a 5-variant enum per mint call.
- **Security** — `donor.require_auth()` and `require_not_paused()` are untouched, so only the donor can mint their own NFTs and the contract still respects the pause flag.

## Rollback Plan

```bash
git revert <commit>   # reverts code + tests + CHANGELOG in one atomic commit
```

## Related Issues

- Closes #674 — IndigoPay: `mint_impact_nft` exact-match tier check prevents minting previously-earned lower tiers

---

**Labels**: GrantFox OSS, area/contracts, type/bug, priority/medium

**Tested on**: Rust 1.91.0 (soroban-sdk 27.0.0)
