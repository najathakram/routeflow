/**
 * B215 (train 4 Run B) — DB lane (TP2). Real Postgres proof for the staff-merge
 * same-key-retry defect: `apps/api/src/orders/orders.controller.ts` ~147-221 folds
 * a cart onto the customer's active order under `withAdvisoryLock`, then
 * `OrdersService.recordIdempotencyKey` stamps the Order column first-key-wins
 * (`orders.service.ts` ~1661). An order that already carried a key silently dropped
 * the retry's key, so the replay lookup (`findOrderIdByIdempotencyKey`) missed it
 * and the retry folded the cart again — doubling the order's total, since the fold
 * writes ABSOLUTE totals.
 *
 * `mergeOnce()` below is the staff merge branch's persistence sequence with a raw
 * `+10` fold stand-in in place of the real cart fold: the replay lookup, then ONE
 * `tenantTransaction` holding the fold AND the in-tx key write via
 * `recordMergeIdempotencyKey`, then the controller's post-commit Order-column
 * stamp. It runs the real `OrdersService` methods against real Postgres.
 *
 * D1-D4 went RED on the pre-fix tree (the retry folded every time, because the
 * single Order column dropped the second key). The fix adds the
 * `OrderIdempotencyKey` model + migration and `OrdersService.recordMergeIdempotencyKey`,
 * which `mergeOnce()` now calls UNCONDITIONALLY inside the fold transaction — so a
 * missing method or a missing table fails every test in this lane loudly rather
 * than soft (the earlier `typeof` feature-probe around that call is gone).
 *
 * The replay lookup's order is (1) the key table scoped to THIS customer, (2) this
 * customer's own `Order.idempotencyKey` column, (3) only then a tenant-wide key-table
 * refusal — a pre-fold 409 (`IDEMPOTENCY_KEY_CONFLICT` / `HELD_BY_OTHER_ORDER`, carrying
 * the holding `orderId`) when the key belongs to another customer's order. D3 below is
 * that pre-fold refusal; D4 covers the in-transaction P2002 rollback it cannot reach.
 *
 * Run via `npm run local:test:db` (compose Postgres) — collected only by
 * jest.db.config.js, never the main unit lane.
 */

// Mock InvoicesService before it's imported — prevents Jest from traversing
// invoice-pdf.service.ts which imports @react-pdf/renderer (ESM-only module).
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    createInvoiceFromOrder: jest
      .fn()
      .mockResolvedValue([{ id: "inv-1", invoiceNumber: "INV-1", total: 0 }]),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue(undefined),
    resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
  })),
}));

