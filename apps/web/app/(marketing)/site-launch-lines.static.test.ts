/**
 * @jest-environment node
 */
// SA-1253 C5 (owner boxes 1 and 2, 2026-11-23):
//   T9  the pricing page shows one line and no table; the two numbers in it are the ones checkout sells.
//   T10 the bridge line shows only while the site's name differs from the top-level name.
// The names are typed on purpose: this pins the words the owner chose.
import * as fs from "fs";
import * as path from "path";
import { BRAND, SITE_BRAND, siteView, type Brand } from "@routeflow/types/brand";
import { readServedSitePage } from "@/lib/read-site-page";

const REPO = path.resolve(__dirname, "../../../..");
const page = (name: Parameters<typeof readServedSitePage>[0], brand = SITE_BRAND) =>
  readServedSitePage(name, { websiteId: undefined, brand });

const PRICE_LINE = "Plans from $99 a month.";
const YEAR_OFFER = /a year|annual|2 months free/i;
const BRIDGE = "RouteFlow is now Rovio. Your sign-in, data and account stay the same.";

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

  it("shows no table and no plan ladder", () => {
    const html = page("pricing");
    expect(html).not.toMatch(/<table/i);
    expect(html).not.toContain("pcard");
    expect(html).not.toContain("pgrid");
    expect(html).not.toContain("pl-wrap");
    expect(html).not.toMatch(/\$249|\$499|2,490|4,990/);
    expect(html).not.toMatch(/\b(?:Growth|Scale|Enterprise)\b/);
  });

  it("still offers the free trial", () => {
    expect(page("pricing")).toContain('href="/signup"');
  });
});

describe("T10: the bridge line", () => {
  const home = () => page("home");

  it("shows on the home page while the names differ", () => {
    expect(SITE_BRAND.name).not.toBe(BRAND.name);
    expect(home()).toContain(BRIDGE);
  });

  it("shows once, on the home page only", () => {
    expect(home().split(BRIDGE)).toHaveLength(2);
    for (const name of ["pricing", "product", "company", "contact", "security"] as const) {
      expect(page(name)).not.toContain("is now");
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
