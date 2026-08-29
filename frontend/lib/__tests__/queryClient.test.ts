/** @jest-environment jsdom */
import "fake-indexeddb/auto";
import {
  createQueryClient,
  indexedDbPersister,
  QUERY_CACHE_MAX_AGE,
  shouldDehydrateMutation,
} from "@/lib/queryClient";

function deleteDatabase(): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase("indigopay-query-cache");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

describe("queryClient", () => {
  beforeEach(async () => {
    await deleteDatabase();
  });

  it("uses the shared retry policy and exponential mutation backoff", () => {
    const client = createQueryClient();
    const options = client.getDefaultOptions();
    const queryRetry = options.queries?.retry as (
      failureCount: number,
      error: unknown,
    ) => boolean;
    const mutationRetry = options.mutations?.retry as (
      failureCount: number,
      error: unknown,
    ) => boolean;
    const mutationRetryDelay = options.mutations?.retryDelay as (
      attemptIndex: number,
      error: unknown,
    ) => number;

    expect(queryRetry(0, { code: "ERR_NETWORK" })).toBe(true);
    expect(options.queries?.gcTime).toBe(QUERY_CACHE_MAX_AGE);
    expect(mutationRetry(3, { response: { status: 503 } })).toBe(false);
    expect(mutationRetryDelay(0, new Error())).toBe(1_000);
    expect(mutationRetryDelay(1, new Error())).toBe(2_000);
  });

  it("persists and restores the dehydrated query cache in IndexedDB", async () => {
    const persisted = {
      timestamp: Date.now(),
      buster: "test",
      clientState: {
        mutations: [],
        queries: [],
      },
    };

    await indexedDbPersister.persistClient(persisted);
    await expect(indexedDbPersister.restoreClient()).resolves.toEqual(persisted);
  });

  it("excludes paused donation mutations while preserving paused query mutations", () => {
    expect(
      shouldDehydrateMutation({
        state: { isPaused: true },
        options: { mutationKey: ["recordDonation"] },
      }),
    ).toBe(false);
    expect(
      shouldDehydrateMutation({
        state: { isPaused: true },
        options: { mutationKey: ["otherMutation"] },
      }),
    ).toBe(true);
    expect(
      shouldDehydrateMutation({
        state: { isPaused: false },
        options: { mutationKey: ["otherMutation"] },
      }),
    ).toBe(false);
  });
});
