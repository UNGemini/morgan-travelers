/* MORGAN Travelers PWA service worker
 *
 * Strategy:
 *  · Navigations / HTML → always network (no stale shell)
 *  · CSS/JS entry → network-first (hashed URLs still change per build)
 *  · Other hashed /assets/* → stale-while-revalidate
 *  · APIs / fares / overrides → never cache
 *
 * Bump CACHE on every deploy that must drop stuck clients.
 * Old v1 was cache-first for index.html — clients kept “too high” dock CSS forever.
 */
const CACHE = "mtravelers-shell-v8";
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
        // Drop every previous shell (v1–v6 cache-first HTML was sticky)
        Promise.all(keys.map((k) => caches.delete(k))),
      )
      .then(() => caches.open(CACHE).then((c) => c.addAll(PRECACHE)))
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

/**
 * @param {Request} request
 * @param {Response} response
 */
function putInCache(request, response) {
  if (!response || !response.ok) return;
  // Never persist navigations / HTML — always take network on next open
  try {
    const dest = request.destination;
    if (
      request.mode === "navigate" ||
      dest === "document" ||
      dest === "style" ||
      dest === "script"
    ) {
      return;
    }
  } catch {
    /* ignore */
  }
  const copy = response.clone();
  caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.hostname === "hk-gtfsdata.morgandev.cc") {
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

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

  if (url.origin !== self.location.origin) {
    return;
  }

  // Never intercept the service worker script itself
  if (url.pathname.endsWith("/sw.js") || url.pathname.endsWith("sw.js")) {
    event.respondWith(fetch(request));
    return;
  }

  const isNavigate =
    request.mode === "navigate" ||
    request.destination === "document" ||
    url.pathname === "/" ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("index.html");

  // HTML: network only (offline fallback to last cached index if any)
  if (isNavigate) {
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .then((response) => {
          // Keep one offline copy only
          if (response.ok) {
            const copy = response.clone();
            caches
              .open(CACHE)
              .then((cache) => cache.put("./index.html", copy))
              .catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match("./index.html")),
    );
    return;
  }

  // CSS / main JS: network-first so dock layout deploys are not sticky
  const isShellAsset =
    request.destination === "style" ||
    request.destination === "script" ||
    /\.(css|js)$/i.test(url.pathname);

  if (isShellAsset) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Hashed assets can be cached; next build has new URL
          if (url.pathname.includes("/assets/") && response.ok) {
            putInCache(request, response);
          }
          return response;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  // Other same-origin (fonts, icons, wasm, data): cache then network
  if (url.pathname.includes("/assets/") || url.pathname.includes("/data/")) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request).then((response) => {
          putInCache(request, response);
          return response;
        });
        return cached || network;
      }),
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        putInCache(request, response);
        return response;
      })
      .catch(() => caches.match(request)),
  );
});
