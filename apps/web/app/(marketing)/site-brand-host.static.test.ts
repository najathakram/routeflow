/**
 * @jest-environment node
 */
// Lane 2A.2a: the redirect from the old site host to the new one, the one page list behind it, and
// the base address of the signed-out layouts. The hosts are not typed anywhere in the config: it
// reads origin (where the site is) and oldOrigin (the host being left) from the brand seam, so the
// day the two differ is a change of values only. With one host there is no rule (it would loop).
// next.config.mjs cannot import TypeScript, so its page list is checked here against the
// TypeScript lists. Public paths only are redirected; the sign-in pages keep working on the old host.
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";
import { SHELL_UA_PRODUCT, shellUserAgentToken } from "@routeflow/ui/shell-bridge";
import { STATIC_SITE_PAGE_NAMES } from "@/lib/static-site-page";
import { STATIC_SITE_PATHS } from "@/lib/umami-tag";
import { BUYER_PRESENCE_COOKIE, OP_PRESENCE_COOKIE } from "@/lib/presence-cookies";
import { site } from "./lib/site";

const WEB_ROOT = path.resolve(__dirname, "../..");

interface Rule {
  source: string;
  destination: string;
  permanent: boolean;
  has?: Array<{ type: string; value: string }>;
  missing?: Array<{ type: string; key: string; value?: string }>;
}

interface Loaded {
  SITE_PAGES: Record<string, string>;
  hosts: { origin: string; oldOrigin: string };
  today: Rule[];
  todayFromHosts: Rule[];
  rewrites: Array<{ source: string; destination: string }>;
  split: Rule[];
}

// Two different hosts (test values, not the site's): the day the values differ.
const SPLIT = { origin: "https://www.new.test", oldOrigin: "https://www.old.test" };

