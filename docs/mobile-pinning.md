# Mobile Certificate / Public-Key Pinning

**Closes [issue #694](https://github.com/Stellar-IndigoPay/Stellar-IndigoPay/issues/694)**
— *Mobile: No TLS certificate pinning for API calls*.

The mobile app (React Native / Expo) talks to the IndigoPay backend over HTTPS.
Without pinning, a MITM with a trusted-but-compromised CA (or a misconfigured
proxy) can intercept API traffic — including auth tokens and donation intents.
This document explains how the app pins the backend certificate, how pins are
generated, how rotation is handled safely, and how to wire the native
enforcement layer for production builds.

---

## 1. Overview

| Concern                        | Where it lives                  | What it does                                                          |
| ------------------------------ | ------------------------------- | --------------------------------------------------------------------- |
| Pinning policy (host → pins)   | `mobile/lib/pinning.ts`         | Which hosts are pinned, which pins are allowed, dev allowlist.        |
| Safe rotation / remote updates | `mobile/lib/pinning.ts`         | Grace-pin rotation, HMAC-authenticated remote pin updates.            |
| Centralized HTTP client        | `mobile/lib/apiClient.ts`       | All backend calls flow through `apiClient` / `pinnedFetch`.           |
| Unit tests                     | `mobile/lib/__tests__/*.test.ts`| Pin validation, mismatch rejection, rotation, crypto vectors.         |
| Native enforcement (production)| Android Network Security Config / iOS TrustKit (see §5) | Rejects mismatched certs at the TLS layer. |

A pin is the base64 **SHA-256 digest of the DER-encoded SubjectPublicKeyInfo**
(SPKI) of the server certificate, expressed in RFC 7469 form: `sha256/<base64>`.
Pinning the *public key* (not the whole cert) means a cert renewal that reuses
the same key does not break the app, and you can pre-ship the next key.

---

## 2. How the JS policy works

`lib/pinning.ts` is pure and dependency-free. Its key functions:

- `normalizeHost(url)` — reduce a URL to a bare hostname.
- `parsePin(value)` — validate `sha256/<base64>` (must decode to 32 bytes).
- `isHostPinned(policy, host)` — true when the host has active pins.
- `isPinningBypassed(policy, host, { isDev, allowlist })` — dev allowlist:
  localhost/loopback, explicit allowlist entries, `bypass: true` policies, and
  any unconfigured host **in a dev build** are never enforced.
- `validatePins(policy, host, presentedPins)` — the enforcement primitive.
  Throws `PinningError` with a machine-readable `code`:
  - `PIN_MISMATCH` — none of the peer's pins matched the pinned set.
  - `HOST_NOT_PINNED` — host has no policy.
  - `INVALID_PIN_FORMAT` — malformed pin value.
  - `PINNING_NOT_ENFORCED` — pinned host, no verifier registered (production).
  - `INVALID_SIGNATURE` / `STALE_PIN_UPDATE` — remote pin update rejected.

`lib/apiClient.ts` asserts the policy before every request:

```text
request → normalizeHost(url)
        → isPinningBypassed?        → allow
        → isHostPinned?             → no policy → allow
        → PinningVerifier registered? → run it (throws PIN_MISMATCH on failure)
        → no verifier + dev build   → warn and continue
        → no verifier + production  → throw PINNING_NOT_ENFORCED (fail closed)
```

---

## 3. Configuration

Configuration is via `EXPO_PUBLIC_*` env vars (see `mobile/.env.example`),
which Expo inlines at build time:

| Variable                         | Purpose                                                              |
| -------------------------------- | -------------------------------------------------------------------- |
| `EXPO_PUBLIC_PINNING_ENABLED`    | `false` disables pinning entirely (default in the template).         |
| `EXPO_PUBLIC_PINNING_POLICY`     | JSON mapping host → pins, e.g. `{"api.example.com":["sha256/AAA..."]}`. |
| `EXPO_PUBLIC_PIN_ALLOWLIST`      | Comma-separated hosts exempt from pinning (dev allowlist).           |
| `EXPO_PUBLIC_PIN_UPDATE_SECRET`  | HMAC-SHA256 secret authenticating remote pin updates.                |

> **Always ship ≥ 2 pins per host** (current + next). This is what makes
> certificate rotation safe: when the server rotates to the pre-shipped key,
> the app still connects, and the old pin is demoted to a grace pin while the
> new pin is promoted.

### Generating a pin

```bash
# Get the server's SPKI and hash it (RFC 7469 pin)
openssl s_client -connect api.example.com:443 -servername api.example.com \
  </dev/null 2>/dev/null | openssl x509 -pubkey -noout | \
  openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl base64
# → 9n0y4q... (this is the value after "sha256/")
```

For your local backend (`http://localhost:4000`) no pin is needed — loopback
hosts are always exempt.

---

## 4. Safe pin rotation & remote updates

### Rotation (additive-first)

`PinRegistry.rotatePins(host, newPins, { graceMs })`:

1. The **new pins become active** immediately.
2. The **previous active pins are demoted to `gracePins`** and remain accepted
   until `graceUntil` (default 7 days).
3. `confirmRotation(host)` drops the grace pins once the new certificate is
   confirmed working.

Because rotation is additive-first, a server that rotates its certificate
**never locks out clients** that still present the old key.

### Remote pin updates (managed path)

Pins can be updated at runtime from a signed source via
`applyRemotePinUpdate(registry, update, signature, secret)`:

- The payload is authenticated with **HMAC-SHA256** using
  `EXPO_PUBLIC_PIN_UPDATE_SECRET` (implemented in pure JS in `lib/pinning.ts`
  and validated against the RFC 4231 test vectors).
- Replay / staleness guards reject updates that are too old, stamped in the
  future, or an older version than the one already applied.
- A MITM cannot inject pins because it does not know the signing secret.

```ts
import { PinRegistry, applyRemotePinUpdate, signPinUpdate } from "../lib/pinning";

const update = { host: "api.example.com", pins: ["sha256/NEW..."], issuedAt: Date.now(), version: 3 };
const signature = signPinUpdate(update, process.env.EXPO_PUBLIC_PIN_UPDATE_SECRET!);
applyRemotePinUpdate(registry, update, signature, process.env.EXPO_PUBLIC_PIN_UPDATE_SECRET!);
```

---

## 5. Native enforcement (production)

React Native performs TLS validation natively and does **not** expose the
verified certificate to JavaScript. The JS layer therefore owns the *policy*
and the API client asserts it, but the actual rejection of a mismatched
certificate happens at the native TLS layer. Configure it with the **same
pins** as `EXPO_PUBLIC_PINNING_POLICY`:

### Android — Network Security Config

Add a `network_security_config.xml` and reference it from `app.json` via an
Expo config plugin (or from the AndroidManifest in a bare workflow):

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <!-- Debug builds: trust the system CAs (dev allowlist). -->
  <debug-overrides>
    <trust-anchors>
      <certificates src="system" />
    </trust-anchors>
  </debug-overrides>
  <domain-config>
    <domain includeSubdomains="false">api.example.com</domain>
    <pin-set expiration="2027-06-01">
      <pin digest="SHA-256">9n0y4q...</pin>   <!-- current -->
      <pin digest="SHA-256">7xK2mZ...</pin>   <!-- next (rotation) -->
    </pin-set>
  </domain-config>
</network-security-config>
```

The `<debug-overrides>` element is the native equivalent of the JS dev
allowlist: debuggable (development) builds trust the system CA store, while
release builds enforce the `<pin-set>`.

### iOS — TrustKit

iOS has no plist-based pinning; use [TrustKit](https://github.com/datatheorem/TrustKit)
(or a custom `NSURLSession` delegate) with the same pins:

```swift
let config = [
  kTSKEnforcePinning: true,
  kTSKIncludeSubdomains: false,
  kTSKPublicKeyHashes: ["9n0y4q...", "7xK2mZ..."],
]
TrustKit.sharedInstance().initWithConfiguration([host: config])
```

Then register the native verifier in the app so the JS layer can also assert it:

```ts
import { registerPinningVerifier } from "../lib/apiClient";

registerPinningVerifier({
  verify(host) {
    // Ask the native module whether the peer certificate for `host` matched;
    // throw PinningError("PIN_MISMATCH", host, ...) when it did not.
  },
});
```

---

## 6. Tests

`mobile/lib/__tests__/pinning.test.ts` and `mobile/lib/__tests__/apiClient.test.ts`
cover:

- Host / pin normalization and parsing (including invalid-pin rejection).
- `validatePins` — **mismatch rejection** (`PIN_MISMATCH`) and unconfigured
  hosts (`HOST_NOT_PINNED`).
- Dev allowlist: localhost, explicit allowlist, `bypass`, dev-only bypass.
- Rotation: grace pins, `confirmRotation`, expiry, `purgeExpiredGrace`.
- Remote updates: signature verification, tamper rejection, replay/staleness.
- **SHA-256 (NIST vectors)** and **HMAC-SHA256 (RFC 4231 vectors)** correctness.
- `assertPinningAllowed` fail-closed behavior in production with no verifier.

Run them with:

```bash
cd mobile && npm test
```
