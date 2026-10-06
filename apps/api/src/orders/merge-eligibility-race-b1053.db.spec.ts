/**
 * B1053 (SA-704) — the pending-order merge reads eligibility OUTSIDE its write transaction, so a writer
 * that does not take the order-merge advisory lock (cancel, route assignment, invoice insert, a line
 * edit) can make a loser ineligible after the read; the merge then folds its stale lines into the
 * winner and DELETES it by id. The Invoice -> Order FK is ON DELETE SET NULL, so a racing invoice is
 * silently orphaned.
 *
 * Deterministic interleave (no sleeps): `jest.spyOn(service, "getTaxRate")` runs the racing write and
 * COMMITS it on its own pg connection BEFORE returning, i.e. after the merge's eligibility read and
 * before its transaction. The holder probes keep a writer's lock UNCOMMITTED, start the merge, and poll
 * `pg_blocking_pids` (<= 4000 ms, always under Prisma's 5 s tx timeout, counting ALL blocked backends);
 * every assertion is on the OUTCOME, never a timing.
 *
 * Fixtures use the REAL writers where one is cheap (OrdersService.create for the orders and their stock
 * decrement, OrdersService.changeStatus for the cancel); the invoice / route rows are the racing
 * writer's committed effect. Every fixture line has deliveredQty = 0. Assertions target the FIXED
 * behaviour, so on master each REG test fails on the bug's own wrong value.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host; the tenant is a throwaway `qa-b1053-<run>`
 * slug approved by `assertTestTenant`; `afterAll` deletes exactly the rows this run created.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client, Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import { isMergeContention } from "./merge-contention";
import { mergeEligibleWhere } from "./merge-lock-recheck";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const INITIAL_STOCK = 100;
const WQ = 3; // winner qty
const LQ = 4; // loser qty

describeDb("B1053 pending-order merge vs a racing writer — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-b1053-${run}`, "merge-eligibility-race-b1053.db.spec.ts");
  let tenantId = "";
  let operatorUserId = "";
  let customerId = "";
  let productId = "";
  let seq = 0;

  const operator = (): JwtPayload =>
    ({
      sub: operatorUserId,
      username: `op-${run}`,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  const inTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const pgClient = async () => {
    const c = new Client({ connectionString: requireLocalDatabaseUrl() });
    await c.connect();
    return c;
  };
  /** Run `sql` on its OWN connection and COMMIT before returning (the racing writer's effect). */
  const commitedWrite = async (sql: string, params: unknown[] = []) => {
    const c = await pgClient();
    try {
      await c.query(sql, params);
    } finally {
      await c.end();
    }
  };

  /** A real staff create (real stock decrement); the winner is created LAST so it is the newest. */
  const createOrder = async (qty: number) => {
    const created: any = await inTenant(() =>
      orders.create({ customerId, items: [{ productId, qty }] }, operator(), {
        skipAutoMerge: true,
      }),
    );
    await raw.orderItem.updateMany({ where: { orderId: created.id }, data: { deliveredQty: 0 } });
    // create({ skipAutoMerge }) PERSISTS the flag, which would make the order a non-candidate
    await raw.order.update({ where: { id: created.id }, data: { skipAutoMerge: false } });
    return created.id as string;
  };
  const pair = async () => {
    const loser = await createOrder(LQ);
    const winner = await createOrder(WQ);
    // harness integrity: both orders must BE 'auto' merge candidates (the real predicate) before any race
    // step; otherwise every merge is a silent no-op that looks like a PIN failure
    expect(
      await raw.order.count({
        where: { id: { in: [loser, winner] }, customerId, ...mergeEligibleWhere("auto") },
      }),
    ).toBe(2);
    return { loser, winner };
  };

  const insertInvoice = async (orderId: string, status: string, client?: Client) => {
    const id = randomUUID();
    const sql = `INSERT INTO "Invoice" (id, "invoiceNumber", "customerId", status, subtotal, total, "orderId", "tenantId", "updatedAt")
                 VALUES ($1, $2, $3, $4::"InvoiceStatus", 10, 10, $5, $6, now())`;
    const params = [id, `B1053-${run}-${++seq}`, customerId, status, orderId, tenantId];
    if (client) await client.query(sql, params);
    else await commitedWrite(sql, params);
    return id;
  };

  const mergeAuto = () => inTenant(() => orders.mergeAllPendingForCustomer(customerId, {}));
  const mergeForce = () => inTenant(() => orders.forceConsolidateCustomer(customerId));
  /** Errors thrown by a race callback (it runs inside the merge's getTaxRate, so a throw would abort the merge). */
  let raceErrors: unknown[] = [];
  /** Run `race` after the merge's eligibility read, before its transaction; a throw is RECORDED, never swallowed. */
  const raceBeforeTx = (race: () => Promise<void>) => {
    const orig = (OrdersService.prototype as any).getTaxRate;
    return jest.spyOn(orders, "getTaxRate").mockImplementationOnce(async () => {
      try {
        await race();
      } catch (e) {
        raceErrors.push(e);
      }
      return orig.call(orders);
    });
  };
  const expectRaceClean = () => expect(raceErrors).toEqual([]);

  const qtyOf = async (orderId: string) =>
    (await raw.orderItem.findMany({ where: { orderId, status: { not: "CANCELLED" } } })).reduce(
      (s, li) => s + Number(li.qty),
      0,
    );
  const stockNow = async () =>
    Number((await raw.product.findUniqueOrThrow({ where: { id: productId } })).currentStock);
  const exists = async (orderId: string) =>
    (await raw.order.count({ where: { id: orderId } })) === 1;
  const settle = (p: Promise<unknown>) =>
    p.then(
      (value) => ({ value, error: undefined as any }),
      (error) => ({ value: undefined, error }),
    );

  /** Backends currently blocked by a lock holder, ALL of them (never just "a" blocked one). */
  const blockedBackends = async (probe: Client) =>
    (
      await probe.query(
        `SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
          WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
      )
    ).rows;
  /** Poll (<= 4000 ms, always < Prisma's 5 s tx timeout) until `done()` or the merge is blocked. */
  const pollUntil = async (probe: Client, done: () => boolean) => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (done()) return [];
      const blocked = await blockedBackends(probe);
      if (blocked.length > 0) return blocked;
      await new Promise((r) => setTimeout(r, 25));
    }
    return [];
  };

  async function wipe() {
    const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
      (o) => o.id,
    );
    await raw.invoiceItem.deleteMany({ where: { invoice: { tenantId } } });
    await raw.invoice.deleteMany({ where: { tenantId } });
    await raw.$executeRawUnsafe(`DELETE FROM "DeliveryBatch" WHERE "tenantId" = $1`, tenantId);
    await raw.$executeRawUnsafe(`DELETE FROM "Return" WHERE "tenantId" = $1`, tenantId);
    await raw.orderIdempotencyKey.deleteMany({ where: { tenantId } });
    await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: ids } } });
    await raw.stockMovement.deleteMany({ where: { productId } });
    await raw.orderItem.deleteMany({ where: { tenantId } });
    await raw.order.deleteMany({ where: { tenantId } });
    await raw.routeRunStop.deleteMany({ where: { routeRun: { route: { tenantId } } } });
    await raw.routeRun.deleteMany({ where: { route: { tenantId } } });
    await raw.routeStop.deleteMany({ where: { route: { tenantId } } });
    await raw.route.deleteMany({ where: { tenantId } });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const systemConfig = new SystemConfigService(
      prisma,
      new EncryptionService({ get: () => undefined } as any),
    );
    orders = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      gateway: {
        emitOrderCreated: jest.fn(),
        emitUrgentOrder: jest.fn(),
        emitOrderStatusChanged: jest.fn(),
        emitLowStock: jest.fn(),
      },
      notifications: {
        sendToCustomer: jest.fn().mockResolvedValue(undefined),
        sendToUser: jest.fn().mockResolvedValue(1),
      },
      messaging: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
      systemConfig,
      entitlements: { hasFlag: async () => true },
      sellingRestrictions: {
        getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
        assertLinesSellable: async () => undefined,
      },
      authGuard: { assertAuthorizedOrThrow: async () => undefined },
      promotionsService: { activeForCatalog: async () => [] },
      tenantCtx,
      invoicesService: {
        findOpenOrderDraft: async () => null,
        revertLinkedInvoicesForOrderEdit: async () => undefined,
        resyncOrderInvoicesForEdit: async () => [],
        reconcileOrderDraftInvoice: async () => undefined,
        releaseWalletPaymentsInTx: async () => undefined,
        voidInvoiceInTx: async () => undefined,
      },
      creditNotes: {
        settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
        previewOrderCreditRelease: async () => [], // changeStatus -> cancelImpact reads it
        releaseOrderCreditsInTx: async () => undefined,
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      oversellReader: { read: async () => false },
    });

    tenantId = (await raw.tenant.create({ data: { slug, name: `B1053 ${slug}` } })).id;
    operatorUserId = (
      await raw.user.create({
        data: {
          email: `op-${run}@example.test`,
          username: `op-${run}`,
          role: "OPERATOR",
          tenantId,
        },
      })
    ).id;
    const buyer = await raw.user.create({
      data: {
        email: `buyer-${run}@example.test`,
        username: `buyer-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    customerId = (
      await raw.customer.create({
        data: { userId: buyer.id, businessName: "Acme Retail", contactName: "Tester", tenantId },
      })
    ).id;
    productId = (
      await raw.product.create({
        data: {
          name: `Mango ${run}`,
          unit: "each",
          pricePerUnit: "1.00",
          currentStock: INITIAL_STOCK,
          tenantId,
        },
      })
    ).id;
  }, 120_000);

  beforeEach(async () => {
    jest.restoreAllMocks();
    raceErrors = [];
    await wipe();
    await raw.product.update({ where: { id: productId }, data: { currentStock: INITIAL_STOCK } });
  });

  afterAll(async () => {
    try {
      await wipe();
      await raw.auditLog.deleteMany({ where: { tenantId } });
      await raw.product.deleteMany({ where: { tenantId } });
      await raw.customer.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
    } finally {
      await _resetLockPoolForTests();
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }
  }, 120_000);

  // ---- pins (no REG token): behaviour that must NOT change ---------------------------------------

  it("PIN happy path: an uncontended merge folds the loser into the winner, stock untouched", async () => {
    const { loser, winner } = await pair();
    await mergeAuto();
    expect(await exists(loser)).toBe(false);
    expect(await qtyOf(winner)).toBe(WQ + LQ);
    expect(await stockNow()).toBe(INITIAL_STOCK - WQ - LQ);
  }, 120_000);

  it("PIN B215: the loser's idempotency key still moves onto the winner", async () => {
    const { loser, winner } = await pair();
    await raw.orderIdempotencyKey.create({
      data: { tenantId, key: `k-${run}`, orderId: loser, responseHash: "h" },
    });
    await mergeAuto();
    const key = await raw.orderIdempotencyKey.findFirstOrThrow({ where: { tenantId } });
    expect(key.orderId).toBe(winner);
  }, 120_000);

  // ---- REG: the racing writer commits after the read, before the tx -----------------------------

  it("REG-B1053-INV: an invoice inserted for the loser mid-merge keeps its order and defers the merge", async () => {
    const { loser, winner } = await pair();
    let invoiceId = "";
    raceBeforeTx(async () => {
      invoiceId = await insertInvoice(loser, "DRAFT");
    });
    const out = await settle(mergeAuto());
    expectRaceClean();
    const invoice = await raw.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.orderId).toBe(loser);
    expect(await exists(loser)).toBe(true);
    expect(await qtyOf(winner)).toBe(WQ);
    expect(isMergeContention(out.error)).toBe(true);
  }, 120_000);

  it("REG-B1053-CANCEL: a loser cancelled through changeStatus mid-merge is not folded into the winner", async () => {
    const { loser, winner } = await pair();
    raceBeforeTx(async () => {
      await inTenant(() => orders.changeStatus(loser, { status: "CANCELLED" }, operator()));
    });
    await settle(mergeAuto());
    expectRaceClean();
    // the winner holds only its own qty, and stock equals what live lines hold (the cancel restored its part)
    expect(await qtyOf(winner)).toBe(WQ);
    expect(await stockNow()).toBe(INITIAL_STOCK - WQ);
    expect((await raw.order.findUniqueOrThrow({ where: { id: loser } })).status).toBe("CANCELLED");
  }, 120_000);

  it("REG-B1053-ROUTE: a loser assigned to a route run mid-merge survives the merge", async () => {
    const { loser } = await pair();
    raceBeforeTx(async () => {
      const route = await raw.route.create({ data: { name: `R-${run}`, tenantId } });
      const stop = await raw.routeStop.create({
        data: { routeId: route.id, stopNumber: 1, tenantId } as any,
      });
      const runRow = await raw.routeRun.create({
        data: { routeId: route.id, scheduledDate: new Date(), tenantId } as any,
      });
      const runStop = await raw.routeRunStop.create({
        data: { routeRunId: runRow.id, routeStopId: stop.id, stopNumber: 1, tenantId } as any,
      });
      await raw.order.update({
        where: { id: loser },
        data: { routeRunId: runRow.id, routeRunStopId: runStop.id },
      });
    });
    await settle(mergeAuto());
    expectRaceClean();
    expect(await exists(loser)).toBe(true);
    expect((await raw.order.findUniqueOrThrow({ where: { id: loser } })).routeRunId).not.toBeNull();
  }, 120_000);

  it("REG-B1053-FORCE: forceConsolidateCustomer — a SENT invoice inserted mid-merge keeps its order", async () => {
    const { loser, winner } = await pair();
    let invoiceId = "";
    raceBeforeTx(async () => {
      invoiceId = await insertInvoice(loser, "SENT");
    });
    const out = await settle(mergeForce());
    expectRaceClean();
    const invoice = await raw.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.orderId).toBe(loser);
    expect(await exists(loser)).toBe(true);
    expect(await qtyOf(winner)).toBe(WQ);
    expect(isMergeContention(out.error)).toBe(true);
  }, 120_000);

  it("REG-B1053-FORCE-BILLED (no race): force never deletes a loser that already carries a SENT invoice", async () => {
    const { loser, winner } = await pair();
    const invoiceId = await insertInvoice(loser, "SENT");
    await settle(mergeForce());
    const invoice = await raw.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.orderId).toBe(loser);
    expect(await exists(loser)).toBe(true);
    expect(await qtyOf(winner)).toBe(WQ);
  }, 120_000);

  it("REG-B1053-FORCE-VOID (no race): force skips a loser carrying a VOID invoice (keeps the audit link)", async () => {
    const { loser, winner } = await pair();
    const invoiceId = await insertInvoice(loser, "VOID");
    await settle(mergeForce());
    expect((await raw.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).orderId).toBe(loser);
    expect(await exists(loser)).toBe(true);
    expect(await qtyOf(winner)).toBe(WQ);
  }, 120_000);

  it("REG-B1053-FORCE-RETURN (no race): force skips a loser carrying a Return, no raw P2003 500", async () => {
    const { loser, winner } = await pair();
    await commitedWrite(
      `INSERT INTO "Return" (id, "orderId", "customerId", reason, "tenantId", "updatedAt") VALUES ($1, $2, $3, 'DAMAGED', $4, now())`,
      [randomUUID(), loser, customerId, tenantId],
    );
    const out = await settle(mergeForce());
    expect(out.error).toBeUndefined();
    expect(await exists(loser)).toBe(true);
    expect(await qtyOf(winner)).toBe(WQ);
  }, 120_000);

  it("REG-B1053-FORCE-TWO-DRAFTS (no race): a loser with two DRAFT invoices -> nothing deleted, nothing folded", async () => {
    const { loser, winner } = await pair();
    await insertInvoice(loser, "DRAFT");
    await insertInvoice(loser, "DRAFT");
    await settle(mergeForce());
    expect(await raw.invoice.count({ where: { orderId: loser } })).toBe(2);
    expect(await exists(loser)).toBe(true);
    expect(await qtyOf(winner)).toBe(WQ);
  }, 120_000);

  it("REG-B1053-DELETE-ORDER: deleteOrder interleaved on a second client -> the merge defers (a 409), never a raw error", async () => {
    const { loser, winner } = await pair();
    const holder = await pgClient();
    const watcher = await pgClient();
    let holderError: any;
    try {
      // deleteOrder's lock-free shape: items first, no Order row lock, order row after.
      await holder.query("BEGIN");
      await holder.query(`DELETE FROM "OrderItem" WHERE "orderId" = $1`, [loser]);
      let done = false;
      const merged = settle(mergeAuto()).then((r) => ((done = true), r));
      await pollUntil(watcher, () => done);
      try {
        await holder.query(`DELETE FROM "Order" WHERE id = $1`, [loser]);
        await holder.query("COMMIT");
      } catch (e) {
        holderError = e;
        await holder.query("ROLLBACK").catch(() => undefined);
      }
      const out = await merged;
      // diagnostic for the PR: the merge's own error shape and the holder's
      // eslint-disable-next-line no-console
      console.log("B1053 DELETE-ORDER observed", {
        merge: out.error && {
          name: out.error.constructor?.name,
          code: out.error.code,
          metaCode: out.error.meta?.code,
          message: String(out.error.message).slice(0, 200),
        },
        holder: holderError?.code,
      });
      if (holderError) {
        // the holder was the deadlock victim: the merge folded the loser normally
        expect(holderError.code).toBe("40P01");
        expect(out.error).toBeUndefined();
      } else {
        // the merge lost: a coded contention, and nothing was folded into the winner
        expect(isMergeContention(out.error)).toBe(true);
        expect(await qtyOf(winner)).toBe(WQ);
      }
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
      await watcher.end();
    }
  }, 120_000);

  it("REG-B1053-FORCE-BATCH-DRAFT (no race): a loser whose only DRAFT is a batch draft is skipped, not a permanent 409", async () => {
    const { loser, winner } = await pair();
    const batchId = randomUUID();
    await commitedWrite(
      `INSERT INTO "DeliveryBatch" (id, "customerId", "tenantId") VALUES ($1, $2, $3)`,
      [batchId, customerId, tenantId],
    );
    const invoiceId = await insertInvoice(loser, "DRAFT");
    await commitedWrite(`UPDATE "Invoice" SET "deliveryBatchId" = $1 WHERE id = $2`, [
      batchId,
      invoiceId,
    ]);
    const out = await settle(mergeForce());
    expect(out.error).toBeUndefined();
    expect(await exists(loser)).toBe(true);
    expect(await qtyOf(winner)).toBe(WQ);
  }, 120_000);

  it("REG-B1053-LINE: a loser line edited between the read and the lock defers the merge", async () => {
    const { loser, winner } = await pair();
    raceBeforeTx(async () => {
      await commitedWrite(`UPDATE "OrderItem" SET qty = qty + 5 WHERE "orderId" = $1`, [loser]);
    });
    const out = await settle(mergeAuto());
    expectRaceClean();
    expect(await qtyOf(winner)).toBe(WQ);
    expect(await exists(loser)).toBe(true);
    expect(isMergeContention(out.error)).toBe(true);
  }, 120_000);

  // ---- FK / lock probes: a writer's UNCOMMITTED lock is held while the merge runs ----------------

  type Holder = (c: Client, loser: string, winner: string) => Promise<void>;
  const probe = async (hold: Holder) => {
    const { loser, winner } = await pair();
    const holder = await pgClient();
    const watcher = await pgClient();
    try {
      await holder.query("BEGIN");
      await hold(holder, loser, winner);
      let done = false;
      const merged = settle(mergeAuto()).then((r) => ((done = true), r));
      const blocked = await pollUntil(watcher, () => done);
      // ALL blocked backends: at most the merge itself, and only ever behind the holder
      expect(blocked.length).toBeLessThanOrEqual(1);
      await holder.query("COMMIT");
      return { loser, winner, out: await merged };
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
      await watcher.end();
    }
  };

  it("REG-B1053-PROBE-INV: an uncommitted Invoice insert for the loser (FK KEY SHARE) is not folded away", async () => {
    let invoiceId = "";
    const { loser, winner, out } = await probe(async (c, l) => {
      invoiceId = await insertInvoice(l, "SENT", c);
    });
    expect((await raw.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).orderId).toBe(loser);
    expect(await exists(loser)).toBe(true);
    expect(await qtyOf(winner)).toBe(WQ);
    expect(isMergeContention(out.error)).toBe(true);
  }, 120_000);

  it("REG-B1053-PROBE-CANCEL: an uncommitted cancel (FOR NO KEY UPDATE on the loser) is not folded away", async () => {
    const { loser, winner, out } = await probe(async (c, l) => {
      await c.query(`SELECT id FROM "Order" WHERE id = $1 FOR NO KEY UPDATE`, [l]);
      await c.query(`UPDATE "Order" SET status = 'CANCELLED' WHERE id = $1`, [l]);
    });
    expect(await exists(loser)).toBe(true);
    expect((await raw.order.findUniqueOrThrow({ where: { id: loser } })).status).toBe("CANCELLED");
    expect(await qtyOf(winner)).toBe(WQ);
    expect(isMergeContention(out.error)).toBe(true);
  }, 120_000);

  it("REG-B1053-PROBE-ROUTE: an uncommitted route-assignment lock (FOR NO KEY UPDATE) defers the merge", async () => {
    const { loser, winner, out } = await probe(async (c, l) => {
      await c.query(`SELECT id FROM "Order" WHERE id = $1 FOR NO KEY UPDATE`, [l]);
    });
    expect(await exists(loser)).toBe(true);
    expect(await qtyOf(winner)).toBe(WQ);
    expect(isMergeContention(out.error)).toBe(true);
  }, 120_000);

  it("REG-B1053-DEADLOCK: a route-style UPDATE in REVERSE id order defers the merge, no 40P01 for anyone", async () => {
    const { loser, winner } = await pair();
    const [lo, hi] = [loser, winner].sort();
    const holder = await pgClient();
    const watcher = await pgClient();
    let holderError: any;
    try {
      await holder.query("BEGIN");
      await holder.query(`UPDATE "Order" SET "updatedAt" = "updatedAt" WHERE id = $1`, [hi]);
      let done = false;
      const merged = settle(mergeAuto()).then((r) => ((done = true), r));
      await pollUntil(watcher, () => done); // the merge either deferred or is parked behind `hi`
      try {
        await holder.query(`UPDATE "Order" SET "updatedAt" = "updatedAt" WHERE id = $1`, [lo]);
        await holder.query("COMMIT");
      } catch (e) {
        holderError = e;
        await holder.query("ROLLBACK").catch(() => undefined);
      }
      const out = await merged;
      expect(holderError?.code).not.toBe("40P01");
      expect((out.error as any)?.meta?.code).not.toBe("40P01");
      expect(String(out.error?.message ?? "")).not.toMatch(/deadlock/i);
      expect(isMergeContention(out.error)).toBe(true);
      expect(await exists(loser)).toBe(true);
      expect(await qtyOf(winner)).toBe(WQ);
    } finally {
      await holder.end();
      await watcher.end();
    }
  }, 120_000);

  it("SHOULD: a cancel racing a COMMITTED merge answers a coded 409, never a 500", async () => {
    const { loser } = await pair();
    await mergeAuto(); // the loser is folded away
    const err: any = await inTenant(() =>
      orders.changeStatus(loser, { status: "CANCELLED" }, operator()),
    ).catch((e: any) => e);
    // findOneOrThrow raises the 404 before the tx; a cancel that read the row first hits the
    // in-tx guard (409 ORDER_CHANGED_DURING_EDIT). Either way a coded HTTP error, not a TypeError.
    expect([404, 409]).toContain(err?.getStatus?.());
  }, 120_000);
});
