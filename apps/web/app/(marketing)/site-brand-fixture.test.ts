// T45: the brand seam with a different brand. loadBrand() is mocked with a fixture (another name,
// host, mailbox, logo and icon paths) and everything that names the brand is rendered again: the
// eight inner pages (through readServedSitePage), the site frame, the metadata helper, lib/site.ts,
// umami-tag and the share image. Every name, src, host and mailbox must come from the fixture and
// nothing of the real brand may be left. The share image's colours are the current brand's own and
// stay typed until wave 1 (BrandTokens), so no palette fixture is applied to it here; T35 holds that
// as a hex-only exemption row. Every page is now tokenised, home included (its hex stays until W3):
// the home page also draws the reversed symbol (hub template and static still) from symbolOnDark, and
// its structured data names officialName. A name/formerly swap fails the last block.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render } from "@testing-library/react";
import { loadBrand } from "@routeflow/types/brand/load";
import { footerLine, pageTitle, BRAND } from "@routeflow/types/brand";
import { readServedSitePage } from "@/lib/read-site-page";
import { STATIC_SITE_PAGE_NAMES, type StaticSitePage } from "@/lib/static-site-page";
import { SiteFrame } from "@/components/site-frame/SiteFrame";
import { SHARE_IMAGE, SHARE_IMAGE_LINES, marketingMetadata } from "./lib/metadata";
import { demoEmail, routes, site } from "./lib/site";
import { UMAMI_OWN_DOMAIN, umamiScriptProps } from "@/lib/umami-tag";
import { CURRENT_BRAND, isFileExempt } from "@/lib/test-support/site-brand-exemptions";
import { GET as ogGet } from "./opengraph-image/route";

jest.mock("@routeflow/types/brand/load", () => {
  const actual = jest.requireActual("@routeflow/types/brand/load");
  const fixture = actual.validateBrand({
    name: "FIXTURE.TEST",
    officialName: "FIXTURE-OFFICIAL",
    formerly: "Fixture Former Name",
    legalEntity: "Fixture Legal Holdings Ltd",
    origin: "https://www.fixture-host.example",
    oldOrigin: "https://old.fixture-host.example",
    email: "writeto@fixture-host.example",
    securityEmail: "safety@fixture-host.example",
    // adversarial on purpose: & ' and " in a text context (the title) must come out escaped
    titleSeparator: " &'\" ",
    // adversarial on purpose: & ' and " in an attribute context (og:image:alt)
    shareLine: 'Orders & delivery, "done" right, it\'s simple.',
    logo: {
      onLight: "/fx/logo-light.svg",
      onDark: "/fx/logo-dark.svg",
      small: "/fx/logo-small.svg",
    },
    symbol: "/fx/symbol.svg",
    symbolOnDark: "/fx/symbol-dark.svg",
    icon: {
      favicon: "/fx/tab-icon.png",
      apple: "/fx/apple.png",
      "192": "/fx/i192.png",
      "512": "/fx/i512.png",
    },
    emailLogo: "/fx/email.png",
    emailLogoWidth: 120,
    emailLogoHeight: 34,
  });
  const palette = actual.validatePalette({
    color: { ink: "#010203", white: "#fefdfc", bone: "#0a0b0c", "copper-light": "#1a2b3c" },
  });
  return { ...actual, loadBrand: () => fixture, loadPalette: () => palette };
});

let ogElement: unknown;
jest.mock("next/og", () => ({
  ImageResponse: class {
    constructor(element: unknown) {
      ogElement = element;
    }
  },
}));

const FIXTURE = loadBrand();
const FIXTURE_HOST = new URL(FIXTURE.origin).hostname;

// The pages tokenised so far: every page T35's shared exemption table does not exempt as a file.
// Nothing is hard-coded here.
const TOKENISED = STATIC_SITE_PAGE_NAMES.filter(
  (p) => !isFileExempt(`public/site/${p}.html`),
) as StaticSitePage[];

const REAL_BRAND = CURRENT_BRAND;
/** The planned name the fixture build must never show. The fixture itself is named FIXTURE.TEST (dotted,
 *  so the "name ends a sentence" double full stop is exercised), so only "rovio" is forbidden. */
const PLANNED_NAME = /rovio/i;
/** What the renderer is expected to do to a value placed in HTML (written out here on purpose). */
const esc = (v: string) =>
  v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Everything a visitor or crawler could read from the fixture build, for the global checks. */
const collected: string[] = [];

