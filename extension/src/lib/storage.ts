/**
 * extension/src/lib/storage.ts
 *
 * Versioned, quota-aware persistence layer for `chrome.storage.local`.
 *
 * Introduced for issue #909 — the extension previously wrote directly to
 * `chrome.storage.*` with no schema versioning, no quota budgeting, and no
 * integrity verification (see `chrome.storage.local.set` calls in
 * `background.ts`/`popup.ts` and `chrome.storage.sync.set` in `settings.ts`).
 * That ad hoc usage is left untouched — this module is additive
 * infrastructure that new/updated features can build on, and that
 * `runStartupIntegrityCheck()` protects proactively from the background
 * service worker on every extension startup.
 *
 * Design summary:
 *  - Data lives in three typed namespaces: `settings`, `cache`, `pendingOps`.
 *  - Each namespace is stored as a single `StorageRecord<T>` envelope under
 *    its own `chrome.storage.local` key, carrying a schema version, a
 *    monotonic write counter, and (for the `settings` namespace only, since
 *    it holds critical/user-authored data) an integrity checksum.
 *  - `runMigrations` advances a namespace's `data` through an ordered list
 *    of `MigrationStep`s, persisting after every step so a crash mid-run
 *    resumes from the last completed step on the next startup rather than
 *    re-running (or losing) earlier steps.
 *  - `writeNamespace` implements a guarded read-verify-write: it re-reads
 *    the record immediately before committing and retries (reapplying the
 *    caller's updater against the fresh data) if another tab wrote in the
 *    meantime, so concurrent tabs never blindly clobber each other.
 *  - `runStartupIntegrityCheck` validates each namespace's shape and
 *    checksum, quarantining (backing up, then resetting) any namespace
 *    that looks corrupt or partially written, and logs what happened via
 *    `console.log`/`console.warn` — consistent with the existing
 *    `[IndigoPay ...]`-prefixed logging already used in this codebase
 *    (see `background.ts`, `popup.ts`).
 */

// ── namespaces & record shape ───────────────────────────────────────────

export type StorageNamespace = "settings" | "cache" | "pendingOps";

const ALL_NAMESPACES: StorageNamespace[] = ["settings", "cache", "pendingOps"];

/** The schema version new/migrated records are written at. */
export const CURRENT_SCHEMA_VERSION = 3;

export interface CacheEntry {
  value: unknown;
  /** Approximate serialized size in bytes, used for quota accounting. */
  size: number;
  lastAccessed: number;
}

export interface PendingOp {
  id: string;
  type: string;
  payload: unknown;
  createdAt: number;
}

/** The `data` shape stored in each namespace. */
export interface NamespaceDataMap {
  settings: Record<string, unknown>;
  cache: Record<string, CacheEntry>;
  pendingOps: PendingOp[];
}

/** The on-disk envelope every namespace is wrapped in. */
export interface StorageRecord<T = unknown> {
  schemaVersion: number;
  /** Monotonic counter bumped on every successful `writeNamespace` call. */
  writeVersion: number;
  updatedAt: number;
  /** Integrity checksum — only ever set for the `settings` namespace. */
  checksum?: string;
  data: T;
}

// ── quota budgets ────────────────────────────────────────────────────────

/**
 * Per-namespace byte budgets, well within `chrome.storage.local`'s 10MB
 * default quota. `cache` is evictable (LRU) so it can safely absorb
 * unbounded traffic; `settings` and `pendingOps` hold data the extension
 * cannot silently lose, so writes that would exceed budget hard-fail
 * instead of being trimmed.
 */
export const NAMESPACE_QUOTA_BYTES: Record<StorageNamespace, number> = {
  settings: 50 * 1024,
  cache: 2 * 1024 * 1024,
  pendingOps: 256 * 1024,
};

// ── errors ───────────────────────────────────────────────────────────────

export class StorageQuotaExceededError extends Error {
  constructor(
    public readonly namespace: StorageNamespace,
    public readonly attemptedBytes: number,
    public readonly limitBytes: number,
  ) {
    super(
      `Storage quota exceeded for "${namespace}" namespace: attempted ${attemptedBytes} bytes, limit is ${limitBytes} bytes.`,
    );
    this.name = "StorageQuotaExceededError";
  }
}

export class StorageWriteConflictError extends Error {
  constructor(
    public readonly namespace: StorageNamespace,
    public readonly attempts: number,
  ) {
    super(
      `Write to "${namespace}" namespace conflicted with a concurrent write ${attempts} time(s) in a row; giving up.`,
    );
    this.name = "StorageWriteConflictError";
  }
}

