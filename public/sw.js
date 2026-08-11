/* MORGAN Travelers PWA service worker
 *
 * Three layers, each with a different freshness contract:
 *
 *  1. Navigation fallback — network-first HTML; a copy of the last good
 *     index.html is kept so cold starts still work offline.
 *
 *  2. Shell assets — the JS/CSS bundles and the WASM router. Cache-first,
 *     no TTL: these URLs are content-hashed or declared immutable, so a
 *     cached copy can never go stale (the fresh HTML only ever references
 *     hashes the SW saw on the same visit). This is what makes the app
 *     boot offline. MapLibre files (/maplibre/*) keep fixed filenames, so
 *     they use stale-while-revalidate instead: cache-first within 24h,
 *     network-first with stale fallback beyond that.
 *
 *  3. OPT-IN data cache (router graph, fares, map data) — controlled by
 *     the Settings "Data cache" toggle via DATA_CACHE_PREF messages.
 *     Same SWR contract as /maplibre/, but with a 12h window and the
 *     toggle decides whether it runs at all.
 *
 * The historical rule was "NEVER intercept CSS/JS/wasm" because cache-first
 * HTML left the shell unstyled. That cannot recur here: HTML stays
 * network-first, and asset URLs are content-addressed.
 *
 * Bumping CACHE (below) wipes older shell caches on activation — the
 * deploy path for "force fresh shell". The data cache survives upgrades
 * unless the user clears it.
 */
const CACHE = "mtravelers-shell-v13";
const DATA_CACHE = "mtravelers-data-v1";
const DATA_TTL_MS = 12 * 60 * 60 * 1000; // serve-from-cache window (data)
const SHELL_SWR_TTL_MS = 24 * 60 * 60 * 1000; // /maplibre/ freshness window

/** Same-origin static data the app may cache. Excludes APIs, ETA, /edge. */
const DATA_PREFIXES = ["/data/", "/fares/", "/overrides/", "/mtr/"];

/** Content-hashed or immutable shell assets — safe to cache forever. */
const SHELL_IMMUTABLE_PREFIXES = ["/assets/", "/src/pkg/"];

/** Fixed-filename shell assets that change on deploy — SWR instead. */
const SHELL_SWR_PREFIXES = ["/maplibre/"];

/** Root-level icons and manifest (cache-first, tiny). */
const SHELL_FILES = [
  "/icon-192.png",
  "/icon-512.png",
  "/siteicon.png",
  "/logo.svg",
  "/topbarlogo.svg",
  "/logowithtext.png",
  "/developedbymorgan.png",
  "/manifest.webmanifest",
];

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
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("mtravelers-shell-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
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

/** @param {string} pathname */
function isImmutableShellPath(pathname) {
  return (
    SHELL_IMMUTABLE_PREFIXES.some((p) => pathname.startsWith(p)) ||
    SHELL_FILES.includes(pathname)
  );
}

/** @param {string} pathname */
function isSwrShellPath(pathname) {
  return SHELL_SWR_PREFIXES.some((p) => pathname.startsWith(p));
}

/** Age of a cached response via its Date header; Infinity when absent. */
function cachedAgeMs(response) {
  const date = response?.headers?.get?.("date");
  const t = date ? Date.parse(date) : NaN;
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}

/** Cache-first within TTL, network-first with stale fallback beyond. */
async function swrFetch(event, cacheName, ttlMs, logTag) {
  const { request } = event;
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);

  if (hit && cachedAgeMs(hit) < ttlMs) {
    // Serve instantly; revalidate in the background.
    console.info(
      "[sw] cache hit",
      logTag,
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
      console.info("[sw] cached", logTag, urlPath(event.request.url));
      event.waitUntil(cache.put(request, res.clone()));
    }
    return res;
  } catch (err) {
    if (hit) return hit;
    throw err;
  }
}

/** Cache-first forever — only safe for content-hashed/immutable URLs. */
async function immutableFetch(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok) {
    event.waitUntil(cache.put(request, res.clone()));
  }
  return res;
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

  if (!isNavigate) {
    // Data allowlist (opt-in toggle) → SWR with the data cache.
    if (dataCacheEnabled && isDataPath(url.pathname)) {
      event.respondWith(swrFetch(event, DATA_CACHE, DATA_TTL_MS, "data"));
      return;
    }
    // Shell assets → cache-first (hashed) or SWR (fixed filenames).
    if (isImmutableShellPath(url.pathname)) {
      event.respondWith(immutableFetch(event));
      return;
    }
    if (isSwrShellPath(url.pathname)) {
      event.respondWith(swrFetch(event, CACHE, SHELL_SWR_TTL_MS, "shell"));
      return;
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
