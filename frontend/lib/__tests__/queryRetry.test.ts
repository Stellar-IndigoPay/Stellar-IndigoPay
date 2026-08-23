/**
 * lib/__tests__/queryRetry.test.ts
 *
 * Unit tests for the React Query retry policy. Verifies that retryable
 * failures (network / 429 / 5xx) are retried up to 3 attempts and that 4xx
 * client errors are never retried.
 */
import { queryRetryPolicy } from "@/lib/queryRetry";

describe("queryRetryPolicy", () => {
  it("never retries a 404", () => {
    const error = { response: { status: 404 } };
    expect(queryRetryPolicy(0, error)).toBe(false);
    expect(queryRetryPolicy(1, error)).toBe(false);
  });

  it("never retries other 4xx errors (403, 422)", () => {
    expect(queryRetryPolicy(0, { response: { status: 403 } })).toBe(false);
    expect(queryRetryPolicy(0, { response: { status: 422 } })).toBe(false);
  });

  it("retries a 429 up to 3 attempts then stops", () => {
    const error = { response: { status: 429 } };
    expect(queryRetryPolicy(0, error)).toBe(true);
    expect(queryRetryPolicy(1, error)).toBe(true);
    expect(queryRetryPolicy(2, error)).toBe(true);
    expect(queryRetryPolicy(3, error)).toBe(false);
  });

  it("retries 5xx errors up to 3 attempts then stops", () => {
    const error = { response: { status: 503 } };
    expect(queryRetryPolicy(0, error)).toBe(true);
    expect(queryRetryPolicy(1, error)).toBe(true);
    expect(queryRetryPolicy(2, error)).toBe(true);
    expect(queryRetryPolicy(3, error)).toBe(false);
  });

  it("retries network errors up to 3 attempts then stops", () => {
    const error = { code: "ERR_NETWORK" };
    expect(queryRetryPolicy(0, error)).toBe(true);
    expect(queryRetryPolicy(1, error)).toBe(true);
    expect(queryRetryPolicy(2, error)).toBe(true);
    expect(queryRetryPolicy(3, error)).toBe(false);
  });
});
