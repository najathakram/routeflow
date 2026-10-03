import * as React from "react";
import { render } from "@testing-library/react";
import { StickyFooter } from "@routeflow/ui/web";

describe("StickyFooter", () => {
  it("sticks to the bottom with a safe-area inset", () => {
    const { container } = render(<StickyFooter>Total</StickyFooter>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toMatch(/\bsticky\b/);
    expect(el.className).toMatch(/\bbottom-0\b/);
    expect(el.className).toMatch(/env\(safe-area-inset-bottom\)/);
    expect(el).toHaveTextContent("Total");
  });

  it("is solid by default and frosted only where backdrop-filter is supported", () => {
    const { container } = render(<StickyFooter>x</StickyFooter>);
    const cls = (container.firstElementChild as HTMLElement).className;
    expect(cls).toMatch(/(^|\s)bg-white(\s|$)/);
    expect(cls).toMatch(/supports-\[backdrop-filter\]:backdrop-blur/);
  });

  it("frosted={false} drops the blur", () => {
    const { container } = render(<StickyFooter frosted={false}>x</StickyFooter>);
    expect((container.firstElementChild as HTMLElement).className).not.toMatch(/backdrop-blur/);
  });
});
