import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCounterSaleByKey, useCounterSaleGate, useCreateCounterSale } from "./counter-sale";

const post = jest.fn();
const get = jest.fn();
jest.mock("../api-client", () => ({
  apiClient: { post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a) },
}));
let features: { data?: unknown; isLoading?: boolean; isError?: boolean } = { data: undefined };
const featureOpts: unknown[] = [];
jest.mock("../tenant-features", () => ({
  useTenantFeatures: (o?: unknown) => {
    featureOpts.push(o);
    return features;
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

describe("useCreateCounterSale: the Idempotency-Key header", () => {
  beforeEach(() => post.mockReset());

  it("posts the dto with the key as an Idempotency-Key header and returns the response body", async () => {
    const body = { orderId: "o1", paymentRecorded: true };
    post.mockResolvedValue({ data: body });
    const { result } = renderHook(() => useCreateCounterSale(), { wrapper });
    const dto = { walkIn: true, items: [], payment: { method: "CASH" as const } };
    let res: unknown;
    await act(async () => {
      res = await result.current.mutateAsync({ dto, idempotencyKey: "key-abc" });
    });
    expect(post).toHaveBeenCalledWith("/orders/counter-sale", dto, {
      headers: { "Idempotency-Key": "key-abc" },
    });
    expect(res).toEqual(body);
  });
});

describe("useCounterSaleGate: a missing capability is DARK (entry points and screen alike)", () => {
  const NONE = { showButton: false, opensAsCounter: false, offerShipInstead: false };
  const gateFor = (f: typeof features) => {
    features = f;
    return renderHook(() => useCounterSaleGate()).result.current;
  };
  afterEach(() => {
    features = { data: undefined };
  });

  it.each([
    ["errored", { data: undefined, isError: true }],
    ["a response without capabilities", { data: { tenantId: "t1" } }],
    ["capabilities without fulfilment", { data: { capabilities: {} } }],
    ["counter off", { data: { capabilities: { fulfilment: { counter: "off" } } } }],
    ["an unknown counter value", { data: { capabilities: { fulfilment: { counter: "bogus" } } } }],
  ])("%s: no button, no open-as-counter", (_label, f) => {
    expect(gateFor(f)).toMatchObject(NONE);
  });

  it("loading is exposed as `loading` (and nothing else is open)", () => {
    expect(gateFor({ data: undefined, isLoading: true })).toMatchObject({ ...NONE, loading: true });
  });

  it.each([
    ["errored", { data: undefined, isError: true }],
    ["resolved without the capability", { data: { tenantId: "t1" } }],
    ["resolved with counter off", { data: { capabilities: { fulfilment: { counter: "off" } } } }],
    ["resolved optional", { data: { capabilities: { fulfilment: { counter: "optional" } } } }],
  ])("%s: not loading", (_label, f) => {
    expect(gateFor(f).loading).toBe(false);
  });

  it("optional: the button only; always: the button and open-as-counter", () => {
    expect(
      gateFor({ data: { capabilities: { fulfilment: { counter: "optional" } } } }),
    ).toMatchObject({ showButton: true, opensAsCounter: false });
    expect(
      gateFor({ data: { capabilities: { fulfilment: { counter: "always" } } } }),
    ).toMatchObject({ showButton: true, opensAsCounter: true });
  });
});

describe("useCounterSaleByKey: GET /orders/counter-sale/by-key/:key?method=", () => {
  beforeEach(() => get.mockReset());

  it("looks the held key up with the method THIS attempt rang and returns the sale body", async () => {
    const body = { orderId: "o1", replayed: true };
    get.mockResolvedValue({ data: body });
    const { result } = renderHook(() => useCounterSaleByKey(), { wrapper });
    let res: unknown;
    await act(async () => {
      res = await result.current.mutateAsync({ idempotencyKey: "key abc/1", method: "CARD" });
    });
    expect(get).toHaveBeenCalledWith("/orders/counter-sale/by-key/key%20abc%2F1", {
      params: { method: "CARD" },
    });
    expect(res).toEqual(body);
  });
});

describe("useCounterSaleGate enabled option", () => {
  beforeEach(() => {
    featureOpts.length = 0;
    features = { data: undefined };
  });

  it("passes enabled:false through so the features request is not made, and is never loading", () => {
    features = { data: undefined, isLoading: true };
    const { result } = renderHook(() => useCounterSaleGate({ enabled: false }), { wrapper });
    expect(featureOpts[0]).toEqual({ enabled: false });
    expect(result.current.showButton).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it("defaults to enabled", () => {
    renderHook(() => useCounterSaleGate(), { wrapper });
    expect(featureOpts[0]).toEqual({ enabled: true });
  });
});
