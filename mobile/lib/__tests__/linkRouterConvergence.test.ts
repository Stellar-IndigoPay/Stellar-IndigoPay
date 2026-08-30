/**
 * lib/__tests__/linkRouterConvergence.test.ts
 *
 * Proves the actual point of #906: every inbound-navigation surface goes
 * through `lib/linkRouter.ts`'s shared parse/validate pipeline instead of
 * re-implementing its own ad hoc rules. Two complementary techniques:
 *
 *  1. Spy-based: for surfaces that call `parseLink`/`resolveRoute`
 *     directly (universal links, the custom scheme, notifications,
 *     clipboard), assert the shared function is actually invoked with the
 *     surface's raw input.
 *  2. Source-import assertions: for surfaces that reuse the router's
 *     exported regex/validator constants rather than calling parseLink()
 *     directly (QR — which must keep its own `ParsedQR` return shape for
 *     existing callers like app/scan.tsx and scanHistory), assert the
 *     adapter file imports its patterns from "../lib/linkRouter" and does
 *     NOT define an independent copy of them — so there is exactly one
 *     place the rules can drift from.
 */
import * as fs from "fs";
import * as path from "path";
import { renderHook, act } from "@testing-library/react-native";
import * as Clipboard from "expo-clipboard";
import * as linkRouter from "../linkRouter";
import { useDeepLink } from "../../hooks/useDeepLink";
import { parseDeepLinkUrl } from "../../utils/notifications";
import { checkClipboardForLink, resetClipboardLinkMemory } from "../../utils/clipboardLink";

const mockPush = jest.fn();
const mockGetInitialURL = jest.fn<Promise<string | null>, []>(() => Promise.resolve(null));

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));
jest.mock("expo-linking", () => ({
  getInitialURL: () => mockGetInitialURL(),
  addEventListener: () => ({ remove: jest.fn() }),
}));
jest.mock("expo-clipboard", () => ({
  hasStringAsync: jest.fn(),
  getStringAsync: jest.fn(),
}));

const parseLinkSpy = jest.spyOn(linkRouter, "parseLink");

beforeEach(() => {
  parseLinkSpy.mockClear();
  mockPush.mockClear();
  mockGetInitialURL.mockReset().mockResolvedValue(null);
  resetClipboardLinkMemory();
});

afterAll(() => {
  parseLinkSpy.mockRestore();
});

// ── Spy-based convergence ────────────────────────────────────────────────

describe("convergence: every programmatic surface calls parseLink()", () => {
  test("hooks/useDeepLink.ts calls parseLink for the custom scheme", async () => {
    mockGetInitialURL.mockResolvedValueOnce("indigopay://project/proj-1");
    const { unmount } = renderHook(() => useDeepLink());
    await act(async () => {});

    expect(parseLinkSpy).toHaveBeenCalledWith(
      "indigopay://project/proj-1",
      "custom_scheme",
    );
    unmount();
  });

  test("hooks/useDeepLink.ts calls parseLink with the 'universal_link' surface for https urls", async () => {
    mockGetInitialURL.mockResolvedValueOnce(
      "https://indigopay.example.com/project/proj-1",
    );
    const { unmount } = renderHook(() => useDeepLink());
    await act(async () => {});

    expect(parseLinkSpy).toHaveBeenCalledWith(
      "https://indigopay.example.com/project/proj-1",
      "universal_link",
    );
    unmount();
  });

  test("utils/notifications.ts's parseDeepLinkUrl calls parseLink with the 'notification' surface", () => {
    parseDeepLinkUrl("indigopay://project/proj-1");
    expect(parseLinkSpy).toHaveBeenCalledWith(
      "indigopay://project/proj-1",
      "notification",
    );
  });

  test("utils/clipboardLink.ts's checkClipboardForLink calls parseLink with the 'clipboard' surface", async () => {
    (Clipboard.hasStringAsync as jest.Mock).mockResolvedValueOnce(true);
    (Clipboard.getStringAsync as jest.Mock).mockResolvedValueOnce(
      "stellar-indigopay://donate?projectId=proj-1",
    );

    await checkClipboardForLink();

    expect(parseLinkSpy).toHaveBeenCalledWith(
      "stellar-indigopay://donate?projectId=proj-1",
      "clipboard",
    );
  });
});

