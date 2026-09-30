/**
 * Pure product-form logic — no React/React-Native imports, so it can be unit
 * tested directly (mobile Jest is pure-logic only) and reused by both the full
 * ProductForm screen and the compact InlineCreateProductSheet.
 */

export interface ProductFormValues {
  name: string;
  sku: string;
  barcode: string;
  /**
   * Optional retail-unit (inner piece) code. When blank, the case `sku`
   * applies to units too (read-time fallback on the server) — leave blank
   * unless the unit has its own scannable code.
   */
  unitSku: string;
  category: string;
  unit: string;
  /**
   * Loose pieces per box. Leave blank for products sold individually.
   * When set (>1), `pricePerUnit` is treated as the BOX price; loose pieces
   * are prorated as `pricePerUnit / unitsPerBox` (`@routeflow/pricing`).
   */
  unitsPerBox: string;
  description: string;
  pricePerUnit: string;
  /** Customer tier prices (tier 1 = pricePerUnit); blank means "inherit tier 1". */
  priceTier2: string;
  priceTier3: string;
  priceTier4: string;
  priceTier5: string;
  standardCost: string;
  currentStock: string;
  reorderPoint: string;
  reorderQty: string;
  isActive: boolean;
  /** When set, this product is created as a variant of that standalone product. */
  parentProductId: string;
  /** Flavor/variety label; the variant's `name` stores just this. */
  variantName: string;
  /** Parent's display name — for the picker label only, not submitted. */
  parentName?: string;
  /** Regulated section id, "" = none. */
  trackedCategoryId: string;
  /** Section's display name — carried alongside the id so the picker can show a
   *  since-deactivated current section without a second lookup (same pattern as
   *  `parentName` above for the "Variant of" picker). */
  trackedCategoryName?: string;
  /** Regulated subcategory id, "" = none. */
  trackedSubcategoryId: string;
  /**
   * Regulatory reporting config (mirrors apps/web/lib/api/products.ts). The
   * vocabulary is validated service-side against the section's reportTemplate
   * (apps/api/src/regulated/template-registry.ts). "" = unset.
   */
  regItemType: string;
  /** Case/carton UoM — opts the product into case-level report bucketing when sold by the box. */
  regUomCase: string;
  /** Loose/unit UoM. */
  regUomUnit: string;
}

export function emptyProductForm(): ProductFormValues {
  return {
    name: "",
    sku: "",
    barcode: "",
    unitSku: "",
    category: "",
    unit: "ea",
    unitsPerBox: "",
    description: "",
    pricePerUnit: "",
    priceTier2: "",
    priceTier3: "",
    priceTier4: "",
    priceTier5: "",
    standardCost: "",
    currentStock: "",
    reorderPoint: "",
    reorderQty: "",
    isActive: true,
    parentProductId: "",
    variantName: "",
    parentName: undefined,
    trackedCategoryId: "",
    trackedCategoryName: undefined,
    trackedSubcategoryId: "",
    regItemType: "",
    regUomCase: "",
    regUomUnit: "",
  };
}

export function productFormFromValues(
  p: Partial<Record<keyof ProductFormValues | "pricePerUnit" | "currentStock", any>> &
    Record<string, any>,
): ProductFormValues {
  return {
    name: p.name ?? "",
    sku: p.sku ?? "",
    barcode: p.barcode ?? "",
    unitSku: p.unitSku ?? "",
    category: p.category ?? "",
    unit: p.unit ?? "ea",
    unitsPerBox: p.unitsPerBox != null ? String(p.unitsPerBox) : "",
    description: p.description ?? "",
    pricePerUnit: p.pricePerUnit != null ? String(p.pricePerUnit) : "",
    priceTier2: p.priceTier2 != null ? String(p.priceTier2) : "",
    priceTier3: p.priceTier3 != null ? String(p.priceTier3) : "",
    priceTier4: p.priceTier4 != null ? String(p.priceTier4) : "",
    priceTier5: p.priceTier5 != null ? String(p.priceTier5) : "",
    standardCost:
      (p.standardCost ?? p.costPerUnit) != null ? String(p.standardCost ?? p.costPerUnit) : "",
    currentStock: p.currentStock != null ? String(p.currentStock) : "",
    reorderPoint: p.reorderPoint != null ? String(p.reorderPoint) : "",
    reorderQty: p.reorderQty != null ? String(p.reorderQty) : "",
    isActive: p.isActive ?? true,
    parentProductId: p.parentProductId ?? "",
    variantName: p.variantName ?? "",
    parentName: p.parent?.name ?? undefined,
    trackedCategoryId: p.trackedCategory?.id ?? p.trackedCategoryId ?? "",
    trackedCategoryName: p.trackedCategory?.name,
    trackedSubcategoryId: p.trackedSubcategory?.id ?? p.trackedSubcategoryId ?? "",
    regItemType: p.regItemType ?? "",
    regUomCase: p.regUomCase ?? "",
    regUomUnit: p.regUomUnit ?? "",
  };
}

