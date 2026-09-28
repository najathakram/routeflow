/**
 * #1528 (B86): a mutation whose SERVER path writes `currentStock` must also invalidate the
 * products + inventory caches, or the Products / Inventory views stay stale after it. The pattern
 * already shipped on `useReceiveVendorBill`; this pins it on every stock-moving web hook and pins
 * the non-stock hooks as NOT touching those roots.
 *
 * Server stock writers: ReturnsService.receive (restock) and .cancel (undoes it);
 * VendorBillsService.voidBill and .revertToDraft (decrement). The REAL `onSuccess` each hook
 * configured runs against a fake QueryClient (useMutation is mocked to hand back its config).
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
  jest.doMock("../api-client", () => ({ apiClient: { post: jest.fn(), get: jest.fn() } }));
  const mod = require(modulePath);
  const run = async (hook: () => any, variables: unknown): Promise<Keys> => {
    invalidateQueries.mockClear();
    await hook().onSuccess({}, variables, undefined);
    return invalidateQueries.mock.calls.map((c: any[]) => c[0].queryKey);
  };
  return { mod, run };
}

const STOCK: Keys = [["products"], ["inventory"]];
const hasAll = (keys: Keys, want: Keys) =>
  want.every((w) => keys.some((k) => JSON.stringify(k) === JSON.stringify(w)));
const hasAny = (keys: Keys, want: Keys) =>
  want.some((w) => keys.some((k) => JSON.stringify(k) === JSON.stringify(w)));

describe("#1528 web returns hooks", () => {
  // Each hook's real variables shape: receive takes { id, ... }, cancel takes the bare id.
  it.each([
    ["useMarkReturnReceived", { id: "r1" }],
    ["useCancelReturn", "r1"],
  ] as const)(
    "%s invalidates products + inventory (receive restocks; cancel undoes it)",
    async (hook, variables) => {
      const { mod, run } = load("./returns");
      const keys = await run(mod[hook], variables);
      expect(keys).toContainEqual(["returns", "r1"]);
      expect(hasAll(keys, STOCK)).toBe(true);
    },
  );

  it.each(["useApproveReturn", "useRejectReturn", "useMarkReturnInTransit"])(
    "%s moves no stock — it never touches products/inventory",
    async (hook) => {
      const { mod, run } = load("./returns");
      expect(hasAny(await run(mod[hook], "r1"), STOCK)).toBe(false);
    },
  );
});

describe("#1528 web vendor-bill hooks", () => {
  it.each(["useVoidVendorBill", "useRevertVendorBillToDraft"])(
    "%s invalidates products + inventory (both decrement stock server-side)",
    async (hook) => {
      const { mod, run } = load("./vendor-bills");
      const keys = await run(mod[hook], "vb1");
      expect(keys).toContainEqual(["vendor-bills", "vb1"]);
      expect(hasAll(keys, STOCK)).toBe(true);
    },
  );

  it("control: useReceiveVendorBill already invalidates products + inventory", async () => {
    const { mod, run } = load("./vendor-bills");
    const hook = mod.useReceiveVendorBill;
    // Its variables shape is { id, ... } in the shipped hook.
    expect(hasAll(await run(hook, { id: "vb1" }), STOCK)).toBe(true);
  });
});
