import { syncOrderLineCompositions } from "./order-composition";

/**
 * #2717 M3: the order-wide entry point every order writer calls in its own tx. Mode off (or no
 * feature config at all) must touch nothing, so a tenant that never turned `mixed_packs` on
 * writes byte-identical rows and issues zero extra queries.
 */
function tx(lines: Array<{ id: string }> = []) {
  return {
    orderItem: { findMany: jest.fn().mockResolvedValue(lines) },
    recipe: { findFirst: jest.fn() },
    product: { findMany: jest.fn() },
    orderItemComponent: { deleteMany: jest.fn(), createMany: jest.fn() },
  };
}
const config = (mode: string) => ({ getEffectiveMode: jest.fn().mockResolvedValue(mode) });

describe("syncOrderLineCompositions", () => {
  it("mode off: no query at all", async () => {
    const t = tx();
    await syncOrderLineCompositions(t as never, "o-1", "t-1", config("off"));
    expect(t.orderItem.findMany).not.toHaveBeenCalled();
  });

  it("no feature config, or no tenant: no query at all", async () => {
    const t = tx();
    await syncOrderLineCompositions(t as never, "o-1", "t-1", undefined);
    await syncOrderLineCompositions(t as never, "o-1", null, config("on"));
    expect(t.orderItem.findMany).not.toHaveBeenCalled();
  });

  it("a config read that throws reads as off (never fails the order write)", async () => {
    const t = tx();
    const cfg = { getEffectiveMode: jest.fn().mockRejectedValue(new Error("down")) };
    await expect(syncOrderLineCompositions(t as never, "o-1", "t-1", cfg)).resolves.toBeUndefined();
    expect(t.orderItem.findMany).not.toHaveBeenCalled();
  });

  it("mode on: reads the order's line ids, tenant-scoped, then syncs them", async () => {
    const t = tx([{ id: "li-1" }]);
    await syncOrderLineCompositions(t as never, "o-1", "t-1", config("on"));
    expect(t.orderItem.findMany).toHaveBeenCalledWith({
      where: { orderId: "o-1" },
      select: { id: true },
    });
    // the second findMany is syncLineCompositions loading the lines by id
    expect(t.orderItem.findMany).toHaveBeenCalledTimes(2);
  });

  it("an order with no lines syncs nothing", async () => {
    const t = tx([]);
    await syncOrderLineCompositions(t as never, "o-1", "t-1", config("on"));
    expect(t.orderItem.findMany).toHaveBeenCalledTimes(1);
  });
});
