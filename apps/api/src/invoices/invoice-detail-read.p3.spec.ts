import { deriveInvoiceDetailFields, revisedAtByInvoice } from "./invoice-detail-read";
import { CUSTOMER_INVOICE_FIELDS } from "../common/staff-only-fields";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";

/** SA-763r P-3: the derived `overpaidBy` and `revisedAt` on an invoice read (no column; never a status). */
describe("invoice detail: overpaidBy and revisedAt", () => {
  const pay = (amount: number, method = "CASH", status = "PAID") => ({ amount, method, status });
  const inv = (total: number, payments: any[], status = "SENT") => ({
    total,
    status,
    dueDate: null,
    payments,
  });

  it("overpaidBy is the confirmed EXTERNAL cash beyond the total; a balance floors at 0", () => {
    const over = deriveInvoiceDetailFields(inv(100, [pay(130)]));
    expect(over.overpaidBy).toBe(30);
    expect(over.balanceDue).toBe(0);
    expect(deriveInvoiceDetailFields(inv(100, [pay(60)])).overpaidBy).toBe(0);
    expect(deriveInvoiceDetailFields(inv(100, [pay(100)], "PAID")).overpaidBy).toBe(0);
  });

  it("a credit-note application, an unconfirmed DRAFT payment and a VOID payment never count", () => {
    expect(
      deriveInvoiceDetailFields(
        inv(100, [
          pay(100),
          pay(50, "CREDIT_NOTE"),
          pay(80, "CASH", "DRAFT"),
          pay(90, "CASH", "VOID"),
        ]),
      ).overpaidBy,
    ).toBe(0);
  });

  it("both fields are on the buyer allow-list", () => {
    expect(CUSTOMER_INVOICE_FIELDS).toEqual(expect.arrayContaining(["overpaidBy", "revisedAt"]));
  });

  it("revisedAt: the latest invoice.revised audit row per invoice, one grouped read", async () => {
    const t1 = new Date("2026-10-01T10:00:00Z");
    const groupBy = jest.fn().mockResolvedValue([{ entityId: "inv-1", _max: { createdAt: t1 } }]);
    const map = await revisedAtByInvoice({ auditLog: { groupBy } }, ["inv-1", "inv-2"]);
    expect(map.get("inv-1")).toEqual(t1);
    expect(map.has("inv-2")).toBe(false);
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy.mock.calls[0][0].where).toEqual({
      entityType: "invoice",
      action: AUDIT_ACTIONS.INVOICE_REVISED,
      entityId: { in: ["inv-1", "inv-2"] },
    });
    expect((await revisedAtByInvoice({ auditLog: { groupBy } }, [])).size).toBe(0);
    expect(groupBy).toHaveBeenCalledTimes(1); // nothing to look up: no query
  });
});
