/**
 * __tests__/pages/verification.test.tsx
 *
 * Unit tests for pages/verification/[id].tsx — the public verification
 * transparency page.
 *
 * Regression guard: with NEXT_PUBLIC_API_URL unset the implementation used to
 * build a relative URL (`"" + "/api/verification-requests/..."`). Node's fetch
 * rejects a relative URL with "TypeError: Failed to parse URL" before opening a
 * connection, and because the call sat outside a try/catch that rejection
 * escaped getServerSideProps and rendered HTTP 500 for every verification id.
 */

import { getServerSideProps } from "@/pages/verification/[id]";

type Ctx = Parameters<typeof getServerSideProps>[0];

const ctx = { params: { id: "project-001" } } as unknown as Ctx;
const ORIGINAL_API_URL = process.env.NEXT_PUBLIC_API_URL;

describe("pages/verification/[id] getServerSideProps", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    delete process.env.NEXT_PUBLIC_API_URL;
  });

  afterAll(() => {
    if (ORIGINAL_API_URL === undefined) {
      delete process.env.NEXT_PUBLIC_API_URL;
    } else {
      process.env.NEXT_PUBLIC_API_URL = ORIGINAL_API_URL;
    }
  });

  it("returns notFound instead of throwing when the API call rejects", async () => {
    // The exact rejection that produced the production 500.
    jest
      .spyOn(global, "fetch")
      .mockRejectedValue(
        new TypeError(
          "Failed to parse URL from /api/verification-requests/project-001/public",
        ),
      );

    await expect(getServerSideProps(ctx)).resolves.toEqual({ notFound: true });
  });

  it("requests an absolute URL even when NEXT_PUBLIC_API_URL is unset", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue({ ok: false } as Response);

    await getServerSideProps(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://localhost:4000/api/verification-requests/project-001/public",
    );
  });

  it("uses the configured API URL when one is present", async () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.test";
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue({ ok: false } as Response);

    await getServerSideProps(ctx);

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.example.test/api/verification-requests/project-001/public",
    );
  });

  it("encodes the id into the request path", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue({ ok: false } as Response);

    await getServerSideProps({ params: { id: "a/b c" } } as unknown as Ctx);

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://localhost:4000/api/verification-requests/a%2Fb%20c/public",
    );
  });

  it("maps a non-OK API response to notFound", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue({ ok: false, status: 404 } as Response);

    await expect(getServerSideProps(ctx)).resolves.toEqual({ notFound: true });
  });

  it("returns the record with reviewerNotes stripped", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          id: "project-001",
          projectName: "Gas Optimized Reforestation",
          status: "approved",
          walletAddress: "GABC",
          submittedAt: "2026-09-01T00:00:00.000Z",
          reviewerNotes: "internal reviewer commentary",
        },
      }),
    } as Response);

    const result = await getServerSideProps(ctx);

    expect(result).toEqual({
      props: {
        verification: {
          id: "project-001",
          projectName: "Gas Optimized Reforestation",
          status: "approved",
          walletAddress: "GABC",
          submittedAt: "2026-09-01T00:00:00.000Z",
        },
      },
    });
    // Reviewer notes must never reach the public page props.
    expect(result).not.toHaveProperty("props.verification.reviewerNotes");
  });
});
