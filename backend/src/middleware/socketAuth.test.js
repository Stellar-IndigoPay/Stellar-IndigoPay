"use strict";

jest.mock("./auth", () => ({
  verifyToken: jest.fn(),
  isBlacklisted: jest.fn(),
}));

const { verifyToken, isBlacklisted } = require("./auth");
const { extractToken, socketAuth } = require("./socketAuth");

const buildSocket = (handshake = {}) => ({ handshake, data: {} });
const next = () => {
  const calls = [];
  const fn = (...args) => calls.push(args);
  fn.calls = calls;
  return fn;
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("extractToken", () => {
  it("prefers the auth payload token", () => {
    expect(
      extractToken({
        auth: { token: "from-auth" },
        headers: { authorization: "Bearer from-header" },
      }),
    ).toBe("from-auth");
  });

  it("falls back to the Authorization header", () => {
    expect(extractToken({ auth: {}, headers: { authorization: "Bearer from-header" } })).toBe(
      "from-header",
    );
  });

  it("returns null when neither is present", () => {
    expect(extractToken({ auth: {}, headers: {} })).toBeNull();
    expect(extractToken({})).toBeNull();
    expect(extractToken()).toBeNull();
  });

  it("ignores non-string auth payloads", () => {
    expect(extractToken({ auth: { token: 42 }, headers: {} })).toBeNull();
  });
});

describe("socketAuth", () => {
  it("accepts a valid, non-blacklisted token and attaches the principal", async () => {
    verifyToken.mockReturnValue({ sub: "admin-1", role: "admin", jti: "jti-1" });
    isBlacklisted.mockResolvedValue(false);
    const socket = buildSocket({ auth: { token: "valid" }, headers: {} });
    const onNext = next();

    await socketAuth(socket, onNext);

    expect(onNext.calls).toEqual([[]]);
    expect(socket.data.admin).toEqual({ id: "admin-1", role: "admin", jti: "jti-1" });
    expect(isBlacklisted).toHaveBeenCalledWith("jti-1");
  });

  it("refuses a connection with no token at all", async () => {
    const socket = buildSocket({ auth: {}, headers: {} });
    const onNext = next();

    await socketAuth(socket, onNext);

    expect(onNext.calls).toHaveLength(1);
    expect(onNext.calls[0][0]).toBeInstanceOf(Error);
    expect(onNext.calls[0][0].message).toMatch(/missing access token/);
    expect(socket.data.admin).toBeUndefined();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("refuses an invalid or expired token", async () => {
    verifyToken.mockImplementation(() => {
      throw new Error("jwt expired");
    });
    const socket = buildSocket({ auth: { token: "expired" }, headers: {} });
    const onNext = next();

    await socketAuth(socket, onNext);

    expect(onNext.calls[0][0].message).toMatch(/invalid access token/);
    expect(socket.data.admin).toBeUndefined();
    expect(isBlacklisted).not.toHaveBeenCalled();
  });

  it("refuses a token that lacks the expected claims", async () => {
    verifyToken.mockReturnValue({ sub: "admin-1" }); // no jti
    const socket = buildSocket({ auth: { token: "weird" }, headers: {} });
    const onNext = next();

    await socketAuth(socket, onNext);

    expect(onNext.calls[0][0].message).toMatch(/malformed token claims/);
  });

  it("refuses a blacklisted (logged-out) token", async () => {
    verifyToken.mockReturnValue({ sub: "admin-1", role: "admin", jti: "jti-2" });
    isBlacklisted.mockResolvedValue(true);
    const socket = buildSocket({ auth: { token: "revoked" }, headers: {} });
    const onNext = next();

    await socketAuth(socket, onNext);

    expect(onNext.calls[0][0].message).toMatch(/token revoked/);
    expect(socket.data.admin).toBeUndefined();
  });

  it("fails closed when the blacklist lookup errors", async () => {
    verifyToken.mockReturnValue({ sub: "admin-1", role: "admin", jti: "jti-3" });
    isBlacklisted.mockRejectedValue(new Error("postgres down"));
    const socket = buildSocket({ auth: { token: "valid" }, headers: {} });
    const onNext = next();

    await socketAuth(socket, onNext);

    expect(onNext.calls[0][0].message).toMatch(/verification unavailable/);
    expect(socket.data.admin).toBeUndefined();
  });

  it("accepts a token supplied via the Authorization header", async () => {
    verifyToken.mockReturnValue({ sub: "admin-2", role: "admin", jti: "jti-4" });
    isBlacklisted.mockResolvedValue(false);
    const socket = buildSocket({
      auth: {},
      headers: { authorization: "Bearer header-token" },
    });
    const onNext = next();

    await socketAuth(socket, onNext);

    expect(verifyToken).toHaveBeenCalledWith("header-token");
    expect(onNext.calls).toEqual([[]]);
    expect(socket.data.admin.id).toBe("admin-2");
  });
});