describe("the pages", () => {
  it("covers the ten tokenised pages (landing joined in wave 1b, home in wave 2) and nothing else is asserted", () => {
    expect(TOKENISED).toHaveLength(10);
    expect(TOKENISED).toContain("home");
    expect(TOKENISED).toContain("landing");
  });

  it.each(TOKENISED)("%s carries the fixture brand and none of the real one", (page) => {
    const html = readServedSitePage(page, { websiteId: undefined });
    collected.push(html);
    expect(html).not.toMatch(PLANNED_NAME);
    expect(html).not.toMatch(REAL_BRAND);
    expect(html).toContain(FIXTURE.name);
    // title: "Page :: Name"; landing is "Name :: Tagline" (its served title has always led with the name)
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
    if (page === "landing" || page === "home") {
      expect(title.startsWith(`${esc(FIXTURE.name)}${esc(FIXTURE.titleSeparator)}`)).toBe(true);
    } else {
      expect(title.endsWith(`${esc(FIXTURE.titleSeparator)}${esc(FIXTURE.name)}`)).toBe(true);
    }
    // the raw adversarial separator never reaches the markup
    expect(title).not.toContain(FIXTURE.titleSeparator);
    expect(html).toContain(`<link rel="canonical" href="${FIXTURE.origin}/`);
    expect(html).toContain(`<meta property="og:site_name" content="${FIXTURE.name}">`);
    expect(html).toContain(`<link rel="icon" href="${FIXTURE.icon.favicon}"`);
    expect(html).toContain(`src="${FIXTURE.logo.onLight}"`);
    expect(html).toContain(`mailto:${FIXTURE.email}`);
    expect(html).toContain(`© 2026 ${FIXTURE.name}`);
    // the share-image alt: "Name. Line", and on home "Name: Line" (a colon, so a dotted name never
    // doubles its full stop)
    const alt = page === "home" ? ": " : ". ";
    expect(html).toContain(`content="${esc(FIXTURE.name)}${alt}${esc(FIXTURE.shareLine)}"`);
    expect(html).not.toContain(FIXTURE.shareLine);
    // formerly is a different string from name; the only place it may appear is the alternateName
    // arrays of home's structured data. On home each ld+json is parsed, those arrays are checked and
    // removed, and the rest of the page (the remaining JSON included) must not hold it; every other
    // page is checked whole.
    let rest = html;
    if (page === "home") {
      rest = html.replace(/<script type="application\/ld\+json">([^<]*)<\/script>/g, (_m, raw) => {
        const ld = JSON.parse(raw) as { "@graph"?: Array<{ alternateName?: string[] }> };
        for (const node of ld["@graph"] ?? []) {
          expect(node.alternateName).toEqual([FIXTURE.name, FIXTURE.formerly]);
          delete node.alternateName;
        }
        return JSON.stringify(ld);
      });
    }
    // SA-1203 A1: the one footer line names the previous name; it is removed exactly, and the rest is checked
    const footer = esc(footerLine(undefined, FIXTURE));
    expect(rest.split(footer)).toHaveLength(2);
    expect(rest.replace(footer, "")).not.toContain(FIXTURE.formerly);
  });
});

describe("the home page: reversed symbol and official name", () => {
  const home = () => readServedSitePage("home", { websiteId: undefined });

  it("the hub template and the static still both draw symbolOnDark, never symbol", () => {
    const html = home();
    expect(FIXTURE.symbolOnDark).not.toBe(FIXTURE.symbol);
    const tpl = html.match(/<template id="brand-symbol"><img src="([^"]*)" alt=""><\/template>/);
    expect(tpl?.[1]).toBe(FIXTURE.symbolOnDark);
    const still = html.match(/<image href="([^"]*)"/g) ?? [];
    expect(still).toHaveLength(1);
    expect(still[0]).toBe(`<image href="${FIXTURE.symbolOnDark}"`);
    // the light-surface symbol is drawn on no dark surface (the hub disc, and the dark closing band
    // below), and no typed mark is left
    const hub = html.slice(
      html.indexOf('<template id="brand-symbol">'),
      html.indexOf('<h2 class="rfw-title">'),
    );
    expect(hub).toContain(FIXTURE.symbolOnDark);
    expect(hub).not.toContain(FIXTURE.symbol);
    // the closing band is dark too: its mark is the dark-surface symbol
    expect(html).toContain(`<img class="end-mark" src="${FIXTURE.symbolOnDark}"`);
    expect(html).not.toContain(`<img class="end-mark" src="${FIXTURE.symbol}"`);
    expect(html).not.toContain('class="mk"');
  });

  it("the structured data names officialName and legalName; the head and title keep the everyday name", () => {
    const html = home();
    const raw = html.match(/<script type="application\/ld\+json">([^<]*)<\/script>/)?.[1] ?? "";
    const graph = JSON.parse(raw)["@graph"] as Array<Record<string, unknown>>;
    expect(graph).toHaveLength(2);
    for (const node of graph) expect(node.name).toBe(FIXTURE.officialName);
    expect(graph[0]).toMatchObject({ "@type": "Organization", legalName: FIXTURE.legalEntity });
    expect(FIXTURE.officialName).not.toBe(FIXTURE.name);
    expect(html).toContain(`<meta property="og:site_name" content="${FIXTURE.name}">`);
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
    expect(title.startsWith(esc(FIXTURE.name))).toBe(true);
    expect(title).not.toContain(FIXTURE.officialName);
  });

  it("a rendered official name sits in a white-space:nowrap element and never contains U+2011", () => {
    const html = home();
    expect(html).not.toContain("\u2011");
    const body = html
      .slice(html.indexOf("<body"))
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<span style="white-space:nowrap">[^<]*<\/span>/g, "");
    expect(body).not.toContain(FIXTURE.officialName);
  });
});

