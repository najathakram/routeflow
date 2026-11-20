/**
 * @jest-environment node
 */
// Lane 2A.2b: the main host sends every app path to the old host (one rule, the complement of one
// derived stays set), an alias that ends on an app path gets its own one-hop rule, and the short
// domain is a 301 to the main host when brand.json names one. Fixture hosts only: with the real
// values the hosts are equal, so every rule here is inert today. The old-host rules and the rules
// that are not host rules must stay exactly what their own builders give (compared in process).
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";
import { SHELL_UA_PRODUCT } from "@routeflow/ui/shell-bridge";
import { BUYER_PRESENCE_COOKIE, OP_PRESENCE_COOKIE } from "@/lib/presence-cookies";

const { pathToRegexp } = require("next/dist/compiled/path-to-regexp");
const { checkCustomRoutes } = require("next/dist/lib/load-custom-routes");

const WEB_ROOT = path.resolve(__dirname, "../..");

interface Rule {
  source: string;
  destination: string;
  permanent?: boolean;
  statusCode?: number;
  has?: Array<{ type: string; value: string }>;
  missing?: Array<{ type: string; key: string; value?: string }>;
}

// Fixture hosts, with ports (the host pattern matches the name without one).
const MAIN = { origin: "https://www.new.test:8443", oldOrigin: "https://www.old.test:8444" };
const SHORT_ORIGIN = "https://go.short.test";
const SAME = { origin: "https://www.same.test", oldOrigin: "https://www.same.test" };
const MAIN_HOST = "www.new.test";
const OLD_HOST = "www.old.test";
const OLD_ORIGIN = "https://www.old.test:8444";
const SHORT_HOSTS = ["go.short.test", "www.go.short.test"];
const BROWSER = "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36";
const escDots = (host: string) => host.replace(/\./g, "\\.");

interface Loaded {
  equalApp: Rule[];
  equalAll: Rule[];
  all: Rule[];
  withShort: Rule[];
  shortIsMain: Rule[];
  shortIsMainBare: Rule[];
  expectedRest: Rule[];
  bareShortIsMain: Rule[];
  bareShortIsMainWww: Rule[];
  siteHostPorted: Rule[];
  publicPaths: string[];
  routes: Route[];
  failClosed: Record<string, { ok?: string[]; error?: string }>;
}

interface Route {
  path: string;
  file: string;
  group: string;
  metadata: boolean;
}

