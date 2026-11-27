import { render } from "@testing-library/react";
import { SiteFrameHeader } from "./SiteFrameHeader";

// Wave 3, header lane (P10 and the class the one observer owns). The sign-in, menu and link pins stay in
// site-frame.test.tsx; this file holds the new rows only.

let mockPath: string | null = "/login";
jest.mock("next/navigation", () => ({ usePathname: () => mockPath }));

const trialLinks = (root: ParentNode) =>
  Array.from(root.querySelectorAll('a[href="/signup"]')) as HTMLAnchorElement[];

describe("SiteFrameHeader: the trial button", () => {
  it("shows the trial pill in the header, and one in the phone menu, on a page that is not sign-up", () => {
    mockPath = "/login";
    const { container } = render(<SiteFrameHeader />);
    const header = container.querySelector("header") as HTMLElement;
    const menu = container.querySelector("#mobile-menu") as HTMLElement;
    expect(trialLinks(header)).toHaveLength(1);
    expect(trialLinks(menu)).toHaveLength(1);
  });

  it.each(["/signup", "/signup/check-email"])("shows no trial button anywhere on %s", (p) => {
    mockPath = p;
    const { container } = render(<SiteFrameHeader />);
    expect(trialLinks(container)).toEqual([]);
  });

  it("a path that only starts like sign-up (/signupX) keeps the trial buttons", () => {
    mockPath = "/signupX";
    const { container } = render(<SiteFrameHeader />);
    expect(trialLinks(container)).toHaveLength(2);
  });

  it("keeps Sign in in the header and the menu on /signup", () => {
    mockPath = "/signup";
    const { container } = render(<SiteFrameHeader />);
    const header = container.querySelector("header") as HTMLElement;
    const menu = container.querySelector("#mobile-menu") as HTMLElement;
    expect(header.querySelector("a.nav-signin")?.textContent).toBe("Sign in");
    expect(Array.from(menu.querySelectorAll("a")).map((a) => a.textContent)).toContain("Sign in");
  });

  it("does not hard-code the observer's class (site.js owns hero-btn-in)", () => {
    mockPath = "/login";
    const { container } = render(<SiteFrameHeader />);
    expect(container.querySelector("header")?.classList.contains("hero-btn-in")).toBe(false);
  });

  it("a page with no pathname (a test, a 404 outside the router) still shows the trial button", () => {
    mockPath = null;
    const { container } = render(<SiteFrameHeader />);
    expect(trialLinks(container).length).toBeGreaterThan(0);
  });
});
