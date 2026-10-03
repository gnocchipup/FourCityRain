/* Service Worker for the Four City Rain PWA.
 *
 * Scope: the app shell only. Forecast data is fetched at runtime from the
 * Open-Meteo API, so nothing here caches or intercepts cross-origin requests
 * -- those pass straight through to the network.
 *
 * Strategy:
 *   - navigations  -> network-first, falling back to the cached shell so the
 *                     app still opens offline
 *   - static assets-> stale-while-revalidate (fast, updates in background)
 *
 * Relative URLs throughout, so the same file works when served from a domain
 * root or from a project subpath such as /FourCityRain/.
 */

const VERSION = "v1";
const SHELL_CACHE = `four-city-rain-shell-${VERSION}`;
const ASSET_CACHE = `four-city-rain-assets-${VERSION}`;

/* Resolve against the SW's own location so subpath deployments work. */
const SHELL_URL = new URL("./index.html", self.location).href;

/* Bare essentials for an offline launch. Hashed Vite assets are picked up by
 * the runtime cache instead, since their names change per build. */
const PRECACHE = [SHELL_URL];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => {
        /* A failed precache must not block installation; navigations still
           fall back to the network. */
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith("four-city-rain-") &&
                key !== SHELL_CACHE &&
                key !== ASSET_CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  /* Only GETs are cacheable. */
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  /* Leave the Open-Meteo API (and any other cross-origin call) alone so
     forecast data is always live and never served stale. */
  if (url.origin !== self.location.origin) return;

  /* App shell for navigations: network-first with an offline fallback. */
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(SHELL_URL, copy));
          return response;
        })
        .catch(() =>
          caches.match(SHELL_URL).then((cached) => cached ?? Response.error()),
        ),
    );
    return;
  }

  /* Static assets: stale-while-revalidate. */
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          /* Only persist genuine, complete responses. */
          if (response && response.status === 200 && response.type === "basic") {
            const copy = response.clone();
            caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);

      return cached ?? network;
    }),
  );
});

/* Let the page trigger an immediate update instead of waiting for every
   tab to close. */
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});