/**
 * SA-893 R4 (row 631), real Postgres: the house row-lock order is Return -> Order -> Invoice -> CreditNote
 * (`ROW_LOCK_ORDER`, common/db-locks.ts). Two paths took the inverse order and could deadlock (40P01):
 *
 *  (i)  customer merge `CustomersService.mergeCustomers` moves the loser's orders (implicit Order row locks) and invoices
 *       BEFORE `tx.return.updateMany` => Order -> Invoice -> Return, against inline `approve`
 *       (Return FOR UPDATE -> lockOrderRow => Return -> Order).
 *  (ii) `CreditNotesService.create(dto, { returnId })` with no Return held: lockOrderPoolRows (Order -> Invoice) + Invoice
 *       FOR UPDATE, then `tx.return.updateMany` on that Return => Order -> Invoice -> Return, against inline `issueCredit`
 *       (Return FOR UPDATE -> lockOrderRow -> settle).
 *
 * Each pair runs REPS times on fresh rows with a BARRIER so each transaction has taken ITS FIRST row lock before the other
 * proceeds (the inverse order is really exercised, never a timing guess):
 *   (i)  merge  : after its first `tx.order.updateMany` (Order rows locked); approve: after its `Return ... FOR UPDATE`.
 *   (ii) create : after the first raw statement of the tx = `Order ... FOR UPDATE` of `lockOrderPoolRows` (the order has two
 *                 creditable invoices, so the pool locks the Order); issueCredit: after its `Return ... FOR UPDATE`.
 * On the pre-fix tree the barrier released in every repetition (both sides held a first lock) and the inverse lock then
 * deadlocked: pair (i) 20/20, pair (ii) 19/20 (row 631 PR-1 evidence). Under the one order the second side blocks on the
 * Return BEFORE its barrier, so a barrier miss is the serialised outcome: it is logged, not asserted.
 *
 * A deadlock is counted where it is thrown: the wrapped `tenantTransaction` of each side records every 40P01 that leaves a
 * transaction body, BEFORE any caller-side retry (CreditNotesService.create retries a 40P01 up to 3 times and ends in a 409,
 * which would hide it). The server-side `pg_stat_database.deadlocks` delta is logged as a cross-check.
 *
 * Contract after the fix: zero 40P01 in every pair, and each side either succeeds or fails with a coded HttpException.
 *
 * Runs only under the DB lane (`jest.db.config.js`, RUN_DB_SPECS, a local DATABASE_URL). Tenants are throwaway
 * `qa-r4-631-<run>-<pair>` slugs approved by `assertTestTenant`; `afterAll` deletes them.
 */

jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({ getOrGenerate: jest.fn() })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { randomUUID } from "crypto";
import { HttpException, Logger } from "@nestjs/common";
import { Pool } from "pg";
import { InlineReturnsService } from "./inline-returns.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { CustomersService } from "../customers/customers.service";
import { NumberingService } from "../import/numbering.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { txConflictState } from "../common/tx-retry";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const REPS = 20;
const BARRIER_MS = 2_500;

function makeBarrier() {
  let arrived = 0;
  let released = false;
  let release!: () => void;
  const both = new Promise<void>((r) => (release = r));
  return {
    async arrive() {
      arrived += 1;
      if (arrived >= 2) {
        released = true;
        release();
      }
      await Promise.race([both, new Promise((r) => setTimeout(r, BARRIER_MS))]);
    },
    get bothArrived() {
      return released;
    },
  };
}
type Barrier = ReturnType<typeof makeBarrier>;

/** What one side of one repetition saw: 40P01s thrown out of its transaction bodies (before any retry). */
interface SideRecord {
  deadlocks: number;
  /** first-lock barrier already crossed (once per side per repetition, so a retry never re-waits) */
  crossed: boolean;
}
const newSide = (): SideRecord => ({ deadlocks: 0, crossed: false });

