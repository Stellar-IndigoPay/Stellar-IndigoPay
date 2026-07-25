# Add Anonymous Donation Proof Verification

**Closes #432**

## Summary

Adds an optional, WASM-conscious anonymous-donation verification path to the
IndigoPay Soroban contract. The new flow verifies a compact off-chain prover
attestation, rejects reused nullifiers, and records project/global donation
statistics without storing a donor address or updating donor-specific stats.

The implementation is feature-gated behind `zk` so deployments that do not
need anonymous donations incur no additional contract footprint.

## Type

- [ ] Bug fix
- [x] New feature
- [x] Documentation
- [ ] Refactor
- [x] Smart contract change

## Changes

- Added the `zk` Cargo feature.
- Added `set_zk_verification_key`, protected by the existing M-of-N admin
  authorization model.
- Added `donate_anonymous_zk` with:
  - verification of the ordered public inputs;
  - Ed25519 verification of the off-chain prover attestation;
  - project-ID hash binding;
  - nullifier binding and replay prevention;
  - positive-amount validation;
  - project status and campaign validation.
- Added `ZkVerificationKey`, `Nullifier`, and `ZkDonationRecord` storage keys.
- Added an anonymous donation record that intentionally contains no donor
  address.
- Updates project totals, global donation totals, global CO2 totals, and the
  global donation count.
- Does not update `DonorStats`, donor badges, donor-project totals, or
  donor-count tracking.
- Added `zk_vk_set` and `zk_donate` events for indexers.
- Added getters for anonymous donation records and nullifier status.
- Added feature-gated tests for verification-key configuration and malformed
  proof rejection.
- Documented the verifier trust boundary and event schemas.

## Verification Model

To remain compatible with the contract's tight WASM-size requirements, the
on-chain verifier uses an Ed25519 prover-attestation model. An off-chain prover
validates the ZK circuit and signs:

```text
project_id_hash || amount_commitment || nullifier
```

The contract verifies that signature using the M-of-N-admin-managed public
key. This trust boundary, including relayer and amount-disclosure limitations,
is documented in `contracts/indigopay-contract/SECURITY.md`.

## Testing

- [ ] Tested locally on Testnet
- [ ] `cargo test --features "testutils,zk"`
- [ ] WASM size verified below 64 KB
- [x] `git diff --check`
- [x] Feature-gated unit tests added
- [x] Documentation updated

Rust/Cargo and the Stellar CLI were not installed in the implementation
environment, so the Rust test suite, Testnet flow, and compiled WASM-size check
could not be executed locally.

## Files Changed

| File | Purpose |
| --- | --- |
| `contracts/indigopay-contract/src/lib.rs` | Verification, storage, accounting, events, and tests |
| `contracts/indigopay-contract/Cargo.toml` | Adds the optional `zk` feature |
| `contracts/indigopay-contract/SECURITY.md` | Documents the anonymous-donation trust model |
| `contracts/EVENTS.md` | Documents `zk_vk_set` and `zk_donate` |

## Screenshots

Not applicable; this PR contains no UI changes.
