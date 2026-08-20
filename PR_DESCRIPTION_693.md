# Mobile: jailbreak/root detection with a configurable device-integrity policy

Closes #693

## Summary

The mobile app used biometric auth (`mobile/hooks/useBiometricAuth.ts`) and secure storage (`mobile/lib/secureStore.ts`, `mobile/lib/wallet/sdk.ts`) to protect wallet/session secrets, but had **no jailbreak/root detection**. On a rooted/jailbroken device the secure enclave, iOS Keychain, and Android EncryptedSharedPreferences can be bypassed, so the biometric gate alone was not a sufficient control — a compromised device could reveal stored secrets, unlock the session, and authorise transfers.

This PR adds a single, self-contained device-integrity module (`mobile/lib/deviceIntegrity.ts`) backed by `expo-device`'s `isRootedExperimentalAsync()`, with a configurable policy (`off | warn | block`, default `block`) and an injectable detector so the whole policy is unit-testable without any native module. It is wired into every biometric- and secret-protected flow and surfaced visually in the `AuthGate` fallback UI.

## Problem statement

The mobile threat model did not account for compromised devices:

- On a rooted (Android) or jailbroken (iOS) device, secure enclave and Keychain protections can be bypassed, exposing stored wallet/session secrets.
- The OS biometric result can be spoofed or bypassed, so "authenticated" is no longer a meaningful signal.
- A stolen, rooted device can therefore reveal secrets, unlock the session, and authorise transfers that a clean device would protect.

No device-integrity check was referenced anywhere in the auth or secure-storage path before this change.

## Objectives

1. Add jailbreak/root detection via `expo-device` integrity checks.
2. Make the reaction configurable through a policy: `off`, `warn`, or `block` (default `block`).
3. Enforce that policy on sensitive flows (unlock, secret reveal/store, donation confirmation).
4. Cover the detection, policy mapping, and enforcement with unit tests using a mocked integrity check.

## Scope

### In scope

- A mobile device-integrity check module.
- Wiring the check into biometric auth and session unlock.
- Policy enforcement (blocking sensitive flows on compromise).
- Unit/integration tests for the policy with a mocked detector.
- A mobile CI job that runs the test suite.
- A CHANGELOG entry.

### Out of scope

- Remote attestation (explicitly excluded by the issue).
- Bypass-proof detection — `isRootedExperimentalAsync` is experimental and can be defeated (xCon on iOS, root-hiding on Android); it is one layer of defence, not a guarantee.
- `mobile/src/**` legacy components (see "Notes").

## Implementation

The issue's three-step plan was followed exactly:

1. **Add a device-integrity check on auth/biometric unlock** — the standalone `authenticate()` helper (used by `secureStore` and `AuthProvider.unlock()`) and the `confirmDonation()` hook both run the integrity check before prompting.
2. **Enforce the policy (block sensitive flows on compromise)** — under `block`, unlock/authenticate resolve `false` and donation confirmation returns `{ success: false, error: "Device integrity check failed" }` without ever showing the OS prompt; under `warn`, the flow proceeds but records and surfaces a warning.
3. **Unit/integration test the policy** — `deviceIntegrity.test.ts` exercises policy resolution, the pure policy mapping, end-to-end enforcement with an injected detector, the production `expo-device` detector (clean / rooted / throws → fail-open), and warning surfacing.

### New files

| File | Purpose |
| --- | --- |
| `mobile/lib/deviceIntegrity.ts` | The integrity-check module: detector, policy resolution, pure policy mapping, warning surfacing, and a test-injectable detector hook. |
| `mobile/lib/__tests__/deviceIntegrity.test.ts` | Unit tests for the module. |
| `mobile/__mocks__/expo-device.js` | Jest mock of `expo-device` so tests run without the native module. |
| `PR_DESCRIPTION_693.md` | This campaign PR description (repo convention). |

### Modified files

| File | Change |
| --- | --- |
| `mobile/hooks/useBiometricAuth.ts` | `confirmDonation()` and `authenticate()` enforce the integrity policy before any biometric prompt; hook exposes `isDeviceCompromised`, `integrityPolicy`, and `integrityWarning`. |
| `mobile/providers/AuthProvider.tsx` | Probes device integrity on mount and exposes `isDeviceCompromised` + `integrityPolicy` on the auth context. |
| `mobile/components/AuthGate.tsx` | Locked fallback renders a hard-stop "Device not trusted" screen under `block` and a caution banner under `warn`. |
| `mobile/.env.example` | Documents `EXPO_PUBLIC_DEVICE_INTEGRITY_POLICY` (off/warn/block). |
| `mobile/package.json` / `mobile/package-lock.json` | Add `expo-device@~57.0.1`. |
| `.github/workflows/ci.yml` | Adds a `mobile` jest job so the mobile test suite runs in CI (it did not before). |
| `mobile/__tests__/useBiometricAuth.test.tsx` | Tests for the new enforcement behaviour. |
| `mobile/providers/__tests__/AuthProvider.test.tsx` | Test that the provider surfaces `isDeviceCompromised`. |
| `mobile/components/__tests__/AuthGate.test.tsx` | Tests for the block/warn fallback UI. |
| `CHANGELOG.md` | Entry under `[Unreleased] → Added`. |

