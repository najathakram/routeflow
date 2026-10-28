import { roundMoney } from "@routeflow/pricing";
import { isPieceSynonym, unitNameKey } from "../units/piece-words";
import { MAX_UNIT_NAME_LENGTH } from "../units/units.service";

/**
 * SA-1027 rules 3, 4, 6, 7: the pure copy decisions. The service reads the source and the target into these shapes,
 * asks for a plan, and writes only what the plan says. Nothing here reads a database.
 */
export interface SourceProduct {
  id: string;
  name: string;
  sku: string | null;
  unitSku: string | null;
  barcode: string | null;
  parentProductId: string | null;
  variantName: string | null;
  isTobacco: boolean;
  trackedCategoryId: string | null;
  trackedSubcategoryId: string | null;
  regItemType: string | null;
  regUomCase: string | null;
  regUomUnit: string | null;
  imageKeys: string[];
  levelBarcodes: Array<{ code: string; level: string }>;
  /** The product has a unit ladder (`ProductUnit` rows). */
  hasLadder: boolean;
}

export interface TargetProduct {
  name: string;
  sku: string | null;
  unitSku: string | null;
  barcode: string | null;
  parentProductId: string | null;
}

export interface TargetCatalog {
  /** ACTIVE target products only. */
  products: TargetProduct[];
  levelBarcodes: Array<{ code: string; level: string }>;
  /** The target holds `flag.units_v1` (the ladder writer sits behind it). */
  unitsV1: boolean;
}

export interface PlannedProduct {
  sourceId: string;
  dropBarcode: boolean;
  dropUnitSku: boolean;
  droppedLevels: Array<{ code: string; level: string }>;
  packOnly: boolean;
  photos: number;
}

export interface PlannedFamily {
  rootId: string;
  /** Root first, then its variants. */
  members: PlannedProduct[];
}

export type DroppedCode = {
  sourceId: string;
  kind: "barcode" | "unitSku" | "levelBarcode";
  code: string;
};

export interface CopyPlan {
  create: PlannedFamily[];
  createCount: number;
  skippedBySku: Array<{ sourceId: string; sku: string }>;
  skippedByName: Array<{ sourceId: string; name: string }>;
  variantsSkipped: Array<{ sourceId: string; sku: string }>;
  regulated: Array<{ sourceId: string; reason: "self" | "family" }>;
  codesDropped: DroppedCode[];
  packOnly: string[];
  photos: number;
}

/**
 * Rule 6: one predicate, fail closed. `isTobacco`, either tracked pointer, or any of the three `reg*` fields makes a
 * product regulated; a row that cannot be read (null, or a field that is `undefined` rather than `null`) counts as
 * regulated too, so it is listed and never written.
 */
export function isRegulatedSource(p: SourceProduct): boolean {
  if (!p) return true;
  const fields = [
    p.isTobacco,
    p.trackedCategoryId,
    p.trackedSubcategoryId,
    p.regItemType,
    p.regUomCase,
    p.regUomUnit,
  ];
  if (fields.some((f) => f === undefined)) return true;
  return p.isTobacco === true || fields.slice(1).some((f) => f !== null && f !== "");
}

const hasValue = (v: string | null | undefined): v is string => typeof v === "string" && v !== "";

/** The service's own clash predicates (`products.service.ts` create), over the target's active products. */
function targetIndex(t: TargetCatalog) {
  const skuHolders = new Set<string>(); // sku OR unitSku (a source SKU may not equal either)
  const barcodeBlockers = new Set<string>(); // barcode OR unitSku (a source barcode)
  const unitSkuBlockers = new Set<string>(); // unitSku OR sku OR barcode (a source unitSku)
  const rootNames = new Set<string>();
  for (const p of t.products) {
    if (hasValue(p.sku)) {
      skuHolders.add(p.sku);
      unitSkuBlockers.add(p.sku);
    }
    if (hasValue(p.unitSku)) {
      skuHolders.add(p.unitSku);
      barcodeBlockers.add(p.unitSku);
      unitSkuBlockers.add(p.unitSku);
    }
    if (hasValue(p.barcode)) {
      barcodeBlockers.add(p.barcode);
      unitSkuBlockers.add(p.barcode);
    }
    if (p.parentProductId === null) rootNames.add(p.name);
  }
  const levels = new Set(t.levelBarcodes.map((l) => `${l.code}|${l.level}`));
  return { skuHolders, barcodeBlockers, unitSkuBlockers, rootNames, levels };
}

