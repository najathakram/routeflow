import { act, renderHook } from "@testing-library/react";
import { addScannedProduct, type SaleLine } from "./counter-sale-scan";

/**
 * SA-1068 M6 (T5, T6): the till reads the customer's remembered prices like it reads their layer. While that read is pending
 * or failed Pay waits (the screen would show a price the server may not charge), Retry refetches it, and once it lands the
 * cart is re-priced to what the server will book. A walk-in has no customer, so no read and no wait.
 */
type Hist = {
  isSuccess: boolean;
  isError: boolean;
  isFetching: boolean;
  data?: Record<string, { lastPrice: number; listPriceAtTime: number }>;
  refetch: jest.Mock;
};
let mockHist: Hist;
jest.mock("@/lib/api/orders", () => ({ useCustomerPriceHistory: () => mockHist }));
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

const { useCounterReprice } = require("./useCounterReprice");

const product = { id: "p-1", name: "Cola", unit: "each", pricePerUnit: "10" };
const customer = { id: "c1", businessName: "Acme", pricingTier: 1 };
const hist = (over: Partial<Hist>): Hist => ({
  isSuccess: false,
  isError: false,
  isFetching: true,
  refetch: jest.fn(),
  ...over,
});
const run = (c: typeof customer | null, lines: SaleLine[] = [], setLines = jest.fn()) =>
  renderHook(() => useCounterReprice({ customer: c, lines, setLines, locked: false }));

describe("T5: the remembered-price read gates Pay", () => {
  it("pending: Pay waits", () => {
    mockHist = hist({});
    const r = run(customer).result.current;
    expect(r.blocked).toBe(true);
    expect(r.unconfirmed).toBe("pending");
  });

  it("failed: Pay waits, the failure shows, and Retry refetches the read", () => {
    mockHist = hist({ isError: true, isFetching: false });
    const r = run(customer).result.current;
    expect(r.blocked).toBe(true);
    expect(r.failed).toBe(true);
    expect(r.unconfirmed).toBe("failed");
    r.retry();
    expect(mockHist.refetch).toHaveBeenCalledTimes(1);
  });

  it("answered: Pay is free and the remembered price is readable", () => {
    mockHist = hist({
      isSuccess: true,
      isFetching: false,
      data: { "p-1": { lastPrice: 15, listPriceAtTime: 10 } },
    });
    const r = run(customer).result.current;
    expect(r.blocked).toBe(false);
    expect(r.unconfirmed).toBeNull();
    expect(r.rememberedOf("p-1")).toBe(15);
    expect(r.rememberedOf("p-2")).toBeNull();
  });

  it("a walk-in has no customer: no wait, nothing remembered", () => {
    mockHist = hist({ isFetching: false });
    const r = run(null).result.current;
    expect(r.blocked).toBe(false);
    expect(r.rememberedOf("p-1")).toBeNull();
  });
});

describe("T6 through the hook: the cart follows the customer", () => {
  it("a line scanned as a walk-in is re-priced to the remembered price once the read lands", () => {
    mockHist = hist({
      isSuccess: true,
      isFetching: false,
      data: { "p-1": { lastPrice: 15, listPriceAtTime: 10 } },
    });
    const walkIn = addScannedProduct([], product, "CASE" as never, 1, 1);
    expect(walkIn[0].unitPrice).toBe(10);
    const setLines = jest.fn();
    act(() => {
      run(customer, walkIn, setLines);
    });
    expect(setLines).toHaveBeenCalled();
    const next = setLines.mock.calls[0][0](walkIn) as SaleLine[];
    expect(next[0]).toMatchObject({ unitPrice: 15, priceType: "MANUAL" });
  });
});
