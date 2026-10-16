import * as React from "react";
import { render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { UNITS_V2_CONFIRM_TESTIDS as C } from "../confirm/confirm-testids";
import { emptyPlan } from "../change-prices/plan.test-utils";
import { EditablePricesGrid } from "./EditablePricesGrid";
import { PriceDraftProvider } from "./PriceDraftProvider";
import { usePriceDraft, type PriceDraft } from "./usePriceDraft";

// K8 integration seams: K3's draft + K4's Change prices + K5's status line, mounted the way the page mounts them.

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
let mockError: unknown = null;
const mockSave = jest.fn();
const mockUndo = jest.fn();
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => mockGrid,
  fetchPriceGrid: () => Promise.resolve(mockGrid.data),
}));
jest.mock("@/lib/api/usePriceWrites", () => ({
  ...jest.requireActual("@/lib/api/usePriceWrites"),
  useSavePrices: () => ({ mutate: mockSave, isPending: false, error: mockError }),
  useUndoPrices: () => ({
    mutate: jest.fn(),
    mutateAsync: mockUndo,
    isPending: false,
    error: null,
  }),
}));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: { "2": "Wholesale", "3": "Distributor" } }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => true }));
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  useProductCustomerPrices: () => ({ data: { customers: [] } }),
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
  rows: [
    {
      ref: "case",
      label: "Case",
      factor: 960,
      kind: "pack",
      code: null,
      cells: cells([0, 13.91, 12.5, 11, 10], ["set", "set", "auto", "auto", "auto"]),
    },
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      code: null,
      cells: cells([0.92, 0.9, 0.88, 0.85, 0.8], ["set"]),
    },
  ],
};
const saved: ProductPriceGridDto = { ...grid, revision: 8, priceState: "ps-2" };
const product = { id: "p1", unit: "Piece", unitsPerBox: 24, pricePerUnit: "0.92" };

let draft!: PriceDraft;
const Probe = () => {
  draft = usePriceDraft();
  return null;
};
const render = () =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>
      <ProductPricingV2 product={product} />
    </QueryClientProvider>,
  );
const edit = async (user: ReturnType<typeof userEvent.setup>, text = "14.5") => {
  await user.click(screen.getByTestId(T.btnEdit));
  const input = within(screen.getByTestId(T.row("case"))).getByTestId(T.input("case", 2));
  await user.clear(input);
  await user.type(input, text);
};

beforeEach(() => {
  mockError = null;
  mockSave.mockReset();
  mockUndo.mockReset();
  mockGrid = { data: grid, isLoading: false, isError: false };
});

describe("K8 seams", () => {
  it("one Undo: Saved shows K5's line only, and an Undo keeps 'Save undone.' with no Undo left", async () => {
    mockSave.mockImplementation((_req, o) => {
      mockGrid = { data: saved, isLoading: false, isError: false };
      o.onSuccess({
        auditId: "a1",
        revision: 8,
        undo: { patches: [{ ref: "case", tier: 2, to: 13.91 }], customerMoves: [] },
        grid: saved,
      });
    });
    mockUndo.mockResolvedValue({});
    const user = userEvent.setup();
    render();
    await edit(user);
    await user.click(screen.getByTestId(T.ebSave));
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    await user.click(screen.getByTestId(C.saveUndo));
    expect(mockUndo).toHaveBeenCalledWith({
      auditId: "a1",
      expectedRevision: 8,
      expectedPriceState: "ps-2",
    });
    expect(await screen.findByText("Save undone.")).toBeTruthy();
    expect(screen.queryByTestId(C.saveUndo)).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("a grid without priceState cannot save: Save is unavailable and no request is made", async () => {
    mockGrid = { data: { ...grid, priceState: undefined }, isLoading: false, isError: false };
    const user = userEvent.setup();
    render();
    await edit(user);
    const save = screen.getByTestId(T.ebSave);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    await user.click(save);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("a stale save shows K5's notice (one alert) with Reload prices", async () => {
    mockError = { response: { status: 409, data: { code: "LADDER_REVISION_STALE" } } };
    const user = userEvent.setup();
    render();
    await edit(user);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Reload prices" })).toBeTruthy();
  });

  it("K4 seam: Apply opens edit mode, leaves the customer offer at index 0, Keeps toggle on and off", async () => {
    const customerMoves = [{ customerId: "c1", ref: "case", tier: 2 as const, from: 13.5, to: 14 }];
    const plan = emptyPlan({
      patches: [{ ref: "case", tier: 2, to: 14 }],
      offers: [
        {
          kind: "customer",
          ticked: false,
          title: "Also raise prices set for 1 customer",
          moves: customerMoves,
        },
      ],
      changes: [{ ref: "case", label: "Case", tier: 2, from: 13.91, to: 14 }],
    });
    rtlRender(
      <QueryClientProvider client={new QueryClient()}>
        <PriceDraftProvider productId="p1">
          <Probe />
          <EditablePricesGrid product={product} />
        </PriceDraftProvider>
      </QueryClientProvider>,
    );
    expect(draft.editing).toBe(false);
    act(() => draft.applyPlan(plan));
    act(() => draft.setOfferTicked(0, true));
    expect(draft.editing).toBe(true);
    expect(draft.plan?.cell).toBeNull();
    expect(draft.plan?.ticked).toEqual([true]);
    expect(draft.canSave).toBe(true);
    expect(draft.toRequest()).toMatchObject({
      expectedRevision: 7,
      expectedPriceState: "ps-1",
      patches: [{ ref: "case", tier: 2, to: 14 }],
      customerMoves,
    });
    const keep = { customerId: "c2", ref: "case", tier: 1, from: null, to: 9 };
    act(() => draft.keepCustomer(keep));
    act(() => draft.keepCustomer(keep));
    expect(draft.plan?.customerKeeps).toEqual([keep]);
    expect(draft.toRequest()?.customerMoves).toEqual([...customerMoves, keep]);
    act(() => draft.keepCustomer(keep, false));
    expect(draft.plan?.customerKeeps).toEqual([]);
  });

  it("an edited cell exposes the fields K4's panel reads (cell, ticked, keeps)", async () => {
    const user = userEvent.setup();
    rtlRender(
      <QueryClientProvider client={new QueryClient()}>
        <PriceDraftProvider productId="p1">
          <Probe />
          <EditablePricesGrid product={product} />
        </PriceDraftProvider>
      </QueryClientProvider>,
    );
    await edit(user);
    expect(draft.plan?.cell).toEqual({ ref: "case", tier: 2 });
    expect(draft.plan?.ticked).toEqual([]);
    expect(draft.plan?.keeps).toEqual([]);
  });
});
