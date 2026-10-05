/**
 * B1052 (HIGH, money) — a credit note must never be spent twice. Real-Postgres repro.
 *
 * `settleOrderCreditsInTx` (run by the office invoice paths `createSplitInvoices` /
 * `createPartialFromOrder` inside a READ COMMITTED transaction, and by the driver path on the
 * routes tx) read the note's `amountUsed` with no lock, then `applyCreditInTx` wrote an ABSOLUTE
 * `amountUsed` back. Two settles of two orders that both carry the same note each read
 * `amountUsed = 0`, each applied the full balance, and the last write won: the note says $100 used
 * while $200 of CREDIT_NOTE payments sit on two invoices. The restore side wrote absolute too, so a
 * shrink-restore racing an apply lost one of the two writes.
 *
 * The race is made deterministic with a BARRIER: each transaction's FIRST `creditNote.findUnique`
 * waits (up to BARRIER_MS) for the other transaction to have read too. On the broken code both
 * reads happen before either write, so both see the stale balance. With the fix the second
 * transaction blocks on the note's row lock BEFORE it reads; the first one's barrier times out,
 * it commits, and the second reads the committed balance.
 *
 * Invariants checked (both must hold for every case):
 *  - Σ live CREDIT_NOTE payments of the note ≤ the note's amount;
 *  - the note's `amountUsed` = Σ its live CREDIT_NOTE payments (the wallet never disagrees with
 *    the invoices).
 *
 * Runs only under the DB lane (`jest.db.config.js`, RUN_DB_SPECS, a local DATABASE_URL —
 * `requireLocalDatabaseUrl()` refuses anything else). Every tenant is a throwaway
 * `qa-b1052-<run>-<n>-<label>` slug approved by `assertTestTenant`; `afterAll` deletes exactly the
 * tenants this run created, in FK order. No client identifiers anywhere.
 */

jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { CreditNotesService } from "./credit-notes.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
/** How long a transaction waits at the barrier for its partner before going on alone. */
const BARRIER_MS = 1_500;

/** Two-party barrier with a timeout: `arrive()` resolves when both arrived, or after BARRIER_MS. */
function makeBarrier() {
  let arrived = 0;
  let release!: () => void;
  const both = new Promise<void>((r) => (release = r));
  return {
    async arrive() {
      arrived += 1;
      if (arrived >= 2) release();
      await Promise.race([both, new Promise((r) => setTimeout(r, BARRIER_MS))]);
    },
  };
}

/**
 * `tx`, except its FIRST `creditNote.<verb>` read (findUnique for a settle, findMany for the
 * send-time sweep) waits at `barrier` right after reading.
 */
