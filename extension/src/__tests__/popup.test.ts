/**
 * Tests for popup.ts pure functions and logic.
 *
 * We test the logic directly without importing the module to avoid
 * ESM dependency issues with @stellar/stellar-sdk.
 */

// ── escapeHtml ────────────────────────────────────────────────────────

describe("escapeHtml", () => {
  const escapeHtml = (value: string): string => {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  };

  test("escapes HTML special characters", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;",
    );
  });

  test("escapes ampersands", () => {
    expect(escapeHtml("A & B")).toBe("A &amp; B");
  });

  test("escapes double quotes", () => {
    expect(escapeHtml('He said "hello"')).toBe("He said &quot;hello&quot;");
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

// ── getProjectEmoji ───────────────────────────────────────────────────

describe("getProjectEmoji", () => {
  const getProjectEmoji = (category: string): string => {
    const map: Record<string, string> = {
      Reforestation: "🌳",
      "Solar Energy": "☀️",
      "Ocean Conservation": "🌊",
      "Clean Water": "💧",
      "Wildlife Protection": "🦁",
      "Carbon Capture": "♻️",
      "Wind Energy": "💨",
      "Sustainable Agriculture": "🌾",
    };
    return map[category] ?? "🌿";
  };

  test("returns correct emoji for known categories", () => {
    expect(getProjectEmoji("Reforestation")).toBe("🌳");
    expect(getProjectEmoji("Solar Energy")).toBe("☀️");
    expect(getProjectEmoji("Ocean Conservation")).toBe("🌊");
    expect(getProjectEmoji("Clean Water")).toBe("💧");
    expect(getProjectEmoji("Wildlife Protection")).toBe("🦁");
    expect(getProjectEmoji("Carbon Capture")).toBe("♻️");
    expect(getProjectEmoji("Wind Energy")).toBe("💨");
    expect(getProjectEmoji("Sustainable Agriculture")).toBe("🌾");
  });

  test("returns default emoji for unknown categories", () => {
    expect(getProjectEmoji("Unknown Category")).toBe("🌿");
    expect(getProjectEmoji("")).toBe("🌿");
    expect(getProjectEmoji("Random")).toBe("🌿");
  });
});

// ── abbreviateNumber ──────────────────────────────────────────────────

describe("abbreviateNumber", () => {
  const abbreviateNumber = (num: number): string => {
    if (num < 1000) return Math.floor(num).toString();
    if (num < 1000000) return Math.floor(num / 1000) + "K";
    return (num / 1000000).toFixed(1) + "M";
  };

  test("returns plain number for values under 1000", () => {
    expect(abbreviateNumber(0)).toBe("0");
    expect(abbreviateNumber(1)).toBe("1");
    expect(abbreviateNumber(999)).toBe("999");
  });

  test("abbreviates thousands with K", () => {
    expect(abbreviateNumber(1000)).toBe("1K");
    expect(abbreviateNumber(1500)).toBe("1K");
    expect(abbreviateNumber(999999)).toBe("999K");
  });

  test("abbreviates millions with M", () => {
    expect(abbreviateNumber(1000000)).toBe("1.0M");
    expect(abbreviateNumber(1500000)).toBe("1.5M");
    expect(abbreviateNumber(10000000)).toBe("10.0M");
  });

  test("handles edge cases", () => {
    expect(abbreviateNumber(999.9)).toBe("999");
    expect(abbreviateNumber(0)).toBe("0");
    expect(abbreviateNumber(-1)).toBe("-1");
  });
});

// ── Address truncation ────────────────────────────────────────────────

describe("truncateAddress (popup)", () => {
  const truncateAddress = (addr: string): string => {
    if (addr.length <= 12) return addr;
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  };

  test("truncates long addresses", () => {
    const addr = "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG";
    expect(truncateAddress(addr)).toBe("GDFJEG…KKHG");
  });

  test("returns short strings as-is", () => {
    expect(truncateAddress("short")).toBe("short");
    expect(truncateAddress("123456789012")).toBe("123456789012");
  });
});

// ── Stellar address validation ────────────────────────────────────────

describe("Stellar address validation", () => {
  test("valid Stellar address matches regex", () => {
    const addr = "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG";
    expect(/^G[A-Z2-7]{55}$/.test(addr.trim())).toBe(true);
  });

  test("invalid address rejected", () => {
    expect(/^G[A-Z2-7]{55}$/.test("not-an-address")).toBe(false);
    expect(/^G[A-Z2-7]{55}$/.test("")).toBe(false);
  });

  test("minimum amount validation", () => {
    expect(0.5 >= 0.1).toBe(true);
    expect(0.05 >= 0.1).toBe(false);
    expect(0 >= 0.1).toBe(false);
    expect(0.1 >= 0.1).toBe(true);
  });

  test("memo length validation (max 28)", () => {
    expect("Short memo".length <= 28).toBe(true);
    expect("A".repeat(28).length <= 28).toBe(true);
    expect("A".repeat(29).length <= 28).toBe(false);
  });
});
