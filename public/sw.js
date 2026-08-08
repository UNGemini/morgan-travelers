/* MORGAN Travelers PWA service worker
 *
 * Strategy:
 *  · Navigations / index.html → network-first (always pick up new deploys)
 *  · Hashed /assets/* → cache-first (content-hash changes with every build)
 *  · APIs / fares / overrides → never cache
 *  · Other same-origin GETs → network-first with offline fallback
 *
 * Bump CACHE when install/activate logic changes so old shells are dropped.
 */
const CACHE = "mtravelers-shell-v3";
const PRECACHE = ["./manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/**
 * @param {Request} request
 * @param {Response} response
 */
function putInCache(request, response) {
  if (!response || !response.ok) return;
  const copy = response.clone();
  caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never intercept cross-origin data edge
  if (url.hostname === "hk-gtfsdata.morgandev.cc") {
    return;
  }

  // API / auth — always network
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

  // Live data — always network
  if (
    url.pathname.includes("/fares/") ||
    url.pathname.includes("/overrides/") ||
    url.pathname.includes("/eta/") ||
    url.pathname.endsWith("hk-fares.json") ||
    url.hostname === "raw.githubusercontent.com"
  ) {
    event.respondWith(fetch(request));
    return;
  }

  // Same-origin only for caching strategies below
  if (url.origin !== self.location.origin) {
    return;
  }

  const isNavigate =
    request.mode === "navigate" ||
    request.destination === "document" ||
    url.pathname === "/" ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("index.html");

  // HTML shell: network-first so deploys show up in the PWA without reinstall
  if (isNavigate) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          putInCache(request, response);
          // Also keep a copy under ./index.html for offline boot
          if (response.ok) {
            const copy = response.clone();
            caches
              .open(CACHE)
              .then((cache) => cache.put("./index.html", copy))
              .catch(() => {});
          }
          return response;
        })
        .catch(() =>
          caches
            .match(request)
            .then((c) => c || caches.match("./index.html")),
        ),
    );
    return;
  }

  // Hashed build assets: cache-first (URL changes when content changes)
  if (
    url.pathname.includes("/assets/") ||
    /\.[a-f0-9]{8,}\.(js|css|wasm)$/i.test(url.pathname)
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          putInCache(request, response);
          return response;
        });
      }),
    );
    return;
  }

  // Everything else same-origin: network-first
  event.respondWith(
    fetch(request)
      .then((response) => {
        putInCache(request, response);
        return response;
      })
      .catch(() => caches.match(request)),
  );
});