// Nothing is written: the config is imported in a child process and its output read from stdout.
function load(): Loaded {
  const url = JSON.stringify(pathToFileURL(path.join(WEB_ROOT, "next.config.mjs")).href);
  const libUrl = JSON.stringify(
    pathToFileURL(path.join(WEB_ROOT, "lib", "app-route-paths.mjs")).href,
  );
  const script =
    `const m = await import(${url});` +
    `const l = await import(${libUrl});` +
    `const tryIt = (routes) => { try { return { ok: l.placeStays(routes) }; } catch (e) { return { error: e.message }; } };` +
    `const MAIN = ${JSON.stringify(MAIN)}; const SAME = ${JSON.stringify(SAME)};` +
    `const BARE = { origin: "https://new.test", oldOrigin: "https://old.test" };` +
    `const alias = [{ source: "/sign-in", destination: "/login" }];` +
    `process.stdout.write(JSON.stringify({` +
    ` equalApp: m.buildAppHostRedirects(SAME, alias),` +
    ` equalAll: m.buildRedirects(SAME),` +
    ` all: m.buildRedirects(MAIN),` +
    ` withShort: m.buildRedirects({ ...MAIN, shortOrigin: ${JSON.stringify(SHORT_ORIGIN)} }),` +
    ` shortIsMain: m.buildRedirects({ ...MAIN, shortOrigin: MAIN.origin }),` +
    ` shortIsMainBare: m.buildRedirects({ ...MAIN, shortOrigin: "https://new.test" }),` +
    ` bareShortIsMain: m.buildRedirects({ ...BARE, shortOrigin: "https://new.test" }),` +
    ` bareShortIsMainWww: m.buildRedirects({ ...BARE, shortOrigin: "https://www.new.test" }),` +
    ` expectedRest: [...m.buildSiteHostRedirects(MAIN, m.HOST_ALIASES), ...m.buildRedirects(SAME)],` +
    ` siteHostPorted: m.buildSiteHostRedirects(MAIN, alias),` +
    ` routes: l.listAppRoutes(),` +
    ` failClosed: {` +
    `  dynamicInMarketing: tryIt([{ path: "/[x]", file: "(marketing)/[x]/page.tsx", group: "(marketing)", metadata: false }]),` +
    `  metadataInMarketing: tryIt([{ path: "/a/icon", file: "(marketing)/a/icon.png", group: "(marketing)", metadata: true }]),` +
    `  hashedAtRoot: tryIt([{ path: "/icon", file: "icon.png", group: "", metadata: true }]),` +
    `  fixedAtRoot: tryIt([{ path: "/robots.txt", file: "robots.ts", group: "", metadata: true }, { path: "/sitemap.xml", file: "sitemap.ts", group: "", metadata: true }]),` +
    `  dynamicElsewhere: tryIt([{ path: "/a/[x]", file: "a/[x]/page.tsx", group: "a", metadata: false }]),` +
    ` },` +
    ` publicPaths: [...Object.values(m.SITE_PAGES), "/privacy", "/terms"] }));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: WEB_ROOT,
      encoding: "utf8",
      timeout: 20_000,
    }),
  ) as Loaded;
}

const cfg = load();

// Next's own source matcher, then its destination fill-in (params by name, the query carried over).
function matches(rule: Rule, at: URL, userAgent: string, cookies: string[]) {
  const params: Record<string, string> = {};
  const keys: Array<{ name: string | number }> = [];
  const m = pathToRegexp(rule.source, keys).exec(at.pathname);
  if (!m) return null;
  keys.forEach((k, i) => (params[String(k.name)] = m[i + 1] ?? ""));
  const hostOk = (rule.has ?? []).every((h) => new RegExp(`^${h.value}$`).test(at.hostname));
  const missingOk = (rule.missing ?? []).every((x) =>
    x.type === "cookie" ? !cookies.includes(x.key) : !new RegExp(`^${x.value}$`).test(userAgent),
  );
  if (!hostOk || !missingOk) return null;
  return params;
}

function hopOf(rules: Rule[], at: URL, userAgent = BROWSER, cookies: string[] = []) {
  for (const rule of rules) {
    const params = matches(rule, at, userAgent, cookies);
    if (!params) continue;
    const dest = rule.destination.replace(/:([A-Za-z_]\w*)\*?/g, (_s, n) => params[n] ?? "");
    const next = new URL(dest, at.origin);
    next.search = at.search;
    return { rule, next };
  }
  return null;
}

function follow(rules: Rule[], host: string, url: string) {
  let at = new URL(url, `https://${host}`);
  let hostChanges = 0;
  const trail: string[] = [];
  for (let i = 0; i < 8; i++) {
    const hop = hopOf(rules, at);
    if (!hop) return { at, hostChanges, trail };
    if (hop.next.host !== at.host) hostChanges++;
    trail.push(`${at.host}${at.pathname} -> ${hop.next.host}${hop.next.pathname}`);
    at = hop.next;
  }
  throw new Error(`no end: ${trail.join(" | ")}`);
}

const isAppRule = (r: Rule) => r.has?.some((h) => h.value === escDots(MAIN_HOST));
const isShortRule = (r: Rule) => r.has?.some((h) => SHORT_HOSTS.map(escDots).includes(h.value));

