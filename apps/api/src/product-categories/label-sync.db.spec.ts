/**
 * DB lane for the ADD-ONLY category-text -> label sync (`syncCategoryLabel`, `syncCategoryLabelForProducts`), and for the
 * writers that call it (ProductsService create/update/importFromZoho, VariantResolutionService.completeSetup,
 * TrackedCategoriesService.updateSubcategory), against real Postgres.
 *
 * What a mocked tx cannot show: the membership row, its stamp and its audit row really land in the writer's own
 * transaction; an archived / other-tenant label is never used, case duplicates use the oldest (reported); a text change away from a label leaves the
 * old membership; an opt-out (EXCLUDE) is never flipped; and a rolled-back product write leaves no membership.
 *
 * Collected only by `jest.db.config.js`. Every tenant is a throwaway `qa-labelsync-<run>-*` slug approved by
 * `assertTestTenant`, and afterAll deletes exactly the rows this run made.
 */
import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { ProductsService } from "../products/products.service";
import { VariantResolutionService } from "../import/variant-resolution.service";
import { ProductAliasService } from "../import/product-alias.service";
import { TrackedCategoriesService } from "../tracked-categories/tracked-categories.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { Pool } from "pg";
import { ConflictException } from "@nestjs/common";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import {
  LABEL_FROM_TEXT_ACTION,
  syncCategoryLabel,
  syncCategoryLabelForProducts,
} from "./label-writer";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("category text -> label add-only sync (real Postgres)", () => {
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let products: ProductsService;
  let variants: VariantResolutionService;
  let tracked: TrackedCategoriesService;

  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-labelsync-${run}-a`, "label-sync.db.spec.ts");
  const slugB = assertTestTenant(`qa-labelsync-${run}-b`, "label-sync.db.spec.ts");
  let A: { id: string; snacks: string; archived: string; dupUpper: string; dupLower: string };
  let B: { id: string };
  const actor = { id: "u-label-sync", name: "label-sync" };

  const inA = <T>(fn: () => Promise<T>) => ctx.run(A.id, fn);
  const membershipsOf = (productId: string) =>
    prisma.productCategoryLabel.findMany({ where: { productId } });
  const auditsOf = (productId: string) =>
    prisma.auditLog.findMany({
      where: { entityId: productId, action: LABEL_FROM_TEXT_ACTION },
    });
  const seedProduct = async (
    tenantId: string,
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> =>
    (
      await prisma.product.create({
        data: { tenantId, name, unit: "each", pricePerUnit: "1.00", ...extra },
      })
    ).id;
  const syncIn = (tenantId: string, productId: string, text: string | null) =>
    prisma.$transaction((tx) => syncCategoryLabel(tx, { tenantId, productId, text, actor }));

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    const module = await Test.createTestingModule({
      providers: [
        ProductsService,
        TrackedCategoriesService,
        VariantResolutionService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: { presignedUrl: jest.fn(), delete: jest.fn() } },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
        // VariantResolutionService's alias store: unused by completeSetup.
        { provide: ProductAliasService, useValue: {} },
      ],
    }).compile();
    products = module.get(ProductsService);
    tracked = module.get(TrackedCategoriesService);
    variants = module.get(VariantResolutionService);

    const ta = await prisma.tenant.create({ data: { slug: slugA, name: `Label sync ${slugA}` } });
    const tb = await prisma.tenant.create({ data: { slug: slugB, name: `Label sync ${slugB}` } });
    const mk = (tenantId: string, name: string, archivedAt: Date | null = null) =>
      prisma.productCategory.create({ data: { tenantId, name, archivedAt } });
    A = {
      id: ta.id,
      snacks: (await mk(ta.id, "Snacks")).id,
      archived: (await mk(ta.id, "Frozen", new Date())).id,
      dupUpper: (await mk(ta.id, "Dup")).id,
      dupLower: (await mk(ta.id, "dup")).id,
    };
    B = { id: tb.id };
  }, 120_000);

  afterAll(async () => {
    for (const t of [A?.id, B?.id].filter(Boolean) as string[]) {
      await prisma.auditLog.deleteMany({ where: { tenantId: t } });
      await prisma.productCategoryLabel.deleteMany({ where: { tenantId: t } });
      await prisma.stockMovement.deleteMany({ where: { tenantId: t } });
      await prisma.stockLot.deleteMany({ where: { tenantId: t } });
      await prisma.product.deleteMany({ where: { tenantId: t, parentProductId: { not: null } } });
      await prisma.product.deleteMany({ where: { tenantId: t } });
      await prisma.trackedSubcategory.deleteMany({ where: { tenantId: t } });
      await prisma.trackedCategory.deleteMany({ where: { tenantId: t } });
      await prisma.productCategory.deleteMany({ where: { tenantId: t } });
      await prisma.tenant.deleteMany({ where: { id: t } });
    }
    await prisma.$disconnect();
  }, 120_000);

  describe("syncCategoryLabel", () => {
    it("(a) text 'snacks' adds the INCLUDE of the unarchived label 'Snacks' (case-folded), stamped, with one audit row", async () => {
      const id = await seedProduct(A.id, "a-product", { category: "snacks" });
      const out = await syncIn(A.id, id, " snacks ");
      expect(out.addedCategoryId).toBe(A.snacks);
      const rows = await membershipsOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        categoryId: A.snacks,
        mode: "INCLUDE",
        reason: null,
        parentProductIdAtWrite: null,
        createdById: actor.id,
        createdByName: actor.name,
      });
      expect(await auditsOf(id)).toHaveLength(1);
      // Re-running adds nothing and writes no second audit row.
      expect((await syncIn(A.id, id, "Snacks")).addedCategoryId).toBeNull();
      expect(await membershipsOf(id)).toHaveLength(1);
      expect(await auditsOf(id)).toHaveLength(1);
    });

    it("(b) no matching label: nothing is created or added", async () => {
      const id = await seedProduct(A.id, "b-product", { category: "Nope" });
      const before = await prisma.productCategory.count({ where: { tenantId: A.id } });
      expect((await syncIn(A.id, id, "Nope")).addedCategoryId).toBeNull();
      expect(await prisma.productCategory.count({ where: { tenantId: A.id } })).toBe(before);
      expect(await membershipsOf(id)).toHaveLength(0);
      expect(await auditsOf(id)).toHaveLength(0);
    });

    it("blank text and a null tenant are no-ops", async () => {
      const id = await seedProduct(A.id, "blank-product");
      expect((await syncIn(A.id, id, "   ")).addedCategoryId).toBeNull();
      expect((await syncIn(A.id, id, null)).addedCategoryId).toBeNull();
      expect(
        (
          await prisma.$transaction((tx) =>
            syncCategoryLabel(tx, { tenantId: null, productId: id, text: "Snacks" }),
          )
        ).addedCategoryId,
      ).toBeNull();
      expect(await membershipsOf(id)).toHaveLength(0);
    });

    it("(d) an archived matching label is not added", async () => {
      const id = await seedProduct(A.id, "d-product", { category: "Frozen" });
      expect((await syncIn(A.id, id, "Frozen")).addedCategoryId).toBeNull();
      expect(await membershipsOf(id)).toHaveLength(0);
    });

    it("case-duplicate labels are never merged: the OLDEST is used, and the audit reports the ambiguity", async () => {
      const id = await seedProduct(A.id, "dup-product", { category: "DUP" });
      expect((await syncIn(A.id, id, "DUP")).addedCategoryId).toBe(A.dupUpper); // "Dup" was created first
      expect(await membershipsOf(id)).toEqual([
        expect.objectContaining({ categoryId: A.dupUpper, mode: "INCLUDE" }),
      ]);
      const [audit] = await auditsOf(id);
      expect(audit.meta).toMatchObject({ categoryId: A.dupUpper, ambiguousLabels: 2 });
      // both labels still exist: nothing merged
      expect(
        await prisma.productCategory.count({ where: { id: { in: [A.dupUpper, A.dupLower] } } }),
      ).toBe(2);
    });

    it("another tenant's label is never used, and a product of another tenant is never given one", async () => {
      const bProduct = await seedProduct(B.id, "b-tenant-product", { category: "Snacks" });
      expect((await syncIn(B.id, bProduct, "Snacks")).addedCategoryId).toBeNull();
      expect(await membershipsOf(bProduct)).toHaveLength(0);
      // Tenant A's label, tenant B's product id: the product is not A's, so nothing is written.
      expect((await syncIn(A.id, bProduct, "Snacks")).addedCategoryId).toBeNull();
      expect(await membershipsOf(bProduct)).toHaveLength(0);
    });

    it("an existing opt-out (EXCLUDE) is never flipped", async () => {
      const parent = await seedProduct(A.id, "opt-parent");
      const child = await seedProduct(A.id, "opt-child", {
        parentProductId: parent,
        category: "Snacks",
      });
      await prisma.productCategoryLabel.create({
        data: {
          tenantId: A.id,
          productId: child,
          categoryId: A.snacks,
          mode: "EXCLUDE",
          reason: "ruled out",
          parentProductIdAtWrite: parent,
        },
      });
      expect((await syncIn(A.id, child, "Snacks")).addedCategoryId).toBeNull();
      const rows = await membershipsOf(child);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ mode: "EXCLUDE", reason: "ruled out" });
    });

    it("a rolled-back transaction leaves no membership and no audit row", async () => {
      const id = await seedProduct(A.id, "rollback-product", { category: "Snacks" });
      await expect(
        prisma.$transaction(async (tx) => {
          await syncCategoryLabel(tx, { tenantId: A.id, productId: id, text: "Snacks", actor });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await membershipsOf(id)).toHaveLength(0);
      expect(await auditsOf(id)).toHaveLength(0);
    });
  });

  describe("syncCategoryLabelForProducts", () => {
    it("adds the INCLUDE to every product without a row, leaves existing rows of either mode, ignores other tenants", async () => {
      const parent = await seedProduct(A.id, "bulk-parent");
      const fresh1 = await seedProduct(A.id, "bulk-1");
      const fresh2 = await seedProduct(A.id, "bulk-2");
      const hasInclude = await seedProduct(A.id, "bulk-has");
      const optedOut = await seedProduct(A.id, "bulk-out", { parentProductId: parent });
      const foreign = await seedProduct(B.id, "bulk-foreign");
      await prisma.productCategoryLabel.create({
        data: {
          tenantId: A.id,
          productId: hasInclude,
          categoryId: A.snacks,
          mode: "INCLUDE",
          createdById: "someone",
        },
      });
      await prisma.productCategoryLabel.create({
        data: {
          tenantId: A.id,
          productId: optedOut,
          categoryId: A.snacks,
          mode: "EXCLUDE",
          reason: "no",
          parentProductIdAtWrite: parent,
        },
      });
      const out = await prisma.$transaction((tx) =>
        syncCategoryLabelForProducts(tx, {
          tenantId: A.id,
          productIds: [fresh1, fresh2, hasInclude, optedOut, foreign, fresh1],
          text: "SNACKS",
          actor,
        }),
      );
      expect([...out.addedProductIds].sort()).toEqual([fresh1, fresh2].sort());
      for (const id of [fresh1, fresh2]) {
        const rows = await membershipsOf(id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          mode: "INCLUDE",
          createdById: actor.id,
          parentProductIdAtWrite: null,
        });
        expect(await auditsOf(id)).toHaveLength(1);
      }
      expect((await membershipsOf(hasInclude))[0]).toMatchObject({ createdById: "someone" });
      expect((await membershipsOf(optedOut))[0]).toMatchObject({ mode: "EXCLUDE" });
      expect(await membershipsOf(foreign)).toHaveLength(0);
      expect(await auditsOf(hasInclude)).toHaveLength(0);
    });

    it("no label / archived label / no ids: nothing happens; case duplicates use the oldest", async () => {
      const id = await seedProduct(A.id, "bulk-none");
      for (const text of ["Nope", "Frozen", "", null]) {
        // eslint-disable-next-line no-await-in-loop
        const out = await prisma.$transaction((tx) =>
          syncCategoryLabelForProducts(tx, { tenantId: A.id, productIds: [id], text }),
        );
        expect(out.addedProductIds).toEqual([]);
      }
      const empty = await prisma.$transaction((tx) =>
        syncCategoryLabelForProducts(tx, { tenantId: A.id, productIds: [], text: "Snacks" }),
      );
      expect(empty.addedProductIds).toEqual([]);
      expect(await membershipsOf(id)).toHaveLength(0);
      const dup = await prisma.$transaction((tx) =>
        syncCategoryLabelForProducts(tx, { tenantId: A.id, productIds: [id], text: "dup" }),
      );
      expect(dup.addedProductIds).toEqual([id]);
      expect(await membershipsOf(id)).toEqual([
        expect.objectContaining({ categoryId: A.dupUpper }),
      ]);
      expect((await auditsOf(id))[0].meta).toMatchObject({ ambiguousLabels: 2 });
    });
  });

  describe("the writers", () => {
    it("ProductsService.create with category 'Snacks' gains the INCLUDE, stamped with the actor", async () => {
      const p = await inA(() =>
        products.create(
          { name: "svc-create", unit: "each", pricePerUnit: "2.00", category: "snacks" } as any,
          { actorId: actor.id, actorName: actor.name },
        ),
      );
      const rows = await membershipsOf(p.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        categoryId: A.snacks,
        mode: "INCLUDE",
        createdByName: actor.name,
      });
      expect(await auditsOf(p.id)).toHaveLength(1);
    });

    it("ProductsService.create with a category that is not a label creates no label and no membership", async () => {
      const before = await prisma.productCategory.count({ where: { tenantId: A.id } });
      const p = await inA(() =>
        products.create({
          name: "svc-create-none",
          unit: "each",
          pricePerUnit: "2.00",
          category: "Gadgets",
        } as any),
      );
      expect(await membershipsOf(p.id)).toHaveLength(0);
      expect(await prisma.productCategory.count({ where: { tenantId: A.id } })).toBe(before);
    });

    it("ProductsService.create with an archived label's name adds nothing", async () => {
      const p = await inA(() =>
        products.create({
          name: "svc-create-archived",
          unit: "each",
          pricePerUnit: "2.00",
          category: "Frozen",
        } as any),
      );
      expect(await membershipsOf(p.id)).toHaveLength(0);
    });

    it("ProductsService.update: a category change to a label adds it; a change AWAY keeps the old membership; re-saving the same text does not resurrect a removed one", async () => {
      const p = await inA(() =>
        products.create({
          name: "svc-update",
          unit: "each",
          pricePerUnit: "2.00",
          category: "Gadgets",
        } as any),
      );
      expect(await membershipsOf(p.id)).toHaveLength(0);

      await inA(() => products.update(p.id, { category: "Snacks" } as any, { actorId: actor.id }));
      expect((await membershipsOf(p.id)).map((r) => r.categoryId)).toEqual([A.snacks]);

      // (c) text changes away from the label: the membership stays.
      await inA(() => products.update(p.id, { category: "Gadgets" } as any));
      expect((await membershipsOf(p.id)).map((r) => r.categoryId)).toEqual([A.snacks]);

      // An operator removes the membership; saving the SAME text again must not bring it back.
      await prisma.productCategoryLabel.deleteMany({ where: { productId: p.id } });
      await inA(() => products.update(p.id, { category: "Gadgets", description: "again" } as any));
      expect(await membershipsOf(p.id)).toHaveLength(0);

      // A price-only edit never touches labels.
      await inA(() => products.update(p.id, { description: "price only" } as any));
      expect(await membershipsOf(p.id)).toHaveLength(0);
    });

    it("ProductsService.importFromZoho syncs each created row's category", async () => {
      const out = await inA(() =>
        products.importFromZoho({
          items: [
            { name: "imp-1", unit: "each", pricePerUnit: "1.00", category: "SNACKS" },
            { name: "imp-2", unit: "each", pricePerUnit: "1.00", category: "Gadgets" },
            { name: "imp-3", unit: "each", pricePerUnit: "1.00" },
          ],
        } as any),
      );
      expect(out).toMatchObject({ created: 3, skipped: 0 });
      const byName = async (name: string) =>
        (await prisma.product.findFirstOrThrow({ where: { tenantId: A.id, name } })).id;
      expect((await membershipsOf(await byName("imp-1"))).map((r) => r.categoryId)).toEqual([
        A.snacks,
      ]);
      expect(await membershipsOf(await byName("imp-2"))).toHaveLength(0);
      expect(await membershipsOf(await byName("imp-3"))).toHaveLength(0);
    });

    it("VariantResolutionService.completeSetup syncs the confirmed category when it changed", async () => {
      const id = await seedProduct(A.id, "setup-product", { detailsIncomplete: true });
      await inA(() => variants.completeSetup(id, { category: "snacks" }));
      expect((await membershipsOf(id)).map((r) => r.categoryId)).toEqual([A.snacks]);
    });

    it("TrackedCategoriesService.updateSubcategory rename syncs every product that took the new name, in one pass", async () => {
      const cat = await prisma.trackedCategory.create({
        data: { tenantId: A.id, name: "Section X" },
      });
      const sub = await prisma.trackedSubcategory.create({
        data: { tenantId: A.id, trackedCategoryId: cat.id, name: "Old Name" },
      });
      const tag = { trackedCategoryId: cat.id, trackedSubcategoryId: sub.id };
      const mirrored = await seedProduct(A.id, "ren-mirrored", { ...tag, category: "Old Name" });
      const never = await seedProduct(A.id, "ren-never", tag);
      const diverged = await seedProduct(A.id, "ren-diverged", { ...tag, category: "Legacy" });
      await inA(() => tracked.updateSubcategory(cat.id, sub.id, { name: "Snacks" } as any));
      const cats = async (id: string) =>
        (await prisma.product.findUniqueOrThrow({ where: { id } })).category;
      expect(await cats(mirrored)).toBe("Snacks");
      expect(await cats(never)).toBe("Snacks");
      expect(await cats(diverged)).toBe("Legacy");
      expect((await membershipsOf(mirrored)).map((r) => r.categoryId)).toEqual([A.snacks]);
      expect((await membershipsOf(never)).map((r) => r.categoryId)).toEqual([A.snacks]);
      expect(await membershipsOf(diverged)).toHaveLength(0);
    });
  });

  describe("SA round 2: variants follow the parent; a busy lock is a coded 409", () => {
    it("a variant under a labelled parent gets NO own row; removing the parent's label un-restricts the variant", async () => {
      const parent = await seedProduct(A.id, "follow-parent", { category: "Snacks" });
      expect((await syncIn(A.id, parent, "Snacks")).addedCategoryId).toBe(A.snacks);
      const variant = await seedProduct(A.id, "follow-variant", {
        category: "snacks",
        parentProductId: parent,
      });
      expect((await syncIn(A.id, variant, "snacks")).addedCategoryId).toBeNull();
      expect(await membershipsOf(variant)).toEqual([]);
      const effective = new ProductLabelsService(prisma);
      const labelsOf = async () =>
        (await inA(() => effective.effectiveLabels(A.id, [variant]))).get(variant)
          ?.effectiveCategoryIds ?? [];
      expect([...(await labelsOf())]).toContain(A.snacks); // inherited from the parent
      await prisma.productCategoryLabel.deleteMany({
        where: { productId: parent, categoryId: A.snacks },
      });
      expect([...(await labelsOf())]).not.toContain(A.snacks); // no own row kept it restricted
    });

    it("a product create whose sync meets a busy label lock is a coded 409 LABEL_CHANGE_IN_PROGRESS (never a 500), nothing written", async () => {
      const pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      const holder = await pool.connect();
      const name = `lock-probe-${randomUUID().slice(0, 6)}`;
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
          "product-labels",
          `${A.id}:${A.snacks}`,
        ]);
        const err = await inA(() =>
          products.create({ name, unit: "each", pricePerUnit: "2.00", category: "Snacks" } as any, {
            actorId: actor.id,
            actorName: actor.name,
          }),
        ).catch((e) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).getResponse()).toMatchObject({
          code: "LABEL_CHANGE_IN_PROGRESS",
        });
        expect(await prisma.product.count({ where: { tenantId: A.id, name } })).toBe(0); // the tx rolled back
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
        await pool.end();
      }
    }, 30_000);
  });
});