export function planCatalogCopy(source: readonly SourceProduct[], target: TargetCatalog): CopyPlan {
  const idx = targetIndex(target);
  const plan: CopyPlan = {
    create: [],
    createCount: 0,
    skippedBySku: [],
    skippedByName: [],
    variantsSkipped: [],
    regulated: [],
    codesDropped: [],
    packOnly: [],
    photos: 0,
  };

  // Group into families by root: a root is a product with no parent (or whose parent is not in the source).
  const byId = new Map(source.map((p) => [p.id, p]));
  const rootOf = (p: SourceProduct) =>
    p.parentProductId && byId.has(p.parentProductId) ? p.parentProductId : p.id;
  const families = new Map<string, SourceProduct[]>();
  for (const p of source) {
    const root = rootOf(p);
    const list = families.get(root) ?? [];
    list.push(p);
    families.set(root, list);
  }

  for (const [rootId, members] of families) {
    const root = byId.get(rootId) ?? members[0];
    const variants = members.filter((m) => m.id !== root.id);

    // Rule 6: a family with any regulated member is left out whole, every member listed.
    if (members.some(isRegulatedSource)) {
      for (const m of members) {
        plan.regulated.push({
          sourceId: m?.id ?? rootId,
          reason: isRegulatedSource(m) ? "self" : "family",
        });
      }
      continue;
    }

    // Rule 4: the family is copied or skipped as one unit, keyed by its parent.
    if (hasValue(root.sku)) {
      if (idx.skuHolders.has(root.sku)) {
        plan.skippedBySku.push({ sourceId: root.id, sku: root.sku });
        continue;
      }
    } else if (idx.rootNames.has(root.name)) {
      plan.skippedByName.push({ sourceId: root.id, name: root.name });
      continue;
    }

    const planned: PlannedProduct[] = [];
    const take = (p: SourceProduct) => {
      const dropBarcode = hasValue(p.barcode) && idx.barcodeBlockers.has(p.barcode);
      const dropUnitSku = hasValue(p.unitSku) && idx.unitSkuBlockers.has(p.unitSku);
      const droppedLevels = p.levelBarcodes.filter((l) => idx.levels.has(`${l.code}|${l.level}`));
      if (dropBarcode)
        plan.codesDropped.push({ sourceId: p.id, kind: "barcode", code: p.barcode! });
      if (dropUnitSku)
        plan.codesDropped.push({ sourceId: p.id, kind: "unitSku", code: p.unitSku! });
      for (const l of droppedLevels) {
        plan.codesDropped.push({ sourceId: p.id, kind: "levelBarcode", code: l.code });
      }
      const packOnly = p.hasLadder && !target.unitsV1;
      if (packOnly) plan.packOnly.push(p.id);
      plan.photos += p.imageKeys.length;
      planned.push({
        sourceId: p.id,
        dropBarcode,
        dropUnitSku,
        droppedLevels,
        packOnly,
        photos: p.imageKeys.length,
      });
    };

    take(root);
    for (const v of variants) {
      if (hasValue(v.sku) && idx.skuHolders.has(v.sku)) {
        plan.variantsSkipped.push({ sourceId: v.id, sku: v.sku });
        continue;
      }
      take(v);
    }
    plan.create.push({ rootId: root.id, members: planned });
    plan.createCount += planned.length;
  }
  return plan;
}

// ─── the write inputs (pure: they build the object a writer takes whole, and call nothing) ──────────────────────────
//
// SA-1027 ruling 1: the service hands each of these to the app's own writer exactly as built and names no price column
// itself, so the price-column writer tripwires have nothing to list. Money is rounded here, once, at the boundary.

/** A money value as the 2-decimal string the writers take; a null or unreadable value is 0.00. */
export const toMoney = (v: unknown): string => roundMoney(Number(v ?? 0)).toFixed(2);

/** The five price tiers, in order, of a source row (a Prisma `Product` or anything shaped like one). */
export type Prices = [string, string, string, string, string];

export function readPrices(row: {
  pricePerUnit: unknown;
  priceTier2: unknown;
  priceTier3: unknown;
  priceTier4: unknown;
  priceTier5: unknown;
}): Prices {
  return [
    toMoney(row.pricePerUnit),
    toMoney(row.priceTier2),
    toMoney(row.priceTier3),
    toMoney(row.priceTier4),
    toMoney(row.priceTier5),
  ];
}

