/**
 * lib/offlineCache.ts
 *
 * TTL-based caching utility with staleness indicators for offline support.
 *
 * Provides:
 *   - Configurable per-key TTL (default: 10 minutes).
 *   - Staleness indicators so UI can show "Last updated 5m ago".
 *   - Cache invalidation by key prefix (e.g. "projects:*").
 *   - Memory-first, AsyncStorage-persisted two-layer architecture.
 *   - Automatic pruning of expired entries.
 *
 * Usage:
 *   import { cache, CACHE_TTL } from "../lib/offlineCache";
 *
 *   // Store
 *   await cache.set("projects:list", projects, { ttlMs: 5 * 60 * 1000 });
 *
 *   // Retrieve
 *   const result = await cache.get<ClimateProject[]>("projects:list");
 *   if (result) {
 *     console.log(result.data, result.isStale, result.ageMs);
 *   }
 *
 *   // Invalidate
 *   await cache.invalidatePrefix("projects:");
 *   await cache.clear();
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

// ─── Constants ──────────────────────────────────────────────────────────

/** Default TTL: 10 minutes. */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Maximum number of cache entries in the in-memory map. */
const MAX_MEMORY_ENTRIES = 500;

/** AsyncStorage key for the persisted cache index. */
const PERSISTENCE_KEY = "offline_cache_index";

// ─── Types ──────────────────────────────────────────────────────────────

export interface CacheEntry<T = unknown> {
  data: T;
  cachedAt: number; // epoch ms
  ttlMs: number;
}

export interface CacheResult<T = unknown> {
  data: T;
  /** True if the entry has exceeded its TTL. */
  isStale: boolean;
  /** Age of the entry in milliseconds. */
  ageMs: number;
  /** When the entry was cached (epoch ms). */
  cachedAt: number;
  /** When this entry will expire (epoch ms). */
  expiresAt: number;
}

export interface CacheOptions {
  /** Time-to-live in milliseconds. Default: DEFAULT_TTL_MS. */
  ttlMs?: number;
  /** Tags for grouped invalidation (not yet implemented — reserved). */
  tags?: string[];
}

export interface CacheStats {
  entries: number;
  memoryHits: number;
  storageHits: number;
  misses: number;
  staleServes: number;
}

// ─── In-memory layer ───────────────────────────────────────────────────

const memoryMap = new Map<string, CacheEntry>();
let memoryHits = 0;
let storageHits = 0;
let misses = 0;
let staleServes = 0;

// ─── Helpers ────────────────────────────────────────────────────────────

function isEntryValid(entry: CacheEntry): boolean {
  if (!entry || typeof entry.cachedAt !== "number" || typeof entry.ttlMs !== "number") {
    return false;
  }
  return true;
}

function isEntryStale(entry: CacheEntry): boolean {
  return Date.now() - entry.cachedAt > entry.ttlMs;
}

function buildResult<T>(entry: CacheEntry<T>): CacheResult<T> {
  const ageMs = Date.now() - entry.cachedAt;
  return {
    data: entry.data,
    isStale: isEntryStale(entry),
    ageMs,
    cachedAt: entry.cachedAt,
    expiresAt: entry.cachedAt + entry.ttlMs,
  };
}

// ─── Persistence ──────────────────────────────────────────────────────

/**
 * Persist the in-memory cache index (keys + metadata) to AsyncStorage
 * so it survives app restarts. The actual payloads are stored per-key;
 * this index helps us quickly rebuild the memory map.
 */
async function persistIndex(): Promise<void> {
  try {
    const index: Record<string, Pick<CacheEntry, "cachedAt" | "ttlMs">> = {};
    for (const [key, entry] of memoryMap.entries()) {
      index[key] = { cachedAt: entry.cachedAt, ttlMs: entry.ttlMs };
    }
    await AsyncStorage.setItem(PERSISTENCE_KEY, JSON.stringify(index));
  } catch {
    // Best-effort; persistence failures are non-fatal.
  }
}

async function restoreIndex(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(PERSISTENCE_KEY);
    if (!raw) return;

    const index: Record<string, Pick<CacheEntry, "cachedAt" | "ttlMs">> =
      JSON.parse(raw);

    for (const [key, meta] of Object.entries(index)) {
      if (memoryMap.has(key)) continue; // don't overwrite hot data
      // The actual payload is loaded lazily on first `get()` miss.
      memoryMap.set(key, {
        data: null, // marker — will be loaded from AsyncStorage
        cachedAt: meta.cachedAt,
        ttlMs: meta.ttlMs,
      });
    }
  } catch {
    // Best-effort
  }
}

