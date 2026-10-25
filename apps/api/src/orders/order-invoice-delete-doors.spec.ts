// The harness FIRST: it jest.mock()s modules that orders.service also imports.
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import * as fs from "fs";
import * as path from "path";

/**
 * REG-ROW259 (#2848): the order service has two places that delete an Invoice row, and both used to
 * skip `unlinkSourcedCredits`, so a credit note the deleted invoice sourced kept a dangling link and
 * no SOURCE_DELETED marker. Door 1 is deleteOrder's invoice loop (proved by behaviour); door 2 is the
 * merge-loser draft delete in forceConsolidateCustomer (proved by source, since a merge needs a
 * whole live order graph - the real-Postgres case is order-delete-credit-unlink.db.spec.ts).
 */
describe("REG-ROW259: deleteOrder unlinks the credit notes its invoices sourced", () => {
  it("REG-ROW259: writes a SOURCE_DELETED row and nulls the note's invoiceId BEFORE deleting the invoice", async () => {
    const h = await buildOrdersService();
    const { prisma, service } = h;
    const order = {
      id: "ord-1",
      customerId: "cust-1",
      orderNumber: "ORD-1",
      status: "DELIVERED",
      invoices: [{ id: "inv-1" }],
      transaction: null,
    };
    prisma.order.findUnique.mockResolvedValue(order as never);
    prisma.order.findFirst.mockResolvedValue(order as never);
    prisma.invoice.findUnique.mockResolvedValue({ invoiceNumber: "INV-7" } as never);
    // A fully spent note this invoice sourced: closed, so it does not block the delete.
    prisma.creditNote.findMany.mockResolvedValue([
      { id: "cn-1", invoiceId: "inv-1", amount: 50, amountUsed: 50, status: "APPLIED" },
    ] as never);

    await service.deleteOrder("ord-1", operatorPayload as never);

    expect(prisma.auditLog.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          action: "SOURCE_DELETED",
          entityType: "CreditNote",
          entityId: "cn-1",
          meta: { invoiceId: "inv-1", invoiceNumber: "INV-7" },
        }),
      ],
    });
    expect(prisma.creditNote.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["cn-1"] } },
      data: { invoiceId: null },
    });
    expect(prisma.invoice.delete).toHaveBeenCalledWith({ where: { id: "inv-1" } });
    expect(prisma.creditNote.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.invoice.delete.mock.invocationCallOrder[0],
    );
  });
});

describe("REG-ROW259: orders.service.ts has no bare invoice delete", () => {
  const src = fs.readFileSync(path.join(__dirname, "orders.service.ts"), "utf8");

  it("REG-ROW259: neither door calls tx.invoice.delete directly; both call deleteOrderInvoice", () => {
    expect(src).not.toMatch(/\.invoice\s*\.\s*delete(?:Many)?\s*\(/);
    expect(src.match(/deleteOrderInvoice\(/g) ?? []).toHaveLength(2);
  });

  it("REG-ROW259: the merge-loser draft delete is inside forceConsolidateCustomer", () => {
    const start = src.indexOf("  async forceConsolidateCustomer(");
    const end = src.indexOf("\n  }\n", start);
    expect(src.slice(start, end)).toContain("deleteOrderInvoice(tx, loserDraft.id,");
  });
});
