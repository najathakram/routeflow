/**
 * SA-218 (2) / #2116 — reconcileOrderAfterEdit's credit-sync transaction takes the Order row FIRST.
 *
 * House lock order: advisory → Return → Order → Invoice → rows. The credit tx runs
 * syncOrderCreditSelections → pullBackOrderCreditPair (restoreCreditFromPaymentInTx's
 * `invoice.update`) and only afterwards `orderCreditNote.create`, whose FK check takes KEY SHARE on
 * the Order — an Invoice → Order edge that deadlocks (40P01) against a writer taking Order FOR
 * UPDATE then an Invoice (#2083's invoices update()). The fix makes `Order FOR UPDATE` the tx's
 * first statement, so the later KEY SHARE is a no-wait on a row the tx already holds.
 *
 * The REAL CreditNotesService sync/settle code runs against an op-logging tx (the module boundary),
 * so the logged invoice writes are the shipped ones, not a re-description of them. The real-Postgres
 * interleaving is proven in `common/sa218-lock-order.db.spec.ts`.
 *
 * `Object.create(OrdersService.prototype)` (the orders-promo-bogo.spec.ts precedent) wires only the
 * three members this method reads — prisma, invoicesService, creditNotes — instead of the class's
 * sixteen constructor dependencies.
 */
import { OrdersService } from "./orders.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { createOpLogTx } from "../testing/op-log-tx";

const CN_OLD = {
  id: "cn-old",
  creditNoteNumber: "CN-OLD",
  customerId: "cust-1",
  amount: 30,
  amountUsed: 30,
  status: "APPLIED",
  expiresAt: null,
  appliedToInvoiceId: "inv-1",
  appliedAt: new Date("2026-09-01T00:00:00Z"),
  autoApplied: false,
};
const CN_NEW = {
  ...CN_OLD,
  id: "cn-new",
  creditNoteNumber: "CN-NEW",
  amount: 20,
  amountUsed: 0,
  status: "ISSUED",
  appliedToInvoiceId: null,
  appliedAt: null,
};
const INVOICE = {
  id: "inv-1",
  invoiceNumber: "INV-1",
  orderId: "ord-1",
  total: 100,
  dueDate: null,
  status: "SENT",
  paidAt: null,
};

/** Steers the real sync down the pull-back path (drop CN_OLD, add CN_NEW) and settle into an apply. */
function respond(op: string, args: any): unknown {
  switch (op) {
    case "creditNote.findMany":
      return [{ ...CN_NEW }];
    case "creditNote.findUnique":
      return args?.where?.id === CN_OLD.id ? { ...CN_OLD } : { ...CN_NEW };
    case "orderCreditNote.findMany":
      // settle reads intents WITH the credit note; sync reads the stored rows without it.
      return args?.include
        ? [
            {
              id: "ocn-new",
              orderId: "ord-1",
              creditNoteId: CN_NEW.id,
              amount: null,
              creditNote: { ...CN_NEW },
            },
          ]
        : [{ id: "ocn-old", orderId: "ord-1", creditNoteId: CN_OLD.id, amount: null }];
    case "invoicePayment.findMany":
      return [{ id: "pay-old", invoiceId: INVOICE.id, creditNoteId: CN_OLD.id, amount: 30 }];
    case "invoice.findUnique":
      return { ...INVOICE, payments: [] };
    case "invoice.findMany":
      return [{ ...INVOICE, payments: [] }];
    default:
      return undefined;
  }
}

const INVOICE_WRITE =
  /^(invoice|invoicePayment)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)$/;

function build(tenantId: string | null) {
  const { tx, log } = createOpLogTx(respond);
  const prisma = {
    getTenantId: () => tenantId,
    tenantTransaction: jest.fn((fn: (t: any) => unknown) => fn(tx)),
  };
  const creditNotes = new CreditNotesService(
    prisma as any,
    {} as any,
    {} as any,
    { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) } as any,
    {} as any,
  );
  const invoicesService = {
    resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue(null),
    reconcileOrderDraftInvoice: jest.fn().mockResolvedValue(undefined),
  };
  const service = Object.assign(Object.create(OrdersService.prototype), {
    prisma,
    invoicesService,
    creditNotes,
  });
  const reconcile = (applied: Array<{ creditNoteId: string }> | undefined) =>
    service.reconcileOrderAfterEdit("ord-1", "cust-1", applied, {
      postDeliveryEdit: false,
      skipInPlaceResync: false,
    });
  return { log, prisma, reconcile };
}

function expectOrderLockFirst(log: ReturnType<typeof createOpLogTx>["log"]) {
  expect(log[0]?.op).toBe("$queryRaw");
  expect(log[0]?.sql).toMatch(/^SELECT id FROM "Order" WHERE id = \?.*FOR UPDATE$/);
  expect(log[0]?.values?.[0]).toBe("ord-1");
  // Exactly one row lock: the credit code itself takes none.
  expect(log.filter((e) => e.op === "$queryRaw" || e.op === "$executeRaw")).toHaveLength(1);
}

describe("reconcileOrderAfterEdit — the credit-sync tx takes Order FOR UPDATE first (SA-218 (2), #2116)", () => {
  it("REG-SA218-2a: sync + settle — the Order lock precedes the pull-back's invoice write and the intent insert", async () => {
    const { log, prisma, reconcile } = build("tenant-1");

    await reconcile([{ creditNoteId: CN_NEW.id }]);

    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expectOrderLockFirst(log);
    // Tenant-scoped: the session's tenant is bound into the lock's predicate.
    expect(log[0].sql).toContain('"tenantId"');
    expect(log[0].values).toContain("tenant-1");
    const ops = log.map((e) => e.op);
    // Vacuity guards: the real pull-back DID write the invoice, and the real sync DID insert the
    // new intent (the Order KEY SHARE) — so "after the lock" is about statements that happened.
    expect(ops).toContain("invoice.update");
    expect(ops).toContain("orderCreditNote.create");
    expect(ops.findIndex((op) => INVOICE_WRITE.test(op))).toBeGreaterThan(0);
    expect(ops.indexOf("orderCreditNote.create")).toBeGreaterThan(0);
  });

  it("REG-SA218-2b: settle only (no selection sent) — the Order lock still comes first", async () => {
    const { log, reconcile } = build("tenant-1");

    await reconcile(undefined);

    expectOrderLockFirst(log);
    const ops = log.map((e) => e.op);
    expect(ops).not.toContain("orderCreditNote.create"); // the sync was skipped, as before
    expect(ops).toContain("invoicePayment.create"); // settle really applied a credit
    expect(ops.findIndex((op) => INVOICE_WRITE.test(op))).toBeGreaterThan(0);
  });

  it("REG-SA218-2c: a tenant-less session still takes the lock (on the id alone), never silently skips it", async () => {
    const { log, reconcile } = build(null);

    await reconcile([{ creditNoteId: CN_NEW.id }]);

    expectOrderLockFirst(log);
    expect(log[0].sql).toMatch(/\?::text IS NULL OR "tenantId" = \?/);
  });
});
