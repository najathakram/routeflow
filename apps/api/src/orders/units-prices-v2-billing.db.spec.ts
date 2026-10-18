/**
 * Units S19 (flag.units_prices_v2) on REAL Postgres: a staff edit through OrdersService.updateOrderItems() bills the
 * customer's TYPED unit price (CustomerUnitPrice, with its real price > 0 CHECK and unique key) for a new pack line, a
 * Case line and a Piece line (the 1-piece row is addressed by the level ref "base", never its ProductUnit id, SA-809);
 * flag off, or no row for that unit: master's price. Run on the Mac mini lane (DB specs are the prover's).
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), as buyer-unit-line-diff.db.spec.ts does.
 * SAFETY: one throwaway `qa-s19-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes what this run made.
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

const V2 = "flag.units_prices_v2";

describeDb("S19: billing reads typed customer unit prices, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-s19-${run}`, "units-prices-v2-billing.db.spec.ts");
  let tenantId = "";
  let staffUserId = "";
  let buyerUserId = "";
  let customerId = "";
  let productId = "";
  let caseId = "";
  let pieceId = "";
  let orderId = "";
  let v2On = true;
  const productIds: string[] = [];

  const staff = (): JwtPayload =>
    ({
      sub: staffUserId,
      username: `staff-${run}`,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  const add = (item: Record<string, unknown>) =>
    tenantCtx.run(tenantId, () =>
      orders.updateOrderItems(
        orderId,
        { replaceAll: false, items: [{ productId, ...item }] },
        staff(),
      ),
    );
  const lineFor = async (label: string | null) =>
    raw.orderItem.findFirstOrThrow({
      where: { orderId, productId, unitLabel: label },
      orderBy: { createdAt: "desc" },
    });
  const setTyped = async (rows: Array<[string, string]>) => {
    await raw.customerUnitPrice.deleteMany({ where: { customerId } });
    for (const [unitRef, price] of rows) {
      await raw.customerUnitPrice.create({
        data: { tenantId, customerId, productId, unitRef, price },
      });
    }
  };
  const resetLines = () => raw.orderItem.deleteMany({ where: { orderId, productId } });

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
      entitlements: (() => {
        const flagRead = async (_t: string, k: string) => k !== V2 || v2On;
        return { hasFlag: flagRead, hasFlagStrict: flagRead };
      })(),
      sellingRestrictions: {
        getPolicy: async () => ({ enabled: false }),
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
    tenantId = (await raw.tenant.create({ data: { slug, name: `s19 ${slug}` } })).id;
    staffUserId = (
      await raw.user.create({
        data: { email: `s-${run}@example.test`, username: `s-${run}`, role: "OPERATOR", tenantId },
      })
    ).id;
    buyerUserId = (
      await raw.user.create({
        data: { email: `b-${run}@example.test`, username: `b-${run}`, role: "CUSTOMER", tenantId },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId: buyerUserId, businessName: "s19 co", contactName: "Tester", tenantId },
      })
    ).id;
    // A 6-piece Box at $55 (pack), a Case of 12 at $100, a Piece at $10.
    const product = await raw.product.create({
      data: {
        name: `s19 cola ${run}`,
        unit: "Box",
        pricePerUnit: "55.00",
        unitsPerBox: 6,
        currentStock: "10000",
        tenantId,
      },
    });
    productId = product.id;
    productIds.push(productId);
    const other = await raw.product.create({
      data: {
        name: `s19 other ${run}`,
        unit: "Each",
        pricePerUnit: "3.00",
        currentStock: "100",
        tenantId,
      },
    });
    productIds.push(other.id);
    caseId = (
      await raw.productUnit.create({
        data: { tenantId, productId, label: "Case", factorToBase: 12, price: "100.00" },
      })
    ).id;
    pieceId = (
      await raw.productUnit.create({
        data: { tenantId, productId, label: "Piece", factorToBase: 1, price: "10.00" },
      })
    ).id;
    orderId = (
      await raw.order.create({
        data: {
          customerId,
          tenantId,
          status: "PENDING",
          subtotal: "3.00",
          total: "3.00",
          lineItems: {
            create: [
              { productId: other.id, tenantId, qty: 1, unitPrice: "3.00", subtotal: "3.00" },
            ],
          },
        },
      })
    ).id;
  }, 120_000);

  beforeEach(async () => {
    v2On = true;
    await setTyped([]);
    await resetLines();
  });

  afterAll(async () => {
    await raw.customerUnitPrice?.deleteMany({ where: { customerId } });
    await raw.orderRevision?.deleteMany?.({ where: { orderId } });
    await raw.orderItem.deleteMany({ where: { orderId } });
    await raw.order.deleteMany({ where: { id: orderId } });
    await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
    await raw.productUnit.deleteMany({ where: { productId: { in: productIds } } });
    await raw.product.deleteMany({ where: { id: { in: productIds } } });
    await raw.customer.deleteMany({ where: { id: customerId } });
    await raw.user.deleteMany({ where: { id: { in: [staffUserId, buyerUserId] } } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("flag on: a typed PACK price bills a new pack line (SPECIAL against list)", async () => {
    await setTyped([["pack", "48.00"]]);
    await add({ qty: 2 });
    const li = await lineFor(null);
    expect(Number(li.unitPrice)).toBe(48);
    expect(Number(li.originalPrice)).toBe(55);
    expect(li.priceType).toBe("SPECIAL");
  });

  it("flag on: a typed Case price (its ProductUnit id) bills a Case line; a Piece line with no row keeps the ladder price", async () => {
    await setTyped([[caseId, "90.00"]]);
    await add({ qty: 2, unitLabel: "Case" });
    expect(Number((await lineFor("Case")).unitPrice)).toBe(90);
    await add({ qty: 5, unitLabel: "Piece" });
    expect(Number((await lineFor("Piece")).unitPrice)).toBe(10);
  });

  it("flag on: the 1-piece row bills the level ref base, never the ProductUnit id; both rows present = the exact base row (SA-809)", async () => {
    await setTyped([
      ["base", "8.50"],
      [pieceId, "7.00"],
    ]);
    await add({ qty: 5, unitLabel: "Piece" });
    expect(Number((await lineFor("Piece")).unitPrice)).toBe(8.5);
    await setTyped([[pieceId, "7.00"]]);
    await resetLines();
    await add({ qty: 5, unitLabel: "Piece" });
    expect(Number((await lineFor("Piece")).unitPrice)).toBe(10);
  });

  it("flag OFF with typed rows present: master's prices (pack 55, Case 100)", async () => {
    v2On = false;
    await setTyped([
      ["pack", "48.00"],
      [caseId, "90.00"],
    ]);
    await add({ qty: 2 });
    await add({ qty: 2, unitLabel: "Case" });
    expect(Number((await lineFor(null)).unitPrice)).toBe(55);
    expect(Number((await lineFor("Case")).unitPrice)).toBe(100);
  });
});
