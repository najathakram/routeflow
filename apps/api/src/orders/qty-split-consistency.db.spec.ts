/**
 * Row 531 F2 — real-Postgres pins, THROUGH the real BuyerController.createOrder and the real
 * OrdersService:
 *
 *  - BUYER channel (enforce): the P0 payload ({qty 2, boxes 1, pieces 0} on a 12/box product) is a
 *    coded 400 QTY_SPLIT_MISMATCH and NOTHING is written (no order, no line, an open order left
 *    byte-for-byte as it was);
 *  - the CONSISTENT payloads the fixed client now sends ({2,0,2} and {24,2,0}) are stored exactly,
 *    with the subtotal `computeLineSubtotal` gives for them;
 *  - STAFF / shared channel (warn): the same contradictory payload is accepted and stored exactly
 *    as before (the split wins), plus one warn log naming the path, tenant and product.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), as oversell-policy.orders-service
 * .db.spec.ts does, and the BuyerController the same way (createOrder touches only `prisma`,
 * `ordersService` and `logger`).
 *
 * SAFETY: one throwaway `qa-531-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes
 * exactly the rows this run created, in FK order. Run via `npm run local:test:db`.
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
import { BadRequestException, Logger } from "@nestjs/common";
import { computeLineSubtotal } from "@routeflow/pricing";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { BuyerController } from "../buyer/buyer.controller";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const BOX_PRICE = 12;
const UPB = 12;

describeDb(
  "row 531 — qty / box split consistency on the buyer and staff channels, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    let controller: any;
    let warn: jest.SpyInstance;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-531-${run}`, "qty-split-consistency.db.spec.ts");
    let tenantId = "";
    let buyerUserId = "";
    let operatorUserId = "";
    let customerId = "";
    let otherCustomerId = "";
    let productId = "";

    const ctx = () => ({
      customerId,
      tenantId,
      tenantSlug: slug,
      userId: buyerUserId,
      customer: { id: customerId, businessName: `Acme ${run}` },
    });
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

    const buyerCreate = (items: any[], extra: Record<string, unknown> = {}) =>
      tenantCtx.run(tenantId, () =>
        controller.createOrder({ items, forceNew: true, ...extra }, ctx()),
      );
    const lines = () =>
      raw.orderItem.findMany({ where: { tenantId }, orderBy: { position: "asc" } });
    const orderCount = () => raw.order.count({ where: { tenantId } });

    async function wipe() {
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
          ...INVOICE_EDIT_STUBS,
          reconcileOrderDraftInvoice: async () => undefined,
        },
        creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        oversellReader: { read: async () => ({ allowOversell: true }) },
        // The post-create sweep is not what is under test.
        mergeAllPendingForCustomer: async () => null,
      });
      controller = Object.assign(Object.create(BuyerController.prototype), {
        prisma,
        ordersService: orders,
        logger: new Logger("BuyerController"),
      });

      tenantId = (await raw.tenant.create({ data: { slug, name: `QtySplit ${slug}` } })).id;
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
      customerId = (
        await raw.customer.create({
          data: { userId: buyerUserId, businessName: `Acme ${run}`, contactName: "T", tenantId },
        })
      ).id;
      const otherUser = await raw.user.create({
        data: { email: `x-${run}@example.test`, username: `x-${run}`, role: "CUSTOMER", tenantId },
      });
      otherCustomerId = (
        await raw.customer.create({
          data: { userId: otherUser.id, businessName: `Other ${run}`, contactName: "T", tenantId },
        })
      ).id;
      productId = (
        await raw.product.create({
          data: {
            name: `Cola ${run}`,
            unit: "Box",
            pricePerUnit: String(BOX_PRICE),
            unitsPerBox: UPB,
            currentStock: "100000",
            tenantId,
          },
        })
      ).id;
    }, 120_000);

    beforeEach(async () => {
      await wipe();
      warn = jest.spyOn(orders.logger, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

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

    describe("BUYER channel: enforce", () => {
      it("the P0 payload {qty 2, boxes 1, pieces 0} is a coded 400 and NO row is written", async () => {
        const err = await buyerCreate([{ productId, qty: 2, boxes: 1, pieces: 0 }]).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: "QTY_SPLIT_MISMATCH",
          productIds: [productId],
        });
        expect(await orderCount()).toBe(0);
        expect(await lines()).toHaveLength(0);
      }, 120_000);

      it("refused before the fold too: an open order is left exactly as it was", async () => {
        const open = await raw.order.create({
          data: {
            customerId,
            tenantId,
            status: "PENDING",
            subtotal: "12.00",
            total: "12.00",
            lineItems: {
              create: [
                {
                  tenantId,
                  productId,
                  qty: 12,
                  boxes: 1,
                  pieces: 0,
                  unitsPerBox: UPB,
                  unitPrice: String(BOX_PRICE),
                  subtotal: "12.00",
                  priceType: "STANDARD",
                },
              ],
            },
          },
          include: { lineItems: true },
        });
        const before = JSON.stringify(
          (await lines()).map((l) => [l.id, String(l.qty), l.boxes, l.pieces, String(l.subtotal)]),
        );
        const err = await tenantCtx
          .run(tenantId, () =>
            controller.createOrder(
              { items: [{ productId, qty: 30, boxes: 1, pieces: 0 }] }, // would fold into `open`
              ctx(),
            ),
          )
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: "QTY_SPLIT_MISMATCH",
        });
        expect(await orderCount()).toBe(1);
        expect(
          JSON.stringify(
            (await lines()).map((l) => [
              l.id,
              String(l.qty),
              l.boxes,
              l.pieces,
              String(l.subtotal),
            ]),
          ),
        ).toBe(before);
        expect(open.lineItems).toHaveLength(1);
      }, 120_000);

      it.each([
        // what the FIXED client sends: typing 2 on the Each unit, then 2 on the Case unit
        [{ qty: 2, boxes: 0, pieces: 2 }],
        [{ qty: 24, boxes: 2, pieces: 0 }],
        [{ qty: 25, boxes: 2, pieces: 1 }],
        [{ qty: 12, boxes: 1, pieces: 0 }],
      ])(
        "the consistent payload %j is stored exactly and priced by computeLineSubtotal",
        async (p) => {
          await buyerCreate([{ productId, ...p }]);
          const stored = await lines();
          expect(stored).toHaveLength(1);
          expect(Number(stored[0].qty)).toBe(p.qty);
          expect(stored[0].boxes).toBe(p.boxes);
          expect(stored[0].pieces).toBe(p.pieces);
          const expected = computeLineSubtotal({
            unitPrice: BOX_PRICE,
            qty: p.qty,
            boxes: p.boxes,
            pieces: p.pieces,
            unitsPerBox: UPB,
          });
          expect(Number(stored[0].subtotal)).toBe(expected);
          expect(warn).not.toHaveBeenCalled();
        },
        120_000,
      );

      it("the exact P0 numbers: 2 pieces cost $2.00 (2/12 of the $12 box), 2 Cases cost $24.00", async () => {
        await buyerCreate([{ productId, qty: 2, boxes: 0, pieces: 2 }]);
        expect(Number((await lines())[0].subtotal)).toBe(2);
        await wipe();
        await buyerCreate([{ productId, qty: 24, boxes: 2, pieces: 0 }]);
        expect(Number((await lines())[0].subtotal)).toBe(24);
      }, 120_000);
    });

    describe("BUYER channel, edit-lines (S3): checked against the line's STORED pack", () => {
      /** A stored boxed line on a PENDING order. `pack` is the line's own sale-time snapshot. */
      async function storedLine(pack: number, qty: number, boxes: number, owner = customerId) {
        const o = await raw.order.create({
          data: {
            customerId: owner,
            tenantId,
            status: "PENDING",
            subtotal: "0.00",
            total: "0.00",
            lineItems: {
              create: [
                {
                  tenantId,
                  productId,
                  qty,
                  boxes,
                  pieces: 0,
                  unitsPerBox: pack,
                  unitPrice: String(BOX_PRICE),
                  subtotal: String(boxes * BOX_PRICE),
                  priceType: "STANDARD",
                  authorChannel: "BUYER",
                },
              ],
            },
          },
          include: { lineItems: true },
        });
        return { orderId: o.id, lineId: o.lineItems[0].id };
      }
      const buyerEdit = (orderId: string, entry: Record<string, unknown>) =>
        tenantCtx.run(tenantId, () =>
          controller.updateOrderItems(
            orderId,
            { items: [{ productId, ...entry }], namesLines: true },
            ctx(),
          ),
        );
      const snapshot = async () =>
        JSON.stringify(
          (await lines()).map((l) => [l.id, String(l.qty), l.boxes, l.pieces, String(l.subtotal)]),
        );

      it("an entry that contradicts the stored line's pack is a coded 400 and the order is untouched", async () => {
        const { orderId, lineId } = await storedLine(UPB, 24, 2);
        const before = await snapshot();
        const err = await buyerEdit(orderId, {
          orderItemId: lineId,
          qty: 2,
          boxes: 1,
          pieces: 0,
        }).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: "QTY_SPLIT_MISMATCH",
        });
        expect(await snapshot()).toBe(before);
      }, 120_000);

      it("a pair consistent with the STORED pack (6) is not refused although the product is a 12-pack today", async () => {
        const { orderId, lineId } = await storedLine(6, 12, 2);
        // live product is 12/box: 2 boxes x 12 = 24 != 12, so only the stored pack (2 x 6 = 12) accepts it
        await expect(
          buyerEdit(orderId, { orderItemId: lineId, qty: 12, boxes: 2, pieces: 0 }),
        ).resolves.toBeDefined();
      }, 120_000);

      it("the stored-pack lookup never reads ANOTHER customer's line: a foreign id gets the live-pack answer", async () => {
        const foreign = await storedLine(6, 12, 2, otherCustomerId);
        const err = await buyerEdit(foreign.orderId, {
          orderItemId: foreign.lineId,
          qty: 12,
          boxes: 2,
          pieces: 0,
        }).then(
          () => null,
          (e: unknown) => e,
        );
        // consistent with the foreign line's pack (6) but not the live pack (12): refused as if the line were unknown
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: "QTY_SPLIT_MISMATCH",
        });
      }, 120_000);
    });

    describe("STAFF / shared channel: warn only, behaviour unchanged", () => {
      it("create(): the contradictory payload is still stored at the split (1 box, $12.00) and warns once", async () => {
        await tenantCtx.run(tenantId, () =>
          orders.create(
            { customerId, items: [{ productId, qty: 2, boxes: 1, pieces: 0 }] },
            operator(),
            { skipAutoMerge: true },
          ),
        );
        const stored = await lines();
        expect(stored).toHaveLength(1);
        // unchanged: the split wins, exactly the pre-ruling behaviour
        expect(Number(stored[0].qty)).toBe(12);
        expect(stored[0].boxes).toBe(1);
        expect(Number(stored[0].subtotal)).toBe(12);
        expect(warn).toHaveBeenCalledTimes(1);
        const msg = String(warn.mock.calls[0][0]);
        expect(msg).toContain("path=orders.create");
        expect(msg).toContain(`tenantId=${tenantId}`);
        expect(msg).toContain(`productId=${productId}`);
      }, 120_000);

      it("counter sale: the same warn with its own path label, behaviour unchanged", async () => {
        await tenantCtx.run(tenantId, () =>
          orders.create(
            { customerId, items: [{ productId, qty: 2, boxes: 1, pieces: 0 }] },
            operator(),
            { skipAutoMerge: true, counterSale: true },
          ),
        );
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain("path=counter.sale");
        expect(Number((await lines())[0].qty)).toBe(12);
      }, 120_000);

      it("create(): a consistent payload does not warn", async () => {
        await tenantCtx.run(tenantId, () =>
          orders.create(
            { customerId, items: [{ productId, qty: 24, boxes: 2, pieces: 0 }] },
            operator(),
            { skipAutoMerge: true },
          ),
        );
        expect(warn).not.toHaveBeenCalled();
        expect(Number((await lines())[0].qty)).toBe(24);
      }, 120_000);

      it("a staff edit with a contradictory pair warns (path orders.update) and still writes the split", async () => {
        const created = await tenantCtx.run(tenantId, () =>
          orders.create(
            { customerId, items: [{ productId, qty: 12, boxes: 1, pieces: 0 }] },
            operator(),
            { skipAutoMerge: true },
          ),
        );
        warn.mockClear();
        const [line] = await lines();
        await tenantCtx.run(tenantId, () =>
          orders.updateOrderItems(
            created.id,
            { items: [{ id: line.id, productId, qty: 2, boxes: 1, pieces: 0 }] } as any,
            operator(),
          ),
        );
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain("path=orders.update");
        const [after] = await lines();
        expect(Number(after.qty)).toBe(12); // the split still wins on the staff path
        expect(after.boxes).toBe(1);
      }, 120_000);
    });
  },
);
