/**
 * W-757 — real-Postgres proof that the credit-restore paths take Order -> Invoice BEFORE the CreditNote
 * row (house lock order, ROW_LOCK_ORDER in common/db-locks.ts: Order -> Invoice -> CreditNote).
 *
 * `CreditNotesService.restoreCreditFromPaymentInTx` deletes the InvoicePayment, then locks the CreditNote
 * (FOR NO KEY UPDATE), then updates the Invoice (implicit row lock): CreditNote -> Invoice, the inverse
 * of an Order -> Invoice -> CreditNote writer (markSent's sweep, applyToInvoice). Two callers reach it
 * without holding the Invoice first:
 *   P1  `unapplyFromInvoice(creditNoteId, invoiceId)`: locks nothing before the restore.
 *   P2  `InlineReturnsService.cancel` of a REFUNDED return whose credit note paid an invoice of a
 *       DIFFERENT order: the cancel's lockLedgerDocumentRows set covers the carrying order, not that invoice.
 *
 * Each rep is one deterministic interleaving on two connections:
 *   1. the WRITER (raw `pg`) takes the Order, then the Invoice FOR UPDATE (the Order -> Invoice prefix);
 *   2. the SERVICE starts; a barrier waits until Postgres reports it BLOCKED by the writer
 *      (`pg_blocking_pids`), so the interleaving is real, never a timing guess;
 *   3. only then does the writer take the CreditNote FOR NO KEY UPDATE and commit.
 * Master: the service already holds the CreditNote when it blocks on the Invoice, so step 3 closes a
 * cycle and Postgres aborts one side with 40P01 (P1 may retry internally; the server counter is the
 * authoritative count). Fixed: the service blocks on Order/Invoice before the note, the writer gets it,
 * and both finish.
 *
 * Contract (written for the FIXED tree): zero deadlocked reps, zero server deadlocks and zero errored reps per pair.
 *
 * WHY THE DB LANE: row locks and deadlock detection exist only in a real Postgres. Collected only by
 * `jest.db.config.js` (`.db.spec.ts$`); run via `npm run local:test:db`.
 *
 * SAFETY: throwaway `qa-w757-<run>-p1|p2` tenants (`assertTestTenant`); `afterAll` deletes exactly
 * those tenants' rows, in FK order. No live tenant is touched.
 */

jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({ getOrGenerate: jest.fn() })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CreditNotesService } from "./credit-notes.service";
import { InlineReturnsService } from "../returns/inline-returns.service";
import { NumberingService } from "../import/numbering.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const REPS = 20;

/** The SQLSTATE behind an error from either side: a raw `pg` error, or Prisma's P2034 / adapter error. */
function sqlState(err: any): string | undefined {
  return (
    err?.meta?.driverAdapterError?.cause?.originalCode ?? err?.cause?.originalCode ?? err?.code
  );
}
function isDeadlock(err: unknown): boolean {
  const e = err as any;
  return (
    sqlState(e) === "40P01" || /40P01|deadlock detected/i.test(`${String(e)} ${e?.message ?? ""}`)
  );
}
function describeErr(err: unknown): string {
  return err === undefined
    ? "none"
    : `${sqlState(err) ?? "?"}: ${String((err as any)?.message ?? err).slice(0, 120)}`;
}

