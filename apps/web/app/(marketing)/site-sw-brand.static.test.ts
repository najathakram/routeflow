/**
 * @jest-environment node
 */
// T39 (spec-delta risk 5): the service worker and the PWA must not cache the brand files wrongly, or a
// visitor keeps the old mark after the switch. Pinned here: pages are network-first, the brand files the
// site names are fetched network-first (they sit under /site/), cross-origin and API requests are never
// touched, and the PWA starts at /dashboard, never on a cached marketing page.
// The older audit rows (stale /site/ copy loses to the network, v3 cache dropped, app assets cache-first)
// live in service-worker.static.test.ts and are not repeated. This file runs the real worker in a fake
// worker scope, the same way, and reads the real manifests and the brand file.
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

type Manifest = { start_url: string; scope: string; icons: Array<{ src: string }> };
type Handler = (event: Record<string, unknown>) => void;

const PUBLIC_DIR = path.resolve(__dirname, "../../public");
const SW_SOURCE = fs.readFileSync(path.join(PUBLIC_DIR, "sw.js"), "utf8");
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const OPERATOR = readJson(path.join(PUBLIC_DIR, "operator-manifest.json")) as Manifest;
const BUYER = readJson(path.join(PUBLIC_DIR, "buyer-manifest.json")) as Manifest;
const BRAND = readJson(
  path.resolve(__dirname, "../../../../packages/types/brand/brand.json"),
) as Record<string, unknown>;

const ORIGIN = "https://site.test";
const CURRENT = /CACHE_VERSION = "([^"]+)"/.exec(SW_SOURCE)![1];

function bootWorker(opts: { cached: Record<string, string>; network: Record<string, string> }) {
  const handlers: Record<string, Handler> = {};
  const store = new Map<string, string>(Object.entries(opts.cached));
  const respond = (body: string) => ({ ok: true, body, clone: () => respond(body) });
  const cache = {
    match: async (req: { url: string }) =>
      store.has(req.url) ? respond(store.get(req.url)!) : undefined,
    put: async (req: { url: string }, res: { body: string }) => void store.set(req.url, res.body),
  };
  const caches = {
    keys: async () => [CURRENT],
    delete: async () => true,
    open: async () => cache,
    match: cache.match,
  };
  const fetchFn = async (req: { url: string }) => {
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
    store,
    /** undefined when the worker passes the request through (it never called respondWith). */
    async fetchOf(url: string, method = "GET"): Promise<string | undefined> {
      let pending: Promise<{ body: string }> | undefined;
      handlers.fetch({
        request: { method, url },
        respondWith: (p: Promise<{ body: string }>) => void (pending = p),
      });
      return pending ? (await pending).body : undefined;
    },
  };
}

const brandPaths = (): string[] => {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string" && /^\/(site|brand)\/.+\.(png|svg|ico)$/.test(v)) out.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(BRAND);
  return [...new Set(out)];
};
const underSite = () => brandPaths().filter((p) => p.startsWith("/site/"));

describe("T39: service worker, pages", () => {
  it.each(["/", "/pricing", "/product", "/dashboard", "/buyer/portal"])(
    "%s is network-first: a stale cached page loses to the network",
    async (p) => {
      const url = `${ORIGIN}${p}`;
      const w = bootWorker({ cached: { [url]: "OLD" }, network: { [url]: "NEW" } });
      expect(await w.fetchOf(url)).toBe("NEW");
    },
  );

  it("a page falls back to the cached copy only when the network is down", async () => {
    const url = `${ORIGIN}/pricing`;
    expect(await bootWorker({ cached: { [url]: "OLD" }, network: {} }).fetchOf(url)).toBe("OLD");
  });

  it("a page response is not stored by the worker", async () => {
    const url = `${ORIGIN}/pricing`;
    const w = bootWorker({ cached: {}, network: { [url]: "NEW" } });
    await w.fetchOf(url);
    expect(w.store.size).toBe(0);
  });

  it.each([
    ["an API call", `${ORIGIN}/api/v1/health`],
    ["a Next.js internal", `${ORIGIN}/_next/static/chunk.js`],
    ["another origin's brand file", "https://other.test/site/img/mark.png"],
  ])("%s is passed through, never cached", async (_n, url) => {
    const w = bootWorker({ cached: { [url]: "OLD" }, network: { [url]: "NEW" } });
    expect(await w.fetchOf(url)).toBeUndefined();
  });

  it("a non-GET request is passed through", async () => {
    const url = `${ORIGIN}/site/img/mark.png`;
    const w = bootWorker({ cached: {}, network: { [url]: "NEW" } });
    expect(await w.fetchOf(url, "POST")).toBeUndefined();
  });
});

