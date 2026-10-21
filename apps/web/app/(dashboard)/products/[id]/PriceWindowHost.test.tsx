import * as React from "react";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { PriceWindowHost, ProductPricingRegion, usePriceWindowOpener } from "./PriceWindowHost";
import { usePriceDraftOptional, type PriceDraft } from "./units-v2/edit/usePriceDraft";
import { GRID, PRODUCT } from "./units-v2/window/k11-20a.fixtures";

/**
 * K11-20c: the page-level host. One draft for the page, one window, and the one place a served-grid revision change
 * refreshes the product and the units list (R1: a v2 save writes only the price-grid cache). Plus the inline edit
 * mode's full-width grid (K11-10 ruling), which only the draft's `editingIn` may switch on.
 */
let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => mockGrid,
  fetchPriceGrid: () => Promise.resolve(mockGrid.data),
}));
jest.mock("@/lib/api/usePriceWrites", () => ({
  ...jest.requireActual("@/lib/api/usePriceWrites"),
  useSavePrices: () => ({ mutate: jest.fn(), reset: jest.fn(), isPending: false, error: null }),
  useUndoPrices: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: {} }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  ...jest.requireActual("@/lib/api/useProductCustomerPrices"),
  useProductCustomerPrices: () => ({ data: { customers: [] }, isFetching: false }),
}));

let draft: PriceDraft | null = null;
let opener: ReturnType<typeof usePriceWindowOpener> = null;
const Probe = () => {
  draft = usePriceDraftOptional();
  opener = usePriceWindowOpener();
  return null;
};

let qc: QueryClient;
const mount = (enabled = true, children?: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <PriceWindowHost product={PRODUCT} enabled={enabled}>
        <Probe />
        {children}
      </PriceWindowHost>
    </QueryClientProvider>,
  );
const withRevision = (revision: number): typeof mockGrid => ({
  data: { ...GRID, revision },
  isLoading: false,
  isError: false,
});

beforeEach(() => {
  qc = new QueryClient();
  mockGrid = withRevision(7);
  draft = null;
  opener = null;
});

