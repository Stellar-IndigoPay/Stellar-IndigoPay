/**
 * lib/__tests__/linkRouter.test.ts
 *
 * Unit tests for the single validated inbound-link pipeline (#906):
 * parseLink() format validation across every surface, resolveRoute()'s
 * anti-phishing canonical-data resolution, buildRoutePath(), and the
 * post-consent telemetry gate.
 */
import axios from "axios";
import {
  parseLink,
  resolveRoute,
  resolveCanonicalProject,
  routeLink,
  buildRoutePath,
  reportLinkRejection,
  isValidEntityId,
  isValidTxHash,
  hasDuplicateParam,
  MAX_INPUT_LENGTH,
  ALLOWED_UNIVERSAL_HOSTS,
  type RouteValid,
  type RouteRejected,
} from "../linkRouter";
import * as errorReporter from "../errorReporter";

const mockedAxiosGet = axios.get as jest.Mock;

beforeEach(() => {
  mockedAxiosGet.mockReset();
});

const PROJECT_A = {
  id: "proj-real-1",
  name: "Real Reforestation Fund",
  walletAddress: "G" + "A".repeat(55),
  status: "active",
};

// ── parseLink: malformed-input matrix ──────────────────────────────────

describe("parseLink — universal_link surface", () => {
  test("accepts an allowlisted host + project path", () => {
    const result = parseLink(
      "https://indigopay.example.com/project/proj-1",
      "universal_link",
    );
    expect(result).toEqual<RouteValid>({
      status: "valid",
      surface: "universal_link",
      raw: "https://indigopay.example.com/project/proj-1",
      target: { kind: "project", projectId: "proj-1", untrustedName: undefined },
    });
  });

  test("rejects a host not on the allowlist (phishing-lookalike domain)", () => {
    const result = parseLink(
      "https://indigopay-example.com.evil.tld/project/proj-1",
      "universal_link",
    );
    expect(result.status).toBe("rejected");
    expect((result as RouteRejected).reason).toBe("host_not_allowed");
  });

  test("host matching is case-insensitive (scheme/host case sensitivity)", () => {
    const result = parseLink(
      "https://INDIGOPAY.EXAMPLE.COM/project/proj-1",
      "universal_link",
    );
    expect(result.status).toBe("valid");
  });

  test("falls back (not rejects) for an allowlisted host with an unrecognised path — universal link fallback to custom scheme", () => {
    const result = parseLink(
      "https://indigopay.example.com/some/other/path",
      "universal_link",
    );
    expect(result.status).toBe("fallback");
  });

  test("rejects duplicate query params (request-smuggling guard)", () => {
    const result = parseLink(
      "https://indigopay.example.com/donate/proj-1?amount=5&amount=500",
      "universal_link",
    );
    expect(result.status).toBe("rejected");
    expect((result as RouteRejected).reason).toBe("duplicate_params");
  });

  test("URL-encoded path segments are decoded before id validation", () => {
    const result = parseLink(
      "https://indigopay.example.com/project/proj%2D1",
      "universal_link",
    );
    expect(result.status).toBe("valid");
    expect((result as RouteValid).target).toMatchObject({ projectId: "proj-1" });
  });

  test("rejects an invalid entity id shape even on an allowlisted host", () => {
    const result = parseLink(
      "https://indigopay.example.com/project/<script>",
      "universal_link",
    );
    expect(result.status).toBe("rejected");
    expect((result as RouteRejected).reason).toBe("invalid_entity_id");
  });

  test("never trusts an embedded name — it is carried only as untrustedName", () => {
    const result = parseLink(
      "https://indigopay.example.com/project/proj-1?name=TotallyLegitCharity",
      "universal_link",
    ) as RouteValid;
    expect(result.status).toBe("valid");
    expect(result.target).toMatchObject({
      projectId: "proj-1",
      untrustedName: "TotallyLegitCharity",
    });
    expect((result.target as any).canonicalName).toBeUndefined();
  });
});

