/**
 * B1234 (D-O2-a) - real-Postgres pins THROUGH OrdersService.updateOrderItems(): on a PARTIALLY_DELIVERED order a line
 * the driver delivered (deliveredQty > 0) cannot be cut, deleted, cancelled, substituted, re-united or replaced:
 * 409 LINE_ALREADY_DELIVERED, and the stock counter, the ledger, the lines and the header are exactly as before.
 * The undelivered line stays editable and a note on the delivered line is allowed. A stale pre-tx read (the line
 * looked undelivered, a delivery landed before the Order lock) is refused on the LOCKED read.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), as b1050-delivered-edit.db.spec.ts does.
 * NOT RUN by the lane that wrote it (Docker/DB down); the DB lane runs it.
 *
 * SAFETY: one throwaway `qa-b1234-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes
 * exactly the rows this run created.
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
  "B1234 — a delivered line of a PARTIALLY_DELIVERED order is locked, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-b1234-${run}`, "b1234-delivered-line-lock.db.spec.ts");
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
      tenantId = (await raw.tenant.create({ data: { slug, name: `b1234 ${slug}` } })).id;
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
          data: { userId: buyerUserId, businessName: "b1234 co", contactName: "Tester", tenantId },
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

    it("A qty 5 to 2 (below what was delivered) is refused, nothing moves", async () => {
      await expectRefused(({ a }) => ({ replaceAll: false, items: [{ id: a.id, qty: 2 }] }));
    });
    it("A qty raised is refused too", async () => {
      await expectRefused(({ a }) => ({ replaceAll: false, items: [{ id: a.id, qty: 9 }] }));
    });
    it("DELETE A is refused", async () => {
      await expectRefused(({ a }) => ({
        replaceAll: false,
        items: [{ id: a.id, action: "DELETE" }],
      }));
    });
    it("CANCEL A (Not available) is refused", async () => {
      await expectRefused(({ a }) => ({
        replaceAll: false,
        items: [{ id: a.id, action: "CANCEL" }],
      }));
    });
    it("substituting A is refused", async () => {
      const other = await product("other");
      await expectRefused(({ a }) => ({
        replaceAll: false,
        items: [{ id: a.id, substituteProductId: other }],
      }));
    });
    it("a unit change on A is refused", async () => {
      await expectRefused(({ a }) => ({
        replaceAll: false,
        items: [{ id: a.id, qty: 5, unitLabel: "Case" }],
      }));
    });
    it("a price change on A is refused", async () => {
      await expectRefused(({ a }) => ({
        replaceAll: false,
        items: [{ id: a.id, qty: 5, unitPrice: "2.00" }],
      }));
    });
    it("any replace-all is refused (replace modes fail closed)", async () => {
      // Both lines named by id (an id-less pair of one product is ORDER_EDIT_NEEDS_LINE_IDS first), restated exactly:
      // a valid replace-all that only the B1234 guard can refuse, because a replace deletes and re-creates every line.
      await expectRefused(({ p, a, b }) => ({
        replaceAll: true,
        items: [
          { id: a.id, productId: p, qty: 5, unitPrice: "1.00" },
          { id: b.id, productId: p, qty: 4, unitPrice: "1.00" },
        ],
      }));
    });

    it("control: B (undelivered) is still editable, A untouched", async () => {
      const { o, a, b } = await pdOrder();
      await edit(o.id, { replaceAll: false, items: [{ id: b.id, qty: 2 }] });
      const after = await rows(o.id);
      expect(Number(after.find((l) => l.id === b.id)!.qty)).toBe(2);
      expect(Number(after.find((l) => l.id === a.id)!.qty)).toBe(5);
      expect(Number(after.find((l) => l.id === a.id)!.deliveredQty)).toBe(3);
    });

    it("a note-only change on A is allowed and changes nothing else", async () => {
      const { p, o, a } = await pdOrder();
      const stockBefore = await stock(p);
      await edit(o.id, { replaceAll: false, items: [{ id: a.id, notes: "gate code 4412" }] });
      const after = (await rows(o.id)).find((l) => l.id === a.id)!;
      expect(after.notes).toBe("gate code 4412");
      expect(Number(after.qty)).toBe(5);
      expect(await stock(p)).toBe(stockBefore);
    });

    it("a note on a BOGO line, sent the way the web page sends it, never reprices the delivered line", async () => {
      // Sold under "buy 4 get 1": 6 units, 1 free, 5 billed at $5.00 = $25.00, all delivered. The live promotion is
      // now "buy 2 get 1" (2 free for 6), so a repricing edit would write promoFreeUnits 2 and subtotal 20.00.
      const p = await product("bogo");
      const o = await order(
        [
          {
            productId: p,
            qty: 6,
            deliveredQty: 6,
            unitPrice: "5.00",
            subtotal: "25.00",
            promoFreeUnits: 1,
          },
        ],
        "PARTIALLY_DELIVERED",
      );
      await sentInvoice(o.id, "25.00");
      const a = o.lineItems[0];
      const before = await snapshot(o.id);
      activePromos = [
        {
          id: "promo-1",
          type: "BUY_N_GET_M",
          value: 1,
          minQty: 2,
          scope: "ALL",
          category: null,
          productIds: [],
        },
      ];
      try {
        await edit(o.id, {
          replaceAll: false,
          items: [{ id: a.id, action: "UPDATE", qty: 6, unitPrice: 5, notes: "gate code 4412" }],
        });
      } finally {
        activePromos = [];
      }
      const after = await snapshot(o.id);
      const lineAfter = after.lines.find((l) => l.id === a.id)!;
      expect(lineAfter.notes).toBe("gate code 4412");
      expect(Number(lineAfter.subtotal)).toBe(25);
      expect(lineAfter.promoFreeUnits).toBe(1);
      expect(Number(lineAfter.unitPrice)).toBe(5);
      expect(Number(lineAfter.qty)).toBe(6);
      expect(after.invoices).toEqual(before.invoices);
    });

    // Row 586 (SA-814a item 4 / SA-833): the invoice revert runs in the edit transaction, after the binding refusals,
    // so a refused edit leaves the linked SENT invoice SENT. UNRUN here (needs the DB lane): the revert stub below has
    // the REAL effect (SENT -> DRAFT through the given client, or on its own connection when none is given), so a
    // pre-tx commit would show up in the snapshot.
    it("stale status: the linked SENT invoice is unchanged (status + totals) after the locked-status refusal", async () => {
      const p = await product("flip-inv");
      const o = await order([plain(p, 5, 0), plain(p, 4, 0)], "CONFIRMED");
      const target = o.lineItems.find((l) => Number(l.qty) === 5)!;
      await sentInvoice(o.id, "9.00");
      await raw.orderItem.update({ where: { id: target.id }, data: { deliveredQty: "3" } });
      await raw.order.update({ where: { id: o.id }, data: { status: "PARTIALLY_DELIVERED" } });
      const before = await snapshot(o.id);
      const realRevert = orders.invoicesService.revertLinkedInvoicesForOrderEdit;
      orders.invoicesService.revertLinkedInvoicesForOrderEdit = async (
        orderId: string,
        tx?: any,
        opts?: { preflightOnly?: boolean },
      ) => {
        if (opts?.preflightOnly) return [];
        await (tx ?? raw).invoice.updateMany({
          where: { orderId, status: "SENT" },
          data: { status: "DRAFT", sentAt: null },
        });
        return [];
      };
      const seam = staleOnlyThePreTxRead(o.id, (real) => ({
        ...real,
        status: "CONFIRMED",
        lineItems: real.lineItems.map((l: any) => ({ ...l, deliveredQty: 0 })),
      }));
      try {
        await expect(
          edit(o.id, { replaceAll: false, items: [{ id: target.id, qty: 2 }] }),
        ).rejects.toMatchObject(REFUSED);
      } finally {
        seam.spy.mockRestore();
        orders.invoicesService.revertLinkedInvoicesForOrderEdit = realRevert;
      }
      expect(seam.hits()).toBeGreaterThanOrEqual(1);
      const after = await snapshot(o.id);
      expect(after).toEqual(before);
      expect(after.invoices.map((i: any) => i.status)).toEqual(["SENT"]);
    });

    /**
     * The REAL race, reproduced at the one seam that matters. The delivery is already committed to the database
     * (the caller writes it first); ONLY updateOrderItems' pre-transaction read of the order
     * (`prisma.forTenant().order.findUnique` with `include: { lineItems }`) is made to return the stale snapshot
     * `stale(real)` it would have returned before the delivery landed. The transaction's own locked reads
     * (`tx.order` / `tx.orderItem`, a different client) are untouched, so they see the delivery. `forTenant()`
     * builds a fresh extended client per call, so the spy wraps it and intercepts that one call; `hits()` lets the
     * test assert the seam was really used (a non-intercepting spy can never pass silently).
     */
    function staleOnlyThePreTxRead(orderId: string, stale: (real: any) => any) {
      const realForTenant = prisma.forTenant.bind(prisma);
      let hits = 0;
      const spy = jest.spyOn(prisma, "forTenant").mockImplementation((() => {
        const client: any = realForTenant();
        return new Proxy(client, {
          get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (prop !== "order") return typeof value === "function" ? value.bind(target) : value;
            return new Proxy(value, {
              get(model, method) {
                const fn = Reflect.get(model, method, model);
                if (method !== "findUnique") return typeof fn === "function" ? fn.bind(model) : fn;
                return async (args: any) => {
                  const res = await fn.call(model, args);
                  if (args?.where?.id !== orderId || !args?.include?.lineItems || !res) return res;
                  hits += 1;
                  return stale(res);
                };
              },
            });
          },
        });
      }) as any);
      return { spy, hits: () => hits };
    }

    it("stale status: the pre-tx read shows CONFIRMED, a delivery flips the order to PARTIALLY_DELIVERED, the LOCKED status refuses", async () => {
      const p = await product("flip");
      const o = await order([plain(p, 5, 0), plain(p, 4, 0)], "CONFIRMED");
      const target = o.lineItems.find((l) => Number(l.qty) === 5)!;
      await sentInvoice(o.id, "9.00");
      // The delivery lands for real: line A delivered 3, the order PARTIALLY_DELIVERED.
      await raw.orderItem.update({ where: { id: target.id }, data: { deliveredQty: "3" } });
      await raw.order.update({ where: { id: o.id }, data: { status: "PARTIALLY_DELIVERED" } });
      const before = await snapshot(o.id);
      const stockBefore = await stock(p);
      const ledgerBefore = (await ledgerRows(p)).length;
      // ...but the edit's pre-transaction read still sees the order as it was: CONFIRMED, nothing delivered.
      const seam = staleOnlyThePreTxRead(o.id, (real) => ({
        ...real,
        status: "CONFIRMED",
        lineItems: real.lineItems.map((l: any) => ({ ...l, deliveredQty: 0 })),
      }));
      try {
        await expect(
          edit(o.id, { replaceAll: false, items: [{ id: target.id, qty: 2 }] }),
        ).rejects.toMatchObject(REFUSED);
      } finally {
        seam.spy.mockRestore();
      }
      expect(seam.hits()).toBeGreaterThanOrEqual(1);
      const after = await snapshot(o.id);
      expect(after).toEqual(before);
      expect(Number(after.lines.find((l) => l.id === target.id)!.qty)).toBe(5);
      expect(Number(after.lines.find((l) => l.id === target.id)!.deliveredQty)).toBe(3);
      expect(after.header.status).toBe("PARTIALLY_DELIVERED");
      expect(await stock(p)).toBe(stockBefore);
      expect((await ledgerRows(p)).length).toBe(ledgerBefore);
    });

    it("stale read: the pre-tx read shows A undelivered, a delivery lands, the LOCKED read refuses", async () => {
      const p = await product("stale");
      const o = await order([plain(p, 5, 0), plain(p, 4, 0)], "PARTIALLY_DELIVERED");
      const target = o.lineItems.find((l) => Number(l.qty) === 5)!;
      await sentInvoice(o.id, "9.00");
      // The delivery lands for real: line A delivered 3 (the order is already PARTIALLY_DELIVERED).
      await raw.orderItem.update({ where: { id: target.id }, data: { deliveredQty: "3" } });
      const before = await snapshot(o.id);
      const stockBefore = await stock(p);
      const ledgerBefore = (await ledgerRows(p)).length;
      // ...but the edit's pre-transaction read still sees A undelivered.
      const seam = staleOnlyThePreTxRead(o.id, (real) => ({
        ...real,
        lineItems: real.lineItems.map((l: any) => ({ ...l, deliveredQty: 0 })),
      }));
      try {
        await expect(
          edit(o.id, { replaceAll: false, items: [{ id: target.id, qty: 2 }] }),
        ).rejects.toMatchObject(REFUSED);
      } finally {
        seam.spy.mockRestore();
      }
      expect(seam.hits()).toBeGreaterThanOrEqual(1);
      const after = await snapshot(o.id);
      expect(after).toEqual(before);
      expect(Number(after.lines.find((l) => l.id === target.id)!.qty)).toBe(5);
      expect(Number(after.lines.find((l) => l.id === target.id)!.deliveredQty)).toBe(3);
      expect(await stock(p)).toBe(stockBefore);
      expect((await ledgerRows(p)).length).toBe(ledgerBefore);
    });
  },
);
