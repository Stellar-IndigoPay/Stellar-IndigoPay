"use strict";
/**
 * Unit tests for env.js configuration module.
 */

describe("env.js configuration", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("validateEnv returns object with defaults", () => {
    process.env.JWT_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost:5432/test";

    const { validateEnv } = require("./env");
    const env = validateEnv();

    expect(typeof env).toBe("object");
    expect(Object.keys(env).length).toBeGreaterThan(0);
  });

  test("reads DATABASE_URL from environment", () => {
    process.env.JWT_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://example.com:5432/mydb";

    const { validateEnv } = require("./env");
    const env = validateEnv();

    expect(env.DATABASE_URL).toBe("postgres://example.com:5432/mydb");
  });

  test("reads PORT from environment", () => {
    process.env.JWT_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost:5432/test";
    process.env.PORT = "4000";

    const { validateEnv } = require("./env");
    const env = validateEnv();

    expect(env.PORT).toBe("4000");
  });

  test("reads NODE_ENV from environment", () => {
    process.env.JWT_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost:5432/test";
    process.env.NODE_ENV = "production";

    const { validateEnv } = require("./env");
    const env = validateEnv();

    expect(env.NODE_ENV).toBe("production");
  });

  test("reads JWT_SECRET from environment", () => {
    process.env.JWT_SECRET = "my-super-secret";
    process.env.DATABASE_URL = "postgres://localhost:5432/test";

    const { validateEnv } = require("./env");
    const env = validateEnv();

    expect(env.JWT_SECRET).toBe("my-super-secret");
  });

  test("applies default PORT when not set", () => {
    delete process.env.PORT;
    process.env.JWT_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost:5432/test";

    const { validateEnv } = require("./env");
    const env = validateEnv();

    expect(env.PORT).toBe("4000"); // default
  });

  test("applies default NODE_ENV when not set", () => {
    delete process.env.NODE_ENV;
    process.env.JWT_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost:5432/test";

    const { validateEnv } = require("./env");
    const env = validateEnv();

    expect(env.NODE_ENV).toBe("development"); // default
  });

  test("reads REDIS_URL from environment", () => {
    process.env.JWT_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost:5432/test";
    process.env.REDIS_URL = "redis://my-redis:6379";

    const { validateEnv } = require("./env");
    const env = validateEnv();

    expect(env.REDIS_URL).toBe("redis://my-redis:6379");
  });

  test("defaults REDIS_URL when not set", () => {
    delete process.env.REDIS_URL;
    process.env.JWT_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost:5432/test";

    const { validateEnv } = require("./env");
    const env = validateEnv();

    expect(env.REDIS_URL).toBe("redis://localhost:6379"); // default
  });

  test("apply defaults STELLAR_NETWORK when not set", () => {
    delete process.env.STELLAR_NETWORK;
    process.env.JWT_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://localhost:5432/test";

    const { validateEnv } = require("./env");
    const env = validateEnv();

    expect(env.STELLAR_NETWORK).toBe("testnet"); // default
  });
});
