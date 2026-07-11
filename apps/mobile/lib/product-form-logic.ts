/**
 * Pure (screen-free, testable) product-form model + payload builder. Kept out of
 * components/ProductForm.tsx (which imports React Native) so
 * apps/mobile/__tests__/*.test.ts (node env) can lock the variant vs standalone
 * branch. ProductForm.tsx re-exports these for its consumers.
 */

export interface ProductFormValues {
  name: string;
  sku: string;
  barcode: string;
  category: string;
  unit: string;
  /**
   * Loose pieces per box. Leave blank for products sold individually.
   * When set (>1), `pricePerUnit` is treated as the BOX price; loose pieces
   * are prorated as `pricePerUnit / unitsPerBox` (apps/api/src/common/pricing.ts).
   * The new-order + edit-order screens then offer the operator a Boxes +
   * Loose pieces editor instead of a single qty stepper.
   */
  unitsPerBox: string;
  description: string;
  pricePerUnit: string;
  /** Customer tier prices (tier 1 = pricePerUnit). Blank = inherit tier 1. */
  priceTier2: string;
  priceTier3: string;
  priceTier4: string;
  priceTier5: string;
  standardCost: string;
  currentStock: string;
  reorderPoint: string;
  reorderQty: string;
  isActive: boolean;
  /** Variant linking (create-only). When set, `variantName` is the flavor and
   * carries the product name; picked via the parent picker. */
  parentProductId: string;
  variantName: string;
}

export function emptyProductForm(): ProductFormValues {
  return {
    name: "",
    sku: "",
    barcode: "",
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
    category: p.category ?? "",
    unit: p.unit ?? "ea",
    unitsPerBox: p.unitsPerBox != null ? String(p.unitsPerBox) : "",
    description: p.description ?? "",
    pricePerUnit: p.pricePerUnit != null ? String(p.pricePerUnit) : "",
    // Tier columns default to 0 in the DB (= "inherit tier 1"); show those as blank.
    priceTier2: Number(p.priceTier2) > 0 ? String(p.priceTier2) : "",
    priceTier3: Number(p.priceTier3) > 0 ? String(p.priceTier3) : "",
    priceTier4: Number(p.priceTier4) > 0 ? String(p.priceTier4) : "",
    priceTier5: Number(p.priceTier5) > 0 ? String(p.priceTier5) : "",
    standardCost:
      (p.standardCost ?? p.costPerUnit) != null ? String(p.standardCost ?? p.costPerUnit) : "",
    currentStock: p.currentStock != null ? String(p.currentStock) : "",
    reorderPoint: p.reorderPoint != null ? String(p.reorderPoint) : "",
    reorderQty: p.reorderQty != null ? String(p.reorderQty) : "",
    isActive: p.isActive ?? true,
    // Variant re-linking is a create-only affordance (web handles re-parenting via
    // separate detail-screen actions). Leaving these blank on edit means the PATCH
    // never sends them, so an existing variant's parent/flavor is preserved.
    parentProductId: "",
    variantName: "",
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
}

export function buildProductPayload(form: ProductFormValues): SubmitPayload | { error: string } {
  // A variant carries the flavor/variety as its name (mirrors web), scoped-unique
  // among its parent's siblings; a standalone product uses the Name field.
  const isVariant = !!form.parentProductId.trim();
  const name = isVariant ? form.variantName.trim() : form.name.trim();
  if (!name) {
    return { error: isVariant ? "Enter a flavor / variety for the variant." : "Name is required." };
  }
  const price = parseOptionalNumber(form.pricePerUnit);
  if (price == null || price < 0) return { error: "Enter a valid price." };
  // unitsPerBox: any positive integer is allowed, but values <= 1 (or empty)
  // mean "no box packaging" — we omit the field so the API treats the product
  // as sold by piece.
  const upbRaw = parseOptionalNumber(form.unitsPerBox);
  const unitsPerBox =
    upbRaw != null && Number.isFinite(upbRaw) && upbRaw > 1 ? Math.floor(upbRaw) : undefined;
  return {
    name,
    sku: form.sku.trim() || undefined,
    barcode: form.barcode.trim() || undefined,
    category: form.category.trim() || undefined,
    unit: form.unit.trim() || undefined,
    unitsPerBox,
    description: form.description.trim() || undefined,
    pricePerUnit: price,
    // Blank tier → undefined (never 0), so a blank never overwrites tier 1.
    priceTier2: parseOptionalNumber(form.priceTier2),
    priceTier3: parseOptionalNumber(form.priceTier3),
    priceTier4: parseOptionalNumber(form.priceTier4),
    priceTier5: parseOptionalNumber(form.priceTier5),
    standardCost: parseOptionalNumber(form.standardCost),
    currentStock: parseOptionalNumber(form.currentStock),
    reorderPoint: parseOptionalNumber(form.reorderPoint),
    reorderQty: parseOptionalNumber(form.reorderQty),
    isActive: form.isActive,
    // Variant link (create-only). undefined for a standalone product → dropped
    // from the JSON body, so an edit never re-parents.
    ...(isVariant
      ? { parentProductId: form.parentProductId.trim(), variantName: form.variantName.trim() }
      : {}),
  };
}
