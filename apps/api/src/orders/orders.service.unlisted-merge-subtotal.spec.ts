// Same inline-lock harness as orders.service.b297-merge.spec.ts: these specs exercise the merge
// FOLD's stored subtotal, not the lock.
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
 * SA-982 §3a (row 139) — an unlisted (catalog-free, `productId: null`) loser line is appended to
 * the merge winner as a fresh line whose stored subtotal is per-piece price x qty, cent-rounded
 * (qty is Decimal(10,3), so fractional). Both merge paths write it; this pins the stored value
 * for SA's five qty/price pairs so the write can route through `computeLineSubtotal` without a
 * cent moving.
 */
const PAIRS: ReadonlyArray<readonly [number, number, number]> = [
  [1.5, 3.33, 5],
  [2.125, 7.99, 16.98],
  [3, 0.335, 1.01],
  [0.001, 19.995, 0.02],
  [7, 1.005, 7.04],
];

const customLine = (id: string, qty: number, unitPrice: number) => ({
  id,
  productId: null,
  name: "Delivery fee",
  qty,
  unitPrice,
  subtotal: 0,
  status: "PENDING",
  priceType: "STANDARD",
  originalPrice: null,
  overrideReason: null,
  overriddenBy: null,
  notes: null,
  boxes: null,
  pieces: null,
});

describe("OrdersService merges — unlisted loser line stores qty x unitPrice, cent-rounded (SA-982 §3a)", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.product.findMany.mockResolvedValue([]);
    h.prisma.order.findMany.mockResolvedValue([
      { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [] },
      {
        id: "l1",
        customerId: "cust-1",
        status: "PENDING",
        lineItems: PAIRS.map(([qty, price], i) => customLine(`ll${i}`, qty, price)),
      },
    ]);
  });

  const storedSubtotals = () =>
    h.prisma.orderItem.create.mock.calls
      .map((c: any) => c[0].data)
      .filter((d: any) => d.productId === null)
      .map((d: any) => d.subtotal);

  const expected = PAIRS.map(([, , subtotal]) => subtotal);

  it("mergeAllPendingForCustomer", async () => {
    h.prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 5, trackedCategoryId: null }]);
    await h.service.mergeAllPendingForCustomer("cust-1");
    expect(storedSubtotals()).toEqual(expected);
  });

  it("forceConsolidateCustomer", async () => {
    h.prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 5, status: "PENDING" }]);
    await h.service.forceConsolidateCustomer("cust-1");
    expect(storedSubtotals()).toEqual(expected);
  });
});
