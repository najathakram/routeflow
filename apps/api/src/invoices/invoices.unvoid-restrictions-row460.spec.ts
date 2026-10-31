/**
 * Row 460 (SA-958 §3.1): `unvoidInvoice` brings a dead sale back to life (VOID -> DRAFT), SA-272's case. Like the order
 * reopen: `assertLinesSellable` over every catalog line, STAFF channel, before any write; the override stamped on the
 * restored invoice. REOPEN (PAID -> DRAFT) keeps a live sale live and is not judged. Master called no check at all
 * (observed: the unvoid of a since-banned line answered 200).
 * Stateful fake (./testing/split-invoice-fake-db.ts), like invoices.unvoid-billing-claim-b299.spec.ts.
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { ConflictException } from "@nestjs/common";
import { InvoicesService } from "./invoices.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SplitInvoiceFakeDb, fakeOrderLine } from "./testing/split-invoice-fake-db";
import { buildSplitInvoicesService } from "./testing/split-invoice-service";

describe("Row 460 (SA-958 §3.1): unvoid is a new sale of the whole invoice, judged before any write", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let db: SplitInvoiceFakeDb;
  const mockLedger = {
    writeSaleEntries: jest.fn(),
    reverseInvoiceEntries: jest.fn(),
    settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    db = new SplitInvoiceFakeDb();
    db.install(prisma);
    const p = prisma as any;
    const raw = jest.fn().mockResolvedValue(0);
    p.$executeRaw = raw;
    p.tenantTransaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ ...p.forTenant(), $executeRaw: raw, $queryRaw: jest.fn() }),
    );
    // The pre-tx read and the locked re-read both see A as VOID.
    p.invoice.findUnique.mockImplementation(async () => ({
      id: "inv-a",
      orderId: "ord-1",
      customerId: "cust-1",
      status: db.invoices.find((i) => i.id === "inv-a")!.status,
      payments: [],
    }));
    service = await buildSplitInvoicesService(InvoicesService, prisma, mockLedger);
  });

  const seedVoidA = (
    lineOver: Record<string, unknown> = {},
    aItem: Record<string, unknown> = {},
  ) => {
    db.addOrder({ id: "ord-1", customerId: "cust-1", orderNumber: "ORD-1", total: 100 }, [
      fakeOrderLine({ id: "oi-1", qty: 120, invoicedQty: 0, ...lineOver }),
    ]);
    db.invoices.push({
      id: "inv-a",
      orderId: "ord-1",
      customerId: "cust-1",
      tenantId: "test-tenant",
      invoiceNumber: "INV-A",
      status: "VOID",
      createdAt: new Date(Date.UTC(2026, 0, 1)),
    });
    db.invoiceItems.push({
      id: "ii-a",
      invoiceId: "inv-a",
      orderItemId: "oi-1",
      productId: "p-1",
      qty: 60,
      ...aItem,
    });
  };
  const gate = () => (service as any).sellingRestrictions.assertLinesSellable as jest.Mock;
  const statusOfA = () => db.invoices.find((i) => i.id === "inv-a")!.status;
  const OP = { sub: "u-op", role: "OPERATOR" } as never;

  it("judges every catalog line of the VOID invoice on the STAFF channel, before any write", async () => {
    seedVoidA();
    let writesAtJudgement = -1;
    gate().mockImplementation(async () => {
      writesAtJudgement = db.invoiceUpdateCalls.length;
      return undefined;
    });
    await service.unvoidInvoice("inv-a", OP, undefined);
    expect(gate()).toHaveBeenCalledTimes(1);
    expect(gate().mock.calls[0][0]).toMatchObject({
      channel: "STAFF",
      customerId: "cust-1",
      document: "INVOICE",
      lines: [{ productId: "p-1", lineKey: "l:ii-a" }],
    });
    expect(gate().mock.calls[0][0].held.every((h: { status: unknown }) => h.status === null)).toBe(
      true,
    );
    expect(writesAtJudgement).toBe(0);
    expect(statusOfA()).toBe("DRAFT");
  });

  it("a line now banned for the customer's state: 409 RESTRICTION_WARNING, A stays VOID, nothing written", async () => {
    seedVoidA();
    gate().mockRejectedValue(
      new ConflictException({ code: "RESTRICTION_WARNING", message: "needs a reason" }),
    );
    await expect(service.unvoidInvoice("inv-a", OP, undefined)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "RESTRICTION_WARNING" }),
    });
    expect(statusOfA()).toBe("VOID");
    expect(db.invoiceUpdateCalls).toHaveLength(0);
    expect(db.line("oi-1").invoicedQty).toBe(0);
  });

  it("an acknowledged override is re-judged under the lock and stamped on the restored invoice", async () => {
    seedVoidA();
    const stamp = jest.fn().mockResolvedValue(1);
    const recheck = jest.fn().mockReturnValue({ stamp });
    gate().mockResolvedValue({ recheck, stamp });
    await service.unvoidInvoice("inv-a", OP, { warningHash: "rw1:x" } as never);
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(recheck.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: "ii-a", productId: "p-1" }),
    ]);
    expect(stamp).toHaveBeenCalledWith(expect.anything(), "inv-a");
    expect(statusOfA()).toBe("DRAFT");
  });

  it("a line set that changed between the judgement and the lock is a 409, nothing restored", async () => {
    seedVoidA();
    gate().mockImplementation(async () => {
      db.invoiceItems.push({
        id: "ii-x",
        invoiceId: "inv-a",
        orderItemId: null,
        productId: "p-9",
        qty: 1,
      });
      return undefined;
    });
    await expect(service.unvoidInvoice("inv-a", OP, undefined)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "INVOICE_CHANGED_CONCURRENTLY" }),
    });
    expect(statusOfA()).toBe("VOID");
  });

  it("control: reopening a PAID invoice is NOT judged (a live sale stays live)", async () => {
    seedVoidA();
    db.invoices.find((i) => i.id === "inv-a")!.status = "PAID";
    (prisma as any).invoice.update.mockResolvedValue({ id: "inv-a", status: "DRAFT" });
    await service.reopenInvoice("inv-a");
    expect(gate()).not.toHaveBeenCalled();
  });
});
