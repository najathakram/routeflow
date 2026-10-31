/**
 * SA-1060 A-3 (B841), real Postgres: `approve()` locks what it books against.
 *
 * `approve()` locked its own Return and the CARRYING order, but `reverseLedgerForReturn` reads each line's remaining balance on
 * the SOURCE orders and books the regulated reversal there, and `reverseReturnEntries` takes no lock of its own. Two approvals on
 * different carrying orders and one source order both read the same remaining balance and both booked it: 12 of 10 reversed.
 * The fix (SA-1060 A-3): `lockCustomerInTx` as the tx's first statement, then the Return, then ONE `lockOrderRows` over the
 * carrying order and every source order (sorted, one statement).
 *
 * Rows (the ruling's table):
 *  L1  two held returns of 6 on two carrying orders, one source of 10, a BARRIER right before each reversal reads the balance:
 *      reversed 10 of 10 / $100 / $20, never 12 / $120 / $24. Goes green with either lock, so it is the end-to-end picture.
 *  L2  the SOURCE order's row lock is held by someone else: approve() waits for it. Proves the order set on its own
 *      (red if `lockOrderRows` names the carrying order alone).
 *  L3  the customer return lock is held by someone else: approve() waits for it. Proves the customer lock on its own
 *      (red if `lockCustomerInTx` is dropped). Capture takes that lock first, so this is what puts approve() in line with it.
 *  L4  approve(carrying X, source Y) against approve(carrying Y, source X): both finish, no 40P01 (the one sorted call).
 *  (L5, the pin, is in common/order-lock-callers.guard.spec.ts.)
 *
 * L2 and L3 use a held lock rather than a second racing writer: the lock either excludes or it doesn't, with no timing guess.
 *
 * Runs only under the DB lane (`jest.db.config.js`, RUN_DB_SPECS, a local DATABASE_URL). Tenants are throwaway
 * `qa-sa1060-a3-<run>-<n>` slugs approved by `assertTestTenant`; `afterAll` deletes them.
 */

jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({ getOrGenerate: jest.fn() })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { randomUUID } from "crypto";
import { HttpException } from "@nestjs/common";
import { InlineReturnsService } from "./inline-returns.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { IdempotencyService } from "../common/idempotency.service";
import { NumberingService } from "../import/numbering.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const BARRIER_MS = 1_000;
const HELD_WAIT_MS = 1_500;

function makeBarrier() {
  let inside = 0;
  let maxInside = 0;
  let release!: () => void;
  const both = new Promise<void>((r) => (release = r));
  return {
    async arrive() {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      if (inside >= 2) release();
      await Promise.race([both, new Promise((r) => setTimeout(r, BARRIER_MS))]);
      inside -= 1;
    },
    /** The most transactions at the barrier AT THE SAME TIME (2 means both read before either wrote). */
    get maxConcurrent() {
      return maxInside;
    },
  };
}
type Barrier = ReturnType<typeof makeBarrier>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "done" if `p` settles inside `ms`, else "waiting" (p keeps running). */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<"done" | "waiting"> {
  return Promise.race([
    p.then(
      () => "done" as const,
      () => "done" as const,
    ),
    sleep(ms).then(() => "waiting" as const),
  ]);
}

