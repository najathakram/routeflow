/**
 * SA-407 (#2272) — real-Postgres pins THROUGH OrdersService.updateOrderItems() for a CUSTOMER editing a
 * unit line with the per-line diff: count up, count down, remove are converted (the staff
 * updateUnitLine at the line's OWN snapshot factor, ladder price at the new count, no promos); a unit
 * switch, boxes on a unit line, a new buyer unit line and a replace-all with a unit line are 409s; the
 * selling-restriction netting counts an id-matched unit line at its HELD factor (a repack nets 0, a
 * banned product's increase is refused, a decrease passes).
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), as orders-inline-return-edit.db.spec.ts
 * does. The selling-restrictions choke point is a recorder: it refuses any increase (or unsized line)
 * of the `banned` product and records every line it was handed, so the delta the planner computed is
 * observable. NOT RUN by the lane that wrote it (DB specs are the prover's): F2's DB lane runs it and
 * adjusts any fixture field the schema demands.
 *
 * SAFETY: one throwaway `qa-2272-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes
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
import { ConflictException, Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "SA-407 (#2272) — a buyer edits a unit line through the per-line diff, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-2272-${run}`, "buyer-unit-line-diff.db.spec.ts");
    let tenantId = "";
    let buyerUserId = "";
    let customerId = "";
    const productIds: string[] = [];
    const orderIds: string[] = [];
    const hooks = { reconcileDraft: jest.fn(), resync: jest.fn() };
    /** Every line the restriction choke point was handed, and the product it refuses to grow. */
    const seen: Array<{ productId: string; qtyDelta?: number }> = [];
    let banned = "";

    const buyer = (): JwtPayload =>
      ({
        sub: buyerUserId,
        username: `buyer-${run}`,
        role: "CUSTOMER",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;

    /** A 6-piece Box product with a Case of 12 at $100, and a PENDING order holding 3 Cases (36 pcs). */
    async function seed(tag: string) {
      const product = await raw.product.create({
        data: {
          name: `${tag} cola ${run}`,
          unit: "Box",
          pricePerUnit: "55.00",
          unitsPerBox: 6,
          currentStock: "10000",
          tenantId,
        },
      });
      productIds.push(product.id);
      await raw.productUnit.create({
        data: { tenantId, productId: product.id, label: "Case", factorToBase: 12, price: "100.00" },
      });
      const order = await raw.order.create({
        data: {
          customerId,
          tenantId,
          status: "PENDING",
          subtotal: "300.00",
          total: "300.00",
          lineItems: {
            create: [
              {
                productId: product.id,
                tenantId,
                unitLabel: "Case",
                unitsPerBox: 12,
                qty: 36,
                boxes: 3,
                pieces: 0,
                unitPrice: "100.00",
                subtotal: "300.00",
              },
            ],
          },
        },
        include: { lineItems: true },
      });
      orderIds.push(order.id);
      return { productId: product.id, orderId: order.id, lineId: order.lineItems[0].id };
    }

    const edit = (orderId: string, dto: any) =>
      tenantCtx.run(tenantId, () => orders.updateOrderItems(orderId, dto, buyer()));
    const count = (lineId: string, qty: number, extra: Record<string, unknown> = {}) => ({
      replaceAll: false,
      items: [{ id: lineId, unitLabel: "Case", qty, ...extra }],
    });
    const line = (id: string) => raw.orderItem.findUniqueOrThrow({ where: { id } });

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
          getPolicy: async () => ({ enabled: true, addressPrecedence: "BILLING_FIRST" }),
          assertLinesSellable: async (a: {
            lines: Array<{ productId: string; qtyDelta?: number }>;
          }) => {
            seen.push(...a.lines);
            const grows = a.lines.some(
              (l) => l.productId === banned && (l.qtyDelta === undefined || l.qtyDelta > 0),
            );
            if (grows)
              throw new ConflictException({ code: "SELLING_RESTRICTED", message: "banned" });
          },
        },
        authGuard: { assertAuthorizedOrThrow: async () => undefined },
        promotionsService: { activeForCatalog: async () => [] },
        tenantCtx,
        invoicesService: {
          revertLinkedInvoicesForOrderEdit: async () => undefined,
          resyncOrderInvoicesForEdit: hooks.resync,
          reconcileOrderDraftInvoice: hooks.reconcileDraft,
        },
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
      });
      tenantId = (await raw.tenant.create({ data: { slug, name: `2272 ${slug}` } })).id;
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
          data: { userId: buyerUserId, businessName: "2272 co", contactName: "Tester", tenantId },
        })
      ).id;
    }, 120_000);

    beforeEach(() => {
      seen.length = 0;
      banned = "";
      hooks.reconcileDraft.mockReset().mockResolvedValue(undefined);
      hooks.resync.mockReset().mockResolvedValue([]);
    });

    afterAll(async () => {
      await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
      await raw.productUnit.deleteMany({ where: { productId: { in: productIds } } });
      await raw.product.deleteMany({ where: { id: { in: productIds } } });
      await raw.customer.deleteMany({ where: { id: customerId } });
      await raw.user.deleteMany({ where: { id: buyerUserId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    it("3 → 4 Cases: qty 48 / boxes 4 at the Case ladder price, and the draft mirror reconciles", async () => {
      const f = await seed("up");
      await edit(f.orderId, count(f.lineId, 4));
      const li = await line(f.lineId);
      expect(Number(li.qty)).toBe(48);
      expect(li.boxes).toBe(4);
      expect(li.unitLabel).toBe("Case");
      expect(li.unitsPerBox).toBe(12);
      expect(Number(li.unitPrice)).toBe(100);
      expect(Number(li.subtotal)).toBe(400);
      expect(hooks.reconcileDraft).toHaveBeenCalled();
    });

    it("4 → 2 Cases: qty 24 / boxes 2", async () => {
      const f = await seed("down");
      await edit(f.orderId, count(f.lineId, 4));
      await edit(f.orderId, count(f.lineId, 2));
      const li = await line(f.lineId);
      expect(Number(li.qty)).toBe(24);
      expect(li.boxes).toBe(2);
    });

    it("remove: a CANCEL by id strikes the line off, nothing else", async () => {
      const f = await seed("rm");
      await edit(f.orderId, { replaceAll: false, items: [{ id: f.lineId, action: "CANCEL" }] });
      const li = await line(f.lineId);
      expect(li.status).toBe("CANCELLED");
      expect(await raw.orderItem.count({ where: { orderId: f.orderId } })).toBe(1);
    });

    it("SA-507b: a buyer CANCEL/DELETE naming ANOTHER order's line is a 400; that line is untouched", async () => {
      const mine = await seed("idor-mine");
      const other = await seed("idor-other");
      const before = await line(other.lineId);
      for (const action of ["CANCEL", "DELETE"]) {
        await expect(
          edit(mine.orderId, { replaceAll: false, items: [{ id: other.lineId, action }] }),
        ).rejects.toMatchObject({ status: 400 });
      }
      expect(await line(other.lineId)).toEqual(before);
      expect(await raw.orderItem.count({ where: { id: other.lineId } })).toBe(1);
    });

    it("SA-507b: a tier-3 buyer's count edit is priced at the Case's TIER-3 ladder price", async () => {
      const f = await seed("tier3");
      await raw.productUnit.updateMany({
        where: { productId: f.productId, label: "Case" },
        data: { priceTier3: "90.00" },
      });
      await raw.customer.update({ where: { id: customerId }, data: { pricingTier: 3 } });
      try {
        await edit(f.orderId, count(f.lineId, 4));
      } finally {
        await raw.customer.update({ where: { id: customerId }, data: { pricingTier: 1 } });
      }
      const li = await line(f.lineId);
      expect(Number(li.unitPrice)).toBe(90); // tier 1 would be 100
      expect(Number(li.subtotal)).toBe(360);
    });

    it.each([
      [
        "a unit switch",
        (id: string) => ({ replaceAll: false, items: [{ id, unitLabel: "Box", qty: 1 }] }),
      ],
      ["boxes on a unit line", (id: string) => count(id, 4, { boxes: 4 })],
      [
        "a new buyer unit line",
        (_id: string, pid?: string) => ({
          replaceAll: false,
          items: [{ productId: pid, unitLabel: "Case", qty: 1 }],
        }),
      ],
      [
        "a replace-all with a unit line",
        (_id: string, pid?: string) => ({
          replaceAll: true,
          items: [{ productId: pid, qty: 48 }],
        }),
      ],
    ])("%s is a 409 UNIT_AWARE_LINE and writes nothing", async (_name, payload) => {
      const f = await seed(`refuse-${randomUUID().slice(0, 4)}`);
      await expect(edit(f.orderId, (payload as any)(f.lineId, f.productId))).rejects.toMatchObject({
        response: { code: "UNIT_AWARE_LINE" },
      });
      const li = await line(f.lineId);
      expect(Number(li.qty)).toBe(36);
      expect(li.boxes).toBe(3);
    });

    it("repacked Case 12 → 24: an unchanged re-send nets 0 and the line's factor stays 12", async () => {
      const f = await seed("repack");
      await raw.productUnit.updateMany({
        where: { productId: f.productId, label: "Case" },
        data: { factorToBase: 24 },
      });
      await edit(f.orderId, count(f.lineId, 3));
      expect(seen.filter((l) => l.productId === f.productId)).toEqual([
        { productId: f.productId, qtyDelta: 0 },
      ]);
      const li = await line(f.lineId);
      expect(li.unitsPerBox).toBe(12);
      expect(Number(li.qty)).toBe(36);
    });

    it("a banned product: 3 → 4 Cases is refused, 3 → 2 is allowed", async () => {
      const f = await seed("banned");
      banned = f.productId;
      await expect(edit(f.orderId, count(f.lineId, 4))).rejects.toMatchObject({
        response: { code: "SELLING_RESTRICTED" },
      });
      expect(Number((await line(f.lineId)).qty)).toBe(36);
      await edit(f.orderId, count(f.lineId, 2));
      expect(Number((await line(f.lineId)).qty)).toBe(24);
    });
  },
);
