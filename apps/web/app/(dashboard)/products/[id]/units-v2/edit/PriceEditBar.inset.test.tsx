import * as React from "react";
import { act, render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { EditablePricesGrid } from "./EditablePricesGrid";
import { PriceDraftProvider } from "./PriceDraftProvider";
import { PriceEditBar } from "./PriceEditBar";
import { useShellBottom } from "./useClearOfShellPadding";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";

// F22: the dashboard's #main-content is the scroller and has pb-24. A sticky bar stops at that padding, so it floated
// 96px up and covered the Case and Piece rows when Edit first opened. Same cure as the counter's checkout bar (#3500).

// N2: lets a test force what the shared `useShellBottom` answers, to prove the bar really asks it.
let mockShellBottom: number | null = null;
jest.mock("./useClearOfShellPadding", () => {
  const actual = jest.requireActual("./useClearOfShellPadding");
  return {
    ...actual,
    useShellBottom: (active: boolean) => {
      const real = actual.useShellBottom(active);
      return mockShellBottom ?? real;
    },
  };
});

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => mockGrid,
}));
jest.mock("@/lib/api/usePriceWrites", () => ({
  ...jest.requireActual("@/lib/api/usePriceWrites"),
  useSavePrices: () => ({ mutate: jest.fn(), reset: jest.fn(), isPending: false, error: null }),
  useUndoPrices: () => ({ mutate: jest.fn(), isPending: false, error: null }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: {} }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  ...jest.requireActual("@/lib/api/useProductCustomerPrices"),
  useProductCustomerPrices: () => ({ data: { customers: [] }, isFetching: false }),
}));

const cells = (v: number[]) =>
  v.map((value, i) => ({ tier: (i + 1) as 1 | 2 | 3 | 4 | 5, value, source: "set" as const }));
const grid: ProductPriceGridDto = {
  productId: "p1",
  anchor: "piece",
  revision: 7,
  priceState: "ps-1",
  tierAnchors: {},
  tierRules: {},
  rows: [
    {
      ref: "case",
      label: "Case",
      factor: 24,
      kind: "pack",
      editable: true,
      code: null,
      cells: cells([30, 28, 27, 26, 25]),
    },
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      editable: true,
      code: null,
      cells: cells([1.5, 1.4, 1.3, 1.2, 1.1]),
    },
  ],
};
const product = { id: "p1", unit: "Piece", unitsPerBox: 24, pricePerUnit: "1.5" };
const BAR_HEIGHT = 60;

const realHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
let main: HTMLElement | null = null;
beforeEach(() => {
  mockShellBottom = null;
  mockGrid = { data: grid, isLoading: false, isError: false };
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return (this as HTMLElement).dataset.testid === T.editbar ? BAR_HEIGHT : 0;
    },
  });
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
});
afterEach(() => {
  if (realHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", realHeight);
  delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
  main?.remove();
  main = null;
});

const shell = (paddingBottom?: string) => {
  main = document.createElement("main");
  main.id = "main-content";
  if (paddingBottom) main.style.paddingBottom = paddingBottom;
  document.body.appendChild(main);
  return main;
};
const mount = () =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>
      <PriceDraftProvider productId="p1">
        <EditablePricesGrid product={product} />
        <PriceEditBar />
      </PriceDraftProvider>
    </QueryClientProvider>,
    { container: main?.appendChild(document.createElement("div")) },
  );
const edit = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByTestId(T.btnEdit));
  return user;
};

describe("F22: the save bar never covers the grid rows", () => {
  it("rests at the real bottom of the scroller, through the shell's padding, not 96px up", async () => {
    shell("96px");
    mount();
    await edit();
    const bar = screen.getByTestId(T.editbar);
    expect(bar.className).toContain("sticky");
    expect(bar.style.bottom).toBe("-96px");
  });

  it("keeps a focused price box clear of the bar: scroll-padding-bottom is the bar's height, and lets go on Cancel", async () => {
    const m = shell("96px");
    mount();
    expect(m.style.getPropertyValue("scroll-padding-bottom")).toBe("");
    const user = await edit();
    expect(m.style.getPropertyValue("scroll-padding-bottom")).toBe(`${BAR_HEIGHT}px`);
    await user.click(screen.getByTestId(T.ebCancel));
    expect(screen.queryByTestId(T.editbar)).toBeNull();
    expect(m.style.getPropertyValue("scroll-padding-bottom")).toBe("");
  });

  it("puts back the scroller's own scroll-padding-bottom instead of clearing it", async () => {
    const m = shell("96px");
    m.style.setProperty("scroll-padding-bottom", "12px");
    mount();
    const user = await edit();
    expect(m.style.getPropertyValue("scroll-padding-bottom")).toBe(`${BAR_HEIGHT}px`);
    await user.click(screen.getByTestId(T.ebCancel));
    expect(m.style.getPropertyValue("scroll-padding-bottom")).toBe("12px");
  });

  it("lets go of the scroller on unmount", async () => {
    const m = shell("96px");
    const view = mount();
    await edit();
    expect(m.style.getPropertyValue("scroll-padding-bottom")).toBe(`${BAR_HEIGHT}px`);
    act(() => view.unmount());
    expect(m.style.getPropertyValue("scroll-padding-bottom")).toBe("");
  });

  // K13 P10/P11 (K12 P14): content under the sticky bar is padded by the bar's measured height, so the last card (and,
  // in Change prices, Order unit and the "Prices by unit" heading) scrolls fully clear of it.
  it("pads the scroller's bottom by the bar's height while the bar is up, and lets go on Cancel", async () => {
    const m = shell("96px");
    mount();
    expect(m.style.paddingBottom).toBe("96px");
    const user = await edit();
    expect(m.style.paddingBottom).toBe(`${96 + BAR_HEIGHT}px`);
    await user.click(screen.getByTestId(T.ebCancel));
    expect(m.style.paddingBottom).toBe("96px");
  });

  it("does not move the bar: its bottom still comes from the shell's own padding", async () => {
    shell("96px");
    mount();
    await edit();
    expect(screen.getByTestId(T.editbar).style.bottom).toBe("-96px");
  });

  it("with no dashboard shell around it the bar sticks at 0 and nothing else is touched", async () => {
    shell();
    mount();
    await edit();
    expect(screen.getByTestId(T.editbar).style.bottom).toBe("0px");
  });
});

describe("N2: the bar and the saved line share ONE shell-bottom rule", () => {
  it("the bar's bottom is whatever the shared useShellBottom answers", async () => {
    shell("96px");
    mockShellBottom = -42;
    mount();
    await edit();
    expect(screen.getByTestId(T.editbar).style.bottom).toBe("-42px");
  });

  it("the bar and a user of the shared hook read the same value from the same shell", async () => {
    shell("96px");
    let shared = NaN;
    const Probe = () => {
      shared = useShellBottom(true);
      return null;
    };
    rtlRender(
      <QueryClientProvider client={new QueryClient()}>
        <PriceDraftProvider productId="p1">
          <EditablePricesGrid product={product} />
          <PriceEditBar />
          <Probe />
        </PriceDraftProvider>
      </QueryClientProvider>,
      { container: main?.appendChild(document.createElement("div")) },
    );
    await edit();
    expect(shared).toBe(-96);
    expect(screen.getByTestId(T.editbar).style.bottom).toBe(`${shared}px`);
  });
});
