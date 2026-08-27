const CACHE_VERSION = "indigopay-v1";
const APP_SHELL_CACHE = `${CACHE_VERSION}-app-shell`;
const STATIC_ASSETS_CACHE = `${CACHE_VERSION}-static-assets`;
const DATA_CACHE = `${CACHE_VERSION}-data`;

const APP_SHELL_URLS = ["/", "/offline", "/manifest.json", "/favicon.ico"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL_URLS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== APP_SHELL_CACHE && key !== STATIC_ASSETS_CACHE && key !== DATA_CACHE)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET") return;

  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) {
    if (url.pathname.includes("/projects")) {
      event.respondWith(
        caches.match(request).then((cached) => {
          const networkFetch = fetch(request)
            .then((response) => {
              if (response.ok) {
                const copy = response.clone();
                caches.open(DATA_CACHE).then((cache) => cache.put(request, copy));
              }
              return response;
            })
            .catch(() => cached);
          return cached || networkFetch;
        }),
      );
      return;
    }

    if (url.pathname.includes("/donations") || url.pathname.includes("/donate")) {
      event.respondWith(
        fetch(request)
          .catch(() => caches.match(request))
      );
      return;
    }
  }

  if (request.destination === "image" || request.destination === "font" || request.destination === "script" || request.destination === "style") {
    event.respondWith(
      caches.match(request).then((cached) => {
        const networkFetch = fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(STATIC_ASSETS_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || networkFetch;
      }),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(APP_SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    }),
  );
});

// Background Sync for the offline donation queue (Issue #1096, WS2).
//
// The queue itself lives in IndexedDB (lib/offlineDonationQueue.ts) and is
// drained by the page's sync routine, which needs the wired processor and
// idempotency pre-check. This handler's job is to wake that routine up when
// connectivity returns:
//
//  * If a page is open, post a nudge — the page listens for
//    "indigopay-queue-sync" and runs syncQueuedDonations() with the
//    cross-tab drain lease and server idempotency pre-check intact.
//  * If no page is open, re-register the tag so the browser retries the
//    sync once a page is available. The queue is durable in IndexedDB, so
//    nothing is lost in the meantime — it is also drained on page load and
//    on the window "online" event.
self.addEventListener("sync", (event) => {
  if (event.tag !== "donation-queue") return;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        if (clients.length === 0) {
          // No open page to run the drain — retry once one is available.
          return self.registration.sync.register("donation-queue");
        }
        clients.forEach((client) =>
          client.postMessage("indigopay-queue-sync"),
        );
      }),
  );
});
