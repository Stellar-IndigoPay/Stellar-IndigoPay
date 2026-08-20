/**
 * utils/clipboardLink.ts
 * Clipboard-pasted content as an inbound navigation surface (#906).
 *
 * When the app comes to the foreground, checks the current clipboard
 * contents for a recognised IndigoPay/Stellar link so the user can be
 * offered a "paste to donate/navigate" shortcut. Clipboard text is exactly
 * the kind of untrusted, free-form input `lib/linkRouter.ts` exists to
 * validate — this module never parses or matches the payload itself, it
 * only calls into the shared `parseLink()` pipeline.
 *
 * To avoid re-prompting for the same clipboard content on every foreground
 * event, the last-seen (hashed) clipboard value is remembered in memory for
 * the lifetime of the app process.
 */
import * as Clipboard from "expo-clipboard";
import { parseLink, RouteResult } from "../lib/linkRouter";

let lastCheckedText: string | null = null;

/**
 * Read the clipboard and, if it contains a *new* valid link, return the
 * parsed (format-validated) result. Returns null when the clipboard is
 * empty, unreadable, unchanged since the last check, or doesn't contain a
 * recognised link — callers should treat null as "nothing to suggest".
 *
 * Format-valid only: callers that want to display any project name must
 * still resolve canonical data (see `resolveRoute` in lib/linkRouter.ts)
 * before rendering it — never the payload's own embedded name.
 */
export async function checkClipboardForLink(): Promise<RouteResult | null> {
  let text: string;
  try {
    const hasString = await Clipboard.hasStringAsync();
    if (!hasString) {
      lastCheckedText = null;
      return null;
    }
    text = await Clipboard.getStringAsync();
  } catch {
    // Clipboard access can fail (permissions, platform quirks) — treat as
    // "nothing to suggest" rather than surfacing an error to the user.
    return null;
  }

  if (!text || !text.trim()) {
    lastCheckedText = null;
    return null;
  }
  if (text === lastCheckedText) {
    // Already prompted for this exact value; don't nag on every foreground.
    return null;
  }
  lastCheckedText = text;

  const result = parseLink(text, "clipboard");
  return result.status === "valid" ? result : null;
}

/** Reset the "already prompted" memory — primarily for tests. */
export function resetClipboardLinkMemory(): void {
  lastCheckedText = null;
}
