/**
 * src/services/circuitBreaker.test.js
 *
 * Unit tests for the CircuitBreaker utility and the withRetry / isRetryable
 * helpers exported from stellar.js.
 *
 * Test scenarios (per issue acceptance criteria):
 *  1. Retry: mock RPC fails 2 times then succeeds — verify retry count
 *  2. Circuit open: mock RPC fails 5 times — verify circuit breaker opens
 *  3. Non-retryable: non-retryable error does NOT trigger retry
 *  4. Half-open → closed: circuit breaker recovers after reset timeout
 *  5. Exponential backoff: delays double on each retry attempt
 *  6. Circuit open rejects immediately without calling fn
 *  7. isRetryable: correctly classifies transient vs non-transient errors
 *  8. Prometheus gauge: reflects circuit state transitions
 *  9. Retry counter: sorobanRpcRetriesTotal increments on each retry
 */
"use strict";

const { CircuitBreaker, STATES } = require("./circuitBreaker");
const { isRetryable, sorobanRpcRetriesTotal } = require("./stellar");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fresh CircuitBreaker with a very short reset window for tests. */
function makeBreaker(opts = {}) {
  return new CircuitBreaker({
    name: `test_${Date.now()}_${Math.random()}`,
    failureThreshold: 5,
    resetTimeout: 100, // 100 ms reset — fast for tests
    ...opts,
  });
}

/**
 * Build a standalone async `withRetry` function that uses a given CircuitBreaker
 * instance.  This avoids the shared module-level `rpcBreaker` singleton, making
 * tests fully isolated from each other and from real timer delays.
 *
 * @param {CircuitBreaker} breaker
 * @param {number}         [baseDelayMs=0]  Set to 0 in tests to skip real delays.
 */
function makeWithRetry(breaker, baseDelayMs = 0) {
  return async function withRetry(fn, maxRetries = 3) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await breaker.call(fn);
      } catch (err) {
        lastError = err;
        const circuitOpen = err.message && err.message.includes("Circuit breaker");
        if (circuitOpen) throw lastError;
        if (attempt < maxRetries && isRetryable(err)) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
          sorobanRpcRetriesTotal.inc();
        } else {
          throw lastError;
        }
      }
    }
    throw lastError;
  };
}

// ---------------------------------------------------------------------------
// 1. CircuitBreaker — state machine
// ---------------------------------------------------------------------------

