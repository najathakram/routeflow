/**
 * W-904: a tracking save racing a ship claim must keep the claim's shippedAt (order and invoice mirror). Real Postgres,
 * test tenant only. Scaffolding copied from b1234-delivered-line-lock.db.spec.ts.
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
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "W-904 — updateShipment never nulls a racing ship claim's shippedAt, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-w904-${run}`, "w904-ship-claim-race.db.spec.ts");
    let tenantId = "";
    let operatorUserId = "";
    let buyerUserId = "";
    let driverUserId = "";
    let driverId = "";
    const routeIds: string[] = [];
    const runIds: string[] = [];
    let customerId = "";
    const productIds: string[] = [];
    const orderIds: string[] = [];
    const invoiceIds: string[] = [];
    /** What the (mocked) active promotions endpoint returns; the BOGO case sets it for one edit. */
    let activePromos: any[] = [];

    const principal = (role: "OPERATOR" | "DRIVER", sub: string): JwtPayload =>
      ({
        sub,
        username: `${role.toLowerCase()}-${run}`,
        role,
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;

    /** A plain "ea" product (no box, no unit ladder) holding 90 pieces: the order's own 10 are already out. */
    async function product(tag: string) {
      const p = await raw.product.create({
        data: {
          // Product names are unique per tenant (Product_tenant_root_name_active_key): one per call.
          name: `${tag} cola ${run} #${productIds.length + 1}`,
          unit: "ea",
          pricePerUnit: "1.00",
          currentStock: "90",
          tenantId,
        },
      });
      productIds.push(p.id);
      return p.id;
    }

    const operator = () => principal("OPERATOR", operatorUserId);

    async function order(lines: any | any[], status = "PENDING") {
      const list = Array.isArray(lines) ? lines : [lines];
      const o = await raw.order.create({
        data: {
          customerId,
          tenantId,
          status: status as any,
          subtotal: "20.00",
          total: "20.00",
          lineItems: { create: list.map((l) => ({ tenantId, ...l })) },
        },
        include: { lineItems: true },
      });
      orderIds.push(o.id);
      return o;
    }

    const edit = (orderId: string, dto: any, who: JwtPayload = operator()) =>
      tenantCtx.run(tenantId, () => orders.updateOrderItems(orderId, dto, who));
    /** The whole order as stored: its header money, every line (ids included) and its linked invoices. */
    const snapshot = async (orderId: string) => ({
      header: await raw.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { subtotal: true, total: true, status: true },
      }),
      lines: await rows(orderId),
      invoices: await raw.invoice.findMany({
        where: { orderId },
        orderBy: { id: "asc" },
        select: { id: true, status: true, subtotal: true, taxAmount: true, total: true },
      }),
    });
    const rows = (orderId: string) =>
      raw.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
    const stock = async (id: string) =>
      Number((await raw.product.findUniqueOrThrow({ where: { id } })).currentStock);

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
        promotionsService: { activeForCatalog: async () => activePromos },
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
      tenantId = (await raw.tenant.create({ data: { slug, name: `w904 ${slug}` } })).id;
      operatorUserId = (
        await raw.user.create({
          data: {
            email: `o-${run}@example.test`,
            username: `o-${run}`,
            role: "OPERATOR",
            tenantId,
          },
        })
      ).id;
      buyerUserId = (
        await raw.user.create({
          data: {
            email: `b-${run}@example.test`,
            username: `b-${run}`,
            role: "CUSTOMER",
            tenantId,
          },
        })
      ).id;
      customerId = (
        await raw.customer.create({
          data: { userId: buyerUserId, businessName: "w904 co", contactName: "Tester", tenantId },
        })
      ).id;
      driverUserId = (
        await raw.user.create({
          data: { email: `d-${run}@example.test`, username: `d-${run}`, role: "DRIVER", tenantId },
        })
      ).id;
      driverId = (await raw.driver.create({ data: { userId: driverUserId, tenantId } as any })).id;
    }, 120_000);

    afterAll(async () => {
      await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
      await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.routeRunStop.deleteMany({ where: { routeRunId: { in: runIds } } });
      await raw.routeRun.deleteMany({ where: { id: { in: runIds } } });
      await raw.routeStop.deleteMany({ where: { routeId: { in: routeIds } } });
      await raw.route.deleteMany({ where: { id: { in: routeIds } } });
      await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
      await raw.productUnit.deleteMany({ where: { productId: { in: productIds } } });
      await raw.product.deleteMany({ where: { id: { in: productIds } } });
      await raw.customer.deleteMany({ where: { id: customerId } });
      await raw.driver.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({
        where: { id: { in: [operatorUserId, buyerUserId, driverUserId] } },
      });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    /** A plain line: qty at $1, with a delivered qty. */
    const plain = (productId: string, qty: number, deliveredQty = 0) => ({
      productId,
      qty,
      deliveredQty,
      unitPrice: "1.00",
      subtotal: String(qty),
    });
    const ledgerRows = (productId: string) => raw.stockMovement.findMany({ where: { productId } });
    const REFUSED = { response: { code: "LINE_ALREADY_DELIVERED" }, status: 409 };

    /** A SENT invoice linked to the order, billing what the lines are worth. */
    async function sentInvoice(orderId: string, total: string) {
      const inv = await raw.invoice.create({
        data: {
          tenantId,
          customerId,
          orderId,
          invoiceNumber: `INV-${randomUUID().slice(0, 8)}`,
          status: "SENT",
          subtotal: total,
          total,
          sentAt: new Date(),
        },
      });
      invoiceIds.push(inv.id);
      return inv;
    }

    /**
     * A: 5 ordered, 3 delivered. B: 4 ordered, undelivered. Status PARTIALLY_DELIVERED, with a linked SENT
     * invoice (9.00) that every refusal must leave exactly as it was (`snapshot` reads it).
     */
    async function pdOrder() {
      const p = await product("pd");
      const o = await order([plain(p, 5, 3), plain(p, 4, 0)], "PARTIALLY_DELIVERED");
      await sentInvoice(o.id, "9.00");
      const a = o.lineItems.find((l) => Number(l.deliveredQty) > 0)!;
      const b = o.lineItems.find((l) => Number(l.deliveredQty) === 0)!;
      return { p, o, a, b };
    }

    /** Refused edit: 409, and stock, ledger, lines and header are identical afterwards. */
    async function expectRefused(
      build: (ctx: { p: string; a: { id: string }; b: { id: string } }) => any,
    ) {
      const { p, o, a, b } = await pdOrder();
      const dto = build({ p, a, b });
      const before = await snapshot(o.id);
      const stockBefore = await stock(p);
      const ledgerBefore = (await ledgerRows(p)).length;
      await expect(edit(o.id, dto)).rejects.toMatchObject(REFUSED);
      expect(await snapshot(o.id)).toEqual(before);
      expect(await stock(p)).toBe(stockBefore);
      expect((await ledgerRows(p)).length).toBe(ledgerBefore);
    }

    it("a tracking save that pre-read a not-yet-shipped order keeps the shippedAt a ship claim stamped in between", async () => {
      const p = await product("w904");
      const o = await order([plain(p, 5, 0)], "CONFIRMED");
      await raw.order.update({ where: { id: o.id }, data: { fulfillPath: "SHIP" } });
      const inv = await sentInvoice(o.id, "5.00");
      const claimAt = new Date("2026-11-13T15:00:00.000Z");

      // Race: right AFTER updateShipmentImpl's unlocked pre-read returns, the ship claim commits.
      let armed = true;
      const racing = {
        forTenant: () => {
          const db: any = prisma.forTenant();
          return new Proxy(db, {
            get: (t, k) =>
              k === "order"
                ? new Proxy(t.order, {
                    get: (ord, m) =>
                      m === "findFirst"
                        ? async (...a: any[]) => {
                            const r = await ord.findFirst(...a);
                            if (armed) {
                              armed = false;
                              await raw.order.update({
                                where: { id: o.id },
                                data: { status: "OUT_FOR_DELIVERY", shippedAt: claimAt },
                              });
                            }
                            return r;
                          }
                        : ord[m],
                  })
                : t[k],
          });
        },
      };
      const svc: any = Object.assign(Object.create(orders), { prisma: racing });

      let thrown: unknown = null;
      try {
        await tenantCtx.run(tenantId, () =>
          svc.updateShipment(
            o.id,
            { shippingCarrier: "UPS", shippingTrackingNumber: "1Z999" },
            operator(),
          ),
        );
      } catch (e) {
        thrown = e;
      }
      const after = await raw.order.findUniqueOrThrow({ where: { id: o.id } });
      const invAfter = await raw.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      // eslint-disable-next-line no-console
      console.log(
        "W904-OBSERVED",
        JSON.stringify({
          thrown: thrown ? String((thrown as Error).message) : null,
          status: after.status,
          orderShippedAt: after.shippedAt,
          invoiceShippedAt: invAfter.shippedAt,
          tracking: after.shippingTrackingNumber,
        }),
      );
      expect(thrown).toBeNull();
      expect(after.shippedAt?.toISOString()).toBe(claimAt.toISOString());
      expect(after.shippingTrackingNumber).toBe("1Z999");
      // The claim committed before the main update, so the mirror carries exactly the claim's stamp.
      expect(invAfter.shippedAt?.toISOString()).toBe(claimAt.toISOString());
    });

    it("5: two concurrent tracking saves on a legacy shipped order (no stamp) stamp it once", async () => {
      const p = await product("w904b");
      const o = await order([plain(p, 5, 0)], "OUT_FOR_DELIVERY");
      await raw.order.update({ where: { id: o.id }, data: { fulfillPath: "SHIP" } });
      const inv = await sentInvoice(o.id, "5.00");

      // Barrier: both saves finish their pre-read before either writes.
      let waiting = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let stampWrites = 0;
      const racing = {
        forTenant: () => {
          const db: any = prisma.forTenant();
          return new Proxy(db, {
            get: (t, k) =>
              k === "order"
                ? new Proxy(t.order, {
                    get: (ord, m) => {
                      if (m === "findFirst")
                        return async (...a: any[]) => {
                          const r = await ord.findFirst(...a);
                          if (a[0]?.select && ++waiting === 2) release();
                          if (a[0]?.select) await gate;
                          return r;
                        };
                      if (m === "update")
                        return async (...a: any[]) => {
                          if (a[0]?.data?.shippedAt instanceof Date) stampWrites += 1;
                          return ord.update(...a);
                        };
                      if (m === "updateMany")
                        return async (...a: any[]) => {
                          const r = await ord.updateMany(...a);
                          if (a[0]?.data?.shippedAt instanceof Date) stampWrites += r.count;
                          return r;
                        };
                      return ord[m];
                    },
                  })
                : t[k],
          });
        },
      };
      const svc: any = Object.assign(Object.create(orders), { prisma: racing });
      await tenantCtx.run(tenantId, () =>
        Promise.all([
          svc.updateShipment(
            o.id,
            { shippingCarrier: "UPS", shippingTrackingNumber: "1Z1" },
            operator(),
          ),
          svc.updateShipment(
            o.id,
            { shippingCarrier: "UPS", shippingTrackingNumber: "1Z2" },
            operator(),
          ),
        ]),
      );
      const after = await raw.order.findUniqueOrThrow({ where: { id: o.id } });
      const invAfter = await raw.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      // eslint-disable-next-line no-console
      console.log("W904-CASE5", JSON.stringify({ stampWrites, shippedAt: after.shippedAt }));
      expect(after.shippedAt).not.toBeNull();
      expect(stampWrites).toBe(1);
      expect(invAfter.shippedAt?.toISOString()).toBe(after.shippedAt?.toISOString());
    });
  },
);
