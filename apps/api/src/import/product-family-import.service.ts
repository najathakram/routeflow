import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";
import type { Prisma, Product } from "@prisma/client";
import type {
  ImportFamilyMatchKey,
  ImportFamilyRowInfo,
  ImportFamilySummary,
} from "@routeflow/types";
import { roundMoney } from "@routeflow/pricing";
import { AuditService } from "../audit/audit.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { isTobaccoCategoryName, TOBACCO_CATEGORY_NAME } from "../common/tobacco-category";
import { productCategoryViolation, productNameViolation } from "../common/text-cell-guards";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { PrismaService } from "../prisma/prisma.service";
import { IMPORT_FAMILY_PRICING_ON_MESSAGE, readFamilyPriceMode } from "../products/family-price";
import { productDisplayName } from "../products/product-display-name";
import { ProductFamiliesService } from "../products/product-families.service";
import { assertValidParent, HAS_VARIANTS_MESSAGE, type ParentDb } from "../products/product-parent";
import { bareVariantLabel, stripParentPrefix } from "../products/product-variant-name";
import type { CatalogTx } from "../products/product-catalog-sync";
import { ProductsService } from "../products/products.service";

/** SA-823 section 5: the most rows a file with a Family column may carry (it fits the largest known catalog, 2,202). */
export const IMPORT_FAMILY_MAX_ROWS = 2500;

export const IMPORT_FAMILY_NAME_ONLY_REASON =
  "Add the product's id, SKU or barcode to move it into a family.";
export const IMPORT_FAMILY_CLASS_REASON = "A family's items must share their regulated category.";
export const IMPORT_FAMILY_TOBACCO_HINT = "Set Tobacco to Yes to add this to a tobacco family.";

/** The family a row groups under: an existing container (`id` set) or one this import creates (`id` null). */
export interface FamilyTarget {
  key: string;
  name: string;
  id: string | null;
  state: "existing" | "new";
  /** An INACTIVE, empty family an earlier import made: a re-run reactivates it on the first row that needs it. */
  reactivate?: boolean;
}

/** One file row that carries a Family cell, as the planner needs it. */
export interface FamilyRowInput {
  index: number;
  rowNumber: number;
  family: string;
  variantCell?: string;
  nameCell?: string;
  id?: string;
  sku?: string;
  barcode?: string;
  /** The row's parsed product cells (category, pricePerUnit, isTobacco ...). */
  values: Record<string, unknown>;
}

export type FamilyDecision =
  | { skip: string }
  | {
      skip?: undefined;
      existing: Product | null;
      target: FamilyTarget;
      label: string;
      info: ImportFamilyRowInfo;
    };

interface NewFamily {
  name: string;
  category: string | null;
  price: number | null;
}

/** The run's family state: the row decisions plus the families this run creates (lazily, on apply). */
export interface FamilyPlan {
  decisions: Map<number, FamilyDecision>;
  newFamilies: Map<string, NewFamily>;
  created: Map<string, { id: string; name: string; assigned: number }>;
}

type RegClass = { isTobacco: boolean; tracked: string | null };
type FamilyResolution = { skip: string } | { target: FamilyTarget };

/**
 * SA-823 (row 655 PR-2): the Family / Variant name / Product ID columns of the product import. This service only
 * READS (every lookup is forTenant()) and creates / retires the empty family container; every product write goes
 * through ProductsService (assignToParent / create / update / remove) and the one family creator
 * (ProductFamiliesService.createFamilyContainer), so no new writer of a parent link, a FAMILY row or a ProductUnit
 * exists here (family-writers-tripwire.spec.ts pins it).
 */
@Injectable()
export class ProductFamilyImportService {
  private readonly logger = new Logger(ProductFamilyImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly productsService: ProductsService,
    private readonly families: ProductFamiliesService,
    private readonly audit: AuditService,
    @Optional() private readonly featureConfig?: FeatureConfigService,
  ) {}

  private tenant(): string {
    const t = this.prisma.getTenantId();
    if (!t) throw new BadRequestException("No tenant context");
    return t;
  }