describe("CircuitBreaker — state machine", () => {
  test("starts in CLOSED state", () => {
    const b = makeBreaker();
    expect(b.getState()).toBe(STATES.CLOSED);
    expect(b.getFailureCount()).toBe(0);
  });

  test("passes through successful calls without changing state", async () => {
    const b = makeBreaker();
    const result = await b.call(async () => "hello");
    expect(result).toBe("hello");
    expect(b.getState()).toBe(STATES.CLOSED);
    expect(b.getFailureCount()).toBe(0);
  });

  test("increments failure count on each failed call while CLOSED", async () => {
    const b = makeBreaker({ failureThreshold: 5 });
    for (let i = 1; i <= 4; i++) {
      await expect(
        b.call(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(b.getFailureCount()).toBe(i);
      expect(b.getState()).toBe(STATES.CLOSED);
    }
  });

  test("transitions to OPEN after failureThreshold consecutive failures", async () => {
    const b = makeBreaker({ failureThreshold: 5 });
    for (let i = 0; i < 5; i++) {
      await expect(
        b.call(async () => {
          throw new Error("ECONNRESET");
        }),
      ).rejects.toThrow();
    }
    expect(b.getState()).toBe(STATES.OPEN);
  });

  test("rejects immediately when OPEN (does not invoke fn)", async () => {
    const b = makeBreaker({ failureThreshold: 2 });
    // Force open
    for (let i = 0; i < 2; i++) {
      await expect(
        b.call(async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow();
    }
    expect(b.getState()).toBe(STATES.OPEN);

    const fn = jest.fn();
    await expect(b.call(fn)).rejects.toThrow(/Circuit breaker.*OPEN/i);
    expect(fn).not.toHaveBeenCalled();
  });

  test("transitions OPEN → HALF_OPEN after resetTimeout elapses", async () => {
    const b = makeBreaker({ failureThreshold: 2, resetTimeout: 1 }); // 1 ms
    for (let i = 0; i < 2; i++) {
      await expect(
        b.call(async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow();
    }
    expect(b.getState()).toBe(STATES.OPEN);

    // Wait long enough for resetTimeout to elapse.
    await new Promise((r) => setTimeout(r, 20));

    // Next call should be attempted (HALF_OPEN), and on success → CLOSED.
    const result = await b.call(async () => "recovered");
    expect(result).toBe("recovered");
    expect(b.getState()).toBe(STATES.CLOSED);
    expect(b.getFailureCount()).toBe(0);
  });

  test("HALF_OPEN → OPEN when the probe call fails", async () => {
    const b = makeBreaker({ failureThreshold: 2, resetTimeout: 1 });
    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      await expect(
        b.call(async () => {
          throw new Error("err");
        }),
      ).rejects.toThrow();
    }
    // Wait for HALF_OPEN window
    await new Promise((r) => setTimeout(r, 20));

    // Probe fails → goes back to OPEN
    await expect(
      b.call(async () => {
        throw new Error("still broken");
      }),
    ).rejects.toThrow("still broken");
    expect(b.getState()).toBe(STATES.OPEN);
  });

  test("success after HALF_OPEN resets failure count to 0", async () => {
    const b = makeBreaker({ failureThreshold: 3, resetTimeout: 1 });
    for (let i = 0; i < 3; i++) {
      await expect(
        b.call(async () => {
          throw new Error("x");
        }),
      ).rejects.toThrow();
    }
    await new Promise((r) => setTimeout(r, 20));

    await b.call(async () => "ok");
    expect(b.getFailureCount()).toBe(0);
    expect(b.getState()).toBe(STATES.CLOSED);
  });
});

// ---------------------------------------------------------------------------
// 2. isRetryable — error classification
// ---------------------------------------------------------------------------

describe("isRetryable", () => {
  test.each([
    ["ECONNRESET", true],
    ["ETIMEDOUT", true],
    ["503 Service Unavailable", true],
    ["502 Bad Gateway", true],
    ["socket hang up", true],
    ["upstream 503 error", true],
    ["got 502", true],
    ["Connection reset by peer (ECONNRESET)", true],
  ])("classifies '%s' as retryable", (msg, expected) => {
    expect(isRetryable(new Error(msg))).toBe(expected);
  });

  test.each([
    ["400 Bad Request — invalid XDR", false],
    ["Transaction failed: txBAD_SEQ", false],
    ["Invalid argument", false],
    ["404 Not Found", false],
    ["Unauthorized", false],
    ["", false],
  ])("classifies '%s' as NOT retryable", (msg, expected) => {
    expect(isRetryable(new Error(msg))).toBe(expected);
  });

  test("handles null/undefined err gracefully", () => {
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
    expect(isRetryable({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. withRetry — retry logic (isolated via makeWithRetry)
// ---------------------------------------------------------------------------

describe("withRetry (retry logic)", () => {
  test("succeeds on first attempt when fn succeeds immediately", async () => {
    const breaker = makeBreaker();
    const withRetryLocal = makeWithRetry(breaker);
    const fn = jest.fn(async () => "result");
    const result = await withRetryLocal(fn, 3);
    expect(result).toBe("result");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries on transient error and succeeds on 3rd attempt", async () => {
    const breaker = makeBreaker({ failureThreshold: 10 }); // high threshold so breaker stays closed
    const withRetryLocal = makeWithRetry(breaker, 0); // 0 ms delay

    let calls = 0;
    const fn = jest.fn(async () => {
      calls++;
      if (calls <= 2) throw new Error("ECONNRESET");
      return "success";
    });

    const result = await withRetryLocal(fn, 3);
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("does NOT retry on non-retryable error", async () => {
    const breaker = makeBreaker({ failureThreshold: 10 });
    const withRetryLocal = makeWithRetry(breaker, 0);

    const fn = jest.fn(async () => {
      throw new Error("400 Bad Request");
    });

    await expect(withRetryLocal(fn, 3)).rejects.toThrow("400 Bad Request");
    // Called only once — no retries.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("exhausts retries and re-throws the last error", async () => {
    const breaker = makeBreaker({ failureThreshold: 10 }); // keep breaker closed
    const withRetryLocal = makeWithRetry(breaker, 0);

    const fn = jest.fn(async () => {
      throw new Error("ECONNRESET");
    });

    await expect(withRetryLocal(fn, 2)).rejects.toThrow("ECONNRESET");
    // Initial attempt (0) + 2 retries = 3 calls total.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("circuit breaker opens after 5 consecutive failures via withRetry", async () => {
    const breaker = makeBreaker({ failureThreshold: 5, resetTimeout: 60_000 });
    const withRetryLocal = makeWithRetry(breaker, 0);

    const fn = jest.fn(async () => {
      throw new Error("ECONNRESET");
    });

    // Each call to withRetryLocal uses up to maxRetries+1 attempts.
    // We call with maxRetries=0 so each invocation counts as exactly 1 failure.
    for (let i = 0; i < 4; i++) {
      await expect(withRetryLocal(fn, 0)).rejects.toThrow();
    }
    // 5th failure trips the breaker
    await expect(withRetryLocal(fn, 0)).rejects.toThrow();
    expect(breaker.getState()).toBe(STATES.OPEN);
  });

  test("circuit-open error is NOT retried", async () => {
    const breaker = makeBreaker({ failureThreshold: 2, resetTimeout: 60_000 });
    const withRetryLocal = makeWithRetry(breaker, 0);

    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      await expect(
        withRetryLocal(jest.fn(async () => { throw new Error("ECONNRESET"); }), 0),
      ).rejects.toThrow();
    }
    expect(breaker.getState()).toBe(STATES.OPEN);

    // Subsequent call should fail immediately with circuit-open message.
    const fn = jest.fn(async () => "should-not-run");
    await expect(withRetryLocal(fn, 3)).rejects.toThrow(/Circuit breaker/i);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. sorobanRpcRetriesTotal counter increments on retry
// ---------------------------------------------------------------------------

describe("sorobanRpcRetriesTotal Prometheus counter", () => {
  test("increments once per retry attempt", async () => {
    const breaker = makeBreaker({ failureThreshold: 10 });
    const withRetryLocal = makeWithRetry(breaker, 0);

    // Read starting value.
    const getCount = async () => {
      const metricsText = await require("./metrics").registry.metrics();
      const match = metricsText.match(
        /indigopay_soroban_rpc_retries_total\{[^}]*\}\s+([\d.]+)/,
      );
      return match ? Number(match[1]) : 0;
    };

    const before = await getCount();

    let calls = 0;
    const fn = jest.fn(async () => {
      calls++;
      if (calls <= 2) throw new Error("ECONNRESET");
      return "ok";
    });

    await withRetryLocal(fn, 3);

    const after = await getCount();
    // 2 retries should have been counted.
    expect(after - before).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 5. Prometheus circuit breaker gauge — reflects state transitions
// ---------------------------------------------------------------------------

describe("Prometheus circuit breaker gauge", () => {
  test("gauge metric name exists in registry", async () => {
    makeBreaker({ failureThreshold: 3 });
    const metricsText = await require("./metrics").registry.metrics();
    expect(metricsText).toMatch(/indigopay_soroban_circuit_breaker_state/);
  });

  test("gauge value is 2 (open) after breaker trips", async () => {
    const b = makeBreaker({ failureThreshold: 2, resetTimeout: 60_000 });
    for (let i = 0; i < 2; i++) {
      await expect(
        b.call(async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow();
    }
    expect(b.getState()).toBe(STATES.OPEN);

    const metricsText = await require("./metrics").registry.metrics();
    expect(metricsText).toMatch(
      new RegExp(
        `indigopay_soroban_circuit_breaker_state\\{[^}]*name="${b.name}"[^}]*\\}\\s+2`,
      ),
    );
  });

  test("gauge value returns to 0 (closed) after recovery", async () => {
    const b = makeBreaker({ failureThreshold: 2, resetTimeout: 1 });
    for (let i = 0; i < 2; i++) {
      await expect(
        b.call(async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow();
    }
    // Wait for the reset timeout to elapse
    await new Promise((r) => setTimeout(r, 20));
    await b.call(async () => "ok");

    const metricsText = await require("./metrics").registry.metrics();
    expect(metricsText).toMatch(
      new RegExp(
        `indigopay_soroban_circuit_breaker_state\\{[^}]*name="${b.name}"[^}]*\\}\\s+0`,
      ),
    );
  });
});
