/**
 * __tests__/serviceWorkerSync.test.ts
 *
 * Issue #1096, Workstream 2 — proves the service worker's "donation-queue"
 * Background Sync handler actually triggers a drain instead of being a
 * no-op. The handler is plain JS (public/sw.js) so we load it in a vm
 * sandbox with a ServiceWorkerGlobalScope-shaped `self` and dispatch real
 * `sync` events against it.
 *
 * The drain itself (IndexedDB -> processor -> server) is covered by the
 * offline -> reconnect -> exactly-once E2E spec (e2e/donation-preview.spec.ts)
 * and the queue unit tests; this test pins the glue: sync event -> nudge.
 */
import fs from "fs";
import path from "path";
import vm from "vm";

const SW_SOURCE = fs.readFileSync(
  path.join(process.cwd(), "public", "sw.js"),
  "utf8",
);

interface MockClient {
  postMessage: jest.Mock;
}

interface SyncEventLike {
  tag: string;
  waitUntil: jest.Mock;
}

function loadServiceWorker(opts: {
  clients?: MockClient[];
  register?: jest.Mock;
}): { listeners: Map<string, (event: unknown) => void> } {
  const listeners = new Map<string, (event: unknown) => void>();
  const register =
    opts.register ?? jest.fn().mockResolvedValue(undefined);

  const self = {
    location: { origin: "https://app.example" },
    addEventListener: (
      type: string,
      cb: (event: unknown) => void,
    ) => listeners.set(type, cb),
    skipWaiting: jest.fn(),
    clients: {
      claim: jest.fn(),
      matchAll: jest.fn().mockResolvedValue(opts.clients ?? []),
    },
    registration: { sync: { register } },
  };

  const sandbox: Record<string, unknown> = {
    self,
    caches: { open: jest.fn(), match: jest.fn(), keys: jest.fn() },
    fetch: jest.fn(),
    URL,
    console,
    // sw.js runs `new URL(request.url)` only inside the fetch handler, but
    // keep the globals available so the script parses in any order.
    Request: class {},
    Response: class {},
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(SW_SOURCE, sandbox, { filename: "sw.js" });
  return { listeners };
}

function dispatchSync(
  listeners: Map<string, (event: unknown) => void>,
  tag: string,
): SyncEventLike {
  const event: SyncEventLike = {
    tag,
    waitUntil: jest.fn(),
  };
  const handler = listeners.get("sync");
  expect(handler).toBeDefined();
  handler!(event);
  return event;
}

describe("service worker — donation-queue background sync", () => {
  test("registers a sync handler for the donation-queue tag", () => {
    const { listeners } = loadServiceWorker({});
    expect(listeners.has("sync")).toBe(true);
  });

  test("nudges every open client to drain the queue when one is open", async () => {
    const clients: MockClient[] = [
      { postMessage: jest.fn() },
      { postMessage: jest.fn() },
    ];
    const register = jest.fn().mockResolvedValue(undefined);
    const { listeners } = loadServiceWorker({ clients, register });

    const event = dispatchSync(listeners, "donation-queue");
    await Promise.all(event.waitUntil.mock.calls.map(([p]) => p));

    expect(clients[0].postMessage).toHaveBeenCalledWith(
      "indigopay-queue-sync",
    );
    expect(clients[1].postMessage).toHaveBeenCalledWith(
      "indigopay-queue-sync",
    );
    expect(register).not.toHaveBeenCalled();
  });

  test("re-registers the tag when no page is open so the drain is retried later", async () => {
    const register = jest.fn().mockResolvedValue(undefined);
    const { listeners } = loadServiceWorker({ clients: [], register });

    const event = dispatchSync(listeners, "donation-queue");
    await Promise.all(event.waitUntil.mock.calls.map(([p]) => p));

    expect(register).toHaveBeenCalledWith("donation-queue");
  });

  test("ignores sync events for other tags", () => {
    const clients: MockClient[] = [{ postMessage: jest.fn() }];
    const register = jest.fn().mockResolvedValue(undefined);
    const { listeners } = loadServiceWorker({ clients, register });

    const event = dispatchSync(listeners, "some-other-tag");

    expect(event.waitUntil).not.toHaveBeenCalled();
    expect(clients[0].postMessage).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });
});