function isDeadlock(err: unknown): boolean {
  if (err instanceof HttpException) return false;
  const e = err as any;
  return (
    txConflictState(e) === "40P01" ||
    /40P01|deadlock detected/i.test(`${String(e)} ${e?.message ?? ""} ${safeJson(e?.meta)}`)
  );
}
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/** `tx`, except right AFTER its first raw SQL statement (a row-lock `SELECT ... FOR UPDATE`) it waits at `barrier`. */
function waitAfterFirstRaw(tx: any, barrier: Barrier, side: SideRecord) {
  const wrapRaw = (name: string) => {
    const orig = tx[name];
    return async (...args: unknown[]) => {
      const out = await orig.apply(tx, args);
      if (!side.crossed) {
        side.crossed = true;
        await barrier.arrive();
      }
      return out;
    };
  };
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === "$executeRaw" || prop === "$queryRaw") return wrapRaw(prop as string);
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** `tx`, except right AFTER its first `order.updateMany` (the Order rows it locked) it waits at `barrier`. */
function waitAfterFirstOrderUpdate(tx: any, barrier: Barrier, side: SideRecord) {
  const order = new Proxy(tx.order, {
    get(target, prop) {
      const value = target[prop];
      if (prop === "updateMany") {
        return async (args: unknown) => {
          const out = await value.call(target, args);
          if (!side.crossed) {
            side.crossed = true;
            await barrier.arrive();
          }
          return out;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === "order") return order;
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A PrismaService whose `tenantTransaction` instruments each transaction body and records its 40P01s. */
function instrument(prisma: PrismaService, wrapTx: (tx: any) => any, side: SideRecord): any {
  return new Proxy(prisma, {
    get(target: any, prop) {
      if (prop === "tenantTransaction") {
        return async (fn: (tx: any) => unknown, opts?: unknown) => {
          try {
            return await target.tenantTransaction((tx: any) => fn(wrapTx(tx)), opts);
          } catch (err) {
            if (isDeadlock(err)) side.deadlocks += 1;
            throw err;
          }
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describeDb(
  "SA-893 R4 (row 631): the inverse Order -> ... -> Return paths vs the Return -> Order paths never deadlock",
  () => {
    let prismaA: PrismaService; // the inline-returns side + seeding
    let prismaB: PrismaService; // the merge / credit-note side: a second pool = a second real connection
    let admin: Pool;
    let tenantCtx: TenantContextService;
    const tenantIds: string[] = [];
    let seq = 0;

    // The mocks every collaborator needs; none of them is a lock path under test.
    const anything: any = () =>
      new Proxy({}, { get: () => jest.fn().mockResolvedValue(undefined) });
    const gateway: any = {
      emitCreditNoteCreated: jest.fn(),
      emitInvoiceUpdated: jest.fn(),
    };

    function buildCreditNotes(p: PrismaService) {
      return new CreditNotesService(
        p,
        gateway,
        anything(),
        { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) } as any,
        new NumberingService(p),
      );
    }
    function buildInline(p: any, creditNotes: CreditNotesService, base: PrismaService) {
      return new InlineReturnsService(
        p,
        gateway,
        anything(),
        creditNotes,
        new NumberingService(base),
        { hasAddon: jest.fn().mockResolvedValue(true) } as any,
        {} as any,
        {} as any,
      );
    }

    beforeAll(async () => {
      const url = requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prismaA = new PrismaService(tenantCtx);
      prismaB = new PrismaService(tenantCtx);
      await prismaA.$connect();
      await prismaB.$connect();
      admin = new Pool({ connectionString: url });
    }, 120_000);

    afterAll(async () => {
      const swallow = () => undefined;
      for (const tenantId of tenantIds) {
        const where = { where: { tenantId } };
        await prismaA.invoicePayment.deleteMany(where).catch(swallow);
        await prismaA.orderCreditNote.deleteMany(where).catch(swallow);
        await prismaA.return.deleteMany(where).catch(swallow);
        await prismaA.creditNote.deleteMany(where).catch(swallow);
        await prismaA.invoice.deleteMany(where).catch(swallow);
        await prismaA.order.deleteMany(where).catch(swallow);
        await prismaA.customer.deleteMany(where).catch(swallow);
        await prismaA.user.deleteMany(where).catch(swallow);
        await prismaA.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      }
      await prismaA?.$disconnect();
      await prismaB?.$disconnect();
      await admin?.end();
    }, 120_000);

    async function newTenant(pair: string) {
      seq += 1;
      const slug = assertTestTenant(
        `qa-r4-631-${RUN}-${pair}`,
        "returns-lock-order-deadlock.db.spec.ts",
      );
      const tenant = await prismaA.tenant.create({ data: { slug, name: `R4 631 ${slug}` } });
      tenantIds.push(tenant.id);
      return tenant.id as string;
    }

    let rowSeq = 0;
    async function seedCustomer(tenantId: string, tag: string) {
      rowSeq += 1;
      const n = `${tag}-${RUN}-${rowSeq}`;
      const user = await prismaA.user.create({
        data: { email: `${n}@example.invalid`, username: n, role: "CUSTOMER", tenantId },
      });
      return prismaA.customer.create({
        data: { userId: user.id, businessName: n, contactName: n, tenantId },
      });
    }
    async function seedOrder(tenantId: string, customerId: string, invoices: number) {
      rowSeq += 1;
      const order = await prismaA.order.create({
        data: { tenantId, customerId, status: "CONFIRMED", total: 100 },
      });
      const invoiceIds: string[] = [];
      for (let i = 0; i < invoices; i++) {
        const inv = await prismaA.invoice.create({
          data: {
            tenantId,
            customerId,
            orderId: order.id,
            invoiceNumber: `INV-R4-${RUN}-${rowSeq}-${i}`,
            status: "DRAFT",
            subtotal: 100,
            total: 100,
          },
        });
        invoiceIds.push(inv.id);
      }
      return { orderId: order.id as string, invoiceIds };
    }
    async function seedReturn(
      tenantId: string,
      orderId: string,
      customerId: string,
      held: boolean,
    ) {
      rowSeq += 1;
      return (
        await prismaA.return.create({
          data: {
            tenantId,
            orderId,
            customerId,
            kind: "INLINE",
            status: "RECEIVED",
            reason: "DAMAGED",
            ...(held ? { holdReason: "DRIVER_CAP", heldAmount: 40 } : {}),
            creditSubtotal: 40,
            creditTax: 0,
            creditCategoryTax: 0,
            returnNumber: `RET-R4-${RUN}-${rowSeq}`,
          },
        })
      ).id as string;
    }

    async function serverDeadlocks(): Promise<number> {
      const { rows } = await admin.query(
        "SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()",
      );
      return Number(rows[0].n);
    }

    interface RepOutcome {
      barrierReleased: boolean;
      deadlockedA: number;
      deadlockedB: number;
      results: PromiseSettledResult<unknown>[];
    }

    /** Summarise a pair: log the observable line and return the facts the assertions use. */
    async function summarise(label: string, outcomes: RepOutcome[], before: number) {
      const deadlockedReps = outcomes.filter(
        (o) =>
          o.deadlockedA + o.deadlockedB > 0 ||
          o.results.some((r) => r.status === "rejected" && isDeadlock((r as any).reason)),
      ).length;
      // pg flushes backend stats lazily; give it a moment, then read the server's own counter.
      await new Promise((r) => setTimeout(r, 2_500));
      const serverDelta = (await serverDeadlocks()) - before;
      const notClean = outcomes.flatMap((o, i) =>
        o.results
          .map((r, side) => ({ r, side, rep: i + 1 }))
          .filter(
            ({ r }) =>
              r.status === "rejected" &&
              !((r as PromiseRejectedResult).reason instanceof HttpException),
          )
          .map(
            ({ r, side, rep }) =>
              `rep ${rep} side ${side === 0 ? "inline" : "other"}: ${String(
                (r as PromiseRejectedResult).reason,
              ).slice(0, 160)}`,
          ),
      );
      const barrierMisses = outcomes.filter((o) => !o.barrierReleased).length;
      // eslint-disable-next-line no-console
      console.log(
        `R4 pair ${label}: ${deadlockedReps}/${REPS} deadlocked ` +
          `(thrown 40P01s: inline=${outcomes.reduce((s, o) => s + o.deadlockedA, 0)} ` +
          `other=${outcomes.reduce((s, o) => s + o.deadlockedB, 0)}; ` +
          `server pg_stat_database.deadlocks delta=${serverDelta}; barrier missed ${barrierMisses}/${REPS})`,
      );
      return { deadlockedReps, notClean, barrierMisses, serverDelta };
    }

    it("pair (i): customer merge (Order -> Invoice -> Return) vs inline approve (Return -> Order), 20 reps, no 40P01", async () => {
      const tenantId = await newTenant("i");
      const primary = await seedCustomer(tenantId, "i-primary");
      const before = await serverDeadlocks();
      const outcomes: RepOutcome[] = [];

      for (let rep = 0; rep < REPS; rep++) {
        // The loser (secondary) owns the order, its invoice and the held return that approve touches.
        const secondary = await seedCustomer(tenantId, "i-secondary");
        const { orderId } = await seedOrder(tenantId, secondary.id, 1);
        const returnId = await seedReturn(tenantId, orderId, secondary.id, true);

        const barrier = makeBarrier();
        const approveSide = newSide();
        const mergeSide = newSide();
        const inlineSvc = buildInline(
          instrument(prismaA, (tx) => waitAfterFirstRaw(tx, barrier, approveSide), approveSide),
          buildCreditNotes(prismaA),
          prismaA,
        );
        const customers: CustomersService = Object.assign(
          Object.create(CustomersService.prototype),
          {
            prisma: instrument(
              prismaB,
              (tx) => waitAfterFirstOrderUpdate(tx, barrier, mergeSide),
              mergeSide,
            ),
            logger: new Logger("r4-customers"),
          },
        );

        const results = await Promise.allSettled([
          tenantCtx.run(tenantId, () =>
            inlineSvc.approve(returnId, { sub: primary.userId } as any),
          ),
          tenantCtx.run(tenantId, () => customers.mergeCustomers(primary.id, secondary.id)),
        ]);
        outcomes.push({
          barrierReleased: barrier.bothArrived,
          deadlockedA: approveSide.deadlocks,
          deadlockedB: mergeSide.deadlocks,
          results,
        });
      }

      const s = await summarise("(i)", outcomes, before);
      // The barrier proves the race on the pre-fix tree (each side holds its first lock, then the inverse one deadlocks:
      // 20/20 and 19/20 there). Under the one lock order the second side blocks on the Return BEFORE its barrier, so a
      // barrier miss is the serialised outcome, logged but not asserted.
      expect({ deadlockedReps: s.deadlockedReps, notClean: s.notClean }).toEqual({
        deadlockedReps: 0,
        notClean: [],
      });
    }, 600_000);

    it("pair (ii): credit-note create with returnId (Order -> Invoice -> Return) vs inline issueCredit (Return -> Order), 20 reps, no 40P01", async () => {
      const tenantId = await newTenant("ii");
      const customer = await seedCustomer(tenantId, "ii");
      const before = await serverDeadlocks();
      const outcomes: RepOutcome[] = [];

      for (let rep = 0; rep < REPS; rep++) {
        // Two creditable invoices on the order, so lockOrderPoolRows takes Order FOR UPDATE first (Order -> Invoice).
        const { orderId, invoiceIds } = await seedOrder(tenantId, customer.id, 2);
        const returnId = await seedReturn(tenantId, orderId, customer.id, false);

        const barrier = makeBarrier();
        const inlineSide = newSide();
        const cnSide = newSide();
        const inlineSvc = buildInline(
          instrument(prismaA, (tx) => waitAfterFirstRaw(tx, barrier, inlineSide), inlineSide),
          buildCreditNotes(prismaA),
          prismaA,
        );
        const cnSvc = buildCreditNotes(
          instrument(
            prismaB,
            (tx) => waitAfterFirstRaw(tx, barrier, cnSide),
            cnSide,
          ) as PrismaService,
        );

        const results = await Promise.allSettled([
          tenantCtx.run(tenantId, () => (inlineSvc as any).issueCredit(returnId)),
          tenantCtx.run(tenantId, () =>
            cnSvc.create(
              { customerId: customer.id, invoiceId: invoiceIds[0], amount: 40 },
              { returnId },
            ),
          ),
        ]);
        outcomes.push({
          barrierReleased: barrier.bothArrived,
          deadlockedA: inlineSide.deadlocks,
          deadlockedB: cnSide.deadlocks,
          results,
        });
      }

      const s = await summarise("(ii)", outcomes, before);
      // The barrier proves the race on the pre-fix tree (each side holds its first lock, then the inverse one deadlocks:
      // 20/20 and 19/20 there). Under the one lock order the second side blocks on the Return BEFORE its barrier, so a
      // barrier miss is the serialised outcome, logged but not asserted.
      expect({ deadlockedReps: s.deadlockedReps, notClean: s.notClean }).toEqual({
        deadlockedReps: 0,
        notClean: [],
      });
    }, 600_000);
  },
);
