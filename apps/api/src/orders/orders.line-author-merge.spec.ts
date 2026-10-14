// The merge paths run inside a Postgres advisory lock; these specs pin the FOLD's author marker, not the lock,
// so the critical section runs inline (mirrors orders.service.b297-merge.spec.ts).
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
 * SA ruling (#3418): a merge FOLD moves a loser's lines onto the winner. The loser order is deleted, so each moved
 * line carries its OWN author, resolved before it moves: its `authorChannel` marker when set, else the loser's
 * order-level rule (sourceRecorded=false -> STAFF, else its recorded source). A buyer's quantity folded into a
 * winner line stamps it BUYER; a staff fold leaves the winner line's marker alone.
 */
const line = (id: string, productId: string, authorChannel: string | null) => ({
  id,
  productId,
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
  trackedCategoryId: null,
  categoryTaxType: null,
  categoryTaxRate: null,
  categoryPriceIncludesTax: null,
  notes: null,
  authorChannel,
});
const unlisted = (id: string, authorChannel: string | null) => ({
  ...line(id, "", authorChannel),
  productId: null,
  name: "Delivery",
});
const order = (id: string, src: object, lineItems: unknown[]) => ({
  id,
  customerId: "cust-1",
  status: "PENDING",
  ...src,
  lineItems,
});
const RECORDED_APP = { source: "APP", sourceRecorded: true };
const RECORDED_PHONE = { source: "PHONE", sourceRecorded: true };
const LEGACY = { source: "APP", sourceRecorded: false };

describe("OrdersService merges write the folded line's own authorChannel (SA ruling #3418)", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const created = (productId: string | null) =>
    h.prisma.orderItem.create.mock.calls
      .map((c: any) => c[0].data)
      .find((d: any) => d.productId === productId);

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.product.findMany.mockResolvedValue([
      { id: "p-buyer", unitsPerBox: null },
      { id: "p-staff", unitsPerBox: null },
      { id: "p-legacy", unitsPerBox: null },
      { id: "p-null", unitsPerBox: null },
      { id: "p-w", unitsPerBox: null },
    ]);
    h.prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 5, status: "PENDING" }]);
  });

  it.each([
    ["mergeAllPendingForCustomer", (s: any) => s.mergeAllPendingForCustomer("cust-1")],
    ["forceConsolidateCustomer", (s: any) => s.forceConsolidateCustomer("cust-1")],
  ])(
    "%s: a moved line keeps its marker; a NULL one takes its loser's order-level rule",
    async (_n, go) => {
      h.prisma.order.findMany.mockResolvedValue([
        order("w1", RECORDED_PHONE, []),
        order("l1", RECORDED_PHONE, [line("a", "p-buyer", "BUYER"), line("b", "p-null", null)]),
        order("l2", RECORDED_APP, [line("c", "p-staff", "STAFF"), unlisted("u", null)]),
        order("l3", LEGACY, [line("d", "p-legacy", null)]),
      ]);
      await go(h.service);
      expect(created("p-buyer")?.authorChannel).toBe("BUYER"); // a buyer's line on a staff order
      expect(created("p-null")?.authorChannel).toBe("STAFF"); // NULL on a recorded PHONE order
      expect(created("p-staff")?.authorChannel).toBe("STAFF"); // a staff line on a buyer order
      expect(created("p-legacy")?.authorChannel).toBe("STAFF"); // NULL on a legacy order
      expect(created(null)?.authorChannel).toBe("BUYER"); // unlisted NULL on a recorded APP order
    },
  );

  it("a buyer's quantity folded into the winner's line stamps it BUYER; a staff fold writes no marker", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      order("w1", RECORDED_PHONE, [line("w-a", "p-w", "STAFF"), line("w-b", "p-staff", null)]),
      order("l1", RECORDED_APP, [line("a", "p-w", null)]),
      order("l2", RECORDED_PHONE, [line("b", "p-staff", "STAFF")]),
    ]);
    await h.service.mergeAllPendingForCustomer("cust-1");
    const updated = (id: string) =>
      h.prisma.orderItem.update.mock.calls
        .map((c: any) => c[0])
        .find((a: any) => a.where.id === id);
    expect(updated("w-a")?.data.authorChannel).toBe("BUYER");
    expect(updated("w-b")?.data).toBeDefined();
    expect(updated("w-b")?.data).not.toHaveProperty("authorChannel");
  });
});
