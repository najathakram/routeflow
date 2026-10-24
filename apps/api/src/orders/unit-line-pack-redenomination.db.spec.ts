/**
 * SA-474 (#2443) — real-Postgres pins THROUGH OrdersService.updateOrderItems(): an UPDATE that takes a
 * held Case line back to the pack (`unitLabel: null`, or the pack's own label) is refused 409
 * UNIT_AWARE_LINE with zero writes. Red on master: the edit took the pack branch and wrote
 * {unitLabel "Case", unitsPerBox 12, qty 3, boxes 0, pieces 3} at the Case price — a line that
 * still says Case, sized as pieces, which unitLineCount then locked. A label-less pack line sent
 * `unitLabel: null` (mobile's echo) is edited as before.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), as buyer-edit-cancelled-line.db.spec.ts
 * does. NOT RUN by the lane that wrote it (DB specs are the prover's): F2's DB lane runs it and adjusts
 * any fixture field the schema demands.
 *
 * SAFETY: one throwaway `qa-2443-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes
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
  "SA-474 (#2443) — a held Case line is never re-denominated to the pack, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-2443-${run}`, "unit-line-pack-redenomination.db.spec.ts");
    let tenantId = "";
    let operatorUserId = "";
    let buyerUserId = "";
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

    /** A 6-piece Box product at $10 a box (stocked), with a Case of 12 at $18 on its ladder. */
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

    async function order(line: any) {
      const o = await raw.order.create({
        data: {
          customerId,
          tenantId,
          status: "PENDING",
          subtotal: "0.00",
          total: "0.00",
          lineItems: { create: [{ tenantId, ...line }] },
        },
        include: { lineItems: true },
      });
      orderIds.push(o.id);
      return o;
    }

    /** The writer's own held-Case shape: 3 Cases of 12 at $18. */
    const heldCase = (productId: string) => ({
      productId,
      unitLabel: "Case",
      unitsPerBox: 12,
      qty: 36,
      boxes: 3,
      pieces: 0,
      unitPrice: "18.00",
      subtotal: "54.00",
    });

    const edit = (orderId: string, dto: any) =>
      tenantCtx.run(tenantId, () => orders.updateOrderItems(orderId, dto, operator()));
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
      tenantId = (await raw.tenant.create({ data: { slug, name: `2443 ${slug}` } })).id;
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
          data: { userId: buyerUserId, businessName: "2443 co", contactName: "Tester", tenantId },
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
      await raw.user.deleteMany({ where: { id: { in: [operatorUserId, buyerUserId] } } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    it.each([
      ["unitLabel null (a cleared label)", null],
      ["the pack's own label (a named pack)", "Box"],
    ])("held Case + %s: 409 UNIT_AWARE_LINE, zero writes", async (_name, unitLabel) => {
      const cola = await product(`held-${unitLabel ?? "null"}`);
      const o = await order(heldCase(cola));
      const before = await rows(o.id); // full rows, ids included
      const stockBefore = await stock(cola);
      await expect(
        edit(o.id, { replaceAll: false, items: [{ id: o.lineItems[0].id, unitLabel, qty: 3 }] }),
      ).rejects.toMatchObject({ response: { code: "UNIT_AWARE_LINE" } });
      expect(await rows(o.id)).toEqual(before);
      expect(await stock(cola)).toBe(stockBefore);
    });

    it("a label-less pack line + unitLabel null (mobile's echo) is edited as before", async () => {
      const cola = await product("pack");
      const o = await order({
        productId: cola,
        qty: 6,
        boxes: 1,
        pieces: 0,
        unitsPerBox: 6,
        unitPrice: "10.00",
        subtotal: "10.00",
      });
      await edit(o.id, {
        replaceAll: false,
        items: [{ id: o.lineItems[0].id, unitLabel: null, qty: 12 }],
      });
      const [line] = await rows(o.id);
      expect(line.unitLabel).toBeNull();
      expect({ qty: Number(line.qty), boxes: line.boxes, pieces: line.pieces }).toEqual({
        qty: 12,
        boxes: 2,
        pieces: 0,
      });
      expect(Number(line.subtotal)).toBe(20);
    });
  },
);