// Every route the one walker (lib/app-route-paths.mjs) finds, sorted into three sides by its place:
// STAY (a (marketing) route, an app-root metadata route, or a pinned shadowed page), EXEMPT (only
// site-page, the rewrite target) and CROSS (everything else). A new folder exemption is red.
const fill = (p: string) => p.replace(/\[[^\]]+\]/g, "x1");
const ENTRIES = cfg.routes;
if (ENTRIES.length === 0) throw new Error("census found no app route: the sweep is broken");
const PINNED_STAY = ["/getting-started"];
const isPlaceStay = (e: Route) => e.group === "(marketing)" || (e.group === "" && e.metadata);
const EXEMPT = ENTRIES.filter((e) => e.group === "site-page");
const STAY = ENTRIES.filter((e) => isPlaceStay(e) || PINNED_STAY.includes(e.path));
const CROSS = ENTRIES.filter((e) => !STAY.includes(e) && !EXEMPT.includes(e));
const appRoutes = () => ENTRIES.map((e) => fill(e.path)).sort();
const crossPaths = () => CROSS.map((e) => fill(e.path)).sort();

const PUBLIC_DIR_ENTRIES = fs.readdirSync(path.join(WEB_ROOT, "public"));

describe("K5 1: equal hosts", () => {
  it("add no main-host rule", () => {
    expect(cfg.equalApp).toEqual([]);
    expect(cfg.equalAll.filter((r) => r.has)).toEqual([]);
  });
});

describe("K5 2: census, every app route goes to the old host in one 307 hop", () => {
  const staysOnMain = (route: string) => {
    const at = new URL(route, `https://${MAIN_HOST}`);
    const hop = hopOf(cfg.all, at);
    return hop === null || hop.next.host === at.host;
  };
  const ROUTES = crossPaths();

  it("the walker sees the route.tsx files and the metadata routes the old census missed", () => {
    expect(ENTRIES.some((e) => e.file.endsWith("route.tsx"))).toBe(true);
    expect(ENTRIES.map((e) => e.path)).toEqual(
      expect.arrayContaining(["/opengraph-image", "/robots.txt", "/sitemap.xml"]),
    );
    expect(ENTRIES.some((e) => /\.test\./.test(e.file))).toBe(false);
  });

  it("the pin carries intent: STAY stays, EXEMPT is only site-page, CROSS crosses", () => {
    expect([...new Set(EXEMPT.map((e) => e.group))]).toEqual(["site-page"]);
    expect(EXEMPT.length).toBeGreaterThan(0);
    expect(STAY.length + EXEMPT.length + CROSS.length).toBe(ENTRIES.length);
    expect(STAY.map((e) => e.path).sort()).toEqual(
      expect.arrayContaining([
        "/opengraph-image",
        "/privacy",
        "/terms",
        "/robots.txt",
        "/sitemap.xml",
      ]),
    );
    // No (marketing) route keeps the old host.
    for (const e of ENTRIES.filter((x) => x.group === "(marketing)")) {
      expect(staysOnMain(fill(e.path))).toBe(true);
    }
    for (const e of STAY) expect(staysOnMain(fill(e.path))).toBe(true);
    for (const e of CROSS)
      expect({ path: e.path, crosses: !staysOnMain(fill(e.path)) }).toEqual({
        path: e.path,
        crosses: true,
      });
  });

  it("the shadowed page is pinned to exactly /getting-started", () => {
    const shadowed = ENTRIES.filter((e) => !isPlaceStay(e) && e.group !== "site-page").filter((e) =>
      staysOnMain(fill(e.path)),
    );
    expect(shadowed.map((e) => e.path)).toEqual(PINNED_STAY);
    expect(cfg.publicPaths).toContain("/getting-started");
  });

  it("fails closed on a dynamic segment or a hashed metadata file in a place that stays", () => {
    const fc = cfg.failClosed;
    expect(fc.dynamicInMarketing.error).toMatch(/dynamic segment/);
    expect(fc.metadataInMarketing.error).toMatch(/hashed address/);
    expect(fc.hashedAtRoot.error).toMatch(/hashed address/);
    expect(fc.fixedAtRoot.ok).toEqual(["/robots.txt", "/sitemap.xml"]);
    expect(fc.dynamicElsewhere.ok).toEqual([]);
  });

  it("no host rule's destination carries a query (Next merges the source query itself)", () => {
    const hostRules = cfg.withShort.filter((r) => r.has);
    expect(hostRules.length).toBeGreaterThan(40);
    for (const rule of hostRules) expect(rule.destination).not.toContain("?");
  });

  it("Next's own route check accepts every built redirect, each source under 4096 characters", () => {
    expect(() => checkCustomRoutes(cfg.withShort, "redirect")).not.toThrow();
    for (const rule of cfg.withShort) expect(rule.source.length).toBeLessThan(4096);
  });

  it("finds the app routes", () => {
    expect(ROUTES.length).toBeGreaterThan(50);
    expect(ROUTES).toContain("/login");
    expect(ROUTES).toContain("/buyer/portal/x1/orders/x1");
  });

  it.each(ROUTES)("%s keeps its path and query on the old host", (route) => {
    const hop = hopOf(cfg.all, new URL(`${route}?next=/x`, `https://${MAIN_HOST}`));
    expect(hop).not.toBeNull();
    expect(hop!.rule.permanent).toBe(false);
    expect(hop!.rule.statusCode).toBeUndefined();
    expect(hop!.next.origin).toBe(OLD_ORIGIN);
    expect(hop!.next.pathname).toBe(route);
    expect(hop!.next.search).toBe("?next=/x");
  });

  it("the one rule has no missing list and escaped dots on the main host", () => {
    const rules = cfg.all.filter(isAppRule).filter((r) => r.source.startsWith("/:path("));
    expect(rules).toHaveLength(1);
    expect(rules[0].missing).toBeUndefined();
    expect(rules[0].has).toEqual([{ type: "host", value: escDots(MAIN_HOST) }]);
    expect(rules[0].permanent).toBe(false);
  });
});

