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
import { site } from "./lib/site";

const WEB_ROOT = path.resolve(__dirname, "../..");

interface Rule {
  source: string;
  destination: string;
  permanent: boolean;
  has?: Array<{ type: string; value: string }>;
  missing?: Array<{ type: string; key: string; value: string }>;
}

interface Loaded {
  SITE_PAGES: Record<string, string>;
  hosts: { origin: string; oldOrigin: string };
  today: Rule[];
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
const OLD_HOST = new URL(SPLIT.oldOrigin).host;
const pathOf = (destination: string) =>
  destination.replace(/^https:\/\/[^/]+/, "").replace(/#.*$/, "") || "/";
const hostRules = cfg.split.filter((r) => r.has?.some((h) => h.type === "host"));

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
      expect(rule.missing).toHaveLength(1);
      const [m] = rule.missing!;
      expect([m.type, m.key]).toEqual(["header", "user-agent"]);
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
        !r.source.startsWith("/site/") &&
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