/**
 * Turn a storage error into a short, user-presentable message. Intended
 * for the same UI error surfaces already used in this codebase (e.g. the
 * `saveStatus` element in `settings.ts`, which renders `err.message`
 * directly on a failed save).
 */
export function describeStorageError(err: unknown): string {
  if (err instanceof StorageQuotaExceededError) {
    return `Storage limit reached (${Math.ceil(err.limitBytes / 1024)}KB max for "${err.namespace}"). Free up space and try again.`;
  }
  if (err instanceof StorageWriteConflictError) {
    return "Another tab just updated this data. Please try again.";
  }
  if (err instanceof Error) return err.message;
  return "Unknown storage error.";
}

// ── low-level chrome.storage.local helpers ──────────────────────────────

function storageGet<T = Record<string, unknown>>(
  keys: string[] | string | null,
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys as any, (items: Record<string, unknown>) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(items as T);
    });
  });
}

function storageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

// ── keys ─────────────────────────────────────────────────────────────────

const STORAGE_KEY_PREFIX = "indigopay:storage:";

export function namespaceKey(namespace: StorageNamespace): string {
  return `${STORAGE_KEY_PREFIX}${namespace}`;
}

export function quarantineKeyPrefix(namespace: StorageNamespace): string {
  return `indigopay:quarantine:${namespace}:`;
}

function quarantineKey(namespace: StorageNamespace, timestamp: number): string {
  return `${quarantineKeyPrefix(namespace)}${timestamp}`;
}

// ── size & checksum helpers ──────────────────────────────────────────────

function byteSize(value: unknown): number {
  const json = JSON.stringify(value) ?? "";
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(json).length;
  }
  return json.length;
}

/**
 * Deterministic FNV-1a hash of a value's JSON serialization, used as a
 * lightweight integrity checksum. Not cryptographic — it only needs to
 * detect accidental corruption/partial writes/tampering of critical
 * settings, not resist a motivated adversary.
 */
