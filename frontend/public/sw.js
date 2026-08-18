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

self.addEventListener("sync", (event) => {
  if (event.tag === "donation-queue") {
    event.waitUntil(
      self.registration.sync.register("donation-queue"),
    );
  }
});
