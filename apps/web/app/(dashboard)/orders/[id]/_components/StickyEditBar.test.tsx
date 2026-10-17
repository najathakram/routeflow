import * as React from "react";
import { readFileSync } from "fs";
import { join } from "path";
import { render, screen } from "@testing-library/react";
import { StickyEditBar } from "./StickyEditBar";

/**
 * O2 follow-up (Mac mini 390 proof): <main id="main-content"> carries pb-24 (room for the fixed
 * PwaInstallPrompt), and Chrome insets a sticky edge by the scroll container's padding, so
 * `bottom-0` floated the bar ~96px above the screen edge. The bar docks at -bottom-24 (cancels
 * that padding) and, while mounted, tells the install prompt to yield. jsdom has no sticky
 * layout, so these pin the class / attribute contract; the 390 Playwright proof proves pixels.
 */
describe("StickyEditBar dock + install-prompt yield", () => {
  it("is sticky at the real bottom edge (-bottom-24 cancels main's pb-24), not bottom-0", () => {
    render(<StickyEditBar>x</StickyEditBar>);
    const bar = screen.getByTestId("edit-save-bar");
    expect(bar).toHaveClass("sticky", "-bottom-24");
    expect(bar).not.toHaveClass("bottom-0");
  });

  it("marks <body data-edit-bar> while mounted and clears it on unmount", () => {
    const { unmount } = render(<StickyEditBar>x</StickyEditBar>);
    expect(document.body).toHaveAttribute("data-edit-bar");
    unmount();
    expect(document.body).not.toHaveAttribute("data-edit-bar");
  });

  it("two bars mounted: the marker stays until the last one unmounts", () => {
    const a = render(<StickyEditBar>a</StickyEditBar>);
    const b = render(<StickyEditBar>b</StickyEditBar>);
    a.unmount();
    expect(document.body).toHaveAttribute("data-edit-bar");
    b.unmount();
    expect(document.body).not.toHaveAttribute("data-edit-bar");
  });

  it("every PwaInstallPrompt banner is hidden while body[data-edit-bar] is set", () => {
    const src = readFileSync(join(process.cwd(), "components/PwaInstallPrompt.tsx"), "utf8");
    const banners = src.match(/className="fixed bottom-4[^"]*"/g) ?? [];
    expect(banners.length).toBeGreaterThanOrEqual(2);
    for (const b of banners) expect(b).toContain("[body[data-edit-bar]_&]:hidden");
  });
});
