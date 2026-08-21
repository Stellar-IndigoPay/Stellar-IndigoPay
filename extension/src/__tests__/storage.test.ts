/**
 * Tests for the versioned storage layer in src/lib/storage.ts.
 *
 * Covers: migration ordering/idempotence + crash-resume, quota
 * enforcement + LRU eviction, the concurrent-write guard, and startup
 * corruption detection/quarantine/recovery. `chrome.storage.local` is
 * mocked in-memory here (jest.setup.js's default mock is a no-op stub,
 * which isn't enough to exercise read-modify-write behavior).
 */

import {
  CURRENT_SCHEMA_VERSION,
  NAMESPACE_QUOTA_BYTES,
  StorageQuotaExceededError,
  StorageWriteConflictError,
  describeStorageError,
  dequeuePendingOp,
  enqueuePendingOp,
  getCacheEntry,
  getPendingOps,
  getStorageSettings,
  namespaceKey,
  quarantineKeyPrefix,
  runMigrations,
  runStartupIntegrityCheck,
  setCacheEntry,
  updateStorageSettings,
  writeNamespace,
  type CacheEntry,
  type StorageRecord,
} from "../lib/storage";

// ── in-memory chrome.storage.local mock ──────────────────────────────

let store: Record<string, unknown>;

function installStorageMock() {
  store = {};

  (chrome.storage.local.get as jest.Mock).mockImplementation(
    (keys: string[] | string | null, callback: (items: Record<string, unknown>) => void) => {
      const result: Record<string, unknown> = {};
      const keyList = keys === null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) {
        if (key in store) result[key] = store[key];
      }
      callback(result);
    },
  );

  (chrome.storage.local.set as jest.Mock).mockImplementation(
    (items: Record<string, unknown>, callback?: () => void) => {
      Object.assign(store, items);
      if (callback) callback();
    },
  );

  (chrome.storage.local.remove as jest.Mock).mockImplementation(
    (keys: string[] | string, callback?: () => void) => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) delete store[key];
      if (callback) callback();
    },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  installStorageMock();
  (globalThis as any).chrome.runtime.lastError = null;
});

// ── migrations ────────────────────────────────────────────────────────

