import {
  fetchXlmUsdPrice,
  formatApproximateFiat,
} from "../lib/oraclePrice";

describe("XLM/USD oracle helper", () => {
  test("reads a successful oracle response", async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { price: 0.125 } }),
    });

    await expect(fetchXlmUsdPrice("https://api.example.com", fetcher)).resolves.toBe(0.125);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.com/api/oracle/price",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  test("formats approximate fiat values", () => {
    expect(formatApproximateFiat("10", 0.125)).toBe("≈ $1.25 USD");
    expect(formatApproximateFiat(" 10 ", 0.125)).toBe("≈ $1.25 USD");
    expect(formatApproximateFiat(10, 0.125)).toBe("≈ $1.25 USD");
    expect(formatApproximateFiat("", 0.125)).toBeNull();
    expect(formatApproximateFiat("   ", 0.125)).toBeNull();
    expect(formatApproximateFiat("bad", 0.125)).toBeNull();
    expect(formatApproximateFiat(true, 0.125)).toBeNull();
  });

  test("fails gracefully for unavailable or malformed prices", async () => {
    const unavailable = jest.fn().mockResolvedValue({ ok: false });
    const malformed = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { price: "0.125" } }),
    });
    const rejected = jest.fn().mockRejectedValue(new Error("offline"));

    await expect(fetchXlmUsdPrice("https://api.example.com", unavailable)).resolves.toBeNull();
    await expect(fetchXlmUsdPrice("https://api.example.com", malformed)).resolves.toBeNull();
    await expect(fetchXlmUsdPrice("https://api.example.com", rejected)).resolves.toBeNull();
    expect(formatApproximateFiat("10", null)).toBeNull();
  });
});
