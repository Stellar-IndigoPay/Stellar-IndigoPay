/**
 * __tests__/utils/failureClassifier.test.ts
 *
 * Unit tests for the offline donation failure classifier.
 */
import { classifyFailure, isDuplicateResponse } from "../../utils/failureClassifier";

describe("classifyFailure", () => {
  test("PROJECT_NOT_FOUND is permanent", () => {
    const r = classifyFailure({
      response: {
        status: 404,
        data: { error: { code: "PROJECT_NOT_FOUND", message: "nope" } },
      },
    });
    expect(r.retryable).toBe(false);
    expect(r.errorCode).toBe("PROJECT_NOT_FOUND");
  });

  test("TX_FAILED (insufficient balance / on-chain) is permanent", () => {
    const r = classifyFailure({
      response: { status: 400, data: { error: { code: "TX_FAILED" } } },
    });
    expect(r.retryable).toBe(false);
  });

  test("VALIDATION_ERROR is permanent", () => {
    const r = classifyFailure({
      response: { status: 422, data: { error: { code: "SCHEMA_VALIDATION_ERROR" } } },
    });
    expect(r.retryable).toBe(false);
  });

  test("503 / 502 / 504 are retryable", () => {
    for (const status of [502, 503, 504]) {
      const r = classifyFailure({ response: { status } });
      expect(r.retryable).toBe(true);
    }
  });

  test("429 (rate limited) is retryable", () => {
    const r = classifyFailure({ response: { status: 429 } });
    expect(r.retryable).toBe(true);
  });

  test("network error with no response is retryable", () => {
    const r = classifyFailure({ message: "Network Error", code: "ECONNABORTED" });
    expect(r.retryable).toBe(true);
  });

  test("timeout is retryable", () => {
    const r = classifyFailure({ message: "timeout of 15000ms exceeded" });
    expect(r.retryable).toBe(true);
  });

  test("unknown 4xx is permanent (avoid infinite retries)", () => {
    const r = classifyFailure({ response: { status: 418 } });
    expect(r.retryable).toBe(false);
  });

  test("unrecognised error with response defaults to permanent", () => {
    const r = classifyFailure({ response: { status: 500 } });
    // 5xx other than 502/503/504 → permanent to be safe
    expect(r.retryable).toBe(false);
  });
});

describe("isDuplicateResponse", () => {
  test("detects explicit duplicate flag", () => {
    expect(isDuplicateResponse({ data: { duplicate: true } })).toBe(true);
  });

  test("treats HTTP 200 as duplicate (idempotent replay)", () => {
    expect(isDuplicateResponse({ status: 200, data: {} })).toBe(true);
  });

  test("201 is not a duplicate", () => {
    expect(isDuplicateResponse({ status: 201, data: {} })).toBe(false);
  });
});
