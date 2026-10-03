// Test harness for public/sw.js: a minimal CacheStorage + fetch + event
// shim so the service worker logic can be exercised in Node, with no
// browser and no extra dependencies.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SW_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "sw.js");
export const SUBPATH = "/FourCityRain/"; // simulate a GitHub Pages deployment

export function setup() {
  let pass = 0;
  let fail = 0;

  const check = (label, actual, expected) => {
    const ok = actual === expected;
    ok ? pass++ : fail++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` (got ${actual}, want ${expected})`}`,
    );
  };

  const summarize = () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    return fail;
  };

  // ---- minimal CacheStorage shim -------------------------------------
  const store = new Map();
  const caches = {
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      const entries = store.get(name);
      return {
        async addAll(urls) {
          for (const u of urls) entries.set(u, { status: 200, body: "cached-shell" });
        },
        async put(req, res) {
          entries.set(typeof req === "string" ? req : req.url, res);
        },
      };
    },
    async match(req) {
      const url = typeof req === "string" ? req : req.url;
      for (const entries of store.values()) if (entries.has(url)) return entries.get(url);
      return undefined;
    },
    async keys() {
      return [...store.keys()];
    },
    async delete(name) {
      return store.delete(name);
    },
  };

  class FakeEvent {
    constructor(req) {
      this.request = req;
      this.promises = [];
    }
    waitUntil(p) {
      this.promises.push(p);
    }
    respondWith(p) {
      this.promises.push(p);
    }
    async settle() {
      return Promise.all(this.promises);
    }
  }

  // Responses returned by the fake network need a clone(), which sw.js calls
  // before handing the original back to the page.
  const withClone = (res) => ({
    ...res,
    clone: () => withClone({ ...res }),
  });

  let fetchImpl = async () => withClone({ ok: true, status: 200, type: "basic" });
  const setFetch = (fn) => {
    fetchImpl = async (...args) => withClone(await fn(...args));
  };

  // Evaluate the real sw.js, capturing the handler it registers for each
  // event type. Each type gets its own `self` so addEventListener bags stay
  // separate.
  const handlers = {};
  const src = readFileSync(SW_PATH, "utf8");
  for (const type of ["install", "activate", "fetch", "message"]) {
    const bag = {};
    const fakeSelf = {
      location: new URL(`https://example.com${SUBPATH}sw.js`),
      addEventListener: (t, fn) => (bag[t] = fn),
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    };
    new Function("self", "caches", "fetch", "Response", "URL", src)(
      fakeSelf,
      caches,
      (...a) => fetchImpl(...a),
      { error: () => ({ error: true }) },
      URL,
    );
    handlers[type] = bag[type];
  }

  return {
    check,
    FakeEvent,
    handlers,
    store,
    caches,
    setFetch,
    summarize,
    shellUrl: `https://example.com${SUBPATH}index.html`,
  };
}