import { rebuildDraftsAfterUndo } from "./undo-draft-rebuild";

/**
 * SA-1098 Undo gap: which orders `rebuildDraftsAfterUndo` rebuilds, in what order, and on which basis. The behaviour on real rows is
 * D-44 and UG-1..UG-5 in routes/driver-stops-web.db.spec.ts.
 */
describe("rebuildDraftsAfterUndo", () => {
  const setup = (
    opts: { drafts?: Record<string, unknown>; mutations?: number; delivered?: number } = {},
  ) => {
    const deps = {
      findOpenOrderDraft: jest.fn(async (id: string) => opts.drafts?.[id] ?? null),
      reconcileOrderDeliveredInvoices: jest.fn().mockResolvedValue(null),
    };
    const tx = {
      deliveryMutation: { count: jest.fn().mockResolvedValue(opts.mutations ?? 0) },
      orderItem: { count: jest.fn().mockResolvedValue(opts.delivered ?? 0) },
    };
    return { deps, tx };
  };

  it("an order with no open draft (an issued invoice, or none) is not rebuilt and its evidence is not even counted", async () => {
    const { deps, tx } = setup();
    await rebuildDraftsAfterUndo(deps, tx, [{ orderId: "o1" }]);
    expect(deps.reconcileOrderDeliveredInvoices).not.toHaveBeenCalled();
    expect(tx.deliveryMutation.count).not.toHaveBeenCalled();
  });

  it("no evidence left anywhere: the order basis (onOrder = true)", async () => {
    const { deps, tx } = setup({ drafts: { o1: { id: "d1" } } });
    await rebuildDraftsAfterUndo(deps, tx, [{ orderId: "o1" }]);
    expect(deps.reconcileOrderDeliveredInvoices).toHaveBeenCalledWith("o1", tx, true);
  });

  it.each([
    ["a delivery row of another stop", { mutations: 1 }],
    ["a line with a delivered quantity", { delivered: 3 }],
  ])("%s is left: the delivered basis (onOrder = false)", async (_n, left) => {
    const { deps, tx } = setup({ drafts: { o1: { id: "d1" } }, ...left });
    await rebuildDraftsAfterUndo(deps, tx, [{ orderId: "o1" }]);
    expect(deps.reconcileOrderDeliveredInvoices).toHaveBeenCalledWith("o1", tx, false);
  });

  it("each order once, in id order, whatever the order of the deleted rows", async () => {
    const { deps, tx } = setup({ drafts: { a: { id: "da" }, b: { id: "db" }, c: { id: "dc" } } });
    await rebuildDraftsAfterUndo(deps, tx, [
      { orderId: "c" },
      { orderId: "a" },
      { orderId: "c" },
      { orderId: "b" },
    ]);
    expect(deps.reconcileOrderDeliveredInvoices.mock.calls.map((c) => c[0])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
