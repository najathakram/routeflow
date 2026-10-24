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

/** Fixed copy shown when a family container is refused at an add point. */
export const FAMILY_ADD_MESSAGE = "Pick a variant. A product family can't be ordered.";

/** A FAMILY container is never an orderable line: the cart-add choke point and resumed drafts refuse it. */
export function isFamilyProduct(p: { kind?: ProductKind | null } | null | undefined): boolean {
  return p?.kind === "FAMILY";
}

export function sellableCatalogRows<T extends CatalogProductLike>(rows: readonly T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  // The same variant can arrive twice: as an outer (top-level) row, which carries thumbnailUrl + barcodes, and nested
  // inside its family's `variants`. The outer row wins; the nested copy only lends its family as `parent`.
  const outerById = new Map<string, T>();
  const familyOf = new Map<string, { id: string; name: string }>();
  for (const row of rows) {
    if (row.kind === "FAMILY") {
      for (const v of row.variants ?? []) familyOf.set(v.id, { id: row.id, name: row.name });
    } else {
      outerById.set(row.id, row);
    }
  }
  const push = (r: T) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push(r);
  };
  for (const row of rows) {
    if (row.kind === "FAMILY") {
      for (const v of row.variants ?? []) {
        // Variant names are stored bare ("Grape"); the parent lets the row compose "<Parent> - <Variant>".
        const parent = { id: row.id, name: row.name };
        const outer = outerById.get(v.id);
        push(
          outer
            ? ({ ...outer, parent: outer.parent ?? v.parent ?? parent } as T)
            : ({ ...v, parent: v.parent ?? parent } as T),
        );
      }
      continue;
    }
    const fam = familyOf.get(row.id);
    push(fam && !row.parent ? ({ ...row, parent: fam } as T) : row);
  }
  return out;
}
