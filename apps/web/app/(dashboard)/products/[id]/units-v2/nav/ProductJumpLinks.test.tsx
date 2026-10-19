import * as React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProductJumpLinks } from "./ProductJumpLinks";
import { CustomerPriceView } from "../customer/CustomerPriceView";

// K10c (F27): the Customer view is reached through the jump strip, so its hooks are mocked here.
jest.mock("@/lib/api/useCustomerUnitPrices", () => ({
  useCustomerUnitPrices: () => ({ data: undefined, isLoading: false, isError: false }),
}));
jest.mock("@/lib/api/customers", () => ({ useCustomers: () => ({ data: { data: [] } }) }));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: {} }) }));

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
      {h1 ? <h1 id="h-product">Cola</h1> : null}
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

  it("adopts the grid title as Units and prices, keeping its own id", () => {
    render(
      <div>
        <ProductJumpLinks />
        <h1 id="h-product">Cola</h1>
        <h2 id="units-v2-grid-title">Prices</h2>
      </div>,
    );
    expect(link("h-product")).toHaveAttribute("href", "#h-product");
    // The grid keeps its own id (it labels the grid); the link points at it.
    expect(link("h-units")).toHaveAttribute("href", "#units-v2-grid-title");
  });

  it("Units and prices lands on the actions row above the grid title (K12 F02)", () => {
    render(
      <div>
        <ProductJumpLinks />
        <h1 id="h-product">Cola</h1>
        <div data-testid="actions-anchor" data-units-jump-anchor="">
          <button type="button">Change prices</button>
          <h2 id="units-v2-grid-title">Prices</h2>
        </div>
      </div>,
    );
    const anchor = screen.getByTestId("actions-anchor");
    expect(link("h-units")).toHaveAttribute("href", "#h-units");
    expect(anchor).toHaveAttribute("id", "h-units");
    expect(anchor).toHaveAttribute("data-jump-target");
    expect(document.getElementById("units-v2-grid-title")).not.toHaveAttribute("data-jump-target");
  });

  it("reserves the strip's height before the sections resolve (K12 FE2)", async () => {
    const { rerender } = render(
      <div>
        <ProductJumpLinks reserveSpace />
      </div>,
    );
    const ph = screen.getByTestId("units-v2-jump-placeholder");
    expect(ph).toHaveAttribute("aria-hidden", "true");
    expect(ph.className).toContain("min-h-[57px]");
    expect(nav()).toBeNull();
    rerender(
      <div>
        <ProductJumpLinks reserveSpace />
        <h1 id="h-product">Cola</h1>
        <h2 id="h-units">Units</h2>
      </div>,
    );
    await waitFor(() => expect(nav()).toBeInTheDocument());
    expect(screen.queryByTestId("units-v2-jump-placeholder")).toBeNull();
  });

  it("renders nothing without reserveSpace and no sections", () => {
    render(<ProductJumpLinks />);
    expect(screen.queryByTestId("units-v2-jump-placeholder")).toBeNull();
    expect(nav()).toBeNull();
  });

  it("Product targets the product h1 and never stamps the dashboard header h1 before it", () => {
    const { unmount } = render(
      <div>
        <header>
          <h1 data-testid="dash-h1">RouteFlow</h1>
        </header>
        <ProductJumpLinks />
        <h1 id="h-product" data-testid="product-h1">
          Cola
        </h1>
        <h2 id="h-units">Units</h2>
      </div>,
    );
    const header = screen.getByTestId("dash-h1");
    expect(header).not.toHaveAttribute("id");
    expect(header).not.toHaveAttribute("tabindex");
    expect(header).not.toHaveAttribute("data-jump-target");
    expect(link("h-product")).toHaveAttribute("href", "#h-product");
    expect(screen.getByTestId("product-h1")).toHaveAttribute("data-jump-target");
    unmount();
  });

  it("without a page h1 id there is no Product link (no h1 fallback)", () => {
    render(
      <div>
        <h1>RouteFlow</h1>
        <ProductJumpLinks />
        <h2 id="h-units">Units</h2>
      </div>,
    );
    expect(link("h-product")).toBeNull();
    expect(document.querySelector("h1")).not.toHaveAttribute("id");
    expect(nav()).toBeNull(); // only one section left
  });

  it("leaves nothing behind on any heading after unmount", () => {
    document.body.innerHTML = `<h1>RouteFlow</h1><h1 id="h-product">Cola</h1><h2 id="units-v2-grid-title">Prices</h2><h2 id="h-sales" tabindex="0">Sales</h2>`;
    const before = document.body.innerHTML;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { unmount } = render(<ProductJumpLinks />, { container: host });
    expect(link("h-product")).toBeInTheDocument();
    expect(document.getElementById("h-product")).toHaveAttribute("data-jump-target");
    unmount();
    host.remove();
    expect(document.body.innerHTML).toBe(before);
    expect(document.querySelectorAll("[data-jump-target]")).toHaveLength(0);
    document.body.innerHTML = "";
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
    document.getElementById("h-cust")?.remove(); // appended to body: RTL cleanup does not own it
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

describe("ProductJumpLinks: the Customer view entry (K10c, F27)", () => {
  // The REAL heading id: CustomerPriceView renders `id="h-cust"` itself (K10d), so the link finds it directly.
  const CUSTOMER_HEADING = "h-cust";

  function PageWithCustomer({ customer = true }: { customer?: boolean }) {
    return (
      <div>
        <ProductJumpLinks />
        <h1 id="h-product">Cola</h1>
        <h2 id="units-v2-grid-title">Prices</h2>
        <h2 id="h-exc">Customers and tiers</h2>
        {customer ? (
          <h2 id={CUSTOMER_HEADING} tabIndex={-1}>
            Customer view
          </h2>
        ) : null}
        <h2 id="h-sales">Sales</h2>
      </div>
    );
  }

  it("lists Customer view, pointing at the heading's own id", () => {
    render(<PageWithCustomer />);
    expect(link("h-cust")).toHaveTextContent("Customer view");
    expect(link("h-cust")).toHaveAttribute("href", `#${CUSTOMER_HEADING}`);
  });

  it("does not adopt a stray #units-v2-h-cust element: that fallback id is retired (the heading is h-cust)", () => {
    render(
      <div>
        <ProductJumpLinks />
        <h1 id="h-product">Cola</h1>
        <h2 id="units-v2-h-cust">Not the Customer view heading</h2>
      </div>,
    );
    expect(link("h-cust")).toBeNull();
    expect(document.getElementById("units-v2-h-cust")).not.toHaveAttribute("data-jump-target");
  });

  it("is absent when the Customer view heading is not rendered", () => {
    render(<PageWithCustomer customer={false} />);
    expect(link("h-cust")).toBeNull();
    expect(link("h-sales")).toBeInTheDocument();
  });

  it("clicking scrolls to the heading and focuses it", async () => {
    render(<PageWithCustomer />);
    await userEvent.click(link("h-cust")!);
    const heading = document.getElementById(CUSTOMER_HEADING)!;
    expect(heading.scrollIntoView).toHaveBeenCalled();
    expect(heading).toHaveFocus();
  });

  it("is keyboard reachable: Enter on the focused link focuses the heading", async () => {
    render(<PageWithCustomer />);
    link("h-cust")!.focus();
    await userEvent.keyboard("{Enter}");
    expect(document.getElementById(CUSTOMER_HEADING)).toHaveFocus();
  });

  it("orders the links the way the sections sit in the page", () => {
    render(<PageWithCustomer />);
    const order = Array.from(screen.getByTestId("units-v2-jump-strip").querySelectorAll("a")).map(
      (a) => a.getAttribute("data-testid"),
    );
    expect(order).toEqual([
      "units-v2-jump-h-product",
      "units-v2-jump-h-units",
      "units-v2-jump-h-exc",
      "units-v2-jump-h-cust",
      "units-v2-jump-h-sales",
    ]);
  });

  it("marks the Customer view link current while its heading is in view", () => {
    render(<PageWithCustomer />);
    const heading = document.getElementById(CUSTOMER_HEADING)!;
    act(() => {
      ioCallback?.([{ target: heading, isIntersecting: true, intersectionRatio: 1 }]);
    });
    expect(link("h-cust")).toHaveAttribute("aria-current", "true");
    expect(link("h-sales")).not.toHaveAttribute("aria-current");
  });

  it("finds the real CustomerPriceView heading, and adds the link when it mounts later", async () => {
    const { rerender } = render(
      <div>
        <ProductJumpLinks />
        <h1 id="h-product">Cola</h1>
        <h2 id="h-sales">Sales</h2>
      </div>,
    );
    expect(link("h-cust")).toBeNull();
    rerender(
      <div>
        <ProductJumpLinks />
        <h1 id="h-product">Cola</h1>
        <CustomerPriceView productId="p1" />
        <h2 id="h-sales">Sales</h2>
      </div>,
    );
    await waitFor(() => expect(link("h-cust")).toBeInTheDocument());
    await userEvent.click(link("h-cust")!);
    expect(screen.getByRole("heading", { name: "Customer view" })).toHaveFocus();
  });
});

describe("ProductJumpLinks: short labels and the edge (K11-02, F22, P07)", () => {
  function FullPage() {
    return (
      <div>
        <ProductJumpLinks />
        <h1 id="h-product">Cola</h1>
        <h2 id="units-v2-grid-title">Prices</h2>
        <h2 id="h-exc">Customers and tiers</h2>
        <h2 id="h-cust">Customer view</h2>
        <h2 id="h-sales">Sales</h2>
      </div>
    );
  }
  const FULL: Record<string, string> = {
    "h-product": "Product",
    "h-units": "Units and prices",
    "h-exc": "Customers and tiers",
    "h-cust": "Customer view",
    "h-sales": "Sales",
  };
  const SHORT: Record<string, string> = {
    "h-product": "Product",
    "h-units": "Prices",
    "h-exc": "Tiers",
    "h-cust": "Customer",
    "h-sales": "Sales",
  };

  it("every link keeps its full label as its accessible name, whatever the width", () => {
    render(<FullPage />);
    for (const [id, label] of Object.entries(FULL)) {
      expect(link(id)).toHaveAttribute("aria-label", label);
      expect(screen.getByRole("link", { name: label })).toBe(link(id));
    }
  });

  it("shows the short label below sm and the full label from sm up", () => {
    render(<FullPage />);
    for (const id of Object.keys(FULL)) {
      const a = link(id)!;
      if (FULL[id] === SHORT[id]) {
        // Same word at every width: one label, never hidden.
        expect(a.querySelector('[class~="sm:hidden"]')).toBeNull();
        expect(a).toHaveTextContent(new RegExp(`^${FULL[id]}$`));
      } else {
        expect(a.querySelector('[class~="sm:hidden"]')).toHaveTextContent(SHORT[id]);
        expect(a.querySelector('[class~="hidden"][class~="sm:inline"]')).toHaveTextContent(
          FULL[id],
        );
      }
    }
  });

  it("uses the five short labels the card names, in sentence case with no dashes", () => {
    render(<FullPage />);
    const shorts = Object.keys(FULL).map(
      (id) => (link(id)!.querySelector('[class~="sm:hidden"]') ?? link(id)!).textContent,
    );
    expect(shorts).toEqual(["Product", "Prices", "Tiers", "Customer", "Sales"]);
    for (const t of shorts) expect(t).not.toMatch(/[\u2013\u2014]/);
  });

  it("starts the edge fade at 75% so the cut reads as 'more'", () => {
    const { container } = render(<FullPage />);
    const css = container.querySelector("style")?.textContent ?? "";
    expect(css).toContain("#000 75%");
    expect(css).not.toContain("#000 85%");
  });
});