  /** The 400 for a file with a regrouping Family column over the row cap (identical in preview and apply). */
  assertRowCap(rowCount: number): void {
    if (rowCount > IMPORT_FAMILY_MAX_ROWS) {
      throw new BadRequestException({
        code: API_ERROR_CODES.IMPORT_FAMILY_TOO_MANY_ROWS,
        message: `A file with a Family column can have at most ${IMPORT_FAMILY_MAX_ROWS} rows (this one has ${rowCount}). Split it into smaller files.`,
        max: IMPORT_FAMILY_MAX_ROWS,
        rows: rowCount,
      });
    }
  }

  /**
   * The 409 for a regrouping file while family pricing (`mixed_packs`) is ON: an adoption would overwrite the product's
   * five price columns, so the whole file is refused before any write.
   */
  async assertPricingOff(): Promise<void> {
    const mode = await readFamilyPriceMode(this.featureConfig, this.tenant());
    if (mode === "on") {
      throw new ConflictException({
        code: API_ERROR_CODES.IMPORT_FAMILY_PRICING_ON,
        message: IMPORT_FAMILY_PRICING_ON_MESSAGE,
      });
    }
  }

  /**
   * An old products export carries Family = the product's CURRENT parent. Such a cell is a no-op, not a regroup: it
   * needs no key and never skips, and the row updates as it always did. Returns the row indexes whose Family cell
   * equals the current family (id, SKU, barcode, then a name that is unique).
   */
  async currentFamilyNoops(
    rows: Array<{
      index: number;
      family: string;
      variantCell?: string;
      nameCell?: string;
      id?: string;
      sku?: string;
      barcode?: string;
    }>,
  ): Promise<Set<number>> {
    const db = this.prisma.forTenant().product;
    const select = { parentProductId: true } as const;
    const parentNames = new Map<string, string | null>();
    const out = new Set<number>();
    for (const r of rows) {
      // A Variant Name cell states a label (a regroup file, not an export round trip): that row stays a Family row.
      if (r.variantCell) continue;
      let hit: { parentProductId: string | null } | null = null;
      if (r.id) hit = await db.findFirst({ where: { id: r.id }, select });
      else {
        if (r.sku) hit = await db.findFirst({ where: { sku: r.sku }, select });
        if (!hit && r.barcode) hit = await db.findFirst({ where: { barcode: r.barcode }, select });
        if (!hit && r.nameCell) {
          // an export writes a variant's Item Name bare, but a hand-edited file may carry "{Family} - "
          const bare = stripParentPrefix(r.nameCell, r.family);
          const byName = await db.findMany({
            where: { name: { equals: bare, mode: "insensitive" } },
            select,
            take: 2,
          });
          if (byName.length === 1) hit = byName[0];
        }
      }
      const parentId = hit?.parentProductId;
      if (!parentId) continue;
      if (!parentNames.has(parentId)) {
        const p = await db.findFirst({ where: { id: parentId }, select: { name: true } });
        parentNames.set(parentId, p?.name ?? null);
      }
      const parentName = parentNames.get(parentId);
      if (parentName && parentName.trim().toLowerCase() === r.family.trim().toLowerCase()) {
        out.add(r.index);
      }
    }
    return out;
  }

