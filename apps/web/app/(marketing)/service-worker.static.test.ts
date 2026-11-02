/**
 * @jest-environment node
 */
// Site audit 2026-11-02 (defect 2): public/sw.js served every .js/.css/.woff2/.png file cache-first
// under one fixed CACHE_VERSION, and the marketing files under /site/ have fixed names. A visitor
// who had ever opened a React page kept the OLD home and pricing styles and scripts across every
// later deploy, while the HTML (network-first) was new. These rows run the real worker file in a
// small fake worker scope: a cached /site/ file must lose to the network, the old cache must be
// dropped on activate, and the app's own static files keep their cache-first speed.
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

const SW_SOURCE = fs.readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");
const ORIGIN = "https://www.routeflow.info";
const CURRENT = /CACHE_VERSION = "([^"]+)"/.exec(SW_SOURCE)![1];
const LEGACY = "routeflow-v3";

type Handler = (event: Record<string, unknown>) => void;

function bootWorker(opts: { cached: Record<string, string>; network: Record<string, string> }) {
  const handlers: Record<string, Handler> = {};
  const stores = new Map<string, Map<string, string>>();
  stores.set(CURRENT, new Map(Object.entries(opts.cached)));
  stores.set(LEGACY, new Map([[`${ORIGIN}/site/css/home.css`, "OLD"]]));
  const networkCalls: string[] = [];

  const respond = (body: string) => ({ ok: true, body, clone: () => respond(body) });
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (k: string) => stores.delete(k),
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        match: async (req: { url: string }) =>
          store.has(req.url) ? respond(store.get(req.url)!) : undefined,
        put: async (req: { url: string }, res: { body: string }) =>
          void store.set(req.url, res.body),
      };
    },
    match: async (req: { url: string }) => {
      for (const store of stores.values())
        if (store.has(req.url)) return respond(store.get(req.url)!);
      return undefined;
    },
  };
  const fetchFn = async (req: { url: string }) => {
    networkCalls.push(req.url);
    const body = opts.network[req.url];
    if (body === undefined) throw new Error("offline");
    return respond(body);
  };

  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, h: Handler) => void (handlers[type] = h),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  vm.runInNewContext(SW_SOURCE, { self, caches, fetch: fetchFn, URL, Promise });

  return {
    stores,
    networkCalls,
    async fetchOf(pathname: string): Promise<string | undefined> {
      const request = { method: "GET", url: `${ORIGIN}${pathname}` };
      let pending: Promise<{ body: string }> | undefined;
      handlers.fetch({
        request,
        respondWith: (p: Promise<{ body: string }>) => void (pending = p),
      });
      return pending ? (await pending).body : undefined;
    },
    async activate() {
      let pending: Promise<unknown> = Promise.resolve();
      handlers.activate({ waitUntil: (p: Promise<unknown>) => void (pending = p) });
      await pending;
    },
  };
}

describe("service worker keeps marketing files fresh (audit 2026-11-02, defect 2)", () => {
  it.each(["/site/css/home.css", "/site/js/home-up.js", "/site/fonts/Geist-Variable.woff2"])(
    "serves %s from the network when a stale copy is cached",
    async (file) => {
      const worker = bootWorker({
        cached: { [`${ORIGIN}${file}`]: "OLD" },
        network: { [`${ORIGIN}${file}`]: "NEW" },
      });
      expect(await worker.fetchOf(file)).toBe("NEW");
    },
  );

  it("still serves a cached /site/ file when the network is down", async () => {
    const file = "/site/css/home.css";
    const worker = bootWorker({ cached: { [`${ORIGIN}${file}`]: "OLD" }, network: {} });
    expect(await worker.fetchOf(file)).toBe("OLD");
  });

  it("drops the v3 cache on activate, so entries stored before this fix cannot be served", async () => {
    const worker = bootWorker({ cached: {}, network: {} });
    expect(CURRENT).not.toBe(LEGACY);
    await worker.activate();
    expect([...worker.stores.keys()]).toEqual([CURRENT]);
  });

  it("keeps the app's own static files cache-first", async () => {
    const file = "/icons/icon-192.png";
    const worker = bootWorker({
      cached: { [`${ORIGIN}${file}`]: "CACHED" },
      network: { [`${ORIGIN}${file}`]: "NEW" },
    });
    expect(await worker.fetchOf(file)).toBe("CACHED");
    expect(worker.networkCalls).toEqual([]);
  });
});