describeDb(
  "W757 — restore-credit takes Order -> Invoice before the CreditNote: no 40P01 against an Order -> Invoice -> CreditNote writer",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let creditNotes: CreditNotesService;
    let inlineSvc: InlineReturnsService;
    const run = randomUUID().slice(0, 8);
    const tenantIds: string[] = [];
    let rowSeq = 0;

    const anything: any = () =>
      new Proxy({}, { get: () => jest.fn().mockResolvedValue(undefined) });
    const gateway: any = { emitCreditNoteCreated: jest.fn(), emitInvoiceUpdated: jest.fn() };

    async function newTenant(pair: string) {
      const slug = assertTestTenant(
        `qa-w757-${run}-${pair}`,
        "restore-credit-lock-order.db.spec.ts",
      );
      const tenant = await raw.tenant.create({ data: { slug, name: `W757 ${slug}` } });
      tenantIds.push(tenant.id);
      return tenant.id as string;
    }
    async function seedCustomer(tenantId: string, tag: string) {
      rowSeq += 1;
      const n = `${tag}-${run}-${rowSeq}`;
      const user = await raw.user.create({
        data: { email: `${n}@example.invalid`, username: n, role: "CUSTOMER", tenantId },
      });
      const customer = await raw.customer.create({
        data: { userId: user.id, businessName: n, contactName: n, tenantId },
      });
      return { customerId: customer.id as string, userId: user.id as string };
    }
    async function seedOrderWithInvoice(tenantId: string, customerId: string) {
      rowSeq += 1;
      const order = await raw.order.create({
        data: { customerId, status: "CONFIRMED", subtotal: "100.00", total: "100.00", tenantId },
      });
      const invoice = await raw.invoice.create({
        data: {
          invoiceNumber: `INV-W757-${run}-${rowSeq}`,
          customerId,
          orderId: order.id,
          status: "PARTIAL",
          subtotal: "100.00",
          total: "100.00",
          tenantId,
        },
      });
      return { orderId: order.id as string, invoiceId: invoice.id as string };
    }
    async function seedCreditNote(
      tenantId: string,
      customerId: string,
      amount: string,
      amountUsed: string,
      status: "ISSUED" | "APPLIED",
    ) {
      rowSeq += 1;
      return (
        await raw.creditNote.create({
          data: {
            creditNoteNumber: `CN-W757-${run}-${rowSeq}`,
            customerId,
            amount,
            amountUsed,
            status,
            tenantId,
          },
        })
      ).id as string;
    }
    async function seedCreditPayment(
      tenantId: string,
      invoiceId: string,
      creditNoteId: string,
      amount: string,
    ) {
      await raw.invoicePayment.create({
        data: { invoiceId, amount, method: "CREDIT_NOTE", creditNoteId, status: "PAID", tenantId },
      });
    }

    async function serverDeadlocks(): Promise<number> {
      const { rows } = await pool.query(
        "SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()",
      );
      return Number(rows[0].n);
    }

    /** Polls until some backend is blocked by `blockerPid`; false if `done()` or the deadline comes first. */
    async function waitUntilBlockedBy(blockerPid: number, done: () => boolean): Promise<boolean> {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !done()) {
        const { rows } = await pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
          [blockerPid],
        );
        if (rows[0].n > 0) return true;
        await new Promise((r) => setTimeout(r, 20));
      }
      return false;
    }

    interface Rep {
      blocked: boolean;
      writer: unknown;
      service: unknown;
    }

    /** Steps 1-3 of the header against `service`. Every failure is captured, never thrown early. */
    async function raceAgainstOrderInvoiceCreditWriter(
      ids: { orderId: string; invoiceId: string; creditNoteId: string },
      service: () => Promise<unknown>,
    ): Promise<Rep> {
      const writer = await pool.connect();
      let writerError: unknown;
      let serviceError: unknown;
      let blocked = false;
      try {
        await writer.query("BEGIN");
        await writer.query("SET LOCAL lock_timeout = '15s'");
        const pid = Number((await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await writer.query('SELECT id FROM "Order" WHERE id = $1 FOR UPDATE', [ids.orderId]);
        await writer.query('SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE', [ids.invoiceId]);

        let settled = false;
        const running = service()
          .then(
            () => undefined,
            (err) => {
              serviceError = err;
            },
          )
          .finally(() => {
            settled = true;
          });
        blocked = await waitUntilBlockedBy(pid, () => settled);

        try {
          await writer.query('SELECT id FROM "CreditNote" WHERE id = $1 FOR NO KEY UPDATE', [
            ids.creditNoteId,
          ]);
          await writer.query("COMMIT");
        } catch (err) {
          writerError = err;
          await writer.query("ROLLBACK").catch(() => undefined);
        }
        await running;
      } finally {
        writer.release();
      }
      return { blocked, writer: writerError, service: serviceError };
    }

    async function summarise(label: string, reps: Rep[], before: number) {
      const deadlockedReps = reps.filter(
        (r) => isDeadlock(r.writer) || isDeadlock(r.service),
      ).length;
      // pg flushes backend stats lazily; give it a moment, then read the server's own counter.
      await new Promise((r) => setTimeout(r, 2_500));
      const serverDelta = (await serverDeadlocks()) - before;
      const tally = (pick: (r: Rep) => unknown) => {
        const m = new Map<string, number>();
        for (const r of reps) {
          const e = pick(r);
          if (e === undefined) continue;
          const k = sqlState(e) ?? "?";
          m.set(k, (m.get(k) ?? 0) + 1);
        }
        return m.size ? [...m].map(([k, n]) => `${k}x${n}`).join(",") : "none";
      };
      const sample = reps.map((r) => r.service).find((e) => e !== undefined);
      // eslint-disable-next-line no-console
      console.log(
        `W757 ${label}: ${deadlockedReps}/${REPS} reps deadlocked (server deadlocks delta=${serverDelta}; ` +
          `service errors=${tally((r) => r.service)}; writer errors=${tally((r) => r.writer)}; ` +
          `blocked ${reps.filter((r) => r.blocked).length}/${REPS})` +
          (sample ? ` [first service error ${describeErr(sample)}]` : ""),
      );
      // Both sides must also FINISH: a non-deadlock failure (a lock timeout, a refusal) is not a pass either.
      const erroredReps = reps.filter(
        (r) => r.writer !== undefined || r.service !== undefined,
      ).length;
      return { deadlockedReps, serverDelta, erroredReps };
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();

      creditNotes = new CreditNotesService(
        prisma,
        gateway,
        anything(),
        { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) } as any,
        new NumberingService(prisma),
      );
      inlineSvc = new InlineReturnsService(
        prisma,
        gateway,
        anything(),
        creditNotes,
        new NumberingService(prisma),
        { hasAddon: jest.fn().mockResolvedValue(true) } as any,
        {} as any,
        {} as any,
      );
    }, 120_000);

    afterAll(async () => {
      const swallow = () => undefined;
      for (const tenantId of tenantIds) {
        const where = { where: { tenantId } };
        await raw.creditNoteApplyBlock.deleteMany(where).catch(swallow);
        await raw.invoicePayment.deleteMany(where).catch(swallow);
        await raw.orderCreditNote.deleteMany(where).catch(swallow);
        await raw.returnItem.deleteMany({ where: { return: { tenantId } } }).catch(swallow);
        await raw.return.deleteMany(where).catch(swallow);
        await raw.creditNote.deleteMany(where).catch(swallow);
        await raw.invoice.deleteMany(where).catch(swallow);
        await raw.order.deleteMany(where).catch(swallow);
        await raw.customer.deleteMany(where).catch(swallow);
        await raw.user.deleteMany(where).catch(swallow);
        await raw.tenant.deleteMany({ where: { id: tenantId } }).catch(swallow);
      }
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    it("P1: unapplyFromInvoice vs an Order -> Invoice -> CreditNote writer, 20 reps, no 40P01", async () => {
      const tenantId = await newTenant("p1");
      const before = await serverDeadlocks();
      const reps: Rep[] = [];

      for (let i = 0; i < REPS; i++) {
        const { customerId } = await seedCustomer(tenantId, "p1");
        const { orderId, invoiceId } = await seedOrderWithInvoice(tenantId, customerId);
        const creditNoteId = await seedCreditNote(
          tenantId,
          customerId,
          "100.00",
          "20.00",
          "ISSUED",
        );
        await seedCreditPayment(tenantId, invoiceId, creditNoteId, "20.00");

        reps.push(
          await raceAgainstOrderInvoiceCreditWriter({ orderId, invoiceId, creditNoteId }, () =>
            tenantCtx.run(tenantId, () => creditNotes.unapplyFromInvoice(creditNoteId, invoiceId)),
          ),
        );
      }

      const s = await summarise("P1", reps, before);
      expect({
        deadlockedReps: s.deadlockedReps,
        serverDelta: s.serverDelta,
        erroredReps: s.erroredReps,
      }).toEqual({ deadlockedReps: 0, serverDelta: 0, erroredReps: 0 });
    }, 600_000);

    it("P2: cancel of a REFUNDED return whose note paid another order's invoice vs an Order -> Invoice -> CreditNote writer, 20 reps, no 40P01", async () => {
      const tenantId = await newTenant("p2");
      const before = await serverDeadlocks();
      const reps: Rep[] = [];

      for (let i = 0; i < REPS; i++) {
        const { customerId, userId } = await seedCustomer(tenantId, "p2");
        const a = await seedOrderWithInvoice(tenantId, customerId); // the return's carrying order
        const b = await seedOrderWithInvoice(tenantId, customerId); // the order the note paid
        const creditNoteId = await seedCreditNote(
          tenantId,
          customerId,
          "20.00",
          "20.00",
          "APPLIED",
        );
        await seedCreditPayment(tenantId, b.invoiceId, creditNoteId, "20.00");
        rowSeq += 1;
        const ret = await raw.return.create({
          data: {
            tenantId,
            orderId: a.orderId,
            customerId,
            kind: "INLINE",
            status: "REFUNDED",
            reason: "DAMAGED",
            creditNoteId,
            refundMethod: "CREDIT_NOTE",
            creditSubtotal: 20,
            creditTax: 0,
            creditCategoryTax: 0,
            returnNumber: `RET-W757-${run}-${rowSeq}`,
          },
        });

        reps.push(
          await raceAgainstOrderInvoiceCreditWriter(
            { orderId: b.orderId, invoiceId: b.invoiceId, creditNoteId },
            () => tenantCtx.run(tenantId, () => inlineSvc.cancel(ret.id, { sub: userId } as any)),
          ),
        );
      }

      const s = await summarise("P2", reps, before);
      expect({
        deadlockedReps: s.deadlockedReps,
        serverDelta: s.serverDelta,
        erroredReps: s.erroredReps,
      }).toEqual({ deadlockedReps: 0, serverDelta: 0, erroredReps: 0 });
    }, 600_000);
  },
);
