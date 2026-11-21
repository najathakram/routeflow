/**
 * @jest-environment node
 */
// W4 2.5a: the name switches. Every served page shows the everyday name, the structured data on the
// home page names `officialName`, and the mailboxes are untouched (they move on switch day). The test
// never types a name: it reads them from brand.json. The alternateName line sits in home.html, which
// lane 2.5b owns; its assertion joins this test there.
import * as fs from "fs";
import * as path from "path";
import { BRAND, footerLine } from "@routeflow/types/brand";
import { STATIC_SITE_PAGE_NAMES, type StaticSitePage } from "@/lib/static-site-page";
import { readServedSitePage } from "@/lib/read-site-page";
import { SITE_EMAIL } from "@/components/site-frame/site-frame-nav";
import { site } from "./lib/site";

const WEB = path.resolve(__dirname, "../..");
const pageHtml = (page: StaticSitePage): string =>
  readServedSitePage(page, { websiteId: undefined });

const escapeHtml = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** SA-1203 A1: the footer line occurs exactly once and equals footerLine(); it is removed, and the
 *  rest of the page is held to the old rule. */
function withoutFooterLine(html: string): string {
  const line = escapeHtml(footerLine());
  expect(html.split(line)).toHaveLength(2);
  return html.replace(line, "");
}

/** The visible text of a page: tags, scripts and styles removed. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

describe("the brand file", () => {
  it("holds an everyday name, a longer official name and the previous name", () => {
    expect(BRAND.name).not.toBe(BRAND.officialName);
    expect(BRAND.officialName).toContain(BRAND.name);
    expect(BRAND.formerly).not.toBe(BRAND.name);
    expect(BRAND.formerly).not.toBe(BRAND.officialName);
  });
});

describe("the served pages", () => {
  it("lists ten pages", () => {
    expect(STATIC_SITE_PAGE_NAMES).toHaveLength(10);
  });

  it.each([...STATIC_SITE_PAGE_NAMES])("%s shows the everyday name and no other", (page) => {
    const html = pageHtml(page);
    const text = visibleText(html);
    // SA-1203 A1: the one footer line may name the previous name; nothing else may
    const rest = visibleText(withoutFooterLine(html));
    expect(text).toContain(BRAND.name);
    expect(html).toContain(`<meta property="og:site_name" content="${BRAND.name}">`);
    expect(rest).not.toContain(BRAND.formerly);
    expect(text).not.toContain(BRAND.officialName);
  });

  it.each([...STATIC_SITE_PAGE_NAMES])("%s links only the brand mailboxes", (page) => {
    const addresses = [...pageHtml(page).matchAll(/mailto:([^"?\s>]+)/g)].map((m) => m[1]);
    expect(addresses.length).toBeGreaterThan(0);
    for (const address of addresses) expect([BRAND.email, BRAND.securityEmail]).toContain(address);
  });

  it.each([...STATIC_SITE_PAGE_NAMES])(
    "%s prints the copyright line footerLine() builds",
    (page) => {
      const lines = [...pageHtml(page).matchAll(/©[^<]*/g)].map((m) => m[0]);
      expect(lines).toEqual([footerLine()]);
      expect(lines[0]).toContain("formerly");
    },
  );

  it("the home page structured data names officialName", () => {
    const raw = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(pageHtml("home"));
    if (!raw) throw new Error("home: no structured data found");
    const graph = (JSON.parse(raw[1]) as { "@graph": Array<Record<string, unknown>> })["@graph"];
    const org = graph.find((n) => n["@type"] === "Organization");
    if (!org) throw new Error("home: no Organization node");
    expect(org.name).toBe(BRAND.officialName);
  });
});

describe("the frame and the libs", () => {
  it("SITE_EMAIL and site read the brand file", () => {
    expect(SITE_EMAIL).toBe(BRAND.email);
    expect(site.name).toBe(BRAND.name);
    expect(site.email).toBe(BRAND.email);
  });

  it("the frame file types no name", () => {
    const frame = fs.readFileSync(path.join(WEB, "components/site-frame/SiteFrame.tsx"), "utf8");
    expect(frame).toContain("footerLine");
    expect(frame).toContain("<span>{footerLine()}</span>");
    expect(frame).not.toContain(BRAND.name);
    expect(frame).not.toContain(BRAND.formerly);
  });
});

describe("footerLine", () => {
  it("names the previous name when it is set and differs from the name", () => {
    expect(footerLine()).toBe(`© 2026 ${BRAND.name}, formerly ${BRAND.formerly}`);
  });

  it("is the bare line when the previous name equals the name or is empty", () => {
    const bare = `© 2026 ${BRAND.name}`;
    expect(footerLine(2026, { ...BRAND, formerly: BRAND.name })).toBe(bare);
    expect(footerLine(2026, { ...BRAND, formerly: "" })).toBe(bare);
  });
});
