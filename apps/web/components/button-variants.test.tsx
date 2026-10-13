import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Button } from "@routeflow/ui/web";

/** VU-2: `danger-outline` is ADDITIVE — every existing variant keeps its exact classes. */
const cls = (variant?: string) => {
  const { unmount } = render(<Button variant={variant as never}>x</Button>);
  const c = screen.getByRole("button").className;
  unmount();
  return c;
};

describe("Button variants", () => {
  it("danger-outline is a light, outlined danger button", () => {
    const c = cls("danger-outline");
    for (const t of [
      "bg-paper",
      "text-danger",
      "border",
      "border-danger/40",
      "hover:bg-danger/5",
      "focus-visible:ring-danger",
    ]) {
      expect(c.split(" ")).toContain(t);
    }
    expect(c.split(" ")).not.toContain("bg-danger");
  });

  it.each([
    [undefined, "bg-accent-strong text-white hover:bg-accent-deep focus-visible:ring-accent"],
    ["primary", "bg-accent-strong text-white hover:bg-accent-deep focus-visible:ring-accent"],
    [
      "secondary",
      "bg-paper text-navy border border-line-strong shadow-card hover:bg-surface-raised focus-visible:ring-navy",
    ],
    ["ghost", "text-ink-500 hover:bg-sunken hover:text-navy focus-visible:ring-navy"],
    ["danger", "bg-danger text-white hover:bg-danger/90 focus-visible:ring-danger"],
    [
      "link",
      "text-accent-deep underline underline-offset-[3px] hover:no-underline focus-visible:ring-accent",
    ],
  ])("%s keeps its classes", (variant, expected) => {
    expect(cls(variant)).toContain(expected);
  });
});