/** The columns `create` carries (rule 3), as the plan sees them; the service adds the not-carried ones for the dry run. */
export interface CopySource extends SourceProduct {
  kind: string;
  description: string | null;
  unit: string;
  unitsPerBox: number | null;
  category: string | null;
  msrp: string | null;
  prices: Prices;
}

/**
 * `ProductsService.create`'s input for one product: exactly the columns rule 3 lists; a code the plan dropped is simply
 * not sent. A variant stores its BARE label as its name (the family editor does the same).
 */
export function buildProductCreateInput(
  src: CopySource,
  planned: PlannedProduct,
  parentTargetId: string | null,
  msrpHeld: boolean,
) {
  const dropBarcode = planned.dropBarcode || planned.droppedLevels.length > 0;
  const [p1, p2, p3, p4, p5] = src.prices;
  return {
    name: parentTargetId ? (src.variantName ?? src.name) : src.name,
    ...(src.sku ? { sku: src.sku } : {}),
    ...(src.barcode && !dropBarcode ? { barcode: src.barcode } : {}),
    ...(src.unitSku && !planned.dropUnitSku ? { unitSku: src.unitSku } : {}),
    unit: src.unit,
    pricePerUnit: p1,
    priceTier2: p2,
    priceTier3: p3,
    priceTier4: p4,
    priceTier5: p5,
    ...(src.category ? { category: src.category } : {}),
    ...(src.description ? { description: src.description } : {}),
    ...(src.msrp !== null && msrpHeld ? { msrp: src.msrp } : {}),
    ...(src.unitsPerBox ? { unitsPerBox: src.unitsPerBox } : {}),
    ...(parentTargetId
      ? { parentProductId: parentTargetId, variantName: src.variantName ?? src.name }
      : {}),
    isActive: true,
  };
}

/** `ProductFamiliesService.createFamilyContainer`'s input: the container carries the root's first-tier price only. */
export function buildFamilyContainerInput(root: CopySource) {
  return {
    name: root.name,
    category: root.category,
    pricePerUnit: root.prices[0],
    description: root.description,
    actorId: null,
  };
}

/** One rung of a source ladder, as `ProductUnitsService.create` takes it, re-parented onto the target's rung. */
export function buildLadderLevelInput(
  level: {
    label: string;
    factorToBase: unknown;
    price: unknown;
    priceTier2: unknown;
    priceTier3: unknown;
    priceTier4: unknown;
    priceTier5: unknown;
    perParent: unknown;
    isDefaultSelling: boolean;
    sortOrder: number;
  },
  targetParentUnitId: string | null,
) {
  const num = (v: unknown) => (v === null || v === undefined ? null : roundMoney(Number(v)));
  return {
    label: level.label,
    factorToBase: level.factorToBase,
    price: num(level.price),
    priceTier2: num(level.priceTier2),
    priceTier3: num(level.priceTier3),
    priceTier4: num(level.priceTier4),
    priceTier5: num(level.priceTier5),
    parentUnitId: targetParentUnitId,
    perParent: level.perParent,
    isDefaultSelling: level.isDefaultSelling,
    sortOrder: level.sortOrder,
  };
}

/**
 * SA-1027 spec b17f0ed7: the tenant units the ladder writer would create on the target. New unit names come ONLY from
 * the ladder writer (`ProductUnitsService.create` links a level's label to the tenant's unit list, adding the name when
 * the tenant has none by that key); this script never writes a TenantUnit itself. This lists them for the dry run: the
 * labels of the ladders about to be written, once each in first-use order, minus the names the target already holds
 * (matched by the writer's own key) and minus the names the writer does not list (blank, over the length cap, Piece and
 * its synonyms). At the tenant's active-unit cap the writer saves a level unlinked instead; the list is what it will try.
 */
export function listNewUnitNames(
  ladders: ReadonlyArray<readonly string[]>,
  targetKeys: ReadonlySet<string>,
): string[] {
  const seen = new Set(targetKeys);
  const out: string[] = [];
  for (const labels of ladders) {
    for (const label of labels) {
      const name = label.normalize("NFC").trim();
      if (!name || name.length > MAX_UNIT_NAME_LENGTH || isPieceSynonym(name)) continue;
      const key = unitNameKey(name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}
