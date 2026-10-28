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
