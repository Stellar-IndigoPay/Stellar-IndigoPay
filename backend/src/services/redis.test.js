"use strict";

/**
 * src/services/redis.test.js
 *
 * Unit tests for the sharded Redis service.
 *
 * Since the module uses lazy initialisation and reads process.env, we
 * reset internal state before each test and mock ioredis to avoid
 * real network connections.
 *
 * Coverage:
 *   - getClient() returns default client (backward compat)
 *   - getClient(key) routes correctly across shards
 *   - shardCount returns correct value
 *   - get/set delegate to correct shard
 *   - deletePattern sweeps all shards
 *   - Fallback to single instance when REDIS_URLS is empty
 */

// ── Mocks ───────────────────────────────────────────────────────────────────
// Must be set before any module import because the redis module calls
// `require("ioredis")` at the top level.

const mockRedisInstances = [];
let mockRedisConstructorCallCount = 0;

jest.mock("ioredis", () => {
  return jest.fn().mockImplementation(() => {
    mockRedisConstructorCallCount++;
    const instance = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue("OK"),
      keys: jest.fn().mockResolvedValue([]),
      del: jest.fn().mockResolvedValue(0),
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(),
      quit: jest.fn().mockResolvedValue(),
      pipeline: jest.fn().mockReturnValue({
        zadd: jest.fn().mockReturnThis(),
        zremrangebyscore: jest.fn().mockReturnThis(),
        zcard: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
      script: jest.fn().mockResolvedValue("mock-sha"),
      evalsha: jest.fn().mockResolvedValue([1, 9, 0]),
    };
    mockRedisInstances.push(instance);
    return instance;
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function resetModule() {
  jest.resetModules();
  jest.clearAllMocks();
  mockRedisInstances.length = 0;
  mockRedisConstructorCallCount = 0;
  // Clear env so each test can set its own
  delete process.env.REDIS_URLS;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_SENTINELS;
  delete process.env.REDIS_SENTINEL_MASTER_NAME;
  delete process.env.REDIS_SENTINEL_PASSWORD;
  delete process.env.REDIS_PASSWORD;
  delete process.env.REDIS_PASSWORD_PREVIOUS;
  delete process.env.CLIENTSIDE_REDIS_PASSWORD_PREVIOUS;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Sharded Redis service", () => {
  let redisService;

  beforeEach(() => {
    resetModule();
  });

  afterEach(() => {
    delete process.env.REDIS_URLS;
    delete process.env.REDIS_URL;
  });

  test("getClient() without key returns first client in single-instance mode", () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    redisService = require("./redis");

    const client = redisService.getClient();
    expect(client).toBe(mockRedisInstances[0]);
    expect(mockRedisConstructorCallCount).toBe(1);
  });

  test("getClient(key) routes to the correct shard when REDIS_URLS is set", () => {
    process.env.REDIS_URLS = "redis://a:6379,redis://b:6379";
    redisService = require("./redis");

    // initRedis must be called first so the ring is populated
    redisService.initRedis();
    expect(redisService.shardCount()).toBe(2);

    // With deterministic hashing, the same key always maps to the same shard
    const key = "ratelimit:sw:10.0.0.1:POST:/api/donations";
    const client1 = redisService.getClient(key);
    const client2 = redisService.getClient(key);

    expect(client1).toBe(client2);
    // The client must be one of our two mock instances
    expect([mockRedisInstances[0], mockRedisInstances[1]]).toContain(client1);
  });

  test("initRedis creates one client per REDIS_URLS entry", () => {
    process.env.REDIS_URLS = "redis://redis-0:6379,redis://redis-1:6379,redis://redis-2:6379";
    redisService = require("./redis");

    redisService.initRedis();
    expect(redisService.shardCount()).toBe(3);
    expect(mockRedisConstructorCallCount).toBe(3);
  });

  test("shardCount returns 1 in single-instance mode", () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    redisService = require("./redis");

    redisService.initRedis();
    expect(redisService.shardCount()).toBe(1);
  });

  test("get(key) delegates to the correct shard via getClient", async () => {
    process.env.REDIS_URLS = "redis://a:6379,redis://b:6379";
    redisService = require("./redis");
    redisService.initRedis();

    const testKey = "test:cache:123";
    // Both shards need the same mock value since we can't predict which
    // shard the consistent hash ring will route the key to.
    mockRedisInstances[0].get.mockResolvedValue(JSON.stringify({ data: "hello" }));
    mockRedisInstances[1].get.mockResolvedValue(JSON.stringify({ data: "hello" }));

    const result = await redisService.get(testKey);
    // The result should be the parsed JSON
    expect(result).toEqual({ data: "hello" });
  });

  test("get(key) returns null on Redis error", async () => {
    process.env.REDIS_URL = "redis://broken:6379";
    redisService = require("./redis");
    redisService.initRedis();

    mockRedisInstances[0].get.mockRejectedValue(new Error("connection refused"));

    const result = await redisService.get("some-key");
    expect(result).toBeNull();
  });

  test("set(key, value, ttl) delegates to the correct shard", async () => {
    process.env.REDIS_URLS = "redis://a:6379,redis://b:6379";
    redisService = require("./redis");
    redisService.initRedis();

    const key = "test:cache:456";
    const value = { count: 42 };

    await redisService.set(key, value, 300);

    // The set should have been called on one of the shard clients
    const setCalls = [...mockRedisInstances[0].set.mock.calls, ...mockRedisInstances[1].set.mock.calls];
    expect(setCalls.length).toBeGreaterThanOrEqual(1);
    // At least one call should have the key and TTL
    const matching = setCalls.find(
      (call) => call[0] === key && call[2] === "EX" && call[3] === 300,
    );
    expect(matching).toBeDefined();
  });

  test("set(key, value) without TTL does not pass EX argument", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    redisService = require("./redis");
    redisService.initRedis();

    await redisService.set("plain-key", { hello: "world" });

    const call = mockRedisInstances[0].set.mock.calls.find(
      (c) => c[0] === "plain-key",
    );
    expect(call).toBeDefined();
    // The EX argument should not be present
    expect(call[2]).not.toBe("EX");
  });

  test("deletePattern sweeps all shards", async () => {
    process.env.REDIS_URLS = "redis://a:6379,redis://b:6379";
    redisService = require("./redis");
    redisService.initRedis();

    mockRedisInstances[0].keys.mockResolvedValue(["cache:projects:1"]);
    mockRedisInstances[1].keys.mockResolvedValue(["cache:projects:2", "cache:projects:3"]);

    await redisService.deletePattern("cache:projects:*");

    expect(mockRedisInstances[0].keys).toHaveBeenCalledWith("cache:projects:*");
    expect(mockRedisInstances[1].keys).toHaveBeenCalledWith("cache:projects:*");
    expect(mockRedisInstances[0].del).toHaveBeenCalledWith("cache:projects:1");
    expect(mockRedisInstances[1].del).toHaveBeenCalledWith("cache:projects:2", "cache:projects:3");
  });

  test("_reset clears all internal state", () => {
    process.env.REDIS_URLS = "redis://a:6379,redis://b:6379";
    redisService = require("./redis");
    redisService.initRedis();
    expect(redisService.shardCount()).toBe(2);

    redisService._reset();

    // After reset, clear REDIS_URLS so initRedis falls back to REDIS_URL
    delete process.env.REDIS_URLS;
    process.env.REDIS_URL = "redis://new:6379";
    redisService.initRedis();
    expect(redisService.shardCount()).toBe(1);
  });

  test("getClient with key falls back to first client when REDIS_URLS is not set", () => {
    process.env.REDIS_URL = "redis://single:6379";
    redisService = require("./redis");

    const client = redisService.getClient("any-key");
    expect(client).toBe(mockRedisInstances[0]);
  });

  test("getClient handles empty REDIS_URLS gracefully", () => {
    process.env.REDIS_URLS = "";
    process.env.REDIS_URL = "redis://fallback:6379";
    redisService = require("./redis");

    redisService.initRedis();
    expect(redisService.shardCount()).toBe(1);

    const client = redisService.getClient("any-key");
    expect(client).toBe(mockRedisInstances[0]);
  });

  // ── Dual-version AUTH fallback (WS3 / #1100) ───────────────────────────
  test("WRONGPASS error triggers fallback to the previous password", () => {
    process.env.REDIS_URL = "redis://host:6379";
    process.env.REDIS_PASSWORD = "current-password";
    process.env.REDIS_PASSWORD_PREVIOUS = "previous-password";
    const RedisMock = require("ioredis");
    redisService = require("./redis");
    redisService.initRedis();

    expect(mockRedisConstructorCallCount).toBe(1);

    // Grab the "error" handler ioredis registered on the initial client.
    const errHandler = mockRedisInstances[0].on.mock.calls.find(
      (c) => c[0] === "error",
    )?.[1];
    expect(errHandler).toBeDefined();

    // Redis 7 replies WRONGPASS for a bad AUTH credential.
    errHandler(new Error("WRONGPASS invalid username-password pair or user is disabled"));

    // A fallback client must have been constructed with the previous password.
    expect(mockRedisConstructorCallCount).toBe(2);
    // new Redis(url, options) — options are the 2nd constructor arg.
    const fallbackOpts = RedisMock.mock.calls[1][1];
    expect(fallbackOpts.password).toBe("previous-password");
    // The box-level client must now point at the working fallback.
    expect(redisService.getClient()).toBe(mockRedisInstances[1]);
  });

  test("WRONGPASS fallback keeps swapping to the newest working client", () => {
    process.env.REDIS_URL = "redis://host:6379";
    process.env.REDIS_PASSWORD = "current-password";
    process.env.REDIS_PASSWORD_PREVIOUS = "previous-password";
    redisService = require("./redis");
    redisService.initRedis();

    const errHandler = mockRedisInstances[0].on.mock.calls.find(
      (c) => c[0] === "error",
    )?.[1];
    errHandler(new Error("WRONGPASS "));
    expect(redisService.getClient()).toBe(mockRedisInstances[1]);

    // A second auth failure on the initial client re-triggers the fallback and
    // must not blow up or create an unbounded number of clients.
    errHandler(new Error("WRONGPASS again"));
    // At minimum the box-level client now references one of the fallbacks.
    expect(redisService.getClient()).toBe(mockRedisInstances[1]);
  });

  test("NOAUTH error also triggers the previous-password fallback", () => {
    process.env.REDIS_URL = "redis://host:6379";
    process.env.REDIS_PASSWORD = "current-password";
    process.env.REDIS_PASSWORD_PREVIOUS = "previous-password";
    redisService = require("./redis");
    redisService.initRedis();

    const errHandler = mockRedisInstances[0].on.mock.calls.find(
      (c) => c[0] === "error",
    )?.[1];
    errHandler(new Error("NOAUTH Authentication required."));

    expect(mockRedisConstructorCallCount).toBe(2);
    expect(redisService.getClient()).toBe(mockRedisInstances[1]);
  });

  test("non-auth errors do not trigger a password fallback", () => {
    process.env.REDIS_URL = "redis://host:6379";
    process.env.REDIS_PASSWORD = "current-password";
    process.env.REDIS_PASSWORD_PREVIOUS = "previous-password";
    redisService = require("./redis");
    redisService.initRedis();

    const errHandler = mockRedisInstances[0].on.mock.calls.find(
      (c) => c[0] === "error",
    )?.[1];
    errHandler(new Error("ECONNREFUSED connection refused"));

    expect(mockRedisConstructorCallCount).toBe(1);
    expect(redisService.getClient()).toBe(mockRedisInstances[0]);
  });
});

// ── Sentinel (failover) mode ──────────────────────────────────────────────

describe("Redis Sentinel failover mode", () => {
  let redisService;
  let RedisMock;

  beforeEach(() => {
    resetModule();
    RedisMock = require("ioredis");
  });

  afterEach(() => {
    delete process.env.REDIS_SENTINELS;
    delete process.env.REDIS_SENTINEL_MASTER_NAME;
    delete process.env.REDIS_SENTINEL_PASSWORD;
  });

  test("parseSentinels parses comma-separated host:port pairs", () => {
    redisService = require("./redis");
    const parsed = redisService.parseSentinels(
      "sentinel-0:26379, sentinel-1:26379, sentinel-2:26379",
    );
    expect(parsed).toEqual([
      { host: "sentinel-0", port: 26379 },
      { host: "sentinel-1", port: 26379 },
      { host: "sentinel-2", port: 26379 },
    ]);
  });

  test("parseSentinels defaults port to 26379 and trims whitespace", () => {
    redisService = require("./redis");
    const parsed = redisService.parseSentinels("sentinel-a, sentinel-b:26380");
    expect(parsed).toEqual([
      { host: "sentinel-a", port: 26379 },
      { host: "sentinel-b", port: 26380 },
    ]);
  });

  test("parseSentinels drops malformed/empty entries", () => {
    redisService = require("./redis");
    const parsed = redisService.parseSentinels(" , sentinel-0:26379, , :, ");
    expect(parsed).toEqual([{ host: "sentinel-0", port: 26379 }]);
  });

  test("sentinelOptions returns null when sentinels are unset (backward compat)", () => {
    delete process.env.REDIS_SENTINELS;
    delete process.env.REDIS_SENTINEL_MASTER_NAME;
    process.env.REDIS_URL = "redis://localhost:6379";
    redisService = require("./redis");

    expect(redisService.sentinelOptions()).toBeNull();
  });

  test("sentinelOptions returns null when master name is missing", () => {
    process.env.REDIS_SENTINELS = "sentinel-0:26379";
    delete process.env.REDIS_SENTINEL_MASTER_NAME;
    redisService = require("./redis");

    expect(redisService.sentinelOptions()).toBeNull();
  });

  test("sentinelOptions resolves a valid sentinel config", () => {
    process.env.REDIS_SENTINELS = "sentinel-0:26379,sentinel-1:26379";
    process.env.REDIS_SENTINEL_MASTER_NAME = "indigopay-master";
    redisService = require("./redis");

    const opts = redisService.sentinelOptions();
    expect(opts).toEqual({
      sentinels: [
        { host: "sentinel-0", port: 26379 },
        { host: "sentinel-1", port: 26379 },
      ],
      name: "indigopay-master",
    });
  });

  test("initRedis creates a single sentinel-mode client", () => {
    process.env.REDIS_SENTINELS = "sentinel-0:26379,sentinel-1:26379";
    process.env.REDIS_SENTINEL_MASTER_NAME = "indigopay-master";
    redisService = require("./redis");

    redisService.initRedis();

    expect(mockRedisConstructorCallCount).toBe(1);
    expect(redisService.shardCount()).toBe(1);

    // The ioredis constructor must receive a sentinel options object.
    const constructorArg = RedisMock.mock.calls[0][0];
    expect(constructorArg).toMatchObject({
      sentinels: [
        { host: "sentinel-0", port: 26379 },
        { host: "sentinel-1", port: 26379 },
      ],
      name: "indigopay-master",
      role: "master",
    });
  });

  test("sentinel client attaches failover event handlers", () => {
    process.env.REDIS_SENTINELS = "sentinel-0:26379";
    process.env.REDIS_SENTINEL_MASTER_NAME = "indigopay-master";
    redisService = require("./redis");

    redisService.initRedis();

    const client = mockRedisInstances[0];
    // The mock's `.on()` records event names.
    const events = client.on.mock.calls.map((c) => c[0]);
    expect(events).toEqual(
      expect.arrayContaining([
        "reconnecting",
        "ready",
        "failoverSubscribed",
        "sentinelReconnecting",
        "error",
      ]),
    );
  });

  test("sentinel failover event handlers emit metrics without throwing", () => {
    process.env.REDIS_SENTINELS = "sentinel-0:26379";
    process.env.REDIS_SENTINEL_MASTER_NAME = "indigopay-master";
    redisService = require("./redis");

    redisService.initRedis();

    const client = mockRedisInstances[0];
    // Invoke each registered handler; none should throw.
    for (const [event, handler] of client.on.mock.calls) {
      expect(() =>
        handler(event === "error" ? new Error("boom") : event === "reconnecting" ? 500 : undefined),
      ).not.toThrow();
    }
  });

  test("single-instance mode is unchanged when sentinels are unset", () => {
    delete process.env.REDIS_SENTINELS;
    delete process.env.REDIS_SENTINEL_MASTER_NAME;
    process.env.REDIS_URL = "redis://localhost:6379";
    redisService = require("./redis");

    const client = redisService.getClient();
    expect(client).toBe(mockRedisInstances[0]);
    expect(mockRedisConstructorCallCount).toBe(1);

    // Single-instance mode must NOT attach sentinel-specific handlers.
    const events = mockRedisInstances[0].on.mock.calls.map((c) => c[0]);
    expect(events).not.toContain("failoverSubscribed");
  });
});
