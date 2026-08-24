# Extension permissions — least-privilege audit

This file documents every permission and host grant declared in
[`manifest.json`](./manifest.json) and [`manifest.firefox.json`](./manifest.firefox.json),
and maps each one to the code that consumes it. The set is kept minimal on
purpose: anything added here without a corresponding consumer is flagged by
`npm run check:permissions` (see `scripts/validate-permissions.js`).

## API permissions

| Permission     | Purpose                                                                              | Consumed by                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `storage`      | Persist the user's settings and pending donation state between sessions.             | `chrome.storage.sync` in `src/settings.ts`; `chrome.storage.local` in `src/background.ts` and `src/popup.ts`    |
| `contextMenus` | Add the right-click "Donate to this IndigoPay project" action and react to its click. | `chrome.contextMenus.create/update/onClicked` in `src/background.ts`                                            |

Removed (unused — no code references these APIs):

- `activeTab` — the content script already runs on `<all_urls>`, so no
  per-tab temporary host grant is required.
- `scripting` — no `chrome.scripting` / `browser.scripting` calls exist; the
  content script is declared statically via `content_scripts`.

## Host permissions

| Host pattern                        | Purpose                                                                 | Consumed by                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `https://api.stellar-indigopay.app/*` | Fetch project info, profiles, and submit donations from the IndigoPay API. | `fetch()` to the configured backend in `src/background.ts` and `src/popup.ts` (default `https://api.stellar-indigopay.app` in `src/settings.ts`) |

The Firefox manifest previously declared `host_permissions: ["<all_urls>"]`;
that grant was only needed for content-script injection, which is already
covered by `content_scripts.matches`, so it has been narrowed to the single
API host above.

## Content-script scope (not a "permission")

Both manifests declare `content_scripts` with `matches: ["<all_urls>"]`. This
is required so the companion can detect Stellar addresses (`G…`) on any page
and inject the donate button — the core feature of the extension. It is
unrelated to `host_permissions`, which only governs network access from the
background service worker and popup.
