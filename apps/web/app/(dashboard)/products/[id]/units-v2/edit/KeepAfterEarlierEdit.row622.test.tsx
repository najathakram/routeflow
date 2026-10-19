import * as React from "react";
import { act, render as rtlRender } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { PriceDraftProvider } from "./PriceDraftProvider";
import { usePriceDraft, type PriceDraft } from "./usePriceDraft";

// Row 622: a Keep chosen AFTER an earlier edit in the same draft pins the price the DRAFT shows, but the server
// (planCells) checks every Keep against the SAVED ladder, so Save came back 400 "that price is not what it shows now".
// What the web sends as a Keep must be a price the server can match to the saved ladder; any other pin goes as a patch.

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
// A 12-pack at $24 (only its Retail is a set price) and a factor-1 Piece row that is Auto, so every Piece price is 2.00.
const grid: ProductPriceGridDto = {
  productId: "p1",
  anchor: "pack",
  revision: 7,
  priceState: "ps-1",
  tierAnchors: {},
  tierRules: {},
  rows: [
    {
      ref: "pack",
      label: "12-pack",
      factor: 12,
      kind: "pack",
      editable: true,
      code: null,
      cells: cells([24, 24, 24, 24, 24], ["set"]),
    },
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      editable: true,
      code: null,
      cells: cells([2, 2, 2, 2, 2]),
    },
  ],
};
const savedPrice = (ref: string, tier: number) =>
  grid.rows.find((r) => r.ref === ref)!.cells[tier - 1].value;

let draft!: PriceDraft;
const Probe = () => {
  draft = usePriceDraft();
  return null;
};
const mount = () =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>
      <PriceDraftProvider productId="p1">
        <Probe />
      </PriceDraftProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  mockGrid = { data: grid, isLoading: false, isError: false };
});

describe("row 622: Keep after an earlier edit in the same draft", () => {
  it("every Keep sent is a price the saved ladder shows (the server's planCells match), and the kept price is still saved", () => {
    mount();
    act(() => draft.startEditing());
    act(() => void draft.editCell("pack", 1, "30"));
    act(() => void draft.editCell("pack", 2, "28"));
    // Piece Wholesale followed edit 1 (2.00 to 2.50) and now follows edit 2 (2.50 to 2.33): the Keep is 2.50.
    const follower = draft.plan?.plan.followers.find((f) => f.ref === "piece" && f.tier === 2);
    expect(follower?.keep.value).toBe(2.5);
    act(() => draft.keep(follower!.keep));

    const req = draft.toRequest()!;
    for (const k of req.keeps ?? []) expect(k.value).toBe(savedPrice(k.ref, k.tier));
    // The owner's choice survives: Piece Wholesale is written at 2.50 whichever list carries it.
    const pinned =
      req.patches.find((p) => p.ref === "piece" && p.tier === 2)?.to ??
      req.keeps?.find((k) => k.ref === "piece" && k.tier === 2)?.value;
    expect(pinned).toBe(2.5);
  });

  it("a Keep that matches the saved ladder still goes as a Keep", () => {
    mount();
    act(() => draft.startEditing());
    act(() => void draft.editCell("pack", 2, "28"));
    const follower = draft.plan?.plan.followers.find((f) => f.ref === "piece" && f.tier === 2);
    expect(follower?.keep.value).toBe(2);
    act(() => draft.keep(follower!.keep));
    const req = draft.toRequest()!;
    expect(req.keeps).toEqual([{ ref: "piece", tier: 2, value: 2 }]);
    expect(req.patches.map((p) => `${p.ref}|${p.tier}`)).not.toContain("piece|2");
  });
});
