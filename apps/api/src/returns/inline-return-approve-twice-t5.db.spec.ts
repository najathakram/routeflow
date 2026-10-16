/**
 * T5 (inventory TEST-PLAN W1b, B841): two approves of ONE held inline return must restock once, reverse the
 * regulated ledger once and mint one credit note.
 *
 * Stock 10 (OPENING 10), a sale of 3 (counter 7), then a driver-cap-held inline return of 2 pieces against that
 * order. Two `approve()` calls are released together: a BARRIER on the transaction entry holds both until BOTH
 * pre-checks have passed (so neither takes the already-approved replay shortcut), then lets them race for the Return
 * row lock. The loser must wake on the winner's commit, re-check under the lock and skip.
 * Expected: counter 9, ONE RETURN movement (+2), ONE `reverseReturnEntries` call, ONE credit note, X1 holds.
 *
 * Entry is asserted before the outcome is trusted (both callers reached the barrier). The Return row lock is the
 * only blocking acquisition on the one-return path, so the wait is bounded by the winner's single transaction.
 *
 * Status on master: see the report. B841 itself is the sibling shape (a SECOND return on the same line, holding only
 * the Return lock); this row pins the same-return double approve.
 */
jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({ getOrGenerate: jest.fn() })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { describeDb } from "../common/testing/db-spec";
import { buildOrderStockWorld, type OrderStockWorld } from "../inventory/testing/order-stock-world";
import { expectLedgerConsistent } from "../inventory/testing/ledger-consistency";
import { InlineReturnsService } from "./inline-returns.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";

describeDb("T5 / B841: inline approve twice restocks and reverses once", () => {
  let w: OrderStockWorld;
  let service: InlineReturnsService;
  let reverseCalls = 0;
  let arrived = 0;
  let release!: () => void;
  const bothIn = new Promise<void>((r) => (release = r));

  beforeAll(async () => {
    w = await buildOrderStockWorld("t5", "inline-return-approve-twice-t5.db.spec.ts");
    const numbering = new NumberingService(w.prisma);
    const anything = new Proxy({}, { get: () => jest.fn().mockResolvedValue(undefined) });
    const creditNotes = new CreditNotesService(
      w.prisma,
      { emitCreditNoteCreated: jest.fn(), emitInvoiceUpdated: jest.fn() } as any,
      anything as any,
      { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) } as any,
      numbering,
    );
    // Both approves enter their transaction together: each has already passed the unlocked pre-check.
    const gated: any = new Proxy(w.prisma, {
      get(target: any, prop) {
        if (prop === "tenantTransaction") {
          return async (fn: (tx: any) => unknown, opts?: unknown) => {
            arrived += 1;
            if (arrived >= 2) release();
            await Promise.race([bothIn, new Promise((r) => setTimeout(r, 1500))]);
            return target.tenantTransaction(fn, opts);
          };
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    service = new InlineReturnsService(
      gated,
      { emitCreditNoteCreated: jest.fn() } as any,
      {
        reverseReturnEntries: jest.fn(async () => {
          reverseCalls += 1;
        }),
      } as any,
      creditNotes,
      numbering,
      { hasAddon: jest.fn().mockResolvedValue(true) } as any,
      {} as any,
      {} as any,
    );
  }, 120_000);
  afterAll(async () => {
    const swallow = () => undefined;
    const where = { where: { tenantId: w?.tenantId } };
    if (w) {
      await w.prisma.invoicePayment.deleteMany(where).catch(swallow);
      await w.prisma.orderCreditNote.deleteMany(where).catch(swallow);
      await w.prisma.returnItem.deleteMany(where).catch(swallow);
      await w.prisma.return.deleteMany(where).catch(swallow);
      await w.prisma.creditNote.deleteMany(where).catch(swallow);
      await w.prisma.invoiceItem
        .deleteMany({ where: { invoice: { tenantId: w.tenantId } } })
        .catch(swallow);
      await w.prisma.invoice.deleteMany(where).catch(swallow);
    }
    await w?.cleanup();
  }, 120_000);

  it("B841: two approves of one held return -> one RETURN movement, one ledger reversal, one credit note", async () => {
    const productId = await w.product("t5", 10);
    const { order } = await w.bookOrder({ status: "CONFIRMED", lines: [{ productId, qty: 3 }] });
    const customerId = order.customerId;
    await w.prisma.invoice.create({
      data: {
        tenantId: w.tenantId,
        customerId,
        orderId: order.id,
        invoiceNumber: `INV-T5-${order.id.slice(0, 8)}`,
        status: "DRAFT",
        subtotal: 15,
        total: 15,
      },
    });
    const ret = await w.prisma.return.create({
      data: {
        tenantId: w.tenantId,
        orderId: order.id,
        customerId,
        kind: "INLINE",
        status: "RECEIVED",
        reason: "DAMAGED",
        holdReason: "DRIVER_CAP",
        heldAmount: 10,
        creditSubtotal: 10,
        creditTax: 0,
        creditCategoryTax: 0,
        returnNumber: `RET-T5-${order.id.slice(0, 8)}`,
        items: {
          create: [
            { tenantId: w.tenantId, productId, qty: 2, restock: true, sourceOrderId: order.id },
          ],
        },
      },
    });

    const approve = () => w.inTenant(() => service.approve(ret.id, { sub: w.jwt.sub } as any));
    const results = await Promise.allSettled([approve(), approve()]);

    expect(arrived).toBe(2); // entry: both callers passed the pre-check and raced for the Return lock
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const returnMovements = (await w.movements(productId)).filter((m) => m.type === "RETURN");
    expect({
      returnMovements: returnMovements.map((m) => Number(m.quantity)),
      ledgerReversals: reverseCalls,
      creditNotes: await w.prisma.creditNote.count({ where: { customerId } }),
      stock: await w.stockOf(productId),
    }).toEqual({ returnMovements: [2], ledgerReversals: 1, creditNotes: 1, stock: 9 });
    await expectLedgerConsistent(w.tenantId, w.productIds);
  }, 60_000);
});