function parseOptionalNumber(v: string): number | undefined {
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export interface SubmitPayload {
  name: string;
  sku?: string;
  barcode?: string;
  unitSku?: string | null;
  category?: string;
  unit?: string;
  unitsPerBox?: number;
  description?: string;
  pricePerUnit: number;
  priceTier2?: number;
  priceTier3?: number;
  priceTier4?: number;
  priceTier5?: number;
  standardCost?: number;
  currentStock?: number;
  reorderPoint?: number;
  reorderQty?: number;
  isActive: boolean;
  parentProductId?: string;
  variantName?: string;
  trackedCategoryId?: string | null;
  trackedSubcategoryId?: string | null;
  regItemType?: string | null;
  regUomCase?: string | null;
  regUomUnit?: string | null;
}

export function buildProductPayload(
  form: ProductFormValues,
  mode: "create" | "edit" = "create",
): SubmitPayload | { error: string } {
  // Variant vs standalone: a variant stores JUST the flavor in `name` (PR #44),
  // with the parent context in `parentProductId` — the display name is composed
  // at render (displayProductName). So when a parent is picked, the flavor field
  // is what's required, not the standalone Name.
  const parentProductId = form.parentProductId.trim() || undefined;
  const variantName = form.variantName.trim();
  let name: string;
  if (parentProductId) {
    if (!variantName) return { error: "Variant name (flavor) is required." };
    name = variantName;
  } else {
    name = form.name.trim();
    if (!name) return { error: "Name is required." };
  }
  const price = parseOptionalNumber(form.pricePerUnit);
  if (price == null || price < 0) return { error: "Enter a valid price." };
  // unitsPerBox: any positive integer is allowed, but values <= 1 (or empty)
  // mean "no box packaging" — we omit the field so the API treats the product
  // as sold by piece. Floor BEFORE validating, never after: comparing the raw
  // parsed value against the guard and only flooring afterwards let a
  // fractional like "1.5" pass `upbRaw > 1` and then floor to 1 — exactly the
  // meaningless "no packaging" sentinel the guard exists to reject.
  const upbRaw = parseOptionalNumber(form.unitsPerBox);
  const upbFloored = upbRaw != null ? Math.floor(upbRaw) : undefined;
  const unitsPerBox = upbFloored != null && upbFloored > 1 ? upbFloored : undefined;
  // Regulatory reporting config lives on the product but only makes sense under a
  // regulated section. Clearing the section (trackedCategoryId blank) must clear all
  // three, even if the caller didn't already reset them in form state — mirrors the
  // trackedCategoryId/trackedSubcategoryId clear-on-blank behavior below.
  const clearedValue = mode === "edit" ? null : undefined;
  const sectionCleared = !form.trackedCategoryId.trim();
  const regTrio = (v: string) => (sectionCleared ? clearedValue : v.trim() || clearedValue);
  return {
    name,
    sku: form.sku.trim() || undefined,
    barcode: form.barcode.trim() || undefined,
    unitSku: mode === "edit" ? form.unitSku.trim() || null : form.unitSku.trim() || undefined,
    category: form.category.trim() || undefined,
    unit: form.unit.trim() || undefined,
    unitsPerBox,
    description: form.description.trim() || undefined,
    pricePerUnit: price,
    priceTier2: parseOptionalNumber(form.priceTier2),
    priceTier3: parseOptionalNumber(form.priceTier3),
    priceTier4: parseOptionalNumber(form.priceTier4),
    priceTier5: parseOptionalNumber(form.priceTier5),
    standardCost: parseOptionalNumber(form.standardCost),
    // currentStock deliberately NOT sent: it isn't on the create/update DTOs
    // (forbidNonWhitelisted → guaranteed 400) — stock moves via adjustments.
    reorderPoint: parseOptionalNumber(form.reorderPoint),
    reorderQty: parseOptionalNumber(form.reorderQty),
    isActive: form.isActive,
    parentProductId,
    variantName: parentProductId ? variantName : undefined,
    trackedCategoryId:
      mode === "edit"
        ? form.trackedCategoryId.trim() || null
        : form.trackedCategoryId.trim() || undefined,
    trackedSubcategoryId:
      mode === "edit"
        ? form.trackedSubcategoryId.trim() || null
        : form.trackedSubcategoryId.trim() || undefined,
    regItemType: regTrio(form.regItemType),
    regUomCase: regTrio(form.regUomCase),
    regUomUnit: regTrio(form.regUomUnit),
  };
}
