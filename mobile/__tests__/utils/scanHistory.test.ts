/**
 * __tests__/utils/scanHistory.test.ts
 *
 * Unit tests for the AsyncStorage-backed scan history.
 *
 * Coverage:
 *   - getScanHistory: empty by default, fails soft on corrupt data
 *   - addToHistory: newest-first ordering
 *   - addToHistory: dedupes by raw payload (re-scan moves to top)
 *   - addToHistory: caps at MAX_HISTORY (20) items
 *   - clearScanHistory: removes everything
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  addToHistory,
  clearScanHistory,
  getScanHistory,
  MAX_HISTORY,
  ScanHistoryItem,
} from "../../utils/scanHistory";

const HISTORY_KEY = "@indigopay:scan_history";

function makeItem(overrides: Partial<ScanHistoryItem> = {}): ScanHistoryItem {
  return {
    type: "stellar_address",
    address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    projectName: "Acme Solar",
    timestamp: Date.now(),
    raw: "raw-payload",
    ...overrides,
  };
}

describe("scanHistory", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  it("returns an empty list when nothing has been scanned", async () => {
    expect(await getScanHistory()).toEqual([]);
  });

  it("fails soft when the stored value is corrupt", async () => {
    await AsyncStorage.setItem(HISTORY_KEY, "{not json");
    expect(await getScanHistory()).toEqual([]);
  });

  it("adds items newest-first", async () => {
    await addToHistory(makeItem({ raw: "first", timestamp: 1 }));
    await addToHistory(makeItem({ raw: "second", timestamp: 2 }));

    const history = await getScanHistory();
    expect(history).toHaveLength(2);
    expect(history[0].raw).toBe("second");
    expect(history[1].raw).toBe("first");
  });

  it("persists items via AsyncStorage so history survives restarts", async () => {
    await addToHistory(makeItem({ raw: "persisted" }));
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      HISTORY_KEY,
      expect.stringContaining("persisted"),
    );
  });

  it("dedupes by raw payload, moving a re-scan to the top", async () => {
    await addToHistory(makeItem({ raw: "same-qr", timestamp: 1 }));
    await addToHistory(makeItem({ raw: "other-qr", timestamp: 2 }));
    await addToHistory(makeItem({ raw: "same-qr", timestamp: 3 }));

    const history = await getScanHistory();
    expect(history).toHaveLength(2);
    expect(history[0].raw).toBe("same-qr");
    expect(history[0].timestamp).toBe(3);
    expect(history[1].raw).toBe("other-qr");
  });

  it(`caps the history at ${MAX_HISTORY} items`, async () => {
    for (let i = 0; i < MAX_HISTORY + 5; i++) {
      await addToHistory(makeItem({ raw: `qr-${i}`, timestamp: i }));
    }

    const history = await getScanHistory();
    expect(history).toHaveLength(MAX_HISTORY);
    // Newest survives, oldest five are dropped.
    expect(history[0].raw).toBe(`qr-${MAX_HISTORY + 4}`);
    expect(
      history.find((item) => item.raw === "qr-0"),
    ).toBeUndefined();
  });

  it("clearScanHistory empties the list", async () => {
    await addToHistory(makeItem());
    await clearScanHistory();
    expect(await getScanHistory()).toEqual([]);
  });
});
