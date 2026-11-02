/**
 * SA-1082 A-1 and A-2, W-1119 PR-2 (real Postgres, throwaway `qa-*` tenants). Collected only by `jest.db.config.js`;
 * `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * A family save moves only the variants the person saving named, and only if each is still at the family's price under
 * the family's lock. A variant's own prices are its own in both modes. Rows VM-2 to VM-10 of the test plan.
 */
import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { getTierPrice, type PriceAuthorityMode } from "@routeflow/pricing";
import { randomUUID } from "crypto";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { AddonService } from "../billing/addon.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { ProductPriceGridService } from "./product-price-grid.service";
import { ProductPriceWriteService } from "./product-price-write.service";
import { ProductUnitsService } from "./product-units.service";
import { ProductsService } from "./products.service";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const FILE = "family-price-move.db.spec.ts";
const run = randomUUID().slice(0, 8);
let seq = 0;

describeDb("SA-1082 A-1: a family save asks, and moves only what it names", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let grid: ProductPriceGridService;
  let writes: ProductPriceWriteService;
  let products: ProductsService;
  let mode: PriceAuthorityMode = "on";
  let flags = true;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductPriceGridService,
        ProductPriceWriteService,
        ProductUnitsService,
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: { presignedUrls: jest.fn().mockResolvedValue([]) } },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn(async () => flags) } },
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
    grid = module.get(ProductPriceGridService);
    writes = module.get(ProductPriceWriteService);
    products = module.get(ProductsService);
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        await prisma.invoiceItem.deleteMany({ where: { tenantId } });
        await prisma.invoice.deleteMany({ where: { tenantId } });
        await prisma.orderItem.deleteMany({ where: { tenantId } });
        await prisma.order.deleteMany({ where: { tenantId } });
        await prisma.auditLog.deleteMany({ where: { tenantId } });
        await prisma.recipe.deleteMany({ where: { tenantId } });
        await prisma.productUnit.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
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

  beforeEach(() => {
    mode = "on";
    flags = true;
  });

  const inTenant = <T>(id: string, fn: () => Promise<T>) => tenantCtx.run(id, fn);

  async function tenantOf(label: string): Promise<string> {
    seq += 1;
    const slug = assertTestTenant(`qa-famove-${run}-${seq}-${label}`, FILE);
    const tenant = await prisma.tenant.create({ data: { slug, name: slug } });
    tenantIds.push(tenant.id);
    return tenant.id;
  }

  const productIn = (tenantId: string, name: string, data: Record<string, unknown>) =>
    prisma.product.create({
      data: {
        tenantId,
        name,
        sku: `FM-${randomUUID().slice(0, 8)}`,
        unit: "Box",
        unitsPerBox: 12,
        pricePerUnit: "24.00",
        ...data,
      } as any,
    });
  const familyIn = (tenantId: string, data: Record<string, unknown> = {}) =>
    productIn(tenantId, `Family ${randomUUID().slice(0, 4)}`, {
      kind: "FAMILY",
      priceTier2: "22.00",
      ...data,
    });
  const variantOf = (
    family: { id: string; tenantId: string | null },
    data: Record<string, unknown>,
  ) =>
    productIn(family.tenantId as string, `Variant ${randomUUID().slice(0, 4)}`, {
      kind: "VARIANT",
      parentProductId: family.id,
      ...data,
    });

  const row = (id: string) => prisma.product.findUniqueOrThrow({ where: { id } });
  const retail = async (id: string) => Number((await row(id)).pricePerUnit);
  const tier = async (id: string, t: number) => getTierPrice(await row(id), t);

  /** The read the web makes before it asks. */
  const asked = (tenantId: string, familyId: string, dto: Record<string, unknown>) =>
    inTenant(tenantId, () => products.previewFamilyMove(familyId, dto as any));
  const saveFamily = (
    tenantId: string,
    familyId: string,
    dto: Record<string, unknown>,
    moveVariantIds?: string[],
  ) =>
    inTenant(tenantId, () =>
      products.update(familyId, { ...dto, ...(moveVariantIds ? { moveVariantIds } : {}) } as any, {
        packPrecondition: "internal",
      }),
    ) as Promise<any>;
  const movedAudit = (tenantId: string) =>
    prisma.auditLog.findMany({
      where: { tenantId, action: AUDIT_ACTIONS.PRODUCT_FAMILY_VARIANTS_MOVED },
    });

  const readGrid = (tenantId: string, id: string) => inTenant(tenantId, () => grid.get(id));
  const savePack = async (
    tenantId: string,
    id: string,
    patches: Array<{ tier: number; to: number | null }>,
  ) => {
    const g = await readGrid(tenantId, id);
    return inTenant(tenantId, () =>
      writes.save(
        id,
        {
          expectedRevision: g.revision,
          expectedPriceState: g.priceState,
          patches: patches.map((p) => ({ ref: "pack", ...p })),
        } as any,
        null,
      ),
    );
  };
  const packCells = async (tenantId: string, id: string): Promise<any[]> =>
    (await readGrid(tenantId, id)).rows.find((r: any) => r.ref === "pack")!.cells;

  it.each(["on", "off"] as const)(
    "VM-2 (mode %s): the list names the variant at the family's price; only it moves, counted once",
    async (m) => {
      mode = m;
      const tenantId = await tenantOf(`vm2${m}`);
      const family = await familyIn(tenantId);
      const at24 = await variantOf(family, {});
      const at30 = await variantOf(family, { pricePerUnit: "30.00" });

      const preview = await asked(tenantId, family.id, { pricePerUnit: 26 });
      expect(preview.count).toBe(1);
      expect(preview.variants).toEqual([{ id: at24.id, name: at24.name, from: 24, to: 26 }]);
      expect(await retail(at24.id)).toBe(24);

      const saved = await saveFamily(tenantId, family.id, { pricePerUnit: "26.00" }, [at24.id]);
      expect(saved.movedVariants).toBe(1);
      expect(await retail(family.id)).toBe(26);
      expect(await retail(at24.id)).toBe(26);
      expect(await retail(at30.id)).toBe(30);
      const audit = await movedAudit(tenantId);
      expect(audit).toHaveLength(1);
      expect(audit[0]!.meta).toMatchObject({ asked: 1, moved: 1, variantIds: [at24.id] });
    },
  );

  it.each(["on", "off"] as const)(
    "VM-2b (mode %s): no list means nothing moves, whatever it holds",
    async (m) => {
      mode = m;
      const tenantId = await tenantOf(`vm2b${m}`);
      const family = await familyIn(tenantId);
      const at24 = await variantOf(family, { priceTier2: "22.00" });
      const at30 = await variantOf(family, { pricePerUnit: "30.00" });

      await saveFamily(tenantId, family.id, { pricePerUnit: "26.00", priceTier2: "23.00" });
      expect(await retail(family.id)).toBe(26);
      expect(await retail(at24.id)).toBe(24);
      expect(Number((await row(at24.id)).priceTier2)).toBe(22);
      expect(await retail(at30.id)).toBe(30);
      expect(await movedAudit(tenantId)).toHaveLength(0);
    },
  );

  it("VM-2c: a listed variant that isn't at the family's price, or changed after the read, stays; the count says so", async () => {
    const tenantId = await tenantOf("vm2c");
    const family = await familyIn(tenantId);
    const at30 = await variantOf(family, { pricePerUnit: "30.00" });
    const changes = await variantOf(family, {});
    const stays = await variantOf(family, {});

    const preview = await asked(tenantId, family.id, { pricePerUnit: 26 });
    expect(preview.variants.map((v: { id: string }) => v.id).sort()).toEqual(
      [changes.id, stays.id].sort(),
    );
    // Someone prices it on its own between the read and the save.
    await prisma.product.update({ where: { id: changes.id }, data: { pricePerUnit: "25.00" } });

    const saved = await saveFamily(tenantId, family.id, { pricePerUnit: "26.00" }, [
      at30.id,
      changes.id,
      stays.id,
    ]);
    expect(saved.movedVariants).toBe(1);
    expect(await retail(at30.id)).toBe(30);
    expect(await retail(changes.id)).toBe(25);
    expect(await retail(stays.id)).toBe(26);
    expect((await movedAudit(tenantId))[0]!.meta).toMatchObject({ asked: 3, moved: 1 });
  });

  it("VM-2c: another tenant's row named in the list is never moved", async () => {
    const tenantA = await tenantOf("vm2ca");
    const tenantB = await tenantOf("vm2cb");
    const family = await familyIn(tenantA);
    const foreign = await productIn(tenantB, "Foreign", {
      kind: "VARIANT",
      parentProductId: family.id,
    });
    const saved = await saveFamily(tenantA, family.id, { pricePerUnit: "26.00" }, [foreign.id]);
    expect(saved.movedVariants).toBe(0);
    expect(await retail(foreign.id)).toBe(24);
  });

  it("VM-3: a pack family scales by pieces, one round; a 6-pack at the 12-pack's number isn't listed", async () => {
    const tenantId = await tenantOf("vm3");
    const family = await familyIn(tenantId);
    const six = await variantOf(family, {
      unitsPerBox: 6,
      pricePerUnit: "12.00",
      priceTier2: "11.00",
    });
    const sixAt24 = await variantOf(family, { unitsPerBox: 6 });

    const preview = await asked(tenantId, family.id, { pricePerUnit: 26 });
    expect(preview.variants).toEqual([{ id: six.id, name: six.name, from: 12, to: 13 }]);

    await saveFamily(tenantId, family.id, { pricePerUnit: "26.00" }, [six.id]);
    expect(await retail(six.id)).toBe(13);
    expect(Number((await row(six.id)).priceTier2)).toBe(11);
    expect(await retail(sixAt24.id)).toBe(24);
  });

  it("VM-3b (A-2): a family with no pack moves the number as it is: listed, 26, never 312, and it reads Family", async () => {
    const tenantId = await tenantOf("vm3b");
    const family = await familyIn(tenantId, { unitsPerBox: null, priceTier2: "0" });
    const twelve = await variantOf(family, {});

    const preview = await asked(tenantId, family.id, { pricePerUnit: 26 });
    expect(preview.variants).toEqual([{ id: twelve.id, name: twelve.name, from: 24, to: 26 }]);

    await saveFamily(tenantId, family.id, { pricePerUnit: "26.00" }, [twelve.id]);
    expect(await retail(twelve.id)).toBe(26);
    const cells = await packCells(tenantId, twelve.id);
    expect(cells[0].family).toEqual({ value: 26, follows: true });
  });

  it("VM-3b (A-2): a new variant and a cleared cell under a no-pack family take the number as it is", async () => {
    const tenantId = await tenantOf("vm3bnew");
    const family = await familyIn(tenantId, { unitsPerBox: null, priceTier2: "0" });
    const created = (await inTenant(tenantId, () =>
      products.create(
        {
          name: "New one",
          variantName: "New one",
          parentProductId: family.id,
          unit: "Box",
          unitsPerBox: 12,
        } as any,
        { reparentVia: "editor" } as any,
      ),
    )) as { id: string };
    expect(await retail(created.id)).toBe(24);

    const own = await variantOf(family, { pricePerUnit: "30.00" });
    await savePack(tenantId, own.id, [{ tier: 1, to: null }]);
    expect(await retail(own.id)).toBe(24);
  });

  it("VM-12 (A-3): a family with blank tiers, a variant with tiers stored at 24: every tier bills 26, none left at 24", async () => {
    const tenantId = await tenantOf("vm12");
    const family = await familyIn(tenantId, { priceTier2: "0" });
    const stored = await variantOf(family, {
      priceTier2: "24.00",
      priceTier3: "24.00",
      priceTier4: "24.00",
      priceTier5: "24.00",
    });

    const preview = await asked(tenantId, family.id, { pricePerUnit: 26 });
    expect(preview.variants.map((v: { id: string }) => v.id)).toEqual([stored.id]);

    await saveFamily(tenantId, family.id, { pricePerUnit: "26.00" }, [stored.id]);
    for (const t of [1, 2, 3, 4, 5]) expect(await tier(stored.id, t)).toBe(26);
  });

  it("VM-4: typing an own Retail takes the tiers at the family's value with it: Auto, and it bills the own Retail", async () => {
    const tenantId = await tenantOf("vm4");
    const family = await familyIn(tenantId);
    const follower = await variantOf(family, { priceTier2: "22.00" });
    await savePack(tenantId, follower.id, [{ tier: 1, to: 30 }]);
    expect(await retail(follower.id)).toBe(30);
    expect(await tier(follower.id, 2)).toBe(30);
    const cells = await packCells(tenantId, follower.id);
    expect(cells[1].source).toBe("auto");
    expect(cells[0].family).toEqual({ value: 24, follows: false });

    // The product editor's route, same rule. A tier typed in the same save wins.
    const viaEditor = await variantOf(family, { priceTier2: "22.00" });
    await inTenant(tenantId, () =>
      products.update(viaEditor.id, { pricePerUnit: "30.00" } as any, {
        packPrecondition: "internal",
      }),
    );
    expect(await tier(viaEditor.id, 2)).toBe(30);
    const typed = await variantOf(family, { priceTier2: "22.00" });
    await savePack(tenantId, typed.id, [
      { tier: 1, to: 30 },
      { tier: 2, to: 28 },
    ]);
    expect(await tier(typed.id, 2)).toBe(28);
  });

  it("VM-5: mode on, a variant's Retail is accepted and stays through a family edit", async () => {
    const tenantId = await tenantOf("vm5");
    const family = await familyIn(tenantId);
    const variant = await variantOf(family, {});
    const g = await readGrid(tenantId, variant.id);
    expect(g.rows.find((r: any) => r.ref === "pack")!.editable).toBe(true);

    await savePack(tenantId, variant.id, [{ tier: 1, to: 31 }]);
    expect(await retail(variant.id)).toBe(31);
    await saveFamily(tenantId, family.id, { pricePerUnit: "26.00" });
    expect(await retail(variant.id)).toBe(31);
  });

  it("VM-6: clearing the box takes the family's number and reads Family; clearing all five is Use family prices", async () => {
    const tenantId = await tenantOf("vm6");
    const family = await familyIn(tenantId);
    const variant = await variantOf(family, {
      pricePerUnit: "30.00",
      priceTier2: "28.00",
    });
    await savePack(tenantId, variant.id, [{ tier: 1, to: null }]);
    expect(await retail(variant.id)).toBe(24);
    expect((await packCells(tenantId, variant.id))[0].family).toEqual({ value: 24, follows: true });

    const other = await variantOf(family, { pricePerUnit: "30.00", priceTier2: "28.00" });
    await savePack(
      tenantId,
      other.id,
      [1, 2, 3, 4, 5].map((t) => ({ tier: t, to: null })),
    );
    expect(await retail(other.id)).toBe(24);
    expect(await tier(other.id, 2)).toBe(22);
    expect((await packCells(tenantId, other.id))[1].family).toEqual({ value: 22, follows: true });
  });

  it("VM-6: a blank Retail with no usable family Retail is refused and nothing is written", async () => {
    const tenantId = await tenantOf("vm6none");
    const family = await familyIn(tenantId, { pricePerUnit: "0", priceTier2: "0" });
    const variant = await variantOf(family, { pricePerUnit: "30.00" });
    const err = await savePack(tenantId, variant.id, [{ tier: 1, to: null }]).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(await retail(variant.id)).toBe(30);
  });

  it("VM-7: an own Retail with a tier copied at the family's value isn't listed and doesn't move", async () => {
    const tenantId = await tenantOf("vm7");
    const family = await familyIn(tenantId);
    const own = await variantOf(family, { pricePerUnit: "30.00", priceTier2: "22.00" });
    const dto = { pricePerUnit: 26, priceTier2: 23 };
    expect((await asked(tenantId, family.id, dto)).count).toBe(0);
    await saveFamily(tenantId, family.id, { pricePerUnit: "26.00", priceTier2: "23.00" }, [own.id]);
    expect(await retail(own.id)).toBe(30);
    expect(Number((await row(own.id)).priceTier2)).toBe(22);
  });

  it("VM-8: an own order unit and a $0 family aren't listed; a recipe without the override moves as today in mode on", async () => {
    const tenantId = await tenantOf("vm8");
    const family = await familyIn(tenantId);
    const withUnit = await variantOf(family, {});
    const unit = await prisma.productUnit.create({
      data: { tenantId, productId: withUnit.id, label: "Case", factorToBase: 72 },
    });
    await prisma.product.update({ where: { id: withUnit.id }, data: { orderUnitRef: unit.id } });
    expect((await asked(tenantId, family.id, { pricePerUnit: 26 })).count).toBe(0);

    const zero = await familyIn(tenantId, { pricePerUnit: "0", priceTier2: "0" });
    await variantOf(zero, { pricePerUnit: "0" });
    expect((await asked(tenantId, zero.id, { pricePerUnit: 26 })).count).toBe(0);

    const recipe = await productIn(tenantId, "Recipe", {
      kind: "RECIPE",
      familyPriceOverride: false,
    });
    await prisma.recipe.create({
      data: {
        tenantId,
        productId: recipe.id,
        familyProductId: family.id,
        version: 1,
        unitsPerPack: 2,
        status: "ACTIVE",
      },
    });
    await saveFamily(tenantId, family.id, { pricePerUnit: "27.00" });
    expect(await retail(recipe.id)).toBe(27);
    expect(await retail(withUnit.id)).toBe(24);
  });

  it("VM-9: saved order and invoice lines don't change when a family save moves a variant", async () => {
    const tenantId = await tenantOf("vm9");
    const family = await familyIn(tenantId);
    const variant = await variantOf(family, {});
    const user = await prisma.user.create({
      data: {
        email: `buyer-${run}-${seq}@example.test`,
        username: `buyer-${run}-${seq}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: "Acme", contactName: "Acme Buyer", tenantId },
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderNumber: `ORD-FM-${randomUUID().slice(0, 8)}`,
        subtotal: 24,
        tax: 0,
        total: 24,
        status: "DELIVERED",
      } as any,
    });
    const orderLine = await prisma.orderItem.create({
      data: { tenantId, orderId: order.id, productId: variant.id, qty: 1, unitPrice: 24 } as any,
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        invoiceNumber: `INV-FM-${randomUUID().slice(0, 8)}`,
        status: "SENT",
        subtotal: 24,
        taxAmount: 0,
        total: 24,
      } as any,
    });
    const invoiceLine = await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        productId: variant.id,
        description: "Variant",
        qty: 1,
        unitPrice: 24,
        subtotal: 24,
      } as any,
    });
    const lines = async () => ({
      o: await prisma.orderItem.findUniqueOrThrow({ where: { id: orderLine.id } }),
      i: await prisma.invoiceItem.findUniqueOrThrow({ where: { id: invoiceLine.id } }),
      order: await prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      invoice: await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }),
    });
    const before = await lines();
    await saveFamily(tenantId, family.id, { pricePerUnit: "26.00" }, [variant.id]);
    expect(await retail(variant.id)).toBe(26);
    expect(await lines()).toEqual(before);
  });

  it("VM-10: undoing a grid save with a cleared box and a blanked tier puts every value back", async () => {
    const tenantId = await tenantOf("vm10");
    const family = await familyIn(tenantId);
    const cleared = await variantOf(family, { pricePerUnit: "30.00" });
    const before = await row(cleared.id);
    const save = await savePack(tenantId, cleared.id, [{ tier: 1, to: null }]);
    expect(await retail(cleared.id)).toBe(24);
    const g = await readGrid(tenantId, cleared.id);
    await inTenant(tenantId, () =>
      writes.undo(
        cleared.id,
        {
          auditId: (save as any).auditId,
          expectedRevision: g.revision,
          expectedPriceState: g.priceState,
        } as any,
        null,
      ),
    );
    const after = await row(cleared.id);
    expect(Number(after.pricePerUnit)).toBe(Number(before.pricePerUnit));
    expect(Number(after.priceTier2)).toBe(Number(before.priceTier2));

    const blanked = await variantOf(family, { priceTier2: "22.00" });
    const save2 = await savePack(tenantId, blanked.id, [{ tier: 1, to: 30 }]);
    expect(await tier(blanked.id, 2)).toBe(30);
    const g2 = await readGrid(tenantId, blanked.id);
    await inTenant(tenantId, () =>
      writes.undo(
        blanked.id,
        {
          auditId: (save2 as any).auditId,
          expectedRevision: g2.revision,
          expectedPriceState: g2.priceState,
        } as any,
        null,
      ),
    );
    expect(await retail(blanked.id)).toBe(24);
    expect(await tier(blanked.id, 2)).toBe(22);
  });

  it("VM-10: flag off, a blank tier is stored as a Retail copy, never $0, by the editor and by a move", async () => {
    flags = false;
    const tenantId = await tenantOf("vm10off");
    const family = await familyIn(tenantId);
    const typed = await variantOf(family, { priceTier2: "22.00" });
    await inTenant(tenantId, () =>
      products.update(typed.id, { pricePerUnit: "30.00" } as any, {
        packPrecondition: "internal",
      }),
    );
    expect(Number((await row(typed.id)).priceTier2)).toBe(30);

    const moved = await variantOf(family, { priceTier2: "22.00" });
    await saveFamily(tenantId, family.id, { pricePerUnit: "26.00", priceTier2: "0" }, [moved.id]);
    expect(await retail(moved.id)).toBe(26);
    expect(Number((await row(moved.id)).priceTier2)).toBe(26);
  });

  it("RACE (6 rounds): a family save naming a variant and a price typed on it never deadlock and never lose the typed price", async () => {
    const tenantId = await tenantOf("race");
    for (let round = 0; round < 6; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      const family = await familyIn(tenantId);
      // eslint-disable-next-line no-await-in-loop
      const variant = await variantOf(family, {});
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.allSettled([
        saveFamily(tenantId, family.id, { pricePerUnit: "26.00" }, [variant.id]),
        savePack(tenantId, variant.id, [{ tier: 1, to: 31 }]),
      ]);
      const failures = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
      expect(failures.filter((f) => /deadlock|40P01/i.test(f))).toEqual([]);
      expect(results[0]!.status).toBe("fulfilled");
      // eslint-disable-next-line no-await-in-loop
      const final = await retail(variant.id);
      // The typed price landed: it stays. It lost its compare-and-set to the move: 26, and the person is told.
      expect(final).toBe(results[1]!.status === "fulfilled" ? 31 : 26);
    }
  });
});
