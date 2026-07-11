/**
 * Pure product-form logic — no React/React-Native imports, so it can be unit
 * tested directly (mobile Jest is pure-logic only) and reused by both the full
 * ProductForm screen and the compact InlineCreateProductSheet.
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
   */
  unitsPerBox: string;
  description: string;
  pricePerUnit: string;
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
    standardCost: "",
    currentStock: "",
    reorderPoint: "",
    reorderQty: "",
    isActive: true,
    parentProductId: "",
    variantName: "",
    parentName: undefined,
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
    standardCost:
      (p.standardCost ?? p.costPerUnit) != null ? String(p.standardCost ?? p.costPerUnit) : "",
    currentStock: p.currentStock != null ? String(p.currentStock) : "",
    reorderPoint: p.reorderPoint != null ? String(p.reorderPoint) : "",
    reorderQty: p.reorderQty != null ? String(p.reorderQty) : "",
    isActive: p.isActive ?? true,
    parentProductId: p.parentProductId ?? "",
    variantName: p.variantName ?? "",
    parentName: p.parent?.name ?? undefined,
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
  standardCost?: number;
  currentStock?: number;
  reorderPoint?: number;
  reorderQty?: number;
  isActive: boolean;
  parentProductId?: string;
  variantName?: string;
}

export function buildProductPayload(form: ProductFormValues): SubmitPayload | { error: string } {
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
    standardCost: parseOptionalNumber(form.standardCost),
    currentStock: parseOptionalNumber(form.currentStock),
    reorderPoint: parseOptionalNumber(form.reorderPoint),
    reorderQty: parseOptionalNumber(form.reorderQty),
    isActive: form.isActive,
    parentProductId,
    variantName: parentProductId ? variantName : undefined,
  };
}