describe("parseLink — custom_scheme surface", () => {
  test("accepts the preferred deep link with a project id", () => {
    const result = parseLink(
      "stellar-indigopay://donate?projectId=proj-1&amount=10&memo=hi",
      "custom_scheme",
    );
    expect(result.status).toBe("valid");
    expect((result as RouteValid).target).toMatchObject({
      kind: "donate",
      projectId: "proj-1",
      amount: "10",
      memo: "hi",
    });
  });

  test("accepts the legacy wallet+project deep link", () => {
    const result = parseLink(
      `indigopay://donate?wallet=${PROJECT_A.walletAddress}&project=proj-1`,
      "custom_scheme",
    );
    expect(result.status).toBe("valid");
    expect((result as RouteValid).target).toMatchObject({
      kind: "donate",
      address: PROJECT_A.walletAddress,
      projectId: "proj-1",
    });
  });

  test("rejects the legacy deep link when the wallet address is malformed", () => {
    const result = parseLink(
      "indigopay://donate?wallet=not-an-address&project=proj-1",
      "custom_scheme",
    );
    expect(result.status).toBe("rejected");
    expect((result as RouteRejected).reason).toBe("invalid_address");
  });

  test("rejects an unrecognised scheme outright", () => {
    const result = parseLink("evilscheme://donate?projectId=x", "custom_scheme");
    expect(result.status).toBe("rejected");
    expect((result as RouteRejected).reason).toBe("scheme_not_allowed");
  });

  test("scheme matching is case-insensitive", () => {
    const result = parseLink(
      "STELLAR-INDIGOPAY://donate?projectId=proj-1",
      "custom_scheme",
    );
    expect(result.status).toBe("valid");
  });

  test("rejects a donate query with neither projectId nor address", () => {
    const result = parseLink(
      "stellar-indigopay://donate?amount=10",
      "custom_scheme",
    );
    expect(result.status).toBe("rejected");
    expect((result as RouteRejected).reason).toBe("malformed");
  });

  test("silently drops a non-positive/garbage amount rather than rejecting the whole link", () => {
    const result = parseLink(
      "stellar-indigopay://donate?projectId=proj-1&amount=-5",
      "custom_scheme",
    ) as RouteValid;
    expect(result.status).toBe("valid");
    expect(result.target).toMatchObject({ amount: undefined });
  });

  test("truncates an oversized memo rather than rejecting", () => {
    const longMemo = "x".repeat(500);
    const result = parseLink(
      `stellar-indigopay://donate?projectId=proj-1&memo=${longMemo}`,
      "custom_scheme",
    ) as RouteValid;
    expect(result.status).toBe("valid");
    expect((result.target as any).memo.length).toBe(28);
  });
});

describe("parseLink — sep0007 payment URIs (any surface)", () => {
  test("accepts a well-formed web+stellar:pay URI", () => {
    const result = parseLink(
      `web+stellar:pay?destination=${PROJECT_A.walletAddress}&amount=25&memo_type=text&memo=hi`,
      "sep0007",
    );
    expect(result.status).toBe("valid");
    expect((result as RouteValid).target).toMatchObject({
      kind: "sep0007_pay",
      destination: PROJECT_A.walletAddress,
      amount: "25",
      memoType: "text",
    });
  });

  test("scheme is matched case-insensitively", () => {
    const result = parseLink(
      `Web+Stellar:pay?destination=${PROJECT_A.walletAddress}`,
      "sep0007",
    );
    expect(result.status).toBe("valid");
  });

  test("falls back (not rejects) for web+stellar:tx — owned by the wallet signer, not this router", () => {
    const result = parseLink("web+stellar:tx?xdr=AAAA", "sep0007");
    expect(result.status).toBe("fallback");
  });

  test("rejects a payment URI with an invalid destination", () => {
    const result = parseLink(
      "web+stellar:pay?destination=not-an-address",
      "sep0007",
    );
    expect(result.status).toBe("rejected");
    expect((result as RouteRejected).reason).toBe("invalid_address");
  });

  test("ignores an unsupported memo_type rather than rejecting", () => {
    const result = parseLink(
      `web+stellar:pay?destination=${PROJECT_A.walletAddress}&memo_type=nonsense`,
      "sep0007",
    ) as RouteValid;
    expect(result.status).toBe("valid");
    expect((result.target as any).memoType).toBeUndefined();
  });

  test("rejects duplicate destination params", () => {
    const result = parseLink(
      `web+stellar:pay?destination=${PROJECT_A.walletAddress}&destination=${PROJECT_A.walletAddress}`,
      "sep0007",
    );
    expect(result.status).toBe("rejected");
    expect((result as RouteRejected).reason).toBe("duplicate_params");
  });
});

