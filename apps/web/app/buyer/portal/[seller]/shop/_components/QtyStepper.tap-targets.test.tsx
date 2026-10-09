import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QtyStepper } from "./QtyStepper";

/**
 * E-MB1: the buyer cart stepper's remove / minus / plus were ~22-26px, under the 44px tap floor, and carried no accessible
 * name (a title only). Class-level checks (RTL); the rendered pixel sizes are proven by Playwright.
 */
const setup = (size?: "sm" | "md", qty = 2) =>
  render(<QtyStepper qty={qty} onUpdate={jest.fn()} onRemove={jest.fn()} size={size} />);

describe("QtyStepper tap targets and names", () => {
  it.each([undefined, "sm" as const])(
    "remove, minus and plus each have a 44px hit area (size %s)",
    (size) => {
      setup(size);
      for (const name of ["Remove from cart", "Decrease quantity", "Increase quantity"]) {
        const btn = screen.getByRole("button", { name });
        expect(btn.className).toMatch(/\bmin-h-11\b/);
        expect(btn.className).toMatch(/\bmin-w-11\b/);
      }
    },
  );

  it("the quantity field is labelled and 44px tall", () => {
    setup();
    const field = screen.getByRole("spinbutton", { name: "Quantity" });
    expect(field.className).toMatch(/\bh-11\b/);
  });

  it("minus stays disabled at 1", () => {
    setup(undefined, 1);
    expect(screen.getByRole("button", { name: "Decrease quantity" })).toBeDisabled();
  });
});