  /**
   * Decide every Family row before the first write (read-only): the match key (id, then SKU, then barcode; a name never
   * matches), the family (SA-823 section 2 a-d), the variant label, and the in-file guards (a duplicate label skips BOTH rows;
   * the first row of a family sets its regulated class). The preview and the apply run this same method.
   */
  async planRows(rows: FamilyRowInput[]): Promise<FamilyPlan> {
    const tenantId = this.tenant();
    const db = this.prisma.forTenant().product;
    const plan: FamilyPlan = { decisions: new Map(), newFamilies: new Map(), created: new Map() };
    const familyCache = new Map<string, Promise<FamilyResolution>>();
    const parentNames = new Map<string, string>();

    const resolveFamily = (name: string) => {
      const key = name.toLowerCase();
      let hit = familyCache.get(key);
      if (!hit) {
        hit = this.resolveFamily(name);
        familyCache.set(key, hit);
      }
      return hit;
    };
    const parentName = async (id: string): Promise<string> => {
      let n = parentNames.get(id);
      if (n === undefined) {
        const p = await db.findFirst({ where: { id }, select: { name: true } });
        n = p?.name ?? "another family";
        parentNames.set(id, n);
      }
      return n;
    };

    // A1: per-row resolution
    for (const r of rows) {
      plan.decisions.set(r.index, await this.decide(r, tenantId, resolveFamily, parentName));
    }

    // A2: two rows giving one family the same label are BOTH skipped
    const byLabel = new Map<string, number[]>();
    for (const r of rows) {
      const d = plan.decisions.get(r.index)!;
      if (d.skip !== undefined) continue;
      const k = `${d.target.key}\u0000${d.label.toLowerCase()}`;
      byLabel.set(k, [...(byLabel.get(k) ?? []), r.index]);
    }
    for (const indexes of byLabel.values()) {
      if (indexes.length < 2) continue;
      for (const i of indexes) {
        const d = plan.decisions.get(i) as Extract<FamilyDecision, { target: FamilyTarget }>;
        plan.decisions.set(i, {
          skip: `Another row gives ${d.target.name} the same variant name (${d.label}). Give each item in a family its own variant name.`,
        });
      }
    }

    // A3: one regulated class per family (SEAM: relax with a compliance ruling). A row's class is what the writer will
    // leave it with: an existing product keeps its own; a NEW variant is created by create(), which takes the parent's.
    const classRef = new Map<string, RegClass | null>();
    const cache = this.classCache();
    for (const r of rows) {
      const d = plan.decisions.get(r.index)!;
      if (d.skip !== undefined) continue;
      const cls = d.existing
        ? await this.existingClass(r, d.existing, cache)
        : await this.newVariantClass(r, d.target, cache);
      let ref = classRef.get(d.target.key);
      if (ref === undefined) {
        ref = d.target.id ? await this.siblingClass(d.target.id) : undefined;
        if (ref !== undefined) classRef.set(d.target.key, ref);
      }
      if (ref && (ref.isTobacco !== cls.isTobacco || ref.tracked !== cls.tracked)) {
        // a new plain item meeting a tobacco family: the fix is one cell, so say so
        const plainIntoTobacco =
          !d.existing && ref.isTobacco && !cls.isTobacco && r.values.isTobacco !== true;
        plan.decisions.set(r.index, {
          skip: plainIntoTobacco ? IMPORT_FAMILY_TOBACCO_HINT : IMPORT_FAMILY_CLASS_REASON,
        });
        continue;
      }
      if (ref === undefined) classRef.set(d.target.key, cls);
    }

    // A4: what a NEW family is created with, from the rows the apply will ACCEPT: the category of the first such row, the
    // lowest price among them (display only). A row the writer is certain to refuse does not count: a new product with no
    // Rate, or a SKU / barcode an earlier row of the file already claimed.
    const claimed = new Set<string>();
    for (const r of rows) {
      const d = plan.decisions.get(r.index)!;
      const keys = [
        ...(r.sku ? [`sku:${r.sku.toLowerCase()}`] : []),
        ...(r.barcode ? [`barcode:${r.barcode.toLowerCase()}`] : []),
      ];
      const repeats = keys.some((k) => claimed.has(k));
      for (const k of keys) claimed.add(k);
      if (d.skip !== undefined || d.target.state !== "new") continue;
      const cell = r.values.pricePerUnit;
      if (repeats || (!d.existing && typeof cell !== "number")) continue;
      const nf = plan.newFamilies.get(d.target.key) ?? {
        name: d.target.name,
        category: null,
        price: null,
      };
      const cat = (r.values.category as string | undefined) ?? d.existing?.category ?? null;
      if (nf.category === null && typeof cat === "string" && cat.trim() !== "") {
        nf.category = cat.trim();
      }
      const price =
        typeof cell === "number" ? cell : d.existing ? Number(d.existing.pricePerUnit) : null;
      if (price !== null && Number.isFinite(price) && (nf.price === null || price < nf.price)) {
        nf.price = price;
      }
      plan.newFamilies.set(d.target.key, nf);
    }
    // a new family whose rows were all refused above still needs its entry (its name): the first accepted decision
    for (const r of rows) {
      const d = plan.decisions.get(r.index)!;
      if (d.skip !== undefined || d.target.state !== "new" || plan.newFamilies.has(d.target.key)) {
        continue;
      }
      plan.newFamilies.set(d.target.key, { name: d.target.name, category: null, price: null });
    }
    return plan;
  }

