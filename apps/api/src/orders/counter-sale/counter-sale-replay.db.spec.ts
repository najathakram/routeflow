/**
 * SA-680 M1 — real-Postgres pin for the counter sale's same-key replay with a boxes-only line.
 *
 * The counter DTO makes `qty` optional (a boxed line arrives as boxes/pieces). Before the fix the line
 * reached create() without a qty, the replay's cart comparison keyed it as NaN against the stored piece
 * count and refused with a 409 "different cart": the clerk dropped the key and re-rang the sale (a second
 * order, a second stock decrement, a second tender). The counter now shapes the line through
 * `toCounterOrderItem` (the writer's own normalizeBoxesPieces) before create().
 *
 * Drives the REAL OrdersService.create() through the same `Object.create` harness as
 * orders-inline-return-create.db.spec.ts (side-effect collaborators faked), twice with one
 * Idempotency-Key and the line the counter hands create(): ONE order, ONE stock movement, and the replay
 * flag set on the second call. The payment (recordPayment) half is covered by the unit spec
 * counter-sale.service.spec.ts (one recordPayment on a same-key replay); it needs the invoice pipeline this
 * harness does not build. NOT RUN on the MacBook that wrote it (no Postgres): the DB lane runs it
 * (`npm run local:test:db`, test tenant only, collected only by jest.db.config.js).
 */
jest.mock("../../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { EncryptionService } from "../../common/encryption.service";
import { SystemConfigService } from "../../system-config/system-config.service";
import { OrdersService } from "../orders.service";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { toCounterOrderItem } from "./counter-sale-lines";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const PACK = 4;

describeDb(
  "SA-680 M1 — a counter sale's same-key replay with a boxes-only line, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-cs-replay-${run}`, "counter-sale-replay.db.spec.ts");
    let tenantId = "";
    let operatorId = "";
    let customerId = "";
    let customerUserId = "";
    const productIds: string[] = [];
    const extraUserIds: string[] = [];

    async function boxedProduct(): Promise<string> {
      const p = await raw.product.create({
        data: {
          name: `boxed ${randomUUID().slice(0, 6)} ${run}`,
          unit: "each",
          unitsPerBox: PACK,
          pricePerUnit: "2.50",
          currentStock: 100,
          tenantId,
        },
      });
      productIds.push(p.id);
      return p.id;
    }

    const staff = (): JwtPayload =>
      ({
        sub: operatorId,
        username: "operator",
        role: "OPERATOR",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;

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
        gateway: { emitOrderCreated: jest.fn(), emitUrgentOrder: jest.fn() },
        systemConfig,
        entitlements: { hasFlag: async () => true },
        sellingRestrictions: { assertLinesSellable: async () => undefined },
        authGuard: { assertAuthorizedOrThrow: async () => undefined },
        promotionsService: { activeForCatalog: async () => [] },
        ledger: {},
        tenantCtx,
        logger: new Logger(OrdersService.name),
      });
      tenantId = (await raw.tenant.create({ data: { slug, name: `CS replay ${slug}` } })).id;
      operatorId = (
        await raw.user.create({
          data: {
            email: `op-${run}@example.test`,
            username: `op-${run}`,
            role: "OPERATOR",
            tenantId,
          },
        })
      ).id;
      customerUserId = (
        await raw.user.create({
          data: {
            email: `c-${run}@example.test`,
            username: `c-${run}`,
            role: "CUSTOMER",
            tenantId,
          },
        })
      ).id;
      customerId = (
        await raw.customer.create({
          data: {
            userId: customerUserId,
            businessName: "cs replay co",
            contactName: "Tester",
            tenantId,
          },
        })
      ).id;
    }, 120_000);

    afterAll(async () => {
      const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
        (o) => o.id,
      );
      await raw.orderIdempotencyKey.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
      await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: ids } } });
      await raw.order.deleteMany({ where: { id: { in: ids } } });
      await raw.product.deleteMany({ where: { id: { in: productIds } } });
      await raw.customer.deleteMany({ where: { id: customerId } });
      await raw.systemConfig.deleteMany({ where: { tenantId } });
      // soldById is ON DELETE SET NULL, but the orders are gone first anyway
      await raw.user.deleteMany({
        where: { id: { in: [operatorId, customerUserId, ...extraUserIds] } },
      });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    it.each([
      ["boxes only", { boxes: 2 }, 8],
      ["pieces only", { pieces: 5 }, 5],
      ["boxes and pieces", { boxes: 1, pieces: 3 }, 7],
    ])(
      "%s: the same-key retry replays: one order, one stock movement, no 409",
      async (_n, line, pieces) => {
        const productId = await boxedProduct();
        const key = `cs-replay-${randomUUID()}`;
        const items = () => [toCounterOrderItem({ productId, ...line } as never, PACK)];
        const ring = (onReplay?: () => void) =>
          tenantCtx.run(tenantId, () =>
            orders.create({ customerId, items: items(), idempotencyKey: key }, staff(), {
              skipAutoMerge: true,
              onReplay,
            }),
          );

        const first = await ring();
        let replayed = false;
        const second = await ring(() => (replayed = true));

        expect(replayed).toBe(true);
        expect(second.id).toBe(first.id);
        expect(await raw.order.count({ where: { tenantId, idempotencyKey: key } })).toBe(1);
        const moves = await raw.stockMovement.findMany({ where: { productId, type: "SALE" } });
        expect(moves).toHaveLength(1);
        expect(Math.abs(Number(moves[0].quantity))).toBe(pieces);
        const after = await raw.product.findUniqueOrThrow({ where: { id: productId } });
        expect(Number(after.currentStock)).toBe(100 - pieces);
      },
      60_000,
    );

    // Row 317: the counter write stamps Order.soldById; a same-key replay by ANOTHER cashier writes nothing, so the first stays.
    it("a counter sale stamps soldById with the acting staff user, and a replay by another cashier does not overwrite it", async () => {
      const productId = await boxedProduct();
      const key = `cs-sold-${randomUUID()}`;
      const other = await raw.user.create({
        data: {
          email: `op2-${run}@example.test`,
          username: `op2-${run}`,
          role: "OPERATOR",
          tenantId,
        },
      });
      extraUserIds.push(other.id);
      const ring = (user: JwtPayload) =>
        tenantCtx.run(tenantId, () =>
          orders.create(
            {
              customerId,
              items: [toCounterOrderItem({ productId, boxes: 1 } as never, PACK)],
              idempotencyKey: key,
            },
            user,
            { skipAutoMerge: true, counterSale: true },
          ),
        );

      const first = await ring(staff());
      const replay = await ring({ ...staff(), sub: other.id });

      expect(replay.id).toBe(first.id);
      const stored = await raw.order.findUniqueOrThrow({
        where: { id: first.id },
        select: { soldById: true },
      });
      expect(stored.soldById).toBe(operatorId);
    }, 60_000);
  },
);
