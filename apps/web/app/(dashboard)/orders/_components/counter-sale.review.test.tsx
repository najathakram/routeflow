import { renderHook } from "@testing-library/react";
import type { CustomerLayerUnit } from "@routeflow/pricing";
import { addScannedProduct, type SaleLine } from "./counter-sale-scan";
import { repriceLines } from "./counter-sale-reprice";
import { lineNeedingReason, priceEditLineOf } from "./counter-sale-price-edit";
import { resolveCounterPriceEdit } from "@/lib/counter-price-edit";

// S19b slice B review fixes (Opus xhigh FAIL @9c5dc7f04): items 3, 4 and 5 on the till.
const product = {
  id: "prod-1",
  name: "Widget",
  unit: "each",
  pricePerUnit: "42",
  priceTier2: "40",
  priceTier3: "38",
};
const typed33: CustomerLayerUnit[] = [
  { ref: "pack", label: null, price: 33, listPrice: 42, source: "customer", aboveList: false },
];

describe("review item 4: the till's edit-reason gate reads the layer's isSpecial", () => {
  // A tier-1 (Retail) customer who typed $33: SPECIAL by the layer, not by the tier.
  const [line] = addScannedProduct([], product, "CASE" as never, 1, 1, typed33);

  it("the line carries the layer's special flag", () => {
    expect(line.unitPrice).toBe(33);
    expect(line.special).toBe(true);
  });

  it("the price dialog line requires a reason for a typed SPECIAL, with tier 1", () => {
    const view = priceEditLineOf(line, 1);
    expect(view.isSpecial).toBe(true);
    const r = resolveCounterPriceEdit("set", 30, view);
    expect(r).toEqual(expect.objectContaining({ ok: false, refused: "REASON_REQUIRED" }));
    expect(resolveCounterPriceEdit("set", 30, view, "damaged").ok).toBe(true);
  });

  it("the Pay gate refuses an edited SPECIAL line without a reason", () => {
    const edited: SaleLine = {
      ...line,
      unitPrice: 30,
      tierPrice: 33,
      priceEdited: true,
      override: { mode: "set", value: 30 } as never,
    };
    expect(lineNeedingReason([edited], () => 1)).toBe(edited);
  });

  it("repriceLines keeps the flag in step with the layer", () => {
    const [walkIn] = addScannedProduct([], product, "CASE" as never, 1, 1);
    expect(walkIn.special).toBeUndefined(); // absent unless the layer prices the line
    const r = repriceLines(
      [walkIn],
      () => 1,
      () => typed33,
    );
    expect(r.lines[0].special).toBe(true);
  });
});

// Items 3 and 5 drive the real hook against a controllable layer state.
let mockLayer: Record<string, unknown>;
const mockRefetch = jest.fn();
jest.mock("@/lib/api/useCustomerPriceLayer", () => ({
  useCustomerPriceLayer: () => ({
    error: null,
    layerOf: () => undefined,
    refetch: mockRefetch,
    ...mockLayer,
  }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: undefined }) }));

describe("review item 3: an incomplete layer blocks the till per product", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useCounterReprice } = require("./useCounterReprice");
  const run = (lines: SaleLine[]) =>
    renderHook(() =>
      useCounterReprice({
        customer: { id: "c1", businessName: "Acme", pricingTier: 3 },
        lines,
        setLines: jest.fn(),
        locked: false,
      }),
    ).result.current;

  it("ready but the cart's product is absent from an incomplete layer: blocked, 'incomplete'", () => {
    mockLayer = {
      enabled: true,
      ready: true,
      pending: false,
      failed: false,
      complete: false,
      lineReady: (id: string) => id !== "prod-1",
    };
    const [l] = addScannedProduct([], product, "CASE" as never, 1, 3);
    const r = run([l]);
    expect(r.blocked).toBe(true);
    expect(r.unconfirmed).toBe("incomplete");
  });

  it("ready and listed: not blocked", () => {
    mockLayer = {
      enabled: true,
      ready: true,
      pending: false,
      failed: false,
      complete: true,
      lineReady: () => true,
    };
    const [l] = addScannedProduct([], product, "CASE" as never, 1, 3);
    const r = run([l]);
    expect(r.unconfirmed).toBeNull();
  });
});
