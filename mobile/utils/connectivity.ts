/**
 * utils/connectivity.ts
 *
 * Lightweight connectivity monitor for the offline donation queue.
 *
 * The mobile app currently has no NetInfo dependency, so rather than add one
 * we probe the backend health endpoint with the already-present axios client.
 * This keeps the dependency surface unchanged while still letting the queue
 * worker auto-retry eligible donations the moment connectivity is recovered.
 *
 * Behaviour:
 *   - startConnectivityWatcher() begins a periodic probe (default 15s) and
 *     also fires an immediate check.
 *   - On any transition offline→online, registered listeners are invoked so
 *     the worker can trigger processQueue().
 *   - isOnline() reports the last known state synchronously.
 *   - stopConnectivityWatcher() tears everything down (idempotent).
 */
import axios from "axios";

const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://localhost:4000";
const HEALTH_URL = `${API_URL}/api/health`;
const PROBE_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;

type ConnectivityListener = (online: boolean) => void;

let online = true;
let probeTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<ConnectivityListener>();

async function probe(): Promise<boolean> {
  try {
    await axios.get(HEALTH_URL, { timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

async function checkNow(notify = true): Promise<boolean> {
  const next = await probe();
  const changed = next !== online;
  online = next;
  if (changed && notify) {
    for (const l of listeners) {
      try {
        l(online);
      } catch {
        // listener errors must not break the probe loop
      }
    }
  }
  return online;
}

/**
 * Subscribe to connectivity changes. Fires immediately with the current
 * state, then on every transition.
 *
 * @returns unsubscribe function
 */
export function subscribe(listener: ConnectivityListener): () => void {
  listeners.add(listener);
  // Emit current state to the new subscriber right away.
  Promise.resolve().then(() => {
    try {
      listener(online);
    } catch {
      /* ignore */
    }
  });
  return () => {
    listeners.delete(listener);
  };
}

export function isOnline(): boolean {
  return online;
}

/**
 * Start the periodic connectivity probe. Safe to call multiple times.
 */
export function startConnectivityWatcher(): void {
  if (probeTimer) return;
  // Immediate check so a freshly-restored connection is detected at once.
  checkNow().catch(() => {});
  probeTimer = setInterval(() => {
    checkNow().catch(() => {});
  }, PROBE_INTERVAL_MS);
}

/**
 * Stop the connectivity probe. Safe to call multiple times.
 */
export function stopConnectivityWatcher(): void {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}

export { checkNow };
