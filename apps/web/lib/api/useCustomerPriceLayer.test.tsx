import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { priceLayerKey, useCustomerPriceLayer } from "./useCustomerPriceLayer";

// S19b A0 (SA-813): the hook's contract. Flag off = NO request; flag on = key, staleTime 0, states pending/ready/failed/complete.
let flagOn = true;
const get = jest.fn();
jest.mock("./units-v2", () => ({ usePricesV2Enabled: () => flagOn }));
jest.mock("../api-client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));

const row = {
  ref: "pack",
  label: null,
  price: 33,
  listPrice: 42,
  source: "customer",
  aboveList: false,
};
const wrapper = (qc: QueryClient) =>
  function W({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
const mount = (id: string | null) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { qc, ...renderHook(() => useCustomerPriceLayer(id), { wrapper: wrapper(qc) }) };
};

describe("useCustomerPriceLayer", () => {
  beforeEach(() => {
    flagOn = true;
    get.mockReset();
  });

  it("the query key is [customers, id, price-layer]", () => {
    expect(priceLayerKey("c1")).toEqual(["customers", "c1", "price-layer"]);
  });

  it("flag OFF: no request at all, ready, layerOf undefined (every site runs master's chain)", () => {
    flagOn = false;
    const { result } = mount("c1");
    expect(get).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({
      enabled: false,
      ready: true,
      pending: false,
      failed: false,
    });
    expect(result.current.layerOf("p1")).toBeUndefined();
    expect(result.current.lineReady("p1")).toBe(true);
  });

  it("no customer chosen: no request", () => {
    mount(null);
    expect(get).not.toHaveBeenCalled();
  });

  it("flag on: pending (unconfirmed, not ready) then ready with the layer rows", async () => {
    get.mockResolvedValue({ data: { customerId: "c1", complete: true, products: { p1: [row] } } });
    const { result } = mount("c1");
    expect(result.current).toMatchObject({ enabled: true, ready: false, pending: true });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(get).toHaveBeenCalledWith("/customers/c1/price-layer");
    expect(result.current.layerOf("p1")).toEqual([row]);
    expect(result.current.layerOf("p-none")).toBeUndefined();
    expect(result.current.lineReady("p-none")).toBe(true);
  });

  it("A-8: an incomplete response: an absent product is NOT ready", async () => {
    get.mockResolvedValue({ data: { customerId: "c1", complete: false, products: { p1: [row] } } });
    const { result } = mount("c1");
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.complete).toBe(false);
    expect(result.current.lineReady("p1")).toBe(true);
    expect(result.current.lineReady("p-none")).toBe(false);
  });

  it("failed: not ready, failed true, with a refetch to retry", async () => {
    get.mockRejectedValue(new Error("boom"));
    const { result } = mount("c1");
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.ready).toBe(false);
    expect(result.current.lineReady("p1")).toBe(false);
    get.mockResolvedValue({ data: { customerId: "c1", complete: true, products: {} } });
    result.current.refetch();
    await waitFor(() => expect(result.current.ready).toBe(true));
  });

  it("nit 2: cached data while the mount refetch is in flight is NOT ready; it is ready once that fetch settles", async () => {
    let release: (v: unknown) => void = () => {};
    get.mockReturnValue(new Promise((r) => (release = r)));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(priceLayerKey("c1"), {
      customerId: "c1",
      complete: true,
      products: { p1: [row] },
    });
    const { result } = renderHook(() => useCustomerPriceLayer("c1"), { wrapper: wrapper(qc) });
    expect(result.current.layerOf("p1")).toEqual([row]); // the old layer is visible...
    expect(result.current.ready).toBe(false); // ...but it confirms nothing while the fresh read runs
    expect(result.current.lineReady("p1")).toBe(false);
    release({ data: { customerId: "c1", complete: true, products: { p1: [row] } } });
    await waitFor(() => expect(result.current.ready).toBe(true));
  });
});

describe("useCustomerPriceLayer: stable callbacks (integration review SHOULD 2)", () => {
  beforeEach(() => {
    flagOn = true;
    get.mockReset();
  });
  it("layerOf, refetch and the returned object keep their identity across re-renders with unchanged data", async () => {
    get.mockResolvedValue({ data: { customerId: "c1", complete: true, products: { p1: [row] } } });
    const { result, rerender } = mount("c1");
    await waitFor(() => expect(result.current.ready).toBe(true));
    const first = result.current;
    rerender();
    expect(result.current.layerOf).toBe(first.layerOf);
    expect(result.current.refetch).toBe(first.refetch);
    expect(result.current).toBe(first);
  });
});