describe("runMigrations", () => {
  test("applies v1 -> v2 -> v3 steps in order on a brand-new namespace", async () => {
    const order: number[] = [];
    const record = await runMigrations("settings", [
      { version: 1, migrate: (data) => { order.push(1); return { ...data, step1: true }; } },
      { version: 2, migrate: (data) => { order.push(2); return { ...data, step2: true }; } },
      { version: 3, migrate: (data) => { order.push(3); return { ...data, step3: true }; } },
    ]);

    expect(order).toEqual([1, 2, 3]);
    expect(record.schemaVersion).toBe(3);
    expect(record.data).toEqual({ step1: true, step2: true, step3: true });
  });

  test("applies out-of-order-declared steps by ascending version, not declaration order", async () => {
    const order: number[] = [];
    await runMigrations("settings", [
      { version: 3, migrate: (data) => { order.push(3); return data; } },
      { version: 1, migrate: (data) => { order.push(1); return data; } },
      { version: 2, migrate: (data) => { order.push(2); return data; } },
    ]);

    expect(order).toEqual([1, 2, 3]);
  });

  test("is idempotent: re-running once fully migrated performs no writes", async () => {
    const migrations = [
      { version: 1, migrate: (data: any) => ({ ...data, a: 1 }) },
      { version: 2, migrate: (data: any) => ({ ...data, b: 2 }) },
    ];

    await runMigrations("settings", migrations);
    (chrome.storage.local.set as jest.Mock).mockClear();

    const second = await runMigrations("settings", migrations);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(second.data).toEqual({ a: 1, b: 2 });
  });

  test("crash-resume: resumes from the last persisted step without re-applying earlier steps", async () => {
    let step1Calls = 0;
    const migrations = [
      { version: 1, migrate: (data: any) => { step1Calls += 1; return { ...data, counter: (data.counter || 0) + 1 }; } },
      { version: 2, migrate: (data: any) => ({ ...data, upgraded: true }) },
      { version: 3, migrate: (data: any) => ({ ...data, finalized: true }) },
    ];

    // Simulate a prior process that completed step 1 and persisted it,
    // then crashed before running step 2.
    const key = namespaceKey("settings");
    store[key] = {
      schemaVersion: 1,
      writeVersion: 0,
      updatedAt: Date.now(),
      data: { counter: 1 },
    } as StorageRecord;

    const result = await runMigrations("settings", migrations);

    expect(step1Calls).toBe(0); // step 1 was NOT re-applied
    expect(result.schemaVersion).toBe(3);
    expect(result.data).toEqual({ counter: 1, upgraded: true, finalized: true });
  });

  test("persists after every individual step (not just at the end)", async () => {
    const migrations = [
      { version: 1, migrate: (data: any) => ({ ...data, a: 1 }) },
      { version: 2, migrate: (data: any) => ({ ...data, b: 2 }) },
    ];

    await runMigrations("settings", migrations);
    // 2 steps => 2 separate persisted writes.
    expect((chrome.storage.local.set as jest.Mock).mock.calls.length).toBe(2);
  });

  test("uses the real default migration registry to reach CURRENT_SCHEMA_VERSION", async () => {
    const record = await runMigrations("settings");
    expect(record.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(record.data).toMatchObject({ theme: "system", notificationsEnabled: true });
  });
});

// ── quota enforcement ─────────────────────────────────────────────────

describe("quota enforcement", () => {
  test("settings write hard-fails when it would exceed the settings budget", async () => {
    // Seed an already-migrated baseline so this test exercises only quota
    // enforcement, not the (separately covered) migrate-before-write path
    // that `writeNamespace` runs for a namespace still behind
    // CURRENT_SCHEMA_VERSION.
    await writeNamespace("settings", (current) => ({
      ...current,
      backendUrl: "https://ok.example.com",
    }));

    const huge = "x".repeat(NAMESPACE_QUOTA_BYTES.settings + 1);
    await expect(
      writeNamespace("settings", (current) => ({ ...current, huge })),
    ).rejects.toThrow(StorageQuotaExceededError);

    // The over-budget write was rejected — prior good data is untouched.
    const key = namespaceKey("settings");
    const record = store[key] as StorageRecord;
    expect(record.data).toEqual({
      backendUrl: "https://ok.example.com",
      theme: "system",
      notificationsEnabled: true,
    });
  });

  test("StorageQuotaExceededError produces a user-facing message via describeStorageError", async () => {
    const huge = "x".repeat(NAMESPACE_QUOTA_BYTES.settings + 1);
    try {
      await writeNamespace("settings", () => ({ huge }));
      throw new Error("expected quota error");
    } catch (err) {
      expect(err).toBeInstanceOf(StorageQuotaExceededError);
      expect(describeStorageError(err)).toMatch(/storage limit reached/i);
    }
  });

  test("pendingOps write hard-fails when it would exceed its budget", async () => {
    const bigPayload = "y".repeat(NAMESPACE_QUOTA_BYTES.pendingOps);
    await expect(
      enqueuePendingOp({ id: "op-1", type: "donate", payload: bigPayload }),
    ).rejects.toThrow(StorageQuotaExceededError);
  });

  test("cache eviction: LRU (least-recently-accessed) entries are evicted first when over budget", async () => {
    const entrySize = Math.floor(NAMESPACE_QUOTA_BYTES.cache / 3) + 1000; // 3 entries won't all fit

    await writeNamespace("cache", () => ({
      old: { value: "a", size: entrySize, lastAccessed: 1000 } as CacheEntry,
    }));
    await writeNamespace("cache", (current) => ({
      ...current,
      middle: { value: "b", size: entrySize, lastAccessed: 2000 } as CacheEntry,
    }));
    const record = await writeNamespace("cache", (current) => ({
      ...current,
      newest: { value: "c", size: entrySize, lastAccessed: 3000 } as CacheEntry,
    }));

    // "old" (lastAccessed: 1000) should have been evicted first.
    expect(record.data.old).toBeUndefined();
    expect(record.data.newest).toBeDefined();

    const totalSize = Object.values(record.data).reduce((sum, e) => sum + e.size, 0);
    expect(totalSize).toBeLessThanOrEqual(NAMESPACE_QUOTA_BYTES.cache);
  });

  test("setCacheEntry refuses a single payload larger than the entire cache budget", async () => {
    const tooBig = { blob: "z".repeat(NAMESPACE_QUOTA_BYTES.cache + 1) };
    const accepted = await setCacheEntry("huge-key", tooBig);
    expect(accepted).toBe(false);
    expect(await getCacheEntry("huge-key")).toBeUndefined();
  });

  test("setCacheEntry / getCacheEntry round-trip for a normal-sized payload", async () => {
    const accepted = await setCacheEntry("project-123", { name: "Amazon Reforestation" });
    expect(accepted).toBe(true);
    expect(await getCacheEntry("project-123")).toEqual({ name: "Amazon Reforestation" });
  });
});

// ── concurrent-write guard ────────────────────────────────────────────

describe("concurrent-write guard", () => {
  test("retries and merges when another tab writes between read and commit", async () => {
    const key = namespaceKey("settings");
    store[key] = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      writeVersion: 0,
      updatedAt: Date.now(),
      data: { count: 0 },
    } as StorageRecord;

    let getCallCount = 0;
    const originalGetImpl = (chrome.storage.local.get as jest.Mock).getMockImplementation()!;
    (chrome.storage.local.get as jest.Mock).mockImplementation((...args: any[]) => {
      getCallCount += 1;
      // On the *second* read inside writeNamespace (the pre-commit
      // verification read), simulate another tab having written first.
      if (getCallCount === 2) {
        store[key] = {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          writeVersion: 1, // another tab already bumped this
          updatedAt: Date.now(),
          data: { count: 1, fromOtherTab: true },
        };
      }
      return (originalGetImpl as any)(...args);
    });

    let updaterCalls = 0;
    const result = await writeNamespace("settings", (current: any) => {
      updaterCalls += 1;
      return { ...current, count: (current.count || 0) + 1 };
    });

    // The updater must have been retried against the fresh data from
    // "the other tab" rather than clobbering it.
    expect(updaterCalls).toBe(2);
    expect(result.data).toMatchObject({ count: 2, fromOtherTab: true });
    expect(result.writeVersion).toBe(2);
  });

  test("gives up with StorageWriteConflictError after exceeding maxRetries", async () => {
    const key = namespaceKey("settings");
    store[key] = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      writeVersion: 0,
      updatedAt: Date.now(),
      data: {},
    } as StorageRecord;

    // Every pre-commit read reports a newer writeVersion than expected,
    // simulating a tab that never stops winning the race.
    let readCount = 0;
    (chrome.storage.local.get as jest.Mock).mockImplementation(
      (_keys: any, callback: (items: Record<string, unknown>) => void) => {
        readCount += 1;
        callback({
          [key]: {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            writeVersion: readCount, // always "one step ahead"
            updatedAt: Date.now(),
            data: {},
          },
        });
      },
    );

    await expect(
      writeNamespace("settings", (current) => current, { maxRetries: 2 }),
    ).rejects.toThrow(StorageWriteConflictError);
  });

  test("describeStorageError gives a friendly message for write conflicts", () => {
    const err = new StorageWriteConflictError("settings", 3);
    expect(describeStorageError(err)).toMatch(/another tab/i);
  });
});

