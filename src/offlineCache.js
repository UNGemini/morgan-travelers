/**
 * Read the explicit offline dataset from Cache Storage.
 *
 * iOS standalone PWAs often launch already-offline with no service-worker
 * controller, so fetch() never hits public/sw.js. The Settings download still
 * wrote the files into mtravelers-data-v* — read them here directly.
 *
 * Keep DATA_CACHE_NAME in sync with public/sw.js.
 */
export const DATA_CACHE_NAME = "mtravelers-data-v3";

/**
 * @param {string} url
 * @returns {Promise<Response | null>}
 */
export async function matchDataCacheResponse(url) {
  if (typeof caches === "undefined") return null;
  let abs;
  try {
    abs = new URL(url, typeof location !== "undefined" ? location.href : undefined);
  } catch {
    return null;
  }
  let names = [];
  try {
    names = await caches.keys();
  } catch {
    return null;
  }
  const dataNames = names.filter((n) => n.startsWith("mtravelers-data-"));
  const ordered = [
    ...dataNames.filter((n) => n === DATA_CACHE_NAME),
    ...dataNames.filter((n) => n !== DATA_CACHE_NAME),
  ];
  const opts = { ignoreSearch: true, ignoreVary: true };
  for (const name of ordered) {
    let cache;
    try {
      cache = await caches.open(name);
    } catch {
      continue;
    }
    let hit =
      (await cache.match(abs.href, opts)) ||
      (await cache.match(abs.origin + abs.pathname, opts));
    if (!hit) {
      try {
        const keys = await cache.keys();
        const req = keys.find((r) => {
          try {
            return new URL(r.url).pathname === abs.pathname;
          } catch {
            return false;
          }
        });
        if (req) hit = await cache.match(req);
      } catch {
        /* ignore */
      }
    }
    if (hit) return hit;
  }
  return null;
}

/**
 * fetch() a JSON URL, then fall back to the downloaded data cache.
 * @param {string} url
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function fetchDataJson(url, opts = {}) {
  const signal = opts.signal;
  try {
    const res = await fetch(url, { signal });
    if (res.ok) {
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        /* fall through to cache */
      }
    }
  } catch (e) {
    if (e?.name === "AbortError") throw e;
  }
  const hit = await matchDataCacheResponse(url);
  if (hit) return hit.json();
  throw new Error(`offline data missing: ${url}`);
}

/**
 * fetch() a text/CSV URL, then fall back to the downloaded data cache.
 * @param {string} url
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function fetchDataText(url, opts = {}) {
  const signal = opts.signal;
  try {
    const res = await fetch(url, { signal });
    if (res.ok) return await res.text();
  } catch (e) {
    if (e?.name === "AbortError") throw e;
  }
  const hit = await matchDataCacheResponse(url);
  if (hit) return hit.text();
  throw new Error(`offline data missing: ${url}`);
}
