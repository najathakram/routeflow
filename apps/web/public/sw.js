// RouteFlow service worker — enables "Add to Home Screen" on Chrome/Edge/Android.
// Strategy: network-first for pages, API and the marketing site's files under /site/ (fixed names that change on
// every deploy, so a cached copy would outlive the page that uses it); cache-first for the app's other static assets.
// Bump CACHE_VERSION to drop everything stored so far: v4 removes the /site/ copies v3 kept across deploys.

const CACHE_VERSION = "routeflow-v4";
const STATIC_EXTENSIONS = [".js", ".css", ".woff2", ".woff", ".ttf", ".png", ".svg", ".ico"];

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Remove old caches from previous versions
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Pass through non-GET, API calls, Next.js internals, and cross-origin requests
  if (
    request.method !== "GET" ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/_next/") ||
    url.origin !== self.location.origin
  ) {
    return;
  }

  const isStaticAsset = STATIC_EXTENSIONS.some((ext) => url.pathname.endsWith(ext));
  const isMarketingFile = url.pathname.startsWith("/site/");

  if (isStaticAsset && isMarketingFile) {
    // Network-first: the cache is only an offline fallback, never a way to serve an old deploy
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        try {
          const response = await fetch(request);
          if (response.ok) cache.put(request, response.clone());
          return response;
        } catch (err) {
          const cached = await cache.match(request);
          if (cached) return cached;
          throw err;
        }
      }),
    );
  } else if (isStaticAsset) {
    // Cache-first: static assets change rarely
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
  } else {
    // Network-first: pages should always be fresh
    event.respondWith(fetch(request).catch(() => caches.match(request)));
  }
});
