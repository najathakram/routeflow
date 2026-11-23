// SA-1253 T4 and T5: with the site overlay in place, everything that is not a site page still shows
// today's name, marks and host (the app, the front door, the 404, Terms and Privacy), and the ten
// site pages show the new ones. The names are typed on purpose: this pins which surface is which.
// loadBrand() is NOT mocked here; this reads the real brand.json.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Metadata } from "next";
import { frontDoorMetadata } from "@/lib/front-door-metadata";
import { BRAND_DOMAIN } from "@/lib/brand-domain";
import { STATIC_SITE_PAGE_NAMES } from "@/lib/static-site-page";
import { readServedSitePage } from "@/lib/read-site-page";
import NotFound from "./not-found";
import TermsPage from "./(marketing)/terms/page";
import PrivacyPage from "./(marketing)/privacy/page";

jest.mock("next/navigation", () => ({
  usePathname: () => "/x",
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

const TODAY = "RouteFlow";
const NEW = /rovio|xrov/i;

describe("T4: the app and the front door keep today's name, marks and host", () => {
  it("front-door metadata: name, share block, icons and metadataBase", () => {
    const md: Metadata = frontDoorMetadata();
    expect(md.metadataBase?.href).toBe("https://www.routeflow.info/");
    expect(md.title).toEqual({ default: TODAY, template: `%s · ${TODAY}` });
    expect(md.openGraph?.siteName).toBe(TODAY);
    expect(JSON.stringify(md)).not.toMatch(NEW);
    expect(JSON.stringify(md.icons)).toContain("/site/img/routeflow-mark-64.png");
    expect(JSON.stringify(md.icons)).toContain("/brand/routeflow-mark-180.png");
  });

  it("the app 404 says today's name; its frame is the site's", () => {
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(html).toContain(`Back to ${TODAY}`);
  });

  it("BRAND_DOMAIN is today's host", () => {
    expect(BRAND_DOMAIN).toBe("routeflow.info");
  });
});

describe("T5: Terms and Privacy keep today's name and domain; the site pages wear the new ones", () => {
  it.each([
    ["Terms", TermsPage],
    ["Privacy", PrivacyPage],
  ] as const)("%s body names today's brand only", (_name, Page) => {
    const html = renderToStaticMarkup(createElement(Page));
    expect(html).toContain(TODAY);
    expect(html).toContain("routeflow.info");
    expect(html).not.toMatch(NEW);
  });

  it.each([...STATIC_SITE_PAGE_NAMES])("%s shows the new name and the new marks", (page) => {
    const html = readServedSitePage(page, { websiteId: undefined });
    expect(html).toContain("Rovio");
    expect(html).toMatch(/\/site\/img\/brand\/(?:favicon-32\.png|symbol\.svg)/);
    expect(html).not.toContain("routeflow-mark");
  });
});
