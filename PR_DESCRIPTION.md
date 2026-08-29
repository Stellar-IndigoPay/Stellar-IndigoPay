# PR Description

## Title
feat: Add key rotation, quota handling, and wipe verification to secure store

## Description
This PR addresses several critical operational and security concerns within `mobile/lib/secureStore.ts`:
- **Key Versioning & Rotation**: Implements a rotation API (`rotateKey`) with a dual-read transition window. Keys are now prefixed with version namespaces (e.g., `@StellarIndigo:v1:`).
- **Quota Guards**: Introduces pre-flight payload size estimation to reject writes exceeding the OS platform cap (2048 bytes on iOS, 8192 bytes on Android) explicitly with a typed `QuotaExceededError`. 
- **Wipe Verification & Integrity Check**: As iOS Keychain lacks prefix enumeration, we now maintain a manifest of written keys under `@StellarIndigo:__manifest`. `wipeAll` uses this manifest to enumeratively delete all secrets and verifies emptiness. Also adds an app startup integrity check `checkIntegrity()` to detect discrepancies between the manifest and stored secrets.
- **Robust Testing**: Replaced previous mock-based tests with an updated suite that covers quota limits, simulated mid-transition crashes during rotation, and wipeAll operations. No regressions in `requireAuth` or `ttlMs` functionality.

## Manual Test Matrix Execution

| Device / Environment | Test Case | Status |
|---|---|---|
| iOS Simulator | Rotate key mid-transition crash | ✅ Pass |
| iOS Simulator | Exceed 2048-byte limit | ✅ Pass |
| iOS Simulator | Verify wipeAll emptiness | ✅ Pass |
| iOS Simulator | Biometric cancellation | ✅ Pass |
| Android Emulator | Rotate key mid-transition crash | ✅ Pass |
| Android Emulator | Exceed 8192-byte limit | ✅ Pass |
| Android Emulator | Verify wipeAll emptiness | ✅ Pass |
| Android Emulator | Biometric cancellation | ✅ Pass |

All tests pass. No regressions observed for `requireAuth` and `ttlMs` behaviors.
