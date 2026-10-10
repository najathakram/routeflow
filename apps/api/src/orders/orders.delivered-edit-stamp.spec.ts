/**
 * SA-763r R6 / M2, red row 6: an edit of a DELIVERED order keeps the delivered quantities, through the real
 * `updateOrderItems`. A stable-id edit raises a no-evidence line's deliveredQty by exactly the edit's own
 * increase; a replace-all edit (new row ids) carries each product's delivered sum onto the recreated rows;
 * a line with route evidence rows is never touched. Before the fix an edit left deliveredQty at its old
 * value (stable) or reset it to 0 (recreated), so the next qty cut returned delivered goods to the shelf.
 */
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

const staff = { ...operatorPayload, tenantId: "t-1" } as never;
const PRODUCT = {
  id: "prod-A",
  name: "Widget",
  unit: "each",
  pricePerUnit: 5,
  unitsPerBox: null,
  currentStock: 100,
  category: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  isActive: true,
};
type Line = Record<string, any>;
const lineA = (over: Line = {}): Line => ({
  id: "li-A",
  orderId: "ord-1",
  productId: "prod-A",
  qty: 10,
  unitPrice: 5,
  subtotal: 50,
  status: "PENDING",
  priceType: "STANDARD",
  boxes: null,
  pieces: null,
  position: 0,
  deliveredQty: 10,
  invoicedQty: 0,
  ...over,
});
const order = (lines: Line[]) => ({
  id: "ord-1",
  tenantId: "t-1",
  customerId: "cust-1",
  orderNumber: "ORD-1",
  status: "DELIVERED",
  fulfillPath: "PICKUP",
  shippedAt: null,
  source: "APP",
  urgent: false,
  subtotal: 50,
  tax: 0,
  total: 50,
  notes: null,
  routeRunId: null,
  routeRunStopId: null,
  customer: { businessName: "Acme" },
  lineItems: lines,
});

