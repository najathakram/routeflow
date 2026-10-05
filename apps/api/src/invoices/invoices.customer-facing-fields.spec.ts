import { NotFoundException } from "@nestjs/common";
import { InvoicesService } from "./invoices.service";

/**
 * Customer reads of an invoice (GET /invoices, GET /invoices/:id as CUSTOMER) carry
 * customer-facing fields only: no internal notes, no line override reason/author, no payment
 * notes, and the customer list shows confirmed (PAID) payment rows only. A CUSTOMER opening a
 * DRAFT gets the same 404 as a missing invoice. Staff reads are unchanged. Placeholders only.
 */
const LINE = {
  id: "ii-1",
  unitPrice: 5,
  priceType: "MANUAL",
  originalPrice: 4,
  overrideReason: "staff-only reason",
  overriddenBy: "user-op",
};

function invoiceRow(status = "SENT") {
  return {
    id: "inv-1",
    tenantId: "t-1",
    customerId: "cust-1",
    orderId: null,
    deliveryBatchId: null,
    invoiceNumber: "INV-1",
    status,
    total: 20,
    dueDate: null,
    notes: "printed on the invoice",
    internalNotes: "staff-only memo",
    items: [{ ...LINE }],
    order: null,
    payments: [
      { id: "p-paid", status: "PAID", method: "CASH", amount: 5, notes: "staff-only payment memo" },
      { id: "p-draft", status: "DRAFT", method: "BANK_TRANSFER", amount: 4, notes: "unconfirmed" },
      { id: "p-pending", status: "PENDING", method: "CHECK", amount: 3, notes: null },
      { id: "p-void", status: "VOID", method: "CHECK", amount: 2, notes: "bounced" },
    ],
  };
}

function serviceReading(row: ReturnType<typeof invoiceRow>) {
  const service = new (InvoicesService as unknown as new (...a: unknown[]) => InvoicesService)(
    ...Array(14).fill(undefined),
  );
  const findMany = jest.fn().mockResolvedValue([row]);
  Object.assign(service, {
    prisma: {
      forTenant: () => ({
        invoice: {
          findUnique: jest.fn().mockResolvedValue(row),
          findMany,
          count: jest.fn().mockResolvedValue(1),
        },
        customer: { findFirst: jest.fn().mockResolvedValue({ id: "cust-1" }) },
      }),
    },
    systemConfig: { get: jest.fn().mockResolvedValue(null) },
  });
  return { service, findMany };
}

const principal = (role: string) =>
  ({ sub: "user-x", username: "u", role, status: "ACTIVE", forcePasswordChange: false }) as never;

type Out = Record<string, unknown> & {
  items: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
};

describe("InvoicesService.findAll — customer-facing fields only", () => {
  it("staff: every field and every payment row kept, totals from PAID only", async () => {
    const { service } = serviceReading(invoiceRow());
    const out = await service.findAll({} as never, principal("OPERATOR"));
    const row = out.data[0] as unknown as Out;
    expect(row.internalNotes).toBe("staff-only memo");
    expect(row.payments.map((p) => p.id)).toEqual(["p-paid", "p-draft", "p-pending", "p-void"]);
    expect(row.payments[0].notes).toBe("staff-only payment memo");
    expect(row.paidAmount).toBe(5);
  });

  it("staff with no principal (internal callers): unchanged too", async () => {
    const { service } = serviceReading(invoiceRow());
    const out = await service.findAll({} as never);
    expect((out.data[0] as unknown as Out).internalNotes).toBe("staff-only memo");
  });

  it("customer: no internal notes, no payment notes, confirmed payments only — same money", async () => {
    const { service } = serviceReading(invoiceRow());
    const out = await service.findAll({} as never, principal("CUSTOMER"));
    const row = out.data[0] as unknown as Out;
    expect(row).not.toHaveProperty("internalNotes");
    expect(row.notes).toBe("printed on the invoice");
    expect(row.payments).toEqual([{ id: "p-paid", status: "PAID", method: "CASH", amount: 5 }]);
    expect(row.paidAmount).toBe(5);
    expect(row.balanceDue).toBe(15);
  });
});

describe("InvoicesService.findOne — customer-facing fields only", () => {
  it("staff: every field kept, DRAFT included", async () => {
    const { service } = serviceReading(invoiceRow("DRAFT"));
    const out = (await service.findOne("inv-1", principal("OPERATOR"))) as unknown as Out;
    expect(out.status).toBe("DRAFT");
    expect(out.internalNotes).toBe("staff-only memo");
    expect(out.items[0]).toEqual(expect.objectContaining(LINE));
    expect(out.payments[0].notes).toBe("staff-only payment memo");
  });

  it("customer: no internal notes, no line override reason/author, no payment notes", async () => {
    const { service } = serviceReading(invoiceRow());
    const out = (await service.findOne("inv-1", principal("CUSTOMER"))) as unknown as Out;
    expect(out).not.toHaveProperty("internalNotes");
    expect(out.items[0]).not.toHaveProperty("overrideReason");
    expect(out.items[0]).not.toHaveProperty("overriddenBy");
    for (const p of out.payments) expect(p).not.toHaveProperty("notes");
    expect(out.paidAmount).toBe(5);
  });

  it("customer: a DRAFT answers 404, like a missing invoice", async () => {
    const { service } = serviceReading(invoiceRow("DRAFT"));
    await expect(service.findOne("inv-1", principal("CUSTOMER"))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