  /** Per-plan lookups of the regulated pair, so a 2,500-row file asks each question once. */
  private classCache() {
    const parents = new Map<
      string,
      Promise<Pick<Product, "isTobacco" | "trackedCategoryId"> | null>
    >();
    const names = new Map<string, Promise<string | null>>();
    let tobacco: Promise<string | null> | undefined;
    const db = this.prisma.forTenant();
    return {
      parent: (id: string) => {
        let hit = parents.get(id);
        if (!hit) {
          hit = db.product.findFirst({
            where: { id },
            select: { isTobacco: true, trackedCategoryId: true },
          });
          parents.set(id, hit);
        }
        return hit;
      },
      categoryName: (id: string) => {
        let hit = names.get(id);
        if (!hit) {
          hit = db.trackedCategory
            .findFirst({ where: { id }, select: { name: true } })
            .then((c) => c?.name ?? null);
          names.set(id, hit);
        }
        return hit;
      },
      /** The tenant's Tobacco type, or null when create() would have to seed it. */
      tobaccoId: () => {
        tobacco ??= db.trackedCategory
          .findFirst({
            where: { name: { equals: TOBACCO_CATEGORY_NAME, mode: "insensitive" } },
            select: { id: true },
          })
          .then((c) => c?.id ?? null);
        return tobacco;
      },
    };
  }

  /** An existing product keeps its own pair; a Tobacco=Yes cell files it in the Tobacco type (update() does the same). */
  private async existingClass(
    r: FamilyRowInput,
    existing: Product,
    cache: ReturnType<ProductFamilyImportService["classCache"]>,
  ): Promise<RegClass> {
    const cell = r.values.isTobacco;
    if (cell === true && !existing.trackedCategoryId) {
      return { isTobacco: true, tracked: (await cache.tobaccoId()) ?? "new:tobacco" };
    }
    return {
      isTobacco: typeof cell === "boolean" ? cell : !!existing.isTobacco,
      tracked: existing.trackedCategoryId ?? null,
    };
  }

  /**
   * The pair ProductsService.create() will give a NEW variant under `target` (products.service.ts, "Compliance-pack
   * sync"): a parent with a Tobacco-type / tracked category passes it on (isTobacco follows that category); else a
   * Tobacco=Yes cell files the row in the Tobacco type; else the cell, else the parent's flag, with no type.
   */
  private async newVariantClass(
    r: FamilyRowInput,
    target: FamilyTarget,
    cache: ReturnType<ProductFamilyImportService["classCache"]>,
  ): Promise<RegClass> {
    const cell = r.values.isTobacco;
    const parent = target.id ? await cache.parent(target.id) : null;
    if (parent?.trackedCategoryId) {
      return {
        isTobacco: isTobaccoCategoryName(await cache.categoryName(parent.trackedCategoryId)),
        tracked: parent.trackedCategoryId,
      };
    }
    if (cell === true)
      return { isTobacco: true, tracked: (await cache.tobaccoId()) ?? "new:tobacco" };
    return { isTobacco: typeof cell === "boolean" ? cell : !!parent?.isTobacco, tracked: null };
  }