describe("SA-763r: an edit of a DELIVERED order keeps the delivered quantities", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  let store: Line[];

  const seed = (lines: Line[], evidence: Array<Record<string, unknown>> = []) => {
    store = lines.map((l) => ({ ...l }));
    const o = order(lines);
    h.prisma.order.findUnique.mockImplementation(async (args: any) => {
      const sel = args?.select ? Object.keys(args.select) : [];
      if (sel.length === 1 && sel[0] === "status") return { status: o.status };
      return o;
    });
    h.prisma.order.findFirst.mockResolvedValue(o);
    h.prisma.orderItem.findMany.mockImplementation(async () => store.map((l) => ({ ...l })));
    h.prisma.orderItem.update.mockImplementation(async ({ where, data }: any) => {
      const l = store.find((x) => x.id === where.id)!;
      Object.assign(
        l,
        Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v !== "object")),
      );
      return { ...l };
    });
    h.prisma.orderItem.deleteMany.mockImplementation(async () => {
      store = [];
      return { count: 1 };
    });
    let n = 0;
    h.prisma.orderItem.create.mockImplementation(async ({ data }: any) => {
      const l = { id: `new-${++n}`, deliveredQty: 0, invoicedQty: 0, position: n, ...data };
      store.push(l);
      return { ...l };
    });
    h.prisma.deliveryMutation.findMany.mockResolvedValue(evidence);
    h.prisma.product.findMany.mockResolvedValue([PRODUCT]);
    h.prisma.product.findUnique.mockResolvedValue(PRODUCT);
  };
  const d = (id: string) => Number(store.find((l) => l.id === id)?.deliveredQty);
  const edit = (items: Line[], replaceAll = false) =>
    h.service.updateOrderItems("ord-1", { items, replaceAll } as never, staff);

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
  });

  it("+2 on a no-row line: deliveredQty rises by exactly 2", async () => {
    seed([lineA()]);
    await edit([{ id: "li-A", productId: "prod-A", qty: 12 }]);
    expect(d("li-A")).toBe(12); // red on base: 10
  });

  it("a legacy unstamped line (d 0) is normalised on its first edit: 10 -> 12 gives d 12, then a cut to 5 restocks 0", async () => {
    seed([lineA({ deliveredQty: 0 })]);
    await edit([{ id: "li-A", productId: "prod-A", qty: 12 }]);
    expect(d("li-A")).toBe(12); // red on base: 0 (then 2 under the old per-edit-increase rule)
    h.prisma.product.update.mockClear();
    await edit([{ id: "li-A", productId: "prod-A", qty: 5 }]);
    expect(d("li-A")).toBe(12);
    expect(h.prisma.product.update).not.toHaveBeenCalled(); // the 12 that left stay booked: nothing restocks
  });

  it("a legacy line (d 0, qty 12) cut to 10 puts NOTHING back on the shelf and ends at d 12", async () => {
    seed([lineA({ qty: 12, deliveredQty: 0 })]);
    await edit([{ id: "li-A", productId: "prod-A", qty: 10 }]);
    expect(h.prisma.product.update).not.toHaveBeenCalled(); // red on base: increment 2, then d set to 12
    expect(d("li-A")).toBe(12);
  });

  it("a route-stop order keeps today's settle: a cut restocks (its columns are never touched)", async () => {
    seed([lineA({ qty: 12, deliveredQty: 0 })]);
    h.prisma.order.findFirst.mockResolvedValue({
      ...order([lineA({ qty: 12, deliveredQty: 0 })]),
      routeRunStopId: "stop-1",
    } as never);
    await edit([{ id: "li-A", productId: "prod-A", qty: 10 }]);
    expect(h.prisma.product.update).toHaveBeenCalledWith({
      where: { id: "prod-A" },
      data: { currentStock: { increment: 2 } },
    });
  });

  it("12, cut to 10, raise to 11: d stays 12 and stock moves 0; raise to 14: d is 14 and stock moves 2", async () => {
    seed([lineA({ qty: 12, deliveredQty: 12 })]);
    await edit([{ id: "li-A", productId: "prod-A", qty: 10 }]);
    await edit([{ id: "li-A", productId: "prod-A", qty: 11 }]);
    expect(d("li-A")).toBe(12); // red under the old rule: 13 (d += the raise of 1)
    expect(h.prisma.product.update).not.toHaveBeenCalled();
    await edit([{ id: "li-A", productId: "prod-A", qty: 14 }]);
    expect(d("li-A")).toBe(14);
    expect(h.prisma.product.update).toHaveBeenCalledWith({
      where: { id: "prod-A" },
      data: { currentStock: { decrement: 2 } },
    });
  });

  it("a cut books nothing (d stays, the goods are gone)", async () => {
    seed([lineA()]);
    await edit([{ id: "li-A", productId: "prod-A", qty: 8 }]);
    expect(d("li-A")).toBe(10);
  });

  it("a route short line (rows) that is edited keeps d exactly", async () => {
    seed(
      [lineA({ deliveredQty: 6 })],
      [{ orderItemId: "li-A", type: "PARTIAL", quantityDelivered: 6 }],
    );
    await edit([{ id: "li-A", productId: "prod-A", qty: 12 }]);
    expect(d("li-A")).toBe(6);
  });

  it("replace-all carries the product's delivered sum onto the recreated row (M2)", async () => {
    seed([lineA()]);
    await edit([{ productId: "prod-A", qty: 12 }], true);
    expect(store).toHaveLength(1);
    expect(store[0].id).not.toBe("li-A"); // recreated
    expect(Number(store[0].deliveredQty)).toBe(12); // red on base: 0
  });

  it("replace-all with a cut keeps the carried 10 (never lowered)", async () => {
    seed([lineA()]);
    await edit([{ productId: "prod-A", qty: 6 }], true);
    expect(Number(store[0].deliveredQty)).toBe(10); // red on base: 0
  });

  it("replace-all of an order with route evidence is REFUSED 409 ORDER_EDIT_NEEDS_LINE_IDS, nothing written", async () => {
    seed(
      [lineA({ deliveredQty: 8 })],
      [{ orderItemId: "li-A", type: "PARTIAL", quantityDelivered: 8 }],
    );
    await expect(edit([{ productId: "prod-A", qty: 12 }], true)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "ORDER_EDIT_NEEDS_LINE_IDS" }),
    }); // red on base: the replace-all went through and orphaned the evidence
    expect(h.prisma.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(h.prisma.orderItem.create).not.toHaveBeenCalled();
    expect(store.map((l) => l.id)).toEqual(["li-A"]);
    expect(d("li-A")).toBe(8);
  });

  it("the same order edited with stable line ids succeeds and the evidence line is untouched", async () => {
    seed(
      [lineA({ deliveredQty: 8 })],
      [{ orderItemId: "li-A", type: "PARTIAL", quantityDelivered: 8 }],
    );
    await edit([{ id: "li-A", productId: "prod-A", qty: 12 }]);
    expect(store.map((l) => l.id)).toEqual(["li-A"]);
    expect(d("li-A")).toBe(8);
  });
});