// Mock NotificationsService — it imports expo-server-sdk which is ESM-only
// and fails Jest's CommonJS parser.
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({
    sendToCustomer: jest.fn().mockResolvedValue(undefined),
    sendToDriver: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { ConflictException, Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { OrdersService } from "./orders.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

interface Fx {
  tenantId: string;
  userId: string;
  customerId: string;
  orderId: string;
}

describeDb("B215 OrderIdempotencyKey — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient; // superuser fixture client — deliberately unscoped
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let svc: any;
  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-idem-${run}-a`, "order-idempotency-key.db.spec.ts");
  const slugB = assertTestTenant(`qa-idem-${run}-b`, "order-idempotency-key.db.spec.ts");
  let tenantA = "";
  let tenantB = "";
  const created: Fx[] = [];

  async function seed(tenantId: string, tag: string, orderKey: string | null): Promise<Fx> {
    const user = await raw.user.create({
      data: {
        email: `${tag}-${run}@example.test`,
        username: `${tag}-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await raw.customer.create({
      data: { userId: user.id, businessName: `${tag} co`, contactName: "Idem Tester", tenantId },
    });
    const order = await raw.order.create({
      data: { customerId: customer.id, tenantId, total: "100.00", idempotencyKey: orderKey },
    });
    const fx = { tenantId, userId: user.id, customerId: customer.id, orderId: order.id };
    created.push(fx);
    return fx;
  }

  async function totalOf(orderId: string): Promise<number> {
    return Number((await raw.order.findUniqueOrThrow({ where: { id: orderId } })).total);
  }

  // The staff merge branch's persistence sequence with a raw +10 fold stand-in:
  // replay lookup -> ONE fold transaction (+ the in-tx key write once the fixed service
  // exposes it) -> the controller's post-commit Order-column stamp (kept by the fix).
  async function mergeOnce(f: Fx, key: string, hash: string): Promise<"replayed" | "folded"> {
    return tenantCtx.run(f.tenantId, async () => {
      if (await svc.findOrderIdByIdempotencyKey(key, f.customerId, hash)) return "replayed";
      await prisma.tenantTransaction(async (tx: any) => {
        await tx.$executeRaw`UPDATE "Order" SET "total" = "total" + 10 WHERE "id" = ${f.orderId}`;
        await svc.recordMergeIdempotencyKey(tx, f.orderId, { key, responseHash: hash });
      });
      await svc.recordIdempotencyKey(f.orderId, key);
      return "folded";
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx); // opens its own pool off the same DATABASE_URL
    await prisma.$connect();
    // `Object.create` runs no constructor, so every instance FIELD the exercised paths
    // dereference must be supplied here — `logger` included (`orders.service.ts:96`,
    // a class field, so it lives on the instance, not the prototype). Without it the
    // refusal paths of `findOrderIdByIdempotencyKey` / `recordMergeIdempotencyKey`
    // would surface as `TypeError: Cannot read properties of undefined (reading 'warn')`
    // instead of the ConflictException/ForbiddenException the pins assert.
    svc = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      logger: new Logger(OrdersService.name),
    });

    tenantA = (await raw.tenant.create({ data: { slug: slugA, name: `Idem ${slugA}` } })).id;
    tenantB = (await raw.tenant.create({ data: { slug: slugB, name: `Idem ${slugB}` } })).id;
  }, 120_000);

  afterAll(async () => {
    // Key rows go with their orders (FK ON DELETE CASCADE once the migration exists).
    for (const f of created) {
      await raw.order.deleteMany({ where: { id: f.orderId } });
      await raw.customer.deleteMany({ where: { id: f.customerId } });
      await raw.user.deleteMany({ where: { id: f.userId } });
    }
    await raw.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("REG-B215 D1: a second key on an already-keyed order is replayed by the merge lookup", async () => {
    const a = await seed(tenantA, "d1", `K0-${run}-d1`);
    const key = `K1-${run}-d1`;
    await mergeOnce(a, key, "h-d1");
    // B215/R1 (round 2): the lookup returns { orderId, verified } — a table hit whose stored
    // fingerprint matched is VERIFIED, which is what lets the controller re-apply the retry
    // body's credit selection.
    expect(
      await tenantCtx.run(a.tenantId, () =>
        svc.findOrderIdByIdempotencyKey(key, a.customerId, "h-d1"),
      ),
    ).toEqual({ orderId: a.orderId, verified: true });
  });

  it("REG-B215 D2: a same-key retry never folds twice", async () => {
    const a = await seed(tenantA, "d2", `K0-${run}-d2`);
    const key = `K1-${run}-d2`;
    await mergeOnce(a, key, "h-d2");
    await mergeOnce(a, key, "h-d2");
    expect(await totalOf(a.orderId)).toBe(110);
  });

  it("REG-B215 D3: a key held by another customer's order is refused before the fold (pre-fold 409)", async () => {
    const b = await seed(tenantA, "d3b", null);
    const a = await seed(tenantA, "d3a", `K0-${run}-d3`);
    const key = `K1-${run}-d3`;
    await mergeOnce(b, key, "h-d3b");
    // The replay lookup's `heldByAnotherOrder` branch refuses the key outright, so the
    // fold transaction is never opened — hence the unchanged total. D4 covers the true
    // race the in-tx P2002 backstop exists for.
    await expect(mergeOnce(a, key, "h-d3a")).rejects.toBeInstanceOf(ConflictException);
    expect(await totalOf(a.orderId)).toBe(100);
  });

  it("REG-B215 D4: a colliding key inserted after the replay lookup rolls the fold back through the real unique constraint", async () => {
    const b = await seed(tenantA, "d4b", null);
    const a = await seed(tenantA, "d4a", `K0-${run}-d4`);
    const key = `K1-${run}-d4`;
    await mergeOnce(b, key, "h-d4b"); // b's order now owns (tenantId, key)
    // The lost race the pre-fold lookup cannot close: another customer's fold claims the
    // key AFTER this request's replay lookup returned null. Skip the lookup entirely and
    // run the fold's two writes in one transaction, exactly as updateOrderItems does.
    await expect(
      tenantCtx.run(a.tenantId, () =>
        prisma.tenantTransaction(async (tx: any) => {
          await tx.order.update({ where: { id: a.orderId }, data: { total: 110 } });
          await svc.recordMergeIdempotencyKey(tx, a.orderId, { key, responseHash: "h-d4a" });
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    // Both writes of the fold rolled back together against real Postgres.
    expect(await totalOf(a.orderId)).toBe(100);
    expect(await raw.orderIdempotencyKey.count({ where: { orderId: a.orderId, key } })).toBe(0);
  });

  it("B215 pin PD1: a key recorded for one customer is never replayed for another", async () => {
    const a = await seed(tenantA, "pd1a", null);
    const b = await seed(tenantA, "pd1b", null);
    const key = `K1-${run}-pd1`;
    await mergeOnce(b, key, "h-pd1");
    // Never replayed onto `a` — and now refused OUTRIGHT rather than answered with null: a
    // same-tenant key already bound to ANOTHER customer's order is rejected by the lookup
    // itself, before the caller can revert linked invoices or open the fold transaction. The
    // in-tx P2002 remains the backstop for a true race (proved by D4 — D3 is the
    // pre-fold refusal, which never opens the fold transaction at all).
    await expect(
      tenantCtx.run(a.tenantId, () => svc.findOrderIdByIdempotencyKey(key, a.customerId, "h-pd1")),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("B215 pin PD2: the same key string in two tenants folds once in each", async () => {
    const a = await seed(tenantA, "pd2a", null);
    const b = await seed(tenantB, "pd2b", null);
    const key = `K1-${run}-pd2`;
    await mergeOnce(a, key, "h-pd2");
    await mergeOnce(b, key, "h-pd2");
    expect([await totalOf(a.orderId), await totalOf(b.orderId)]).toEqual([110, 110]);
  });

  it("B215 pin PD3: a key recorded in one tenant is invisible to another tenant", async () => {
    const a = await seed(tenantA, "pd3a", null);
    const b = await seed(tenantB, "pd3b", null);
    const key = `K1-${run}-pd3`;
    await mergeOnce(a, key, "h-pd3");
    expect(
      await tenantCtx.run(tenantB, () =>
        svc.findOrderIdByIdempotencyKey(key, b.customerId, "h-pd3"),
      ),
    ).toBeNull();
  });
});
