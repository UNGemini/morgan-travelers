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
 *     network-first with stale fallback beyond that. Google Fonts
 *     (cross-origin, CORS-enabled) use the same SWR contract with a 30d
 *     window so offline typography keeps working.
 *
 *  3. OPT-IN data cache (router graph, fares, map data) — controlled by
 *     the Settings "Data cache" toggle via DATA_CACHE_PREF messages.
 *     ALL transit data (route/stop files, fares, overrides, MTR geo,
 *     basemap archive) is serve-only: with the Cloud preference (default)
 *     the live network copy is tried first and the downloaded copy is the
 *     offline fallback; with the Local preference the downloaded copy is
 *     served directly. Either way nothing is ever auto-written —
 *     automatic caching is limited to static shell assets so ordinary use
 *     does not burn mobile data.
 *
 *     The only writer is the explicit Settings "Download offline data"
 *     flow (PRECACHE_DATA): every URL is fetched fresh and byte-verified
 *     into a staging cache, then the dataset is committed atomically
 *     (staging → data/tiles) only when EVERY file succeeded. A quit
 *     mid-download therefore leaves the previous dataset intact, and
 *     leftover staging is purged on the next activation — partial
 *     downloads can never surface to the app.
 *
 *     The basemap archive (hongkong.pmtiles, ~30 MB) is cached as ONE
 *     full file: the PMTiles client always asks with Range headers, so
 *     the SW answers every Range request with a synthesized 206 slice
 *     (ETag + CORS headers copied).
 *
 * The historical rule was "NEVER intercept CSS/JS/wasm" because cache-first
 * HTML left the shell unstyled. That cannot recur here: HTML stays
 * network-first, and asset URLs are content-addressed.
 *
 * Bumping CACHE (below) wipes older shell caches on activation — the
 * deploy path for "force fresh shell". The data cache survives upgrades
 * unless the user clears it.
 */
const CACHE = "mtravelers-shell-v14";
const DATA_CACHE = "mtravelers-data-v3"; // v3: all-data serve-only regime
const TILES_CACHE = "mtravelers-tiles-v1";
const STAGING_CACHE = "mtravelers-stage-v1"; // atomic download staging
/** "cloud" (live first, cache as offline fallback) or "local" (cache only) */
let dataSourcePref = "cloud";
const SHELL_SWR_TTL_MS = 24 * 60 * 60 * 1000; // /maplibre/ freshness window
const FONT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // Google Fonts freshness window

/** Cross-origin hosts whose CORS-enabled responses we cache (fonts). */
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

/**
 * Same-origin transit data — routes/stops, fares, overrides, MTR geo.
 * Serve-only: a downloaded copy is served, otherwise network passthrough
 * and NEVER auto-cached (a partial body here breaks route paths).
 */
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

/** Message port for the in-flight offline download (see PRECACHE_*). */
let precachePort = null;

self.addEventListener("install", (event) => {
  console.info("[sw] install", CACHE);
  // First install: take control immediately so the data cache works.
  // Updates wait for SKIP_WAITING — the page prompts the user first.
  if (!self.registration.active) event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  console.info("[sw] activate", CACHE);
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (k) =>
                (k.startsWith("mtravelers-shell-") && k !== CACHE) ||
                k.startsWith("mtravelers-stage-") ||
                (k.startsWith("mtravelers-data-") && k !== DATA_CACHE),
            )
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
  if (event?.data?.type === "DATA_SOURCE_PREF") {
    dataSourcePref = event.data.prefer === "local" ? "local" : "cloud";
    console.info("[sw] data source pref", dataSourcePref);
  }
  if (event?.data?.type === "DATA_CACHE_PREF") {
    dataCacheEnabled = !!event.data.enabled;
    console.info("[sw] data cache pref", dataCacheEnabled);
    if (!dataCacheEnabled) {
      event.waitUntil(
        Promise.all([
          caches.delete(DATA_CACHE),
          caches.delete(TILES_CACHE),
          caches.delete(STAGING_CACHE),
        ]),
      );
    }
  }
  if (event?.data?.type === "PRECACHE_DATA") {
    precachePort = event.ports?.[0] || null;
    event.waitUntil(precacheData(event.data.urls || []));
  }
  if (event?.data?.type === "PRECACHE_ABORT") {
    // Page gave up (failed download / user quit) — discard the staging set.
    event.waitUntil(
      caches
        .delete(STAGING_CACHE)
        .catch(() => {})
        .then(() => {
          precachePort?.close?.();
          precachePort = null;
        }),
    );
  }
  if (event?.data?.type === "PRECACHE_COMMIT") {
    event.waitUntil(commitPrecache());
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

/** @param {string} pathname */
function isTilesPath(pathname) {
  return pathname.endsWith("/hongkong.pmtiles");
}

/** Age of a cached response via its Date header; Infinity when absent. */
function cachedAgeMs(response) {
  const date = response?.headers?.get?.("date");
  const t = date ? Date.parse(date) : NaN;
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}

/**
 * True when a cached body is complete. Decodable = not truncated. When the
 * response has no content-encoding, the decoded length must also match
 * content-length (compressed entries store wire bytes, so their decoded
 * length legitimately differs).
 */
async function cachedBodyComplete(response) {
  let buf;
  try {
    buf = await response.clone().arrayBuffer();
  } catch {
    return false; // truncated / undecodable body
  }
  if (response?.headers?.get?.("content-encoding")) return true;
  const len = Number(response?.headers?.get?.("content-length"));
  if (!Number.isFinite(len) || len <= 0) return true; // cannot verify
  return buf.byteLength === len;
}

/** Cache-first within TTL, network-first with stale fallback beyond. */
async function swrFetch(event, cacheName, ttlMs, logTag) {
  const { request } = event;
  const cache = await caches.open(cacheName);
  let hit = await cache.match(request);

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

  // Miss or stale → network first; keep the copy for offline. The page's
  // stream and cache.put must not consume the body concurrently (Safari can
  // truncate either side), so the full copy lands in the cache first.
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      console.info("[sw] cached", logTag, urlPath(event.request.url));
      try {
        await cache.put(request, res.clone());
      } catch (err) {
        console.warn("[sw] cache put failed", urlPath(event.request.url), err);
      }
    }
    return res;
  } catch (err) {
    if (hit) return hit;
    throw err;
  }
}

