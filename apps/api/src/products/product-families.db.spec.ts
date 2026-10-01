/**
 * WS8 (SA-606 / 606a) DB-lane proof for the families API (real Postgres, throwaway `qa-*` tenants).
 *
 * Run by F2's DB lane (`npm run local:test:db`, its own fresh database); collected only by `jest.db.config.js`.
 * Needs the Sitting-B bundle migration (retired* columns, nullable ProductBarcode.code, active-only name uniques).
 * `requireLocalDatabaseUrl()` refuses any non-local host; every tenant is a `qa-*` slug approved by `assertTestTenant`.
 *
 * Proves: two concurrent POSTs of one barcode -> exactly one 201 and one 409; the same code in two tenants -> both
 * succeed; 201 rows -> 400; a PATCH with one bad row rolls EVERYTHING back (no partial add); a FAMILY row read back
 * from the DB is refused by `assertSellableLines` (400 FAMILY_NOT_SELLABLE), a VARIANT is not; SA-606a: standardCost
 * only (never averageCost), the variant inherits the family cost.
 */
import { BadRequestException, ConflictException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { ProductFamiliesService } from "./product-families.service";
import { InventoryService } from "../inventory/inventory.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { assertSellableLines } from "./sellable-lines";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-ws8-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "product-families.db.spec.ts",
  );
};

const variant = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  pricePerUnit: "1.00",
  ...extra,
});

