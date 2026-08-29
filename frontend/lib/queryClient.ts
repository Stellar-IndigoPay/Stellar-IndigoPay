import { QueryClient } from "@tanstack/react-query";
import type { Persister, PersistedClient } from "@tanstack/react-query-persist-client";
import { queryRetryPolicy } from "@/lib/queryRetry";

const QUERY_CACHE_DB = "indigopay-query-cache";
const QUERY_CACHE_STORE = "queries";
const QUERY_CACHE_KEY = "react-query";

export const QUERY_CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
export const RECORD_DONATION_MUTATION_KEY = "recordDonation";

export function shouldDehydrateMutation(mutation: {
  state: { isPaused: boolean };
  options: { mutationKey?: readonly unknown[] };
}): boolean {
  return (
    mutation.state.isPaused &&
    mutation.options.mutationKey?.[0] !== RECORD_DONATION_MUTATION_KEY
  );
}

/**
 * Create the application QueryClient. Keeping this in a factory makes the
 * client safe to create once in the browser without sharing state between
 * server-side requests.
 */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: QUERY_CACHE_MAX_AGE,
        retry: queryRetryPolicy,
        refetchOnWindowFocus: true,
      },
      mutations: {
        retry: queryRetryPolicy,
        retryDelay: (attemptIndex) =>
          Math.min(1_000 * 2 ** attemptIndex, 30_000),
      },
    },
  });
}

function openQueryCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }

    const request = indexedDB.open(QUERY_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(QUERY_CACHE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open query cache"));
  });
}

function readQueryCache(): Promise<PersistedClient | undefined> {
  return openQueryCache().then(
    (database) =>
      new Promise((resolve, reject) => {
        const request = database
          .transaction(QUERY_CACHE_STORE, "readonly")
          .objectStore(QUERY_CACHE_STORE)
          .get(QUERY_CACHE_KEY);
        request.onsuccess = () => resolve(request.result as PersistedClient | undefined);
        request.onerror = () => reject(request.error);
        request.transaction?.addEventListener("complete", () => database.close());
      }),
  );
}

function writeQueryCache(client: PersistedClient | undefined): Promise<void> {
  return openQueryCache().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(QUERY_CACHE_STORE, "readwrite");
        const request = transaction.objectStore(QUERY_CACHE_STORE).put(
          client,
          QUERY_CACHE_KEY,
        );
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      }),
  );
}

function removeQueryCache(): Promise<void> {
  return openQueryCache().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(QUERY_CACHE_STORE, "readwrite");
        const request = transaction.objectStore(QUERY_CACHE_STORE).delete(
          QUERY_CACHE_KEY,
        );
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      }),
  );
}

/** Best-effort IndexedDB persister for TanStack's dehydrated query cache. */
export const indexedDbPersister: Persister = {
  persistClient: async (client) => {
    try {
      await writeQueryCache(client);
    } catch {
      // Persistence must never make the application unusable in private
      // browsing modes or when storage is disabled.
    }
  },
  restoreClient: async () => {
    try {
      return await readQueryCache();
    } catch {
      return undefined;
    }
  },
  removeClient: async () => {
    try {
      await removeQueryCache();
    } catch {
      // A failed cleanup is harmless; the next restore will apply maxAge/buster.
    }
  },
};
