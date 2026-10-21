import * as React from "react";
import { render, screen } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";

/** B1182: a page with a sticky bar lifts the toasts clear of it through --toast-bottom-inset; unset keeps 1rem. */
const viewportOf = () =>
  screen.getByRole("region", { name: /notifications/i }).querySelector("ol") as HTMLElement;
const INSET_CLASS = "bottom-[max(1rem,var(--toast-bottom-inset,1rem))]";

describe("Toast viewport bottom inset (B1182)", () => {
  afterEach(() => document.documentElement.style.removeProperty("--toast-bottom-inset"));

  it("reads --toast-bottom-inset and falls back to 1rem when it is unset", () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>,
    );
    const viewport = viewportOf();
    expect(viewport.className).toContain(INSET_CLASS);
    expect(viewport.className).not.toMatch(/(^|\s)bottom-4(\s|$)/);
    expect(viewport.className).toContain("right-4");
    expect(viewport.className).toContain("z-[100]");
  });

  it("the variable resolves from the root element the register sets it on", () => {
    document.documentElement.style.setProperty("--toast-bottom-inset", "120px");
    render(
      <ToastProvider>
        <div />
      </ToastProvider>,
    );
    expect(
      getComputedStyle(document.documentElement).getPropertyValue("--toast-bottom-inset"),
    ).toBe("120px");
    expect(viewportOf().className).toContain(INSET_CLASS);
  });
});
