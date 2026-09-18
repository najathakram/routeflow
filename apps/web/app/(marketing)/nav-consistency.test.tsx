import * as React from "react";
import { render } from "@testing-library/react";
import { SiteFooter } from "./components/site-footer";
import MarketingLayout from "./layout";
import { NAV_SLUGS } from "./lib/site";

jest.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

// jsdom has no matchMedia implementation. EditorialMotion (rendered by
// MarketingLayout) calls window.matchMedia on mount, so the layout-render
// test below needs a stub — only site-header.test.tsx renders SiteHeader in
// isolation and doesn't hit this.
beforeAll(() => {
  window.matchMedia =
    window.matchMedia ||
    ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
});

// A7 — marketing nav consistency: the footer's "Platform" section hand-types
// its labels/hrefs instead of sourcing them from routes[] (the L-072
// anti-pattern the header's own comment warns against). This deliberately
// does NOT pin the footer's copy — "Product overview"/"For distributors"/
// "For retailers" read as intentional, friendlier footer-style wording vs.
// the header's terser labels — only that the hrefs stay a same-order subset
// of NAV_SLUGS, so a slug rename/removal in routes[] fails loudly here
// instead of leaving a silent dead link in the footer.
describe("SiteFooter Platform section hrefs track NAV_SLUGS (A7)", () => {
  it("is a same-order subset of NAV_SLUGS", () => {
    const { container } = render(<SiteFooter />);
    const platformHeading = Array.from(container.querySelectorAll("h2")).find(
      (h) => h.textContent === "Platform",
    );
    expect(platformHeading).toBeTruthy();

    const hrefs = Array.from(platformHeading!.parentElement!.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs.length).toBeGreaterThan(0);

    const navHrefs = NAV_SLUGS.map((slug) => `/${slug}`);
    let cursor = -1;
    for (const href of hrefs) {
      const idx = navHrefs.indexOf(href as string);
      expect(idx).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });
});

// A7/B538 — SiteHeader's `.desktop-nav` renders as a sibling of
// `<main>{children}</main>` in this shared layout, never nested inside a
// page's own `.glass-page` wrapper (every marketing page.tsx applies
// `.glass-page` to its own root, inside `{children}`). glass-site.css's
// `.glass-page .desktop-nav [aria-current="page"]` rule was dead for that
// reason and was removed (B538) — this pins the structural fact so a future
// nested layout, or a page moving its wrapper, can't silently change which
// CSS is reachable without a test noticing.
describe("SiteHeader's .desktop-nav is never inside a page's .glass-page wrapper (A7/B538)", () => {
  it("keeps the header nav outside .glass-page", () => {
    const { container } = render(
      <MarketingLayout>
        <div className="glass-page">page content</div>
      </MarketingLayout>,
    );
    const glassPage = container.querySelector(".glass-page");
    const desktopNav = container.querySelector(".desktop-nav");
    expect(glassPage).toBeTruthy();
    expect(desktopNav).toBeTruthy();
    expect(glassPage!.contains(desktopNav)).toBe(false);
  });
});