describe("K11-20c host: one draft and one opener for the page", () => {
  it("enabled: the page has a draft and an opener", () => {
    mount();
    expect(draft).not.toBeNull();
    expect(opener).not.toBeNull();
  });

  it("disabled (flag off, a family, a governed product): no draft, no opener, children untouched", () => {
    mount(false, <p>child</p>);
    expect(draft).toBeNull();
    expect(opener).toBeNull();
    expect(screen.getByText("child")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the window is mounted once, closed, until something opens it", () => {
    mount();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opening it from a figure shows one dialog named Edit prices", async () => {
    mount();
    const origin = document.createElement("button");
    document.body.appendChild(origin);
    act(() => opener!.open({ origin, anchor: origin, focus: { ref: "case", tier: 2 } }));
    expect(await screen.findByRole("dialog", { name: "Edit prices" })).toBeInTheDocument();
    expect(draft!.editingIn).toBe("window");
    origin.remove();
  });

  it("N7: with the inline grid editing, a click goes to the matching inline box; the window never opens", () => {
    mount(true, <input data-testid="units-v2-input-case-2" aria-label="inline case t2" />);
    act(() => {
      draft!.startEditing(undefined, "inline");
    });
    const origin = document.createElement("button");
    document.body.appendChild(origin);
    act(() => opener!.open({ origin, anchor: origin, focus: { ref: "case", tier: 2 } }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("inline case t2")).toHaveFocus();
    expect(draft!.editingIn).toBe("inline");
    expect(screen.getByTestId("price-window-note")).toBeEmptyDOMElement();
    origin.remove();
  });

  it("N7: with no matching inline box it says where the edits are, and still does not open", () => {
    mount();
    act(() => {
      draft!.startEditing(undefined, "inline");
    });
    const origin = document.createElement("button");
    document.body.appendChild(origin);
    act(() => opener!.open({ origin, anchor: origin }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("price-window-note")).toHaveTextContent(/edited in the grid/i);
    expect(draft!.editingIn).toBe("inline");
    origin.remove();
  });
});

describe("K11-20c host: a served-grid revision change refreshes the product and the units list (R1)", () => {
  it("does nothing for the first revision it sees", () => {
    const spy = jest.spyOn(qc, "invalidateQueries");
    mount();
    expect(spy).not.toHaveBeenCalled();
  });

  it("invalidates the product query (exact) and the units list when the revision changes", () => {
    const spy = jest.spyOn(qc, "invalidateQueries");
    const view = mount();
    mockGrid = withRevision(8);
    view.rerender(
      <QueryClientProvider client={qc}>
        <PriceWindowHost product={PRODUCT} enabled>
          <Probe />
        </PriceWindowHost>
      </QueryClientProvider>,
    );
    const keys = spy.mock.calls.map(([f]) => JSON.stringify((f as { queryKey: unknown }).queryKey));
    expect(keys).toContain(JSON.stringify(["products", "p1"]));
    expect(keys).toContain(JSON.stringify(["products", "p1", "units"]));
    const productCall = spy.mock.calls.find(
      ([f]) => JSON.stringify((f as { queryKey: unknown }).queryKey) === '["products","p1"]',
    );
    expect((productCall![0] as { exact?: boolean }).exact).toBe(true);
  });

  it("does not invalidate again for the same revision", () => {
    const spy = jest.spyOn(qc, "invalidateQueries");
    const view = mount();
    const rerender = () =>
      view.rerender(
        <QueryClientProvider client={qc}>
          <PriceWindowHost product={PRODUCT} enabled>
            <Probe />
          </PriceWindowHost>
        </QueryClientProvider>,
      );
    mockGrid = withRevision(8);
    rerender();
    const after = spy.mock.calls.length;
    rerender();
    expect(spy.mock.calls.length).toBe(after);
  });
});

describe("K11-20c host: nits", () => {
  it("navigating to another product does not invalidate (the revision it sees is a new product's first)", () => {
    const spy = jest.spyOn(qc, "invalidateQueries");
    const view = mount();
    mockGrid = withRevision(12);
    view.rerender(
      <QueryClientProvider client={qc}>
        <PriceWindowHost product={{ ...PRODUCT, id: "p2" }} enabled>
          <Probe />
        </PriceWindowHost>
      </QueryClientProvider>,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("the N7 note lives in a live region that is always mounted, never takes the pointer, and sits above the Save bar", () => {
    mount();
    const live = screen.getByTestId("price-window-note");
    expect(live).toHaveAttribute("role", "status");
    expect(live).toBeEmptyDOMElement();
    act(() => {
      draft!.startEditing(undefined, "inline");
    });
    const origin = document.createElement("button");
    document.body.appendChild(origin);
    act(() => opener!.open({ origin, anchor: origin }));
    expect(screen.getByTestId("price-window-note")).toHaveTextContent(/edited in the grid/i);
    expect(live.className).toMatch(/pointer-events-none/);
    expect(live.className).toMatch(/bottom-2[0-9]|bottom-3[0-9]/);
    origin.remove();
  });

  it("from the header's Edit prices (no price named) while editing inline, focus goes to the first inline box", () => {
    mount(
      true,
      <>
        <input data-testid="units-v2-input-case-1" aria-label="first inline" />
        <input data-testid="units-v2-input-box-1" aria-label="second inline" />
      </>,
    );
    act(() => {
      draft!.startEditing(undefined, "inline");
    });
    const origin = document.createElement("button");
    document.body.appendChild(origin);
    act(() => opener!.open({ origin, anchor: origin }));
    expect(screen.getByLabelText("first inline")).toHaveFocus();
    expect(screen.getByTestId("price-window-note")).toBeEmptyDOMElement();
    expect(screen.queryByRole("dialog")).toBeNull();
    origin.remove();
  });
});

describe("K11-20c region: the prices grid is full width only while the inline editor edits (K11-10 ruling)", () => {
  const region = () => screen.getByTestId("units-v2-region");

  it("is the normal column width when nobody is editing", () => {
    mount(true, <ProductPricingRegion>x</ProductPricingRegion>);
    expect(region().className).not.toMatch(/-ml-/);
    expect(region()).not.toHaveAttribute("data-wide");
  });

  it("takes the full width at lg and up while editingIn is inline", () => {
    mount(true, <ProductPricingRegion>x</ProductPricingRegion>);
    act(() => {
      draft!.startEditing(undefined, "inline");
    });
    expect(region()).toHaveAttribute("data-wide", "true");
    expect(region().className).toMatch(/lg:-ml-\[calc\(50%\+0\.75rem\)\]/);
    expect(region().className).toMatch(/lg:w-\[calc\(150%\+0\.75rem\)\]/);
  });

  it("insets the unit controls 17 px (card border 1 + p-4) while wide, so Add a unit lines up with the grid card's text", () => {
    mount(
      true,
      <ProductPricingRegion>
        <div data-wide-inset="" data-testid="inset-probe" />
      </ProductPricingRegion>,
    );
    expect(region().className).not.toMatch(/data-wide-inset/);
    act(() => {
      draft!.startEditing(undefined, "inline");
    });
    expect(region().className).toContain("lg:[&_[data-wide-inset]]:px-[17px]");
    expect(region().querySelector("[data-wide-inset]")).toBe(screen.getByTestId("inset-probe"));
  });

  it("every width class is lg-only, so nothing changes below lg", () => {
    mount(true, <ProductPricingRegion>x</ProductPricingRegion>);
    act(() => {
      draft!.startEditing(undefined, "inline");
    });
    const widthish = region()
      .className.split(/\s+/)
      .filter((c) => /(^|:)(-?ml-|w-|transition|duration|ease)/.test(c));
    expect(widthish.length).toBeGreaterThan(0);
    for (const c of widthish) expect(c).toMatch(/^(motion-safe:)?lg:/);
  });

  it("stays normal while the WINDOW edits (it floats over the card, the page does not move)", () => {
    mount(true, <ProductPricingRegion>x</ProductPricingRegion>);
    act(() => {
      draft!.startEditing(undefined, "window");
    });
    expect(region()).not.toHaveAttribute("data-wide");
  });

  it("goes back to normal when the edit ends", () => {
    mount(true, <ProductPricingRegion>x</ProductPricingRegion>);
    act(() => {
      draft!.startEditing(undefined, "inline");
    });
    act(() => draft!.discard());
    expect(region()).not.toHaveAttribute("data-wide");
  });

  it("animates the width change in 200 ms ease-out, and not at all under prefers-reduced-motion", () => {
    mount(true, <ProductPricingRegion>x</ProductPricingRegion>);
    const cls = region().className;
    // The transition exists ONLY under motion-safe: under prefers-reduced-motion no transition rule applies at all, so
    // no stylesheet ordering of lg: against motion-reduce: can let an animation win.
    expect(cls).toContain("motion-safe:lg:transition-[margin,width]");
    expect(cls).toContain("motion-safe:lg:duration-200");
    expect(cls).toContain("motion-safe:lg:ease-out");
    expect(cls).not.toMatch(/motion-reduce/);
    expect(cls.split(/\s+/).filter((c) => /transition|duration|ease/.test(c))).toEqual([
      "motion-safe:lg:transition-[margin,width]",
      "motion-safe:lg:duration-200",
      "motion-safe:lg:ease-out",
    ]);
  });

  it("the width change never remounts the grid: a focused element inside keeps focus", () => {
    mount(
      true,
      <ProductPricingRegion>
        <input aria-label="probe" />
      </ProductPricingRegion>,
    );
    const input = screen.getByLabelText("probe");
    input.focus();
    const wrapper = region();
    act(() => {
      draft!.startEditing(undefined, "inline");
    });
    expect(screen.getByLabelText("probe")).toBe(input);
    expect(region()).toBe(wrapper);
    expect(input).toHaveFocus();
    act(() => draft!.discard());
    expect(screen.getByLabelText("probe")).toBe(input);
    expect(input).toHaveFocus();
  });

  it("while wide it is an opaque raised surface, so nothing under it shows through", () => {
    mount(true, <ProductPricingRegion>x</ProductPricingRegion>);
    expect(region().className).not.toMatch(/bg-white|shadow-card/);
    act(() => {
      draft!.startEditing(undefined, "inline");
    });
    expect(region().className).toMatch(/lg:bg-white/);
    expect(region().className).toMatch(/lg:shadow-card/);
  });

  describe("the column it covers is inert only while wide, at lg and up", () => {
    const original = window.matchMedia;
    const stubLg = (matches: boolean) => {
      window.matchMedia = ((query: string) => ({
        matches,
        media: query,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
        onchange: null,
      })) as unknown as typeof window.matchMedia;
    };
    afterEach(() => {
      window.matchMedia = original;
    });
    const withColumn = () =>
      mount(
        true,
        <>
          <div data-region-covers data-testid="covered">
            <button type="button">hidden under the grid</button>
          </div>
          <ProductPricingRegion>x</ProductPricingRegion>
        </>,
      );

    it("is inert while the inline editor edits at lg and up, and not before or after", () => {
      stubLg(true);
      withColumn();
      expect(screen.getByTestId("covered")).not.toHaveAttribute("inert");
      act(() => {
        draft!.startEditing(undefined, "inline");
      });
      expect(screen.getByTestId("covered")).toHaveAttribute("inert");
      act(() => draft!.discard());
      expect(screen.getByTestId("covered")).not.toHaveAttribute("inert");
    });

    it("is not inert below lg even while editing inline", () => {
      stubLg(false);
      withColumn();
      act(() => {
        draft!.startEditing(undefined, "inline");
      });
      expect(screen.getByTestId("covered")).not.toHaveAttribute("inert");
    });

    it("is not inert while the window edits", () => {
      stubLg(true);
      withColumn();
      act(() => {
        draft!.startEditing(undefined, "window");
      });
      expect(screen.getByTestId("covered")).not.toHaveAttribute("inert");
    });

    it("is released when the region unmounts mid-edit", () => {
      stubLg(true);
      const view = withColumn();
      act(() => {
        draft!.startEditing(undefined, "inline");
      });
      expect(screen.getByTestId("covered")).toHaveAttribute("inert");
      view.unmount();
      expect(document.querySelector("[data-region-covers]")).toBeNull();
    });
  });

  it("without a page-level draft it is just the normal column", () => {
    render(
      <QueryClientProvider client={qc}>
        <ProductPricingRegion>x</ProductPricingRegion>
      </QueryClientProvider>,
    );
    expect(region()).not.toHaveAttribute("data-wide");
  });
});

/**
 * R3 (lead ruling a): the floating window has no opener on the v2 product page, so the e2e geometry (old T2) and
 * reduced-motion (old T7) tests were retired with it. These are their jsdom equivalents, until the owner's
 * two-price-editors decision: the window is placed from the card's rect inside the viewport, shows all five tiers,
 * and under prefers-reduced-motion carries no scale/slide classes.
 */
describe("R3 floating window: geometry and motion (jsdom equivalents of old e2e T2 and T7)", () => {
  const original = window.matchMedia;
  const stubMedia = (reduce: boolean) => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? reduce : query.includes("min-width"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  };
  afterEach(() => {
    window.matchMedia = original;
    jest.restoreAllMocks();
  });

  const rect = (r: Partial<DOMRect>) => ({ x: 0, y: 0, width: 0, height: 0, ...r }) as DOMRect;
  const openWindow = () => {
    const card = document.createElement("section");
    card.textContent = "card";
    const origin = document.createElement("button");
    origin.textContent = "origin";
    document.body.append(card, origin);
    jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === card) return rect({ left: 300, right: 1000, top: 100, bottom: 500 });
      if (this === origin)
        return rect({ left: 900, right: 980, top: 120, bottom: 150, width: 80, height: 30 });
      return rect({});
    });
    jest.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    jest.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(400);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    mount();
    act(() => opener!.open({ origin, anchor: card, focus: { ref: "case", tier: 2 } }));
    return { card, origin };
  };

  it("T2: hung off the card (right edges meet), inside the viewport margins, capped to the viewport", async () => {
    stubMedia(false);
    const { card, origin } = openWindow();
    const dialog = await screen.findByRole("dialog", { name: "Edit prices" });
    const left = parseInt(dialog.style.left, 10);
    const top = parseInt(dialog.style.top, 10);
    expect(left + 800).toBe(1000); // right-aligned to the card, as the e2e asserted within 1 px
    expect(left).toBeGreaterThanOrEqual(16);
    expect(left + 800).toBeLessThanOrEqual(1440 - 16);
    expect(top).toBe(158); // 8 px below what opened it
    expect(top + 400).toBeLessThanOrEqual(900 - 24);
    expect(dialog.className).toContain("w-[min(860px,calc(100vw-32px))]");
    expect(dialog.className).toContain("max-h-[min(40rem,calc(100dvh-48px))]");
    card.remove();
    origin.remove();
  });

  it("T2: all five tiers have a price box in the window's grid", async () => {
    stubMedia(false);
    const { card, origin } = openWindow();
    const dialog = await screen.findByRole("dialog", { name: "Edit prices" });
    act(() => {
      draft!.startEditing(undefined, "window");
    });
    for (const tier of [1, 2, 3, 4, 5]) {
      expect(
        dialog.querySelector(`[data-testid^="units-v2-input-"][data-testid$="-${tier}"]`),
      ).not.toBeNull();
    }
    card.remove();
    origin.remove();
  });

  it("T7: under reduced motion the panel has no scale or slide class (opacity only)", async () => {
    stubMedia(true);
    const { card, origin } = openWindow();
    const dialog = await screen.findByRole("dialog", { name: "Edit prices" });
    expect(dialog.className).not.toMatch(/zoom-in|slide-in-from/);
    expect(dialog.className).toContain("fade-in-0");
    card.remove();
    origin.remove();
  });

  it("T7 control: without reduced motion the panel does zoom in", async () => {
    stubMedia(false);
    const { card, origin } = openWindow();
    const dialog = await screen.findByRole("dialog", { name: "Edit prices" });
    expect(dialog.className).toContain("zoom-in-[0.97]");
    card.remove();
    origin.remove();
  });
});
