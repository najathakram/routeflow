import { NotFoundException } from "@nestjs/common";
import { InvoicesService } from "./invoices.service";
import { expectNoStaffLeaks, leakyInvoice } from "../common/testing/customer-leak-fixtures";

/**
 * Customer reads of an invoice (GET /invoices, GET /invoices/:id as CUSTOMER) carry an ALLOWLIST of
 * customer-facing fields: no internal notes, write-off reason, fee/recurring/group/batch links, no
 * line override reason/author, no payment memo / image key / bank charges / bounce reason /
 * replaced-payment link (nor any column added later), and the customer list shows confirmed (PAID)
 * payment rows only. A CUSTOMER opening a
 * DRAFT gets the same 404 as a missing invoice. Staff reads are unchanged. Placeholders only.
 */
const LINE = {
  id: "li-1",
  unitPrice: 5,
  overrideReason: "staff-overrideReason",
  overriddenBy: "staff-overriddenBy",
};

function invoiceRow(status = "SENT") {
  const base = leakyInvoice(status);
  const pay = base.payments[0];
  return {
    ...base,
    tenantId: "t-1",
    orderId: null,
    dueDate: null,
    order: null,
    payments: [
      { ...pay, id: "p-paid", method: "CASH", amount: 5 },
      { ...pay, id: "p-draft", status: "DRAFT", method: "BANK_TRANSFER", amount: 4 },
      { ...pay, id: "p-pending", status: "PENDING", method: "CHECK", amount: 3 },
      { ...pay, id: "p-void", status: "VOID", method: "CHECK", amount: 2 },
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
      // SA-770: findAll resolves the tenant for the overdue balance filter (a no-op without isOverdue)
      getTenantId: () => "tenant-1",
      // row 308: every read resolves the tenant zone once for its isOverdue flag (none configured here)
      tenantConfig: { findUnique: jest.fn().mockResolvedValue({ timezone: null }) },
      forTenant: () => ({
        invoice: {
          findUnique: jest.fn().mockResolvedValue(row),
          findMany,
          count: jest.fn().mockResolvedValue(1),
        },
        customer: { findFirst: jest.fn().mockResolvedValue({ id: "cust-1" }) },
        auditLog: { groupBy: jest.fn().mockResolvedValue([]) }, // revisedAt: never revised
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
    expect(row.internalNotes).toBe("staff-internalNotes");
    expect(row.payments.map((p) => p.id)).toEqual(["p-paid", "p-draft", "p-pending", "p-void"]);
    expect(row.payments[0].notes).toBe("staff-notes");
    expect(row.paidAmount).toBe(5);
  });

  it("staff with no principal (internal callers): unchanged too", async () => {
    const { service } = serviceReading(invoiceRow());
    const out = await service.findAll({} as never);
    expect((out.data[0] as unknown as Out).internalNotes).toBe("staff-internalNotes");
  });

  it("customer: allowlisted fields only, confirmed payments only — same money", async () => {
    const { service } = serviceReading(invoiceRow());
    const out = await service.findAll({} as never, principal("CUSTOMER"));
    const row = out.data[0] as unknown as Out;
    expectNoStaffLeaks(row);
    expect(row.notes).toBe("printed on the invoice");
    expect(row.payments.map((p) => p.id)).toEqual(["p-paid"]);
    expect(row.payments[0]).toMatchObject({ status: "PAID", method: "CASH", amount: 5 });
    expect(row.paidAmount).toBe(5);
    expect(row.balanceDue).toBe(15);
    // SA-763r P-3: the two derived fields are on the buyer allow-list
    expect(row.overpaidBy).toBe(0);
    expect(row.revisedAt).toBeNull();
  });
});

describe("InvoicesService.findOne — customer-facing fields only", () => {
  it("staff: every field kept, DRAFT included", async () => {
    const { service } = serviceReading(invoiceRow("DRAFT"));
    const out = (await service.findOne("inv-1", principal("OPERATOR"))) as unknown as Out;
    expect(out.status).toBe("DRAFT");
    expect(out.internalNotes).toBe("staff-internalNotes");
    expect(out.items[0]).toEqual(expect.objectContaining(LINE));
    expect(out.payments[0].notes).toBe("staff-notes");
  });

  it("customer: allowlisted fields only — no internal note, override, or payment memo/key/charges", async () => {
    const { service } = serviceReading(invoiceRow());
    const out = (await service.findOne("inv-1", principal("CUSTOMER"))) as unknown as Out;
    expectNoStaffLeaks(out);
    expect(out.paidAmount).toBe(5);
    expect(out.overpaidBy).toBe(0);
    expect(out.revisedAt).toBeNull();
  });

  it("customer: a DRAFT answers 404, like a missing invoice", async () => {
    const { service } = serviceReading(invoiceRow("DRAFT"));
    await expect(service.findOne("inv-1", principal("CUSTOMER"))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
