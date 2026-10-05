// The harness FIRST: it jest.mock()s modules that orders.service also imports.
import {
  buildOrdersService,
  customerPayload,
  operatorPayload,
} from "./testing/orders-service-harness";
import { omitStaffOnlyOrderFields } from "../common/staff-only-fields";

/**
 * Customer reads of an order (GET /orders, GET /orders/:id as CUSTOMER) carry customer-facing
 * fields only: no line override reason/author, no commission rate, and no DRAFT invoice in the
 * order's invoice list. Staff reads are unchanged — the SAME rows, byte for byte. Placeholders only.
 */
const STAFF_LINE = {
  id: "li-1",
  productId: "p-1",
  qty: 2,
  unitPrice: 5,
  priceType: "MANUAL",
  originalPrice: 4,
  overrideReason: "staff-only reason",
  overriddenBy: "user-op",
  product: { id: "p-1", name: "Widget", unit: "ea" },
};

function orderRow() {
  return {
    id: "ord-1",
    customerId: "cust-1",
    orderNumber: "ORD-1",
    status: "PENDING",
    commissionRatePct: 7.5,
    notes: "customer note",
    routeRun: null,
    lineItems: [{ ...STAFF_LINE }],
    invoices: [
      { id: "inv-draft", invoiceNumber: "INV-D", status: "DRAFT", total: 10, payments: [] },
      { id: "inv-sent", invoiceNumber: "INV-S", status: "SENT", total: 10, payments: [] },
    ],
  };
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v));

describe("OrdersService.findAll — customer-facing fields only", () => {
  it("staff: rows come back exactly as read (every field kept)", async () => {
    const h = await buildOrdersService();
    h.prisma.order.findMany.mockResolvedValue([orderRow()]);
    h.prisma.order.count.mockResolvedValue(1);
    const out = await h.service.findAll({} as never, operatorPayload as never);
    expect(json(out.data)).toEqual(json([orderRow()]));
    expect(out.data[0]).toHaveProperty("commissionRatePct", 7.5);
    expect(out.data[0].lineItems[0]).toHaveProperty("overrideReason", "staff-only reason");
  });

  it("customer: no commission rate, no line override reason/author", async () => {
    const h = await buildOrdersService();
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    h.prisma.order.findMany.mockResolvedValue([orderRow()]);
    h.prisma.order.count.mockResolvedValue(1);
    const out = await h.service.findAll({} as never, customerPayload as never);
    const row = out.data[0] as Record<string, unknown> & { lineItems: object[] };
    expect(row).not.toHaveProperty("commissionRatePct");
    expect(row.lineItems[0]).not.toHaveProperty("overrideReason");
    expect(row.lineItems[0]).not.toHaveProperty("overriddenBy");
    expect(row.notes).toBe("customer note");
  });
});

describe("OrdersService.findOne — customer-facing fields only", () => {
  it("staff: the order keeps every field and every invoice, DRAFT included", async () => {
    const h = await buildOrdersService();
    h.prisma.order.findUnique.mockResolvedValue(orderRow());
    const out = (await h.service.findOne("ord-1", operatorPayload as never)) as unknown as {
      commissionRatePct: number;
      lineItems: Array<Record<string, unknown>>;
      invoices: Array<{ id: string }>;
    };
    expect(out.commissionRatePct).toBe(7.5);
    expect(out.lineItems[0]).toEqual(expect.objectContaining(STAFF_LINE));
    expect(out.invoices.map((i) => i.id)).toEqual(["inv-draft", "inv-sent"]);
  });

  it("customer: no commission rate, no override reason/author, no DRAFT invoice", async () => {
    const h = await buildOrdersService();
    h.prisma.order.findUnique.mockResolvedValue(orderRow());
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    const out = (await h.service.findOne("ord-1", customerPayload as never)) as unknown as Record<
      string,
      unknown
    > & { lineItems: object[]; invoices: Array<{ id: string }> };
    expect(out).not.toHaveProperty("commissionRatePct");
    expect(out.lineItems[0]).not.toHaveProperty("overrideReason");
    expect(out.lineItems[0]).not.toHaveProperty("overriddenBy");
    expect(out.invoices.map((i) => i.id)).toEqual(["inv-sent"]);
    expect(out).toHaveProperty("editWindow");
  });

  it("staff and customer differ ONLY by the staff-only fields", async () => {
    const staff = await buildOrdersService();
    staff.prisma.order.findUnique.mockResolvedValue(orderRow());
    const staffOut = await staff.service.findOne("ord-1", operatorPayload as never);

    const cust = await buildOrdersService();
    cust.prisma.order.findUnique.mockResolvedValue(orderRow());
    cust.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    const custOut = await cust.service.findOne("ord-1", customerPayload as never);

    // The customer read also redacts the upsell base (pre-existing) and its edit window is
    // computed for the CUSTOMER role, so compare on the fields this change owns.
    const strip = (o: Record<string, unknown>) => {
      const { editWindow: _e, lineItems: _l, ...rest } = o;
      return rest;
    };
    expect(json(strip(custOut as never))).toEqual(
      json(strip(omitStaffOnlyOrderFields(staffOut) as never)),
    );
  });
});