  private async decide(
    r: FamilyRowInput,
    tenantId: string,
    resolveFamily: (name: string) => Promise<FamilyResolution>,
    parentName: (id: string) => Promise<string>,
  ): Promise<FamilyDecision> {
    const db = this.prisma.forTenant().product;
    let existing: Product | null = null;
    let matchedBy: ImportFamilyMatchKey | null = null;
    // The stable keys only: id, then SKU, then barcode. A name never regroups (bare labels collide globally).
    if (r.id) {
      existing = await db.findFirst({ where: { id: r.id } });
      if (!existing) {
        return {
          skip: "That Product ID isn't in this business. Check the Product ID column, or use the SKU.",
        };
      }
      matchedBy = "id";
    } else {
      if (r.sku) {
        existing = await db.findFirst({ where: { sku: r.sku } });
        if (existing) matchedBy = "sku";
      }
      if (!existing && r.barcode) {
        existing = await db.findFirst({ where: { barcode: r.barcode } });
        if (existing) {
          if (r.sku && existing.sku && existing.sku !== r.sku) {
            return {
              skip: "SKU differs from the product matched by barcode; change SKUs in the product editor",
            };
          }
          matchedBy = "barcode";
        }
      }
    }
    if (!existing && r.nameCell) {
      const byName = await db.findMany({
        where: { name: { equals: r.nameCell, mode: "insensitive" } },
        take: 1,
      });
      if (byName.length > 0) return { skip: IMPORT_FAMILY_NAME_ONLY_REASON };
    }
    if (existing?.kind === "FAMILY") {
      return { skip: `${existing.name} is a family, not a product, so it can't be grouped.` };
    }
    if (existing?.kind === "RECIPE") {
      return { skip: `${existing.name} is a recipe, so it can't be grouped into a family.` };
    }

    const fam = await resolveFamily(r.family);
    if ("skip" in fam) return { skip: fam.skip };
    const target = fam.target;
    if ((!target.id || target.reactivate) && existing) {
      // a NEW (or not yet reactivated) family has no usable row to ask assertValidParent about, but the rule on the
      // product itself still applies
      const kids = await db.count({ where: { parentProductId: existing.id } });
      if (kids > 0) return { skip: HAS_VARIANTS_MESSAGE };
    }
    if (target.id && !target.reactivate && existing) {
      // The writer's own parent rules, asked read-only so the preview agrees with the apply.
      const parentDb: ParentDb = {
        product: {
          findFirst: (args) => db.findFirst(args as Prisma.ProductFindFirstArgs),
          count: (args) => db.count(args as Prisma.ProductCountArgs),
        },
      };
      try {
        await assertValidParent(parentDb, { tenantId, id: existing.id, parentId: target.id });
      } catch (e) {
        return {
          skip: e instanceof HttpException ? e.message : "This product can't join that family.",
        };
      }
    }

    const raw = (r.variantCell ?? r.nameCell ?? existing?.name ?? "").trim();
    if (!raw) return { skip: "Name is required" };
    let label: string;
    try {
      label = bareVariantLabel(raw, target.name).trim();
    } catch (e) {
      return { skip: e instanceof HttpException ? e.message : "That variant name can't be used." };
    }
    const violation =
      productNameViolation(
        { name: label, variantName: label },
        existing
          ? { name: existing.name, variantName: existing.variantName ?? undefined }
          : undefined,
      ) ??
      (target.state === "new" ? productNameViolation({ name: target.name }) : null) ??
      productCategoryViolation(
        r.values.category as string | undefined,
        existing ? (existing.category ?? null) : undefined,
      );
    if (violation) return { skip: violation };

    let movesFrom: string | null = null;
    if (existing?.parentProductId && existing.parentProductId !== target.id) {
      movesFrom = await parentName(existing.parentProductId);
    }
    const stock = existing && existing.currentStock != null ? Number(existing.currentStock) : null;
    return {
      existing,
      target,
      label,
      info: {
        matchedBy,
        name: target.name,
        state: target.state,
        variantName: label,
        displayName: productDisplayName(
          { name: label, variantName: label, parentProductId: target.id ?? "new" },
          target.name,
        ),
        movesFrom,
        stock,
      },
    };
  }

