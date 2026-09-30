import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ScrollShadow } from "@routeflow/ui/web";

/**
 * B919 (widened, #2794 UX review): a wide table at 390px was cut off after a few columns with no cue that it
 * scrolls. ScrollShadow is the shared horizontal scroll wrapper: it shows a right-edge fade while there is
 * more to the right, a left fade once scrolled, and neither when everything fits. jsdom has no layout, so the
 * test drives scrollWidth/clientWidth/scrollLeft directly.
 */
function setGeometry(
  el: HTMLElement,
  g: { scrollWidth: number; clientWidth: number; scrollLeft: number },
) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: g.scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: g.clientWidth });
  el.scrollLeft = g.scrollLeft;
}

const scroller = () => screen.getByTestId("scroller");
const hint = (side: "left" | "right") =>
  document.querySelector(`[data-scroll-hint="${side}"]`) as HTMLElement;

describe("ScrollShadow", () => {
  it("scrolls horizontally and forwards the scroller's own props", () => {
    render(
      <ScrollShadow
        scrollerProps={{ "data-testid": "scroller" } as React.HTMLAttributes<HTMLDivElement>}
      >
        <div style={{ width: 2000 }}>wide</div>
      </ScrollShadow>,
    );
    expect(scroller().className).toMatch(/\boverflow-x-auto\b/);
  });

  it("shows the right fade while more content is to the right, hides it when scrolled to the end", () => {
    render(
      <ScrollShadow
        scrollerProps={{ "data-testid": "scroller" } as React.HTMLAttributes<HTMLDivElement>}
      >
        <div>wide</div>
      </ScrollShadow>,
    );
    act(() => {
      setGeometry(scroller(), { scrollWidth: 900, clientWidth: 390, scrollLeft: 0 });
      fireEvent.scroll(scroller());
    });
    expect(hint("right")).toHaveAttribute("data-visible", "true");
    expect(hint("left")).toHaveAttribute("data-visible", "false");

    act(() => {
      setGeometry(scroller(), { scrollWidth: 900, clientWidth: 390, scrollLeft: 510 });
      fireEvent.scroll(scroller());
    });
    expect(hint("right")).toHaveAttribute("data-visible", "false");
    expect(hint("left")).toHaveAttribute("data-visible", "true");
  });

  it("shows no fade at all when the content fits", () => {
    render(
      <ScrollShadow
        scrollerProps={{ "data-testid": "scroller" } as React.HTMLAttributes<HTMLDivElement>}
      >
        <div>narrow</div>
      </ScrollShadow>,
    );
    act(() => {
      setGeometry(scroller(), { scrollWidth: 390, clientWidth: 390, scrollLeft: 0 });
      fireEvent.scroll(scroller());
    });
    expect(hint("right")).toHaveAttribute("data-visible", "false");
    expect(hint("left")).toHaveAttribute("data-visible", "false");
  });

  it("the fades are decorative: aria-hidden and never intercept clicks", () => {
    render(
      <ScrollShadow>
        <div>x</div>
      </ScrollShadow>,
    );
    for (const side of ["left", "right"] as const) {
      expect(hint(side)).toHaveAttribute("aria-hidden", "true");
      expect(hint(side).className).toMatch(/pointer-events-none/);
    }
  });

  it("the fades inherit the wrapper's rounded corners (B919: square fades bled past a rounded table)", () => {
    render(
      <ScrollShadow className="rounded-xl">
        <div>x</div>
      </ScrollShadow>,
    );
    for (const side of ["left", "right"] as const) {
      expect(hint(side).className).toMatch(/rounded-\[inherit\]/);
    }
  });

  it("the scroller is a labelled, keyboard-focusable region ONLY while it overflows", () => {
    render(
      <ScrollShadow
        scrollLabel="Recent orders"
        scrollerProps={{ "data-testid": "scroller" } as React.HTMLAttributes<HTMLDivElement>}
      >
        <div>wide</div>
      </ScrollShadow>,
    );
    // fits: no region semantics, not a tab stop
    act(() => {
      setGeometry(scroller(), { scrollWidth: 390, clientWidth: 390, scrollLeft: 0 });
      fireEvent.scroll(scroller());
    });
    expect(scroller()).not.toHaveAttribute("tabindex");
    expect(scroller()).not.toHaveAttribute("role");
    expect(scroller()).not.toHaveAttribute("aria-label");

    // overflows: focusable region with the caller's label
    act(() => {
      setGeometry(scroller(), { scrollWidth: 900, clientWidth: 390, scrollLeft: 0 });
      fireEvent.scroll(scroller());
    });
    expect(scroller()).toHaveAttribute("tabindex", "0");
    expect(scroller()).toHaveAttribute("role", "region");
    expect(scroller()).toHaveAttribute("aria-label", "Recent orders");
  });

  it("without a scrollLabel an overflowing scroller still gets a generic accessible name", () => {
    render(
      <ScrollShadow
        scrollerProps={{ "data-testid": "scroller" } as React.HTMLAttributes<HTMLDivElement>}
      >
        <div>wide</div>
      </ScrollShadow>,
    );
    act(() => {
      setGeometry(scroller(), { scrollWidth: 900, clientWidth: 390, scrollLeft: 0 });
      fireEvent.scroll(scroller());
    });
    expect(scroller()).toHaveAttribute("aria-label", "Scrollable content");
  });
});
