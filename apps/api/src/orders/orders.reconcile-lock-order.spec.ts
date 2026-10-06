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
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
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
    // SA-495a (#2520): credit settlement resolves the tenant zone once (no zone configured here).
    tenantConfig: { findUnique: jest.fn().mockResolvedValue(null) },
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
  // B1052: the credit code now takes its own row locks too (settle: this Order again — a no-op on
  // a row the tx holds — then its invoices, then its notes; restore: the note), so a second
  // spender of the same note waits instead of double-spending. They all come AFTER this Order
  // lock, they only ever lock Order / Invoice / CreditNote rows, and the only Order is this one.
  const locks = log.filter((e) => e.op === "$queryRaw" || e.op === "$executeRaw");
  for (const lock of locks) {
    expect(lock.sql).toMatch(/FROM "(Order|Invoice|CreditNote)"/);
    if (/^SELECT id FROM "Order" WHERE id = \?/.test(lock.sql ?? "")) {
      expect(lock.values?.[0]).toBe("ord-1");
    }
  }
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

// SA-269: the credit tx is Serializable, and with SA-218's Order lock a concurrent Order → Invoice
// writer surfaces as a conflict at commit AFTER the edit itself committed. A bare failure would
// leave the order edited with its credits un-synced, so the whole (idempotent) tx is retried.
const conflict = (
  code: string,
  message = "Transaction failed due to a write conflict or a deadlock",
) =>
  new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

describe("reconcileOrderAfterEdit — a write conflict retries the credit tx (SA-269, #2116)", () => {
  it.each([
    ["Prisma P2034", () => conflict("P2034")],
    [
      "an unwrapped adapter conflict (40001)",
      () =>
        Object.assign(new Error("TransactionWriteConflict"), {
          name: "DriverAdapterError",
          cause: { kind: "TransactionWriteConflict", originalCode: "40001" },
        }),
    ],
    [
      "a raw 40P01 deadlock",
      () => Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    ],
  ])("REG-SA269-1: %s at commit re-runs the whole tx, which converges", async (_label, make) => {
    const { log, prisma, reconcile } = build("tenant-1");
    const runTx = prisma.tenantTransaction.getMockImplementation()!;
    const starts: number[] = [];
    prisma.tenantTransaction.mockImplementation(async (fn) => {
      starts.push(log.length);
      const result = await runTx(fn);
      if (starts.length === 1) throw make(); // the first attempt's commit loses the race
      return result;
    });

    await expect(reconcile([{ creditNoteId: CN_NEW.id }])).resolves.toBeUndefined();

    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
    // Each attempt is a whole tx: it re-takes the Order lock FIRST, then re-runs the sync.
    expect(starts.map((s) => log[s]?.op)).toEqual(["$queryRaw", "$queryRaw"]);
    expect(log.filter((e) => e.op === "orderCreditNote.create")).toHaveLength(2);
  });

  it.each([
    // Its text quotes a conflict code: an HttpException is never retried whatever it says.
    [
      "a 400 (an invalid selection)",
      () => new BadRequestException("Credit note CN-9 (ref 40001) has expired"),
    ],
    ["a non-conflict Prisma error", () => conflict("P2002", "Unique constraint failed")],
  ])("REG-SA269-2: %s propagates once, never retried", async (_label, make) => {
    const { prisma, reconcile } = build("tenant-1");
    const failure = make();
    prisma.tenantTransaction.mockImplementation(async () => {
      throw failure;
    });

    await expect(reconcile([{ creditNoteId: CN_NEW.id }])).rejects.toBe(failure);
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
  });

  it("REG-SA269-3: a conflict on every attempt gives up after 3 and propagates the last one", async () => {
    const { prisma, reconcile } = build("tenant-1");
    const conflicts = [1, 2, 3].map((n) => conflict("P2034", `write conflict ${n}`));
    prisma.tenantTransaction.mockImplementation(async () => {
      throw conflicts[prisma.tenantTransaction.mock.calls.length - 1];
    });

    await expect(reconcile(undefined)).rejects.toBe(conflicts[2]);
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(3);
  });
});
