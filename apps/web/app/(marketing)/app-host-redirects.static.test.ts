/**
 * @jest-environment node
 */
// Lane 2A.2b: the main host sends every app path to the old host (one rule, the complement of one
// derived stays set), an alias that ends on an app path gets its own one-hop rule, and the short
// domain is a 301 to the main host when brand.json names one. Fixture hosts only: with the real
// values the hosts are equal, so every rule here is inert today. The old-host rules must stay
// byte-identical to the 2A.2a head (BASELINE_SHA), computed here from git.
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";

const { pathToRegexp } = require("next/dist/compiled/path-to-regexp");

const WEB_ROOT = path.resolve(__dirname, "../..");
const BASELINE_SHA = "74e20491ad";
const BASELINE_FILE = path.join(WEB_ROOT, ".host-baseline.tmp.mjs");

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
  baseline: Rule[];
  siteHostPorted: Rule[];
  publicPaths: string[];
}

function load(): Loaded {
  const base = execFileSync("git", ["show", `${BASELINE_SHA}:apps/web/next.config.mjs`], {
    cwd: WEB_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  fs.writeFileSync(BASELINE_FILE, base);
  try {
    const url = (file: string) => JSON.stringify(pathToFileURL(file).href);
    const script =
      `const m = await import(${url(path.join(WEB_ROOT, "next.config.mjs"))});` +
      `const b = await import(${url(BASELINE_FILE)});` +
      `const MAIN = ${JSON.stringify(MAIN)}; const SAME = ${JSON.stringify(SAME)};` +
      `const alias = [{ source: "/sign-in", destination: "/login" }];` +
      `process.stdout.write(JSON.stringify({` +
      ` equalApp: m.buildAppHostRedirects(SAME, alias),` +
      ` equalAll: m.buildRedirects(SAME),` +
      ` all: m.buildRedirects(MAIN),` +
      ` withShort: m.buildRedirects({ ...MAIN, shortOrigin: ${JSON.stringify(SHORT_ORIGIN)} }),` +
      ` shortIsMain: m.buildRedirects({ ...MAIN, shortOrigin: MAIN.origin }),` +
      ` shortIsMainBare: m.buildRedirects({ ...MAIN, shortOrigin: "https://new.test" }),` +
      ` baseline: b.buildRedirects(MAIN),` +
      ` siteHostPorted: m.buildSiteHostRedirects(MAIN, alias),` +
      ` publicPaths: [...Object.values(m.SITE_PAGES), "/privacy", "/terms"] }));`;
    return JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: WEB_ROOT,
        encoding: "utf8",
        timeout: 20_000,
      }),
    ) as Loaded;
  } finally {
    fs.rmSync(BASELINE_FILE, { force: true });
  }
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

// Every page.tsx and route.ts outside (marketing) and site-page, as the path it serves.
function appRoutes(): string[] {
  const root = path.join(WEB_ROOT, "app");
  const out: string[] = [];
  const walk = (dir: string, segments: string[]) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (segments.length === 0 && ["(marketing)", "site-page"].includes(entry.name)) continue;
        if (entry.name.startsWith("@")) continue;
        const seg = /^\(.*\)$/.test(entry.name)
          ? []
          : [entry.name.startsWith("[") ? "x1" : entry.name];
        walk(path.join(dir, entry.name), [...segments, ...seg]);
      } else if (entry.name === "page.tsx" || entry.name === "route.ts") {
        out.push(`/${segments.join("/")}`);
      }
    }
  };
  walk(root, []);
  if (out.length === 0) throw new Error("census found no app route: the sweep is broken");
  return out.sort();
}

const PUBLIC_DIR_ENTRIES = fs.readdirSync(path.join(WEB_ROOT, "public"));

describe("K5 1: equal hosts", () => {
  it("add no main-host rule", () => {
    expect(cfg.equalApp).toEqual([]);
    expect(cfg.equalAll.filter((r) => r.has)).toEqual([]);
  });
});

describe("K5 2: census, every app route goes to the old host in one 307 hop", () => {
  // An app page at a public path is shadowed by that page's beforeFiles rewrite, so the path is
  // served by the site and stays on the main host (today: the dashboard's /getting-started).
  const SHADOWED = appRoutes().filter((r) => cfg.publicPaths.includes(r));
  const ROUTES = appRoutes().filter((r) => !cfg.publicPaths.includes(r));

  it("the only app routes left out are those a public page already serves", () => {
    expect(SHADOWED).toEqual(["/getting-started"]);
    for (const route of SHADOWED) {
      expect(hopOf(cfg.all, new URL(route, `https://${MAIN_HOST}`))).toBeNull();
    }
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
    for (const source of appRoutes()) {
      if (cfg.publicPaths.includes(source)) continue;
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

describe("K5 6: the old-host rules are byte-identical to the 2A.2a head", () => {
  it("the new list minus the main-host and short-domain rules is the baseline", () => {
    const rest = cfg.withShort.filter((r) => !isAppRule(r) && !isShortRule(r));
    expect(JSON.stringify(rest)).toBe(JSON.stringify(cfg.baseline));
    expect(JSON.stringify(cfg.all.filter((r) => !isAppRule(r)))).toBe(JSON.stringify(cfg.baseline));
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

  it("makes no rule when the short host is the main host, bare or www", () => {
    for (const rules of [cfg.shortIsMain, cfg.shortIsMainBare]) {
      expect(rules.filter(isShortRule)).toEqual([]);
      expect(rules.filter((r) => r.statusCode !== undefined)).toEqual([]);
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
