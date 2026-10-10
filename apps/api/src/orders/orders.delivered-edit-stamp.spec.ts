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

  it("+2 on a legacy unstamped line (d 0): d is the edit's own increase, 2", async () => {
    seed([lineA({ deliveredQty: 0 })]);
    await edit([{ id: "li-A", productId: "prod-A", qty: 12 }]);
    expect(d("li-A")).toBe(2); // red on base: 0
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

  it("replace-all of a product whose line had route evidence keeps the carried value, not qty", async () => {
    seed(
      [lineA({ deliveredQty: 6 })],
      [{ orderItemId: "li-A", type: "PARTIAL", quantityDelivered: 6 }],
    );
    await edit([{ productId: "prod-A", qty: 12 }], true);
    expect(Number(store[0].deliveredQty)).toBe(6); // red on base: 0
  });
});
