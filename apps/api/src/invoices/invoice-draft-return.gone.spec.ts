import { NotFoundException } from "@nestjs/common";
import { revertInvoiceToDraftFlow } from "./invoice-draft-return";

/**
 * R-302: a revert whose invoice row is gone by the time the lock is taken answers 404, never a 400 "not found" (a
 * missing row is not a bad request). The pre-read passes; the locked read finds nothing.
 */
describe("revertInvoiceToDraftFlow: the row is gone under the lock", () => {
  it("answers 404 NotFound and writes nothing", async () => {
    const tx: any = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      invoice: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
    };
    const deps: any = {
      prisma: {
        forTenant: () => ({ invoicePayment: { count: jest.fn().mockResolvedValue(0) } }),
        tenantTransaction: (fn: any) => fn(tx),
      },
      commissionEngine: { syncInvoiceCommissionSafe: jest.fn() },
      findOneOrThrow: jest.fn().mockResolvedValue({ id: "inv-1", orderId: null, status: "SENT" }),
    };
    await expect(revertInvoiceToDraftFlow(deps, "inv-1")).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.invoice.update).not.toHaveBeenCalled();
    expect(deps.commissionEngine.syncInvoiceCommissionSafe).not.toHaveBeenCalled();
  });
});