// ── Source-import convergence (no independently-defined rules) ──────────

const MOBILE_ROOT = path.resolve(__dirname, "../..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(MOBILE_ROOT, relativePath), "utf8");
}

describe("convergence: no surface defines its own copy of the shared patterns", () => {
  test("utils/qrParser.ts imports its regexes/validators from lib/linkRouter instead of redefining them", () => {
    const source = readSource("utils/qrParser.ts");
    expect(source).toMatch(/from ["']\.\.\/lib\/linkRouter["']/);

    for (const symbol of [
      "DEEP_LINK_RE",
      "LEGACY_DEEP_LINK_RE",
      "SEP0007_PAY_RE",
      "RAW_ADDRESS_RE",
      "EMBEDDED_ADDRESS_RE",
      "isValidEntityId",
      "hasDuplicateParam",
      "sanitizeAmountParam",
      "sanitizeMemoParam",
    ]) {
      expect(source).toMatch(new RegExp(`\\b${symbol}\\b`));
    }
    // No independent regex literal for the Stellar address shape — the
    // one true definition lives in utils/stellarValidation.ts /
    // lib/linkRouter.ts only.
    expect(source).not.toMatch(/\/\^G\[A-Z0-9\]/);
  });

  test("utils/qrParser.ts and lib/linkRouter.ts agree on every case in the shared malformed-input matrix", () => {
    const qrParser = require("../../utils/qrParser");
    // qrParser doesn't re-export the regexes, so this proves convergence
    // behaviorally instead: feeding both modules the exact same input
    // must produce the same accept/reject verdict for every case below.
    const cases: Array<{ input: string; expectValid: boolean }> = [
      { input: "stellar-indigopay://donate?projectId=proj-1", expectValid: true },
      { input: "stellar-indigopay://donate?projectId=proj-1&projectId=proj-2", expectValid: false },
      { input: "indigopay://donate?wallet=not-an-address&project=proj-1", expectValid: false },
      { input: `web+stellar:pay?destination=G${"A".repeat(55)}`, expectValid: true },
      { input: "web+stellar:pay?destination=not-an-address", expectValid: false },
      { input: `G${"A".repeat(55)}`, expectValid: true },
      { input: "just some random text", expectValid: false },
    ];

    for (const { input, expectValid } of cases) {
      const qrResult = qrParser.parseQRData(input);
      const routerResult = linkRouter.parseLink(input, "qr");
      expect(qrResult.type !== "unknown").toBe(expectValid);
      expect(routerResult.status === "valid").toBe(expectValid);
    }
  });

  test("hooks/useDeepLink.ts contains no independently defined scheme/host allowlist", () => {
    const source = readSource("hooks/useDeepLink.ts");
    expect(source).toMatch(/from ["']\.\.\/lib\/linkRouter["']/);
    expect(source).not.toMatch(/ALLOWED_SCHEMES\s*=/);
    expect(source).not.toMatch(/ALLOWED_UNIVERSAL_HOSTS\s*=/);
  });

  test("utils/notifications.ts contains no independently defined deep-link parsing", () => {
    const source = readSource("utils/notifications.ts");
    expect(source).toMatch(/from ["']\.\.\/lib\/linkRouter["']/);
    // The old ad hoc implementation split `path.replace(...).split("/")`
    // itself — that pattern must be gone now that parseDeepLinkUrl
    // delegates to the router.
    expect(source).not.toMatch(/path\.replace\(\/\^\\\/\/,\s*""\)\.split\("\/"\)/);
  });

  test("utils/clipboardLink.ts contains no independently defined link parsing", () => {
    const source = readSource("utils/clipboardLink.ts");
    expect(source).toMatch(/from ["']\.\.\/lib\/linkRouter["']/);
    expect(source).toMatch(/\bparseLink\(/);
  });
});
