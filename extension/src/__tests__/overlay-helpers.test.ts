/**
 * Tests for overlay-helpers.ts — pure utility functions.
 */
import { escapeHtml, truncateAddress, truncateText } from "../overlay-helpers";

describe("escapeHtml", () => {
  test("escapes all HTML special chars", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;",
    );
  });

  test("escapes ampersand", () => {
    expect(escapeHtml("A & B")).toBe("A &amp; B");
  });

  test("escapes double quotes", () => {
    expect(escapeHtml('He said "hello"')).toBe("He said &quot;hello&quot;");
  });

  test("escapes single quotes", () => {
    expect(escapeHtml("It's done")).toBe("It&#039;s done");
  });

  test("returns plain text unchanged", () => {
    expect(escapeHtml("Hello World")).toBe("Hello World");
  });

  test("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  test("escapes all special chars simultaneously", () => {
    expect(escapeHtml("<a href='foo' & \"bar\">")).toBe(
      "&lt;a href=&#039;foo&#039; &amp; &quot;bar&quot;&gt;",
    );
  });
});

describe("truncateAddress", () => {
  test("truncates long Stellar address", () => {
    const addr = "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG";
    expect(truncateAddress(addr)).toBe("GDFJEG…KKHG");
  });

  test("returns short string as-is", () => {
    expect(truncateAddress("short")).toBe("short");
  });

  test("returns exactly-12-char string as-is", () => {
    expect(truncateAddress("123456789012")).toBe("123456789012");
  });

  test("returns 13-char string truncated", () => {
    expect(truncateAddress("1234567890123")).toBe("123456…0123");
  });

  test("handles empty string", () => {
    expect(truncateAddress("")).toBe("");
  });
});

describe("truncateText", () => {
  test("truncates text longer than maxLen", () => {
    expect(truncateText("Hello World", 5)).toBe("Hello…");
  });

  test("returns text shorter than maxLen unchanged", () => {
    expect(truncateText("Hi", 10)).toBe("Hi");
  });

  test("returns text equal to maxLen unchanged", () => {
    expect(truncateText("Hello", 5)).toBe("Hello");
  });

  test("handles empty string", () => {
    expect(truncateText("", 5)).toBe("");
  });

  test("truncates multiline text", () => {
    expect(truncateText("line1\nline2\nline3", 10)).toBe("line1\nline…");
  });
});