  /** SA-823 section 2 (a)-(d): the family a name resolves to among the tenant's root products. */
  private async resolveFamily(name: string): Promise<FamilyResolution> {
    const db = this.prisma.forTenant().product;
    const roots = await db.findMany({
      where: { name: { equals: name, mode: "insensitive" }, parentProductId: null },
    });
    const active = roots.filter((p) => p.isActive);
    if (active.length === 0) {
      if (roots.length > 0) {
        // A re-run after an all-failed run: the empty family THAT import made is reused, not a dead end.
        for (const old of roots) {
          if (await this.isReusableImportFamily(old)) {
            return {
              target: {
                key: `id:${old.id}`,
                name: old.name,
                id: old.id,
                state: "existing",
                reactivate: true,
              },
            };
          }
        }
        return { skip: `${roots[0].name} is inactive. Reactivate it, or use another family name.` };
      }
      return { target: { key: `new:${name.toLowerCase()}`, name, id: null, state: "new" } };
    }
    const fam = active.find((p) => p.kind === "FAMILY") ?? active[0];
    const existingTarget = {
      key: `id:${fam.id}`,
      name: fam.name,
      id: fam.id,
      state: "existing" as const,
    };
    if (fam.kind === "FAMILY") return { target: existingTarget };
    const kids = await db.count({ where: { parentProductId: fam.id } });
    if (kids > 0) return { target: existingTarget }; // (b) a legacy parent that already has variants
    return {
      skip: `${fam.name} is a product, not a family. Rename one of them, or make ${fam.name} a family first.`,
    };
  }

  /** An INACTIVE FAMILY root with no members, no order history, that an import run created (its audit row says so). */
  private async isReusableImportFamily(old: Product): Promise<boolean> {
    if (old.kind !== "FAMILY") return false;
    const scoped = this.prisma.forTenant();
    if ((await scoped.product.count({ where: { parentProductId: old.id } })) > 0) return false;
    if ((await scoped.orderItem.count({ where: { productId: old.id } })) > 0) return false;
    const made = await this.prisma.auditLog.findFirst({
      where: {
        tenantId: this.tenant(),
        action: AUDIT_ACTIONS.IMPORT_FAMILY_CREATED,
        entityId: old.id,
      },
      select: { id: true },
    });
    return made !== null;
  }

  /** The regulated class the family's active items share; `undefined` = no items yet; `null` = a legacy mix (no constraint). */
  private async siblingClass(familyId: string): Promise<RegClass | null | undefined> {
    const sibs = await this.prisma.forTenant().product.findMany({
      where: { parentProductId: familyId, isActive: true },
      select: { isTobacco: true, trackedCategoryId: true },
    });
    if (sibs.length === 0) return undefined;
    const first = { isTobacco: !!sibs[0].isTobacco, tracked: sibs[0].trackedCategoryId ?? null };
    const uniform = sibs.every(
      (s) => !!s.isTobacco === first.isTobacco && (s.trackedCategoryId ?? null) === first.tracked,
    );
    return uniform ? first : null;
  }

  /**
   * APPLY only: the id of the family a row goes under, creating the container on the first row that needs it (name
   * lock + root-name check, then the one FAMILY creator, in one transaction), or reactivating the empty family an
   * earlier import made.
   */
  async ensureFamily(plan: FamilyPlan, target: FamilyTarget, actorId: string): Promise<string> {
    const done = plan.created.get(target.key);
    if (done) return done.id;
    if (target.id) {
      if (target.reactivate) {
        await this.families.reactivateFamilyContainer(target.id, actorId);
        plan.created.set(target.key, { id: target.id, name: target.name, assigned: 0 });
      }
      return target.id;
    }
    const nf = plan.newFamilies.get(target.key);
    if (!nf) throw new BadRequestException("This family isn't part of the plan.");
    const tenantId = this.tenant();
    const family = await this.prisma.tenantTransaction(async (tx: CatalogTx) => {
      const conflicts = await this.families.reserveFamilyName(tx, tenantId, nf.name);
      if (conflicts.length > 0) {
        throw new ConflictException(`A product named "${nf.name}" already exists`);
      }
      return this.families.createFamilyContainer(tx, {
        name: nf.name,
        category: nf.category,
        pricePerUnit: roundMoney(nf.price ?? 0).toFixed(2),
        actorId,
      });
    });
    plan.created.set(target.key, { id: family.id, name: nf.name, assigned: 0 });
    // The mark a re-run reads to know this empty family was an import's (isReusableImportFamily).
    await this.audit.log({
      tenantId,
      userId: actorId,
      action: AUDIT_ACTIONS.IMPORT_FAMILY_CREATED,
      entityType: "Product",
      entityId: family.id,
      meta: { name: nf.name },
    });
    return family.id;
  }