describe("parseLink — qr and clipboard (free-text) surfaces", () => {
  test("accepts a bare Stellar address", () => {
    const result = parseLink(PROJECT_A.walletAddress, "qr");
    expect(result.status).toBe("valid");
    expect((result as RouteValid).target).toEqual({
      kind: "donate",
      address: PROJECT_A.walletAddress,
    });
  });

  test("accepts an address embedded in arbitrary surrounding text", () => {
    const result = parseLink(
      `Donate to us! ${PROJECT_A.walletAddress} Thanks!`,
      "clipboard",
    );
    expect(result.status).toBe("valid");
  });

  test("free-text address matching is NOT applied to programmatic surfaces", () => {
    // A notification payload containing a bare/embedded address must not
    // be treated as a donation target — only structured, allowlisted
    // schemes are trusted on programmatic surfaces.
    const result = parseLink(PROJECT_A.walletAddress, "notification");
    expect(result.status).toBe("fallback");
  });

  test("garbage input falls back safely", () => {
    const result = parseLink("not a link at all, just text", "qr");
    expect(result.status).toBe("fallback");
  });
});

describe("parseLink — universal edge cases", () => {
  test("rejects empty input", () => {
    expect(parseLink("", "clipboard").status).toBe("rejected");
    expect(parseLink("   ", "clipboard").status).toBe("rejected");
  });

  test("rejects non-string input without throwing", () => {
    expect(parseLink(null, "clipboard").status).toBe("rejected");
    expect(parseLink(undefined, "clipboard").status).toBe("rejected");
    expect(parseLink(12345, "clipboard").status).toBe("rejected");
  });

  test("rejects extremely long input before any regex touches it (DoS guard)", () => {
    const huge = "stellar-indigopay://donate?projectId=" + "a".repeat(MAX_INPUT_LENGTH * 5);
    const result = parseLink(huge, "clipboard");
    expect(result.status).toBe("rejected");
    expect((result as RouteRejected).reason).toBe("too_long");
    // The raw payload is never echoed back in full.
    expect(result.raw.length).toBeLessThan(100);
  });

  test("rejects malformed percent-encoding without throwing", () => {
    expect(() =>
      parseLink("https://indigopay.example.com/project/%E0%A4%A", "universal_link"),
    ).not.toThrow();
  });
});

// ── Shared validators exported for re-use by other surfaces ─────────────

describe("shared validator building blocks", () => {
  test("isValidEntityId enforces the strict bounded format", () => {
    expect(isValidEntityId("proj-1")).toBe(true);
    expect(isValidEntityId("a")).toBe(true);
    expect(isValidEntityId("A".repeat(64))).toBe(true);
    expect(isValidEntityId("A".repeat(65))).toBe(false); // too long
    expect(isValidEntityId("-leading-dash")).toBe(false);
    expect(isValidEntityId("has spaces")).toBe(false);
    expect(isValidEntityId("<script>")).toBe(false);
    expect(isValidEntityId("")).toBe(false);
    expect(isValidEntityId(42)).toBe(false);
  });

  test("isValidTxHash enforces 64 lowercase/uppercase hex chars", () => {
    expect(isValidTxHash("a".repeat(64))).toBe(true);
    expect(isValidTxHash("A".repeat(64))).toBe(true);
    expect(isValidTxHash("a".repeat(63))).toBe(false);
    expect(isValidTxHash("g".repeat(64))).toBe(false); // 'g' not hex
    expect(isValidTxHash(null)).toBe(false);
  });

  test("hasDuplicateParam only flags true duplicates", () => {
    const params = new URLSearchParams("a=1&a=2&b=3");
    expect(hasDuplicateParam(params, "a")).toBe(true);
    expect(hasDuplicateParam(params, "b")).toBe(false);
    expect(hasDuplicateParam(params, "c")).toBe(false);
  });
});

