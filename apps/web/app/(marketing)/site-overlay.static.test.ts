/**
 * @jest-environment node
 */
// SA-1178 A6 R1, SA-1253 C3: the inverted seam. The top level of brand.json keeps today's name, marks
// and host for every reader; a `site` block holds the new ones, and an allowlist decides who reads it.
//   T1: every importer of the site view is on the list below; any other file is red.
//   T2: the overlay differs from the top level. When phase A lifts it, `site.name === name` and this
//       test goes red, so the overlay and its pins are deleted instead of left as a dead alias.
// The names are typed here on purpose: this is the one test that pins which name is which.
import * as fs from "fs";
import * as path from "path";
import { BRAND, SITE_BRAND, loadSiteBrand } from "@routeflow/types/brand";

const REPO = path.resolve(__dirname, "../../../..");
const raw = JSON.parse(
  fs.readFileSync(path.join(REPO, "packages/types/brand/brand.json"), "utf8"),
) as Record<string, unknown> & { site?: Record<string, unknown> };

/** The only non-test files that may name the site view (A6 R1). A new site reader is one line here. */
const ALLOWLIST = [
  "apps/web/app/(marketing)/lib/metadata.ts",
  "apps/web/app/(marketing)/lib/site.ts",
  "apps/web/app/(marketing)/opengraph-image/route.tsx",
  "apps/web/components/site-frame/SiteFrame.tsx",
  "apps/web/components/site-frame/SiteFrameHeader.tsx",
  "apps/web/components/site-frame/site-frame-nav.ts",
  "apps/web/lib/read-site-page.ts",
  "apps/web/next.config.mjs",
  "packages/types/brand/index.ts",
  "packages/types/brand/load.ts",
  "scripts/lib/site-port-jsonld.cjs",
].sort();

const SKIP_DIRS = new Set(["node_modules", ".next", ".turbo", "dist", ".git", ".jest-cache"]);
const SOURCE = /\.(?:ts|tsx|mjs|cjs|js)$/;
const TEST = /\.(?:test|spec)\.[a-z]+$|[\\/](?:e2e|__tests__|test-support)[\\/]/;
/** The site view's names, and a direct read of the overlay block. */
const SITE_READER =
  /\bSITE_BRAND\b|\bloadSiteBrand\b|\bsiteFooterLine\b|\bsiteShareAlt\b|\.site\b\??\.origin/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (file: string) => path.relative(REPO, file).split(path.sep).join("/");

describe("T1: the site view has exactly the allowlisted readers", () => {
  it("lists every importer of the site view and goes red on any other", () => {
    const roots = ["apps/web", "apps/api/src", "apps/mobile", "packages", "scripts"].map((r) =>
      path.join(REPO, r),
    );
    const found = roots
      .filter((r) => fs.existsSync(r))
      .flatMap((r) => walk(r))
      .map(rel)
      .filter((f) => !TEST.test(f))
      .filter((f) => SITE_READER.test(fs.readFileSync(path.join(REPO, f), "utf8")))
      .sort();
    expect(found).toEqual(ALLOWLIST);
  });

  it("the contracts never read it: Terms, Privacy, the root layout, front-door metadata, BRAND_DOMAIN", () => {
    const WEB = "apps/web/";
    const never = [
      "app/(marketing)/terms/page.tsx",
      "app/(marketing)/privacy/page.tsx",
      "app/layout.tsx",
      "app/not-found.tsx",
      "app/(auth)/choose-role/page.tsx",
      "lib/front-door-metadata.ts",
      "lib/brand-domain.ts",
    ];
    for (const file of never) {
      const text = fs.readFileSync(path.join(REPO, WEB, file), "utf8");
      expect({ file, reads: SITE_READER.test(text) }).toEqual({ file, reads: false });
      // nor through the site table, whose name is the overlay's
      expect({
        file,
        viaSite: /from "\.\.\/lib\/site"/.test(text) && /\bsite\.(?:name|origin)\b/.test(text),
      }).toEqual({
        file,
        viaSite: false,
      });
    }
  });
});

describe("T2: the overlay differs from the top level (phase A deletes it)", () => {
  it("the top level keeps today's name, marks and host", () => {
    expect(raw.name).toBe("RouteFlow");
    expect(raw.officialName).toBe("RouteFlow");
    expect(raw.origin).toBe("https://www.routeflow.info");
    expect(raw.oldOrigin).toBe("https://www.routeflow.info");
    expect(raw.logo).toEqual({
      onLight: "/site/img/routeflow-mark-64.png",
      onDark: "/site/img/routeflow-mark-64.png",
      small: "/site/img/routeflow-mark-64.png",
    });
    expect(raw.icon).toEqual({
      favicon: "/site/img/routeflow-mark-64.png",
      apple: "/brand/routeflow-mark-180.png",
      "192": "/brand/routeflow-mark-192.png",
      "512": "/brand/routeflow-mark-512.png",
    });
    expect(BRAND.name).toBe("RouteFlow");
  });

  it("the site block holds the new name, marks and the main host", () => {
    expect(raw.site).toEqual({
      name: "Rovio",
      officialName: "X-Rovio",
      origin: "https://www.xrov.io",
      logo: {
        onLight: "/site/img/brand/symbol.svg",
        onDark: "/site/img/brand/symbol-reversed.svg",
        small: "/site/img/brand/symbol.svg",
      },
      symbol: "/site/img/brand/symbol.svg",
      symbolOnDark: "/site/img/brand/symbol-reversed.svg",
      icon: {
        favicon: "/site/img/brand/favicon-32.png",
        apple: "/site/img/brand/apple-touch-icon.png",
        "192": "/site/img/brand/icon-192.png",
        "512": "/site/img/brand/icon-512.png",
      },
    });
  });

  it("SITE_BRAND is the top level with the site block laid over it", () => {
    expect(SITE_BRAND.name).toBe("Rovio");
    expect(SITE_BRAND.officialName).toBe("X-Rovio");
    expect(SITE_BRAND.origin).toBe("https://www.xrov.io");
    expect(SITE_BRAND.symbolOnDark).toBe("/site/img/brand/symbol-reversed.svg");
    // not overlaid: the mailboxes, the legal entity, the old host and the former name
    expect(SITE_BRAND.email).toBe(BRAND.email);
    expect(SITE_BRAND.securityEmail).toBe(BRAND.securityEmail);
    expect(SITE_BRAND.legalEntity).toBe(BRAND.legalEntity);
    expect(SITE_BRAND.oldOrigin).toBe(BRAND.oldOrigin);
    expect(SITE_BRAND.formerly).toBe("RouteFlow");
    expect(loadSiteBrand()).toBe(SITE_BRAND);
  });

  it("the overlay must differ from the top level: when site.name === name it is a dead alias", () => {
    expect(SITE_BRAND.name).not.toBe(BRAND.name);
    expect(SITE_BRAND.origin).not.toBe(BRAND.origin);
  });
});
