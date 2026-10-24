/**
 * #2275 / SA-408 — real-Postgres pins THROUGH OrdersService.updateOrderItems() on the STAFF per-line
 * diff: the selling-restriction netting of a units_v1 line compares in PIECES at the HELD row's
 * snapshot factor. Before the fix a count (4) was compared to the stored pieces (36), so 3 → 4 Cases
 * of a banned product passed as a −32 decrease.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), as orders-inline-return-edit.db.spec.ts
 * does. The choke point is a recorder: it refuses any increase (or unsized line) of the `banned`
 * product and records every line handed to it, so the planner's delta is observable. NOT RUN by the
 * lane that wrote it (DB specs are the prover's): F2's DB lane runs it and adjusts any fixture field
 * the schema demands.
 *
 * SAFETY: one throwaway `qa-2275-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes
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
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "#2275 — a staff unit-line edit nets in pieces at the held factor, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-2275-${run}`, "unit-line-restriction-netting.db.spec.ts");
    let tenantId = "";
    let operatorUserId = "";
    let buyerUserId = "";
    let customerId = "";
    const productIds: string[] = [];
    const orderIds: string[] = [];
    /** Every line the restriction choke point was handed, and the product it refuses to grow. */
    const seen: Array<{ productId: string; qtyDelta?: number }> = [];
    let banned = "";

    const staff = (): JwtPayload =>
      ({
        sub: operatorUserId,
        username: `op-${run}`,
        role: "OPERATOR",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;

    /** A 6-piece Box product with a Case of 12 at $100, and a PENDING order holding 3 Cases (36 pcs). */
    async function seed(tag: string, snapshot: number | null = 12) {
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
                unitsPerBox: snapshot,
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

    const count = (orderId: string, lineId: string, qty: number) =>
      tenantCtx.run(tenantId, () =>
        orders.updateOrderItems(
          orderId,
          { replaceAll: false, items: [{ id: lineId, unitLabel: "Case", qty }] },
          staff(),
        ),
      );
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
            lines: Array<{ productId: string; qtyDelta?: number; lineKey?: string }>;
          }) => {
            // row 510: each judged line also carries the key a warning echoes; the netting is what these specs pin
            seen.push(...a.lines.map(({ lineKey: _lineKey, ...line }) => line));
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
          resyncOrderInvoicesForEdit: async () => [],
          ...INVOICE_EDIT_STUBS,
          reconcileOrderDraftInvoice: async () => undefined,
        },
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
      });
      tenantId = (await raw.tenant.create({ data: { slug, name: `2275 ${slug}` } })).id;
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
          data: { userId: buyerUserId, businessName: "2275 co", contactName: "Tester", tenantId },
        })
      ).id;
    }, 120_000);

    beforeEach(() => {
      seen.length = 0;
      banned = "";
    });

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

    it("a banned product: 3 → 4 Cases (+12 pieces) is REFUSED and nothing is written (master: −32 passed)", async () => {
      const f = await seed("up");
      banned = f.productId;
      await expect(count(f.orderId, f.lineId, 4)).rejects.toMatchObject({
        response: { code: "SELLING_RESTRICTED" },
      });
      expect(seen).toContainEqual({ productId: f.productId, qtyDelta: 12 });
      expect(Number((await line(f.lineId)).qty)).toBe(36);
    });

    it("a banned product: 3 → 2 Cases (−12 pieces) is allowed", async () => {
      const f = await seed("down");
      banned = f.productId;
      await count(f.orderId, f.lineId, 2);
      expect(seen).toContainEqual({ productId: f.productId, qtyDelta: -12 });
      expect(Number((await line(f.lineId)).qty)).toBe(24);
    });

    it("repacked Case 12 → 24: an unchanged re-send nets 0 and the line keeps its factor", async () => {
      const f = await seed("repack");
      await raw.productUnit.updateMany({
        where: { productId: f.productId, label: "Case" },
        data: { factorToBase: 24 },
      });
      await count(f.orderId, f.lineId, 3);
      expect(seen.filter((l) => l.productId === f.productId)).toEqual([
        { productId: f.productId, qtyDelta: 0 },
      ]);
      const li = await line(f.lineId);
      expect(li.unitsPerBox).toBe(12);
      expect(Number(li.qty)).toBe(36);
    });

    it("SA-408b: a held Case line with NO snapshot factor — 3 → 4 on a banned product is REFUSED (unsized, never the live pack)", async () => {
      const f = await seed("nosnap", null);
      banned = f.productId;
      await expect(count(f.orderId, f.lineId, 4)).rejects.toMatchObject({
        response: { code: "SELLING_RESTRICTED" },
      });
      expect(seen).toContainEqual({ productId: f.productId });
      expect(Number((await line(f.lineId)).qty)).toBe(36);
    });

    // #2288 / SA-447: the write re-denominates a held unit line whose label is CLEARED (null) to the
    // PACK; the netting must agree, so the edit is a re-denomination — unsized, checked in full.
    const edit = (orderId: string, item: Record<string, unknown>) =>
      tenantCtx.run(tenantId, () =>
        orders.updateOrderItems(orderId, { replaceAll: false, items: [item] } as any, staff()),
      );

    // SA-447 × SA-474 (SA-474c): a CLEARED label on a held unit line is now refused by SA-474's
    // assertNoPackRedenomination — 409 UNIT_AWARE_LINE, before the restriction netting is ever
    // reached (the same precedence the ABSENT-label case below pins). SA-447's re-denomination
    // netting rule stays pinned by the pure unitLineEdit cases for the day the units freeze lifts.
    it("SA-447 × SA-474: a banned product's held Case line with unitLabel CLEARED (null) is refused by UNIT_AWARE_LINE before the netting, nothing written", async () => {
      const f = await seed("clear");
      banned = f.productId;
      const linesOf = () =>
        raw.orderItem.findMany({ where: { orderId: f.orderId }, orderBy: { id: "asc" } });
      const stockOf = async () => ({
        onHand: String(
          (await raw.product.findUniqueOrThrow({ where: { id: f.productId } })).currentStock,
        ),
        movements: await raw.stockMovement.count({ where: { productId: f.productId } }),
      });
      const [linesBefore, stockBefore] = [await linesOf(), await stockOf()];
      await expect(
        edit(f.orderId, { id: f.lineId, unitLabel: null, qty: 3 }),
      ).rejects.toMatchObject({
        response: { code: "UNIT_AWARE_LINE" },
      });
      expect(seen).toEqual([]); // the restriction choke point is never reached
      expect(await linesOf()).toEqual(linesBefore); // no order-line write
      expect(await stockOf()).toEqual(stockBefore); // no stock write
      const li = await line(f.lineId);
      expect(li.unitLabel).toBe("Case"); // nothing written
      expect(Number(li.qty)).toBe(36);
      expect(li.unitsPerBox).toBe(12);
    });

    it("SA-447: with unitLabel ABSENT the edit never re-denominates — a qty edit is refused by UNIT_AWARE_LINE before the netting; a note-only edit nets nothing and is allowed", async () => {
      const f = await seed("absent");
      banned = f.productId;
      // assertUnitLabelNamed (updateOrderItems :2978) runs before assertLinesSellable (:3024).
      await expect(edit(f.orderId, { id: f.lineId, qty: 3 })).rejects.toMatchObject({
        response: { code: "UNIT_AWARE_LINE" },
      });
      expect(seen).toEqual([]);
      // Note-only, label absent (unitPrice/qty would be refused by UNIT_AWARE_LINE too): unitLineEdit
      // returns null (no quantity change) — never checked.
      await edit(f.orderId, { id: f.lineId, notes: "leave at the side door" });
      expect(seen.filter((l) => l.productId === f.productId)).toEqual([]);
      const li = await line(f.lineId);
      expect(li.unitLabel).toBe("Case");
      expect(Number(li.qty)).toBe(36);
      expect(li.notes).toBe("leave at the side door");
    });
  },
);
