/* Minimal offline shell for MORGAN Travelers PWA */
const CACHE = "mtravelers-shell-v1";
const PRECACHE = ["./", "./index.html", "./manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never cache large data-plane assets (GTFS / PMTiles / metadata live on edge)
  if (url.hostname === "hk-gtfsdata.morgandev.cc") {
    return;
  }

  // API / auth — always network (secrets + session; never SW cache)
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

  // Fare tables + hand overrides — always network (never stale SW cache)
  if (
    url.pathname.includes("/fares/") ||
    url.pathname.includes("/overrides/") ||
    url.pathname.endsWith("hk-fares.json")
  ) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok && url.origin === self.location.origin) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
