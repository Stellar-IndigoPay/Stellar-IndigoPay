/**
 * lib/sanitize.ts — XSS defense-in-depth for user-generated content.
 *
 * The frontend renders several classes of user-supplied strings: project
 * descriptions and update bodies, donation messages, profile bios, and
 * verification notes.  React escapes text nodes by default, but any path
 * that intentionally emits HTML (markdown rendering, `dangerouslySetInnerHTML`)
 * must pass through DOMPurify first, and any href/src the user controls must
 * pass through `sanitizeUrl` so `javascript:`/`data:`/`vbscript:` schemes can
 * never become clickable XSS (issue #1096, Workstream 3).
 *
 * DOMPurify runs in jsdom in unit tests and in the browser at runtime, so it
 * works both under Jest and in production without a separate server-side
 * dependency.  The shared policy is deliberately conservative: no <script>,
 * no <iframe>, no event-handler attributes, no `javascript:` URLs.
 */
import DOMPurify from "dompurify";

/** Schemes that are safe to keep in user-controlled URLs. Everything else
 *  (javascript:, data:, vbscript:, file:) is treated as unsafe and dropped. */
const SAFE_URL_SCHEMES = ["http:", "https:", "mailto:", "tel:", "web+stellar:"];

const ALLOWED_TAGS = [
  "a",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "p",
  "br",
  "ul",
  "ol",
  "li",
  "blockquote",
  "code",
  "pre",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "span",
];

const ALLOWED_ATTR = ["href", "title", "target", "rel"];

/**
 * Sanitize an HTML string, stripping scripts, event handlers, and unsafe
 * URL schemes.  Returns an empty string when the input contains nothing
 * safe to keep.
 *
 * @param html - Raw HTML (e.g. output of a markdown renderer).
 * @returns Sanitized HTML safe for `dangerouslySetInnerHTML`.
 */
export function sanitizeHtml(html: string): string {
  if (!html) return "";
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|web\+stellar):|(?:\/|#))/i,
    // Never allow the sanitizer to keep a scheme the whitelist rejected.
    ALLOW_UNKNOWN_PROTOCOLS: false,
    // We render markdown ourselves and never allow raw <script>/<iframe>.
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "style", "svg", "math"],
  });
}

/**
 * Validate a URL string against the safe-scheme whitelist.  Returns the
 * original URL when it is safe, and `null` when it uses a dangerous scheme
 * (javascript:, data:, vbscript:) or is otherwise unusable.
 *
 * Relative URLs (/path, #hash) are allowed because they stay on our origin.
 *
 * @param url - User-supplied URL (project website, social link, document URL).
 * @returns The safe URL, or null to drop/replace the link.
 */
export function sanitizeUrl(url: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // Relative and fragment-only URLs are same-origin safe.
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) return trimmed;

  let parsed: URL;
  let wasBareHost = false;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Not parseable as an absolute URL — try treating it as a bare host
    // (e.g. "example.com" typed without a scheme) by normalizing it.
    wasBareHost = true;
    try {
      parsed = new URL(`https://${trimmed}`);
    } catch {
      return null;
    }
  }

  if (!SAFE_URL_SCHEMES.includes(parsed.protocol)) return null;

  // A bare host like "example.com" must be normalized to its https URL —
  // returning the raw string would make it a relative path on our origin.
  // `parsed.href` is the URL's normalized absolute form (scheme, host,
  // path, query, fragment), which is exactly what the fallback parser
  // resolved the input to.
  if (wasBareHost) {
    return parsed.href;
  }

  return trimmed;
}

/**
 * Convenience for React link props: returns a safe href or "#" when the
 * user-supplied URL is dangerous, so the anchor still renders but can never
 * execute code.
 */
export function safeHref(url: string | null | undefined): string {
  if (!url) return "#";
  return sanitizeUrl(url) ?? "#";
}

/**
 * Escape a plain-text string for safe interpolation inside an HTML
 * template.  Unlike `sanitizeHtml` (which keeps an allowlist of markup),
 * `escapeHtml` neutralizes every character that could become markup, so it
 * is the right tool for interpolating plain-text fields (names, locations,
 * categories, addresses) into a `document.write`-style HTML document.
 *
 * @param text - Plain-text user-supplied string.
 * @returns The text with `& < > " '` escaped, safe for HTML text/attr contexts.
 */
export function escapeHtml(text: string | null | undefined): string {
  return String(text ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}
