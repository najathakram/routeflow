/**
 * BO-04 (seam S4): the Feature Console writers of `fulfilment_model` (`set()` PUT, `clear()` DELETE) share the
 * carrier-in-transit rule with Settings and the profile apply. A change that moves the billing moment (into or out
 * of the shipping modes) while a carrier order is shipped and not delivered is a 409
 * FULFILMENT_CARRIER_IN_TRANSIT, checked INSIDE the fulfilment lock and BEFORE the row is written or audited.
 * `from` is the STORED row (read from the DB), never the cache.
 */
import "reflect-metadata";
import { lockState, resetLockState } from "../settings-fulfilment/testing/lock-mock";
import { createWorld, TENANT_ID } from "../settings-fulfilment/testing/fulfilment-world";

jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.requireActual("../settings-fulfilment/testing/lock-mock")
    .fakeWithAdvisoryLock,
}));

beforeEach(() => resetLockState());

const shipped = (n = 1) =>
  Array.from({ length: n }, () => ({
    tenantId: TENANT_ID,
    fulfillPath: "SHIP" as const,
    status: "CONFIRMED",
    shippedAt: new Date("2026-10-10T10:00:00.000Z"),
  }));

async function rejection(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return { status: (e as any).getStatus?.(), ...((e as any).getResponse?.() ?? {}) };
  }
  throw new Error("expected a rejection");
}

describe("FeatureConfigService.set(fulfilment_model) with a carrier order in transit", () => {
  it("ship -> delivery with one in transit: 409, no row written, no audit", async () => {
    const w = createWorld({
      fleet: true,
      rows: [{ featureKey: "fulfilment_model", mode: "ship" }],
      orders: shipped(1),
    });
    const err = await rejection(
      w.featureConfig.set(TENANT_ID, "fulfilment_model", "delivery", "console", "sa-1"),
    );
    expect(err).toMatchObject({ status: 409, code: "FULFILMENT_CARRIER_IN_TRANSIT", count: 1 });
    expect(w.prisma.tenantFeatureConfig.upsert).not.toHaveBeenCalled();
    expect(w.audit.log).not.toHaveBeenCalled();
    expect(w.row("fulfilment_model")!.mode).toBe("ship");
  });

  it("unset (no row) -> ship with one in transit: 409 too (the fallback mode is the `from`)", async () => {
    const w = createWorld({ fleet: true, orders: shipped(2) });
    const err = await rejection(
      w.featureConfig.set(TENANT_ID, "fulfilment_model", "ship", "console", "sa-1"),
    );
    expect(err).toMatchObject({ status: 409, code: "FULFILMENT_CARRIER_IN_TRANSIT", count: 2 });
    expect(w.rowCount()).toBe(0);
  });

  it("the check runs INSIDE the fulfilment lock, before any write", async () => {
    const w = createWorld({
      fleet: true,
      rows: [{ featureKey: "fulfilment_model", mode: "ship" }],
      orders: shipped(1),
    });
    w.prisma.order.count.mockImplementationOnce(async () => {
      expect(lockState.held.has(`fulfilment-settings:${TENANT_ID}`)).toBe(true);
      return 1;
    });
    await rejection(w.featureConfig.set(TENANT_ID, "fulfilment_model", "delivery", "c", "sa-1"));
    expect.assertions(1);
  });

  it("`from` is the stored row in the DB: the lookup is scoped to this tenant and key", async () => {
    const w = createWorld({
      fleet: true,
      rows: [{ featureKey: "fulfilment_model", mode: "ship" }],
      orders: shipped(1),
    });
    await rejection(w.featureConfig.set(TENANT_ID, "fulfilment_model", "delivery", "c", "sa-1"));
    expect(w.prisma.tenantFeatureConfig.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_featureKey: { tenantId: TENANT_ID, featureKey: "fulfilment_model" } },
      }),
    );
  });

  it.each([
    ["ship", "both"],
    ["ship", "pickup_ship"],
    ["delivery", "pickup"],
  ])(
    "a same-side move (%s -> %s) never counts: it is written even with one in transit",
    async (from, to) => {
      const w = createWorld({
        fleet: true,
        rows: [{ featureKey: "fulfilment_model", mode: from }],
        orders: shipped(1),
      });
      await w.featureConfig.set(TENANT_ID, "fulfilment_model", to, "console", "sa-1");
      expect(w.row("fulfilment_model")!.mode).toBe(to);
      expect(w.prisma.order.count).not.toHaveBeenCalled();
    },
  );

  it("orders that are delivered, or not yet shipped, do not block", async () => {
    const w = createWorld({
      fleet: true,
      rows: [{ featureKey: "fulfilment_model", mode: "ship" }],
      orders: [
        { ...shipped(1)[0], status: "DELIVERED" },
        { ...shipped(1)[0], shippedAt: null },
        { ...shipped(1)[0], tenantId: "tenant-globex" },
      ],
    });
    await w.featureConfig.set(TENANT_ID, "fulfilment_model", "delivery", "console", "sa-1");
    expect(w.row("fulfilment_model")!.mode).toBe("delivery");
  });

  it("counter_sales never counts, in transit or not", async () => {
    const w = createWorld({ fleet: true, orders: shipped(3) });
    await w.featureConfig.set(TENANT_ID, "counter_sales", "on", "console", "sa-1");
    await w.featureConfig.clear(TENANT_ID, "counter_sales", "console", "sa-1");
    expect(w.prisma.order.count).not.toHaveBeenCalled();
  });
});

describe("FeatureConfigService.clear(fulfilment_model) with a carrier order in transit", () => {
  it("clearing a stored ship (-> unset) with one in transit: 409, the row stays, no audit", async () => {
    const w = createWorld({
      fleet: true,
      rows: [{ featureKey: "fulfilment_model", mode: "ship" }],
      orders: shipped(1),
    });
    const err = await rejection(w.featureConfig.clear(TENANT_ID, "fulfilment_model", "c", "sa-1"));
    expect(err).toMatchObject({ status: 409, code: "FULFILMENT_CARRIER_IN_TRANSIT", count: 1 });
    expect(w.prisma.tenantFeatureConfig.deleteMany).not.toHaveBeenCalled();
    expect(w.audit.log).not.toHaveBeenCalled();
    expect(w.row("fulfilment_model")!.mode).toBe("ship");
  });

  it("clearing a stored delivery (-> unset) is the same side: it clears", async () => {
    const w = createWorld({
      fleet: true,
      rows: [{ featureKey: "fulfilment_model", mode: "delivery" }],
      orders: shipped(1),
    });
    await w.featureConfig.clear(TENANT_ID, "fulfilment_model", "c", "sa-1");
    expect(w.row("fulfilment_model")).toBeUndefined();
  });

  it("clearing with no stored row is a no-op that never counts", async () => {
    const w = createWorld({ fleet: true, orders: shipped(1) });
    await w.featureConfig.clear(TENANT_ID, "fulfilment_model", "c", "sa-1");
    expect(w.prisma.order.count).not.toHaveBeenCalled();
  });
});
