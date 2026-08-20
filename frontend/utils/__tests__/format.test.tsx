/**
 * utils/__tests__/format.test.tsx
 * Unit + hydration-determinism tests for the pinned locale/timezone
 * formatting helpers (issue #652).
 *
 * The helpers must render identical output on the server and the client even
 * when the two environments resolve different default locales/timezones.
 */
import React from "react";
import type { ReactElement } from "react";
import { execFileSync } from "child_process";
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from "util";

// react-dom/server's browser build references TextEncoder/TextDecoder at
// module scope, but jest-environment-jsdom does not expose them. Polyfill
// before requiring the module (a static import would evaluate too early).
// The node:util implementations are structurally compatible; the cast bridges
// the lib.dom vs node typings.
if (typeof globalThis.TextEncoder === "undefined") {
  globalThis.TextEncoder = NodeTextEncoder as unknown as typeof TextEncoder;
}
if (typeof globalThis.TextDecoder === "undefined") {
  globalThis.TextDecoder = NodeTextDecoder as unknown as typeof TextDecoder;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderToString } = require("react-dom/server") as typeof import("react-dom/server");

import {
  PINNED_LOCALE,
  PINNED_TIME_ZONE,
  formatDate,
  formatDateTime,
  formatMonthYear,
  formatNumber,
  formatTime,
} from "../format";

describe("pinned formatting helpers", () => {
  test("formatNumber defaults to the pinned locale", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(
      formatNumber(1234567.891, "en-US", { maximumFractionDigits: 2 })
    ).toBe("1,234,567.89");
    expect(formatNumber(1234567, "fr").replace(/\s/g, " ")).toMatch(
      /1 234 567|1234567/
    );
  });

  test("formatDate renders a deterministic short date", () => {
    expect(formatDate("2026-08-15T12:00:00Z")).toBe("Aug 15, 2026");
  });

  test("formatDate respects an explicit timezone at the day boundary", () => {
    // 02:30 UTC on Aug 15 is 22:30 on Aug 14 in New York.
    expect(formatDate("2026-08-15T02:30:00Z", "en-US", "UTC")).toBe(
      "Aug 15, 2026"
    );
    expect(
      formatDate("2026-08-15T02:30:00Z", "en-US", "America/New_York")
    ).toBe("Aug 14, 2026");
  });

  test("formatDate falls back to the input on invalid dates", () => {
    expect(formatDate("not-a-date")).toBe("not-a-date");
  });

  test("formatDateTime renders date + time", () => {
    expect(formatDateTime("2026-08-15T02:30:00Z")).toBe(
      "Aug 15, 2026, 2:30 AM"
    );
  });

  test("formatTime renders time only", () => {
    expect(formatTime("2026-08-15T02:30:00Z")).toBe("2:30 AM");
  });

  test("formatMonthYear renders month + year", () => {
    expect(formatMonthYear(new Date(Date.UTC(2026, 7, 1)))).toBe("August 2026");
  });

  test("pinned constants are explicit", () => {
    expect(PINNED_LOCALE).toBe("en-US");
    expect(PINNED_TIME_ZONE).toBe("UTC");
  });
});

describe("hydration determinism", () => {
  // 02:30 UTC on Aug 15 is 22:30 on Aug 14 in New York — a day boundary, so
  // any environment-resolved timezone would shift the rendered date.
  const ISO = "2026-08-15T02:30:00Z";

  function PinnedComponent() {
    return (
      <div>
        <span>{formatDate(ISO)}</span>
        <span>{formatDateTime(ISO)}</span>
        <span>{formatTime(ISO)}</span>
        <span>{formatNumber(1234567.89)}</span>
      </div>
    );
  }

  test("pinned defaults equal explicit pinned args (environment-independent)", () => {
    expect(formatDate(ISO)).toBe(formatDate(ISO, "en-US", "UTC"));
    expect(formatDateTime(ISO)).toBe(formatDateTime(ISO, "en-US", "UTC"));
    expect(formatTime(ISO)).toBe(formatTime(ISO, "en-US", "UTC"));
    expect(formatNumber(1234567.89)).toBe(formatNumber(1234567.89, "en-US"));
  });

  test("a New York process renders the same UTC-pinned output as the helper", () => {
    // Spawn a fresh Node process with a browser-like timezone. Node's ICU
    // caches the default timezone per process, so this is the only reliable
    // way to simulate a client whose environment resolves differently from
    // the server's.
    const script = `
      const iso = "2026-08-15T02:30:00Z";
      const bare = new Date(iso).toLocaleDateString("en-US");
      const pinned = new Intl.DateTimeFormat("en-US", {
        month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
      }).format(new Date(iso));
      console.log(JSON.stringify({ bare, pinned }));
    `;
    const out = execFileSync(process.execPath, ["-e", script], {
      env: { ...process.env, TZ: "America/New_York" },
      encoding: "utf8",
    });
    const { bare, pinned } = JSON.parse(out) as {
      bare: string;
      pinned: string;
    };
    // In an environment resolving America/New_York, the raw API shows the
    // previous day — the source of the server/client hydration mismatch.
    expect(bare).toBe("8/14/2026");
    // The pinned output stays on the UTC calendar day — identical to our helper.
    expect(pinned).toBe("Aug 15, 2026");
    expect(formatDate(ISO)).toBe(pinned);
  });

  test("server render is deterministic under a fixed locale", () => {
    const html = renderToString(<PinnedComponent />);
    expect(html).toContain("Aug 15, 2026");
    expect(html).toContain("Aug 15, 2026, 2:30 AM");
    expect(html).toContain("2:30 AM");
    expect(html).toContain("1,234,567.89");
  });
});