describe("T39: service worker, brand files", () => {
  it("the brand file names at least two files under /site/ (guards a vacuous pass)", () => {
    expect(underSite().length).toBeGreaterThanOrEqual(2);
  });

  it("the brand paths under /site/ exist on disk", () => {
    for (const p of underSite()) expect(fs.existsSync(path.join(PUBLIC_DIR, p))).toBe(true);
  });

  it.each(underSite())("%s is fetched network-first: a stale cached mark loses", async (p) => {
    const url = `${ORIGIN}${p}`;
    const w = bootWorker({ cached: { [url]: "OLD" }, network: { [url]: "NEW" } });
    expect(await w.fetchOf(url)).toBe("NEW");
    expect(w.store.get(url)).toBe("NEW");
  });

  it.each(underSite())("%s is served from the cache only while offline", async (p) => {
    const url = `${ORIGIN}${p}`;
    expect(await bootWorker({ cached: { [url]: "OLD" }, network: {} }).fetchOf(url)).toBe("OLD");
  });

  it("the network-first treatment of static files is gated on /site/ alone", () => {
    expect(SW_SOURCE).toMatch(/isMarketingFile\s*=\s*url\.pathname\.startsWith\("\/site\/"\)/);
    expect(SW_SOURCE).toMatch(/if\s*\(\s*isStaticAsset\s*&&\s*isMarketingFile\s*\)/);
  });

  // SA-1203 A3: brand files under /brand/ are served cache-first, and the switch gives every /brand/ key a
  // NEW file name (the old files stay), so a cached old icon is never served for the new name. This pins the
  // strategy; if it changes, the switch-day row (every /brand/ key differs from its pre-switch value) must be
  // looked at again. sw.js is not changed for the site.
  it.each(brandPaths().filter((p) => p.startsWith("/brand/")))(
    "%s is cache-first: a cached copy wins and the network is not asked",
    async (p) => {
      const url = `${ORIGIN}${p}`;
      const w = bootWorker({ cached: { [url]: "CACHED" }, network: { [url]: "NEW" } });
      expect(await w.fetchOf(url)).toBe("CACHED");
    },
  );

  it("only /site/ is network-first and /brand/ is cache-first in the worker source", () => {
    expect(SW_SOURCE).not.toMatch(/startsWith\("\/brand\/"\)/);
    expect(SW_SOURCE).toMatch(
      /\/\/ Cache-first: static assets change rarely\s*\n\s*event\.respondWith/,
    );
    expect(SW_SOURCE).toMatch(/STATIC_EXTENSIONS\s*=\s*\[[^\]]*"\.png"/);
  });

  it("every brand file outside /site/ is a file under /brand/ that exists (a new location needs a row here)", () => {
    const outside = brandPaths().filter((p) => !p.startsWith("/site/"));
    expect(outside.length).toBeGreaterThan(0);
    for (const p of outside) {
      expect(p.startsWith("/brand/")).toBe(true);
      expect(fs.existsSync(path.join(PUBLIC_DIR, p))).toBe(true);
    }
  });
});

describe("T39: the PWA", () => {
  it("the operator app starts at /dashboard", () => {
    expect(OPERATOR.start_url).toBe("/dashboard");
  });

  it.each([
    ["operator", OPERATOR],
    ["buyer", BUYER],
  ])("the %s manifest starts inside its scope and never on a marketing page", (_n, m) => {
    expect(m.start_url.startsWith(m.scope === "/" ? "/" : `${m.scope}/`)).toBe(true);
    expect(m.start_url).not.toBe("/");
    expect(m.start_url.startsWith("/site/")).toBe(false);
  });

  it("the buyer app is scoped to /buyer, so no marketing page opens inside it", () => {
    expect(BUYER.scope).toBe("/buyer");
    expect(BUYER.start_url).toBe("/buyer/portal");
  });

  it("every manifest icon exists on disk", () => {
    for (const m of [OPERATOR, BUYER])
      for (const i of m.icons) expect(fs.existsSync(path.join(PUBLIC_DIR, i.src))).toBe(true);
  });
});
