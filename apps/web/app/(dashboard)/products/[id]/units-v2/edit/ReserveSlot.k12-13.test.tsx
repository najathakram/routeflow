import * as React from "react";
import { render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { EditablePricesGrid } from "./EditablePricesGrid";
import { PriceDraftProvider } from "./PriceDraftProvider";
import { PriceEditBar } from "./PriceEditBar";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";

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

beforeEach(() => {
  mockGrid = { data: grid, isLoading: false, isError: false };
});
const mount = () =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>
      <PriceDraftProvider productId="p1">
        <EditablePricesGrid product={product} />
        <PriceEditBar />
      </PriceDraftProvider>
    </QueryClientProvider>,
  );
const edit = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByTestId(T.btnEdit));
  return user;
};

// K12 F13, narrowed (R3 review): the also-update slot is there from the moment Edit opens, but only holds its 8rem
// minimum once a plan exists, so a plan-less edit leaves no empty gap under the grid card.
describe("K12 F13: the also-update slot", () => {
  it("is absent outside edit mode and present, with no reserved height, until a plan exists", async () => {
    mount();
    expect(screen.queryByTestId("also-update-slot")).toBeNull();
    await edit();
    const slot = screen.getByTestId("also-update-slot");
    expect(slot.className).not.toMatch(/\bmin-h-\[/);
  });
});
