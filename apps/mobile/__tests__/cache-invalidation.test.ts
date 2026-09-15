/**
 * Lane caches — the client half of the mobile-scan hunt's staleness findings:
 * credit-note-cache-not-invalidated-after-apply, order-item-edit-leaves-
 * invoice-cache-stale, no-realtime-product-cache-invalidation
 * (`.claude/pipeline/2026-09-14-hunt-mobile-scan/design/server-side.json`).
 *
 * Each `describe` isolates its own module graph with `jest.resetModules()` +
 * per-test `jest.doMock()`, because the three files under test want mutually
 * incompatible "react-native" shapes in the SAME jest file: `orders.ts`
 * imports nothing from it, `useSocket.ts` wants `Platform.OS === "web"` (the
 * localStorage code path), and `query-client.ts` wants a real `AppState` with
 * a NON-"web" platform to exercise the focusManager wiring. This mirrors the
 * `jest.doMock` + fresh `require()` idiom already used by
 * `secure-key.test.ts`'s buyer-session-store boot-gate tests.
 *
 * (a)+(b) run the REAL `onSuccess` handler `useMutation` was configured with
 * against a fake QueryClient and assert exactly which keys were invalidated —
 * pure logic, no renderer. (c) runs the REAL socket event handler `useSocket`
 * registered. (d) runs the REAL AppState→focusManager wiring from
 * `query-client.ts`.
 */

beforeEach(() => {
  jest.resetModules();
});

// ─── (a)+(b) apps/mobile/lib/api/orders.ts ─────────────────────────────────

describe("orders.ts — useUpdateOrderItems / useCreateOrderAsDriver cache invalidation", () => {
  function loadOrdersWithCapturedMutations() {
    const invalidateQueries = jest.fn();
    const configs: Record<string, any> = {};
    let callIndex = 0;
    // useMutation is called once per hook invocation, in the order the hook
    // functions below call it — capture each config as it's built.
    const order = ["current"];
    jest.doMock("@tanstack/react-query", () => ({
      useMutation: (config: any) => {
        configs[order[callIndex] ?? `call-${callIndex}`] = config;
        callIndex += 1;
        return {};
      },
      useQuery: () => ({}),
      useQueryClient: () => ({ invalidateQueries }),
    }));
    jest.doMock("../lib/api-client", () => ({
      apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module under the mock, isolated per test
    const orders = require("../lib/api/orders");
    return {
      orders,
      invalidateQueries,
      captureNext: (label: string) => {
        order[callIndex] = label;
      },
      configFor: (label: string) => configs[label],
    };
  }

  function invalidatedKeys(invalidateQueries: jest.Mock): unknown[] {
    return invalidateQueries.mock.calls.map((c) => c[0].queryKey);
  }

  it("REG-CACHE-1: useUpdateOrderItems invalidates orders + admin/orders (existing) AND credit-notes + invoices + admin/invoices (new)", () => {
    const { orders, invalidateQueries, captureNext, configFor } = loadOrdersWithCapturedMutations();
    captureNext("update-items");
    orders.useUpdateOrderItems();
    const config = configFor("update-items");
    expect(config).toBeTruthy();

    config.onSuccess();

    const keys = invalidatedKeys(invalidateQueries);
    expect(keys).toEqual(
      expect.arrayContaining([
        ["orders"],
        ["admin", "orders"],
        ["credit-notes"],
        ["invoices"],
        ["admin", "invoices"],
      ]),
    );
    // Exactly these five — no accidental extra invalidation.
    expect(keys).toHaveLength(5);
  });

  it("REG-CACHE-2: useCreateOrderAsDriver invalidates the same money families as useUpdateOrderItems, plus route-runs when routeRunId is present", () => {
    const { orders, invalidateQueries, captureNext, configFor } = loadOrdersWithCapturedMutations();
    captureNext("create-as-driver");
    orders.useCreateOrderAsDriver();
    const config = configFor("create-as-driver");
    expect(config).toBeTruthy();

    config.onSuccess({}, { routeRunId: "run-1" });

    const keys = invalidatedKeys(invalidateQueries);
    expect(keys).toEqual(
      expect.arrayContaining([
        ["route-runs", "run-1"],
        ["orders"],
        ["admin", "orders"],
        ["credit-notes"],
        ["invoices"],
        ["admin", "invoices"],
      ]),
    );
  });

  it("REG-CACHE-2b: useCreateOrderAsDriver still invalidates credit-notes/invoices even with no routeRunId (a plain create, no route attach)", () => {
    const { orders, invalidateQueries, captureNext, configFor } = loadOrdersWithCapturedMutations();
    captureNext("create-as-driver-no-run");
    orders.useCreateOrderAsDriver();
    const config = configFor("create-as-driver-no-run");

    config.onSuccess({}, {});

    const keys = invalidatedKeys(invalidateQueries);
    expect(keys).toEqual(
      expect.arrayContaining([["credit-notes"], ["invoices"], ["admin", "invoices"]]),
    );
    expect(keys).not.toEqual(expect.arrayContaining([["route-runs", undefined]]));
  });

  it("REG-CACHE-3: a mutation the design does NOT touch (useCancelOrder) still invalidates only order caches — no scope creep onto credit-notes/invoices", () => {
    const { orders, invalidateQueries, captureNext, configFor } = loadOrdersWithCapturedMutations();
    captureNext("cancel-order");
    orders.useCancelOrder();
    const config = configFor("cancel-order");

    config.onSuccess();

    const keys = invalidatedKeys(invalidateQueries);
    expect(keys).toEqual([["orders"], ["admin", "orders"]]);
  });
});

// ─── (c) apps/mobile/hooks/useSocket.ts ────────────────────────────────────

describe("useSocket — product.updated handler + invoice.updated buyer-family fix", () => {
  function setupSocketMocks() {
    const socketHandlers: Record<string, (...args: unknown[]) => void> = {};
    const mockSocketOn = jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      socketHandlers[event] = cb;
    });
    const mockIo = jest.fn(() => ({ on: mockSocketOn, disconnect: jest.fn(), id: "sock-1" }));
    jest.doMock("socket.io-client", () => ({ io: mockIo }));
    jest.doMock("react-native", () => ({ Platform: { OS: "web" } }));

    const invalidateQueries = jest.fn();
    jest.doMock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries }) }));

    jest.doMock("../lib/auth-store", () => ({
      useAuthStore: () => ({ user: { role: "OPERATOR", id: "user-1" } }),
    }));

    // Run useEffect synchronously — same idiom as socket-wiring.test.ts.
    jest.doMock("react", () => {
      const actual = jest.requireActual("react") as Record<string, unknown>;
      return { ...actual, useEffect: (fn: () => unknown) => fn() };
    });

    (global as Record<string, unknown>).localStorage = {
      getItem: () => "fake-token",
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    (global as Record<string, unknown>).window = global;

    return { socketHandlers, invalidateQueries };
  }

  function invalidatedKeys(invalidateQueries: jest.Mock): unknown[] {
    return invalidateQueries.mock.calls.map((c) => c[0].queryKey);
  }

  it('REG-CACHE-4: registers a "product.updated" handler that invalidates ["products"] and ["admin","products"]', async () => {
    const { socketHandlers, invalidateQueries } = setupSocketMocks();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module under the mock, isolated per test
    const { useSocket } = require("../hooks/useSocket");
    useSocket();
    await Promise.resolve();
    await Promise.resolve();

    expect(socketHandlers["product.updated"]).toBeInstanceOf(Function);
    socketHandlers["product.updated"]();

    const keys = invalidatedKeys(invalidateQueries);
    expect(keys).toEqual(expect.arrayContaining([["products"], ["admin", "products"]]));
    // Never the single-id shape — every list key's 2nd element is a params object.
    expect(keys).not.toEqual(expect.arrayContaining([["products", expect.any(String)]]));
  });

  it('REG-CACHE-5: "invoice.updated" now ALSO invalidates the buyer family ["invoices"] alongside ["admin","invoices"]', async () => {
    const { socketHandlers, invalidateQueries } = setupSocketMocks();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module under the mock, isolated per test
    const { useSocket } = require("../hooks/useSocket");
    useSocket();
    await Promise.resolve();
    await Promise.resolve();

    expect(socketHandlers["invoice.updated"]).toBeInstanceOf(Function);
    socketHandlers["invoice.updated"]();

    const keys = invalidatedKeys(invalidateQueries);
    expect(keys).toEqual(expect.arrayContaining([["invoices"], ["admin", "invoices"]]));
  });
});

