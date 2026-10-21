import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
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

let authUser: { role: string } | null = null;
jest.mock("../auth-context", () => ({
  useOptionalAuth: () => (authUser ? { user: authUser } : null),
  useAuth: () => ({ user: authUser }),
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
    return renderHook(() => useCounterSaleGate(), { wrapper }).result.current;
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

describe("useCounterSaleGate: a disabled gate stays dark even with cached add-on data (W20-L2)", () => {
  const cached = (counter: string) => ({ data: { capabilities: { fulfilment: { counter } } } });
  afterEach(() => {
    features = { data: undefined };
  });
  it.each(["optional", "always"])("enabled:false with cached %s: showButton false", (counter) => {
    features = cached(counter);
    const r = renderHook(() => useCounterSaleGate({ enabled: false }), { wrapper }).result.current;
    expect(r.showButton).toBe(false);
  });
  it.each(["optional", "always"])("enabled:false with cached %s: capability is null", (counter) => {
    features = cached(counter);
    const r = renderHook(() => useCounterSaleGate({ enabled: false }), { wrapper }).result.current;
    expect(r.capability).toBeNull();
  });
  it("enabled:true with cached always: capability is passed through", () => {
    features = cached("always");
    const r = renderHook(() => useCounterSaleGate({ enabled: true }), { wrapper }).result.current;
    expect(r.capability).toEqual({ counter: "always" });
  });
  it("enabled:true with cached optional: unchanged", () => {
    features = cached("optional");
    expect(
      renderHook(() => useCounterSaleGate({ enabled: true }), { wrapper }).result.current
        .showButton,
    ).toBe(true);
  });
});

describe("useCounterSaleGate: BO-07 till permission (an operator whose admin turned off ORDERS)", () => {
  const ALWAYS = { data: { capabilities: { fulfilment: { counter: "always" } } } };
  const ALL = ["PRICING", "ORDERS", "FINANCE"];
  const perms = (groups: string[]) => ({
    data: { role: "OPERATOR", isAccountAdmin: false, groups, version: 1, mode: "shadow" },
  });
  /** One QueryClient for the whole render (the shared `wrapper` builds a new one per render). */
  const render = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const w = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return renderHook(() => useCounterSaleGate(), { wrapper: w });
  };
  const permissionCalls = () =>
    get.mock.calls.filter((c) => c[0] === "/users/me/permissions").length;
  beforeEach(() => {
    get.mockReset();
    features = ALWAYS;
  });
  afterEach(() => {
    features = { data: undefined };
    authUser = null;
  });

  it("OPERATOR without ORDERS: no button, no open-as-counter, mayUseTill false, the capability and old keys intact", async () => {
    authUser = { role: "OPERATOR" };
    get.mockResolvedValue(perms(["PRICING", "FINANCE"]));
    const { result } = render();
    await waitFor(() => expect(result.current.mayUseTill).toBe(false));
    expect(result.current).toMatchObject({
      showButton: false,
      opensAsCounter: false,
      mayUseTill: false,
      loading: false,
      capability: { counter: "always" },
    });
    expect(result.current).toHaveProperty("offerShipInstead");
    expect(result.current).toHaveProperty("offerInvoiceOrder");
    expect(result.current).toHaveProperty("failed");
    expect(result.current).toHaveProperty("retry");
  });

  it("OPERATOR with ORDERS held: unchanged, mayUseTill true", async () => {
    authUser = { role: "OPERATOR" };
    get.mockResolvedValue(perms(ALL));
    const { result } = render();
    await waitFor(() => expect(permissionCalls()).toBe(1));
    await waitFor(() => expect(result.current.showButton).toBe(true));
    expect(result.current).toMatchObject({ opensAsCounter: true, mayUseTill: true });
  });

  it.each(["TENANT_ADMIN", "SUPER_ADMIN"])("%s: no permissions fetch at all", async (role) => {
    authUser = { role };
    const { result } = render();
    expect(result.current).toMatchObject({ showButton: true, mayUseTill: true });
    expect(permissionCalls()).toBe(0);
  });

  it("while the operator's permissions load: loading is true and nothing is offered", () => {
    authUser = { role: "OPERATOR" };
    get.mockReturnValue(new Promise(() => {}));
    const { result } = render();
    expect(result.current).toMatchObject({
      loading: true,
      showButton: false,
      opensAsCounter: false,
    });
  });

  it("the permissions request failed: the server stays the authority (mayUseTill true, entry offered)", async () => {
    authUser = { role: "OPERATOR" };
    get.mockRejectedValue(new Error("network"));
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ mayUseTill: true, showButton: true });
  });

  it("a gate that is disabled never fetches permissions", () => {
    authUser = { role: "OPERATOR" };
    const client = new QueryClient();
    const w = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useCounterSaleGate({ enabled: false }), { wrapper: w });
    expect(permissionCalls()).toBe(0);
    expect(result.current.showButton).toBe(false);
  });
});
