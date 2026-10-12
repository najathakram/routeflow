import { buildOrdersService, customerPayload } from "./testing/orders-service-harness";

/**
 * B297 row 357 (SA-734r2 r-note 5): a product that sits on SEVERAL lines of one buyer edit meets a QTY_BREAK on its
 * COMBINED quantity, and every line of it then bills the break price. Two 6-piece lines meet a 12-piece break that
 * neither meets alone; the price promotion is resolved once on the group, so both lines carry the same net unit
 * price (no line is left at list). Driven through the real `updateOrderItems` buyer replace-all path; the pure
 * helpers are pinned in packages/pricing `product-promotion-qty.spec.ts`.
 */
const MOCK_ORDER = {
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-1",
  status: "DRAFT" as const,
  source: "APP" as const,
  urgent: false,
  subtotal: 0,
  tax: 0,
  total: 0,
  notes: null,
  driverNote: null,
  routeRunId: null,
  routeRunStopId: null,
  deliveredAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  customer: { businessName: "Acme Wholesale" },
};

const PRODUCT = { id: "prod-A", pricePerUnit: 10, unitsPerBox: null, trackedCategoryId: null };
/** 10% off from 12 pieces: a 6-piece line alone never meets it. */
const QTY_BREAK_12 = {
  id: "promo-qb",
  type: "QTY_BREAK" as const,
  value: 10,
  minQty: 12,
  scope: "ALL" as const,
  category: null as string | null,
  productIds: [] as string[],
};

const stored = (id: string, qty: number) => ({
  id,
  orderId: "ord-1",
  productId: "prod-A",
  qty,
  unitPrice: 10,
  subtotal: qty * 10,
  status: "PENDING",
  boxes: null,
  pieces: null,
  trackedCategoryId: null,
  createdAt: new Date("2026-10-01T10:00:00Z"),
  position: 0,
});

describe("OrdersService.updateOrderItems: a split product meets a QTY_BREAK on its combined quantity (row 357)", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 0, status: "PENDING" }]);
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
    h.prisma.product.findMany.mockResolvedValue([PRODUCT]);
    h.prisma.trackedCategory.findMany.mockResolvedValue([]);
  });

  const created = () =>
    h.prisma.orderItem.create.mock.calls
      .map((c: any) => c[0].data)
      .filter((d: any) => d.productId === "prod-A");

  async function edit(lines: Array<{ id: string; qty: number }>) {
    h.prisma.order.findUnique.mockResolvedValue({
      ...MOCK_ORDER,
      lineItems: lines.map((l) => stored(l.id, l.qty)),
    });
    ((h.service as any).promotionsService.activeForCatalog as jest.Mock).mockResolvedValue([
      QTY_BREAK_12,
    ]);
    await h.service.updateOrderItems(
      "ord-1",
      {
        items: lines.map((l) => ({ productId: "prod-A", qty: l.qty, sourceLineId: l.id })),
      } as never,
      { ...customerPayload, sub: "user-cust" } as never,
    );
  }

  it("6 + 6 pieces: BOTH lines bill the break price (9.00 off 10.00), not list", async () => {
    await edit([
      { id: "li-1", qty: 6 },
      { id: "li-2", qty: 6 },
    ]);
    const rows = created();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.unitPrice).toBe(9);
      expect(r.originalPrice).toBe(10);
      expect(r.priceType).toBe("PROMO");
      expect(r.subtotal).toBe(54); // 6 x 9
    }
  });

  it("control: 6 pieces on ONE line does not meet the break and bills list", async () => {
    await edit([{ id: "li-1", qty: 6 }]);
    const rows = created();
    expect(rows).toHaveLength(1);
    expect(rows[0].unitPrice).toBe(10);
    expect(rows[0].priceType).not.toBe("PROMO");
  });

  it("5 + 6 = 11 pieces is still under the break: neither line is discounted", async () => {
    await edit([
      { id: "li-1", qty: 5 },
      { id: "li-2", qty: 6 },
    ]);
    for (const r of created()) expect(r.unitPrice).toBe(10);
  });
});
