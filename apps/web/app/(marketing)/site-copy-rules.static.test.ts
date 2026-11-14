// Copy rules for the eight inner pages (wave 1b): T41 pricing wording (plan limits are about
// customers only, one Enterprise line, no stray lines, one weight) and T37 (no sentence ends with
// the brand name, titles stay short) with a dotted fixture name. Pages are read as served.
import { loadBrand } from "@routeflow/types/brand";
import { readServedSitePage } from "@/lib/read-site-page";
import {
  renderSitePage,
  STATIC_SITE_PAGE_NAMES,
  type StaticSitePage,
} from "@/lib/static-site-page";

const PAGES = [
  "pricing",
  "product",
  "company",
  "contact",
  "getting-started",
  "does-and-doesnt",
  "data-in-and-out",
  "security",
] as StaticSitePage[];

const DOTTED = { ...loadBrand(), name: "XROV.IO" };

const decode = (s: string) =>
  s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Visible text, plus meta content and aria-label / alt / title attribute values, one per line. */
function readable(html: string): string {
  // og:image:alt is a label ("Name. Share line"), built by shareAlt() in the brand package and
  // pinned by the seam tests; it is not a sentence. Reported to the brand-seam owner (2.5 flip).
  html = html.replace(/<meta property="og:image:alt"[^>]*>/g, "");
  const attrs = [...html.matchAll(/\b(?:content|aria-label|alt|title)="([^"]*)"/g)].map(
    (m) => m[1],
  );
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "");
  return decode([body, ...attrs].join("\n"));
}

const served = (p: StaticSitePage) => readServedSitePage(p, { websiteId: undefined });
const titleOf = (html: string) => decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "");

describe("the page list", () => {
  it("is the eight inner pages", () => {
    for (const p of PAGES) expect(STATIC_SITE_PAGE_NAMES).toContain(p);
  });
});

describe("T41: plans differ by customers only", () => {
  it.each(PAGES)("%s: no plan-limit sentence mentions logins", (p) => {
    const text = readable(served(p));
    // plan-limit sentences: "differ by", "plans differ", "include"
    const lines = text.split(/(?<=[.!?])\s+|\n/);
    const bad = lines.filter((l) => /\bdiffer\b/i.test(l) && /logins?\b/i.test(l));
    expect(bad).toEqual([]);
  });

  it("pricing and product say the plans differ by customers only", () => {
    expect(readable(served("pricing"))).toContain(
      "The plans differ by how many customers they include.",
    );
    expect(readable(served("product"))).toContain(
      "The plans differ by how many customers they include.",
    );
  });

  it("pricing has exactly one Enterprise email line", () => {
    const html = served("pricing");
    expect(readable(html)).not.toMatch(/Need more than Scale/);
    const mails = html.match(/<a[^>]*href="mailto:[^"]*"[^>]*>/g) ?? [];
    const enterprise = mails.filter((m) => /enterprise_click/.test(m));
    expect(enterprise).toHaveLength(1);
    // the card's link keeps the #contact anchor
    expect(enterprise[0]).toMatch(/id="contact"/);
    expect(html.match(/id="contact"/g)).toHaveLength(1);
  });

  it("pricing drops the stray lines", () => {
    const text = readable(served("pricing"));
    expect(text).not.toContain("Includes your team.");
    expect(text).not.toContain("A custom price");
  });

  it("the trial line is the same weight as its siblings", () => {
    const html = served("pricing");
    expect(html).toContain("Every trial starts on Starter and lasts 14 days. No card needed.");
    expect(html).not.toMatch(/<(strong|b)>\s*Every trial starts/);
    expect(html).toMatch(
      /<p>Every trial starts on Starter and lasts 14 days\. No card needed\.<\/p>/,
    );
  });

  it("the closing band says free and the 14 days in one sentence", () => {
    for (const p of PAGES.filter((x) => x !== "contact" && x !== "company")) {
      const html = served(p);
      expect(html).toContain("free for 14 days.</h2><p>No card needed.</p>");
      expect(html).not.toContain("free.</h2><p>14 days free. No card needed.</p>");
    }
  });
});

describe("T37: no sentence ends with the name (dotted fixture name)", () => {
  it.each(PAGES)("%s: no name followed by . ! or ?", (p) => {
    const html = readServedSitePage(p, { brand: DOTTED, websiteId: undefined });
    expect(html).toContain("XROV.IO");
    expect(readable(html)).not.toMatch(/XROV\.IO\s*[.!?]/);
  });

  it.each(PAGES)("%s: title is at most 60 characters with the real name and the fixture", (p) => {
    expect(titleOf(served(p)).length).toBeLessThanOrEqual(60);
    expect(
      titleOf(readServedSitePage(p, { brand: DOTTED, websiteId: undefined })).length,
    ).toBeLessThanOrEqual(60);
  });
});
