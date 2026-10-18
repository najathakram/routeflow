/**
 * DB-lane proof for GET products/:productId/customer-prices (real Postgres, throwaway `qa-*` tenants).
 *
 * Run by F2's DB lane (`npm run local:test:db`); collected only by `jest.db.config.js`. `requireLocalDatabaseUrl()`
 * refuses any non-local host; every tenant is a `qa-*` slug approved by `assertTestTenant`.
 *
 * Proves the real query (the relation filter, the nested selects and the tenant proxy): who is listed, the tier and
 * order unit read from the customer-product row, newest first, soft-deleted customers left out, the 500 cap with
 * `truncated`, and that another tenant's product is a 404 and its customers never leak.
 */
import { NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import {
  CUSTOMER_PRICES_CAP,
  ProductCustomerPricesService,
} from "./product-customer-prices.service";
import { ProductPriceGridService } from "./product-price-grid.service";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const FILE = "product-customer-prices.db.spec.ts";
const RUN = randomUUID().slice(0, 8);
let seq = 0;

describeDb("units v2 customer prices - real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: ProductCustomerPricesService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductCustomerPricesService,
        ProductPriceGridService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(ProductCustomerPricesService);
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        await prisma.customerUnitPrice.deleteMany({ where: { tenantId } });
        await prisma.customerPrice.deleteMany({ where: { tenantId } });
        await prisma.productUnit.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.customer.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      })().catch(() => {
        // Best-effort cleanup must never mask a test's own result.
      });
    }
    await prisma?.$disconnect();
  });

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  async function seedTenant(label: string) {
    seq += 1;
    const slug = assertTestTenant(`qa-cprices-${RUN}-${seq}-${label}`, FILE);
    const tenant = await prisma.tenant.create({ data: { slug, name: `cprices ${slug}` } });
    tenantIds.push(tenant.id);
    const product = await prisma.product.create({
      data: {
        tenantId: tenant.id,
        name: "Prices Box",
        sku: `CP-${randomUUID().slice(0, 6)}`,
        unit: "Box",
        unitsPerBox: 12,
        pricePerUnit: "12.00",
        priceTier2: "11.00",
      },
    });
    await prisma.productUnit.create({
      data: { tenantId: tenant.id, productId: product.id, label: "Case", factorToBase: 72 },
    });
    return { tenantId: tenant.id, productId: product.id };
  }

  async function seedCustomer(
    tenantId: string,
    label: string,
    over: { createdAt?: Date; pricingTier?: number; deletedAt?: Date; displayName?: string } = {},
  ) {
    const user = await prisma.user.create({
      data: {
        email: `cp-${RUN}-${randomUUID().slice(0, 6)}@example.test`,
        username: `cp-${RUN}-${randomUUID().slice(0, 8)}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    return prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `${label} Wholesale`,
        contactName: `${label} Buyer`,
        tenantId,
        ...over,
      },
    });
  }

  const price = (
    t: { tenantId: string; productId: string },
    customerId: string,
    unitRef: string,
    p: string,
  ) =>
    prisma.customerUnitPrice.create({
      data: { tenantId: t.tenantId, productId: t.productId, customerId, unitRef, price: p },
    });

  it("lists only customers with a typed price on this product: shape, tier, order unit and prices", async () => {
    const t = await seedTenant("shape");
    const a = await seedCustomer(t.tenantId, "Acme", { pricingTier: 2, displayName: "Acme Foods" });
    const b = await seedCustomer(t.tenantId, "Bravo");
    const noPrice = await seedCustomer(t.tenantId, "Nobody");
    const other = await prisma.product.create({
      data: {
        tenantId: t.tenantId,
        name: "Other",
        sku: `O-${RUN}-${seq}`,
        unit: "Box",
        unitsPerBox: 12,
        pricePerUnit: "5.00",
        priceTier2: "4.00",
      },
    });
    await price(t, a.id, "pack", "13.50");
    await price(t, a.id, "base", "0.5");
    await price(t, b.id, "pack", "12.00");
    await prisma.customerUnitPrice.create({
      data: {
        tenantId: t.tenantId,
        productId: other.id,
        customerId: noPrice.id,
        unitRef: "pack",
        price: "9",
      },
    });
    // a's own tier and order unit for THIS product; b has none
    await prisma.customerPrice.create({
      data: {
        tenantId: t.tenantId,
        customerId: a.id,
        productId: t.productId,
        pricingTier: 4,
        orderUnitRef: "pack",
      },
    });
    const res = await inTenant(t.tenantId, () => service.get(t.productId));
    const product = await prisma.product.findUniqueOrThrow({ where: { id: t.productId } });
    expect(res.productId).toBe(t.productId);
    expect(res.revision).toBe(Number(product.priceRevision));
    expect(res.truncated).toBe(false);
    const byId = Object.fromEntries(res.customers.map((c) => [c.customerId, c]));
    expect(Object.keys(byId).sort()).toEqual([a.id, b.id].sort());
    expect(byId[a.id]).toEqual({
      customerId: a.id,
      name: "Acme Foods",
      tier: 4,
      orderUnit: "pack",
      set: { pack: 13.5, base: 0.5 },
    });
    expect(byId[b.id]).toEqual({
      customerId: b.id,
      name: "Bravo Wholesale",
      tier: 1,
      orderUnit: null,
      set: { pack: 12 },
    });
  });

  it("lists newest customers first and leaves soft-deleted customers out", async () => {
    const t = await seedTenant("order");
    const old = await seedCustomer(t.tenantId, "Old", { createdAt: new Date("2026-01-01") });
    const mid = await seedCustomer(t.tenantId, "Mid", { createdAt: new Date("2026-06-01") });
    const fresh = await seedCustomer(t.tenantId, "Fresh", { createdAt: new Date("2026-10-01") });
    const gone = await seedCustomer(t.tenantId, "Gone", { deletedAt: new Date("2026-10-02") });
    for (const c of [old, mid, fresh, gone]) await price(t, c.id, "pack", "10");
    const res = await inTenant(t.tenantId, () => service.get(t.productId));
    expect(res.customers.map((c) => c.customerId)).toEqual([fresh.id, mid.id, old.id]);
  });

  it("caps at 500 customers and says truncated when more exist", async () => {
    const t = await seedTenant("cap");
    const total = CUSTOMER_PRICES_CAP + 1;
    const users = Array.from({ length: total }, (_, i) => ({
      id: randomUUID(),
      email: `cap-${RUN}-${seq}-${i}@example.test`,
      username: `cap-${RUN}-${seq}-${i}`,
      role: "CUSTOMER" as const,
      tenantId: t.tenantId,
    }));
    await prisma.user.createMany({ data: users });
    const customers = users.map((u, i) => ({
      id: randomUUID(),
      userId: u.id,
      businessName: `Cap ${i}`,
      contactName: `Cap ${i}`,
      tenantId: t.tenantId,
      createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000),
    }));
    await prisma.customer.createMany({ data: customers });
    await prisma.customerUnitPrice.createMany({
      data: customers.map((c) => ({
        tenantId: t.tenantId,
        productId: t.productId,
        customerId: c.id,
        unitRef: "pack",
        price: "10",
      })),
    });
    const res = await inTenant(t.tenantId, () => service.get(t.productId));
    expect(res.customers).toHaveLength(CUSTOMER_PRICES_CAP);
    expect(res.truncated).toBe(true);
    // newest first: the oldest customer is the one cut
    expect(res.customers[0].customerId).toBe(customers[total - 1].id);
    expect(res.customers.some((c) => c.customerId === customers[0].id)).toBe(false);
  });

  it("an empty product answers customers: [] and a product outside the caller's tenant is 404", async () => {
    const a = await seedTenant("empty-a");
    const b = await seedTenant("empty-b");
    const stranger = await seedCustomer(b.tenantId, "Stranger");
    await price(b, stranger.id, "pack", "10");
    await expect(inTenant(a.tenantId, () => service.get(a.productId))).resolves.toMatchObject({
      customers: [],
      truncated: false,
    });
    await expect(inTenant(a.tenantId, () => service.get(b.productId))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // and b's customers never appear in a's own answer
    const mine = await inTenant(a.tenantId, () => service.get(a.productId));
    expect(mine.customers.map((c) => c.customerId)).not.toContain(stranger.id);
  });
});
