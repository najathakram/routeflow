import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Fold } from "@routeflow/ui/web";
import { mockReducedMotion } from "./matchMedia";

const ui = () => (
  <Fold summary="Options">
    <button type="button">Inner</button>
  </Fold>
);

describe("Fold", () => {
  beforeEach(() => mockReducedMotion(false));

  it("trigger is a button with aria-expanded + aria-controls pointing at the region", async () => {
    const { container } = render(ui());
    const t = screen.getByRole("button", { name: /options/i });
    expect(t).toHaveAttribute("aria-expanded", "false");
    const region = container.querySelector(`#${CSS.escape(t.getAttribute("aria-controls")!)}`);
    expect(region).not.toBeNull();
    await userEvent.click(t);
    expect(t).toHaveAttribute("aria-expanded", "true");
  });

  it("closed content is inert and not tabbable; open content is focusable", async () => {
    const { container } = render(ui());
    const region = container.querySelector("[data-state]")!;
    expect(region).toHaveAttribute("inert");
    // jsdom does not model `inert` in the tab order, so the attribute is the contract here.
    await userEvent.click(screen.getByRole("button", { name: /options/i }));
    expect(region).not.toHaveAttribute("inert");
    screen.getByText("Inner").focus();
    expect(screen.getByText("Inner")).toHaveFocus();
  });

  it("reduced motion: closed content is inert AND display:none (class hidden), open is neither", async () => {
    mockReducedMotion(true);
    const { container } = render(ui());
    const region = container.querySelector("[data-state]")!;
    expect(region).toHaveAttribute("inert");
    expect(region.className).toMatch(/(^|\s)hidden(\s|$)/);
    await userEvent.click(screen.getByRole("button", { name: /options/i }));
    expect(region).not.toHaveAttribute("inert");
    expect(region.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it("controlled mode reports changes and follows the prop", async () => {
    const onOpenChange = jest.fn();
    const { rerender } = render(
      <Fold open={false} onOpenChange={onOpenChange} summary="S">
        x
      </Fold>,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    rerender(
      <Fold open onOpenChange={onOpenChange} summary="S">
        x
      </Fold>,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  });

  it("motion allowed animates the 0fr↔1fr track; reduced motion is instant (no transition)", () => {
    mockReducedMotion(false);
    const a = render(ui());
    expect(a.container.querySelector("[data-state]")!.className).toMatch(/grid-rows-\[0fr\]/);
    expect(a.container.querySelector("[data-state]")!.className).toMatch(/transition/);
    a.unmount();
    mockReducedMotion(true);
    const b = render(ui());
    expect(b.container.querySelector("[data-state]")!.className).not.toMatch(/transition/);
    expect(b.container.querySelector("[data-state]")!.className).not.toMatch(/0fr/);
  });
});
