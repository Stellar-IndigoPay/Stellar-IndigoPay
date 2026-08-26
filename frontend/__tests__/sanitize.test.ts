/**
 * __tests__/sanitize.test.ts
 *
 * Workstream 3 — XSS defense-in-depth.  Proves that user-generated content
 * (project updates, donation messages, profile bios, verification notes)
 * cannot execute in other donors' browsers: <script> is stripped, event
 * handlers are removed, and javascript:/data: URL schemes are dropped.
 *
 * @jest-environment jsdom
 */
import { sanitizeHtml, sanitizeUrl, safeHref, escapeHtml } from "@/lib/sanitize";

describe("sanitizeHtml — stored-XSS defense", () => {
  it("strips <script> tags entirely", () => {
    expect(sanitizeHtml("<script>alert(1)</script>Hello")).toBe("Hello");
  });

  it("strips <iframe> and <object> embeds", () => {
    expect(sanitizeHtml('<iframe src="https://evil.example"></iframe>ok')).toBe(
      "ok",
    );
    expect(
      sanitizeHtml('<object data="https://evil.example"></object>ok'),
    ).toBe("ok");
  });

  it("removes on* event handler attributes", () => {
    expect(sanitizeHtml('<p onmouseover="alert(1)">hi</p>')).toBe("<p>hi</p>");
    expect(
      sanitizeHtml('<img src="x" onerror="alert(1)">'),
    ).not.toContain("onerror");
  });

  it("strips javascript: URLs from href attributes", () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript:");
    // The link text survives but the dangerous href is dropped.
    expect(out).toContain("click");
  });

  it("keeps safe markdown-rendered HTML (links, bold, em)", () => {
    const out = sanitizeHtml(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a> <strong>bold</strong> <em>it</em>',
    );
    expect(out).toContain('<a href="https://example.com"');
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>it</em>");
  });

  it("neutralizes mixed payloads (script inside markdown link)", () => {
    const out = sanitizeHtml(
      '<a href="javascript:alert(1)">[click](javascript:alert(1))</a><script>alert(2)</script>',
    );
    // The executable href attribute is dropped (the markdown text inside the
    // anchor is inert content and may survive — that is fine).
    expect(out).not.toContain('href="javascript:');
    expect(out).not.toContain("<script");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeHtml("")).toBe("");
  });
});

describe("sanitizeUrl — dangerous scheme blocking", () => {
  it("allows https/http/mailto/tel/web+stellar", () => {
    expect(sanitizeUrl("https://example.com")).toBe("https://example.com");
    expect(sanitizeUrl("http://example.com")).toBe("http://example.com");
    expect(sanitizeUrl("mailto:dev@example.com")).toBe("mailto:dev@example.com");
    expect(sanitizeUrl("tel:+1234567")).toBe("tel:+1234567");
    expect(sanitizeUrl("web+stellar:pay?destination=GABC")).toBe(
      "web+stellar:pay?destination=GABC",
    );
  });

  it("blocks javascript:, data:, and vbscript: schemes", () => {
    expect(sanitizeUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeUrl("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(sanitizeUrl("vbscript:msgbox(1)")).toBeNull();
    // Mixed-case schemes are also blocked.
    expect(sanitizeUrl("JaVaScRiPt:alert(1)")).toBeNull();
  });

  it("allows relative and fragment URLs", () => {
    expect(sanitizeUrl("/projects/abc")).toBe("/projects/abc");
    expect(sanitizeUrl("#section")).toBe("#section");
  });

  it("normalizes a bare host to its https URL (never a relative path)", () => {
    // The fallback parser's normalized absolute URL (parsed.href) is
    // returned — a root bare host keeps the canonical trailing slash.
    expect(sanitizeUrl("example.com")).toBe("https://example.com/");
    expect(sanitizeUrl("example.com/docs")).toBe("https://example.com/docs");
  });

  it("returns null for empty/garbage input", () => {
    expect(sanitizeUrl("")).toBeNull();
    expect(sanitizeUrl("   ")).toBeNull();
    expect(sanitizeUrl("not a url at all with spaces")).toBeNull();
  });
});

describe("safeHref — React link convenience", () => {
  it("returns # for dangerous or missing URLs", () => {
    expect(safeHref("javascript:alert(1)")).toBe("#");
    expect(safeHref(null)).toBe("#");
    expect(safeHref(undefined)).toBe("#");
  });

  it("passes through safe URLs", () => {
    expect(safeHref("https://example.com/docs.pdf")).toBe(
      "https://example.com/docs.pdf",
    );
  });

  it("normalizes a bare host to its normalized HTTPS URL", () => {
    expect(safeHref("example.com")).toBe("https://example.com/");
    expect(safeHref("example.com/docs")).toBe("https://example.com/docs");
  });
});

describe("escapeHtml — plain-text interpolation (print report path)", () => {
  it("escapes characters that could become markup", () => {
    expect(escapeHtml("<img src=x onerror=alert(1)>")).toBe(
      "&lt;img src=x onerror=alert(1)&gt;",
    );
    expect(escapeHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(escapeHtml('He said "hi" & left <now>')).toBe(
      "He said &quot;hi&quot; &amp; left &lt;now&gt;",
    );
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("handles null, undefined, and empty input", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml("")).toBe("");
  });

  it("is idempotent-safe for already-safe text", () => {
    expect(escapeHtml("Amazon Reforestation")).toBe("Amazon Reforestation");
    // Double-escaping is avoided because raw & is always escaped on the way in.
    expect(escapeHtml(escapeHtml("<b>"))).toBe("&amp;lt;b&amp;gt;");
  });
});
