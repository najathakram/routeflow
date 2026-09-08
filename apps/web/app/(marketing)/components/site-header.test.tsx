import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { SiteHeader } from "./site-header";

jest.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

// R-MKT — both Radix surfaces (mobile sheet, sign-in menu) portal into
// document.body, outside the `.rf-marketing` div stamped by
// app/(marketing)/layout.tsx. marketing.css scopes its token table and every
// rule for those surfaces under that class, so the portalled subtree must
// re-stamp it or it renders unstyled. One `it` per oracle.
describe("SiteHeader portals stay inside the .rf-marketing scope", () => {
  it("renders the mobile sheet inside a .rf-marketing carrier (R-MKT T2)", async () => {
    const user = userEvent.setup();
    render(<SiteHeader />);

    await user.click(screen.getByRole("button", { name: /open menu/i }));

    const sheet = screen.getByRole("dialog");
    expect(sheet).toHaveClass("mobile-panel");
    expect(sheet.closest(".rf-marketing")).not.toBeNull();
  });

  it("offers Book a demo in the open sheet (ux-spec §3, R-MKT T2)", async () => {
    const user = userEvent.setup();
    render(<SiteHeader />);

    await user.click(screen.getByRole("button", { name: /open menu/i }));

    const sheet = screen.getByRole("dialog");
    const links = Array.from(sheet.querySelectorAll("a"));
    const demo = links.find((a) => /book a demo/i.test(a.textContent ?? ""));
    expect(demo).toBeTruthy();
    expect(demo).toHaveAttribute("href", "/contact");
    expect(links).toHaveLength(9);
  });

  it("renders the sign-in menu inside a .rf-marketing carrier (R-MKT T2)", async () => {
    const user = userEvent.setup();
    render(<SiteHeader />);

    await user.click(screen.getByRole("button", { name: /sign in/i }));

    const menu = await screen.findByRole("menu");
    expect(menu).toHaveClass("signin-menu");
    expect(menu.closest(".rf-marketing")).not.toBeNull();
  });
});
