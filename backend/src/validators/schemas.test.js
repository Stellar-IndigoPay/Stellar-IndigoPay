"use strict";

const {
  stellarAddress,
  transactionHash,
  uuid,
  xlmAmount,
  donationSchema,
  leaderboardQuerySchema,
  projectSubmissionSchema,
} = require("./schemas");

const VALID_STELLAR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const VALID_TX_HASH = "a".repeat(64);
const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("stellarAddress", () => {
  test("accepts a valid Stellar address", () => {
    const result = stellarAddress.safeParse(VALID_STELLAR);
    expect(result.success).toBe(true);
  });

  test("rejects an invalid Stellar address", () => {
    const result = stellarAddress.safeParse("not-a-key");
    expect(result.success).toBe(false);
  });

  test("rejects an empty string", () => {
    const result = stellarAddress.safeParse("");
    expect(result.success).toBe(false);
  });

  test("rejects address with invalid characters (0, 1, 8, 9)", () => {
    const result = stellarAddress.safeParse("G0".padEnd(56, "A"));
    expect(result.success).toBe(false);
  });
});

describe("transactionHash", () => {
  test("accepts a valid 64-char hex hash", () => {
    const result = transactionHash.safeParse(VALID_TX_HASH);
    expect(result.success).toBe(true);
  });

  test("rejects a short hash", () => {
    const result = transactionHash.safeParse("abc");
    expect(result.success).toBe(false);
  });

  test("rejects a non-hex hash", () => {
    const result = transactionHash.safeParse("z".repeat(64));
    expect(result.success).toBe(false);
  });
});

describe("uuid", () => {
  test("accepts a valid UUID", () => {
    const result = uuid.safeParse(VALID_UUID);
    expect(result.success).toBe(true);
  });

  test("rejects an invalid UUID", () => {
    const result = uuid.safeParse("not-a-uuid");
    expect(result.success).toBe(false);
  });
});

describe("xlmAmount", () => {
  test("accepts a positive number string", () => {
    const result = xlmAmount.safeParse("100.50");
    expect(result.success).toBe(true);
  });

  test("rejects a negative amount", () => {
    const result = xlmAmount.safeParse("-10");
    expect(result.success).toBe(false);
  });

  test("rejects zero", () => {
    const result = xlmAmount.safeParse("0");
    expect(result.success).toBe(false);
  });

  test("rejects a non-numeric string", () => {
    const result = xlmAmount.safeParse("abc");
    expect(result.success).toBe(false);
  });
});