// ── resolveRoute / resolveCanonicalProject — anti-phishing guardrail ────

describe("resolveCanonicalProject", () => {
  test("resolves by project id from the live registry", async () => {
    // Id-based lookups hit the single-project endpoint (GET /api/projects/:id),
    // not the capped list endpoint — see the "resolves via the single-project
    // endpoint" test below for the URL assertion.
    mockedAxiosGet.mockResolvedValueOnce({ data: { data: PROJECT_A } });
    const project = await resolveCanonicalProject({ projectId: PROJECT_A.id });
    expect(project).toEqual(PROJECT_A);
  });

  test("uses the single-project endpoint, not the capped list, for id-based lookups", async () => {
    mockedAxiosGet.mockResolvedValueOnce({ data: { data: PROJECT_A } });
    await resolveCanonicalProject({ projectId: PROJECT_A.id });
    expect(mockedAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining(`/api/projects/${PROJECT_A.id}`),
    );
    expect(mockedAxiosGet).not.toHaveBeenCalledWith(
      expect.stringContaining("limit=100"),
    );
  });

  test("resolves by wallet address from the live registry", async () => {
    mockedAxiosGet.mockResolvedValueOnce({ data: { data: [PROJECT_A] } });
    const project = await resolveCanonicalProject({ address: PROJECT_A.walletAddress });
    expect(project).toEqual(PROJECT_A);
  });

  test("returns null (fails closed) when the registry lookup errors", async () => {
    mockedAxiosGet.mockRejectedValueOnce(new Error("network down"));
    const project = await resolveCanonicalProject({ projectId: "proj-1" });
    expect(project).toBeNull();
  });

  test("returns null when neither id nor address is given", async () => {
    const project = await resolveCanonicalProject({});
    expect(project).toBeNull();
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });
});