describe("K5 3: the stays samples match no host-crossing rule", () => {
  const SAMPLES = [
    ...cfg.publicPaths,
    "/_next/static/x.js",
    "/site/css/home.css",
    "/site/home.html",
    "/brand/x",
    "/robots.txt",
    "/sitemap.xml",
    "/favicon.ico",
    "/.well-known/x",
    "/pricing/",
    "/opengraph-image",
    ...PUBLIC_DIR_ENTRIES.map((name) => `/${name}`),
  ];

  it.each([...new Set(SAMPLES)])("%s stays on the main host", (sample) => {
    const at = new URL(`${sample}?q=1`, `https://${MAIN_HOST}`);
    const hop = hopOf(cfg.all, at);
    expect(hop === null || hop.next.host === at.host).toBe(true);
  });

  it("an app path next to a stays name is not swallowed", () => {
    for (const near of ["/pricing-x", "/brandx", "/site2", "/_nextx"]) {
      const hop = hopOf(cfg.all, new URL(near, `https://${MAIN_HOST}`));
      expect(hop?.next.origin).toBe(OLD_ORIGIN);
    }
  });
});

describe("K5 4: an alias that ends on an app path", () => {
  it("/sign-in reaches the old host's /login in one hop", () => {
    const { at, trail } = follow(cfg.all, MAIN_HOST, "/sign-in?utm_source=x");
    expect(trail).toHaveLength(1);
    expect(at.origin).toBe(OLD_ORIGIN);
    expect(at.pathname).toBe("/login");
    expect(at.search).toBe("?utm_source=x");
  });
});