describe("the palette", () => {
  it("every page is served with the fixture palette and none of the real one", () => {
    for (const page of TOKENISED) {
      const html = readServedSitePage(page, { websiteId: undefined });
      expect(html).toContain(
        '<style id="brand-tokens">:root{--brand-ink:#010203;--brand-white:#fefdfc;--brand-bone:#0a0b0c;--brand-copper-light:#1a2b3c;}</style>',
      );
      expect(html).not.toMatch(/--brand-copper:|#0e1726/i);
    }
  });
});

describe("the site frame", () => {
  it("header and footer read the fixture", () => {
    const { container } = render(createElement(SiteFrame, null, "x"));
    const html = container.innerHTML;
    collected.push(html);
    expect(html).not.toMatch(PLANNED_NAME);
    expect(html).not.toMatch(REAL_BRAND);
    const imgs = Array.from(container.querySelectorAll("img")).map((i) => i.getAttribute("src"));
    expect(imgs).toEqual([FIXTURE.logo.onLight, FIXTURE.logo.onLight]);
    expect(container.querySelector("a.brand")?.getAttribute("aria-label")).toBe(
      `${FIXTURE.name} home`,
    );
    expect(container.querySelector("a.brand span")?.textContent).toBe(FIXTURE.name);
    expect(container.querySelector(".foot-mail a")?.getAttribute("href")).toBe(
      `mailto:${FIXTURE.email}`,
    );
    expect(container.querySelector(".foot-bottom span")?.textContent).toBe(footerLine());
  });
});

describe("metadata, site and the share image", () => {
  it("site.ts reads the fixture", () => {
    collected.push(
      JSON.stringify({
        site,
        routes,
        demo: demoEmail({ name: "a", email: "b", company: "c", notes: "" }),
      }),
    );
    expect(site).toEqual({ name: FIXTURE.name, origin: FIXTURE.origin, email: FIXTURE.email });
    const contact = routes.find((r) => r.slug === "contact");
    expect(contact?.description).toContain(FIXTURE.email);
    expect(demoEmail({ name: "a", email: "b", company: "c", notes: "" })).toContain(
      encodeURIComponent(`${FIXTURE.name} demo request`),
    );
  });

  it("metadata.ts reads the fixture", () => {
    const meta = marketingMetadata({ path: "/pricing", title: "Pricing", description: "d" });
    collected.push(JSON.stringify({ meta, SHARE_IMAGE, SHARE_IMAGE_LINES }));
    expect(SHARE_IMAGE_LINES).toEqual({ name: FIXTURE.name, line: FIXTURE.shareLine });
    expect(SHARE_IMAGE.alt).toBe(`${FIXTURE.name}. ${FIXTURE.shareLine}`);
    expect(meta.openGraph).toMatchObject({ siteName: FIXTURE.name });
  });

  it("umami reads the fixture host", () => {
    expect(UMAMI_OWN_DOMAIN).toBe(FIXTURE_HOST.replace(/^www\./, ""));
    const props = umamiScriptProps("id", "/pricing");
    collected.push(JSON.stringify(props));
    expect(props?.["data-domains"]).toBe(FIXTURE_HOST);
  });

  it("the share image draws the fixture's name and line", () => {
    ogGet();
    const text = renderToStaticMarkup(ogElement as never);
    collected.push(text);
    expect(text).toContain(FIXTURE.name);
    // React escapes text children itself: compare with the escaped form of the adversarial line
    const escapedLine = renderToStaticMarkup(createElement("span", null, FIXTURE.shareLine)).slice(
      "<span>".length,
      -"</span>".length,
    );
    expect(text).toContain(escapedLine);
    // colours from the fixture palette, none from the real one
    for (const hex of ["#010203", "#fefdfc", "#0a0b0c", "#1a2b3c"]) expect(text).toContain(hex);
    expect(text).not.toMatch(/#0e1726|#b5683a|#d69062/i);
    expect(text).not.toMatch(PLANNED_NAME);
    expect(text).not.toMatch(REAL_BRAND);
  });
});

describe("the reader", () => {
  it("name and formerly are not swapped", () => {
    expect(BRAND.name).toBe(FIXTURE.name);
    expect(BRAND.formerly).toBe(FIXTURE.formerly);
    expect(footerLine()).toContain(BRAND.name);
    expect(footerLine()).toContain(BRAND.formerly);
    expect(pageTitle("Pricing")).toBe(`Pricing${FIXTURE.titleSeparator}${FIXTURE.name}`);
  });

  it("no planned-name and no real-brand string anywhere in what was rendered", () => {
    expect(collected.length).toBeGreaterThan(8);
    for (const text of collected) {
      expect(text).not.toMatch(PLANNED_NAME);
      expect(text).not.toMatch(REAL_BRAND);
    }
  });
});