describe("donationSchema", () => {
  const validPayload = {
    projectId: VALID_UUID,
    donorAddress: VALID_STELLAR,
    transactionHash: VALID_TX_HASH,
    amountXLM: "10",
  };

  test("accepts a valid donation payload", () => {
    const result = donationSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  test("applies default currency of XLM", () => {
    const result = donationSchema.safeParse(validPayload);
    expect(result.data.currency).toBe("XLM");
  });

  test("rejects an invalid Stellar address", () => {
    const result = donationSchema.safeParse({
      ...validPayload,
      donorAddress: "bad",
    });
    expect(result.success).toBe(false);
  });

  test("rejects an invalid transaction hash", () => {
    const result = donationSchema.safeParse({
      ...validPayload,
      transactionHash: "bad",
    });
    expect(result.success).toBe(false);
  });

  test("rejects a negative amount", () => {
    const result = donationSchema.safeParse({
      ...validPayload,
      amountXLM: "-50",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing required fields", () => {
    const result = donationSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("returns multiple errors for multiple missing fields", () => {
    const result = donationSchema.safeParse({});
    expect(result.success).toBe(false);
    expect(result.error.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe("leaderboardQuerySchema", () => {
  test("applies defaults for empty query", () => {
    const result = leaderboardQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data.limit).toBe(20);
    expect(result.data.period).toBe("all");
    expect(result.data.sortBy).toBe("totalDonatedXLM");
    expect(result.data.onlyVerified).toBe("false");
  });

  test("coerces limit to a number", () => {
    const result = leaderboardQuerySchema.safeParse({ limit: "5" });
    expect(result.success).toBe(true);
    expect(result.data.limit).toBe(5);
  });

  test("rejects invalid period", () => {
    const result = leaderboardQuerySchema.safeParse({ period: "decade" });
    expect(result.success).toBe(false);
  });

  test("rejects negative limit", () => {
    const result = leaderboardQuerySchema.safeParse({ limit: -1 });
    expect(result.success).toBe(false);
  });
});

describe("projectSubmissionSchema tags", () => {
  const validPayload = {
    name: "Amazon Reforestation",
    category: "Reforestation",
    description: "Restoring native tree cover across degraded land.",
    location: "Brazil",
    goalXLM: "10000",
    walletAddress: VALID_STELLAR,
    organization: {
      name: "Rainforest Org",
      contactEmail: "contact@rainforest.org",
    },
    co2Methodology: {
      name: "Verra VCS",
      annualTonnesCO2: "1200",
    },
  };

  test("accepts a payload with valid tags", () => {
    const result = projectSubmissionSchema.safeParse({
      ...validPayload,
      tags: ["reforestation", "amazon"],
    });
    expect(result.success).toBe(true);
    expect(result.data.tags).toEqual(["reforestation", "amazon"]);
  });

  test("defaults tags to an empty array when omitted", () => {
    const result = projectSubmissionSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
    expect(result.data.tags).toEqual([]);
  });

  test("accepts exactly 10 tags (boundary)", () => {
    const result = projectSubmissionSchema.safeParse({
      ...validPayload,
      tags: Array.from({ length: 10 }, (_, i) => `tag-${i}`),
    });
    expect(result.success).toBe(true);
  });

  test("rejects more than 10 tags", () => {
    const result = projectSubmissionSchema.safeParse({
      ...validPayload,
      tags: Array.from({ length: 11 }, (_, i) => `tag-${i}`),
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/at most 10/);
  });

  test("accepts a tag of exactly 50 characters (boundary)", () => {
    const result = projectSubmissionSchema.safeParse({
      ...validPayload,
      tags: ["x".repeat(50)],
    });
    expect(result.success).toBe(true);
  });

  test("rejects a tag longer than 50 characters", () => {
    const result = projectSubmissionSchema.safeParse({
      ...validPayload,
      tags: ["x".repeat(51)],
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/at most 50/);
  });

  test("rejects an empty-string tag", () => {
    const result = projectSubmissionSchema.safeParse({
      ...validPayload,
      tags: ["valid", ""],
    });
    expect(result.success).toBe(false);
  });

  test("rejects a whitespace-only tag", () => {
    const result = projectSubmissionSchema.safeParse({
      ...validPayload,
      tags: ["   "],
    });
    expect(result.success).toBe(false);
  });

  test("trims surrounding whitespace from tags", () => {
    const result = projectSubmissionSchema.safeParse({
      ...validPayload,
      tags: ["  solar  "],
    });
    expect(result.success).toBe(true);
    expect(result.data.tags).toEqual(["solar"]);
  });

  test("rejects non-string tag entries", () => {
    const result = projectSubmissionSchema.safeParse({
      ...validPayload,
      tags: [42],
    });
    expect(result.success).toBe(false);
  });
});

describe("sanitization", () => {
  const validPayload = {
    name: "Amazon Reforestation",
    category: "Reforestation",
    description: "Restoring native tree cover across degraded land.",
    location: "Brazil",
    goalXLM: "10000",
    walletAddress: VALID_STELLAR,
    organization: {
      name: "Rainforest Org",
      contactEmail: "contact@rainforest.org",
    },
    co2Methodology: {
      name: "Verra VCS",
      annualTonnesCO2: "1200",
    },
  };

  test("strips HTML tags from text fields", () => {
    const result = projectSubmissionSchema.safeParse({
      ...validPayload,
      name: "Amazon <script>alert(1)</script>Reforestation",
      description: "Restoring <b>native</b> tree cover.",
    });
    expect(result.success).toBe(true);
    expect(result.data.name).toBe("Amazon Reforestation");
    expect(result.data.description).toBe("Restoring native tree cover.");
  });

  test("strips bidirectional control characters", () => {
    const result = projectSubmissionSchema.safeParse({
      ...validPayload,
      name: "Amazon\u202EReforestation",
    });
    expect(result.success).toBe(true);
    expect(result.data.name).toBe("AmazonReforestation");
  });

  test("normalizes Unicode to NFC", () => {
    // "é" as e + combining acute accent (NFD) → NFC "é"
    const result = projectSubmissionSchema.safeParse({
      ...validPayload,
      name: "Cafe\u0301 Reforestation",
    });
    expect(result.success).toBe(true);
    expect(result.data.name).toBe("Café Reforestation");
  });

  test("truncates at the schema-defined max length", () => {
    const result = projectSubmissionSchema.safeParse({
      ...validPayload,
      name: "x".repeat(200),
    });
    expect(result.success).toBe(true);
    expect(result.data.name.length).toBe(120);
  });

  test("sanitizes donation message", () => {
    const result = donationSchema.safeParse({
      projectId: VALID_UUID,
      donorAddress: VALID_STELLAR,
      transactionHash: VALID_TX_HASH,
      amountXLM: "10",
      message: "Thanks <script>alert(1)</script>!",
    });
    expect(result.success).toBe(true);
    expect(result.data.message).toBe("Thanks !");
  });
});