describeDb("WS8 families API — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: ProductFamiliesService;
  let inventory: InventoryService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductFamiliesService,
        InventoryService,
        AuditService,
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = module.get(ProductFamiliesService);
    inventory = module.get(InventoryService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.stockCountLine.deleteMany({ where: { tenantId } });
    await prisma.stockCountSession.deleteMany({ where: { tenantId } });
    await prisma.stockMovement.deleteMany({ where: { tenantId } });
    await prisma.stockLot.deleteMany({ where: { tenantId } });
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    // ProductBarcode cascades on Product delete; variants reference the family, so children first.
    await prisma.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string): Promise<string> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `ws8 ${slug}` } });
    createdTenantIds.push(tenant.id);
    return tenant.id;
  }

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const ACTOR = null;
  const conflictOf = async (p: Promise<unknown>) => {
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    return (err as ConflictException).getResponse() as Record<string, any>;
  };

  it("two concurrent POSTs holding ONE barcode: exactly one succeeds, the other is a 409 FAMILY_ROWS_CONFLICT", async () => {
    const tenantId = await seedTenant("race");
    const post = (name: string) =>
      inTenant(tenantId, () =>
        service.createFamily(
          {
            family: { name, pricePerUnit: "1.00" },
            variants: [variant(`${name} kid`, { barcode: "800800" })],
          } as any,
          ACTOR,
        ),
      );
    const results = await Promise.allSettled([post("Fam One"), post("Fam Two")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBeInstanceOf(ConflictException);
    expect((bad[0].reason as ConflictException).getResponse()).toMatchObject({
      code: "FAMILY_ROWS_CONFLICT",
    });
    // the loser left NOTHING behind: one family + one variant in the tenant
    expect(await prisma.product.count({ where: { tenantId } })).toBe(2);
    expect(await prisma.product.count({ where: { tenantId, barcode: "800800" } })).toBe(1);
  });

  it("the same code in two different tenants: both creates succeed (codes are tenant-scoped)", async () => {
    const a = await seedTenant("xa");
    const b = await seedTenant("xb");
    const mk = (tenantId: string) =>
      inTenant(tenantId, () =>
        service.createFamily(
          {
            family: { pricePerUnit: "1.00", name: "Shared Fam" },
            variants: [variant("Kid", { sku: "SHARED-1" })],
          } as any,
          ACTOR,
        ),
      );
    const [ra, rb] = await Promise.all([mk(a), mk(b)]);
    expect(ra.variants).toHaveLength(1);
    expect(rb.variants).toHaveLength(1);
    expect(
      await prisma.product.count({ where: { sku: "SHARED-1", tenantId: { in: [a, b] } } }),
    ).toBe(2);
  });

  it("201 variant rows is a 400 and nothing is written", async () => {
    const tenantId = await seedTenant("cap");
    const rows = Array.from({ length: 201 }, (_, i) => variant(`V${i}`));
    await expect(
      inTenant(tenantId, () =>
        service.createFamily(
          { family: { pricePerUnit: "1.00", name: "Big" }, variants: rows } as any,
          ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await prisma.product.count({ where: { tenantId } })).toBe(0);
  });

  it("a conflicting row names EVERY conflict and the whole create rolls back", async () => {
    const tenantId = await seedTenant("conf");
    await inTenant(tenantId, () =>
      service.createFamily(
        {
          family: { pricePerUnit: "1.00", name: "Existing" },
          variants: [variant("Held", { sku: "HELD-1" })],
        } as any,
        ACTOR,
      ),
    );
    const before = await prisma.product.count({ where: { tenantId } });
    const body = await conflictOf(
      inTenant(tenantId, () =>
        service.createFamily(
          {
            family: { pricePerUnit: "1.00", name: "Second" },
            variants: [variant("Fine"), variant("Clash", { sku: "HELD-1" })],
          } as any,
          ACTOR,
        ),
      ),
    );
    expect(body.code).toBe("FAMILY_ROWS_CONFLICT");
    expect(body.rows).toEqual(expect.arrayContaining([expect.objectContaining({ row: 1 })]));
    expect(await prisma.product.count({ where: { tenantId } })).toBe(before);
  });

  it("PATCH variants is ALL-OR-NOTHING: one bad update row rolls back the valid add", async () => {
    const tenantId = await seedTenant("patch");
    const created = await inTenant(tenantId, () =>
      service.createFamily(
        {
          family: { pricePerUnit: "1.00", name: "PatchFam" },
          variants: [variant("K1", { sku: "K-1" }), variant("K2", { sku: "K-2" })],
        } as any,
        ACTOR,
      ),
    );
    const [k1, k2] = created.variants;
    const before = await prisma.product.count({ where: { tenantId } });
    await conflictOf(
      inTenant(tenantId, () =>
        service.updateVariants(
          created.family.id,
          { add: [variant("K3", { sku: "K-3" })], update: [{ id: k1.id, sku: "K-2" }] } as any,
          ACTOR,
        ),
      ),
    );
    expect(await prisma.product.count({ where: { tenantId } })).toBe(before);
    expect(await prisma.product.count({ where: { tenantId, sku: "K-3" } })).toBe(0);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: k1.id } })).sku).toBe("K-1");
    expect((await prisma.product.findUniqueOrThrow({ where: { id: k2.id } })).sku).toBe("K-2");
  });

  it("Opus #2881 B2: a LEGACY inactive product still holding a LIVE code does not 500 a POST or a PATCH; the claim releases it", async () => {
    const tenantId = await seedTenant("legacy");
    const first = await inTenant(tenantId, () =>
      service.createFamily(
        {
          family: { pricePerUnit: "1.00", name: "Old Fam" },
          variants: [variant("OldKid", { sku: "LEG-1" })],
        } as any,
        ACTOR,
      ),
    );
    // pre-#2860 shape: deactivated WITHOUT a release, so the code is still live on the inactive row
    await prisma.product.update({ where: { id: first.variants[0].id }, data: { isActive: false } });
    const second = await inTenant(tenantId, () =>
      service.createFamily(
        {
          family: { pricePerUnit: "1.00", name: "New Fam" },
          variants: [variant("NewKid", { sku: "LEG-1" })],
        } as any,
        ACTOR,
      ),
    );
    expect(second.variants).toHaveLength(1);
    const old = await prisma.product.findUniqueOrThrow({ where: { id: first.variants[0].id } });
    expect(old.sku).toBeNull();
    expect(old.retiredSku).toBe("LEG-1");
    // the same through PATCH
    await prisma.product.update({
      where: { id: second.variants[0].id },
      data: { isActive: false },
    });
    const third = await inTenant(tenantId, () =>
      service.createFamily(
        {
          family: { pricePerUnit: "1.00", name: "Third Fam" },
          variants: [variant("ThirdKid", { sku: "T-1" })],
        } as any,
        ACTOR,
      ),
    );
    await inTenant(tenantId, () =>
      service.updateVariants(
        third.family.id,
        { update: [{ id: third.variants[0].id, sku: "LEG-1" }] } as any,
        ACTOR,
      ),
    );
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: third.variants[0].id } })).sku,
    ).toBe("LEG-1");
  });

  it("Opus #2881 B3: an update row taking a code a SIBLING still holds is a 409 FAMILY_ROWS_CONFLICT, never a 500", async () => {
    const tenantId = await seedTenant("swap");
    const created = await inTenant(tenantId, () =>
      service.createFamily(
        {
          family: { pricePerUnit: "1.00", name: "SwapFam" },
          variants: [variant("A", { sku: "SW-A" }), variant("B", { sku: "SW-B" })],
        } as any,
        ACTOR,
      ),
    );
    const [a, b] = created.variants;
    const body = await conflictOf(
      inTenant(tenantId, () =>
        service.updateVariants(
          created.family.id,
          {
            update: [
              { id: a.id, sku: "SW-B" },
              { id: b.id, name: "B renamed" },
            ],
          } as any,
          ACTOR,
        ),
      ),
    );
    expect(body.code).toBe("FAMILY_ROWS_CONFLICT");
    expect((await prisma.product.findUniqueOrThrow({ where: { id: a.id } })).sku).toBe("SW-A");
  });

  it("a FAMILY row read from the DB is refused as a sales line (400 FAMILY_NOT_SELLABLE); its variant is not", async () => {
    const tenantId = await seedTenant("sell");
    const created = await inTenant(tenantId, () =>
      service.createFamily(
        { family: { pricePerUnit: "1.00", name: "SellFam" }, variants: [variant("Kid")] } as any,
        ACTOR,
      ),
    );
    const rows = await prisma.product.findMany({
      where: { tenantId },
      select: { id: true, name: true, kind: true },
    });
    const fam = rows.find((r) => r.id === created.family.id)!;
    const kid = rows.find((r) => r.id === created.variants[0].id)!;
    expect(fam.kind).toBe("FAMILY");
    expect(kid.kind).toBe("VARIANT");
    let thrown: unknown;
    try {
      assertSellableLines([fam]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getResponse()).toMatchObject({
      code: "FAMILY_NOT_SELLABLE",
      productIds: [fam.id],
    });
    expect(() => assertSellableLines([kid])).not.toThrow();
  });

  it("Opus #2881 r3 B1': a counted / cost-based FAMILY is a 400 through the REAL queries (commitStockCount, upsertStockCountLine, setCostBasis)", async () => {
    const tenantId = await seedTenant("count");
    const user = await prisma.user.create({
      data: {
        email: `${freshTenantSlug("u")}@example.invalid`,
        username: `u-${randomUUID().slice(0, 8)}`,
        role: "OPERATOR",
        tenantId,
      },
    });
    const created = await inTenant(tenantId, () =>
      service.createFamily(
        { family: { pricePerUnit: "1.00", name: "CountFam" }, variants: [variant("Kid")] } as any,
        ACTOR,
      ),
    );
    const famId = created.family.id;
    const stockOf = async () => {
      const f = await prisma.product.findUniqueOrThrow({ where: { id: famId } });
      return {
        averageCost: f.averageCost?.toString() ?? null,
        standardCost: f.standardCost?.toString() ?? null,
        currentStock: f.currentStock.toString(),
        lots: await prisma.stockLot.count({ where: { tenantId, productId: famId } }),
      };
    };
    const familyBefore = await stockOf();
    const refusedFamily = async (p: Promise<unknown>) => {
      const err = await p.catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: "FAMILY_NOT_SELLABLE",
      });
    };
    await inTenant(tenantId, async () => {
      await refusedFamily(
        inventory.commitStockCount(
          {
            sessionId: randomUUID(),
            items: [{ productId: famId, countedQty: 5, unitCost: 1 }],
          } as any,
          user.id,
        ),
      );
      const session = await prisma.stockCountSession.create({
        data: { tenantId, startedById: user.id, name: "ws8 count" },
      });
      // the select path: upsertStockCountLine reads { id, kind, name, ... } from the real DB
      await refusedFamily(
        inventory.upsertStockCountLine(session.id, { productId: famId, countedQty: 5 } as any, {
          sub: user.id,
        }),
      );
      await refusedFamily(inventory.setCostBasis(famId, { unitCost: 2 } as any, user.id));
    });
    // nothing was written for the FAMILY
    // ...and the family's own cost / stock columns and lot count are untouched (no phantom stock, no cost basis)
    expect(await stockOf()).toEqual(familyBefore);
    expect(await prisma.stockMovement.count({ where: { tenantId, productId: famId } })).toBe(0);
    expect(await prisma.stockCountLine.count({ where: { tenantId, productId: famId } })).toBe(0);
    // and a real VARIANT still goes through the same entry
    await inTenant(tenantId, () =>
      inventory.setCostBasis(created.variants[0].id, { unitCost: 2 } as any, user.id),
    );
    expect(
      await prisma.stockMovement.count({ where: { tenantId, productId: created.variants[0].id } }),
    ).toBe(1); // the guard refuses kind FAMILY, not the path: a VARIANT's cost basis is audited normally
  });

  it("Tier 1 money: an explicit null price / cost on an update row is a 400 and the row is untouched", async () => {
    const tenantId = await seedTenant("null");
    const created = await inTenant(tenantId, () =>
      service.createFamily(
        {
          family: { pricePerUnit: "1.00", name: "NullFam" },
          variants: [variant("Kid", { pricePerUnit: "5.00", standardCost: "2" })],
        } as any,
        ACTOR,
      ),
    );
    const id = created.variants[0].id;
    for (const bad of [{ pricePerUnit: null }, { standardCost: null }]) {
      await expect(
        inTenant(tenantId, () =>
          service.updateVariants(created.family.id, { update: [{ id, ...bad }] } as any, ACTOR),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    const row = await prisma.product.findUniqueOrThrow({ where: { id } });
    expect(Number(row.pricePerUnit)).toBe(5);
    expect(Number(row.priceTier2)).toBe(5);
    expect(Number(row.standardCost)).toBe(2);
  });

  it("SA-606a: variant cost lands in standardCost ONLY (never averageCost / a StockLot); an omitted cost inherits the family's", async () => {
    const tenantId = await seedTenant("cost");
    const created = await inTenant(tenantId, () =>
      service.createFamily(
        {
          family: { pricePerUnit: "1.00", name: "CostFam", standardCost: "2.00005" },
          variants: [variant("Inherits"), variant("Own", { standardCost: "3.5" })],
        } as any,
        ACTOR,
      ),
    );
    const byName = async (name: string) =>
      prisma.product.findFirstOrThrow({ where: { tenantId, name } });
    const inherits = await byName("Inherits");
    const own = await byName("Own");
    expect(Number(inherits.standardCost)).toBeCloseTo(2.0001, 4);
    expect(Number(own.standardCost)).toBeCloseTo(3.5, 4);
    expect(Number(inherits.averageCost ?? 0)).toBe(0);
    expect(Number(own.averageCost ?? 0)).toBe(0);
    expect(await prisma.stockLot.count({ where: { tenantId } })).toBe(0);
  });
});
