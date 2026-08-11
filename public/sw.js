/* MORGAN Travelers PWA service worker
 *
 * Two jobs, deliberately narrow:
 *  1. Offline fallback for navigations (HTML only) — as before.
 *  2. OPT-IN data-asset cache (router graph, fares, map data) so repeat
 *     launches skip re-downloading ~25 MB. Controlled by the Settings
 *     "Data cache" toggle via DATA_CACHE_PREF messages.
 *
 * NEVER intercept CSS/JS/wasm — mobile Safari + aggressive caching was
 * leaving the shell unstyled (HTML without matching assets). The data
 * allowlist below excludes /assets/ and /src/ entirely.
 *
 * Freshness: cache-first while the response Date header is younger than
 * DATA_TTL_MS, with a background refresh (stale-while-revalidate); stale
 * or missing Date → network first, stale copy as offline fallback.
 * Bumping CACHE (below) wipes every cache on next activation — that is
 * the deploy path for "force fresh data".
 */
const CACHE = "mtravelers-shell-v12";
const DATA_CACHE = "mtravelers-data-v1";
const DATA_TTL_MS = 12 * 60 * 60 * 1000; // serve-from-cache window

/** Same-origin static data the app may cache. Excludes APIs, ETA, /edge. */
const DATA_PREFIXES = ["/data/", "/fares/", "/overrides/", "/mtr/"];

let dataCacheEnabled = true;

self.addEventListener("install", (event) => {
  console.info("[sw] install", CACHE);
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  console.info("[sw] activate", CACHE);
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
  if (event?.data?.type === "DATA_CACHE_PREF") {
    dataCacheEnabled = !!event.data.enabled;
    console.info("[sw] data cache pref", dataCacheEnabled);
    if (!dataCacheEnabled) {
      event.waitUntil(caches.delete(DATA_CACHE));
    }
  }
});

/** @param {string} pathname */
function isDataPath(pathname) {
  return DATA_PREFIXES.some((p) => pathname.startsWith(p));
}

/** Age of a cached response via its Date header; Infinity when absent. */
function cachedAgeMs(response) {
  const date = response?.headers?.get?.("date");
  const t = date ? Date.parse(date) : NaN;
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}

/** Fresh from cache (SWR) or network-first with stale fallback. */
async function dataCachedFetch(event) {
  const { request } = event;
  const cache = await caches.open(DATA_CACHE);
  const hit = await cache.match(request);

  if (hit && cachedAgeMs(hit) < DATA_TTL_MS) {
    // Serve instantly; revalidate in the background.
    console.info(
      "[sw] data cache hit",
      urlPath(event.request.url),
      Math.round(cachedAgeMs(hit) / 60000),
      "min old",
    );
    event.waitUntil(
      fetch(request)
        .then((res) => {
          if (res && res.ok) cache.put(request, res.clone());
        })
        .catch(() => {}),
    );
    return hit;
  }

  // Miss or stale → network first; keep the stale copy for offline.
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      console.info("[sw] data cached", urlPath(event.request.url));
      event.waitUntil(cache.put(request, res.clone()));
    }
    return res;
  } catch (err) {
    if (hit) return hit;
    throw err;
  }
}

/** @param {string} url */
function urlPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

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

  const isNavigate =
    request.mode === "navigate" || request.destination === "document";

  // Non-navigation: only the opt-in data allowlist is handled here.
  if (!isNavigate) {
    if (dataCacheEnabled && isDataPath(url.pathname)) {
      event.respondWith(dataCachedFetch(event));
    }
    return;
  }

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