function readThenWait(
  tx: any,
  barrier: ReturnType<typeof makeBarrier>,
  verb: "findUnique" | "findMany" = "findUnique",
) {
  let waited = false;
  const delegate = tx.creditNote;
  const creditNote = new Proxy(delegate, {
    get(target, prop) {
      const value = target[prop];
      if (prop === verb) {
        return async (args: unknown) => {
          const row = await value.call(target, args);
          if (!waited) {
            waited = true;
            await barrier.arrive();
          }
          return row;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === "creditNote") return creditNote;
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describeDb("B1052 a credit note can't be spent twice (concurrent settles, real Postgres)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let creditNotes: CreditNotesService;
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: RouteFlowGateway,
          useValue: { emitCreditNoteCreated: jest.fn(), emitCreditNoteVoided: jest.fn() },
        },
        {
          provide: RegulatedLedgerService,
          useValue: {
            reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
            unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    creditNotes = mod.get(CreditNotesService);
  });

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.creditNoteApplyBlock.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.orderCreditNote.deleteMany(where).catch(swallow);
      await prisma.tenantConfig.deleteMany(where).catch(swallow);
      await prisma.creditNoteItem.deleteMany(where).catch(swallow);
      await prisma.creditNote.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  async function seedTenant(label: string) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-b1052-${RUN}-${seq}-${label}`,
      "credit-note-double-spend-b1052.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `B1052 ${slug}` } });
    tenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `c ${label}`,
        contactName: `c ${label}`,
        tenantId: tenant.id,
      },
    });
    return { tenantId: tenant.id as string, customerId: customer.id as string };
  }

  /** An order with one DRAFT invoice of `total` (what the office invoice paths settle against). */
  async function seedOrderWithInvoice(tenantId: string, customerId: string, total: number) {
    seq += 1;
    const order = await prisma.order.create({
      data: { tenantId, customerId, status: "CONFIRMED", total },
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        orderId: order.id,
        invoiceNumber: `INV-B1052-${RUN}-${seq}`,
        status: "DRAFT",
        subtotal: total,
        total,
      },
    });
    return { orderId: order.id as string, invoiceId: invoice.id as string };
  }

  /** The order's credit intent, through the real writer (as orders.service does). */
  async function intend(
    tenantId: string,
    orderId: string,
    customerId: string,
    creditNoteId: string,
    amount?: number,
  ) {
    await tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction((tx) =>
        creditNotes.syncOrderCreditSelections(tx, orderId, customerId, [
          { creditNoteId, ...(amount != null ? { amount } : {}) },
        ]),
      ),
    );
  }

  /** settleOrderCreditsInTx in its own default-isolation tx, as the office invoice paths run it. */
  function settle(tenantId: string, orderId: string, barrier?: ReturnType<typeof makeBarrier>) {
    return tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction(
        (tx) =>
          creditNotes.settleOrderCreditsInTx(barrier ? readThenWait(tx, barrier) : tx, orderId),
        { timeout: 15_000 },
      ),
    );
  }

  /** The sweep (send-time oldest-first auto-apply) in its own default-isolation tx, as markSent runs it. */
  function sweep(
    tenantId: string,
    invoiceId: string,
    customerId: string,
    barrier?: ReturnType<typeof makeBarrier>,
  ) {
    return tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction(
        (tx) =>
          creditNotes.autoApplyOldestCreditsInTx(
            barrier ? readThenWait(tx, barrier, "findMany") : tx,
            invoiceId,
            customerId,
          ),
        { timeout: 15_000 },
      ),
    );
  }

  /** What a customer would see on an invoice: its status and what is still owed after live payments. */
  async function invoiceStateOf(invoiceId: string) {
    const inv = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { payments: true },
    });
    const paid =
      Math.round(
        inv!.payments
          .filter((p) => p.status !== "VOID")
          .reduce((sum, p) => sum + Number(p.amount), 0) * 100,
      ) / 100;
    return {
      status: inv!.status as string,
      total: Number(inv!.total),
      paid,
      balance: Math.round((Number(inv!.total) - paid) * 100) / 100,
    };
  }

  async function ledgerOf(creditNoteId: string) {
    const note = await prisma.creditNote.findUnique({ where: { id: creditNoteId } });
    const pays = await prisma.invoicePayment.findMany({
      where: { creditNoteId, method: "CREDIT_NOTE", status: { not: "VOID" } },
    });
    const byInvoice = new Map<string, number>();
    for (const p of pays) {
      byInvoice.set(p.invoiceId, (byInvoice.get(p.invoiceId) ?? 0) + Number(p.amount));
    }
    return {
      amount: Number(note!.amount),
      amountUsed: Number(note!.amountUsed),
      paid: Math.round(pays.reduce((s, p) => s + Number(p.amount), 0) * 100) / 100,
      byInvoice,
    };
  }

  it("two concurrent settles of one $100 note across two $100 invoices spend it ONCE", async () => {
    const { tenantId, customerId } = await seedTenant("race");
    const note = await tenantCtx.run(tenantId, () =>
      creditNotes.create({ customerId, amount: 100 } as any),
    );
    const a = await seedOrderWithInvoice(tenantId, customerId, 100);
    const b = await seedOrderWithInvoice(tenantId, customerId, 100);
    await intend(tenantId, a.orderId, customerId, note.id);
    await intend(tenantId, b.orderId, customerId, note.id);

    const barrier = makeBarrier();
    const results = await Promise.allSettled([
      settle(tenantId, a.orderId, barrier),
      settle(tenantId, b.orderId, barrier),
    ]);

    const ledger = await ledgerOf(note.id);
    // Observed numbers, printed for the PR's before/after record.
    console.log(
      `B1052 race: amount=${ledger.amount} amountUsed=${ledger.amountUsed} ` +
        `appliedOnInvoices=${ledger.paid} perInvoice=${JSON.stringify([...ledger.byInvoice.values()])} ` +
        `settles=${results.map((r) => r.status).join(",")}`,
    );
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(ledger.paid).toBe(100); // never 200
    expect(ledger.amountUsed).toBe(100);
    expect(ledger.amountUsed).toBe(ledger.paid);
    expect([...ledger.byInvoice.values()].sort()).toEqual([100]); // one invoice, not both
    // The invoice that LOST the race is still unpaid: not PAID, no credit on it, balance unchanged.
    const [winnerId] = [...ledger.byInvoice.keys()];
    const loserId = winnerId === a.invoiceId ? b.invoiceId : a.invoiceId;
    expect(await invoiceStateOf(winnerId)).toMatchObject({ status: "PAID", paid: 100, balance: 0 });
    const loser = await invoiceStateOf(loserId);
    expect(loser.status).not.toBe("PAID");
    expect(loser).toMatchObject({ paid: 0, balance: 100, total: 100 });
  }, 60_000);

  it("a shrink-restore racing an apply of the same note loses neither write", async () => {
    const { tenantId, customerId } = await seedTenant("restore");
    const note = await tenantCtx.run(tenantId, () =>
      creditNotes.create({ customerId, amount: 100 } as any),
    );
    // Order A: $60 of the note applied, then its invoice shrinks to $40 → settle(A) restores $20.
    const a = await seedOrderWithInvoice(tenantId, customerId, 100);
    await intend(tenantId, a.orderId, customerId, note.id, 60);
    await settle(tenantId, a.orderId);
    await prisma.invoice.update({
      where: { id: a.invoiceId },
      data: { total: 40, subtotal: 40 },
    });
    // Order B: wants whatever is left of the note.
    const b = await seedOrderWithInvoice(tenantId, customerId, 100);
    await intend(tenantId, b.orderId, customerId, note.id);
    expect((await ledgerOf(note.id)).amountUsed).toBe(60);

    const barrier = makeBarrier();
    const results = await Promise.allSettled([
      settle(tenantId, a.orderId, barrier),
      settle(tenantId, b.orderId, barrier),
    ]);

    const ledger = await ledgerOf(note.id);
    console.log(
      `B1052 restore race: amount=${ledger.amount} amountUsed=${ledger.amountUsed} ` +
        `appliedOnInvoices=${ledger.paid} perInvoice=${JSON.stringify(Object.fromEntries([...ledger.byInvoice].map(([k, v]) => [k === a.invoiceId ? "A" : "B", v])))} ` +
        `settles=${results.map((r) => r.status).join(",")}`,
    );
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(ledger.byInvoice.get(a.invoiceId)).toBe(40); // A shrank to $40 of credit
    expect(ledger.paid).toBeLessThanOrEqual(100);
    expect(ledger.amountUsed).toBe(ledger.paid); // the wallet agrees with the invoices
    // B takes whatever the note had left when it ran ($40 if it went before A's restore, $60
    // after) but never the whole $100 invoice, and it is never reported PAID.
    const stateB = await invoiceStateOf(b.invoiceId);
    expect(stateB.status).not.toBe("PAID");
    expect(stateB.paid).toBeLessThanOrEqual(60);
    expect(stateB.balance).toBe(100 - stateB.paid);
    expect(stateB.balance).toBeGreaterThan(0);
  }, 60_000);

  it("a send-time sweep racing a settle of the same note spends it once; the loser stays unpaid", async () => {
    const { tenantId, customerId } = await seedTenant("sweep");
    await prisma.tenantConfig.create({ data: { tenantId, creditAutoApplyOnSend: true } });
    const note = await tenantCtx.run(tenantId, () =>
      creditNotes.create({ customerId, amount: 100 } as any),
    );
    // Order A carries an intent for the note (settle path); invoice B has none (sweep path).
    const a = await seedOrderWithInvoice(tenantId, customerId, 100);
    const b = await seedOrderWithInvoice(tenantId, customerId, 100);
    await intend(tenantId, a.orderId, customerId, note.id);

    const barrier = makeBarrier();
    const results = await Promise.allSettled([
      settle(tenantId, a.orderId, barrier),
      sweep(tenantId, b.invoiceId, customerId, barrier),
    ]);

    const ledger = await ledgerOf(note.id);
    console.log(
      `B1052 sweep-vs-settle: amount=${ledger.amount} amountUsed=${ledger.amountUsed} ` +
        `appliedOnInvoices=${ledger.paid} settles=${results.map((r) => r.status).join(",")}`,
    );
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(ledger.paid).toBe(100); // never 200
    expect(ledger.amountUsed).toBe(ledger.paid);
    expect([...ledger.byInvoice.values()]).toEqual([100]); // exactly one invoice got the note
    const [winnerId] = [...ledger.byInvoice.keys()];
    const loserId = winnerId === a.invoiceId ? b.invoiceId : a.invoiceId;
    expect(await invoiceStateOf(winnerId)).toMatchObject({ status: "PAID", paid: 100, balance: 0 });
    const loser = await invoiceStateOf(loserId);
    expect(loser.status).not.toBe("PAID");
    expect(loser).toMatchObject({ paid: 0, balance: 100, total: 100 });
  }, 60_000);

  it("sequential settles (today's safe case) still spend it once", async () => {
    const { tenantId, customerId } = await seedTenant("seq");
    const note = await tenantCtx.run(tenantId, () =>
      creditNotes.create({ customerId, amount: 100 } as any),
    );
    const a = await seedOrderWithInvoice(tenantId, customerId, 100);
    const b = await seedOrderWithInvoice(tenantId, customerId, 100);
    await intend(tenantId, a.orderId, customerId, note.id);
    await intend(tenantId, b.orderId, customerId, note.id);

    expect(await settle(tenantId, a.orderId)).toEqual({ applied: 100, unapplied: 0 });
    expect(await settle(tenantId, b.orderId)).toEqual({ applied: 0, unapplied: 0 });
    const ledger = await ledgerOf(note.id);
    expect(ledger.paid).toBe(100);
    expect(ledger.amountUsed).toBe(100);
  }, 60_000);
});
