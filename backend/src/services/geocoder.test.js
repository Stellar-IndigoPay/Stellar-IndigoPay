"use strict";

jest.mock("./redis", () => ({
  get: jest.fn(),
  set: jest.fn(),
  deletePattern: jest.fn(),
}));

const redis = require("./redis");
const { geocode } = require("./geocoder");

describe("geocoder", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue(null);
    global.fetch = jest.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test("returns coordinates parsed from the Nominatim response", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => [{ lat: "-3.4653", lon: "-62.2159" }],
    });

    const result = await geocode("Amazonas, Brazil");

    expect(result).toEqual({ latitude: -3.4653, longitude: -62.2159 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = global.fetch.mock.calls[0];
    expect(calledUrl).toContain("nominatim.openstreetmap.org/search");
    expect(calledUrl).toContain(encodeURIComponent("Amazonas, Brazil"));
    expect(options.headers["User-Agent"]).toBe("Stellar-IndigoPay/1.0");
  });

  test("caches the result after a successful lookup", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => [{ lat: "1.0", lon: "2.0" }],
    });

    await geocode("Kenya");

    expect(redis.set).toHaveBeenCalledWith(
      "geocode:kenya",
      { latitude: 1, longitude: 2 },
      86400 * 30,
    );
  });

  test("returns the cached result without calling fetch again", async () => {
    redis.get.mockResolvedValue({ latitude: 9.1, longitude: 40.5 });

    const result = await geocode("Ethiopia");

    expect(result).toEqual({ latitude: 9.1, longitude: 40.5 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("returns null when Nominatim finds no match", async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => [] });

    const result = await geocode("Paris, Texas, definitely-not-a-place-xyz");

    expect(result).toBeNull();
    expect(redis.set).not.toHaveBeenCalled();
  });

  test("returns null and does not throw on network error", async () => {
    global.fetch.mockRejectedValue(new Error("network down"));

    const result = await geocode("Nowhere");

    expect(result).toBeNull();
  });

  test("returns null for an empty or non-string location", async () => {
    expect(await geocode("")).toBeNull();
    expect(await geocode(undefined)).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("serializes requests to at least 1/sec (Nominatim rate limit)", async () => {
    global.fetch.mockImplementation(async () => ({
      ok: true,
      json: async () => [{ lat: "0", lon: "0" }],
    }));

    const start = Date.now();
    await geocode("Location A");
    await geocode("Location B");
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(990);
  }, 10000);
});
