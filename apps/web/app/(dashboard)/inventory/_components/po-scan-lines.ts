import { normalizeBoxesPieces, type SellLevel } from "@routeflow/pricing";
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

/**
 * A product row handed to Create purchase order. `kind` and `parentProductId` are present when the
 * caller's list already carries the family facts (the Inventory page's stock overview, W-1299).
 */
export interface POProductRow {
  id: string;
  name: string;
  sku?: string;
  unitsPerBox?: number | null;
  kind?: string | null;
  parentProductId?: string | null;
}

/**
 * True when EVERY row says its kind, so the rows alone answer "is this a family" and "whose variant is
 * this" and no catalog read is needed. One row without it (an older API, or a caller that does not send
 * it) means the answer is not known: the caller must read the catalog and fail closed until it arrives.
 */
export function rowsCarryCatalogMeta(rows: readonly POProductRow[]): boolean {
  return rows.every((r) => typeof r.kind === "string");
}

/** id -> parent/kind, from rows that carry them (see `rowsCarryCatalogMeta`). */
export function rowMetaById(rows: readonly POProductRow[]): Map<string, CatalogMeta> {
  return new Map(
    rows.map((r) => [r.id, { kind: r.kind ?? null, parentProductId: r.parentProductId ?? null }]),
  );
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
 * One scan or pick adds ONE unit of the level it is given (SA-1218): a BOX code adds a box; a UNIT code on a
 * boxed product adds a piece, rolled into boxes by `normalizeBoxesPieces`; an unboxed product always gains 1 in
 * Quantity. No level (a name pick) adds the entry unit. A product already on a line gains on that line; a new
 * product fills the first empty row, else a new row. Never adds a family.
 */
export function addEntryUnit(
  lines: POLineItem[],
  product: { id: string; kind?: string | null },
  unitsPerBox: number,
  level?: SellLevel,
): { lines: POLineItem[]; created: boolean } {
  if (isFamilyProduct(product)) return { lines, created: false };
  const boxed = unitsPerBox > 1;
  const bump = (l: POLineItem): POLineItem => {
    if (!boxed) return { ...l, qty: String(Math.round(((Number(l.qty) || 0) + 1) * 1000) / 1000) };
    const boxes = Math.trunc(Number(l.boxes)) || 0;
    const pieces = Math.trunc(Number(l.pieces)) || 0;
    if (level !== "UNIT") return { ...l, boxes: String(boxes + 1) };
    const split = normalizeBoxesPieces({ boxes, pieces: pieces + 1, unitsPerBox });
    return { ...l, boxes: String(split.boxes ?? 0), pieces: String(split.pieces ?? 0) };
  };
  const at = lines.findIndex((l) => l.productId === product.id);
  if (at >= 0) return { lines: lines.map((l, i) => (i === at ? bump(l) : l)), created: false };
  const fresh = bump({ ...emptyPOLine(), productId: product.id });
  const blank = lines.findIndex(isBlank);
  return {
    lines: blank >= 0 ? lines.map((l, i) => (i === blank ? fresh : l)) : [...lines, fresh],
    created: true,
  };
}
