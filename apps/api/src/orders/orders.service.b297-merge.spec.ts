// The merge paths run inside a Postgres advisory lock (`common/db-locks.ts`, R3) — these specs
// exercise the merge FOLD's trio-spread, not the lock, so run the critical section inline
// (mirrors orders.service.spec.ts's own mock).
// B1053: fold-math spec — row guard passed through (testing/merge-recheck.ts)
jest.mock("./merge-lock-recheck", () => require("./testing/merge-recheck").pass());
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { buildOrdersService } from "./testing/orders-service-harness";

/**
 * B297 (SA-098a/SA-100 hardening) — `merge-pack-resolve.spec.ts`/`merge-line-writes.ts` prove
 * `buildMergeLineWrites` itself copies a losing line's trio verbatim (`copyCategoryTaxSnapshot`)
 * into the write it plans; they do NOT prove `orders.service.ts`'s
 * `mergeAllPendingForCustomer`/`forceConsolidateCustomer` actually apply that planned write's
 * trio fields into the real `tx.orderItem.create()` call for the new winner line (B776 flattened
 * that call to explicit inline keys — SA-100's trioVia detector is spread-blind — so this pins
 * each key landing correctly, not just the plan that fed it).
 */
const regulatedLine = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  productId: "prod-tob",
  qty: 1,
  unitPrice: 5,
  subtotal: 5,
  status: "PENDING",
  priceType: "STANDARD",
  originalPrice: null,
  name: null,
  overrideReason: null,
  overriddenBy: null,
  boxes: null,
  pieces: null,
  trackedCategoryId: "cat-1",
  categoryTaxType: "EXCISE_PER_UNIT",
  categoryTaxRate: 0.5,
  categoryPriceIncludesTax: false,
  ...extra,
});

const expectTrio = (data: any) =>
  expect(data).toEqual(
    expect.objectContaining({
      trackedCategoryId: "cat-1",
      categoryTaxType: "EXCISE_PER_UNIT",
      categoryTaxRate: 0.5,
      categoryPriceIncludesTax: false,
    }),
  );

describe("OrdersService merges — B297 trio spreads into the new winner line's create() (SA-100)", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.product.findMany.mockResolvedValue([{ id: "prod-tob", unitsPerBox: null }]);
  });

  it("mergeAllPendingForCustomer spreads the losing line's trio into the new winner create()", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [] },
      { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [regulatedLine("ll1")] },
    ]);
    h.prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 5, trackedCategoryId: "cat-1" }]);

    await h.service.mergeAllPendingForCustomer("cust-1");

    const call = h.prisma.orderItem.create.mock.calls.find(
      (c: any) => c[0]?.data?.productId === "prod-tob",
    );
    expect(call).toBeDefined();
    expectTrio(call![0].data);
  });

  it("forceConsolidateCustomer spreads the losing line's trio into the new winner create()", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [] },
      { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [regulatedLine("ll1")] },
    ]);
    h.prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 5, status: "PENDING" }]);

    await h.service.forceConsolidateCustomer("cust-1");

    const call = h.prisma.orderItem.create.mock.calls.find(
      (c: any) => c[0]?.data?.productId === "prod-tob",
    );
    expect(call).toBeDefined();
    expectTrio(call![0].data);
  });
});
