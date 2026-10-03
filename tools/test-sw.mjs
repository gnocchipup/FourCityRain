// Simulates the sw.js install/activate/fetch handlers against a fake Cache
// and fetch, to verify routing and the offline fallback without a browser.
// Run with: node tools/test-sw.mjs
import { setup, SUBPATH } from "./sw-harness.mjs";

const { check, FakeEvent, handlers, store, caches, setFetch, summarize, shellUrl } = setup();

// ---- 1. install precaches the shell at the subpath -------------------
const installEvent = new FakeEvent();
handlers.install(installEvent);
await installEvent.settle();
check(
  "install precaches index.html at subpath",
  store.get("four-city-rain-shell-v1")?.has(shellUrl),
  true,
);

// ---- 2. activate keeps the current cache -----------------------------
const activateEvent = new FakeEvent();
handlers.activate(activateEvent);
await activateEvent.settle();
check("activate keeps current cache", store.has("four-city-rain-shell-v1"), true);

// ---- 3. stale caches are purged -------------------------------------
store.set("four-city-rain-shell-v0", new Map());
const purgeEvent = new FakeEvent();
handlers.activate(purgeEvent);
await purgeEvent.settle();
check("activate deletes stale versions", store.has("four-city-rain-shell-v0"), false);

// ---- 4. cross-origin API calls are NOT intercepted ------------------
let intercepted = false;
setFetch(async () => {
  intercepted = true;
  return { ok: true, status: 200, type: "basic" };
});
const apiEvent = new FakeEvent({
  url: "https://api.open-meteo.com/v1/forecast?lat=1",
  method: "GET",
});
handlers.fetch(apiEvent);
check(
  "cross-origin API call bypasses SW",
  intercepted === false && apiEvent.promises.length === 0,
  true,
);

// ---- 5. cross-origin responses are never cached ---------------------
const apiCacheEvent = new FakeEvent({
  url: "https://api.open-meteo.com/v1/forecast",
  method: "GET",
});
handlers.fetch(apiCacheEvent);
await apiCacheEvent.settle();
check(
  "API response never written to a cache",
  [...store.values()].some((e) =>
    e.has("https://api.open-meteo.com/v1/forecast"),
  ),
  false,
);

// ---- 6. non-GET requests pass through -------------------------------
let postIntercepted = false;
setFetch(async () => {
  postIntercepted = true;
  return { ok: true, status: 200, type: "basic" };
});
const postEvent = new FakeEvent({
  url: `https://example.com${SUBPATH}api`,
  method: "POST",
});
handlers.fetch(postEvent);
check(
  "POST is not intercepted",
  postIntercepted === false && postEvent.promises.length === 0,
  true,
);

// ---- 7. navigation online uses the network --------------------------
setFetch(async () => ({ ok: true, status: 200, type: "basic", net: true }));
const navEvent = new FakeEvent({
  url: `https://example.com${SUBPATH}`,
  method: "GET",
  mode: "navigate",
});
handlers.fetch(navEvent);
const navRes = await navEvent.settle();
check("navigation serves network response", navRes[0].net === true, true);

// ---- 8. navigation OFFLINE falls back to the cached shell -----------
// Test 7 refreshed the shell cache with the network response, so re-seed a
// recognisable entry to prove the fallback reads from cache.
store.get("four-city-rain-shell-v1").set(shellUrl, { body: "cached-shell" });
setFetch(async () => {
  throw new Error("offline");
});
const offEvent = new FakeEvent({
  url: `https://example.com${SUBPATH}`,
  method: "GET",
  mode: "navigate",
});
handlers.fetch(offEvent);
const offRes = await offEvent.settle();
check("offline navigation falls back to shell", offRes[0].body, "cached-shell");

// ---- 9. stale-while-revalidate serves cache first -------------------
const assetUrl = `https://example.com${SUBPATH}assets/index-abc.js`;
await caches.open("four-city-rain-assets-v1");
store.get("four-city-rain-assets-v1").set(assetUrl, { body: "cached-asset" });
setFetch(async () => ({ ok: true, status: 200, type: "basic", net: true }));
const assetEvent = new FakeEvent({ url: assetUrl, method: "GET" });
handlers.fetch(assetEvent);
const assetRes = await assetEvent.settle();
check("asset served from cache immediately", assetRes[0].body, "cached-asset");

// ---- 10. uncached asset comes from network -------------------------
const freshEvent = new FakeEvent({
  url: `https://example.com${SUBPATH}assets/new.js`,
  method: "GET",
});
handlers.fetch(freshEvent);
const freshRes = await freshEvent.settle();
check("uncached asset comes from network", freshRes[0].net === true, true);

process.exit(summarize() === 0 ? 0 : 1);