  /** A row was written under `target`: the family this run created is not empty. */
  markAssigned(plan: FamilyPlan, target: FamilyTarget): void {
    const made = plan.created.get(target.key);
    if (made) made.assigned++;
  }

  /**
   * An empty family this run created (or reactivated) is deactivated in the same run (SA-823 section 5). A cleanup that
   * fails is reported as not removed, never as deactivated.
   */
  async deactivateEmpty(
    plan: FamilyPlan,
  ): Promise<{ deactivated: { name: string }[]; cleanupFailed: { name: string }[] }> {
    const deactivated: { name: string }[] = [];
    const cleanupFailed: { name: string }[] = [];
    for (const made of plan.created.values()) {
      if (made.assigned > 0) continue;
      try {
        await this.productsService.remove(made.id);
        deactivated.push({ name: made.name });
      } catch (e) {
        this.logger.warn(`could not deactivate empty family ${made.id}: ${(e as Error).message}`);
        cleanupFailed.push({ name: made.name });
      }
    }
    return { deactivated, cleanupFailed };
  }

  /** The header block of the preview / result, derived from the final row plans (so a later skip is counted as one). */
  summarize(
    plans: Array<{
      row: number;
      action: string;
      reason?: string;
      changes?: Record<string, unknown>;
      family?: ImportFamilyRowInfo;
    }>,
    familyRows: Set<number>,
    cleanup: { deactivated: { name: string }[]; cleanupFailed: { name: string }[] },
  ): ImportFamilySummary {
    const toCreate = new Map<string, { name: string; rows: number }>();
    const skips = new Map<string, number>();
    let grouped = 0;
    let newVariants = 0;
    let moves = 0;
    for (const p of plans) {
      if (p.action === "skip") {
        if (familyRows.has(p.row) && p.reason) skips.set(p.reason, (skips.get(p.reason) ?? 0) + 1);
        continue;
      }
      if (!p.family) continue;
      if (p.family.state === "new") {
        const k = p.family.name.toLowerCase();
        const cur = toCreate.get(k) ?? { name: p.family.name, rows: 0 };
        cur.rows++;
        toCreate.set(k, cur);
      }
      if (p.action === "create") newVariants++;
      else if (p.changes && "family" in p.changes) {
        grouped++;
        if (p.family.movesFrom) moves++;
      }
    }
    return {
      familiesToCreate: [...toCreate.values()],
      grouped,
      newVariants,
      moves,
      skipsByReason: [...skips.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
      deactivated: cleanup.deactivated,
      cleanupFailed: cleanup.cleanupFailed,
    };
  }

  /** One `import.products.applied` summary row per apply of a product import (SA-823 section 4); `summary` is absent without Family columns. */
  async recordApplied(input: {
    actorId: string;
    fileName?: string;
    counts: Record<string, number>;
    summary?: ImportFamilySummary;
    /** false when the run crashed part-way: the counts are the ones reached so far. */
    completed?: boolean;
  }): Promise<void> {
    await this.audit.log({
      tenantId: this.tenant(),
      userId: input.actorId,
      action: AUDIT_ACTIONS.IMPORT_PRODUCTS_APPLIED,
      entityType: "Product",
      meta: {
        fileName: input.fileName ?? null,
        completed: input.completed ?? true,
        ...input.counts,
        familiesCreated: input.summary?.familiesToCreate.length ?? 0,
        grouped: input.summary?.grouped ?? 0,
        moves: input.summary?.moves ?? 0,
        familiesDeactivated: input.summary?.deactivated.length ?? 0,
        actor: input.actorId,
      },
    });
  }
}
