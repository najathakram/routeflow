// The harness FIRST: it jest.mock()s modules that orders.service also imports.
import { buildOversellOrders, buyer, operator, stockTx, TENANT } from "./testing/oversell-harness";
import { readEditedOrder } from "./order-edit-cancelled";
import { readFileSync } from "fs";
import { join } from "path";
import { stockWriteOf } from "./order-stock";

/**
 * SA-606m (4) / SA-606o Q-C: OrdersService.create and updateOrderItems RETURN the locked write's
 * figure (typed carrier on the returned order, never serialized). Only the BUYER controller maps it
 * onto the wire; a staff response must not carry `backorderPieces`. The reads the response is built
 * from are deterministic and carry the pack the decrement's converter falls back on.
 */
const PRODUCT = {
  id: "prod-1",
  name: "Widget",
  unit: "ea",
  pricePerUnit: 10,
  unitsPerBox: null,
  category: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  isActive: true,
  // the buyer gate (#2856) judges these: a fixture that omits them is correctly hidden
  kind: "STANDARD",
  portalVisible: true,
  parent: null,
};
type H = Awaited<ReturnType<typeof buildOversellOrders>>;
const write = (n: number) => ({ backorderByProduct: new Map([["prod-1", n]]) });

function arrangeCreate(h: H) {
  const { prisma } = h;
  prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
  prisma.customer.findUnique.mockResolvedValue({
    id: "cust-1",
    pricingTier: 1,
    user: { status: "ACTIVE" },
    deletedAt: null,
  });
  prisma.product.findMany.mockResolvedValue([PRODUCT]);
  prisma.order.create.mockImplementation(async () => ({
    id: "ord-new",
    customerId: "cust-1",
    orderNumber: "x",
    total: 0,
    urgent: false,
    createdAt: new Date(),
    customer: { id: "cust-1", businessName: "Acme" },
    lineItems: [{ id: "li-1", productId: "prod-1", qty: 8 }],
  }));
  const t = stockTx(prisma as never, { v: 5 });
  (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(t.tx));
}
const dto = (extra: object = {}) => ({
  customerId: "cust-1",
  items: [{ productId: "prod-1", qty: 8 }],
  ...extra,
});

describe("create() returns the locked write", () => {
  it.each([
    ["buyer", buyer],
    ["operator", operator],
  ])(
    "%s: the returned order carries the decrement's result, nothing on the wire",
    async (_n, u) => {
      const h = await buildOversellOrders("backorder");
      arrangeCreate(h);
      h.decrement.mockResolvedValue(write(3));
      const created: any = await h.service.create(dto() as never, u as never);
      expect(stockWriteOf(created)?.backorderByProduct.get("prod-1")).toBe(3);
      expect(JSON.stringify(created)).not.toMatch(/backorder/i);
      expect(created.lineItems.every((l: any) => !("backorderPieces" in l))).toBe(true);
    },
  );

  it("a DRAFT never decrements, so it carries nothing (unknown, not 0)", async () => {
    const h = await buildOversellOrders("backorder");
    arrangeCreate(h);
    const created = await h.service.create(dto({ status: "DRAFT" }) as never, buyer as never);
    expect(h.decrement).not.toHaveBeenCalled();
    expect(stockWriteOf(created)).toBeUndefined();
  });

  it("the created order's lines carry the product pack the decrement falls back on, in a stable order", async () => {
    const h = await buildOversellOrders("backorder");
    arrangeCreate(h);
    await h.service.create(dto() as never, buyer as never);
    const include = (h.prisma.order.create as jest.Mock).mock.calls[0][0].include.lineItems;
    expect(include.include.product.select.unitsPerBox).toBe(true);
    expect(include.orderBy).toEqual([{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }]);
  });
});

describe("updateOrderItems() returns the locked write", () => {
  const line = {
    id: "li-1",
    orderId: "ord-1",
    productId: "prod-1",
    qty: 2,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitPrice: 5,
    subtotal: 10,
    status: "PENDING",
    priceType: "STANDARD",
    originalPrice: null,
    invoicedQty: 0,
    deliveredQty: 0,
    promoFreeUnits: null,
    unitLabel: null,
    notes: null,
    overrideReason: null,
    position: 0,
  };
  const order = (status: string) => ({
    id: "ord-1",
    tenantId: TENANT,
    customerId: "cust-1",
    status,
    routeRun: null,
    shippingFee: 0,
    lineItems: [line],
  });
  async function arrangeEdit(status: string) {
    const h = await buildOversellOrders("backorder");
    const { prisma } = h;
    prisma.order.findUnique.mockImplementation(async () => order(status));
    prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([{ ...PRODUCT, pricePerUnit: 5 }]);
    prisma.deliveryMutation.count.mockResolvedValue(0);
    prisma.orderItem.findMany.mockResolvedValue([line]);
    return h;
  }
  const body = { items: [{ productId: "prod-1", qty: 5 }], replaceAll: true } as never;

  it("a live edit returns the settle's result on the order, nothing on the wire", async () => {
    const h = await arrangeEdit("PENDING");
    h.settle.mockResolvedValue(write(3));
    const r: any = await h.service.updateOrderItems("ord-1", body, buyer as never);
    expect(stockWriteOf(r)?.backorderByProduct.get("prod-1")).toBe(3);
    expect(JSON.stringify(r)).not.toMatch(/backorder/i);
  });

  it("a DRAFT edit settles nothing and carries nothing", async () => {
    const h = await arrangeEdit("DRAFT");
    const r = await h.service.updateOrderItems("ord-1", body, buyer as never);
    expect(h.settle).not.toHaveBeenCalled();
    expect(stockWriteOf(r)).toBeUndefined();
  });
});

describe("readEditedOrder: the response read is deterministic and carries the pack", () => {
  it("orders lines by createdAt then id and selects the product's pack", async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    await readEditedOrder({ forTenant: () => ({ order: { findUnique } }) } as never, "o-1");
    const lineItems = findUnique.mock.calls[0][0].include.lineItems;
    expect(lineItems.orderBy).toEqual([{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }]);
    expect(lineItems.include.product.select.unitsPerBox).toBe(true);
  });
});

describe("the other response reads the buyer figure is attributed over", () => {
  it("findOne orders lines deterministically (position, createdAt, then id)", async () => {
    const h = await buildOversellOrders("backorder");
    h.prisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      tenantId: TENANT,
      customerId: "cust-1",
      status: "PENDING",
      lineItems: [],
    });
    await h.service.findOne("ord-1", buyer as never).catch(() => undefined);
    const include = (h.prisma.order.findUnique as jest.Mock).mock.calls[0][0].include;
    expect(include.lineItems.orderBy).toEqual([
      { position: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ]);
    expect(include.lineItems.include.product.select.unitsPerBox).toBe(true);
  });

  it("only create() uses RESPONSE_LINE_ITEMS: the two merge-sweep survivor reads keep master's select (SA-631d moved the buyer holder read to findOne, so widening them would be a dead change)", () => {
    const text = readFileSync(join(__dirname, "orders.service.ts"), "utf8");
    expect(text.match(/lineItems: cancelledLines\.RESPONSE_LINE_ITEMS/g)).toHaveLength(1);
    // the sweep survivor reads are the original narrow select again (staff / template responses are unchanged)
    expect(
      text.match(
        /lineItems: \{\s*include: \{ product: \{ select: \{ id: true, name: true, unit: true \} \} \},\s*\},/g,
      ),
    ).toHaveLength(2);
  });
});
