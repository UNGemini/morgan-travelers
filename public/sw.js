/* MORGAN Travelers PWA service worker
 *
 * Minimal SW: do NOT intercept CSS/JS/wasm — mobile Safari + aggressive
 * caching was leaving the shell unstyled (HTML without matching assets).
 *
 * Only help: offline fallback for navigations when the network fails.
 * Bump CACHE to drop any old cache-first shells still stuck on devices.
 */
const CACHE = "mtravelers-shell-v11";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() =>
        self.clients.matchAll({ type: "window" }).then((clients) => {
          for (const client of clients) {
            client.postMessage({ type: "SW_ACTIVATED", cache: CACHE });
          }
        }),
      ),
  );
});

self.addEventListener("message", (event) => {
  if (event?.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
  if (event?.data?.type === "CLEAR_CACHES") {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))),
    );
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Never touch cross-origin (data edge, fonts, APIs, etc.)
  if (url.origin !== self.location.origin) return;

  // Never intercept the worker script
  if (url.pathname.endsWith("/sw.js") || url.pathname.endsWith("sw.js")) {
    return;
  }

  // Only navigations get an offline fallback. CSS/JS/assets use the browser.
  const isNavigate =
    request.mode === "navigate" || request.destination === "document";

  if (!isNavigate) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Keep a single HTML copy for offline cold start only
        if (response.ok) {
          const copy = response.clone();
          caches
            .open(CACHE)
            .then((cache) => cache.put("/index.html", copy))
            .catch(() => {});
        }
        return response;
      })
      .catch(() =>
        caches
          .match(request)
          .then((c) => c || caches.match("/index.html") || caches.match("./index.html")),
      ),
  );
});