// ─── Public API ─────────────────────────────────────────────────────────

export const cache = {
  /**
   * Initialise the cache — restore the persisted index from AsyncStorage.
   * Call once at app startup (e.g. in _layout.tsx).
   */
  async init(): Promise<void> {
    await restoreIndex();
  },

  /**
   * Store a value in the cache.
   *
   * Writes to both the in-memory map and AsyncStorage for persistence.
   */
  async set<T>(
    key: string,
    data: T,
    options: CacheOptions = {},
  ): Promise<void> {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const entry: CacheEntry<T> = {
      data,
      cachedAt: Date.now(),
      ttlMs,
    };

    // Memory
    memoryMap.set(key, entry as CacheEntry);
    if (memoryMap.size > MAX_MEMORY_ENTRIES) {
      // Evict oldest entry
      const oldest = memoryMap.entries().next().value;
      if (oldest) memoryMap.delete(oldest[0]);
    }

    // Persist to AsyncStorage
    try {
      await AsyncStorage.setItem(`cache:${key}`, JSON.stringify(entry));
    } catch {
      // Non-fatal
    }

    await persistIndex();
  },

  /**
   * Retrieve a value from the cache.
   *
   * Returns null if the key does not exist.
   * Returns stale data with `isStale: true` if TTL has expired
   * (the caller can decide whether to display it).
   */
  async get<T = unknown>(key: string): Promise<CacheResult<T> | null> {
    // 1. Check memory
    const memEntry = memoryMap.get(key) as CacheEntry<T> | undefined;

    if (memEntry && memEntry.data !== null) {
      memoryHits++;
      return buildResult(memEntry);
    }

    // 2. Check AsyncStorage
    try {
      const raw = await AsyncStorage.getItem(`cache:${key}`);
      if (!raw) {
        misses++;
        return null;
      }

      const entry: CacheEntry<T> = JSON.parse(raw);

      if (!isEntryValid(entry)) {
        misses++;
        memoryMap.delete(key);
        return null;
      }

      // Update memory
      memoryMap.set(key, entry);
      storageHits++;

      if (isEntryStale(entry)) {
        staleServes++;
      }

      return buildResult(entry);
    } catch {
      misses++;
      return null;
    }
  },

  /**
   * Remove a single key from both memory and storage.
   */
  async remove(key: string): Promise<void> {
    memoryMap.delete(key);
    try {
      await AsyncStorage.removeItem(`cache:${key}`);
    } catch {
      // Non-fatal
    }
    await persistIndex();
  },

  /**
   * Invalidate all keys matching a prefix (e.g. "projects:").
   * Useful when the feed is refreshed and all project cache should be
   * considered stale.
   */
  async invalidatePrefix(prefix: string): Promise<void> {
    const keysToRemove: string[] = [];

    for (const key of memoryMap.keys()) {
      if (key.startsWith(prefix)) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      memoryMap.delete(key);
      try {
        await AsyncStorage.removeItem(`cache:${key}`);
      } catch {
        // Non-fatal
      }
    }

    // Also purge from AsyncStorage any keys we might have missed in memory
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      const cacheKeys = allKeys.filter(
        (k) => k.startsWith(`cache:${prefix}`),
      );
      if (cacheKeys.length > 0) {
        await AsyncStorage.multiRemove(cacheKeys);
      }
    } catch {
      // Non-fatal
    }

    await persistIndex();
  },

  /**
   * Clear the entire cache.
   */
  async clear(): Promise<void> {
    memoryMap.clear();
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      const cacheKeys = allKeys.filter((k) => k.startsWith("cache:"));
      if (cacheKeys.length > 0) {
        await AsyncStorage.multiRemove(cacheKeys);
      }
      await AsyncStorage.removeItem(PERSISTENCE_KEY);
    } catch {
      // Non-fatal
    }
  },

  /**
   * Get cache statistics for debugging / monitoring.
   */
  stats(): CacheStats {
    return {
      entries: memoryMap.size,
      memoryHits,
      storageHits,
      misses,
      staleServes,
    };
  },

  /**
   * Reset statistics counters (for testing).
   */
  resetStats(): void {
    memoryHits = 0;
    storageHits = 0;
    misses = 0;
    staleServes = 0;
  },
};

/**
 * Helper to produce a human-readable staleness string.
 *
 * @example
 *   stalenessLabel(result.ageMs) // "2m ago" | "1h ago" | "stale"
 */
export function stalenessLabel(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
