/**
 * @jest-environment node
 */
// SA-1253 C5 (owner boxes 1 and 2, 2026-11-23):
//   T9  the pricing page heads with one line, keeps its plan cards and table, and its numbers are the ones checkout sells.
//   T10 the bridge line shows only once the site's name AND host differ from the app's (R-210 M3: while the
//       launch is held the app still carries the top-level name, so no page promises a rename).
// The names are typed on purpose: this pins the words the owner chose.
import * as fs from "fs";
import * as path from "path";
import { BRAND, SITE_BRAND, siteView, type Brand } from "@routeflow/types/brand";
import { readServedSitePage } from "@/lib/read-site-page";
import { routes } from "./lib/site";

const REPO = path.resolve(__dirname, "../../../..");
const page = (name: Parameters<typeof readServedSitePage>[0], brand = SITE_BRAND) =>
  readServedSitePage(name, { websiteId: undefined, brand });

const PRICE_LINE = "Plans from $99 a month.";
const YEAR_OFFER = /a year|annual|2 months free/i;
const BRIDGE = "RouteFlow is now Rovio. Your data and account stay the same.";
// The launch state: the site served from its own host (the held state shares the app's host).
const LAUNCHED = siteView({
  ...(BRAND as Brand),
  site: { ...(BRAND.site as NonNullable<Brand["site"]>), origin: "https://www.new.test" },
});

describe("T9: the pricing line", () => {
  // The line is true in checkout today (Starter $99): apps/api/src/billing/billing-math.ts. A year is not
  // sold: a new subscription is monthly only (billing.service.ts refuses an annual checkout).
  it("is pinned to the checkout's own numbers", () => {
    const math = fs.readFileSync(path.join(REPO, "apps/api/src/billing/billing-math.ts"), "utf8");
    expect(math).toContain("Starter $99/mo");
    const billing = fs.readFileSync(
      path.join(REPO, "apps/api/src/billing/billing.service.ts"),
      "utf8",
    );
    expect(billing).toContain("CHECKOUT_ANNUAL_NOT_SUPPORTED");
  });

  it("the pricing page says it once, as the heading", () => {
    const html = page("pricing");
    expect(html).toContain("Plans from $<span");
    expect(html).toMatch(/<h1[^>]*>Plans from \$<span[^>]*>99<\/span> a month\.<\/h1>/);
    expect(PRICE_LINE).toContain("$99");
  });

  it("offers no year: no yearly price or pay-for-a-year line in the page text or its meta", () => {
    const html = page("pricing");
    expect(html).not.toMatch(YEAR_OFFER);
    expect(html).not.toMatch(/<[/]h1><p class="lede">/);
  });

  // R-210 M2: a UI change never loses a feature. The four plan cards, the table and the Enterprise
  // contact path stay; only the pay-for-a-year offer is off (no yearly checkout).
  it("keeps the four plan cards, the table and the Enterprise contact path", () => {
    const html = page("pricing");
    for (const plan of ["Starter", "Growth", "Scale", "Enterprise"])
      expect(html).toContain(`<h2>${plan}</h2>`);
    expect(html.match(/class="pcard\b/g)).toHaveLength(4);
    expect(html).toContain('<table class="pl"');
    expect(html).toContain('data-track="enterprise_click"');
  });

  it("the search snippet names the same plans the page shows (SA-C note 1)", () => {
    const route = routes.find((r) => r.slug === "pricing")!;
    const meta = /<meta name="description" content="([^"]*)">/.exec(page("pricing"))?.[1] ?? "";
    for (const text of [meta, route.description])
      expect(text).toContain("plans from $99 a month. Starter, Growth, Scale, and Enterprise.");
  });

  it("still offers the free trial", () => {
    expect(page("pricing")).toContain('href="/signup"');
  });
});

describe("T10: the bridge line", () => {
  const home = () => page("home");

  it("is held while the site shares the app's host: the names differ, the bridge is absent", () => {
    expect(SITE_BRAND.name).not.toBe(BRAND.name);
    expect(new URL(SITE_BRAND.origin).host).toBe(new URL(BRAND.origin).host);
    expect(SITE_BRAND.bridgeLine).toBe("");
    expect(home()).not.toContain("is now");
    expect(home()).not.toContain("data-bridge");
  });

  it("shows on the home page once the names and the hosts differ", () => {
    expect(LAUNCHED.bridgeLine).toBe(BRIDGE);
    expect(page("home", LAUNCHED)).toContain(BRIDGE);
  });

  it("promises no sign-in carry-over (sessions are per host)", () => {
    expect(BRIDGE).not.toMatch(/sign-in/i);
  });

  it("shows once, on the home page only", () => {
    expect(page("home", LAUNCHED).split(BRIDGE)).toHaveLength(2);
    for (const name of ["pricing", "product", "company", "contact", "security"] as const) {
      expect(page(name, LAUNCHED)).not.toContain("is now");
    }
  });

  it("is gone, element and all, when the site's name equals the top-level name", () => {
    const same = siteView({
      ...(BRAND as Brand),
      site: { ...(BRAND.site as NonNullable<Brand["site"]>), name: BRAND.name },
    });
    const html = page("home", same);
    expect(html).not.toContain(BRIDGE);
    expect(html).not.toContain("data-bridge");
    expect(html).not.toContain('class="bridge"');
  });

  it("is gone when there is no overlay at all", () => {
    const html = page("home", siteView({ ...(BRAND as Brand), site: undefined }));
    expect(html).not.toContain("data-bridge");
  });

  it("is never on Terms or Privacy", () => {
    for (const f of ["terms", "privacy"]) {
      const src = fs.readFileSync(path.join(__dirname, f, "page.tsx"), "utf8");
      expect(src).not.toMatch(/bridge/i);
    }
  });
});

describe("home pricing on a phone", () => {
  // R-336: under 900px the plan cards were hidden and the table they were swapped for is gone, so a phone
  // saw no plan rows. The home page keeps its cards at every width.
  it("shows the four plan cards below 900px (no hidden cards, no table to fall back on)", () => {
    const html = page("home");
    expect(html.match(/class="pcard\b/g)).toHaveLength(4);
    expect(html).not.toContain('<table class="pl"');
    const css = fs.readFileSync(path.join(REPO, "apps/web/public/site/css/site.css"), "utf8");
    const phone = css.slice(css.indexOf("@media (max-width:899.98px){"));
    expect(phone).toMatch(/\.home #pricing \.pgrid--4\{display:grid[^}]*\}/);
    const home = fs.readFileSync(path.join(REPO, "apps/web/public/site/css/home.css"), "utf8");
    expect(home).not.toMatch(/#pricing[^{}]*\.pgrid--4[^{}]*\{[^}]*display:none/);
  });
});
