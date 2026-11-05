/**
 * SA-1101 A-6 Part 2 (B1279), row RO-38, on REAL Postgres: an unpinned inline-return capture gets each chunk's source
 * order from the matching set (DELIVERED orders only) and never locks those orders. Before this, an office change that
 * moves the source order out of DELIVERED could commit while a capture for the same customer was pricing, and the
 * capture then restocked against an order that is no longer DELIVERED. The live-return guard now takes the customer's
 * returns lock first (the key every create / capture / approve takes), so the capture WAITS for the demotion and then
 * reads the order as CONFIRMED: its matching set excludes it and no chunk is sourced from it.
 *
 * The demotion side is held open (guard run on a real transaction, status written, commit withheld); the capture is
 * the REAL InlineReturnsService.capture over the same wiring as inline-returns-capture-concurrency.db.spec.ts.
 * Test tenant only (qa-b1279-race-*). Run: `npm run local:test:db`.
 */
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
import { NumberingService } from "../import/numbering.service";
import { IdempotencyService } from "../common/idempotency.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { InlineReturnsService } from "./inline-returns.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { lockThenAssertNoLiveReturn } from "./live-return-guard";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "SA-1101 A-6 Part 2 (B1279): the live-return guard takes the customer returns lock — capture side, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient; // superuser fixture client — deliberately unscoped
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let svc: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(
      `qa-b1279-race-${run}`,
      "live-return-guard-customer-lock.b1279.db.spec.ts",
    );
    let tenantId = "";
    const orderIds: string[] = [];
    const customerIds: string[] = [];
    const productIds: string[] = [];
    const userIds: string[] = [];
    const invoiceIds: string[] = [];

    function driverUser(sub: string): JwtPayload {
      return {
        sub,
        username: `driver-${sub.slice(0, 6)}`,
        role: "DRIVER" as any,
        status: "ACTIVE" as any,
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      };
    }

    /** One product + one driver-owned carrying order (DELIVERED, `total`, on a real route
     * run stop) — no Invoice at all, so every captured item prices UNREFERENCED. */
    async function seedOrder(tag: string, total: number) {
      const product = await raw.product.create({
        data: { name: `${tag} product ${run}`, unit: "each", pricePerUnit: "10.00", tenantId },
      });
      productIds.push(product.id);
      const driverUserRow = await raw.user.create({
        data: {
          email: `${tag}-drv-${run}@example.test`,
          username: `${tag}-drv-${run}`,
          role: "DRIVER",
          tenantId,
        },
      });
      userIds.push(driverUserRow.id);
      // RouteRun.driverId is a real FK to Driver (the profile row), never User directly.
      const driver = await raw.driver.create({
        data: { userId: driverUserRow.id, tenantId },
      });
      const custUser = await raw.user.create({
        data: {
          email: `${tag}-cust-${run}@example.test`,
          username: `${tag}-cust-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      userIds.push(custUser.id);
      const customer = await raw.customer.create({
        data: {
          userId: custUser.id,
          businessName: `${tag} co`,
          contactName: "B467 Tester",
          tenantId,
        },
      });
      customerIds.push(customer.id);
      const route = await raw.route.create({ data: { name: `${tag} route ${run}`, tenantId } });
      const routeStop = await raw.routeStop.create({
        data: { routeId: route.id, stopNumber: 1, tenantId },
      });
      const routeRun = await raw.routeRun.create({
        data: {
          routeId: route.id,
          driverId: driver.id,
          status: "IN_PROGRESS",
          scheduledDate: new Date(),
          tenantId,
        },
      });
      const routeRunStop = await raw.routeRunStop.create({
        data: {
          routeRunId: routeRun.id,
          routeStopId: routeStop.id,
          customerId: customer.id,
          stopNumber: 1,
          status: "IN_PROGRESS",
          podPhotoUrls: [],
          tenantId,
        },
      });
      const order = await raw.order.create({
        data: {
          customerId: customer.id,
          tenantId,
          status: "DELIVERED",
          total: total.toFixed(2),
          routeRunId: routeRun.id,
          routeRunStopId: routeRunStop.id,
        },
      });
      orderIds.push(order.id);
      return {
        productId: product.id,
        customerId: customer.id,
        // The JWT `sub` a captured-by/audit field stores is the USER id, never the
        // Driver-profile id — keep them distinct even though this fixture creates one
        // Driver row per driver user.
        driverId: driverUserRow.id,
        orderId: order.id,
        routeRunStopId: routeRunStop.id,
      };
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();

      const idempotency = new IdempotencyService();
      const numbering = new NumberingService(prisma);
      const ledger = new RegulatedLedgerService(prisma);
      // EncryptionService needs a real ConfigService only to read ENCRYPTION_KEY/nodeEnv —
      // a fake returning undefined for both is exactly the "no key configured" dev fallback
      // path this service already has for a real (unconfigured) local/test environment; the
      // tax-rate key this test's unreferenced pricing reads is never a SECRET_KEY, so
      // encryption is never actually exercised here.
      const systemConfig = new SystemConfigService(
        prisma,
        new EncryptionService({ get: () => undefined } as any),
      );
      const quoteService = new InlineReturnsQuoteService(prisma, systemConfig);
      // `Object.create` runs no constructor — every instance FIELD the exercised code
      // dereferences must be supplied here (see returns-idempotency.db.spec.ts's note).
      const creditNotes = Object.assign(Object.create(CreditNotesService.prototype), {
        prisma,
        gateway: { emitCreditNoteCreated: jest.fn() },
        ledger,
        commissionEngine: {}, // never touched by mintStandaloneInTx (no invoice application here)
        numbering,
        logger: new Logger(CreditNotesService.name),
      });
      svc = Object.assign(Object.create(InlineReturnsService.prototype), {
        prisma,
        gateway: { emitCreditNoteCreated: jest.fn() },
        ledger,
        creditNotes,
        numbering,
        addonService: { hasAddon: async () => true },
        quoteService,
        idempotency,
      });

      tenantId = (await raw.tenant.create({ data: { slug, name: `B1279 Race ${slug}` } })).id;
    }, 120_000);

    afterAll(async () => {
      for (const orderId of orderIds) {
        await raw.orderCreditNote.deleteMany({ where: { orderId } });
        await raw.returnItem.deleteMany({ where: { return: { orderId } } });
        await raw.return.deleteMany({ where: { orderId } });
      }
      await raw.creditNote.deleteMany({ where: { tenantId } });
      await raw.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.routeRunStop.deleteMany({ where: { tenantId } });
      await raw.routeRun.deleteMany({ where: { tenantId } });
      await raw.routeStop.deleteMany({ where: { tenantId } });
      await raw.route.deleteMany({ where: { tenantId } });
      await raw.customer.deleteMany({ where: { id: { in: customerIds } } });
      // StockMovement (written by restockReturnItems) references productId — must clear
      // before deleting Product. Driver (RouteRun.driverId's real target) references
      // userId — must clear before deleting User.
      await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
      await raw.product.deleteMany({ where: { id: { in: productIds } } });
      await raw.driver.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { id: { in: userIds } } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    const staffOf = (sub: string): JwtPayload => ({
      sub,
      username: "operator",
      role: "OPERATOR" as any,
      status: "ACTIVE" as any,
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    });
    const itemsOf = (returnId: string) => raw.returnItem.findMany({ where: { returnId } });

    /** One DELIVERED sale of the product to the customer, `daysAgo` days back (outside the 90-day pricing window). */
    async function seedOldSale(
      f: { customerId: string; productId: string },
      daysAgo: number,
    ): Promise<string> {
      const order = await raw.order.create({
        data: {
          customerId: f.customerId,
          tenantId,
          status: "DELIVERED",
          subtotal: "100.00",
          total: "100.00",
        },
      });
      orderIds.push(order.id);
      await raw.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: f.productId,
          name: "Widget",
          qty: 10,
          unitPrice: "10.00",
          subtotal: "100.00",
        } as any,
      });
      const invoice = await raw.invoice.create({
        data: {
          tenantId,
          customerId: f.customerId,
          orderId: order.id,
          invoiceNumber: `INV-1060-${run}-${invoiceIds.length}`,
          status: "PAID",
          subtotal: "100.00",
          taxAmount: "0.00",
          total: "100.00",
          issueDate: new Date(Date.now() - daysAgo * 86_400_000),
        } as any,
      });
      invoiceIds.push(invoice.id);
      await raw.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          productId: f.productId,
          description: "Widget",
          qty: 10,
          unitPrice: "10.00",
          subtotal: "100.00",
        },
      });
      return order.id;
    }

    const captureQty = (
      f: { customerId: string; orderId: string; productId: string },
      user: JwtPayload,
      item: Record<string, unknown>,
      returnKey: string,
      extra: Record<string, unknown> = {},
    ) =>
      tenantCtx.run(tenantId, () =>
        svc.capture(
          {
            customerId: f.customerId,
            orderId: f.orderId,
            items: [{ productId: f.productId, ...item }],
            returnKey,
            ...extra,
          },
          user,
        ),
      );

    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const DEMOTE_MESSAGE =
      "This order has a return. To change its delivery status, cancel the return first.";

    it("RO-38: the demotion of X holds the customer lock; an unpinned capture started meanwhile WAITS, then its matching set excludes X (no chunk sourced from X)", async () => {
      const f = await seedOrder("ro38", 500);
      const sourceX = await seedOldSale(f, 120); // X: DELIVERED, sold 10 of the product 120 days ago
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let guarded!: () => void;
      const guardDone = new Promise<void>((r) => (guarded = r));

      // The office demotion: the live-return guard (its locks, then the count), the status write, commit withheld.
      const demotion = tenantCtx.run(tenantId, () =>
        prisma.tenantTransaction(async (tx: any) => {
          await lockThenAssertNoLiveReturn(tx, [sourceX], DEMOTE_MESSAGE);
          await tx.order.update({ where: { id: sourceX }, data: { status: "CONFIRMED" } });
          guarded();
          await gate;
        }),
      );
      let settled = false;
      let capture: Promise<any> | undefined;
      try {
        await guardDone;
        capture = captureQty(f, staffOf(f.driverId), { qty: 3 }, `ro38-${run}`).then(
          (v: any) => ((settled = true), v),
          (e: unknown) => {
            settled = true;
            throw e;
          },
        );
        capture.catch(() => undefined);
        await pause(1500);
        expect(settled).toBe(false); // red today: the capture commits at once, sourced from X (still DELIVERED to it)
      } finally {
        release();
        await demotion;
      }
      const ret = await capture;
      const items = await itemsOf(ret.id);
      expect(items.map((i) => i.sourceOrderId)).toEqual([null]);
      expect((await raw.order.findUniqueOrThrow({ where: { id: sourceX } })).status).toBe(
        "CONFIRMED",
      );
    }, 60_000);
  },
);
