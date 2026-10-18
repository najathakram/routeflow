/**
 * C0 part B DB-lane proof for the units v2 price grid (real Postgres, throwaway `qa-*` tenants).
 *
 * Run by F2's DB lane (`npm run local:test:db`, its own fresh database); collected only by
 * `jest.db.config.js`. `requireLocalDatabaseUrl()` refuses any non-local host; every tenant is a
 * `qa-*` slug approved by `assertTestTenant`.
 *
 * Proves: a caller gets the grid for its own product, and a product outside the caller's catalog
 * is a 404 (never another tenant's prices).
 */
import { NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { ProductPriceGridService } from "./product-price-grid.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-pgrid-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "product-price-grid.db.spec.ts",
  );
};

describeDb("units v2 price grid - real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: ProductPriceGridService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProductPriceGridService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(ProductPriceGridService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        await prisma.productUnit.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      })().catch(() => {
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function seedTenant(label: string): Promise<string> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `pgrid ${slug}` } });
    createdTenantIds.push(tenant.id);
    return tenant.id;
  }

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  async function seedProduct(tenantId: string) {
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: "Grid Box",
        sku: `GRID-${randomUUID().slice(0, 6)}`,
        unit: "Box",
        unitsPerBox: 12,
        pricePerUnit: "12.00",
        priceTier2: "11.00",
      },
    });
    await prisma.productUnit.create({
      data: { tenantId, productId: product.id, label: "Case", factorToBase: 72, price: "66.00" },
    });
    return product;
  }

  it("returns the grid for the caller's own product", async () => {
    const tenantId = await seedTenant("own");
    const product = await seedProduct(tenantId);
    const dto = await inTenant(tenantId, () => service.get(product.id));
    expect(dto.productId).toBe(product.id);
    expect(dto.rows.map((r) => r.label)).toEqual(["Case", "Box", "Piece"]);
    expect(dto.rows[0].cells[0]).toEqual({ tier: 1, source: "set", value: 66 });
  });

  it("returns 404 for a product outside the caller's catalog", async () => {
    const a = await seedTenant("a");
    const b = await seedTenant("b");
    const product = await seedProduct(a);
    await expect(inTenant(b, () => service.get(product.id))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
