/**
 * utils/scanHistory.ts
 * AsyncStorage-backed history of QR scans so donors can quickly re-donate
 * to a recently scanned project without re-scanning its code.
 *
 * Follows the storage pattern of utils/cache.ts: reads fail soft (return
 * an empty list) so a corrupted entry can never crash the scan screen.
 * The list is newest-first, deduplicated by raw QR payload, and capped at
 * MAX_HISTORY items.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const HISTORY_KEY = "@indigopay:scan_history";
export const MAX_HISTORY = 20;

export interface ScanHistoryItem {
  type: string;
  address?: string;
  projectId?: string;
  projectName?: string;
  amount?: string;
  memo?: string;
  timestamp: number;
  raw: string;
}

export async function getScanHistory(): Promise<ScanHistoryItem[]> {
  try {
    const stored = await AsyncStorage.getItem(HISTORY_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function addToHistory(item: ScanHistoryItem): Promise<void> {
  try {
    const history = await getScanHistory();
    // Re-scanning the same QR moves it to the top instead of duplicating it.
    const deduped = history.filter((existing) => existing.raw !== item.raw);
    deduped.unshift(item);
    await AsyncStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(deduped.slice(0, MAX_HISTORY)),
    );
  } catch (error) {
    console.warn("Scan history write failed:", error);
  }
}

export async function clearScanHistory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(HISTORY_KEY);
  } catch (error) {
    console.warn("Scan history clear failed:", error);
  }
}
