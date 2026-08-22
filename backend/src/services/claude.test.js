"use strict";

describe("generateProjectSummary", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  function mockSdk(createImpl) {
    jest.doMock("@anthropic-ai/sdk", () =>
      jest.fn().mockImplementation(() => ({
        messages: { create: createImpl },
      })),
    );
  }

  it("returns summary, model, usage, and latencyMs on success", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockSdk(
      jest.fn().mockResolvedValue({
        model: "claude-opus-4-7",
        content: [
          { type: "text", text: "  Sentence one. Sentence two. Sentence three.  " },
        ],
        usage: { input_tokens: 120, output_tokens: 40 },
      }),
    );
    const { generateProjectSummary } = require("./claude");

    const result = await generateProjectSummary({
      name: "Reforest Now",
      category: "Reforestation",
      description: "Plants trees in degraded land.",
    });

    expect(result.summary).toBe("Sentence one. Sentence two. Sentence three.");
    expect(result.model).toBe("claude-opus-4-7");
    expect(result.usage).toEqual({ input_tokens: 120, output_tokens: 40 });
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("throws with reason 'api_key' when ANTHROPIC_API_KEY is not set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    mockSdk(jest.fn());
    const { generateProjectSummary } = require("./claude");

    await expect(
      generateProjectSummary({ name: "X", category: "Y", description: "Z" }),
    ).rejects.toMatchObject({ code: "MISSING_API_KEY", reason: "api_key" });
  });

  it("throws with reason 'empty_response' when Claude returns no text block", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockSdk(
      jest.fn().mockResolvedValue({
        model: "claude-opus-4-7",
        content: [{ type: "tool_use" }],
        usage: { input_tokens: 10, output_tokens: 0 },
      }),
    );
    const { generateProjectSummary } = require("./claude");

    await expect(
      generateProjectSummary({ name: "X", category: "Y", description: "Z" }),
    ).rejects.toMatchObject({ code: "EMPTY_RESPONSE", reason: "empty_response" });
  });

  it("classifies a 429 provider error as reason 'rate_limit'", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const rateLimitErr = Object.assign(new Error("Rate limited"), { status: 429 });
    mockSdk(jest.fn().mockRejectedValue(rateLimitErr));
    const { generateProjectSummary } = require("./claude");

    await expect(
      generateProjectSummary({ name: "X", category: "Y", description: "Z" }),
    ).rejects.toMatchObject({ reason: "rate_limit" });
  });

  it("classifies an unrecognised provider error as reason 'provider_error'", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockSdk(jest.fn().mockRejectedValue(new Error("network blip")));
    const { generateProjectSummary } = require("./claude");

    await expect(
      generateProjectSummary({ name: "X", category: "Y", description: "Z" }),
    ).rejects.toMatchObject({ reason: "provider_error" });
  });

  it("attaches latencyMs to a thrown error too", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockSdk(jest.fn().mockRejectedValue(new Error("boom")));
    const { generateProjectSummary } = require("./claude");

    await expect(
      generateProjectSummary({ name: "X", category: "Y", description: "Z" }),
    ).rejects.toMatchObject({ latencyMs: expect.any(Number) });
  });
});