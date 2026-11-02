/**
 * @jest-environment node
 */
// The home, pricing, product and landing pages are ready-made HTML under public/site, served at
// their own addresses by the rewrites in next.config.mjs. This pins what makes that safe: the
// rewrites point at real files, every file the pages name is there, every link goes to a route
// that exists, nothing loads from another host, the head carries what the old pages carried, and
// the Content-Security-Policy is the one the rest of the app runs under.
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";
import { buildContentSecurityPolicy } from "../../csp.mjs";
import { site } from "./lib/site";

const WEB_ROOT = path.resolve(__dirname, "../..");
const PUBLIC_ROOT = path.join(WEB_ROOT, "public");
const SITE_ROOT = path.join(PUBLIC_ROOT, "site");
const APP_ROOT = path.join(WEB_ROOT, "app");

// route -> file, and whether search engines may list it
const PAGES: Array<{ route: string; file: string; indexable: boolean }> = [
  { route: "/", file: "home.html", indexable: true },
  { route: "/pricing", file: "pricing.html", indexable: true },
  { route: "/product", file: "product.html", indexable: true },
  { route: "/landing", file: "landing.html", indexable: false },
];

function loadConfig<T>(call: "redirects" | "rewrites" | "headers"): T {
  const configUrl = pathToFileURL(path.join(WEB_ROOT, "next.config.mjs")).href;
  const script =
    `const m = await import(${JSON.stringify(configUrl)});` +
    `process.stdout.write(JSON.stringify(await m.default.${call}()));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: WEB_ROOT,
      encoding: "utf8",
      timeout: 15_000,
    }),
  ) as T;
}

const html = (file: string) => fs.readFileSync(path.join(SITE_ROOT, file), "utf8");

// Every URL path the app answers with a page or a route handler, from the app folder. A segment
// in [brackets] matches anything; (groups) are not part of the address.
function appRoutes(): RegExp[] {
  const found: string[] = [];
  const walk = (dir: string, segments: string[]) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        const group = /^\(.*\)$/.test(entry.name);
        walk(path.join(dir, entry.name), group ? segments : [...segments, entry.name]);
      } else if (/^(page|route)\.(tsx|ts)$/.test(entry.name)) {
        found.push("/" + segments.join("/"));
      }
    }
  };
  walk(APP_ROOT, []);
  return found.map((route) => {
    const body = route
      .split("/")
      .map((seg) => (/^\[.*\]$/.test(seg) ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("/");
    return new RegExp(`^${body}/?$`);
  });
}

describe("ready-made pages: served by rewrites", () => {
  const rewrites = loadConfig<{ beforeFiles: Array<{ source: string; destination: string }> }>(
    "rewrites",
  ).beforeFiles;

  it("R1: exactly these four addresses are rewritten, each to its file under public/site", () => {
    expect(rewrites.map((r) => [r.source, r.destination])).toEqual(
      PAGES.map((p) => [p.route, `/site/${p.file}`]),
    );
  });

  it.each(PAGES)("R2: $route's file exists and is a whole document", ({ file }) => {
    const text = html(file);
    expect(text.startsWith("<!doctype html>")).toBe(true);
    expect(text).toContain("</html>");
  });

  it("R3: none of the four is also a page built in Next (a second source of truth)", () => {
    for (const { route } of PAGES) {
      const dir = route === "/" ? "" : route.slice(1);
      for (const group of ["(marketing)", ""]) {
        expect(fs.existsSync(path.join(APP_ROOT, group, dir, "page.tsx"))).toBe(false);
      }
    }
  });

  it("R4: the files are named in a header that keeps them out of search when asked for directly", () => {
    const rules = loadConfig<Array<{ source: string; headers: Array<{ key: string }> }>>("headers");
    const rule = rules.find((r) => r.headers.some((h) => h.key === "X-Robots-Tag"));
    expect(rule?.source).toBe("/site/:page(home|pricing|product|landing).html");
  });
});

describe("ready-made pages: head", () => {
  it.each(PAGES)(
    "H1: $route has a title, description, canonical and share tags",
    ({ route, file }) => {
      const text = html(file);
      const pick = (re: RegExp) => re.exec(text)?.[1];
      expect(pick(/<title>([^<]+)<\/title>/)).toBeTruthy();
      expect(pick(/<meta name="description" content="([^"]+)"/)).toBeTruthy();
      expect(pick(/<link rel="canonical" href="([^"]+)"/)).toBe(`${site.origin}${route}`);
      expect(pick(/<meta property="og:url" content="([^"]+)"/)).toBe(`${site.origin}${route}`);
      expect(pick(/<meta property="og:title" content="([^"]+)"/)).toBe(
        pick(/<title>([^<]+)<\/title>/),
      );
      expect(pick(/<meta property="og:image" content="([^"]+)"/)).toBe(
        `${site.origin}/opengraph-image`,
      );
      expect(pick(/<meta name="twitter:card" content="([^"]+)"/)).toBe("summary_large_image");
      expect(pick(/<meta name="twitter:image" content="([^"]+)"/)).toBe(
        `${site.origin}/opengraph-image`,
      );
    },
  );

  it.each(PAGES)(
    "H2: $route is listed by search engines only when it should be",
    ({ file, indexable }) => {
      expect(/<meta name="robots" content="[^"]*noindex/.test(html(file))).toBe(!indexable);
    },
  );

  // The pricing page opens on an h2 ("Plans from ..."): the design has no h1 there. Kept as
  // designed, so it is left out here and a later fix needs no test change.
  it.each(PAGES.filter((p) => p.route !== "/pricing"))("H3: $route has one h1", ({ file }) => {
    expect(html(file).match(/<h1[\s>]/g) ?? []).toHaveLength(1);
  });

  it("H4: the home page carries the organization and the software, with no ratings", () => {
    const blocks = [
      ...html("home.html").matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
    ].map((m) => JSON.parse(m[1] ?? "null"));
    expect(blocks).toHaveLength(1);
    const nodes = (blocks[0] as { "@graph": Array<Record<string, unknown>> })["@graph"];
    expect(nodes.map((n) => n["@type"])).toEqual(["Organization", "SoftwareApplication"]);
    const text = JSON.stringify(blocks);
    for (const banned of ["aggregateRating", "ratingValue", "reviewCount", '"review"', "offers"]) {
      expect(text).not.toContain(banned);
    }
    expect(nodes[0]?.url).toBe(site.origin);
    expect(nodes[0]?.email).toBe(site.email);
  });

  it("H5: no page carries a note meant for the people who built it", () => {
    for (const { file } of PAGES) {
      expect(html(file)).not.toMatch(/<!--/);
    }
  });
});

describe("ready-made pages: files and links", () => {
  const routes = appRoutes();
  const rewritten = new Set(PAGES.map((p) => p.route));
  const redirects = loadConfig<Array<{ source: string }>>("redirects").map((r) => r.source);
  const routeExists = (p: string) =>
    rewritten.has(p) || redirects.includes(p) || routes.some((re) => re.test(p));

  // [page, value] for every href and src that is not an in-page anchor, a mailto or a data URI
  const refs = PAGES.flatMap(({ route, file }) =>
    [...html(file).matchAll(/\b(?:href|src)="([^"#][^"]*)"/g)]
      .map((m) => m[1] as string)
      .filter((v) => !/^(mailto:|data:)/.test(v))
      .map((v) => [route, v] as const),
  );

  it("L1: every file a page names under /site is there", () => {
    const missing = refs
      .filter(([, v]) => v.startsWith("/site/"))
      .filter(([, v]) => !fs.existsSync(path.join(PUBLIC_ROOT, v.split(/[?#]/)[0] as string)));
    expect(missing).toEqual([]);
  });

  it("L2: every other link goes to a route that exists (no 404, no stray preview file)", () => {
    const bad = refs
      .filter(([, v]) => v.startsWith("/") && !v.startsWith("/site/"))
      .map(([route, v]) => [route, v.split(/[?#]/)[0] as string] as const)
      .filter(([, p]) => !routeExists(p));
    expect(bad).toEqual([]);
  });

  it("L3: a link is a path on this site or the canonical address, never another host or a file name", () => {
    const bad = refs.filter(([, v]) => {
      if (v.startsWith("/")) return false;
      if (v.startsWith(site.origin)) return false;
      return true;
    });
    expect(bad).toEqual([]);
    expect(refs.filter(([, v]) => /\.html(?:[#?]|$)/.test(v) && !v.startsWith("/site/"))).toEqual(
      [],
    );
  });

  it("L4: sign-in and sign-up point at the real routes", () => {
    const home = refs.filter(([route]) => route === "/").map(([, v]) => v);
    for (const real of ["/signup", "/login", "/buyer/login"]) {
      expect(home).toContain(real);
      expect(routeExists(real)).toBe(true);
    }
    expect(refs.filter(([route]) => route === "/landing").map(([, v]) => v)).toContain("/signup");
  });

  it("L5: the legal pages the footer names are still there", () => {
    for (const real of ["/terms", "/privacy"]) {
      expect(routeExists(real)).toBe(true);
      expect(refs.filter(([, v]) => v === real).length).toBeGreaterThan(0);
    }
  });

  it("L6: the contact address reads right everywhere it appears", () => {
    for (const { file } of PAGES) {
      const text = html(file);
      const mails = [...text.matchAll(/mailto:([^"?]+)/g)].map((m) => m[1]);
      expect(mails.length).toBeGreaterThan(0);
      for (const mail of mails) expect(mail).toBe(site.email);
      for (const shown of text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []) {
        expect(shown).toBe(site.email);
      }
    }
  });

  it("L7: nothing under public/site loads from, or names, another host", () => {
    // w3.org and schema.org are XML and JSON-LD namespace names, not addresses anything fetches.
    // The vendored animation scripts are skipped: their licence comments name their own site.
    const allowed = new Set([site.origin.replace("https://", ""), "www.w3.org", "schema.org"]);
    const hosts: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "vendor") walk(full);
        } else if (/\.(html|css|js)$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf8");
          for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
            if (!allowed.has((m[1] as string).toLowerCase())) hosts.push(`${entry.name}: ${m[1]}`);
          }
        }
      }
    };
    walk(SITE_ROOT);
    expect(hosts).toEqual([]);
  });

  it("L8: the font is one subset woff2 file, and every stylesheet's font URL resolves", () => {
    const font = path.join(SITE_ROOT, "fonts", "Geist-Variable.woff2");
    expect(fs.statSync(font).size).toBeLessThan(40_000);
    expect(fs.readFileSync(font).subarray(0, 4).toString("latin1")).toBe("wOF2");
    const css = fs.readFileSync(path.join(SITE_ROOT, "css", "site.css"), "utf8");
    for (const m of css.matchAll(/url\(([^)]*fonts\/[^)]+)\)/g)) {
      const ref = (m[1] as string).replace(/["']/g, "");
      expect(fs.existsSync(path.resolve(SITE_ROOT, "css", ref))).toBe(true);
    }
    expect(html("landing.html")).toContain("url(/site/fonts/Geist-Variable.woff2)");
  });
});

describe("ready-made pages: the Content-Security-Policy they run under", () => {
  const csp = buildContentSecurityPolicy({ isDev: false, apiUrl: undefined });
  const directive = (name: string) =>
    csp
      .split("; ")
      .find((d) => d.startsWith(`${name} `))
      ?.split(" ")
      .slice(1) ?? [];

  it("C1: every script, stylesheet, font and image the pages load is the site's own, so no source is added", () => {
    for (const { file } of PAGES) {
      const text = html(file);
      for (const m of text.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
        expect(m[1]).toMatch(/^\/site\/js\/|^\/site\/graphics\//);
      }
      for (const m of text.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)) {
        expect(m[1]).toMatch(/^\/site\/(css|graphics)\//);
      }
    }
    expect(directive("script-src")).toContain("'self'");
    expect(directive("style-src")).toContain("'self'");
    expect(directive("font-src")).toContain("'self'");
  });

  it("C2: the inline start-up script and the landing page's inline style are allowed, and the policy keeps no eval", () => {
    expect(directive("script-src")).toContain("'unsafe-inline'");
    expect(directive("style-src")).toContain("'unsafe-inline'");
    expect(directive("script-src")).not.toContain("'unsafe-eval'");
    expect(directive("frame-ancestors")).toEqual(["'none'"]);
    expect(directive("object-src")).toEqual(["'none'"]);
  });
});

describe("ready-made pages: old marketing addresses", () => {
  const routes = appRoutes();
  const redirects = loadConfig<Array<{ source: string }>>("redirects").map((r) => r.source);
  const rewritten = new Set(PAGES.map((p) => p.route));
  const OLD_ADDRESSES = [
    "/",
    "/product",
    "/wholesalers",
    "/retailers",
    "/pricing",
    "/company",
    "/contact",
    "/privacy",
    "/terms",
    "/sign-in",
    "/book-a-demo",
    "/distributors",
    "/about",
    "/demo",
    "/features",
    "/faq",
    "/integrations",
    "/quickbooks",
  ];

  it.each(OLD_ADDRESSES)("O1: %s still answers (a page, a ready-made page or a redirect)", (p) => {
    expect(rewritten.has(p) || redirects.includes(p) || routes.some((re) => re.test(p))).toBe(true);
  });
});
