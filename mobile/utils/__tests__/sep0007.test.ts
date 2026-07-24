import { parseSEP0007Params, validateSEP0007Params } from "../sep0007";

describe("parseSEP0007Params", () => {
  it("parses a full payment URI with all supported fields", () => {
    const url = "web+stellar:pay?destination=GABC123&amount=50&memo=donation&memo_type=text&asset_code=USDC&asset_issuer=GISSUER&message=Thanks&callback=https%3A%2F%2Fexample.com%2Fdone";

    expect(parseSEP0007Params(url)).toEqual({
      destination: "GABC123",
      amount: "50",
      memo: "donation",
      memo_type: "text",
      asset_code: "USDC",
      asset_issuer: "GISSUER",
      message: "Thanks",
      callback: "https://example.com/done",
    });
  });

  it("defaults asset_code to XLM when omitted", () => {
    const params = parseSEP0007Params("web+stellar:pay?destination=GABC123&amount=25");
    expect(params.asset_code).toBe("XLM");
  });

  it("returns an empty object for non SEP-0007 schemes", () => {
    expect(parseSEP0007Params("https://example.com")).toEqual({});
  });

  it("returns an empty object for malformed URLs", () => {
    expect(parseSEP0007Params("not a url")).toEqual({});
  });

  it("preserves the callback parameter", () => {
    const params = parseSEP0007Params("web+stellar:pay?destination=GABC123&callback=https%3A%2F%2Fexample.com%2Fdone");
    expect(params.callback).toBe("https://example.com/done");
  });

  it("supports memo_type=id", () => {
    const params = parseSEP0007Params("web+stellar:pay?destination=GABC123&memo_type=id");
    expect(params.memo_type).toBe("id");
  });

  it("supports memo_type=hash", () => {
    const params = parseSEP0007Params("web+stellar:pay?destination=GABC123&memo_type=hash");
    expect(params.memo_type).toBe("hash");
  });

  it("supports memo_type=return", () => {
    const params = parseSEP0007Params("web+stellar:pay?destination=GABC123&memo_type=return");
    expect(params.memo_type).toBe("return");
  });

  it("returns an empty destination for missing destination", () => {
    const params = parseSEP0007Params("web+stellar:pay?amount=10");
    expect(params.destination).toBe("");
  });

  it("validates missing destination as invalid", () => {
    expect(validateSEP0007Params({ destination: "" })).toEqual(
      expect.arrayContaining(["destination"]),
    );
  });

  it("validates a non-numeric amount", () => {
    expect(validateSEP0007Params({ destination: "GABC123", amount: "abc" })).toEqual(
      expect.arrayContaining(["amount"]),
    );
  });

  it("validates unsupported asset codes", () => {
    expect(validateSEP0007Params({ destination: "GABC123", asset_code: "EUR" })).toEqual(
      expect.arrayContaining(["asset_code"]),
    );
  });

  it("validates asset issuer for non-native assets", () => {
    expect(validateSEP0007Params({ destination: "GABC123", asset_code: "USDC", asset_issuer: "" })).toEqual(
      expect.arrayContaining(["asset_issuer"]),
    );
  });
});