### The module (`mobile/lib/deviceIntegrity.ts`)

- **Policy source** — `getIntegrityPolicy()` reads `EXPO_PUBLIC_DEVICE_INTEGRITY_POLICY` (inlined by Expo's Babel transform at build time). Valid values are `off | warn | block`; anything else falls back to `block`. EAS builds can ship `block` while simulators/dev builds use `off`.
- **Detector** — `checkDeviceIntegrity()` runs the active detector. Production uses `expo-device.isRootedExperimentalAsync()` and **fails open** (clean with `supported: false`) on web or when the native call throws, so the check can never brick the app.
- **Pure policy mapping** — `evaluateIntegrityPolicy(result, policy)` maps compromise verdict + policy to `allow | warn | block`. Never throws.
- **Convenience wrapper** — `enforceIntegrityPolicy()` runs the check then maps it through the active policy.
- **Warning surfacing** — `recordWarning()` keeps the latest reason (`getLastIntegrityWarning()`) and notifies subscribers (`onIntegrityWarning()`).
- **Testability** — `setIntegrityDetector()` / `resetIntegrityDetector()` swap the detector.

### Enforcement points

| Flow | Gate | `block` | `warn` |
| --- | --- | --- | --- |
| Session unlock | `AuthProvider.unlock()` → `authenticate()` | returns `false`, stays locked | proceeds, warning recorded |
| SecureStore `requireAuth` read/write/delete | `secureStore` → `authenticate()` | returns `null`/`false` | proceeds, warning recorded |
| Secret-key store/load/delete | `wallet/sdk` → `secureStore` (`requireAuth`) | aborts | proceeds, warning recorded |
| Donation / send / SEP-0007 confirm | `useBiometricAuth.confirmDonation()` | `{ success: false }` before prompt | proceeds, warning recorded |
| Gated screen UI | `AuthGate` | hard-stop screen, no unlock button | caution banner + unlock available |

## Acceptance criteria

- [x] Compromised devices trigger the configured policy — `block` refuses every sensitive flow and shows a hard-stop UI; `warn` proceeds but records and surfaces a warning; `off` disables enforcement.
- [x] The policy is configurable per build via `EXPO_PUBLIC_DEVICE_INTEGRITY_POLICY` (default `block`).
- [x] The detector fails open (never bricks a clean device on a web/unsupported/error path).

## Testing

- `mobile/lib/__tests__/deviceIntegrity.test.ts` — policy resolution + sanitisation; pure mapping for all (clean/compromised × off/warn/block); end-to-end `enforceIntegrityPolicy` with an injected detector; the production detector (clean / rooted / throws → fail-open); warning surfacing (last-warning + listener isolation).
- `mobile/__tests__/useBiometricAuth.test.tsx` — `confirmDonation()` refuses on a compromised device under `block`, proceeds under `warn`; standalone `authenticate()` refuses under `block` without invoking `LocalAuthentication`.
- `mobile/providers/__tests__/AuthProvider.test.tsx` — provider surfaces `isDeviceCompromised: true` via context.
- `mobile/components/__tests__/AuthGate.test.tsx` — hard-stop + no unlock button under `block`; caution banner + working unlock under `warn`; standard UI when clean.

**Result:** 30 test suites / **295 tests passing**, `tsc --noEmit` clean.

## CI requirements

- Added a `mobile` jest job to `.github/workflows/ci.yml` (`npm ci` + `npm test -- --ci --forceExit`) because the mobile test suite was not running anywhere in CI previously. `--forceExit` prevents the known "Jest did not exit one second after the test run" open-handle hang from flaking the job.
- Branch is rebased on the latest `upstream/main`; the only conflict (a `CHANGELOG.md` `### Added` entry) was resolved, so this merges cleanly.

## Deliverables

- [x] Single commit: `feat(mobile): add jailbreak/root detection with configurable integrity policy`
- [x] CHANGELOG entry under `[Unreleased] → Added`

## Definition of done

- [x] Integrity check added
- [x] Tests green (295 passing, typecheck clean, mobile CI job added)

## Notes / risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Detection is bypassable | Explicitly out of scope; `isRootedExperimentalAsync` is one layer of defence, not remote attestation. |
| Detector could brick a clean device | Fails open on web and on any detector error (`supported: false` treated as clean). |
| `mobile/src/hooks/useWallet.ts` uses raw `expo-secure-store` | It stores only a **public key** and `mobile/src/**` is legacy/unused by active `app/` routes — not a secret, intentionally left untouched. |

## References

- Issue: https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/693
- `mobile/hooks/useBiometricAuth.ts`
- `mobile/lib/secureStore.ts`
- `mobile/lib/wallet/sdk.ts`
- `mobile/providers/AuthProvider.tsx`
- `mobile/components/AuthGate.tsx`

---

**Labels**: GrantFox OSS, Official Campaign, area/mobile, type/security, priority/medium

**Tested on**: Expo SDK 57 (jest-expo preset), Node 22, Ubuntu

**Contributors**: @DammyAji
