import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { addScannedProduct, type SaleLine } from "./counter-sale-scan";
import { applyPriceEdit } from "./counter-sale-price-edit";

/**
 * SA-1068 A-2 (M12, T9-T11): the note's Undo restores the old price, and an unedited line sends no price, so the server books
 * today's rule whatever the screen says. A line whose remembered price differs on either side of the customer change stays
 * where the rule put it; a line with a price EDIT to restore still goes back, because that price is sent.
 */
type Hist = {
  isSuccess: boolean;
  isError: boolean;
  isFetching: boolean;
  data?: Record<string, { lastPrice: number; listPriceAtTime: number }>;
  refetch: jest.Mock;
};
const answered: Hist = {
  isSuccess: true,
  isError: false,
  isFetching: false,
  data: { "p-1": { lastPrice: 15, listPriceAtTime: 10 } },
  refetch: jest.fn(),
};
const noRead: Hist = { isSuccess: false, isError: false, isFetching: false, refetch: jest.fn() };
jest.mock("@/lib/api/orders", () => ({
  useCustomerPriceHistory: (id?: string) => (id ? answered : noRead),
}));
jest.mock("@/lib/api/useCustomerPriceLayer", () => ({
  useCustomerPriceLayer: () => ({
    enabled: false,
    pending: false,
    failed: false,
    ready: true,
    complete: true,
    lineReady: () => true,
    layerOf: () => undefined,
    error: null,
    refetch: jest.fn(),
  }),
}));
const mockNoPrices: unknown[] = []; // stable across renders, like the query cache: a fresh array would re-run the re-price effect
jest.mock("@/lib/api/customers", () => ({
  useCustomerPrices: () => ({
    data: mockNoPrices,
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: undefined }) }));

const { useCounterReprice } = require("./useCounterReprice");

const product = { id: "p-1", name: "Cola", unit: "each", pricePerUnit: "10" };
type Cust = { id: string; businessName: string; pricingTier: number } | null;
const acme: Cust = { id: "c1", businessName: "Acme", pricingTier: 1 };

function mount(customer: Cust, initial: SaleLine[]) {
  return renderHook(
    ({ c }: { c: Cust }) => {
      const [lines, setLines] = React.useState<SaleLine[]>(initial);
      const r = useCounterReprice({ customer: c, lines, setLines, locked: false });
      return { lines, ...r };
    },
    { initialProps: { c: customer } },
  );
}

describe("T9: a walk-in line, a customer with a memory picked, then Undo", () => {
  it("the line stays at the remembered price and keeps its chip", () => {
    const walkIn = addScannedProduct([], product, "CASE" as never, 1, 1);
    const h = mount(null, walkIn);
    h.rerender({ c: acme });
    expect(h.result.current.lines[0]).toMatchObject({
      unitPrice: 15,
      priceType: "MANUAL",
      remembered: true,
    });
    expect(h.result.current.noteText).not.toBeNull();
    act(() => h.result.current.undo());
    expect(h.result.current.lines[0]).toMatchObject({
      unitPrice: 15,
      priceType: "MANUAL",
      remembered: true,
    });
    expect(h.result.current.noteText).toBeNull();
  });
});

describe("T10: a named line at its memory, back to walk-in, then Undo", () => {
  it("the line stays at the tier price", () => {
    const named = addScannedProduct([], product, "CASE" as never, 1, 1, undefined, 15);
    expect(named[0]).toMatchObject({ unitPrice: 15, remembered: true });
    const h = mount(acme, named);
    h.rerender({ c: null });
    expect(h.result.current.lines[0]).toMatchObject({ unitPrice: 10, priceType: "STANDARD" });
    expect(h.result.current.lines[0].remembered).toBeUndefined();
    expect(h.result.current.noteText).not.toBeNull();
    act(() => h.result.current.undo());
    expect(h.result.current.lines[0]).toMatchObject({ unitPrice: 10, priceType: "STANDARD" });
    expect(h.result.current.lines[0].remembered).toBeUndefined();
    expect(h.result.current.noteText).toBeNull();
  });
});

describe("T11: an edited line still goes back (that price is sent)", () => {
  it("Undo restores the edit's net and its tier figure", () => {
    const [scanned] = addScannedProduct([], product, "CASE" as never, 1, 1);
    const [typed] = applyPriceEdit([scanned], scanned.tempId, {
      mode: "set",
      value: 12,
      unitPrice: 12,
      override: true,
    });
    const before = { unitPrice: typed.unitPrice, tierPrice: typed.tierPrice };
    const h = mount(null, [typed]);
    h.rerender({ c: acme });
    expect(h.result.current.lines[0]).toMatchObject({ unitPrice: 12, tierPrice: 15 });
    act(() => h.result.current.undo());
    expect(h.result.current.lines[0]).toMatchObject({ ...before, priceEdited: true });
    expect(h.result.current.noteText).toBeNull();
  });
});
