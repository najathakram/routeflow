import * as React from "react";
import { render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";

// K11-13: Enter on a price opens that price, and the opened box is never left under the save bar.

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => mockGrid,
  fetchPriceGrid: () => Promise.resolve(mockGrid.data),
}));
jest.mock("@/lib/api/usePriceWrites", () => ({
  ...jest.requireActual("@/lib/api/usePriceWrites"),
  useSavePrices: () => ({ mutate: jest.fn(), reset: jest.fn(), isPending: false, error: null }),
  useUndoPrices: () => ({ mutate: jest.fn(), isPending: false, error: null }),
}));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: { "2": "Wholesale", "3": "Distributor" } }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  ...jest.requireActual("@/lib/api/useProductCustomerPrices"),
  useProductCustomerPrices: () => ({ data: { customers: [] }, isFetching: false }),
}));

const cells = (v: number[], src: Array<"auto" | "set"> = []) =>
  v.map((value, i) => ({
    tier: (i + 1) as 1 | 2 | 3 | 4 | 5,
    value,
    source: src[i] ?? "auto",
  }));
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
      factor: 60,
      kind: "pack",
      editable: true,
      code: null,
      cells: cells([1800, 30, 28.5, 27, 26], ["set", "set", "auto", "auto", "auto"]),
    },
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      editable: true,
      code: null,
      cells: cells([30, 0.5, 0.48, 0.45, 0.43], ["set", "auto", "auto", "auto", "auto"]),
    },
  ],
};
const product = { id: "p1", unit: "Piece", unitsPerBox: 60, pricePerUnit: "30" };
const render = () =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>
      <ProductPricingV2 product={product} />
    </QueryClientProvider>,
  );
const row = (ref: string) => within(screen.getByTestId(T.row(ref)));
const editButton = (ref: string, name: RegExp) => row(ref).getByRole("button", { name });
const scrollIntoView = jest.fn();

beforeEach(() => {
  mockGrid = { data: grid, isLoading: false, isError: false };
  scrollIntoView.mockReset();
  (HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
});
afterEach(() => {
  delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  document.getElementById("main-content")?.remove();
});

describe("K11-13: Enter on a price opens that price", () => {
  it("Enter on the Wholesale Piece price leaves focus on the Wholesale Piece input, not the first box", async () => {
    const user = userEvent.setup();
    render();
    editButton("piece", /^Edit Wholesale Piece price/).focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(row("piece").getByTestId(T.input("piece", 2)));
  });

  it("Enter on a Tier 4 price of the first row opens that one, and a click still does", async () => {
    const user = userEvent.setup();
    render();
    editButton("case", /^Edit Tier 4 Case price/).focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(row("case").getByTestId(T.input("case", 4)));
  });

  it("the Edit button still hands focus to the first price box", async () => {
    const user = userEvent.setup();
    render();
    await user.click(screen.getByTestId(T.btnEdit));
    expect((document.activeElement as HTMLElement).getAttribute("data-testid")).toBe(
      T.input("case", 1),
    );
  });
});

describe("K11-13: the opened box is scrolled clear of the save bar", () => {
  it("scrolls the focused box into view, nearest edge, once the page has a frame", async () => {
    const user = userEvent.setup();
    render();
    await user.click(editButton("piece", /^Edit Wholesale Piece price/));
    const input = row("piece").getByTestId(T.input("piece", 2));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.contexts[0]).toBe(input);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("waits for the bar's measured height (scroll-padding-bottom on #main-content) before it scrolls", async () => {
    const main = document.body.appendChild(document.createElement("div"));
    main.id = "main-content";
    const user = userEvent.setup();
    render();
    await user.click(editButton("piece", /^Edit Wholesale Piece price/));
    await new Promise((r) => setTimeout(r, 60));
    expect(scrollIntoView).not.toHaveBeenCalled();
    main.style.setProperty("scroll-padding-bottom", "64px");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" }));
  });
});
