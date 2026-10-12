/**
 * Row 372 (SA-735 items 2-4, API half) — real-Postgres pins THROUGH OrdersService.updateOrderItems():
 *  (1) a stale `expectedRevisionNumber` is 409 ORDER_REVISION_STALE inside the Order-locked tx, nothing written;
 *  (2) a line deleted by another writer WHILE the edit waits on the Order lock is 409 CONCURRENT_UPDATE, never a
 *      P2025 / stale write (the old `heldOrSnapshot` fallback to the pre-tx snapshot);
 *  (3) B720: a concurrent substitution that makes the line unit-aware under the lock no longer 500s on a missing
 *      product map entry: its product is loaded AFTER the lock;
 *  (4) the matching revision number edits, and the edit appends the revision the next GET exposes.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), as buyer-edit-cancelled-line.db.spec.ts does.
 * SAFETY: one throwaway `qa-372-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes what it made.
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
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import { latestEditRevisionNumber } from "./order-revisions";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("row 372 (SA-735 items 2-4): the order edit guards, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-372-${run}`, "orders.revision-guard.db.spec.ts");
  let tenantId = "";
  let operatorUserId = "";
  let customerUserId = "";
  let customerId = "";
  const productIds: string[] = [];
  const orderIds: string[] = [];

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

  async function product(tag: string) {
    const p = await raw.product.create({
      data: {
        name: `${tag} cola ${run}`,
        unit: "Box",
        pricePerUnit: "10.00",
        unitsPerBox: 6,
        currentStock: "10000",
        tenantId,
      },
    });
    productIds.push(p.id);
    await raw.productUnit.create({
      data: { tenantId, productId: p.id, label: "Case", factorToBase: 12, price: "18.00" },
    });
    return p.id;
  }

  /** A PENDING order holding one plain pack line of `productId`. */
  async function order(productId: string) {
    const o = await raw.order.create({
      data: {
        customerId,
        tenantId,
        status: "PENDING",
        subtotal: "20.00",
        total: "20.00",
        lineItems: {
          create: [
            {
              tenantId,
              productId,
              qty: 2,
              unitPrice: "10.00",
              subtotal: "20.00",
              status: "PENDING",
            },
          ],
        },
      },
      include: { lineItems: true },
    });
    orderIds.push(o.id);
    return o;
  }

  const edit = (orderId: string, dto: any) =>
    tenantCtx.run(tenantId, () => orders.updateOrderItems(orderId, dto, operator()));
  const rows = (orderId: string) =>
    raw.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
  const latest = () => (orderId: string) =>
    tenantCtx.run(tenantId, () => latestEditRevisionNumber(prisma.forTenant() as any, orderId));

  /** Hold the Order row lock on a raw connection until `release()`; the edit started meanwhile waits on it. */
  async function holdOrderLock(orderId: string) {
    const c = await pool.connect();
    await c.query("BEGIN");
    await c.query(`SELECT id FROM "Order" WHERE id = $1 FOR UPDATE`, [orderId]);
    return {
      query: (sql: string, args?: unknown[]) => c.query(sql, args),
      async release(commit = true) {
        await c.query(commit ? "COMMIT" : "ROLLBACK");
        c.release();
      },
    };
  }
  /** Wait until some backend is blocked on a lock (the edit reached the Order FOR UPDATE). */
  async function waitUntilBlocked(timeoutMs = 8000) {
    const t0 = Date.now();
    for (;;) {
      const { rows: r } = await pool.query(
        `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() LIMIT 1`,
      );
      if (r.length > 0) return;
      if (Date.now() - t0 > timeoutMs) throw new Error("the edit never blocked on the Order lock");
      await new Promise((res) => setTimeout(res, 50));
    }
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
      gateway: { emitOrderStatusChanged: jest.fn(), emitOrderCreated: jest.fn() },
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
        revertLinkedInvoicesForOrderEdit: async () => undefined,
        resyncOrderInvoicesForEdit: async () => [],
        ...INVOICE_EDIT_STUBS,
        reconcileOrderDraftInvoice: async () => undefined,
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
    });
    tenantId = (await raw.tenant.create({ data: { slug, name: `372 ${slug}` } })).id;
    operatorUserId = (
      await raw.user.create({
        data: { email: `o-${run}@example.test`, username: `o-${run}`, role: "OPERATOR", tenantId },
      })
    ).id;
    customerUserId = (
      await raw.user.create({
        data: { email: `c-${run}@example.test`, username: `c-${run}`, role: "CUSTOMER", tenantId },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId: customerUserId, businessName: "372 co", contactName: "Tester", tenantId },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
    await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
    await raw.productUnit.deleteMany({ where: { productId: { in: productIds } } });
    await raw.product.deleteMany({ where: { id: { in: productIds } } });
    await raw.customer.deleteMany({ where: { id: customerId } });
    await raw.user.deleteMany({ where: { id: { in: [operatorUserId, customerUserId] } } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("a stale expectedRevisionNumber is 409 ORDER_REVISION_STALE and the order is untouched; the current number edits", async () => {
    const cola = await product("rev");
    const o = await order(cola);
    const lineId = o.lineItems[0].id;
    const r0 = await latest()(o.id);
    const before = await rows(o.id);

    // another tab's edit lands first: the revision moves on
    await edit(o.id, { items: [{ id: lineId, action: "UPDATE", qty: 3, unitPrice: 10 }] });
    const r1 = await latest()(o.id);
    expect(r1).toBeGreaterThan(r0);

    // this tab still holds r0
    await expect(
      edit(o.id, {
        items: [{ id: lineId, action: "UPDATE", qty: 9, unitPrice: 10 }],
        expectedRevisionNumber: r0,
      }),
    ).rejects.toMatchObject({ response: { code: "ORDER_REVISION_STALE" } });
    const after = await rows(o.id);
    expect(Number(after[0].qty)).toBe(3); // the first edit stands, the stale one wrote nothing
    expect(after[0].id).toBe(before[0].id);

    // the current number goes through
    await edit(o.id, {
      items: [{ id: lineId, action: "UPDATE", qty: 4, unitPrice: 10 }],
      expectedRevisionNumber: r1,
    });
    expect(Number((await rows(o.id))[0].qty)).toBe(4);
  });

  it("a line deleted while the edit waits on the Order lock is 409 CONCURRENT_UPDATE, never P2025 or a stale write", async () => {
    const cola = await product("gone");
    const o = await order(cola);
    const lineId = o.lineItems[0].id;
    const lock = await holdOrderLock(o.id);
    const pending = edit(o.id, {
      items: [{ id: lineId, action: "UPDATE", qty: 5, unitPrice: 10 }],
    });
    const settled = pending.then(
      () => ({ ok: true as const }),
      (e: any) => ({ ok: false as const, e }),
    );
    await waitUntilBlocked();
    await lock.query(`DELETE FROM "OrderItem" WHERE id = $1`, [lineId]);
    await lock.release(true);
    const r = await settled;
    expect(r.ok).toBe(false);
    expect((r as any).e?.response?.code).toBe("CONCURRENT_UPDATE");
    expect(await rows(o.id)).toHaveLength(0); // nothing re-created from the snapshot
  });

  it("B720: a concurrent substitution that makes the line unit-aware under the lock loads its product after the lock (no 500)", async () => {
    const plain = await product("b720-a");
    const cased = await product("b720-b");
    const o = await order(plain);
    const lineId = o.lineItems[0].id;
    const lock = await holdOrderLock(o.id);
    const pending = edit(o.id, {
      items: [{ id: lineId, action: "UPDATE", unitLabel: "Case", qty: 2 }],
    });
    const settled = pending.then(
      () => ({ ok: true as const }),
      (e: any) => ({ ok: false as const, e }),
    );
    await waitUntilBlocked();
    // another writer re-pointed the line at a Case line of ANOTHER product while we waited
    await lock.query(
      `UPDATE "OrderItem" SET "productId" = $1, "unitLabel" = 'Case', "unitsPerBox" = 12, qty = 24, boxes = 2, pieces = 0, "unitPrice" = 18, subtotal = 36 WHERE id = $2`,
      [cased, lineId],
    );
    await lock.release(true);
    const r = await settled;
    // under the lock the line is a Case line of `cased`, whose product the pre-lock context never loaded: it is
    // read now (B720), so the edit completes as a 2-Case line instead of dying on an empty map entry
    expect(r.ok).toBe(true);
    const [line] = await rows(o.id);
    expect(line.productId).toBe(cased);
    expect(Number(line.qty)).toBe(24);
    expect(line.unitLabel).toBe("Case");
  });
});