function load(): Loaded {
  const configUrl = pathToFileURL(path.join(WEB_ROOT, "next.config.mjs")).href;
  const script =
    `const m = await import(${JSON.stringify(configUrl)});` +
    `process.stdout.write(JSON.stringify({ SITE_PAGES: m.SITE_PAGES, hosts: m.readSiteHosts(),` +
    ` todayFromHosts: m.buildRedirects(m.readSiteHosts()),` +
    ` today: await m.default.redirects(),` +
    ` rewrites: (await m.default.rewrites()).beforeFiles,` +
    ` split: m.buildRedirects(${JSON.stringify(SPLIT)}) }));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: WEB_ROOT,
      encoding: "utf8",
      timeout: 15_000,
    }),
  ) as Loaded;
}

const cfg = load();
const PUBLIC_PATHS = [...Object.values(cfg.SITE_PAGES ?? {}), "/privacy", "/terms"];
const AUTH_PATHS = [
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/buyer/login",
  "/buyer/reset-password",
];
const NEW_HOST = new URL(SPLIT.origin).host;
// Next reads a host value as a pattern, so the dots are escaped; it matches the name without a port.
const OLD_HOST = new URL(SPLIT.oldOrigin).hostname.replace(/\./g, "\\.");
const OLD_HOSTNAME = new URL(SPLIT.oldOrigin).hostname;
const RAW_PATHS = Object.keys(cfg.SITE_PAGES ?? {}).map((page) => `/site/${page}.html`);
const LEGACY_SOURCES = [
  "/wholesalers",
  "/distributors",
  "/retailers",
  "/buyer",
  "/book-a-demo",
  "/demo",
  "/about",
  "/features",
  "/faq",
  "/integrations",
  "/quickbooks",
];

// A request for `url` on `host` and `userAgent`, answered the way Next answers it: the first rule
// whose source, host pattern and missing-header pattern all fit; a same-host destination continues,
// a destination on another host ends the walk. The request's query is carried over (Next's own
// behaviour for a redirect whose destination names none).
function follow(
  rules: Rule[],
  host: string,
  url: string,
  userAgent: string,
  cookies: string[] = [],
) {
  let at = new URL(url, `https://${host}`);
  const seen: string[] = [];
  for (;;) {
    const rule = rules.find(
      (r) =>
        r.source === at.pathname &&
        (r.has ?? []).every((h) => new RegExp(`^${h.value}$`).test(at.hostname)) &&
        (r.missing ?? []).every((m) =>
          m.type === "cookie"
            ? !cookies.includes(m.key)
            : !new RegExp(`^${m.value}$`).test(userAgent),
        ),
    );
    if (!rule) return { at, seen };
    expect(rule.destination).not.toContain("?");
    const next = new URL(rule.destination, at.origin);
    next.search = at.search;
    seen.push(`${at.host}${at.pathname} -> ${next.host}${next.pathname}`);
    expect(seen.length).toBeLessThan(5);
    at = next;
  }
}
const BROWSER = "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36";
const pathOf = (destination: string) =>
  destination.replace(/^https:\/\/[^/]+/, "").replace(/#.*$/, "") || "/";
const hostRules = cfg.split.filter((r) =>
  r.has?.some((h) => h.type === "host" && h.value === OLD_HOST),
);

describe("T31: one page list", () => {
  it("SITE_PAGES holds the same pages as STATIC_SITE_PAGE_NAMES and the same routes as STATIC_SITE_PATHS", () => {
    expect(cfg.SITE_PAGES).toBeDefined();
    expect(Object.keys(cfg.SITE_PAGES).sort()).toEqual([...STATIC_SITE_PAGE_NAMES].sort());
    expect(Object.values(cfg.SITE_PAGES).sort()).toEqual([...STATIC_SITE_PATHS].sort());
  });

  it("the rewrites are derived from it", () => {
    expect(cfg.rewrites.length).toBeGreaterThan(0);
    expect(cfg.rewrites.map((r) => [r.source, r.destination]).sort()).toEqual(
      Object.entries(cfg.SITE_PAGES)
        .map(([page, route]) => [route, `/site-page/${page}`])
        .sort(),
    );
  });
});

describe("T30: today's values (one host)", () => {
  it("the config reads both hosts from brand.json, and they are the same host", () => {
    const brand = JSON.parse(
      fs.readFileSync(path.join(WEB_ROOT, "../../packages/types/brand/brand.json"), "utf8"),
    );
    expect(cfg.hosts).toEqual({ origin: brand.origin, oldOrigin: brand.oldOrigin });
    expect(new URL(cfg.hosts.origin).host).toBe(new URL(cfg.hosts.oldOrigin).host);
  });

  it("redirects() holds no host rule (it would redirect the site to itself)", () => {
    expect(cfg.today.length).toBeGreaterThan(0);
    expect(cfg.today.filter((r) => r.has || r.missing)).toEqual([]);
    expect(cfg.today.filter((r) => r.destination.startsWith("https://"))).toEqual([]);
  });
});

describe("T30: the values differ (switch day)", () => {
  it.each(PUBLIC_PATHS)("%s has one host-matched, temporary rule to the new host", (source) => {
    const rules = hostRules.filter(
      (r) => r.source === source && r.destination.startsWith("https://"),
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].has).toEqual([{ type: "host", value: OLD_HOST }]);
    expect(rules[0].permanent).toBe(false);
    expect(rules[0].destination).toBe(`https://${NEW_HOST}${source === "/" ? "" : source}`);
  });

  it("the installed phone app is never redirected", () => {
    expect(hostRules.length).toBeGreaterThan(0);
    for (const rule of hostRules) {
      const m = rule.missing!.find((x) => x.type === "header")!;
      expect(m.key).toBe("user-agent");
      expect(m.value).toContain(SHELL_UA_PRODUCT);
      const re = new RegExp(`^${m.value}$`);
      expect(re.test(`Mozilla/5.0 (Linux; Android 14) ${shellUserAgentToken("1.2.3")}`)).toBe(true);
      expect(re.test("Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36")).toBe(false);
    }
  });

  it("no sign-in or reset path is redirected to the new host", () => {
    expect(hostRules.length).toBeGreaterThan(0);
    for (const rule of hostRules) {
      expect(AUTH_PATHS).not.toContain(rule.source);
      expect(AUTH_PATHS).not.toContain(pathOf(rule.destination));
    }
    expect(cfg.split.some((r) => AUTH_PATHS.includes(r.source) && r.has)).toBe(false);
  });

  it("every rule that leaves for the new host lands on a final public page", () => {
    expect(hostRules.length).toBeGreaterThanOrEqual(PUBLIC_PATHS.length);
    for (const rule of hostRules) {
      expect(PUBLIC_PATHS).toContain(pathOf(rule.destination));
      expect(
        cfg.split.find((r) => r.source === pathOf(rule.destination) && !r.has),
      ).toBeUndefined();
    }
  });

  it("legacy aliases resolve in one hop: a host-matched rule to the final page comes first", () => {
    const aliases = cfg.split.filter(
      (r) =>
        !r.has &&
        !r.destination.startsWith("https://") &&
        PUBLIC_PATHS.includes(pathOf(r.destination)),
    );
    expect(aliases.length).toBeGreaterThan(0);
    for (const alias of aliases) {
      const first = cfg.split.findIndex((r) => r.source === alias.source);
      const rule = cfg.split[first];
      expect(rule.has).toEqual([{ type: "host", value: OLD_HOST }]);
      expect(rule.destination).toBe(
        `https://${NEW_HOST}${alias.destination === "/" ? "" : alias.destination}`,
      );
      expect(rule.permanent).toBe(false);
      expect(cfg.split.indexOf(alias)).toBeGreaterThan(first);
    }
  });
});