describe("K5 5: no loop", () => {
  const concrete = cfg.all.map((r) => r.source).filter((s) => !s.includes(":"));
  const SOURCES = [...new Set([...concrete, ...appRoutes(), "/", "/_next/x", "/robots.txt"])];

  it.each([MAIN_HOST, OLD_HOST])(
    "every source on %s ends after at most one host change",
    (host) => {
      expect(SOURCES.length).toBeGreaterThan(40);
      for (const source of SOURCES) {
        const { hostChanges, trail } = follow(cfg.withShort, host, source);
        expect({ source, trail, ok: hostChanges <= 1 }).toMatchObject({ ok: true });
      }
    },
  );

  it.each(SHORT_HOSTS)("%s: every stays source ends after one host change", (host) => {
    for (const source of cfg.publicPaths) {
      const { hostChanges, at } = follow(cfg.withShort, host, source);
      expect(hostChanges).toBe(1);
      expect(at.host).toBe(new URL(MAIN.origin).host);
    }
  });

  it.each(SHORT_HOSTS)("%s: every app path ends after one host change, on the old host", (host) => {
    for (const source of crossPaths()) {
      const { hostChanges, at } = follow(cfg.withShort, host, `${source}?next=/x`);
      expect({ source, hostChanges }).toEqual({ source, hostChanges: 1 });
      expect(at.origin).toBe(OLD_ORIGIN);
    }
  });

  it.each(SHORT_HOSTS)("%s: /login?next=/x makes one 307 to the old host", (host) => {
    const hop = hopOf(cfg.withShort, new URL("/login?next=/x", `https://${host}`));
    expect(hop!.rule.permanent).toBe(false);
    expect(hop!.rule.statusCode).toBeUndefined();
    expect(hop!.next.origin).toBe(OLD_ORIGIN);
    expect(hop!.next.pathname).toBe("/login");
    expect(hop!.next.search).toBe("?next=/x");
    const signIn = follow(cfg.withShort, host, "/sign-in");
    expect(signIn.trail).toHaveLength(1);
    expect(signIn.at.pathname).toBe("/login");
  });
});

describe("K5 6: the old-host rules and the other redirects are unchanged by the new rules", () => {
  it("the list minus the main-host and short-domain rules is the old-host rules plus the rest", () => {
    expect(cfg.expectedRest.length).toBeGreaterThan(20);
    const rest = cfg.withShort.filter((r) => !isAppRule(r) && !isShortRule(r));
    expect(JSON.stringify(rest)).toBe(JSON.stringify(cfg.expectedRest));
    expect(JSON.stringify(cfg.all.filter((r) => !isAppRule(r)))).toBe(
      JSON.stringify(cfg.expectedRest),
    );
  });

  it("every host rule's missing list is exactly the shell header and the two presence cookies", () => {
    const oldRules = cfg.all.filter((r) => r.has?.some((h) => h.value === escDots(OLD_HOST)));
    expect(oldRules.length).toBeGreaterThan(10);
    for (const rule of oldRules) {
      expect(rule.missing).toEqual([
        { type: "header", key: "user-agent", value: `.*${SHELL_UA_PRODUCT}.*` },
        { type: "cookie", key: OP_PRESENCE_COOKIE },
        { type: "cookie", key: BUYER_PRESENCE_COOKIE },
      ]);
    }
  });

  it("the old-host rules still carry the shell and cookie exemptions", () => {
    const oldRules = cfg.all.filter((r) => r.has?.some((h) => h.value === escDots(OLD_HOST)));
    expect(oldRules.length).toBeGreaterThan(10);
    for (const r of oldRules) expect(r.missing).toHaveLength(3);
  });
});

describe("the 2A.2a leftovers: a host with a port", () => {
  it("the host pattern is the escaped name, never the port", () => {
    expect(cfg.siteHostPorted.length).toBeGreaterThan(0);
    for (const r of cfg.siteHostPorted) {
      expect(r.has).toEqual([{ type: "host", value: "www\\.old\\.test" }]);
      expect(r.destination.startsWith("https://www.new.test:8443")).toBe(true);
    }
  });

  it("the escaped dots do not match another name", () => {
    for (const r of [...cfg.siteHostPorted, ...cfg.all.filter(isAppRule)]) {
      const re = new RegExp(`^${r.has![0].value}$`);
      expect(re.test("wwwXoldXtest")).toBe(false);
      expect(re.test("wwwXnewXtest")).toBe(false);
    }
  });
});