// ─── (d) apps/mobile/lib/query-client.ts ───────────────────────────────────

describe("query-client.ts — AppState wired into TanStack's focusManager", () => {
  function setupAppStateMock(platformOS: string) {
    const listeners: Record<string, (status: string) => void> = {};
    const addEventListener = jest.fn((type: string, cb: (status: string) => void) => {
      listeners[type] = cb;
      return { remove: jest.fn() };
    });
    jest.doMock("react-native", () => ({
      AppState: { addEventListener },
      Platform: { OS: platformOS },
    }));
    // The useSocket describe block above leaves a `jest.doMock` on
    // "@tanstack/react-query" registered (doMock factories persist across
    // tests in the same file — `jest.resetModules()` only clears the
    // required-module cache, not the factory registration). Force the REAL
    // package back so `QueryClient`/`focusManager` are the genuine exports.
    jest.doMock("@tanstack/react-query", () => jest.requireActual("@tanstack/react-query"));
    return { listeners, addEventListener };
  }

  it("REG-CACHE-6: registers a single AppState 'change' listener on module load", () => {
    const { addEventListener } = setupAppStateMock("ios");
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module under the mock, isolated per test
    require("../lib/query-client");
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it('REG-CACHE-7: returning to "active" focuses TanStack\'s focusManager; backgrounding un-focuses it', () => {
    const { listeners } = setupAppStateMock("android");
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module under the mock, isolated per test
    const { focusManager } = require("@tanstack/react-query");
    const setFocusedSpy = jest.spyOn(focusManager, "setFocused");

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module under the mock, isolated per test
    require("../lib/query-client");
    const onChange = listeners["change"];
    expect(onChange).toBeInstanceOf(Function);

    onChange("background");
    expect(setFocusedSpy).toHaveBeenLastCalledWith(false);

    onChange("active");
    expect(setFocusedSpy).toHaveBeenLastCalledWith(true);

    setFocusedSpy.mockRestore();
  });

  it('REG-CACHE-8: on Platform.OS === "web" the native wiring is a no-op (web keeps its own visibilitychange listener)', () => {
    const { listeners } = setupAppStateMock("web");
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module under the mock, isolated per test
    const { focusManager } = require("@tanstack/react-query");
    const setFocusedSpy = jest.spyOn(focusManager, "setFocused");

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module under the mock, isolated per test
    require("../lib/query-client");
    listeners["change"]?.("active");

    expect(setFocusedSpy).not.toHaveBeenCalled();
    setFocusedSpy.mockRestore();
  });

  it("REG-CACHE-9: a react-native test double lacking AppState (mirrors session-teardown.test.ts's mock) never crashes the import", () => {
    jest.doMock("react-native", () => ({ Platform: { OS: "ios" } })); // no AppState key at all
    jest.doMock("@tanstack/react-query", () => jest.requireActual("@tanstack/react-query"));
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module under the mock, isolated per test
    expect(() => require("../lib/query-client")).not.toThrow();
  });
});
