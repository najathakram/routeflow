import type { ProductKind } from "@routeflow/types";

/**
 * A FAMILY is a non-stocked, non-sellable container (WS8): ordering one is a 400 FAMILY_NOT_SELLABLE. Web's
 * CreateOrderModal never adds the container: a parent with variants only expands, and the nested variants are the
 * sellable rows. This is the same rule for mobile's flat picker list: a family is replaced by its (active) variants,
 * a variant or plain product passes through untouched, and nothing is listed twice.
 */
export interface CatalogProductLike {
  id: string;
  name: string;
  kind?: ProductKind | null;
  parentProductId?: string | null;
  parent?: { id: string; name: string } | null;
  variants?: CatalogProductLike[] | null;
}

export function sellableCatalogRows<T extends CatalogProductLike>(rows: readonly T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  const push = (r: T) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push(r);
  };
  for (const row of rows) {
    if (row.kind === "FAMILY") {
      for (const v of row.variants ?? []) {
        // Variant names are stored bare ("Grape"); the parent lets the row compose "<Parent> - <Variant>".
        push({ ...v, parent: v.parent ?? { id: row.id, name: row.name } } as T);
      }
      continue;
    }
    push(row);
  }
  return out;
}
