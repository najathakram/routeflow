import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { EditablePricesGrid } from "../edit/EditablePricesGrid";
import { PriceDraftProvider } from "../edit/PriceDraftProvider";
import { PriceEditBar } from "../edit/PriceEditBar";
import { usePriceDraft } from "../edit/usePriceDraft";
import { ChangePrices, useChangePrices } from "./ChangePrices";
import { PLAN_TESTIDS as P } from "./plan-testids";

// K12 P17: the Amount box says what it is an amount of: a % after a percent, a $ before an amount. The real draft,
// grid and panel; only the data hooks are mocked.

jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => true }));
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => ({ data: mockGrid, isLoading: false, isError: false }),
  fetchPriceGrid: () => Promise.resolve(mockGrid),
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

const cells = (v: number[], src: Array<"auto" | "set"> = []) =>
  v.map((value, i) => ({
    tier: (i + 1) as 1 | 2 | 3 | 4 | 5,
    value,
    source: src[i] ?? "auto",
  }));
const mockGrid: ProductPriceGridDto = {
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
      cells: cells([30, 28, 26, 24, 22], ["set", "set", "set"]),
    },
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      editable: true,
      code: null,
      cells: cells([1.25, 1.17, 1.08, 1, 0.92], ["set"]),
    },
  ],
};
const product = { id: "p1", unit: "Piece", unitsPerBox: 24, pricePerUnit: "1.25" };

function Harness() {
  const cp = useChangePrices();
  return (
    <PriceDraftProvider productId="p1">
      <EditablePricesGrid
        product={product}
        onOpenChangePrices={cp.toggle}
        changePricesOpen={cp.open}
        changePricesRef={cp.opener}
        panel={<ChangePrices open={cp.open} onClose={cp.close} openerRef={cp.opener} />}
      />
      <PriceEditBar changePricesOpen={cp.open} />
    </PriceDraftProvider>
  );
}
const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );

describe("K12 P17: the Amount box carries its unit", () => {
  it("shows % by default, $ when By is an amount, and the label still names the input", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId(T.btnChange));
    const box = within(screen.getByTestId(P.changePanel));
    expect(box.getByTestId("amount-adornment")).toHaveTextContent("%");
    expect(box.getByTestId("amount-adornment")).toHaveAttribute("aria-hidden", "true");
    await user.selectOptions(screen.getByLabelText("By"), "amount");
    expect(box.getByTestId("amount-adornment")).toHaveTextContent("$");
    expect(screen.getByLabelText("Amount")).toBeInstanceOf(HTMLInputElement);
  });
});
