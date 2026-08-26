import { QueryClient } from '@tanstack/react-query';
import { get, set, del } from 'idb-keyval';
import { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import { classifyError } from "./queryErrors";

export const queryRetryPolicy = (failureCount: number, error: unknown) => {
  const classified = classifyError(error);
  if (!classified.retryable) return false;
  return failureCount < 3;
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: queryRetryPolicy,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
      refetchOnWindowFocus: true,
      staleTime: 30000,
    },
    mutations: {
      retry: queryRetryPolicy,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    },
  },
});

export const createIndexedDBPersister = (idbValidKey: IDBValidKey = 'reactQuery'): Persister => {
  return {
    persistClient: async (client: PersistedClient) => {
      try {
        await set(idbValidKey, client);
      } catch (error) {
        console.error('Error persisting query client:', error);
      }
    },
    restoreClient: async () => {
      try {
        return await get<PersistedClient>(idbValidKey);
      } catch (error) {
        console.error('Error restoring query client:', error);
        return undefined;
      }
    },
    removeClient: async () => {
      try {
        await del(idbValidKey);
      } catch (error) {
        console.error('Error removing query client:', error);
      }
    },
  };
};

export const persister = createIndexedDBPersister();
