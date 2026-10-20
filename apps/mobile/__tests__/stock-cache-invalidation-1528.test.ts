/**
 * #1528 (B86): a mutation whose SERVER path writes `currentStock` must also invalidate the
 * products + inventory caches, or the Products / Warehouse views stay stale after it. The pattern
 * already shipped on `useReceiveVendorBill`; this pins it on every stock-moving hook and pins the
 * non-stock hooks as NOT touching those roots.
 *
 * Server stock writers: ReturnsService.receive (restock) and .cancel (undoes it);
 * VendorBillsService.voidBill (decrement). Same idiom as cache-invalidation.test.ts: the REAL
 * `onSuccess` each hook configured runs against a fake QueryClient — pure logic, no renderer.
 */

type Keys = unknown[][];

function load(modulePath: string) {
  jest.resetModules();
  const invalidateQueries = jest.fn();
  jest.doMock("@tanstack/react-query", () => ({
    useMutation: (config: any) => config,
    useQuery: () => ({}),
    useQueryClient: () => ({
      invalidateQueries,
      setQueryData: jest.fn(),
      removeQueries: jest.fn(),
    }),
  }));
  jest.doMock("../lib/api-client", () => ({ apiClient: { post: jest.fn(), get: jest.fn() } }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(modulePath);
  const run = async (hook: () => any, variables: unknown): Promise<Keys> => {
    invalidateQueries.mockClear();
    await hook().onSuccess({}, variables, undefined);
    return invalidateQueries.mock.calls.map((c: any[]) => c[0].queryKey);
  };
  return { mod, run };
}

// SA-543a: mobile's operator product lists (useAdminProducts / useAdminProductsInfinite) carry
// currentStock + reorderPoint under ["admin", "products", …], outside the ["products"] root.
const STOCK: Keys = [["products"], ["inventory"], ["admin", "products"]];
const hasAll = (keys: Keys, want: Keys) =>
  want.every((w) => keys.some((k) => JSON.stringify(k) === JSON.stringify(w)));
const hasAny = (keys: Keys, want: Keys) =>
  want.some((w) => keys.some((k) => JSON.stringify(k) === JSON.stringify(w)));

describe("#1528 mobile returns hooks", () => {
  it("useReceiveReturn (bare id and {id, restock}) invalidates products + inventory + admin products", async () => {
    const { mod, run } = load("../lib/api/returns");
    expect(hasAll(await run(mod.useReceiveReturn, "r1"), STOCK)).toBe(true);
    expect(hasAll(await run(mod.useReceiveReturn, { id: "r1", restock: false }), STOCK)).toBe(true);
  });

  it("useCancelReturn invalidates products + inventory + admin products (cancel undoes the receive restock)", async () => {
    const { mod, run } = load("../lib/api/returns");
    expect(hasAll(await run(mod.useCancelReturn, "r1"), STOCK)).toBe(true);
  });

  it.each(["useApproveReturn", "useRejectReturn", "useMarkReturnInTransit"])(
    "%s moves no stock — it never touches products/inventory",
    async (hook) => {
      const { mod, run } = load("../lib/api/returns");
      const keys = await run(mod[hook], "r1");
      expect(keys).toContainEqual(["returns", "r1"]);
      expect(hasAny(keys, STOCK)).toBe(false);
    },
  );
});

describe("#1528 mobile vendor-bill hooks", () => {
  it("useVoidVendorBill invalidates products + inventory + admin products (void decrements stock)", async () => {
    const { mod, run } = load("../lib/api/vendor-bills");
    expect(hasAll(await run(mod.useVoidVendorBill, "vb1"), STOCK)).toBe(true);
  });
});

describe("SA-828 mobile count hook", () => {
  it("useProductCount invalidates products + inventory + admin products (it writes currentStock)", async () => {
    const { mod, run } = load("../lib/api/products");
    expect(hasAll(await run(() => mod.useProductCount("p1"), {}), STOCK)).toBe(true);
  });
});
