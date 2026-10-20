import * as React from "react";
import { render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EditablePricesGrid } from "./EditablePricesGrid";
import { PriceDraftProvider } from "./PriceDraftProvider";
import type { ProductPriceGridDto } from "@routeflow/types";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
let mockError: unknown = null;
const mockSave = jest.fn();
let mockFresh: ProductPriceGridDto = {} as ProductPriceGridDto;
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => mockGrid,
  fetchPriceGrid: () => Promise.resolve(mockFresh),
}));
jest.mock("@/lib/api/usePriceWrites", () => ({
  ...jest.requireActual("@/lib/api/usePriceWrites"),
  useSavePrices: () => ({ mutate: mockSave, reset: jest.fn(), isPending: false, error: mockError }),
  useUndoPrices: () => ({ mutate: jest.fn(), isPending: false, error: null }),
}));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: { "2": "Wholesale", "3": "Distributor" } }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
// The customers query is settled (Save also waits for it) and holds nobody; Seams.test.tsx drives it.
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
      factor: 960,
      kind: "pack",
      editable: true,
      code: "012345678905",
      cells: cells([0, 13.91, 12.5, 11, 10], ["set", "set", "auto", "auto", "auto"]),
    },
    {
      ref: "box",
      label: "Box",
      factor: 24,
      kind: "unit",
      editable: true,
      code: null,
      cells: cells([24.5, 22, 21, 20, 19]),
    },
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      editable: true,
      code: null,
      cells: cells([0.92, 0.9, 0.88, 0.85, 0.8], ["set", "auto", "auto", "auto", "auto"]),
    },
  ],
};
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);
const render = (ui: React.ReactElement, opts: Parameters<typeof rtlRender>[1] = {}) =>
  rtlRender(ui, { wrapper, ...opts });
const product = { id: "p1", unit: "Piece", unitsPerBox: 24, pricePerUnit: "0.92" };

beforeEach(() => {
  mockError = null;
  mockSave.mockReset();
  mockGrid = { data: grid, isLoading: false, isError: false };
});

const mount = (extra: Partial<React.ComponentProps<typeof EditablePricesGrid>> = {}) =>
  render(
    <PriceDraftProvider productId="p1">
      <EditablePricesGrid product={product} onOpenChangePrices={() => {}} {...extra} />
    </PriceDraftProvider>,
  );

describe("R3 review item 2: the region heading leads the actions row", () => {
  it("renders Prices by unit once, in the actions row before Change prices, not in the grid card", () => {
    mount();
    const row = screen.getByTestId("units-v2-actions-row");
    const h = within(row).getByRole("heading", { level: 2, name: "Prices by unit" });
    expect(h).toHaveAttribute("id", "units-v2-grid-title");
    expect(screen.getAllByRole("heading", { name: "Prices by unit" })).toHaveLength(1);
    expect(within(screen.getByTestId(T.grid)).queryByRole("heading")).toBeNull();
    const change = within(row).getByRole("button", { name: "Change prices" });
    expect(h.compareDocumentPosition(change) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the scrolling table region is still named by that heading", () => {
    mount();
    expect(screen.getByTestId(T.unitsTable)).toHaveAttribute(
      "aria-labelledby",
      "units-v2-grid-title",
    );
  });
});

describe("R3 review item 3: the entry button reads Edit prices", () => {
  it("names the entry button Edit prices", () => {
    mount();
    expect(screen.getByRole("button", { name: "Edit prices" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit$/ })).toBeNull();
  });
});

describe("R3 review item 4: Name / Contains read straight under the grid card", () => {
  it("renders afterGrid after the grid card and before the order-unit footer", async () => {
    const user = userEvent.setup();
    mount({ afterGrid: <div data-testid="after-grid" /> });
    await user.click(screen.getByRole("button", { name: "Edit prices" }));
    const after = screen.getByTestId("after-grid");
    const follows = (a: Element, b: Element) =>
      !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(screen.getByTestId(T.grid), after)).toBe(true);
    expect(follows(after, screen.getByTestId(T.orderUnit))).toBe(true);
  });

  it("keeps the disabled Pricing unit select (the guarded control) where it is", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Edit prices" }));
    expect(screen.getByTestId(T.orderUnit)).toHaveAttribute("aria-disabled", "true");
  });
});
