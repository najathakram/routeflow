/**
 * SA-763r [N] — real-Postgres pins of the delivered stamp through the REAL writers, one case per path the spec
 * names, none of them calling the stamp helpers directly:
 *   - a replace-all edit through OrdersService.updateOrderItems (markLinesRecreated -> carry -> stampDeliveredAfterEdit),
 *     with no evidence (the carry) and with a route evidence row (409 ORDER_EDIT_NEEDS_LINE_IDS, nothing written);
 *   - a stable-id edit of a DELIVERED order (raise lifts d to the new qty, a cut keeps it);
 *   - pickup-complete (PickupCompleteService -> changeStatus DELIVERED) on a PICKUP order;
 *   - a counter sale (createSale's DELIVERED write; create() is stubbed, the sale's own write is real).
 *
 * NOT RUN by the authoring lane (no Postgres here): the DB lane runs it (`npm run local:test:db`, test tenants
 * only, collected only by jest.db.config.js). One throwaway `qa-stampx-<run>` tenant; `afterAll` deletes exactly
 * the rows this run created. Collaborators OrdersService only touches after the status write (notifications,
 * messaging, invoicing) answer any method with a no-op.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { EncryptionService } from "../common/encryption.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PickupCompleteService } from "./counter-sale/pickup-complete.service";
import { clearUnevidencedDelivered, unevidencedDeliveredFloor } from "./delivered-stamp";
import { OrdersService } from "./orders.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("SA-763r — the delivered stamp through the real writers, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-stampx-${run}`, "orders.delivered-stamp-paths.db.spec.ts");
  let tenantId = "";
  let userId = "";
  let customerId = "";
  let productId = "";
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];
  let n = 0;

  const operator = (): JwtPayload =>
    ({
      sub: userId,
      username: `o-${run}`,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;
  const as = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  async function seed(opts: {
    status: string;
    fulfillPath?: "ROUTE" | "PICKUP";
    lines: Array<{ qty: number; d?: number; evidence?: number; status?: string }>;
  }) {
    n += 1;
    const order = await raw.order.create({
      data: {
        customerId,
        tenantId,
        status: opts.status as never,
        fulfillPath: (opts.fulfillPath ?? "PICKUP") as never,
        orderNumber: `SX${run}-${n}`,
        subtotal: "0",
        total: "0",
      },
    });
    orderIds.push(order.id);
    const lineIds: string[] = [];
    for (const l of opts.lines) {
      const li = await raw.orderItem.create({
        data: {
          orderId: order.id,
          productId,
          tenantId,
          qty: l.qty,
          deliveredQty: l.d ?? 0,
          ...(l.status ? { status: l.status as never } : {}),
          unitPrice: 1,
          subtotal: l.qty,
        },
      });
      lineIds.push(li.id);
      if (l.evidence != null) {
        await raw.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: li.id,
            productId,
            tenantId,
            type: "PARTIAL",
            quantityDelivered: l.evidence,
          },
        });
      }
    }
    return { orderId: order.id, lineIds };
  }
  const lines = (orderId: string) =>
    raw.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
  const dq = async (lineId: string) =>
    Number((await raw.orderItem.findUniqueOrThrow({ where: { id: lineId } })).deliveredQty);
  const edit = (orderId: string, dto: unknown) =>
    as(() => orders.updateOrderItems(orderId, dto, operator()));

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const anyMethod = new Proxy(
      {},
      { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
    );
    orders = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      gateway: { emitOrderStatusChanged: jest.fn(), emitOrderCreated: jest.fn() },
      systemConfig: new SystemConfigService(
        prisma,
        new EncryptionService({ get: () => undefined } as any),
      ),
      entitlements: { hasFlag: async () => true },
      sellingRestrictions: {
        getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
        assertLinesSellable: async () => undefined,
      },
      authGuard: { assertAuthorizedOrThrow: async () => undefined },
      promotionsService: { activeForCatalog: async () => [] },
      notifications: { sendToCustomer: async () => undefined },
      messaging: anyMethod,
      ledger: anyMethod,
      featureConfig: { getEffectiveMode: async () => "unset" },
      tenantCtx,
      invoicesService: {
        revertLinkedInvoicesForOrderEdit: async () => undefined,
        resyncOrderInvoicesForEdit: async () => [],
        reconcileOrderDraftInvoice: async () => undefined,
        findOpenOrderDraft: async () => null,
        createInvoiceFromOrderWithTenant: async () => [{ id: "stub" }],
        createInvoiceFromOrder: async () => [{ id: "stub", status: "DRAFT" }],
        send: async () => ({ status: "SENT" }),
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      creditNotes: {
        settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
        releaseOrderCreditsInTx: async () => [],
      },
    });
    orders.invoicesService.releaseWalletPaymentsInTx = async () => ({ credits: [], advances: 0 });
    orders.invoicesService.voidInvoiceInTx = async () => ({});
    tenantId = (await raw.tenant.create({ data: { slug, name: `Stampx ${slug}` } })).id;
    userId = (
      await raw.user.create({
        data: { email: `o-${run}@example.test`, username: `o-${run}`, role: "OPERATOR", tenantId },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId, businessName: `Acme Test ${run}`, contactName: "Tester", tenantId },
      })
    ).id;
    productId = (
      await raw.product.create({
        data: {
          name: `Widget ${run}`,
          unit: "ea",
          pricePerUnit: "1.00",
          currentStock: "100",
          tenantId,
        },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await raw.auditLog.deleteMany({ where: { entityId: { in: orderIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
    await raw.deliveryMutation.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.stockMovement.deleteMany({ where: { productId } });
    await raw.product.deleteMany({ where: { id: productId } });
    await raw.customer.deleteMany({ where: { id: customerId } });
    await raw.user.deleteMany({ where: { id: userId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("a replace-all edit of a DELIVERED order with no evidence carries the delivered sum (12 from 10)", async () => {
    const { orderId } = await seed({ status: "DELIVERED", lines: [{ qty: 10, d: 10 }] });
    await edit(orderId, { items: [{ productId, qty: 12 }], replaceAll: true });
    const rows = await lines(orderId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].qty)).toBe(12);
    expect(Number(rows[0].deliveredQty)).toBe(12); // red on base: 0 (the recreated row reset it)
  });

  it("a replace-all cut keeps the carried 10; the stable-id edit then raises to the new qty", async () => {
    const { orderId } = await seed({ status: "DELIVERED", lines: [{ qty: 10, d: 10 }] });
    await edit(orderId, { items: [{ productId, qty: 6 }], replaceAll: true });
    const [cut] = await lines(orderId);
    expect(Number(cut.deliveredQty)).toBe(10);
    await edit(orderId, { items: [{ id: cut.id, productId, qty: 14 }], replaceAll: false });
    expect(await dq(cut.id)).toBe(14);
  });

  it("a replace-all of an order with a route evidence row is REFUSED 409 and nothing is written", async () => {
    const { orderId, lineIds } = await seed({
      status: "DELIVERED",
      lines: [{ qty: 10, d: 8, evidence: 8 }],
    });
    await expect(
      edit(orderId, { items: [{ productId, qty: 12 }], replaceAll: true }),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "ORDER_EDIT_NEEDS_LINE_IDS" }),
    });
    const rows = await lines(orderId);
    expect(rows.map((r) => r.id)).toEqual(lineIds);
    expect(Number(rows[0].deliveredQty)).toBe(8);
    expect(await raw.deliveryMutation.count({ where: { orderId, orderItemId: lineIds[0] } })).toBe(
      1,
    );
    // the stable-id edit of the same order succeeds and the evidence line is untouched
    await edit(orderId, { items: [{ id: lineIds[0], productId, qty: 12 }], replaceAll: false });
    expect(await dq(lineIds[0])).toBe(8);
    expect(await raw.deliveryMutation.count({ where: { orderId, orderItemId: lineIds[0] } })).toBe(
      1,
    );
  });

  it("pickup-complete (through changeStatus) stamps a no-row line: 0 -> qty", async () => {
    const { orderId, lineIds } = await seed({ status: "CONFIRMED", lines: [{ qty: 7 }] });
    const invoice = await raw.invoice.create({
      data: {
        invoiceNumber: `INV-SX-${run}-${n}`,
        customerId,
        orderId,
        tenantId,
        status: "DRAFT",
        subtotal: 0,
        total: 0,
      },
    });
    invoiceIds.push(invoice.id);
    const pickup = new PickupCompleteService(orders, orders.invoicesService, prisma);
    await as(() => pickup.complete(orderId, {} as never, operator(), `key-${run}-${n}`));
    expect((await raw.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      "DELIVERED",
    );
    expect(await dq(lineIds[0])).toBe(7); // red on base: 0
  });

  it("a counter sale (createSale's DELIVERED write) stamps its lines in the same transaction", async () => {
    const { orderId, lineIds } = await seed({ status: "PENDING", lines: [{ qty: 3 }, { qty: 2 }] });
    jest.spyOn(orders, "create").mockResolvedValue({
      id: orderId,
      customerId,
      orderNumber: `SX${run}`,
      status: "PENDING",
    } as never);
    await as(() =>
      orders.createSale(
        { customerId, items: [{ productId, qty: 3 }], deliveredNow: true },
        operator(),
        { counterSale: true, fulfillPath: "PICKUP" },
      ),
    );
    expect((await raw.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      "DELIVERED",
    );
    expect(await dq(lineIds[0])).toBe(3); // red on base: 0
    expect(await dq(lineIds[1])).toBe(2);
  });
  /** The counter void's order step, as CounterSaleVoidService.voidInTx runs it (floor read, reset, then the cancel). */
  const voidLike = (orderId: string) =>
    as(() =>
      prisma.tenantTransaction(async (tx: any) => {
        const bookedFloor = await unevidencedDeliveredFloor(tx, orderId);
        await clearUnevidencedDelivered(tx, orderId);
        await orders.cancelOrderInTx(
          tx,
          { id: orderId },
          {
            fromStatuses: ["DELIVERED"],
            statusUpdateData: { status: "CANCELLED" },
            carrier: null,
            user: operator(),
            notes: "CANCEL",
            bookedFloor,
          },
        );
      }),
    );
  const stock = async () =>
    Number((await raw.product.findUniqueOrThrow({ where: { id: productId } })).currentStock);

  it("a LEGACY counter line (d 0): 12 sold, cut to 10, then voided: stock ends where it started (no over-restock)", async () => {
    const { orderId, lineIds } = await seed({
      status: "DELIVERED",
      lines: [{ qty: 12, d: 0 }],
    });
    await raw.product.update({ where: { id: productId }, data: { currentStock: 88 } }); // the sale took 12
    await edit(orderId, { items: [{ id: lineIds[0], productId, qty: 10 }], replaceAll: false });
    expect(await stock()).toBe(88); // red on base: 90 (the cut put 2 back)
    expect(await dq(lineIds[0])).toBe(12);
    await voidLike(orderId);
    expect(await stock()).toBe(100); // red on base: 102 (14 restocked for 12 sold)
  });

  it("the same legacy line cut through a replace-all keeps the books: no restock, d 12, void back to the start", async () => {
    const { orderId } = await seed({ status: "DELIVERED", lines: [{ qty: 12, d: 0 }] });
    await raw.product.update({ where: { id: productId }, data: { currentStock: 88 } });
    await edit(orderId, { items: [{ productId, qty: 10 }], replaceAll: true });
    const [row] = await lines(orderId);
    expect(Number(row.deliveredQty)).toBe(12);
    expect(await stock()).toBe(88);
    await voidLike(orderId);
    expect(await stock()).toBe(100);
  });
  it("a legacy CANCELLED row with qty > 0 does not inflate a replace-all carry, and the void does not over-restock", async () => {
    const { orderId } = await seed({
      status: "DELIVERED",
      lines: [
        { qty: 12, d: 0 },
        { qty: 5, d: 0, status: "CANCELLED" }, // already returned to the shelf when it was cancelled
      ],
    });
    await raw.product.update({ where: { id: productId }, data: { currentStock: 88 } });
    await edit(orderId, { items: [{ productId, qty: 10 }], replaceAll: true });
    const live = (await lines(orderId)).filter((r) => r.status !== "CANCELLED");
    expect(live.map((r) => Number(r.deliveredQty))).toEqual([12]); // red before the guard: 17
    expect(await stock()).toBe(88);
    await voidLike(orderId);
    expect(await stock()).toBe(100); // red before the guard: the extra 5 would be credited again
  });
});
