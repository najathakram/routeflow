// Copy rules for the eight inner pages (wave 1b) and the home page (wave 2): T41 pricing wording
// (plan limits are about customers only, one Enterprise line, no stray lines, one weight) and T37
// (no sentence ends with the brand name, titles stay short) with a dotted fixture name, plus the
// SA-1080 rule (no login or seat numbers on any served page). Pages are read as served.
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

const DOTTED = { ...loadBrand(), name: "FIXTURE.TEST" };

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

  it("home: no plan-limit sentence mentions logins, and it says customers only", () => {
    const text = readable(served("home"));
    const lines = text.split(/(?<=[.!?])\s+|\n/);
    expect(lines.filter((l) => /\bdiffer\b/i.test(l) && /logins?\b/i.test(l))).toEqual([]);
    expect(text).toContain("The plans differ by how many customers they include.");
    expect(text).not.toMatch(/customers and logins/);
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

// SA-1080 A-1 (js/prices.js:5): plans differ by price and customers only; seats and logins are not
// counted, so no served page puts a number next to the words login or seat.
const LOGIN_NUMBER =
  /(?:\d[\d,]*|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|unlimited)\b)\s+(?:[a-z-]+\s+)?(?:logins?|seats?)\b|\b(?:logins?|seats?)\s*[:=(]?\s*\d/gi;
const loginNumbers = (text: string): string[] => text.match(LOGIN_NUMBER) ?? [];

describe("SA-1080: no number next to login or seat", () => {
  it("the rule flags a fixture sentence (it is not vacuous)", () => {
    expect(loginNumbers("Starter includes up to 5 logins.")).toHaveLength(1);
    expect(loginNumbers("Each plan has 3 staff seats and 2 driver logins.")).toHaveLength(2);
    expect(loginNumbers("Seats: 10")).toHaveLength(1);
    expect(loginNumbers("Add as many logins as you need.")).toEqual([]);
  });

  it.each(STATIC_SITE_PAGE_NAMES)("%s: no login or seat count", (p) => {
    expect(loginNumbers(readable(served(p)))).toEqual([]);
  });
});

describe("T37 home: no sentence ends with the name (dotted fixture name)", () => {
  const home = () => readServedSitePage("home", { brand: DOTTED, websiteId: undefined });

  it("the home page carries the fixture name and no sentence ends with it", () => {
    const html = home();
    expect(html).toContain("FIXTURE.TEST");
    const text = readable(html);
    expect(text).not.toMatch(/FIXTURE\.TEST\s*[.!?]/);
    // the three lines that used to end with the name, as decided (Set 1)
    expect(text).toContain("What is FIXTURE.TEST for?");
    expect(text).toContain("What FIXTURE.TEST helps you do.");
    expect(text).toContain("You do every step in FIXTURE.TEST, start to finish.");
    expect(text).not.toContain("What is FIXTURE.TEST?");
    expect(text).not.toContain("Every step is in FIXTURE.TEST.");
    expect(text).not.toContain("What you can do with FIXTURE.TEST.");
  });

  it("the title is at most 60 characters with the real name and the fixture", () => {
    expect(titleOf(served("home")).length).toBeLessThanOrEqual(60);
    expect(titleOf(home()).length).toBeLessThanOrEqual(60);
  });

  it("pricing asks the same question as home, with the same answer", () => {
    const q = "What is FIXTURE.TEST for?";
    const answer =
      "Software for businesses that sell to stores. Take orders, send invoices, and get paid.";
    for (const p of ["home", "pricing"] as StaticSitePage[]) {
      const html = readServedSitePage(p, { brand: DOTTED, websiteId: undefined });
      expect(html).toContain("<summary>" + q);
      expect(html).toContain(answer);
      expect(html).not.toContain("What does FIXTURE.TEST do?");
    }
  });
});

describe("T37: no sentence ends with the name (dotted fixture name)", () => {
  it.each(PAGES)("%s: no name followed by . ! or ?", (p) => {
    const html = readServedSitePage(p, { brand: DOTTED, websiteId: undefined });
    expect(html).toContain("FIXTURE.TEST");
    expect(readable(html)).not.toMatch(/FIXTURE\.TEST\s*[.!?]/);
  });

  it.each(PAGES)("%s: title is at most 60 characters with the real name and the fixture", (p) => {
    expect(titleOf(served(p)).length).toBeLessThanOrEqual(60);
    expect(
      titleOf(readServedSitePage(p, { brand: DOTTED, websiteId: undefined })).length,
    ).toBeLessThanOrEqual(60);
  });
});