describe("the short domain", () => {
  const short = cfg.withShort.filter(isShortRule);

  it("is one 301 rule per host form, to the main host, path and query kept", () => {
    const moved = short.filter((r) => r.statusCode === 301);
    expect(moved).toHaveLength(2);
    expect(moved.map((r) => r.has![0].value).sort()).toEqual(SHORT_HOSTS.map(escDots).sort());
    for (const r of short) {
      expect(r.missing).toBeUndefined();
      expect("permanent" in r).toBe(r.statusCode === undefined);
    }
    for (const host of SHORT_HOSTS) {
      const at = new URL("/pricing?utm_source=x", `https://${host}`);
      const hop = hopOf(cfg.withShort, at);
      expect(hop!.rule.statusCode).toBe(301);
      expect(hop!.next.origin).toBe(MAIN.origin);
      expect(hop!.next.pathname).toBe("/pricing");
      expect(hop!.next.search).toBe("?utm_source=x");
      expect(hopOf(cfg.withShort, new URL("/", `https://${host}`))!.next.origin).toBe(MAIN.origin);
    }
  });

  it("the 301 rule matches no app path, on its own", () => {
    const moved = short.filter((r) => r.statusCode === 301);
    expect(moved).toHaveLength(2);
    const routes = crossPaths();
    expect(routes).toContain("/login");
    for (const rule of moved) {
      for (const route of [...routes, "/sign-in"]) {
        expect(pathToRegexp(rule.source).exec(route)).toBeNull();
      }
      expect(pathToRegexp(rule.source).exec("/pricing")).not.toBeNull();
    }
  });

  it("makes no rule when the short host is the main host, bare or www", () => {
    for (const rules of [
      cfg.shortIsMain,
      cfg.shortIsMainBare,
      cfg.bareShortIsMain,
      cfg.bareShortIsMainWww,
    ]) {
      expect(rules.filter(isShortRule)).toEqual([]);
      expect(rules.filter((r) => r.statusCode !== undefined)).toEqual([]);
      // As many host rules as with no short host at all: nothing was added on the main host's name.
      expect(rules.filter((r) => r.has)).toHaveLength(cfg.all.filter((r) => r.has).length);
    }
  });

  it("makes no rule when the key is absent", () => {
    expect(cfg.all.filter(isShortRule)).toEqual([]);
    expect(cfg.all.filter((r) => r.statusCode !== undefined)).toEqual([]);
  });

  it("brand.json does not carry the key yet", () => {
    const brand = JSON.parse(
      fs.readFileSync(path.join(WEB_ROOT, "../../packages/types/brand/brand.json"), "utf8"),
    );
    expect(brand.shortOrigin).toBeUndefined();
  });
});

describe("the partition pin: every host rule has exactly one owner", () => {
  const owners = (r: Rule) =>
    [r.has?.some((h) => h.value === escDots(OLD_HOST)), isAppRule(r), isShortRule(r)].filter(
      Boolean,
    ).length;
  const FOURTH: Rule = {
    source: "/:path*",
    has: [{ type: "host", value: escDots("www.fourth.test") }],
    destination: "https://www.new.test/:path*",
    permanent: false,
  };
  const unowned = (rules: Rule[]) => rules.filter((r) => r.has && owners(r) !== 1);

  it("every host rule in the list belongs to the old, main or short set, once", () => {
    expect(unowned(cfg.withShort)).toEqual([]);
    expect(unowned(cfg.all)).toEqual([]);
  });

  it("a rule on a fourth host fails the pin", () => {
    expect(unowned([...cfg.withShort, FOURTH])).toEqual([FOURTH]);
  });
});