describe("resolveRoute — canonical-data rendering (anti-phishing)", () => {
  test("a link claiming project name X resolves to the server's real name, not X", async () => {
    mockedAxiosGet.mockResolvedValueOnce({ data: { data: PROJECT_A } });

    const parsed = parseLink(
      `https://indigopay.example.com/project/${PROJECT_A.id}?name=TotallyLegitCharityScam`,
      "universal_link",
    );
    const resolved = (await resolveRoute(parsed)) as RouteValid;

    expect(resolved.status).toBe("valid");
    expect((resolved.target as any).canonicalName).toBe(PROJECT_A.name);
    expect((resolved.target as any).canonicalName).not.toBe(
      "TotallyLegitCharityScam",
    );
    // The attacker-controlled name is retained only for diagnostics, never
    // presented as the canonical one.
    expect((resolved.target as any).untrustedName).toBe("TotallyLegitCharityScam");
  });

  test("downgrades to entity_not_found when the project no longer exists", async () => {
    mockedAxiosGet.mockResolvedValueOnce({ data: { data: null } });
    const parsed = parseLink(
      "https://indigopay.example.com/project/deleted-project",
      "universal_link",
    );
    const resolved = await resolveRoute(parsed);
    expect(resolved.status).toBe("rejected");
    expect((resolved as RouteRejected).reason).toBe("entity_not_found");
  });

  test("downgrades to entity_inactive for a paused/inactive project", async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: { data: { ...PROJECT_A, status: "paused" } },
    });
    const parsed = parseLink(
      `https://indigopay.example.com/project/${PROJECT_A.id}`,
      "universal_link",
    );
    const resolved = await resolveRoute(parsed);
    expect(resolved.status).toBe("rejected");
    expect((resolved as RouteRejected).reason).toBe("entity_inactive");
  });

  test("passes through rejected/fallback results unchanged (no network call)", async () => {
    const rejected = parseLink("evilscheme://x", "custom_scheme");
    const resolved = await resolveRoute(rejected);
    expect(resolved).toBe(rejected);
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  test("sep0007_pay targets pass through unchanged — arbitrary external accounts by design", async () => {
    const parsed = parseLink(
      `web+stellar:pay?destination=${PROJECT_A.walletAddress}`,
      "sep0007",
    );
    const resolved = await resolveRoute(parsed);
    expect(resolved).toBe(parsed);
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  test("routeLink() = parseLink() + resolveRoute() in one call", async () => {
    mockedAxiosGet.mockResolvedValueOnce({ data: { data: PROJECT_A } });
    const result = (await routeLink(
      `https://indigopay.example.com/project/${PROJECT_A.id}`,
      "universal_link",
    )) as RouteValid;
    expect(result.status).toBe("valid");
    expect((result.target as any).canonicalName).toBe(PROJECT_A.name);
  });
});

// ── buildRoutePath ───────────────────────────────────────────────────────

describe("buildRoutePath", () => {
  test("builds a project path", () => {
    expect(buildRoutePath({ kind: "project", projectId: "proj-1" })).toBe(
      "/project/proj-1",
    );
  });

  test("builds a donate path with amount/memo query params", () => {
    expect(
      buildRoutePath({
        kind: "donate",
        projectId: "proj-1",
        amount: "10",
        memo: "hi there",
      }),
    ).toBe("/donate/proj-1?amount=10&memo=hi+there");
  });

  test("builds a donate path by address when no projectId is present", () => {
    expect(buildRoutePath({ kind: "donate", address: PROJECT_A.walletAddress })).toBe(
      `/donate/${encodeURIComponent(PROJECT_A.walletAddress)}`,
    );
  });

  test("builds a profile path", () => {
    expect(buildRoutePath({ kind: "profile", address: PROJECT_A.walletAddress })).toBe(
      `/profile/${encodeURIComponent(PROJECT_A.walletAddress)}`,
    );
  });

  test("builds a sep0007 hand-off path", () => {
    const path = buildRoutePath({
      kind: "sep0007_pay",
      destination: PROJECT_A.walletAddress,
      amount: "5",
    });
    expect(path).toContain("/sep0007?uri=");
    expect(decodeURIComponent(path)).toContain(`destination=${PROJECT_A.walletAddress}`);
  });
});

// ── reportLinkRejection — strictly post-consent telemetry ────────────────

describe("reportLinkRejection", () => {
  test("no-ops when consent is false — never fires automatically", async () => {
    const spy = jest.spyOn(errorReporter, "captureException");
    const rejected = parseLink("evilscheme://x", "clipboard") as RouteRejected;
    await reportLinkRejection(rejected, false);
    expect(spy).not.toHaveBeenCalled();
  });

  test("reports a capped preview of the raw payload when consent is true", async () => {
    const spy = jest
      .spyOn(errorReporter, "captureException")
      .mockResolvedValueOnce(true);
    const rejected = parseLink("evilscheme://" + "x".repeat(200), "clipboard") as RouteRejected;
    await reportLinkRejection(rejected, true);
    expect(spy).toHaveBeenCalledTimes(1);
    const [, context] = spy.mock.calls[0];
    expect((context as any).rawPreview.length).toBeLessThanOrEqual(64);
    expect((context as any).surface).toBe("clipboard");
  });

  test("never throws even if the reporter itself fails", async () => {
    jest.spyOn(errorReporter, "captureException").mockRejectedValueOnce(new Error("boom"));
    const rejected = parseLink("evilscheme://x", "clipboard") as RouteRejected;
    await expect(reportLinkRejection(rejected, true)).resolves.toBeUndefined();
  });
});

test("ALLOWED_UNIVERSAL_HOSTS mirrors app.json's associatedDomains/intentFilters host", () => {
  expect(ALLOWED_UNIVERSAL_HOSTS).toContain("indigopay.example.com");
});
