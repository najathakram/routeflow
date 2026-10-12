import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

/**
 * B297 row 373(b), through the REAL updateOrderItems: a staff replace-all re-creates every line, and a line
 * paired with its stored line keeps that line's rate trio and createdAt (a re-created line is not a new sale),
 * where it used to be re-stamped from the product's CURRENT category (SA-098a, superseded).
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
const SOLD_AT = new Date("2026-09-01T09:00:00Z");
const storedLine = {
  id: "li-1",
  orderId: "ord-1",
  productId: "prod-tob",
  qty: 12,
  unitPrice: 7,
  subtotal: 84,
  status: "PENDING",
  boxes: null,
  pieces: null,
  unitLabel: null,
  createdAt: SOLD_AT,
  trackedCategoryId: "cat-1",
  trackedSubcategoryId: null,
  categoryTaxType: "EXCISE_PER_UNIT",
  categoryTaxRate: "0.0500",
  categoryPriceIncludesTax: false,
  categoryTaxAmount: 0.6,
};
const product = { id: "prod-tob", pricePerUnit: 7, unitsPerBox: null, trackedCategoryId: "cat-1" };
const RAISED = { id: "cat-1", taxType: "EXCISE_PER_UNIT", rate: 0.08, priceIncludesTax: false };

describe("updateOrderItems staff replace-all: a paired line carries its trio and createdAt (row 373b)", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 84, status: "PENDING" }]);
    h.prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [storedLine] });
    h.prisma.customer.findFirst.mockResolvedValue({ pricingTier: 1 });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
    h.prisma.product.findMany.mockResolvedValue([product]);
    h.prisma.trackedCategory.findMany.mockResolvedValue([RAISED]); // the live rate was raised since the sale
  });
  const created = () =>
    h.prisma.orderItem.create.mock.calls
      .map((c: any) => c[0].data)
      .filter((d: any) => d.productId === "prod-tob");

  it("an id-less entry (one stored line of the product) keeps the SOLD rate and createdAt, not the raised live rate", async () => {
    await h.service.updateOrderItems(
      "ord-1",
      { items: [{ productId: "prod-tob", qty: 12, unitPrice: 7 }], replaceAll: true } as never,
      operatorPayload as never,
    );
    const rows = created();
    expect(rows).toHaveLength(1);
    expect(rows[0].categoryTaxRate).toBe(0.05);
    expect(rows[0].createdAt).toEqual(SOLD_AT);
  });

  it("added quantity at the raised live rate goes on a NEW live line; the old line keeps its units and rate", async () => {
    await h.service.updateOrderItems(
      "ord-1",
      {
        items: [{ productId: "prod-tob", qty: 20, unitPrice: 7, id: "li-1" }],
        replaceAll: true,
      } as never,
      operatorPayload as never,
    );
    const rows = created();
    expect(rows.map((r: any) => [r.qty, r.categoryTaxRate])).toEqual([
      [12, 0.05],
      [8, 0.08],
    ]);
  });

  it("two stored lines of the product and an id-less entry is 409 ORDER_EDIT_NEEDS_LINE_IDS with nothing written", async () => {
    h.prisma.order.findUnique.mockResolvedValue({
      ...MOCK_ORDER,
      lineItems: [storedLine, { ...storedLine, id: "li-2" }],
    });
    await expect(
      h.service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-tob", qty: 12, unitPrice: 7 }], replaceAll: true } as never,
        operatorPayload as never,
      ),
    ).rejects.toMatchObject({ response: { code: "ORDER_EDIT_NEEDS_LINE_IDS" } });
    expect(h.prisma.orderItem.create).not.toHaveBeenCalled();
    expect(h.prisma.orderItem.deleteMany).not.toHaveBeenCalled();
  });
});