// ── startup integrity check / corruption recovery ────────────────────

describe("runStartupIntegrityCheck", () => {
  test("initializes fresh defaults when storage was wiped (no data present)", async () => {
    const reports = await runStartupIntegrityCheck();
    expect(reports.map((r) => r.namespace).sort()).toEqual(["cache", "pendingOps", "settings"]);
    for (const report of reports) {
      expect(report.status).toBe("initialized");
    }

    const settingsRecord = store[namespaceKey("settings")] as StorageRecord;
    expect(settingsRecord.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  test("quarantines a namespace with an invalid shape and resets it, without touching others", async () => {
    const settingsKey = namespaceKey("settings");
    const cacheKey = namespaceKey("cache");

    store[settingsKey] = { garbage: true }; // missing schemaVersion/writeVersion/data
    store[cacheKey] = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      writeVersion: 1,
      updatedAt: Date.now(),
      data: { keepMe: { value: 1, size: 10, lastAccessed: Date.now() } },
    } as StorageRecord;

    const reports = await runStartupIntegrityCheck();
    const settingsReport = reports.find((r) => r.namespace === "settings")!;
    const cacheReport = reports.find((r) => r.namespace === "cache")!;

    expect(settingsReport.status).toBe("quarantined");
    // Untouched namespace is unaffected — no data loss beyond the
    // quarantined namespace.
    expect(cacheReport.status).toBe("ok");
    expect((store[cacheKey] as StorageRecord).data).toEqual({
      keepMe: { value: 1, size: 10, lastAccessed: expect.any(Number) },
    });

    // The corrupt record was backed up, not destroyed.
    const backupKeys = Object.keys(store).filter((k) => k.startsWith(quarantineKeyPrefix("settings")));
    expect(backupKeys).toHaveLength(1);
    expect(store[backupKeys[0]]).toEqual({ garbage: true });

    // The live namespace was reset to a known-good default and run back
    // through the migration chain, so it regains migrated defaults (v2's
    // `theme`, v3's `notificationsEnabled`) instead of a bare `{}`.
    const resetRecord = store[settingsKey] as StorageRecord;
    expect(resetRecord.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(resetRecord.data).toEqual({ theme: "system", notificationsEnabled: true });
  });

  test("quarantines a namespace whose checksum was tampered with", async () => {
    const settingsKey = namespaceKey("settings");
    // Write a legitimate record first, then tamper with the data while
    // leaving the checksum stale — simulating corruption/tampering.
    await updateStorageSettings({ backendUrl: "https://good.example.com" });
    const tampered = store[settingsKey] as StorageRecord;
    store[settingsKey] = { ...tampered, data: { backendUrl: "https://evil.example.com" } };

    const reports = await runStartupIntegrityCheck();
    const settingsReport = reports.find((r) => r.namespace === "settings")!;
    expect(settingsReport.status).toBe("quarantined");
    expect(settingsReport.detail).toMatch(/checksum/i);

    const recovered = await getStorageSettings();
    // Reset to migrated defaults, tampered data discarded (but backed up).
    expect(recovered).toEqual({ theme: "system", notificationsEnabled: true });
  });

  test("logs a warning to the console when quarantining", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    store[namespaceKey("settings")] = { garbage: true };

    await runStartupIntegrityCheck();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[IndigoPay Storage]"),
    );
    warnSpy.mockRestore();
  });

  test("migrates a namespace stuck at an old schema version instead of quarantining it", async () => {
    // Write real data first (which stamps a valid checksum for it — now
    // required on `settings`, see the checksum-enforcement test below),
    // then roll schemaVersion back down to simulate an old-but-not-corrupt
    // record without also having to fake a matching checksum by hand.
    await updateStorageSettings({ backendUrl: "https://existing.example.com" });
    const written = store[namespaceKey("settings")] as StorageRecord;
    store[namespaceKey("settings")] = { ...written, schemaVersion: 1 };

    const reports = await runStartupIntegrityCheck();
    const settingsReport = reports.find((r) => r.namespace === "settings")!;
    expect(settingsReport.status).toBe("migrated");

    const record = store[namespaceKey("settings")] as StorageRecord;
    expect(record.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    // Old data is preserved through migration, never silently dropped.
    expect(record.data).toMatchObject({ backendUrl: "https://existing.example.com" });
  });

  test("a namespace already valid and current is reported ok and left untouched", async () => {
    await runStartupIntegrityCheck(); // first run initializes everything
    (chrome.storage.local.set as jest.Mock).mockClear();

    const reports = await runStartupIntegrityCheck();
    expect(reports.every((r) => r.status === "ok")).toBe(true);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
});

// ── pendingOps namespace ──────────────────────────────────────────────

describe("pendingOps namespace", () => {
  test("enqueue / dequeue round-trip", async () => {
    await enqueuePendingOp({ id: "op-1", type: "donate", payload: { amount: 5 } });
    await enqueuePendingOp({ id: "op-2", type: "donate", payload: { amount: 10 } });

    let ops = await getPendingOps();
    expect(ops.map((o) => o.id)).toEqual(["op-1", "op-2"]);

    await dequeuePendingOp("op-1");
    ops = await getPendingOps();
    expect(ops.map((o) => o.id)).toEqual(["op-2"]);
  });
});

// ── settings namespace ────────────────────────────────────────────────

describe("settings namespace helpers", () => {
  test("updateStorageSettings merges into existing data and stamps a checksum", async () => {
    await updateStorageSettings({ backendUrl: "https://a.example.com" });
    const record = await writeNamespace("settings", (c) => c); // read current via a no-op write
    expect(record.data).toMatchObject({ backendUrl: "https://a.example.com" });
    expect(record.checksum).toEqual(expect.any(String));
  });
});

// ── CodeRabbit fixes (PR #977) regression tests ───────────────────────

describe("writeNamespace runs pending migrations before stamping a schema version", () => {
  test("a write against a namespace still behind CURRENT_SCHEMA_VERSION actually migrates the data, not just the version number", async () => {
    // Seed a legitimate v1 settings record (valid checksum for its data) —
    // simulating a namespace that was written before v2/v3 introduced new
    // fields and never went through runStartupIntegrityCheck. Before this
    // fix, writeNamespace stamped CURRENT_SCHEMA_VERSION directly onto
    // whatever `updater` produced, permanently hiding the pending
    // migrations from every future check.
    await updateStorageSettings({ backendUrl: "https://existing.example.com" });
    const written = store[namespaceKey("settings")] as StorageRecord;
    store[namespaceKey("settings")] = { ...written, schemaVersion: 1 };

    const result = await writeNamespace("settings", (current) => ({
      ...current,
      backendUrl: "https://updated.example.com",
    }));

    expect(result.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    // The migrated-in defaults (v2 theme, v3 notificationsEnabled) are
    // present, proving the migration chain actually ran rather than the
    // version number being forced.
    expect(result.data).toMatchObject({
      backendUrl: "https://updated.example.com",
      theme: "system",
      notificationsEnabled: true,
    });
  });
});

describe("runMigrations bumps writeVersion on every persisted step", () => {
  test("writeVersion advances by the number of migration steps applied", async () => {
    const migrations = [
      { version: 1, migrate: (data: any) => ({ ...data, a: 1 }) },
      { version: 2, migrate: (data: any) => ({ ...data, b: 2 }) },
      { version: 3, migrate: (data: any) => ({ ...data, c: 3 }) },
    ];
    const record = await runMigrations("settings", migrations);
    // Regression: runMigrations previously left writeVersion unchanged,
    // so writeNamespace's concurrent-write guard (which compares
    // writeVersion) couldn't detect that a migration had landed in the
    // meantime and could overwrite migrated data with pre-migration data.
    expect(record.writeVersion).toBe(3);
  });
});

describe("getCacheEntry refreshes lastAccessed (true LRU, not FIFO, eviction)", () => {
  test("reading an older entry protects it from eviction over a newer, unread one", async () => {
    const entrySize = Math.floor(NAMESPACE_QUOTA_BYTES.cache / 3) + 1000; // 2 fit; adding a 3rd overflows

    await writeNamespace("cache", () => ({
      old: { value: "a", size: entrySize, lastAccessed: 1000 } as CacheEntry,
    }));
    await writeNamespace("cache", (current) => ({
      ...current,
      newer: { value: "b", size: entrySize, lastAccessed: 2000 } as CacheEntry,
    }));

    // Read "old" — without the fix, this has no effect on lastAccessed and
    // eviction stays ordered by last *write*.
    await getCacheEntry("old");
    // Flush the fire-and-forget lastAccessed touch triggered by the read
    // above (a background writeNamespace call) before the next write reads
    // the cache namespace.
    const cacheKey = namespaceKey("cache");
    for (
      let i = 0;
      i < 50 && (store[cacheKey] as StorageRecord<any>).data.old.lastAccessed === 1000;
      i++
    ) {
      await Promise.resolve();
    }

    const record = await writeNamespace("cache", (current) => ({
      ...current,
      third: { value: "c", size: entrySize, lastAccessed: 3000 } as CacheEntry,
    }));

    // "newer" was written more recently but never read — it should be
    // evicted instead of "old", which was just accessed.
    expect(record.data.old).toBeDefined();
    expect(record.data.newer).toBeUndefined();
  });
});

describe("checkAndRecoverNamespace requires a checksum on settings", () => {
  test("a settings record with no checksum field at all is quarantined, not silently accepted", async () => {
    // Unlike the "stuck at an old schema version" case (which has a valid
    // checksum for its data), this record has no checksum field
    // whatsoever — e.g. one written by code that bypassed writeNamespace.
    // Before this fix, `typeof record.checksum === "string"` being false
    // skipped verification entirely and reported this record "ok".
    store[namespaceKey("settings")] = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      writeVersion: 0,
      updatedAt: Date.now(),
      data: { backendUrl: "https://existing.example.com" },
    } as StorageRecord;

    const reports = await runStartupIntegrityCheck();
    const settingsReport = reports.find((r) => r.namespace === "settings")!;
    expect(settingsReport.status).toBe("quarantined");
  });
});
