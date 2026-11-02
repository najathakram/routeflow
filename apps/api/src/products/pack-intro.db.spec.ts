/**
 * SA-946 / SA-961 R1, W-867 (real Postgres, throwaway `qa-*` tenants). Collected only by `jest.db.config.js`;
 * `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * A product's first units per box: a person says what the stock number meant, and "boxes" turns the per-piece numbers
 * into pieces in the same write. Rows PI-1 to PI-14 of the test plan. Prices are never touched (L-332).
 */
import { MovementType } from "@prisma/client";
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { AuditService } from "../audit/audit.service";
import { AddonService } from "../billing/addon.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { withImportPackReading } from "../import/import-pack-reading";
import { foldLedger } from "../inventory/fold-ledger";
import { applyStockMovements } from "../inventory/stock-movements";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { ProductsService } from "./products.service";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const FILE = "pack-intro.db.spec.ts";
const run = randomUUID().slice(0, 8);
let seq = 0;

describeDb("SA-946 / SA-961: a product's first units per box", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let products: ProductsService;
  let mode: "on" | "off" = "off";
  const tenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: StorageService, useValue: { presignedUrls: jest.fn().mockResolvedValue([]) } },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn(async () => true) } },
        entitlementAuthorityFromEntitlements,
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
        {
          provide: FeatureConfigService,
          useValue: { getEffectiveMode: jest.fn(async () => mode) },
        },
      ],
    }).compile();
    products = module.get(ProductsService);
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        await prisma.stockLot.deleteMany({ where: { product: { tenantId } } });
        await prisma.stockMovement.deleteMany({ where: { tenantId } });
        await prisma.auditLog.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      })().catch(() => {
        // Best-effort cleanup must never mask a test's own result.
      });
    }
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    mode = "off";
  });

  async function tenantOf(label: string): Promise<string> {
    seq += 1;
    const slug = assertTestTenant(`qa-pack-${run}-${seq}-${label}`, FILE);
    const tenant = await prisma.tenant.create({ data: { slug, name: slug } });
    tenantIds.push(tenant.id);
    return tenant.id;
  }

  const productIn = (tenantId: string, data: Record<string, unknown> = {}) =>
    prisma.product.create({
      data: {
        tenantId,
        name: `Pack ${randomUUID().slice(0, 6)}`,
        sku: `PI-${randomUUID().slice(0, 8)}`,
        unit: "Box",
        pricePerUnit: "24.00",
        priceTier2: "22.00",
        ...data,
      } as any,
    });
  /** Today's shape of the case the rulings name: 50 on hand, cost 2.00, no pack. */
  const stocked = (tenantId: string, data: Record<string, unknown> = {}) =>
    productIn(tenantId, { currentStock: 50, averageCost: "2.0000", ...data });

  const saveEditor = (tenantId: string, id: string, dto: Record<string, unknown>) =>
    tenantCtx.run(tenantId, () =>
      products.update(
        id,
        { expectedUnitsPerBox: null, ...dto } as any,
        {
          packPrecondition: "client",
          actorId: null,
        } as any,
      ),
    );
  const saveImport = (tenantId: string, id: string, unitsPerBox: number) =>
    tenantCtx.run(tenantId, () =>
      products.update(
        id,
        withImportPackReading({ unitsPerBox }) as any,
        {
          packPrecondition: "internal",
          suppressEmit: true,
        } as any,
      ),
    );

  const row = (id: string) => prisma.product.findUniqueOrThrow({ where: { id } });
  const money = async (id: string) => {
    const p = await row(id);
    return [Number(p.pricePerUnit), Number(p.priceTier2)];
  };
  const movements = (id: string) =>
    prisma.stockMovement.findMany({
      where: { productId: id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  const audits = (id: string) =>
    prisma.auditLog.findMany({
      where: { entityId: id, action: AUDIT_ACTIONS.PRODUCT_PACK_INTRODUCED },
    });
  const refusalCode = (saving: Promise<unknown>) =>
    saving.then(
      () => "saved",
      (e) => e?.response?.code ?? e?.message,
    );

  it("PI-1: a pack on a product holding stock, no answer: 409, and nothing is written", async () => {
    const tenantId = await tenantOf("pi1");
    const p = await stocked(tenantId);

    expect(await refusalCode(saveEditor(tenantId, p.id, { unitsPerBox: 10 }))).toBe(
      API_ERROR_CODES.PACK_READING_REQUIRED,
    );

    const after = await row(p.id);
    expect(after.unitsPerBox).toBeNull();
    expect(Number(after.currentStock)).toBe(50);
    expect(await movements(p.id)).toHaveLength(0);
    expect(await audits(p.id)).toHaveLength(0);
  });

  it("PI-2: the box answer turns stock, reorder levels, cost and open lots into pieces; prices stay", async () => {
    const tenantId = await tenantOf("pi2");
    const p = await stocked(tenantId, {
      standardCost: "3.0000",
      reorderPoint: 5,
      reorderQty: 7,
    });
    const open = await prisma.stockLot.create({
      data: { tenantId, productId: p.id, qty: 60, remainingQty: 50, unitCost: "2.0000" },
    });
    const usedUp = await prisma.stockLot.create({
      data: { tenantId, productId: p.id, qty: 40, remainingQty: 0, unitCost: "1.5000" },
    });

    await saveEditor(tenantId, p.id, { unitsPerBox: 10, packReading: "box" });

    const after = await row(p.id);
    expect(after.unitsPerBox).toBe(10);
    expect(Number(after.currentStock)).toBe(500);
    expect(Number(after.averageCost)).toBe(0.2);
    expect(Number(after.standardCost)).toBe(0.3);
    expect([after.reorderPoint, after.reorderQty]).toEqual([50, 70]);
    expect(await money(p.id)).toEqual([24, 22]);

    const lot = await prisma.stockLot.findUniqueOrThrow({ where: { id: open.id } });
    expect([Number(lot.qty), Number(lot.remainingQty), Number(lot.unitCost)]).toEqual([
      600, 500, 0.2,
    ]);
    const spent = await prisma.stockLot.findUniqueOrThrow({ where: { id: usedUp.id } });
    expect([Number(spent.qty), Number(spent.remainingQty), Number(spent.unitCost)]).toEqual([
      40, 0, 1.5,
    ]);
  });

  it("PI-3: the box answer appends one adjustment and one cost row, and one audit row", async () => {
    const tenantId = await tenantOf("pi3");
    const p = await stocked(tenantId);

    await saveEditor(tenantId, p.id, { unitsPerBox: 10, packReading: "box" });

    const rows = await movements(p.id);
    expect(rows.map((m) => m.type)).toEqual([MovementType.ADJUSTMENT, MovementType.COST_BASIS]);
    expect(Number(rows[0].quantity)).toBe(450);
    expect(Number(rows[0].stockAfter)).toBe(500);
    expect(rows[0].reason).toBe("OTHER");
    expect(rows[0].reasonNote).toBe("Units per box set to 10");
    expect(Number(rows[1].quantity)).toBe(0);
    expect(Number(rows[1].unitCost)).toBe(0.2);
    expect(Number(rows[1].avgCostAfter)).toBe(0.2);

    const [audit, ...more] = await audits(p.id);
    expect(more).toHaveLength(0);
    expect(audit.meta).toEqual({
      from: null,
      to: 10,
      reading: "box",
      stockBefore: 50,
      stockAfter: 500,
      costBefore: 2,
      costAfter: 0.2,
    });
  });

  it("PI-4: the piece answer changes nothing but the pack, and says so in the audit row", async () => {
    const tenantId = await tenantOf("pi4");
    const p = await stocked(tenantId, { reorderPoint: 5 });

    await saveEditor(tenantId, p.id, { unitsPerBox: 10, packReading: "piece" });

    const after = await row(p.id);
    expect(after.unitsPerBox).toBe(10);
    expect(Number(after.currentStock)).toBe(50);
    expect(Number(after.averageCost)).toBe(2);
    expect(after.reorderPoint).toBe(5);
    expect(await movements(p.id)).toHaveLength(0);
    const [audit] = await audits(p.id);
    expect(audit.meta).toEqual({
      from: null,
      to: 10,
      reading: "piece",
      stockBefore: 50,
      stockAfter: 50,
      costBefore: 2,
      costAfter: 2,
    });
  });

  it("PI-5 (SA-961 R1): the import reads as pieces: 50 and 2.0000 stay, one audit row says piece", async () => {
    const tenantId = await tenantOf("pi5");
    const p = await stocked(tenantId);

    await saveImport(tenantId, p.id, 10);

    const after = await row(p.id);
    expect(after.unitsPerBox).toBe(10);
    expect(Number(after.currentStock)).toBe(50);
    expect(Number(after.averageCost)).toBe(2);
    const [audit, ...more] = await audits(p.id);
    expect(more).toHaveLength(0);
    expect((audit.meta as { reading: string }).reading).toBe("piece");
  });

  it("PI-6: nothing held: no question, no conversion", async () => {
    const tenantId = await tenantOf("pi6");
    const p = await productIn(tenantId, { reorderPoint: 5 });

    await saveEditor(tenantId, p.id, { unitsPerBox: 10 });

    const after = await row(p.id);
    expect(after.unitsPerBox).toBe(10);
    expect(after.reorderPoint).toBe(5);
    expect(await movements(p.id)).toHaveLength(0);
  });

  it("PI-7: a cost and no stock still asks; the box answer moves only the cost", async () => {
    const tenantId = await tenantOf("pi7");
    const p = await productIn(tenantId, { averageCost: "2.0000" });

    expect(await refusalCode(saveEditor(tenantId, p.id, { unitsPerBox: 10 }))).toBe(
      API_ERROR_CODES.PACK_READING_REQUIRED,
    );
    await saveEditor(tenantId, p.id, { unitsPerBox: 10, packReading: "box" });

    const after = await row(p.id);
    expect(Number(after.currentStock)).toBe(0);
    expect(Number(after.averageCost)).toBe(0.2);
    expect((await movements(p.id)).map((m) => m.type)).toEqual([MovementType.COST_BASIS]);
  });

  it("PI-8: a pack of 1 or a pack already set is not an introduction: no question, no conversion", async () => {
    const tenantId = await tenantOf("pi8");
    const one = await stocked(tenantId);
    await saveEditor(tenantId, one.id, { unitsPerBox: 1 });
    expect(Number((await row(one.id)).currentStock)).toBe(50);
    expect(await audits(one.id)).toHaveLength(0);

    const set = await stocked(tenantId, { unitsPerBox: 10 });
    await saveEditor(tenantId, set.id, {
      unitsPerBox: 12,
      expectedUnitsPerBox: 10,
      packReading: "box",
    });
    expect(Number((await row(set.id)).currentStock)).toBe(50);
    expect(await audits(set.id)).toHaveLength(0);
  });

  it("PI-9: a stored pack of 1 behaves as blank, so 1 to N is an introduction", async () => {
    const tenantId = await tenantOf("pi9");
    const p = await stocked(tenantId, { unitsPerBox: 1 });

    expect(
      await refusalCode(saveEditor(tenantId, p.id, { unitsPerBox: 10, expectedUnitsPerBox: 1 })),
    ).toBe(API_ERROR_CODES.PACK_READING_REQUIRED);
    await saveEditor(tenantId, p.id, {
      unitsPerBox: 10,
      expectedUnitsPerBox: 1,
      packReading: "box",
    });
    expect(Number((await row(p.id)).currentStock)).toBe(500);
  });

  it("PI-10: a replay and a double-tap convert once", async () => {
    const tenantId = await tenantOf("pi10");
    const p = await stocked(tenantId);

    const box = { unitsPerBox: 10, packReading: "box" };
    await Promise.all(
      [1, 2].map(() =>
        tenantCtx.run(tenantId, () =>
          products.update(p.id, box as any, { packPrecondition: "internal" } as any),
        ),
      ),
    );
    await tenantCtx.run(tenantId, () =>
      products.update(p.id, box as any, { packPrecondition: "internal" } as any),
    );

    expect(Number((await row(p.id)).currentStock)).toBe(500);
    expect(Number((await row(p.id)).averageCost)).toBe(0.2);
    expect(await audits(p.id)).toHaveLength(1);
  });

  it("PI-11: stock that wouldn't fit its column refuses the save and writes nothing", async () => {
    const tenantId = await tenantOf("pi11");
    const p = await stocked(tenantId, { currentStock: 5_000_000 });

    expect(
      await refusalCode(saveEditor(tenantId, p.id, { unitsPerBox: 10, packReading: "box" })),
    ).toBe(API_ERROR_CODES.PACK_CONVERSION_TOO_LARGE);

    const after = await row(p.id);
    expect(after.unitsPerBox).toBeNull();
    expect(Number(after.currentStock)).toBe(5_000_000);
    expect(await movements(p.id)).toHaveLength(0);
  });

  it("PI-12: the ledger's own fold agrees with the converted product, so a cost recompute can't undo it", async () => {
    const tenantId = await tenantOf("pi12");
    const p = await productIn(tenantId);
    await prisma.$transaction((tx) =>
      applyStockMovements(tx, tenantId, [
        {
          productId: p.id,
          type: MovementType.PURCHASE,
          quantity: 50,
          unitCost: 2 as any,
          average: { receive: 2 as any },
        },
      ]),
    );

    await saveEditor(tenantId, p.id, { unitsPerBox: 10, packReading: "box" });

    const fold = foldLedger(
      (await movements(p.id)).map((m) => ({
        type: m.type,
        quantity: m.quantity,
        unitCost: m.unitCost,
        reference: m.reference,
      })),
      { isStandard: false, averageCost: null },
    );
    expect(Number(fold.stock)).toBe(500);
    expect(Number(fold.avg)).toBe(0.2);
    expect(Number((await row(p.id)).averageCost)).toBe(0.2);
  });

  it("PI-13: a reorder level or standard cost typed in the same save is kept as typed", async () => {
    const tenantId = await tenantOf("pi13");
    const p = await stocked(tenantId, { reorderPoint: 5, standardCost: "3.0000" });

    await saveEditor(tenantId, p.id, {
      unitsPerBox: 10,
      packReading: "box",
      reorderPoint: 99,
      standardCost: "1.2500",
    });

    const after = await row(p.id);
    expect(after.reorderPoint).toBe(99);
    expect(Number(after.standardCost)).toBe(1.25);
    expect(Number(after.currentStock)).toBe(500);
  });

  it.each(["on", "off"] as const)(
    "PI-14 (family mode %s): a family's or variant's first pack moves no price",
    async (familyMode) => {
      mode = familyMode;
      const tenantId = await tenantOf(`pi14${familyMode}`);
      const family = await stocked(tenantId, { kind: "FAMILY" });
      const variant = await stocked(tenantId, {
        kind: "VARIANT",
        parentProductId: family.id,
      });

      await saveEditor(tenantId, family.id, { unitsPerBox: 12, packReading: "box" });
      expect(await money(family.id)).toEqual([24, 22]);
      expect(await money(variant.id)).toEqual([24, 22]);
      expect(Number((await row(variant.id)).currentStock)).toBe(50);
      expect((await row(variant.id)).unitsPerBox).toBeNull();

      await saveEditor(tenantId, variant.id, { unitsPerBox: 6, packReading: "box" });
      expect(await money(variant.id)).toEqual([24, 22]);
      expect(await money(family.id)).toEqual([24, 22]);
      expect(Number((await row(variant.id)).currentStock)).toBe(300);
      expect(Number((await row(family.id)).currentStock)).toBe(600);
    },
  );
});
