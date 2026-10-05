// The harness FIRST: it jest.mock()s modules that orders.service also imports.
import {
  buildOrdersService,
  customerPayload,
  operatorPayload,
} from "./testing/orders-service-harness";
import { pickCustomerOrderFields } from "../common/staff-only-fields";
import {
  expectNoStaffLeaks,
  leakyLine,
  leakyOrder,
} from "../common/testing/customer-leak-fixtures";

/**
 * Customer reads of an order (GET /orders, GET /orders/:id as CUSTOMER) carry an ALLOWLIST of
 * customer-facing fields (common/staff-only-fields.ts): no idempotency key, merge flag, run /
 * template link, commission rate or line override reason/author — nor any column added later — and
 * no DRAFT invoice in the order's invoice list. Upsell lines have their base price redacted on the
 * list read as well as the detail read. Staff reads are unchanged — the SAME rows, byte for byte.
 * Placeholders only.
 */
const STAFF_LINE = leakyLine();

const orderRow = () => ({ ...leakyOrder(), routeRun: null });

const json = (v: unknown) => JSON.parse(JSON.stringify(v));

describe("OrdersService.findAll — customer-facing fields only", () => {
  it("staff: rows come back exactly as read (every field kept)", async () => {
    const h = await buildOrdersService();
    h.prisma.order.findMany.mockResolvedValue([orderRow()]);
    h.prisma.order.count.mockResolvedValue(1);
    const out = await h.service.findAll({} as never, operatorPayload as never);
    expect(json(out.data)).toEqual(json([orderRow()]));
    expect(out.data[0]).toHaveProperty("commissionRatePct", "staff-commissionRatePct");
    expect(out.data[0]).toHaveProperty("idempotencyKey");
    expect(out.data[0].lineItems[0]).toHaveProperty("overrideReason", "staff-overrideReason");
  });

  it("customer: only the allowlisted fields — no staff-internal key at any depth", async () => {
    const h = await buildOrdersService();
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    h.prisma.order.findMany.mockResolvedValue([orderRow()]);
    h.prisma.order.count.mockResolvedValue(1);
    const out = await h.service.findAll({} as never, customerPayload as never);
    const row = out.data[0] as unknown as Record<string, unknown> & { lineItems: object[] };
    expectNoStaffLeaks(row);
    expect(row.notes).toBe("customer note");
    expect(row.lineItems[0]).toMatchObject({ id: "li-1", qty: 2, unitPrice: 5 });
  });

  it("customer: an upsell line's base price is redacted on the list too", async () => {
    const h = await buildOrdersService();
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    const row = orderRow();
    row.lineItems = [
      {
        ...STAFF_LINE,
        priceType: "MANUAL",
        unitPrice: 8,
        originalPrice: 5,
        product: { id: "p-1", name: "Widget", unit: "ea", pricePerUnit: 5 },
      } as never,
    ];
    h.prisma.order.findMany.mockResolvedValue([row]);
    h.prisma.order.count.mockResolvedValue(1);
    const out = await h.service.findAll({} as never, customerPayload as never);
    expect((out.data[0] as unknown as { lineItems: object[] }).lineItems[0]).toMatchObject({
      unitPrice: 8,
      originalPrice: null,
      priceType: "STANDARD",
    });
  });
});

describe("OrdersService.findOne — customer-facing fields only", () => {
  it("staff: the order keeps every field and every invoice, DRAFT included", async () => {
    const h = await buildOrdersService();
    h.prisma.order.findUnique.mockResolvedValue(orderRow());
    const out = (await h.service.findOne("ord-1", operatorPayload as never)) as unknown as {
      commissionRatePct: string;
      lineItems: Array<Record<string, unknown>>;
      invoices: Array<{ id: string }>;
    };
    expect(out.commissionRatePct).toBe("staff-commissionRatePct");
    expect(out.lineItems[0]).toEqual(expect.objectContaining(STAFF_LINE));
    expect(out.invoices.map((i) => i.id)).toEqual(["inv-draft", "inv-sent"]);
  });

  it("customer: only the allowlisted fields, no DRAFT invoice", async () => {
    const h = await buildOrdersService();
    h.prisma.order.findUnique.mockResolvedValue(orderRow());
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    const out = (await h.service.findOne("ord-1", customerPayload as never)) as unknown as Record<
      string,
      unknown
    > & { lineItems: object[]; invoices: Array<{ id: string }> };
    expectNoStaffLeaks(out);
    expect(out.invoices.map((i) => i.id)).toEqual(["inv-sent"]);
    expect(out).toHaveProperty("editWindow");
  });

  it("staff and customer differ ONLY by what the allowlist drops", async () => {
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
      json(strip(pickCustomerOrderFields(staffOut) as never)),
    );
  });
});