describe("one hop: every old-host address that ends on a public page", () => {
  const SOURCES = [...PUBLIC_PATHS, ...LEGACY_SOURCES, ...RAW_PATHS];

  it.each(SOURCES)("%s reaches the new host in exactly one hop, query kept", (source) => {
    const { at, seen } = follow(cfg.split, OLD_HOSTNAME, `${source}?utm_source=x`, BROWSER);
    expect(seen).toHaveLength(1);
    expect(at.host).toBe(NEW_HOST);
    expect(PUBLIC_PATHS).toContain(at.pathname);
    expect(at.search).toBe("?utm_source=x");
  });

  it("the ten raw page addresses are all covered", () => {
    expect(RAW_PATHS).toHaveLength(10);
  });

  it("the same addresses on the new host take no hop to the other host", () => {
    for (const source of SOURCES) {
      const { at } = follow(cfg.split, NEW_HOST, source, BROWSER);
      expect(at.host).toBe(NEW_HOST);
    }
  });

  it("the phone shell stays on the old host for every public address", () => {
    const shell = `Mozilla/5.0 ${shellUserAgentToken("1.0.0")}`;
    for (const source of PUBLIC_PATHS) {
      expect(follow(cfg.split, OLD_HOSTNAME, source, shell).at.host).toBe(OLD_HOSTNAME);
    }
  });
});

describe("T38: a signed-in visitor is never redirected", () => {
  const PRESENCE = [OP_PRESENCE_COOKIE, BUYER_PRESENCE_COOKIE];

  it("every host rule has a missing entry for both presence cookies", () => {
    expect(hostRules.length).toBeGreaterThan(0);
    for (const rule of hostRules) {
      const cookies = (rule.missing ?? []).filter((m) => m.type === "cookie").map((m) => m.key);
      expect(cookies.sort()).toEqual([...PRESENCE].sort());
    }
  });

  it.each(PUBLIC_PATHS)("%s: operator or buyer cookie present means no redirect", (source) => {
    for (const cookies of [[OP_PRESENCE_COOKIE], [BUYER_PRESENCE_COOKIE], PRESENCE]) {
      const { at, seen } = follow(cfg.split, OLD_HOSTNAME, source, BROWSER, cookies);
      expect(seen).toEqual([]);
      expect(at.host).toBe(OLD_HOSTNAME);
    }
  });

  it.each(PUBLIC_PATHS)("%s: both cookies absent means the redirect fires", (source) => {
    const { at, seen } = follow(cfg.split, OLD_HOSTNAME, source, BROWSER, []);
    expect(seen).toHaveLength(1);
    expect(at.host).toBe(NEW_HOST);
  });

  it.each([[OP_PRESENCE_COOKIE], [BUYER_PRESENCE_COOKIE]])(
    "the old host's / with the %s cookie is not redirected",
    (cookie) => {
      const { at, seen } = follow(cfg.split, OLD_HOSTNAME, "/", BROWSER, [cookie]);
      expect(seen).toEqual([]);
      expect(at.host).toBe(OLD_HOSTNAME);
    },
  );

  it("a legacy alias and a raw page address are held back too", () => {
    for (const source of [...LEGACY_SOURCES, ...RAW_PATHS]) {
      const { at } = follow(cfg.split, OLD_HOSTNAME, source, BROWSER, [OP_PRESENCE_COOKIE]);
      expect(at.host).toBe(OLD_HOSTNAME);
    }
  });
});

describe("the host rules are exactly the public addresses", () => {
  it("redirects() takes its hosts from readSiteHosts()", () => {
    const source = fs.readFileSync(path.join(WEB_ROOT, "next.config.mjs"), "utf8");
    expect(source).toMatch(
      /async redirects\(\)\s*\{\s*return buildRedirects\(readSiteHosts\(\)\);\s*\}/,
    );
    expect(cfg.today).toEqual(cfg.todayFromHosts);
  });

  it("their sources are the public paths, the legacy aliases and the raw page files, nothing else", () => {
    expect(hostRules.map((r) => r.source).sort()).toEqual(
      [...PUBLIC_PATHS, ...LEGACY_SOURCES, ...RAW_PATHS].sort(),
    );
    for (const rule of hostRules) {
      expect(rule.source).not.toMatch(/^\/(dashboard|api)(\/|$)/);
      expect(AUTH_PATHS).not.toContain(rule.source);
    }
  });
});

describe("T33: the signed-out layouts set their own base address from site.origin", () => {
  const LAYOUTS = [
    "./layout",
    "../(auth)/login/layout",
    "../(auth)/signup/layout",
    "../(auth)/forgot-password/layout",
    "../(auth)/reset-password/layout",
    "../buyer/login/layout",
  ];

  it.each(LAYOUTS)("%s", (mod) => {
    const { metadata } = require(mod);
    expect(metadata.metadataBase.href).toBe(new URL(site.origin).href);
  });
});
