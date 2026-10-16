import * as React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProductJumpLinks } from "./ProductJumpLinks";

type IOCallback = (entries: Partial<IntersectionObserverEntry>[]) => void;
let ioCallback: IOCallback | null = null;
const observed: Element[] = [];

class FakeIO {
  constructor(cb: IOCallback) {
    ioCallback = cb;
  }
  observe(el: Element) {
    observed.push(el);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const originalIO = (window as { IntersectionObserver?: unknown }).IntersectionObserver;

function Page({ ids, h1 = true }: { ids: string[]; h1?: boolean }) {
  return (
    <div>
      <ProductJumpLinks />
      {h1 ? <h1>Cola</h1> : null}
      {ids.map((id) => (
        <section key={id}>
          <h2 id={id}>{id}</h2>
        </section>
      ))}
    </div>
  );
}

const nav = () => screen.queryByTestId("units-v2-jump");
const link = (id: string) => screen.queryByTestId(`units-v2-jump-${id}`);

beforeEach(() => {
  ioCallback = null;
  observed.length = 0;
  (window as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIO;
  Element.prototype.scrollIntoView = jest.fn();
});

afterAll(() => {
  (window as { IntersectionObserver?: unknown }).IntersectionObserver = originalIO;
});

describe("ProductJumpLinks (V19)", () => {
  it("renders nothing when the page has fewer than two of its sections", () => {
    render(<Page ids={[]} h1={false} />);
    expect(nav()).toBeNull();
    render(<Page ids={["h-units"]} h1={false} />);
    expect(nav()).toBeNull();
  });

  it("is a labelled nav with one link per section that exists, and none for missing ones", () => {
    render(<Page ids={["h-units", "h-sales"]} />);
    const n = nav()!;
    expect(n.tagName).toBe("NAV");
    expect(n).toHaveAttribute("aria-label", "On this page");
    expect(link("h-product")).toHaveTextContent("Product");
    expect(link("h-units")).toHaveTextContent("Units and prices");
    expect(link("h-sales")).toHaveTextContent("Sales");
    expect(link("h-exc")).toBeNull();
    expect(link("h-cust")).toBeNull();
    expect(link("h-units")).toHaveAttribute("href", "#h-units");
  });

  it("uses the page's h1 as the Product section and the grid title as Units and prices", () => {
    render(
      <div>
        <ProductJumpLinks />
        <h1>Cola</h1>
        <h2 id="units-v2-grid-title">Prices</h2>
      </div>,
    );
    expect(document.querySelector("h1")).toHaveAttribute("id", "h-product");
    expect(link("h-product")).toHaveAttribute("href", "#h-product");
    // The grid keeps its own id (it labels the grid); the link points at it.
    expect(link("h-units")).toHaveAttribute("href", "#units-v2-grid-title");
  });

  it("picks up a section that arrives after mount", async () => {
    render(<Page ids={["h-units"]} />);
    expect(link("h-cust")).toBeNull();
    await act(async () => {
      const h = document.createElement("h2");
      h.id = "h-cust";
      document.body.appendChild(h);
    });
    await waitFor(() => expect(link("h-cust")).toBeInTheDocument());
  });

  it("marks the link of the section in view with aria-current", () => {
    render(<Page ids={["h-units", "h-sales"]} />);
    expect(observed.length).toBeGreaterThanOrEqual(3);
    const units = document.getElementById("h-units")!;
    act(() => {
      ioCallback?.([{ target: units, isIntersecting: true, intersectionRatio: 1 }]);
    });
    expect(link("h-units")).toHaveAttribute("aria-current", "true");
    expect(link("h-sales")).not.toHaveAttribute("aria-current");
    expect(link("h-product")).not.toHaveAttribute("aria-current");
    const sales = document.getElementById("h-sales")!;
    act(() => {
      ioCallback?.([
        { target: units, isIntersecting: false, intersectionRatio: 0 },
        { target: sales, isIntersecting: true, intersectionRatio: 1 },
      ]);
    });
    expect(link("h-sales")).toHaveAttribute("aria-current", "true");
    expect(link("h-units")).not.toHaveAttribute("aria-current");
  });

  it("does not crash when IntersectionObserver is missing (jsdom)", () => {
    delete (window as { IntersectionObserver?: unknown }).IntersectionObserver;
    expect(() => render(<Page ids={["h-units"]} />)).not.toThrow();
    expect(link("h-units")).toBeInTheDocument();
  });

  it("scrolls to the section and moves focus to its heading on click", async () => {
    render(<Page ids={["h-units", "h-sales"]} />);
    await userEvent.click(link("h-sales")!);
    const target = document.getElementById("h-sales")!;
    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(target).toHaveAttribute("tabindex", "-1");
    expect(target).toHaveFocus();
  });

  it("gives every link a 44px touch target", () => {
    render(<Page ids={["h-units"]} />);
    expect(link("h-units")!.className).toContain("min-h-[44px]");
  });

  it("removes the focus outline on programmatically focused headings, in its own scoped style", () => {
    const { container } = render(<Page ids={["h-units"]} />);
    const css = container.querySelector("style")?.textContent ?? "";
    expect(css).toMatch(/\[tabindex="-1"\]:focus\s*\{\s*outline:\s*none/);
  });

  describe("edge fade", () => {
    const setScroll = (el: HTMLElement, v: { sw: number; cw: number; sl: number }) => {
      Object.defineProperty(el, "scrollWidth", { configurable: true, value: v.sw });
      Object.defineProperty(el, "clientWidth", { configurable: true, value: v.cw });
      Object.defineProperty(el, "scrollLeft", { configurable: true, value: v.sl });
    };

    it("fades while the strip can still scroll, and not once it reaches the end", () => {
      render(<Page ids={["h-units", "h-sales"]} />);
      const strip = screen.getByTestId("units-v2-jump-strip");
      setScroll(strip, { sw: 600, cw: 300, sl: 0 });
      act(() => {
        strip.dispatchEvent(new Event("scroll"));
      });
      expect(strip).toHaveAttribute("data-fade", "true");
      setScroll(strip, { sw: 600, cw: 300, sl: 300 });
      act(() => {
        strip.dispatchEvent(new Event("scroll"));
      });
      expect(strip).toHaveAttribute("data-fade", "false");
    });

    it("does not fade when everything fits", () => {
      render(<Page ids={["h-units"]} />);
      const strip = screen.getByTestId("units-v2-jump-strip");
      setScroll(strip, { sw: 300, cw: 300, sl: 0 });
      act(() => {
        strip.dispatchEvent(new Event("scroll"));
      });
      expect(strip).toHaveAttribute("data-fade", "false");
    });
  });
});
