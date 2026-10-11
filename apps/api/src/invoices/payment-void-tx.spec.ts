import { readFileSync } from "fs";
import { join } from "path";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AfterCommit } from "../common/after-commit";
import { voidPaymentInTx, type PaymentVoidTxDeps } from "./payment-void-tx";

// SA-762r: voidPaymentInTx is the ONE payment-void writer; voidPayment wraps it and the counter-sale void reuses it.
function harness(payment: Record<string, unknown> | null, invoicePayments: unknown[] = []) {
  const tx: any = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    invoicePayment: {
      findFirst: jest.fn().mockResolvedValue(payment),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    advancePayment: { update: jest.fn().mockResolvedValue({}) },
    invoice: {
      findUnique: jest.fn().mockResolvedValue({
        id: "inv-1",
        invoiceNumber: "INV-1",
        customerId: "c-1",
        total: 50,
        status: "PAID",
        dueDate: null,
        paidAt: new Date(),
        payments: invoicePayments,
        order: { routeRunId: null, routeRunStopId: null },
      }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const gateway = { emitInvoiceUpdated: jest.fn() };
  const deps: PaymentVoidTxDeps = {
    reverseRunAdvancesInTx: jest.fn().mockResolvedValue(0),
    gateway,
    commissionEngine: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
    tenantId: "t-1",
  };
  return { tx, gateway, deps, after: new AfterCommit() };
}

describe("voidPaymentInTx", () => {
  it("voids the payment, reopens the invoice, syncs commission and queues (not fires) the emit", async () => {
    const h = harness({
      id: "p-1",
      invoiceId: "inv-1",
      method: "CASH",
      status: "PAID",
      amount: 50,
    });
    await expect(voidPaymentInTx(h.deps, h.tx, h.after, "inv-1", "p-1", null)).resolves.toEqual({
      success: true,
    });
    expect(h.tx.invoicePayment.update).toHaveBeenCalledWith({
      where: { id: "p-1" },
      data: { status: "VOID" },
    });
    // the invoice row lock comes first, the status recompute (no confirmed payment left) after the VOID write
    expect(h.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      h.tx.invoicePayment.update.mock.invocationCallOrder[0],
    );
    expect(h.tx.invoice.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: { status: expect.not.stringMatching(/^PAID$/), paidAt: null },
    });
    expect(h.deps.commissionEngine.syncInvoiceCommissionSafe).toHaveBeenCalledWith("inv-1", h.tx);
    expect(h.gateway.emitInvoiceUpdated).not.toHaveBeenCalled(); // queued until the owning tx commits
    h.after.flush();
    expect(h.gateway.emitInvoiceUpdated).toHaveBeenCalledWith(
      "t-1",
      expect.objectContaining({ invoiceId: "inv-1" }),
    );
  });

  it("an ADVANCE application hands its dollars back to the advance balance", async () => {
    const h = harness({
      id: "p-2",
      invoiceId: "inv-1",
      method: "ADVANCE",
      status: "PAID",
      amount: 30,
      advancePaymentId: "adv-1",
    });
    await voidPaymentInTx(h.deps, h.tx, h.after, "inv-1", "p-2", null);
    expect(h.tx.advancePayment.update).toHaveBeenCalledWith({
      where: { id: "adv-1" },
      data: { balance: { increment: 30 } },
    });
  });

  it("refuses a missing payment (404), an already-void one and an applied credit note (400); writes nothing", async () => {
    const missing = harness(null);
    await expect(
      voidPaymentInTx(missing.deps, missing.tx, missing.after, "inv-1", "p-x", null),
    ).rejects.toBeInstanceOf(NotFoundException);
    const voided = harness({ id: "p", method: "CASH", status: "VOID", amount: 1 });
    await expect(
      voidPaymentInTx(voided.deps, voided.tx, voided.after, "inv-1", "p", null),
    ).rejects.toBeInstanceOf(BadRequestException);
    const note = harness({ id: "p", method: "CREDIT_NOTE", status: "PAID", amount: 1 });
    await expect(
      voidPaymentInTx(note.deps, note.tx, note.after, "inv-1", "p", null),
    ).rejects.toBeInstanceOf(BadRequestException);
    for (const h of [missing, voided, note])
      expect(h.tx.invoicePayment.update).not.toHaveBeenCalled();
  });

  it("structure: voidPayment delegates to it, and no other file writes a payment VOID status through this path", () => {
    const svc = readFileSync(join(__dirname, "invoices.service.ts"), "utf8");
    const at = svc.indexOf("  async voidPayment(");
    const body = svc.slice(at, svc.indexOf("\n  }\n", at));
    expect(body).toMatch(/this\.voidPaymentInTx\(tx, after, invoiceId, paymentId, tz\)/);
    expect(body).not.toMatch(/invoicePayment\.update/);
  });
});
