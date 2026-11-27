import { fireEvent, render } from "@testing-library/react";
import { BRAND, loadPalette, paletteCss } from "@routeflow/types/brand";
import { SiteFrame } from "./SiteFrame";
import { FOOTER_COLUMNS, MENU_LINKS, NAV_LINKS } from "./site-frame-nav";
import { readServedSitePage } from "@/lib/read-site-page";
import { BUYER_PRESENCE_COOKIE, OP_PRESENCE_COOKIE } from "@/lib/presence-cookies";

// The React pages that wear the site frame (Privacy, Terms, sign-in, sign-up, 404) must say the
// same thing as the ready-made pages about where things are: same header links, same phone menu,
// same footer columns. The ready-made page is the reference; this fails when either side moves.

const reference = readServedSitePage("contact", { websiteId: undefined });

const pairs = (html: string) =>
  [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(
    (m) => [m[1], m[2]] as [string, string],
  );
const section = (html: string, open: string, close: string) => {
  const start = html.indexOf(open);
  return html.slice(start, html.indexOf(close, start));
};

describe("SiteFrame matches the ready-made pages", () => {
  it("header links", () => {
    const ref = pairs(section(reference, '<ul class="nav-links">', "</ul>"));
    expect(NAV_LINKS.map((l) => [l.href, l.label])).toEqual(ref);
  });

  it("phone menu links, before Sign in and the trial button", () => {
    const ref = pairs(section(reference, 'id="mobile-menu"', "data-signin")).filter(
      ([href]) => href !== "/login",
    );
    expect(MENU_LINKS.map((l) => [l.href, l.label])).toEqual(ref);
  });

  it("footer columns", () => {
    const foot = section(reference, '<footer class="site-footer">', "foot-bottom");
    const columns = [...foot.matchAll(/<h2>([^<]*)<\/h2><ul>(.*?)<\/ul>/g)];
    const ref = columns
      .filter((m) => m[1] !== "Account")
      .map((m) => ({ title: m[1], links: pairs(m[2]) }));
    expect(
      FOOTER_COLUMNS.map((c) => ({ title: c.title, links: c.links.map((l) => [l.href, l.label]) })),
    ).toEqual(ref);
  });

  it("carries the same account links, email and legal links", () => {
    const { container } = render(<SiteFrame>x</SiteFrame>);
    const hrefs = Array.from(container.querySelectorAll("footer a")).map((a) =>
      a.getAttribute("href"),
    );
    for (const href of ["/signup", "/login", "/buyer/login", "/privacy", "/terms"]) {
      expect(hrefs).toContain(href);
      expect(reference).toContain(`href="${href}"`);
    }
    expect(hrefs).toContain(`mailto:${BRAND.email}`);
  });
});

describe("SiteFrame header", () => {
  afterEach(() => {
    document.cookie = `${OP_PRESENCE_COOKIE}=; max-age=0; path=/`;
    document.cookie = `${BUYER_PRESENCE_COOKIE}=; max-age=0; path=/`;
  });

  it("shows Sign in, going to /login, when nobody is signed in", () => {
    const { container } = render(<SiteFrame>x</SiteFrame>);
    const link = container.querySelector("a.nav-signin") as HTMLAnchorElement;
    expect(link.textContent).toBe("Sign in");
    expect(link.getAttribute("href")).toBe("/login");
  });

  it("shows Open dashboard when a presence cookie exists: operator, then buyer", () => {
    document.cookie = `${OP_PRESENCE_COOKIE}=1; path=/`;
    const op = render(<SiteFrame>x</SiteFrame>).container;
    expect(op.querySelector("a.nav-signin")?.textContent).toBe("Open dashboard");
    expect(op.querySelector("a.nav-signin")?.getAttribute("href")).toBe("/dashboard");
    document.cookie = `${OP_PRESENCE_COOKIE}=; max-age=0; path=/`;
    document.cookie = `${BUYER_PRESENCE_COOKIE}=1; path=/`;
    const buyer = render(<SiteFrame>x</SiteFrame>).container;
    expect(buyer.querySelectorAll("a.nav-signin")[0]?.getAttribute("href")).toBe("/buyer/portal");
  });

  it("opens the phone menu with the button", () => {
    const { container } = render(<SiteFrame>x</SiteFrame>);
    const button = container.querySelector("button.menu-btn") as HTMLButtonElement;
    const menu = container.querySelector("#mobile-menu") as HTMLElement;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(menu.className).toContain("open");
    expect(document.body.classList.contains("menu-open")).toBe(true);
  });
});

describe("SiteFrame carries the palette", () => {
  it("renders exactly one brand-tokens style, with the real palette, beside the stylesheet links", () => {
    const { container } = render(<SiteFrame>x</SiteFrame>);
    const styles = container.querySelectorAll("style#brand-tokens");
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toBe(paletteCss(loadPalette()));
    expect(container.querySelector('link[href="/site/graphics/rf-graphics.css"]')).not.toBeNull();
  });
});
