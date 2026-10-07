/**
 * SA-714 R1 / SA-716: the per-line backorder marker (`OrderItem.backorderedPieces`) THROUGH the real
 * `OrdersService` against a REAL Postgres: create SETs, edit ADJUSTS, promotion SETs, cancel leaves
 * it, reopen SETs, the merge fold CARRIES it, and the marker never moves money, stock or status.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), like oversell-policy.orders-service
 * .db.spec.ts; the side-effect collaborators are inert fakes. SAFETY: one throwaway
 * `qa-backorder-mk-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes exactly its rows.
 * Run via `npm run local:test:db`.
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
import { _resetLockPoolForTests } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PACKING_SLIP_LINE_SELECT } from "./packing-slip-data";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("backorder marker (SA-714 R1) through OrdersService, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-backorder-mk-${run}`, "backorder-marker.db.spec.ts");
  let tenantId = "";
  let operatorUserId = "";
  let customerId = "";
  let productId = "";

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
  const inTenant = (fn: () => Promise<any>): Promise<any> => tenantCtx.run(tenantId, fn);
  const createOrder = (qty: number, extra: object = {}, skipAutoMerge = true) =>
    inTenant(() =>
      orders.create({ customerId, items: [{ productId, qty }], ...extra }, operator(), {
        skipAutoMerge,
      }),
    );
  /** The staff web/mobile edit: an incremental diff by line id (replaceAll:false), never a recreate. */
  const editQty = async (orderId: string, qty: number) => {
    const line = await lineOf(orderId);
    return inTenant(() =>
      orders.updateOrderItems(
        orderId,
        { items: [{ id: line.id, productId, qty }], replaceAll: false } as any,
        operator(),
      ),
    );
  };
  const lineOf = (orderId: string) =>
    raw.orderItem.findFirstOrThrow({ where: { orderId }, orderBy: { position: "asc" } });
  const marker = async (orderId: string) => Number((await lineOf(orderId)).backorderedPieces);
  const stockNow = async () =>
    Number((await raw.product.findUniqueOrThrow({ where: { id: productId } })).currentStock);
  const setStock = (n: number) =>
    raw.product.update({ where: { id: productId }, data: { currentStock: n } });

  async function wipeOrders() {
    const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
      (o) => o.id,
    );
    await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: ids } } });
    await raw.stockMovement.deleteMany({ where: { productId } });
    await raw.orderItem.deleteMany({ where: { tenantId } });
    await raw.order.deleteMany({ where: { tenantId } });
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
      },
      creditNotes: {
        settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
        previewOrderCreditRelease: async () => [],
        releaseOrderCreditsInTx: async () => undefined,
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      oversellReader: { read: async () => "off" },
    });
    tenantId = (await raw.tenant.create({ data: { slug, name: `Backorder MK ${slug}` } })).id;
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
    const u = await raw.user.create({
      data: { email: `b-${run}@example.test`, username: `b-${run}`, role: "CUSTOMER", tenantId },
    });
    customerId = (
      await raw.customer.create({
        data: { userId: u.id, businessName: "Acme", contactName: "Tester", tenantId },
      })
    ).id;
    productId = (
      await raw.product.create({
        data: {
          name: `Mango ${run}`,
          unit: "each",
          pricePerUnit: "1.00",
          currentStock: 5,
          tenantId,
        },
      })
    ).id;
  }, 120_000);

  beforeEach(async () => {
    await wipeOrders();
    await setStock(5);
  });

  afterAll(async () => {
    try {
      await wipeOrders();
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

  it("a freshly migrated row defaults to 0 (history reads 0 = unknown)", async () => {
    const o = await createOrder(2);
    expect(await marker(o.id)).toBe(0);
  }, 120_000);

  it("create: an oversell sets the marker to the pieces past stock; an in-stock create stays 0", async () => {
    const over = await createOrder(8); // 5 on hand
    expect(await marker(over.id)).toBe(3);
    expect(await stockNow()).toBe(-3);
    await setStock(50);
    const ok = await createOrder(8);
    expect(await marker(ok.id)).toBe(0);
  }, 120_000);

  it("edit: an increase past stock ADDS its delta to the line; a reduction releases it first", async () => {
    const o = await createOrder(2); // stock 3
    await editQty(o.id, 10); // +8 with 3 on hand -> 5 backordered
    expect(await marker(o.id)).toBe(5);
    await editQty(o.id, 6); // -4 releases 4 of the 5
    expect(await marker(o.id)).toBe(1);
    await editQty(o.id, 1); // -5 releases the rest, never negative
    expect(await marker(o.id)).toBe(0);
  }, 120_000);

  it("promotion SETs: create DRAFT -> PENDING reads the promotion's own value", async () => {
    const d = await createOrder(8, { status: "DRAFT" });
    expect(await marker(d.id)).toBe(0);
    expect(await stockNow()).toBe(5);
    await inTenant(() => orders.changeStatus(d.id, { status: "PENDING" } as any, operator()));
    expect(await marker(d.id)).toBe(3);
    expect(await stockNow()).toBe(-3);
  }, 120_000);

  it("cancel leaves the marker unchanged; reopen SETs its own value", async () => {
    const o = await createOrder(8);
    expect(await marker(o.id)).toBe(3);
    await inTenant(() => orders.changeStatus(o.id, { status: "CANCELLED" } as any, operator()));
    expect(await marker(o.id)).toBe(3); // a fact of the sale
    expect(await stockNow()).toBe(5); // the cancel credited the 8 back
    await setStock(6); // a restock while cancelled
    await inTenant(() => orders.reopenOrder(o.id));
    expect(await marker(o.id)).toBe(2); // 8 re-taken against 6 on hand
  }, 120_000);

  it("the merge fold CARRIES it: two orders backordering 3 each, merged, read 6", async () => {
    await createOrder(8, {}, false); // stock 5 -> marker 3, stock -3
    await createOrder(3, {}, false); // all 3 past stock -> marker 3
    await inTenant(() => orders.mergeAllPendingForCustomer(customerId));
    const live = await raw.order.findMany({ where: { tenantId }, include: { lineItems: true } });
    expect(live).toHaveLength(1);
    expect(live[0].lineItems).toHaveLength(1);
    expect(Number(live[0].lineItems[0].backorderedPieces)).toBe(6);
    expect(Number(live[0].lineItems[0].qty)).toBe(11);
  }, 120_000);

  it("byte-identical money, stock and status with the marker set to 7 vs 0", async () => {
    await setStock(100);
    const x = await createOrder(4);
    const y = await createOrder(4);
    await raw.orderItem.updateMany({ where: { orderId: y.id }, data: { backorderedPieces: 7 } });
    for (const id of [x.id, y.id]) await editQty(id, 9);
    const snap = async (id: string) => {
      const o = await raw.order.findUniqueOrThrow({ where: { id }, include: { lineItems: true } });
      const li = o.lineItems[0] as any;
      return {
        status: o.status,
        subtotal: String(o.subtotal),
        tax: String(o.tax),
        total: String(o.total),
        line: {
          qty: String(li.qty),
          unitPrice: String(li.unitPrice),
          subtotal: String(li.subtotal),
          boxes: li.boxes,
          pieces: li.pieces,
          status: li.status,
          categoryTaxAmount: String(li.categoryTaxAmount),
        },
      };
    };
    expect(await snap(y.id)).toEqual(await snap(x.id));
    const moves = (id: string) =>
      raw.stockMovement
        .findMany({ where: { reference: `ORDER:${id}` }, orderBy: { createdAt: "asc" } })
        .then((r) => r.map((m) => Number(m.quantity)));
    expect(await moves(y.id)).toEqual(await moves(x.id));
    expect(await stockNow()).toBe(100 - 18);
  }, 120_000);

  it("the packing slip's exact line select runs against the migrated schema and reads the marker (L-262)", async () => {
    const o = await createOrder(8);
    const row = await raw.order.findUniqueOrThrow({
      where: { id: o.id },
      select: { lineItems: { select: PACKING_SLIP_LINE_SELECT } },
    });
    expect(Number(row.lineItems[0].backorderedPieces)).toBe(3);
  }, 120_000);
});
