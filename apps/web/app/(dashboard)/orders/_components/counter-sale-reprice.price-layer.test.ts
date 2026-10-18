import { renderHook } from "@testing-library/react";
import type { CustomerLayerUnit } from "@routeflow/pricing";
import { addScannedProduct, type SaleLine } from "./counter-sale-scan";
import { repriceLines } from "./counter-sale-reprice";

// S19b slice B, B-2 (SA-811a R1): a counter sale prices a typed customer's product at the layer price. The layer is billing's
// own resolved row (the server), so the till only picks it with customerLinePrice. With no layer: master's tier price.
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

describe("counter sale: the customer's price layer (B-2)", () => {
  it("a scanned product lands at the layer price, SPECIAL", () => {
    const [line] = addScannedProduct([], product, "CASE" as never, 1, 3, typed33);
    expect(line.unitPrice).toBe(33);
    expect(line.priceType).toBe("SPECIAL");
  });

  it("no layer: master's tier price and flag", () => {
    const [line] = addScannedProduct([], product, "CASE" as never, 1, 3);
    expect(line.unitPrice).toBe(38);
    expect(line.priceType).toBe("SPECIAL");
    const [walkIn] = addScannedProduct([], product, "CASE" as never, 1, 1);
    expect(walkIn.unitPrice).toBe(42);
    expect(walkIn.priceType).toBe("STANDARD");
  });

  it("picking the customer reprices a walk-in cart to $33", () => {
    const [walkIn] = addScannedProduct([], product, "CASE" as never, 1, 1);
    expect(walkIn.unitPrice).toBe(42);
    const r = repriceLines(
      [walkIn],
      () => 3,
      (id) => (id === "prod-1" ? typed33 : undefined),
    );
    expect(r.lines[0].unitPrice).toBe(33);
    expect(r.lines[0].priceType).toBe("SPECIAL");
    expect(r.changed).toBe(1);
  });

  it("repriceLines without a layer is master's getTierPrice at the tier", () => {
    const [walkIn] = addScannedProduct([], product, "CASE" as never, 1, 1);
    const r = repriceLines([walkIn], () => 3);
    expect(r.lines[0].unitPrice).toBe(38);
  });
});

// SA-813 M1/M3 on the till: a pending or failed layer is "unconfirmed" and blocks Pay.
let mockLayerState: { enabled: boolean; pending: boolean; failed: boolean; ready: boolean };
jest.mock("@/lib/api/useCustomerPriceLayer", () => ({
  useCustomerPriceLayer: () => ({
    ...mockLayerState,
    complete: true,
    lineReady: () => mockLayerState.ready,
    layerOf: () => undefined,
    error: null,
    refetch: jest.fn(),
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

describe("counter sale: an unconfirmed layer blocks the till (B-5b)", () => {
  const { useCounterReprice } = require("./useCounterReprice");
  const run = () =>
    renderHook(() =>
      useCounterReprice({
        customer: { id: "c1", businessName: "Acme", pricingTier: 3 },
        lines: [] as SaleLine[],
        setLines: jest.fn(),
        locked: false,
      }),
    ).result.current;

  it("pending: unconfirmed pending and blocked", () => {
    mockLayerState = { enabled: true, pending: true, failed: false, ready: false };
    const r = run();
    expect(r.unconfirmed).toBe("pending");
    expect(r.blocked).toBe(true);
  });

  it("failed: unconfirmed failed, blocked and failed", () => {
    mockLayerState = { enabled: true, pending: false, failed: true, ready: false };
    const r = run();
    expect(r.unconfirmed).toBe("failed");
    expect(r.blocked).toBe(true);
    expect(r.failed).toBe(true);
  });

  it("ready: confirmed", async () => {
    mockLayerState = { enabled: true, pending: false, failed: false, ready: true };
    const r = run();
    expect(r.unconfirmed).toBeNull();
  });
});
