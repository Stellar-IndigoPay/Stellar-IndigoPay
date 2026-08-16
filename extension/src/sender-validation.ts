/**
 * extension/src/sender-validation.ts
 *
 * Sender validation for `chrome.runtime` message handlers (issue #697).
 *
 * Kept side-effect free so it can be unit-tested directly.
 */

/**
 * URL schemes whose extension pages are trusted to message the background.
 * Content scripts legitimately run on arbitrary pages (`<all_urls>`), so
 * their page origin is intentionally NOT allow-listed — the extension-id
 * check in `isTrustedSender` is the trust boundary for them.
 */
const EXTENSION_ORIGIN_SCHEMES = ["chrome-extension:", "moz-extension:"];

/**
 * Allow-list check for message senders.
 *
 * Only the extension's own code may drive the background service worker:
 *  - `sender.id` must be this extension's id. It is only set when the
 *    connection was opened by an extension (content script or extension
 *    page) — web pages never carry it, and other extensions carry a
 *    different id.
 *  - Extension pages (popup/options) must additionally come from the
 *    extension's own origin (`chrome-extension://` or `moz-extension://`).
 *
 * Returns `true` for trusted senders, `false` for unknown origins.
 */
export function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  // Reject web pages and other extensions before any handler runs.
  if (sender.id !== chrome.runtime.id) return false;

  // Content scripts run on arbitrary pages by design (<all_urls>); the
  // extension-id check above is the trust boundary for them.
  if (sender.tab) return true;

  // Extension pages must originate from the extension's own origin.
  if (!sender.url) return false;
  const url = sender.url;
  return EXTENSION_ORIGIN_SCHEMES.some((scheme) =>
    url.startsWith(`${scheme}//${chrome.runtime.id}`),
  );
}