describeDb(
  "approve() locks the customer and every order it books against (SA-1060 A-3, B841)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let service: InlineReturnsService;
    let gate: Barrier | null = null;
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
      // The REAL ledger, except that a reversal waits at the barrier (when one is set) right BEFORE it reads the balance.
      const realLedger = new RegulatedLedgerService(prisma);
      const ledger: any = new Proxy(realLedger, {
        get(target: any, prop) {
          if (prop === "reverseReturnEntries") {
            return async (args: unknown) => {
              if (gate) await gate.arrive();
              return target.reverseReturnEntries(args);
            };
          }
          const value = target[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      service = new InlineReturnsService(
        prisma,
        { emitCreditNoteCreated: jest.fn() } as any,
        ledger,
        creditNotes,
        numbering,
        { hasAddon: jest.fn().mockResolvedValue(true) } as any,
        {} as any,
        new IdempotencyService(), // REAL: the customer lock is an advisory lock; a mock would make L3 vacuous
      );
    }, 120_000);

    afterEach(() => {
      gate = null;
    });

    afterAll(async () => {
      const swallow = () => undefined;
      for (const tenantId of tenantIds) {
        const where = { where: { tenantId } };
        await prisma.regulatedSalesLedger.deleteMany(where).catch(swallow);
        await prisma.invoicePayment.deleteMany(where).catch(swallow);
        await prisma.orderCreditNote.deleteMany(where).catch(swallow);
        await prisma.returnItem.deleteMany(where).catch(swallow);
        await prisma.return.deleteMany(where).catch(swallow);
        await prisma.creditNote.deleteMany(where).catch(swallow);
        await prisma.invoiceItem.deleteMany(where).catch(swallow);
        await prisma.invoice.deleteMany(where).catch(swallow);
        await prisma.orderItem.deleteMany(where).catch(swallow);
        await prisma.order.deleteMany(where).catch(swallow);
        await prisma.product.deleteMany(where).catch(swallow);
        await prisma.customer.deleteMany(where).catch(swallow);
        await prisma.user.deleteMany(where).catch(swallow);
        await prisma.trackedCategory.deleteMany(where).catch(swallow);
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      }
      await prisma?.$disconnect();
    }, 120_000);

    /** One tenant, one customer, one tracked product. Dummy goods only. */
    async function world() {
      seq += 1;
      const slug = assertTestTenant(
        `qa-sa1060-a3-${RUN}-${seq}`,
        "inline-return-approve-source-locks-sa1060.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({ data: { slug, name: `SA1060 A-3 ${slug}` } });
      tenantIds.push(tenant.id);
      const tenantId = tenant.id as string;
      const user = await prisma.user.create({
        data: {
          email: `${slug}@example.invalid`,
          username: slug,
          role: "CUSTOMER",
          tenantId,
        },
      });
      const customer = await prisma.customer.create({
        data: { userId: user.id, businessName: "c", contactName: "c", tenantId },
      });
      const category = await prisma.trackedCategory.create({
        data: { name: "Tobacco", taxType: "NONE", tenantId },
      });
      const product = await prisma.product.create({
        data: {
          name: `a3 product ${seq}`,
          unit: "each",
          pricePerUnit: "10.00",
          unitsPerBox: 1,
          trackedCategoryId: category.id,
          tenantId,
        },
      });
      let n = 0;
      const w = {
        tenantId,
        userId: user.id as string,
        customerId: customer.id as string,
        productId: product.id as string,
        categoryId: category.id as string,
        /** A delivered sale of 10 at $10: net $100, category tax $20, booked on the regulated ledger. */
        async sale(tag: string): Promise<string> {
          n += 1;
          const order = await prisma.order.create({
            data: {
              tenantId,
              customerId: w.customerId,
              status: "DELIVERED",
              subtotal: "100.00",
              total: "100.00",
            },
          });
          const orderItem = await prisma.orderItem.create({
            data: {
              orderId: order.id,
              productId: w.productId,
              status: "DELIVERED",
              qty: 10,
              unitPrice: "10.00",
              subtotal: "100.00",
              categoryTaxAmount: "20.00",
              trackedCategoryId: w.categoryId,
              tenantId,
            },
          });
          const invoice = await prisma.invoice.create({
            data: {
              invoiceNumber: `INV-A3-${RUN}-${seq}-${tag}-${n}`,
              customerId: w.customerId,
              orderId: order.id,
              status: "SENT",
              subtotal: "100.00",
              taxAmount: "20.00",
              total: "120.00",
              tenantId,
            },
          });
          const invoiceItem = await prisma.invoiceItem.create({
            data: {
              invoiceId: invoice.id,
              description: "a3 product",
              productId: w.productId,
              orderItemId: orderItem.id,
              qty: 10,
              unitPrice: "10.00",
              subtotal: "100.00",
              categoryTaxAmount: "20.00",
              trackedCategoryId: w.categoryId,
              tenantId,
            },
          });
          await prisma.regulatedSalesLedger.create({
            data: {
              tenantId,
              trackedCategoryId: w.categoryId,
              entryType: "SALE",
              orderId: order.id,
              orderItemId: orderItem.id,
              invoiceId: invoice.id,
              invoiceItemId: invoiceItem.id,
              qty: 10,
              unitBasisQty: 10,
              netSales: 100,
              categoryTax: 20,
              soldAt: new Date(),
              periodBucket: new Date().toISOString().slice(0, 7),
            },
          });
          return order.id as string;
        },
        /** A carrying order the credit lands on: open, with a draft invoice that takes the credit note. */
        async carrier(tag: string): Promise<string> {
          n += 1;
          const order = await prisma.order.create({
            data: { tenantId, customerId: w.customerId, status: "CONFIRMED", total: 100 },
          });
          await prisma.invoice.create({
            data: {
              tenantId,
              customerId: w.customerId,
              orderId: order.id,
              invoiceNumber: `INV-A3C-${RUN}-${seq}-${tag}-${n}`,
              status: "DRAFT",
              subtotal: 100,
              total: 100,
            },
          });
          return order.id as string;
        },
        /** A held INLINE return of `qty` pieces on `carryingId`, naming `sourceId` as the order the goods were sold on. */
        async held(carryingId: string, sourceId: string, qty: number): Promise<string> {
          n += 1;
          const amount = qty * 10;
          const ret = await prisma.return.create({
            data: {
              tenantId,
              orderId: carryingId,
              customerId: w.customerId,
              kind: "INLINE",
              status: "RECEIVED",
              reason: "DAMAGED",
              holdReason: "DRIVER_CAP",
              heldAmount: amount,
              creditSubtotal: amount,
              creditTax: 0,
              creditCategoryTax: 0,
              returnNumber: `RET-A3-${RUN}-${seq}-${n}`,
              items: {
                create: [
                  {
                    tenantId,
                    productId: w.productId,
                    qty,
                    restock: false,
                    sourceOrderId: sourceId,
                    unitPrice: "10.00",
                    subtotal: amount,
                  },
                ],
              },
            },
          });
          return ret.id as string;
        },
        approve(id: string) {
          return tenantCtx.run(tenantId, () => service.approve(id, { sub: w.userId } as any));
        },
        async reversed(orderId: string) {
          const rows = await prisma.regulatedSalesLedger.findMany({
            where: { tenantId, orderId, entryType: "REVERSAL" },
          });
          const sum = (f: "qty" | "netSales" | "categoryTax") =>
            rows.reduce((s: number, r: any) => s + Number(r[f]), 0);
          return { qty: sum("qty"), net: sum("netSales"), tax: sum("categoryTax") };
        },
        async statuses(ids: string[]) {
          const rows = await prisma.return.findMany({ where: { id: { in: ids } } });
          return ids.map((id) => rows.find((r: any) => r.id === id)?.status);
        },
      };
      return w;
    }

    /** Hold `lock` inside an open tenant transaction until `release()`; resolves once the lock is held. */
    async function holdLock(
      tenantId: string,
      lock: (tx: any) => Promise<void>,
    ): Promise<{ release: () => Promise<void> }> {
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      let open!: () => void;
      const gateOpen = new Promise<void>((r) => (open = r));
      const holder = tenantCtx.run(tenantId, () =>
        prisma.tenantTransaction(async (tx: any) => {
          await lock(tx);
          locked();
          await gateOpen;
        }),
      );
      await isLocked;
      return {
        release: async () => {
          open();
          await holder;
        },
      };
    }

    it("L1: two approvals on two carrying orders and one source reverse 10 of 10 ($100, $20), never 12 ($120, $24)", async () => {
      const w = await world();
      const source = await w.sale("src");
      const c1 = await w.carrier("c1");
      const c2 = await w.carrier("c2");
      const r1 = await w.held(c1, source, 6);
      const r2 = await w.held(c2, source, 6);

      gate = makeBarrier();
      const barrier = gate;
      const results = await Promise.allSettled([w.approve(r1), w.approve(r2)]);

      const deadlocks = results.filter(
        (r) =>
          r.status === "rejected" &&
          !((r as PromiseRejectedResult).reason instanceof HttpException) &&
          /40P01|deadlock detected/i.test(String((r as PromiseRejectedResult).reason)),
      );
      expect(deadlocks).toEqual([]);
      expect(
        results
          .filter((r) => r.status === "rejected")
          .map((r) => String((r as PromiseRejectedResult).reason)),
      ).toEqual([]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      // The second approval waited at the lock, so it was never at the barrier with the first: both never read before either wrote.
      expect(barrier.maxConcurrent).toBe(1);
      expect(await w.reversed(source)).toEqual({ qty: -10, net: -100, tax: -20 });
      expect(await w.statuses([r1, r2])).toEqual(["REFUNDED", "REFUNDED"]);
    }, 90_000);

    it("L2: approve() waits while the SOURCE order's row lock is held, then books (proves lockOrderRows names the source)", async () => {
      const w = await world();
      const source = await w.sale("src");
      const carrying = await w.carrier("c1");
      const held = await w.held(carrying, source, 6);

      const holder = await holdLock(w.tenantId, async (tx) => {
        await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${source} FOR UPDATE`;
      });
      const approval = w.approve(held);
      try {
        expect(await settledWithin(approval, HELD_WAIT_MS)).toBe("waiting");
        expect(await w.statuses([held])).toEqual(["RECEIVED"]);
      } finally {
        await holder.release();
      }
      await expect(approval).resolves.toBeDefined();
      expect(await w.statuses([held])).toEqual(["REFUNDED"]);
      expect(await w.reversed(source)).toEqual({ qty: -6, net: -60, tax: -12 });
    }, 60_000);

    it("L3: approve() waits while the customer return lock is held, then books (proves lockCustomerInTx, the lock capture takes)", async () => {
      const w = await world();
      const source = await w.sale("src");
      const carrying = await w.carrier("c1");
      const held = await w.held(carrying, source, 6);

      const holder = await holdLock(w.tenantId, (tx) => service.lockCustomerInTx(tx, w.customerId));
      const approval = w.approve(held);
      try {
        expect(await settledWithin(approval, HELD_WAIT_MS)).toBe("waiting");
        expect(await w.statuses([held])).toEqual(["RECEIVED"]);
      } finally {
        await holder.release();
      }
      await expect(approval).resolves.toBeDefined();
      expect(await w.statuses([held])).toEqual(["REFUNDED"]);
    }, 60_000);

    it("L4: approve(carrying X, source Y) against approve(carrying Y, source X) both finish, no 40P01", async () => {
      const w = await world();
      const x = await w.sale("x");
      const y = await w.sale("y");
      const a = await w.held(x, y, 3);
      const b = await w.held(y, x, 3);

      gate = makeBarrier();
      const results = await Promise.allSettled([w.approve(a), w.approve(b)]);

      const deadlocks = results.filter(
        (r) =>
          r.status === "rejected" &&
          !((r as PromiseRejectedResult).reason instanceof HttpException) &&
          /40P01|deadlock detected/i.test(String((r as PromiseRejectedResult).reason)),
      );
      expect(deadlocks).toEqual([]);
      expect(
        results
          .filter((r) => r.status === "rejected")
          .map((r) => String((r as PromiseRejectedResult).reason)),
      ).toEqual([]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(await w.statuses([a, b])).toEqual(["REFUNDED", "REFUNDED"]);
      expect(await w.reversed(y)).toEqual({ qty: -3, net: -30, tax: -6 });
      expect(await w.reversed(x)).toEqual({ qty: -3, net: -30, tax: -6 });
    }, 90_000);
  },
);
