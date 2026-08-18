/**
 * lib/__tests__/queryErrors.test.ts
 *
 * Unit tests for the error classifier used by both the ErrorBoundary and the
 * inline QueryErrorFallback. Verifies that errors are bucketed by *structured*
 * information (HTTP status / network code) rather than string matching.
 */
import { classifyError } from "@/lib/queryErrors";

describe("classifyError", () => {
  it("classifies ERR_NETWORK as network", () => {
    const result = classifyError({ code: "ERR_NETWORK" });
    expect(result.kind).toBe("network");
    expect(result.retryable).toBe(true);
    expect(result.message).toMatch(/network error/i);
  });

  it("classifies a request with no response as network", () => {
    const result = classifyError({ request: {}, message: "timeout" });
    expect(result.kind).toBe("network");
  });

  it("classifies HTTP 429 as rate-limit", () => {
    const result = classifyError({ response: { status: 429 } });
    expect(result.kind).toBe("rate-limit");
    expect(result.status).toBe(429);
    expect(result.retryable).toBe(true);
    expect(result.message).toMatch(/too many requests/i);
  });

  it("classifies HTTP 5xx as server", () => {
    const result = classifyError({ response: { status: 503 } });
    expect(result.kind).toBe("server");
    expect(result.retryable).toBe(true);
    expect(result.message).toMatch(/server error/i);
  });

  it("classifies HTTP 4xx (non-429) as client and not retryable", () => {
    const result = classifyError({ response: { status: 404 } });
    expect(result.kind).toBe("client");
    expect(result.retryable).toBe(false);
  });

  it("falls back to unknown for plain errors", () => {
    const result = classifyError(new Error("unexpected"));
    expect(result.kind).toBe("unknown");
    expect(result.retryable).toBe(true);
  });

  it("falls back to unknown for null/undefined", () => {
    expect(classifyError(null).kind).toBe("unknown");
    expect(classifyError(undefined).kind).toBe("unknown");
  });
});