/**
 * Explicit one-shot download of the offline dataset (Settings button).
 * Every URL is fetched fresh (caches bypassed) and byte-verified into the
 * STAGING cache — the live data/tiles caches are untouched until the page
 * confirms zero failures (PRECACHE_COMMIT). The page never shares a body
 * stream with this write, so a partial file cannot poison a cache, and a
 * quit mid-download leaves the previous dataset intact (the staging cache
 * is purged on the next activation). Reports progress + result over the
 * message port.
 * @param {string[]} urls
 */
/** Offline download may only fetch first-party data + the PMTiles CDN. */
function isAllowedPrecacheUrl(href) {
  let u;
  try {
    u = new URL(href, self.location.href);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.origin === self.location.origin) {
    return (
      isDataPath(u.pathname) ||
      isTilesPath(u.pathname) ||
      u.pathname.startsWith("/fares/") ||
      u.pathname.startsWith("/overrides/") ||
      u.pathname.startsWith("/mtr/")
    );
  }
  return u.hostname === "hk-gtfsdata.morgandev.cc";
}

async function precacheData(urls) {
  let done = 0;
  let totalBytes = 0;
  const failures = [];
  try {
    await caches.delete(STAGING_CACHE);
  } catch {
    /* ignore */
  }
  const stage = await caches.open(STAGING_CACHE);
  for (const href of urls) {
    try {
      if (!isAllowedPrecacheUrl(href)) {
        throw new Error("url not allowed");
      }
      const key = new URL(href, self.location.href).href;
      const res = await fetch(key, { cache: "reload" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      // The CDN compresses JSON/CSV/GeoJSON with gzip/brotli, so the
      // decoded body is larger than the wire content-length — only compare
      // lengths for uncompressed bodies. A truncated compressed body fails
      // at the arrayBuffer() decode above instead.
      const len = Number(res.headers.get("content-length"));
      if (
        !res.headers.get("content-encoding") &&
        Number.isFinite(len) &&
        buf.byteLength !== len
      ) {
        throw new Error(`incomplete body (${buf.byteLength}/${len} bytes)`);
      }
      // Body is decoded — drop transfer-encoding so the stored response
      // matches its (now uncompressed) bytes.
      const headers = new Headers(res.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      headers.set("content-length", String(buf.byteLength));
      await stage.put(key, new Response(buf, { status: res.status, headers }));
      totalBytes += buf.byteLength;
    } catch (err) {
      failures.push({ url: href, error: String(err?.message || err) });
    }
    done += 1;
    precachePort?.postMessage({
      type: "PRECACHE_PROGRESS",
      done,
      total: urls.length,
      totalBytes,
    });
  }
  precachePort?.postMessage({
    type: "PRECACHE_DONE",
    ok: failures.length === 0,
    failures,
    totalBytes,
  });
}

/**
 * Promote a fully-verified staging set into the live caches (called only
 * after PRECACHE_DONE reported zero failures). Entries are copied
 * key-by-key — put overwrites in place, so readers never see a
 * missing-file window — then stale keys absent from the new set are
 * purged. The staging cache is deleted last.
 */
async function commitPrecache() {
  const stage = await caches.open(STAGING_CACHE);
  const keys = await stage.keys();
  const live = { [DATA_CACHE]: new Set(), [TILES_CACHE]: new Set() };
  for (const req of keys) {
    const res = await stage.match(req);
    if (!res) continue;
    const name = req.url.endsWith("/hongkong.pmtiles")
      ? TILES_CACHE
      : DATA_CACHE;
    const cache = await caches.open(name);
    await cache.put(req, res);
    live[name].add(req.url);
  }
  for (const [name, keep] of Object.entries(live)) {
    const cache = await caches.open(name);
    for (const req of await cache.keys()) {
      if (!keep.has(req.url)) await cache.delete(req);
    }
  }
  await caches.delete(STAGING_CACHE);
  precachePort?.postMessage({ type: "PRECACHE_COMMITTED" });
  precachePort?.close?.();
  precachePort = null;
}

/**
 * Serve transit data from a previously downloaded copy (Settings button)
 * or pass through to the network WITHOUT caching. Data is never written
 * outside the explicit PRECACHE_DATA flow (which byte-verifies every body
 * into staging before the atomic commit), so a partial file cannot
 * surface here.
 *
 * Data-source preference (DATA_SOURCE_PREF):
 *  - cloud (default): try the live network copy first, fall back to the
 *    downloaded copy when offline — fresh data whenever reachable.
 *  - local: serve the downloaded copy directly, saving mobile data.
 * @param {FetchEvent} event
 * @param {string} cacheName
 */
async function cachedOnlyFetch(event, cacheName) {
  const { request } = event;
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) {
    if (!(await cachedBodyComplete(hit))) {
      console.warn(
        "[sw] discarding corrupt data",
        urlPath(event.request.url),
      );
      await cache.delete(request);
    } else if (dataSourcePref === "local") {
      console.info(
        "[sw] serving downloaded data",
        urlPath(event.request.url),
      );
      return hit;
    } else {
      // Cloud: prefer live data when online, fall back offline.
      try {
        const live = await fetch(request);
        if (live && live.ok) {
          console.info("[sw] live data", urlPath(event.request.url));
          return live;
        }
      } catch {
        /* offline — fall through to the downloaded copy */
      }
      console.info(
        "[sw] serving downloaded data",
        urlPath(event.request.url),
      );
      return hit;
    }
  }
  return fetch(request);
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

/**
 * Serve a cached full response, answering Range requests with a 206 slice.
 * Returns a Promise<Response> — the slice body comes from the cached archive.
 */
function sliceOrFull(full, range) {
  if (!range) return Promise.resolve(full);
  const m = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
  if (!m) return Promise.resolve(full);
  return full.arrayBuffer().then((buf) => {
    const start = parseInt(m[1], 10);
    const end = m[2] ? Math.min(parseInt(m[2], 10), buf.byteLength - 1) : buf.byteLength - 1;
    if (start > end || start >= buf.byteLength) {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${buf.byteLength}` },
      });
    }
    const slice = buf.slice(start, end + 1);
    const headers = new Headers();
    for (const h of [
      "access-control-allow-origin",
      "access-control-expose-headers",
      "content-type",
      "etag",
      "last-modified",
      "cache-control",
    ]) {
      const v = full.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set("content-range", `bytes ${start}-${end}/${buf.byteLength}`);
    headers.set("content-length", String(slice.byteLength));
    headers.set("accept-ranges", "bytes");
    return new Response(slice, { status: 206, headers });
  });
}

/**
 * Basemap archive cache (serve-only). The client only ever sends Range
 * requests, so a downloaded full archive is re-served as 206 slices. A
 * miss passes through to the network — the archive is NEVER auto-written
 * outside the explicit PRECACHE_DATA flow (which byte-verifies it).
 */
async function tilesFetch(event) {
  const { request } = event;
  const url = new URL(request.url);
  const key = url.origin + url.pathname;
  const cache = await caches.open(TILES_CACHE);
  const hit = await cache.match(key);
  const range = request.headers.get("range");
  if (hit) {
    if (dataSourcePref === "cloud") {
      // Cloud: prefer live tile slices when online, fall back offline.
      try {
        const live = await fetch(request);
        if (live && live.ok) {
          console.info("[sw] live tiles", urlPath(request.url));
          return live;
        }
      } catch {
        /* offline — fall through to the downloaded archive */
      }
    }
    console.info(
      "[sw] serving downloaded tiles archive",
      urlPath(request.url),
    );
    return sliceOrFull(hit, range);
  }
  return fetch(request);
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

  // Google Fonts (cross-origin but CORS-enabled) — SWR for offline typography.
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(swrFetch(event, CACHE, FONT_TTL_MS, "font"));
    return;
  }

  // Map tiles (cross-origin archive on the data edge, same-origin /edge
  // proxy in preview) — downloaded archive served as 206 slices only.
  if (dataCacheEnabled && isTilesPath(url.pathname)) {
    event.respondWith(tilesFetch(event));
    return;
  }

  // Never touch other cross-origin (data edge, APIs, etc.)
  if (url.origin !== self.location.origin) return;

  // Never intercept the worker script
  if (url.pathname.endsWith("/sw.js") || url.pathname.endsWith("sw.js")) {
    return;
  }

  const isNavigate =
    request.mode === "navigate" || request.destination === "document";

  if (!isNavigate) {
    // Transit data (routes/stops, fares, overrides, MTR geo) — serve-only:
    // downloaded copy or network, never auto-cached (a partial body here
    // breaks route paths).
    if (dataCacheEnabled && isDataPath(url.pathname)) {
      event.respondWith(cachedOnlyFetch(event, DATA_CACHE));
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