function computeChecksum(data: unknown): string {
  const json = JSON.stringify(data) ?? "";
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function defaultDataFor<K extends StorageNamespace>(namespace: K): NamespaceDataMap[K] {
  switch (namespace) {
    case "settings":
      return {} as NamespaceDataMap[K];
    case "cache":
      return {} as NamespaceDataMap[K];
    case "pendingOps":
      return [] as unknown as NamespaceDataMap[K];
    default:
      throw new Error(`Unknown storage namespace: ${namespace}`);
  }
}

function isValidRecordShape(record: unknown): record is StorageRecord {
  if (!record || typeof record !== "object") return false;
  const r = record as Record<string, unknown>;
  return (
    typeof r.schemaVersion === "number" &&
    typeof r.writeVersion === "number" &&
    typeof r.updatedAt === "number" &&
    "data" in r
  );
}

/**
 * Read a namespace's record, falling back to a fresh (unversioned) default
 * record if nothing is stored yet, or if what's stored doesn't even look
 * like a valid envelope (defense in depth — the authoritative corruption
 * handling lives in `runStartupIntegrityCheck`, but every read path stays
 * safe on its own too).
 */
async function readRawRecord<K extends StorageNamespace>(
  namespace: K,
): Promise<StorageRecord<NamespaceDataMap[K]>> {
  const key = namespaceKey(namespace);
  const result = await storageGet<Record<string, unknown>>([key]);
  const existing = result[key];
  if (isValidRecordShape(existing)) {
    return existing as StorageRecord<NamespaceDataMap[K]>;
  }
  return {
    schemaVersion: 0,
    writeVersion: 0,
    updatedAt: Date.now(),
    data: defaultDataFor(namespace),
  };
}

// ── migrations ───────────────────────────────────────────────────────────

export interface MigrationStep<T> {
  /** Schema version this step upgrades the namespace's data TO. */
  version: number;
  migrate: (data: T) => T;
}

const SETTINGS_MIGRATIONS: MigrationStep<NamespaceDataMap["settings"]>[] = [
  { version: 1, migrate: (data) => ({ ...data }) },
  // v2 introduced a `theme` preference; default existing users to "system".
  { version: 2, migrate: (data) => ({ theme: "system", ...data }) },
  // v3 introduced a `notificationsEnabled` preference.
  { version: 3, migrate: (data) => ({ notificationsEnabled: true, ...data }) },
];

// `cache` and `pendingOps` have no structural schema changes yet, but their
// migration chains are kept in lockstep with CURRENT_SCHEMA_VERSION (via
// identity steps) so that a namespace freshly initialized by
// `runStartupIntegrityCheck` lands on the current version rather than
// being perpetually reported as needing migration.
const CACHE_MIGRATIONS: MigrationStep<NamespaceDataMap["cache"]>[] = [
  { version: 1, migrate: (data) => ({ ...data }) },
  { version: 2, migrate: (data) => ({ ...data }) },
  { version: 3, migrate: (data) => ({ ...data }) },
];

const PENDING_OPS_MIGRATIONS: MigrationStep<NamespaceDataMap["pendingOps"]>[] = [
  { version: 1, migrate: (data) => [...data] },
  { version: 2, migrate: (data) => [...data] },
  { version: 3, migrate: (data) => [...data] },
];

export const NAMESPACE_MIGRATIONS: {
  [K in StorageNamespace]: MigrationStep<NamespaceDataMap[K]>[];
} = {
  settings: SETTINGS_MIGRATIONS,
  cache: CACHE_MIGRATIONS,
  pendingOps: PENDING_OPS_MIGRATIONS,
};

/**
 * Advance a namespace's stored data through every migration step whose
 * `version` is greater than the record's current `schemaVersion`, applied
 * in ascending order. Persists after each individual step, so:
 *  - Re-running when already at/above the target version is a no-op
 *    (idempotent) — no steps are pending, nothing is written.
 *  - If the process crashes/is terminated partway through, the next call
 *    (e.g. on the next extension startup) resumes from the last
 *    successfully-persisted step rather than re-applying earlier steps or
 *    losing progress.
 */
export async function runMigrations<K extends StorageNamespace>(
  namespace: K,
  migrations: MigrationStep<NamespaceDataMap[K]>[] = NAMESPACE_MIGRATIONS[namespace],
): Promise<StorageRecord<NamespaceDataMap[K]>> {
  const key = namespaceKey(namespace);
  let record = await readRawRecord(namespace);

  const pending = migrations
    .filter((step) => step.version > record.schemaVersion)
    .sort((a, b) => a.version - b.version);

  for (const step of pending) {
    const migratedData = step.migrate(record.data);
    record = {
      ...record,
      schemaVersion: step.version,
      writeVersion: record.writeVersion + 1,
      data: migratedData,
      updatedAt: Date.now(),
      checksum: namespace === "settings" ? computeChecksum(migratedData) : undefined,
    };
    await storageSet({ [key]: record });
  }

  return record;
}

// ── quota enforcement ────────────────────────────────────────────────────

function evictLruUntilFits(
  cache: NamespaceDataMap["cache"],
  limit: number,
): NamespaceDataMap["cache"] {
  const entries = Object.entries(cache);
  let totalSize = entries.reduce((sum, [, entry]) => sum + entry.size, 0);
  if (totalSize <= limit) return cache;

  const byLeastRecentlyUsed = [...entries].sort(
    (a, b) => a[1].lastAccessed - b[1].lastAccessed,
  );
  const result: NamespaceDataMap["cache"] = { ...cache };
  for (const [key, entry] of byLeastRecentlyUsed) {
    if (totalSize <= limit) break;
    delete result[key];
    totalSize -= entry.size;
  }
  return result;
}

function enforceQuota<K extends StorageNamespace>(
  namespace: K,
  data: NamespaceDataMap[K],
): NamespaceDataMap[K] {
  const limit = NAMESPACE_QUOTA_BYTES[namespace];
  if (namespace === "cache") {
    const evicted = evictLruUntilFits(data as NamespaceDataMap["cache"], limit);
    return evicted as NamespaceDataMap[K];
  }
  const size = byteSize(data);
  if (size > limit) {
    throw new StorageQuotaExceededError(namespace, size, limit);
  }
  return data;
}

// ── guarded (concurrency-safe) writes ────────────────────────────────────

export interface WriteOptions {
  /** Number of times to retry after a detected concurrent write. */
  maxRetries?: number;
}

/**
 * Read-verify-write a namespace: `updater` is applied to the current data
 * to produce the next value, which is then quota-checked and persisted —
 * but only after re-reading the record immediately beforehand to confirm
 * no other tab wrote a newer `writeVersion` in the interim. If it did,
 * `updater` is re-applied against the fresh data and the check repeats
 * (up to `maxRetries`), so two tabs writing at once merge rather than one
 * silently clobbering the other.
 */
export async function writeNamespace<K extends StorageNamespace>(
  namespace: K,
  updater: (current: NamespaceDataMap[K]) => NamespaceDataMap[K],
  options: WriteOptions = {},
): Promise<StorageRecord<NamespaceDataMap[K]>> {
  const key = namespaceKey(namespace);
  const maxRetries = options.maxRetries ?? 3;

  let baseline = await readRawRecord(namespace);
  // A namespace whose data never passed through the migration chain must
  // not have CURRENT_SCHEMA_VERSION stamped onto it here — that would
  // report it as already migrated and permanently skip the pending steps
  // (see `checkAndRecoverNamespace`). Run migrations first so `baseline`
  // (and therefore the version this write stamps) is genuinely current.
  if (baseline.schemaVersion < CURRENT_SCHEMA_VERSION) {
    baseline = await runMigrations(namespace);
  }
  let attempt = 0;

  for (;;) {
    const candidateData = enforceQuota(namespace, updater(baseline.data));

    const candidateRecord: StorageRecord<NamespaceDataMap[K]> = {
      schemaVersion: baseline.schemaVersion,
      writeVersion: baseline.writeVersion + 1,
      updatedAt: Date.now(),
      checksum: namespace === "settings" ? computeChecksum(candidateData) : undefined,
      data: candidateData,
    };

    // Guard: re-read right before committing to catch a write that landed
    // from another tab between our initial read and now.
    const latest = await readRawRecord(namespace);
    if (latest.writeVersion !== baseline.writeVersion) {
      attempt += 1;
      if (attempt > maxRetries) {
        throw new StorageWriteConflictError(namespace, attempt - 1);
      }
      baseline =
        latest.schemaVersion < CURRENT_SCHEMA_VERSION ? await runMigrations(namespace) : latest;
      continue;
    }

    await storageSet({ [key]: candidateRecord });
    return candidateRecord;
  }
}

// ── namespace-specific convenience APIs ──────────────────────────────────

export async function getStorageSettings(): Promise<NamespaceDataMap["settings"]> {
  const record = await readRawRecord("settings");
  return record.data;
}

export async function updateStorageSettings(
  patch: Record<string, unknown>,
): Promise<StorageRecord<NamespaceDataMap["settings"]>> {
  return writeNamespace("settings", (current) => ({ ...current, ...patch }));
}

/**
 * Cache a value under `key`. Returns `false` (without writing anything)
 * if the value alone is larger than the entire cache budget — eviction
 * can never make room for a payload that big, so we refuse it up front
 * instead of evicting every other cache entry for no benefit.
 */
export async function setCacheEntry(key: string, value: unknown): Promise<boolean> {
  const size = byteSize(value);
  const limit = NAMESPACE_QUOTA_BYTES.cache;
  if (size > limit) {
    console.warn(
      `[IndigoPay Storage] Refusing to cache "${key}": ${size} bytes exceeds the ${limit} byte cache budget.`,
    );
    return false;
  }

  await writeNamespace("cache", (current) => ({
    ...current,
    [key]: { value, size, lastAccessed: Date.now() },
  }));
  return true;
}

export async function getCacheEntry(key: string): Promise<unknown | undefined> {
  const record = await readRawRecord("cache");
  const entry = record.data[key];
  if (!entry) return undefined;
  // Best-effort LRU touch so evictLruUntilFits actually orders by last
  // access rather than last write; a failed refresh must not fail the read.
  void writeNamespace("cache", (current) =>
    current[key] ? { ...current, [key]: { ...current[key], lastAccessed: Date.now() } } : current,
  ).catch(() => {});
  return entry.value;
}

export async function enqueuePendingOp(
  op: Omit<PendingOp, "createdAt">,
): Promise<StorageRecord<NamespaceDataMap["pendingOps"]>> {
  return writeNamespace("pendingOps", (current) => [
    ...current,
    { ...op, createdAt: Date.now() },
  ]);
}

export async function dequeuePendingOp(
  id: string,
): Promise<StorageRecord<NamespaceDataMap["pendingOps"]>> {
  return writeNamespace("pendingOps", (current) =>
    current.filter((op) => op.id !== id),
  );
}

export async function getPendingOps(): Promise<NamespaceDataMap["pendingOps"]> {
  const record = await readRawRecord("pendingOps");
  return record.data;
}

// ── startup integrity check ──────────────────────────────────────────────

export type IntegrityStatus = "ok" | "initialized" | "migrated" | "quarantined";

export interface IntegrityReport {
  namespace: StorageNamespace;
  status: IntegrityStatus;
  detail: string;
}

/**
 * Back up a corrupt/tampered record under a timestamped quarantine key
 * (never destroyed automatically — it's left for forensics/manual
 * recovery) and reset the live namespace key to a known-good default so
 * the extension keeps working. Other namespaces are untouched.
 */
async function quarantineNamespace(
  namespace: StorageNamespace,
  corrupt: unknown,
): Promise<void> {
  const backupKey = quarantineKey(namespace, Date.now());
  await storageSet({ [backupKey]: corrupt });

  const key = namespaceKey(namespace);
  const data = defaultDataFor(namespace);
  // Reset at schemaVersion 0 and run the reset data through the migration
  // chain (rather than stamping CURRENT_SCHEMA_VERSION directly) so a
  // quarantined `settings` namespace regains its migrated defaults (e.g.
  // v2's `theme`, v3's `notificationsEnabled`) instead of resetting to a
  // bare `{}`.
  const fresh: StorageRecord = {
    schemaVersion: 0,
    writeVersion: 0,
    updatedAt: Date.now(),
    checksum: undefined,
    data,
  };
  await storageSet({ [key]: fresh });
  await runMigrations(namespace);
}

function logIntegrityReport(report: IntegrityReport): void {
  const prefix = "[IndigoPay Storage]";
  if (report.status === "quarantined") {
    console.warn(`${prefix} Quarantined "${report.namespace}" namespace: ${report.detail}`);
  } else if (report.status === "migrated") {
    console.log(`${prefix} Migrated "${report.namespace}" namespace: ${report.detail}`);
  } else if (report.status === "initialized") {
    console.log(`${prefix} Initialized "${report.namespace}" namespace: ${report.detail}`);
  }
  // "ok" is intentionally not logged, to avoid noise on every startup.
}

async function checkAndRecoverNamespace(
  namespace: StorageNamespace,
): Promise<IntegrityReport> {
  const key = namespaceKey(namespace);
  const result = await storageGet<Record<string, unknown>>([key]);
  const raw = result[key];

  if (raw === undefined) {
    // First run, or the browser wiped storage — this is not corruption,
    // just an empty slate. Initialize defaults gracefully.
    await runMigrations(namespace);
    return {
      namespace,
      status: "initialized",
      detail: "No prior data found; initialized defaults.",
    };
  }

  if (!isValidRecordShape(raw)) {
    await quarantineNamespace(namespace, raw);
    return {
      namespace,
      status: "quarantined",
      detail: "Stored record did not match the expected shape (corrupt or partial write).",
    };
  }

  const record = raw as StorageRecord;
  // `settings` is the namespace the design protects with a checksum (see
  // the module doc comment), so a record missing that field there is
  // itself an integrity failure, not just a mismatch to check for when
  // present — otherwise dropping the field would silently defeat the
  // stamp.
  const requiresChecksum = namespace === "settings";
  if (requiresChecksum || typeof record.checksum === "string") {
    const expected = computeChecksum(record.data);
    if (expected !== record.checksum) {
      await quarantineNamespace(namespace, raw);
      return {
        namespace,
        status: "quarantined",
        detail:
          typeof record.checksum === "string"
            ? "Checksum mismatch — data was tampered with or partially written."
            : "Checksum missing on a checksum-protected namespace.",
      };
    }
  }

  if (record.schemaVersion < CURRENT_SCHEMA_VERSION) {
    const migrated = await runMigrations(namespace);
    return {
      namespace,
      status: "migrated",
      detail: `Migrated from schema v${record.schemaVersion} to v${migrated.schemaVersion}.`,
    };
  }

  return { namespace, status: "ok", detail: "Valid." };
}

/**
 * Validate every namespace on startup: check record shape and (for
 * `settings`) checksum, quarantine anything corrupt, and run any pending
 * migrations. Safe to call multiple times (e.g. once per background
 * service worker wake) — a namespace already at the current schema
 * version with a valid checksum is a fast no-op.
 */
export async function runStartupIntegrityCheck(): Promise<IntegrityReport[]> {
  const reports: IntegrityReport[] = [];
  for (const namespace of ALL_NAMESPACES) {
    const report = await checkAndRecoverNamespace(namespace);
    reports.push(report);
    logIntegrityReport(report);
  }
  return reports;
}
