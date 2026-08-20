# Storage & Wallet-Key Security Audit

Resolves #656 - Harden secret/wallet-key handling in `chrome.storage`

## Summary

**Finding: this extension never stores a private key, seed phrase, or any
other wallet secret.** All transaction signing is delegated to the
Freighter browser extension via `window.freighter.signTransaction()` and
`window.freighter.getPublicKey()`. This codebase only ever handles
**public** Stellar addresses (`G...`), which are not sensitive.

## What is persisted, and where

| Storage area | Key | Contents | Sensitivity |
|---|---|---|---|
| `chrome.storage.local` | `pendingDonationAddress` | Public Stellar address (`G...`) | Not sensitive |
| `chrome.storage.local` | `pendingDonationProjectId` | Public project ID | Not sensitive |
| `chrome.storage.local` | `totalDonatedXLM` | Numeric total | Not sensitive |
| `chrome.storage.sync` | `backendUrl`, `network`, `defaultDonationAmount` | User config | Not sensitive |

No `chrome.storage.*` call anywhere in `extension/src` writes a private key,
secret key, seed phrase, or mnemonic. `chrome.storage.sync` (which syncs to
the cloud) is used only for non-sensitive settings, which is an acceptable
use of `sync`.

## Wallet architecture

Signing happens entirely inside the separate Freighter extension:

- `popup.ts` calls `signWithFreighter(xdr)`, which uses `window.freighter.signTransaction(...)`
- `settings.ts` calls `getWalletPublicKey()`, which uses `window.freighter.getPublicKey()`
- This extension never requests, receives, or handles a raw secret key.

## Ongoing enforcement

`extension/scripts/scan-storage-secrets.js` runs in CI (`.github/workflows/extension.yml`)
on every PR touching `extension/**`. It fails the build if:

- A Stellar secret key pattern (`S` + 55 base32 chars) is hardcoded anywhere in `extension/src`.
- Any object key shaped like `privateKey`, `secretKey`, `seedPhrase`, or `mnemonic`
  appears in the source (a strong signal someone is about to store one).

This keeps the "no plaintext secrets" guarantee true going forward, not just
as of this audit.

## If this ever changes

If a future feature needs to handle a secret key directly (e.g. an in-extension
signer that doesn't rely on Freighter), it **must not** use
`chrome.storage.sync` and **must not** persist the raw key in
`chrome.storage.local` in plaintext. Encrypt at rest with a key derived from
a user-supplied passphrase (e.g. via WebCrypto PBKDF2/AES-GCM), and update
this document and the scanner accordingly.