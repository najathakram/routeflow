/**
 * SA-706c (d), real Postgres: two inline-return approvals on ONE order commit — no 40P01, both
 * credits correct.
 *
 * `approve()` locked only its own Return row, then `issueCreditInTx` inserted an `OrderCreditNote`
 * (FK KEY SHARE on the Order) and settle's `lockOrderCreditSettle` upgraded that to `Order FOR
 * UPDATE`. Two approvals of two held returns on the same order each held KEY SHARE and waited on
 * the other's upgrade: Postgres killed one with 40P01, an uncoded 500, with no retry. The fix takes
 * the Order lock right after the Return lock (house order Return -> Order).
 *
 * The interleave is forced with a BARRIER right after each transaction's intent insert, so both
 * transactions hold the Order KEY SHARE before either one settles. Pre-fix both reach it and
 * deadlock at settle; fixed, the second approval is still waiting on the Order lock (its barrier
 * times out) while the first commits, then it runs on the committed state.
 *
 * Runs only under the DB lane (`jest.db.config.js`, RUN_DB_SPECS, a local DATABASE_URL). Tenants are
 * throwaway `qa-sa706c-<run>-<n>` slugs approved by `assertTestTenant`; `afterAll` deletes them.
 */

jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({ getOrGenerate: jest.fn() })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { randomUUID } from "crypto";
import { HttpException } from "@nestjs/common";
import { InlineReturnsService } from "./inline-returns.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const BARRIER_MS = 1_500;

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

/** `tx`, except right AFTER its first `orderCreditNote.create` it waits at `barrier`. */
function waitAfterIntentInsert(tx: any, barrier: ReturnType<typeof makeBarrier>) {
  let waited = false;
  const orderCreditNote = new Proxy(tx.orderCreditNote, {
    get(target, prop) {
      const value = target[prop];
      if (prop === "create") {
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
      if (prop === "orderCreditNote") return orderCreditNote;
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describeDb("inline-return approvals lock the Order before the intent insert (SA-706c)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: InlineReturnsService;
  const barrier = makeBarrier();
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const numbering = new NumberingService(prisma);
    const anything = new Proxy({}, { get: () => jest.fn().mockResolvedValue(undefined) });
    const creditNotes = new CreditNotesService(
      prisma,
      { emitCreditNoteCreated: jest.fn(), emitInvoiceUpdated: jest.fn() } as any,
      anything as any,
      { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) } as any,
      numbering,
    );
    // The barrier sits between each approval's intent insert and its settle: wrap the tenant tx.
    const wrapped: any = new Proxy(prisma, {
      get(target: any, prop) {
        if (prop === "tenantTransaction") {
          return (fn: (tx: any) => unknown, opts?: unknown) =>
            target.tenantTransaction((tx: any) => fn(waitAfterIntentInsert(tx, barrier)), opts);
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    service = new InlineReturnsService(
      wrapped,
      { emitCreditNoteCreated: jest.fn() } as any,
      anything as any,
      creditNotes,
      numbering,
      { hasAddon: jest.fn().mockResolvedValue(true) } as any,
      {} as any,
      {} as any,
    );
  });

  afterAll(async () => {
    const swallow = () => undefined;
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.orderCreditNote.deleteMany(where).catch(swallow);
      await prisma.return.deleteMany(where).catch(swallow);
      await prisma.creditNote.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  async function seed() {
    seq += 1;
    const slug = assertTestTenant(
      `qa-sa706c-${RUN}-${seq}`,
      "inline-return-approve-order-lock-sa706c.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA706c ${slug}` } });
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
      data: { userId: user.id, businessName: "c", contactName: "c", tenantId: tenant.id },
    });
    const order = await prisma.order.create({
      data: { tenantId: tenant.id, customerId: customer.id, status: "CONFIRMED", total: 100 },
    });
    await prisma.invoice.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        orderId: order.id,
        invoiceNumber: `INV-SA706C-${RUN}-${seq}`,
        status: "DRAFT",
        subtotal: 100,
        total: 100,
      },
    });
    const held = async (n: number) =>
      (
        await prisma.return.create({
          data: {
            tenantId: tenant.id,
            orderId: order.id,
            customerId: customer.id,
            kind: "INLINE",
            status: "RECEIVED",
            reason: "DAMAGED",
            holdReason: "DRIVER_CAP",
            heldAmount: 40,
            creditSubtotal: 40,
            creditTax: 0,
            creditCategoryTax: 0,
            returnNumber: `RET-SA706C-${RUN}-${seq}-${n}`,
          },
        })
      ).id as string;
    return {
      tenantId: tenant.id as string,
      orderId: order.id as string,
      customerId: customer.id as string,
      userId: user.id as string,
      r1: await held(1),
      r2: await held(2),
    };
  }

  it("two approvals of two held returns on one order both commit: no 40P01, two credits of $40, $80 applied", async () => {
    const s = await seed();
    const approve = (id: string) =>
      tenantCtx.run(s.tenantId, () => service.approve(id, { sub: s.userId } as any));

    const results = await Promise.allSettled([approve(s.r1), approve(s.r2)]);

    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    // pre-fix: one approval is a deadlock victim (a bare DB error, never an HttpException)
    expect(
      failed.filter(
        (r) =>
          !(r.reason instanceof HttpException) && /40P01|deadlock detected/i.test(String(r.reason)),
      ),
    ).toEqual([]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);

    const returns = await prisma.return.findMany({ where: { orderId: s.orderId } });
    expect(returns.map((r) => r.status)).toEqual(["REFUNDED", "REFUNDED"]);
    const notes = await prisma.creditNote.findMany({ where: { customerId: s.customerId } });
    expect(notes.map((n) => Number(n.amount))).toEqual([40, 40]);
    // The order's $100 invoice takes both intents: $80 applied, each note fully used.
    const payments = await prisma.invoicePayment.findMany({
      where: { method: "CREDIT_NOTE", status: { not: "VOID" }, invoice: { orderId: s.orderId } },
    });
    expect(payments.reduce((sum, p) => sum + Number(p.amount), 0)).toBe(80);
    expect(notes.map((n) => Number(n.amountUsed))).toEqual([40, 40]);
  }, 60_000);
});
