import { displayProductName } from "@/lib/product-display";
import { isFamilyProduct } from "@/lib/product-search-groups";
import { emptyPOLine, type POLineItem } from "./purchase-orders-shared";

/** What a whole-catalog read tells us about a product that the stock overview does not. */
export interface CatalogMeta {
  kind?: string | null;
  parentProductId?: string | null;
}

/** id -> parent/kind, from `GET /products?includeVariants=true` rows (top-level rows and nested variants). */
export function catalogMetaById(rows: readonly any[]): Map<string, CatalogMeta> {
  const out = new Map<string, CatalogMeta>();
  for (const r of rows) {
    out.set(r.id, { kind: r.kind ?? null, parentProductId: r.parentProductId ?? null });
    for (const v of r.variants ?? []) {
      if (!out.has(v.id)) out.set(v.id, { kind: v.kind ?? null, parentProductId: r.id });
    }
  }
  return out;
}

export interface POSelectProduct {
  id: string;
  name: string;
  sku?: string;
}

/**
 * The product select's options: a family is dropped (never addable), a variant reads
 * "<Family> - <Variant>" through the one `displayProductName`, and the list sorts by that full name.
 */
export function poSelectOptions(
  products: readonly POSelectProduct[],
  meta: ReadonlyMap<string, CatalogMeta>,
): { id: string; label: string }[] {
  return products
    .filter((p) => !isFamilyProduct(meta.get(p.id)))
    .map((p) => ({
      id: p.id,
      label:
        displayProductName(
          { name: p.name, parentProductId: meta.get(p.id)?.parentProductId ?? null },
          products,
        ) + (p.sku ? ` (${p.sku})` : ""),
    }))
    .sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }),
    );
}

const isBlank = (l: POLineItem) => !l.productId && !l.qty && !l.unitCost && !l.boxes && !l.pieces;

/**
 * One scan or pick: a product already on a line gains ONE entry unit (a box for a boxed product, a piece
 * otherwise); a new product fills the first empty row, else a new row. Never adds a family.
 */
export function addEntryUnit(
  lines: POLineItem[],
  product: { id: string; kind?: string | null },
  unitsPerBox: number,
): { lines: POLineItem[]; created: boolean } {
  if (isFamilyProduct(product)) return { lines, created: false };
  const boxed = unitsPerBox > 1;
  const bump = (l: POLineItem): POLineItem =>
    boxed
      ? { ...l, boxes: String((Math.trunc(Number(l.boxes)) || 0) + 1) }
      : { ...l, qty: String(Math.round(((Number(l.qty) || 0) + 1) * 1000) / 1000) };
  const at = lines.findIndex((l) => l.productId === product.id);
  if (at >= 0) return { lines: lines.map((l, i) => (i === at ? bump(l) : l)), created: false };
  const fresh = bump({ ...emptyPOLine(), productId: product.id });
  const blank = lines.findIndex(isBlank);
  return {
    lines: blank >= 0 ? lines.map((l, i) => (i === blank ? fresh : l)) : [...lines, fresh],
    created: true,
  };
}
