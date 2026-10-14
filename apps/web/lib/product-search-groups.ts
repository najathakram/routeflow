import { displayProductName } from "@/lib/product-display";

/**
 * Shared shaping for product PICKERS (order / invoice / estimate search dropdowns).
 *
 * `GET /products?search=…&includeVariants=true` answers with FLAT rows: every product whose own
 * fields match. A parent that matches carries ALL its active variants nested; a variant that
 * matches on its own flavor is a top-level row (with `parentProductId` + a light `parent`) and its
 * parent is absent unless it matched too. A picker that only keeps rows without `parentProductId`
 * therefore shows "No products found" for a flavor-only search (B1215 C6), and a FAMILY (a
 * non-sellable container) must never be added as a line itself (C7).
 */
export interface PickerRow {
  id: string;
  name: string;
  /** STANDARD | FAMILY | VARIANT | RECIPE. */
  kind?: string | null;
  parentProductId?: string | null;
  variantName?: string | null;
  parent?: { id?: string; name: string; kind?: string | null } | null;
  variants?: PickerRow[];
}

/** A FAMILY is a container: it may head an expandable group but is never itself a line. */
export function isFamilyProduct(p: { kind?: string | null } | null | undefined): boolean {
  return p?.kind === "FAMILY";
}

/** Every row that may become a line: a FAMILY never does. */
export function sellableOnly<T extends { kind?: string | null }>(rows: readonly T[]): T[] {
  return rows.filter((p) => !isFamilyProduct(p));
}

/**
 * Top-level picker rows for a flat search result.
 *  - a variant row whose parent is NOT in the result gets its parent re-attached (built from the
 *    row's own `parent`), carrying the matching variants, and is returned in `expandedIds` so the
 *    variant is selectable at once;
 *  - a variant row whose parent IS in the result is folded into it (added when the parent's nested
 *    list lacks it);
 *  - a FAMILY with no variant to show is dropped (nothing under it can be picked);
 *  - a variant that carries no parent info at all stays a plain selectable row.
 */
export function groupSearchRows<T extends PickerRow>(
  rows: readonly T[],
): { rows: T[]; expandedIds: Set<string> } {
  const expandedIds = new Set<string>();
  const topLevel: T[] = [];
  const byId = new Map<string, T>();
  for (const r of rows) {
    if (!r.parentProductId) {
      const copy = { ...r, variants: r.variants ? [...r.variants] : r.variants } as T;
      topLevel.push(copy);
      byId.set(copy.id, copy);
    }
  }
  const out: T[] = [...topLevel];
  for (const r of rows) {
    const parentId = r.parentProductId;
    if (!parentId) continue;
    let parent = byId.get(parentId);
    if (!parent) {
      if (!r.parent?.name) {
        out.push(r); // no parent context: still selectable on its own
        continue;
      }
      parent = {
        id: parentId,
        name: r.parent.name,
        // Keep the parent's real kind; only a parent whose kind is unknown is assumed a FAMILY.
        kind: r.parent.kind ?? "FAMILY",
        parentProductId: null,
        isActive: true,
        variants: [],
      } as unknown as T;
      byId.set(parentId, parent);
      out.push(parent);
      expandedIds.add(parentId);
    } else if (!parent.variants?.some((v) => v.id === r.id)) {
      expandedIds.add(parentId);
    }
    if (!parent.variants?.some((v) => v.id === r.id)) {
      (parent as PickerRow).variants = [...(parent.variants ?? []), r];
    }
  }
  return {
    rows: out.filter((p) => !(isFamilyProduct(p) && !(p.variants && p.variants.length > 0))),
    expandedIds,
  };
}

/**
 * Is this group open? An operator's own toggle (`toggled` = the id they last opened, or "" for
 * "closed it") wins; with no toggle yet, a group the search re-attached for a variant hit is open.
 */
export function isGroupExpanded(
  toggled: string | null,
  autoExpandedIds: ReadonlySet<string>,
  id: string,
): boolean {
  return toggled === null ? autoExpandedIds.has(id) : toggled === id;
}

/** Picker label for any row: "<Parent> - <Variant>" for a variant, the plain name otherwise. */
export function pickerProductName(p: PickerRow, parent?: PickerRow | null): string {
  return displayProductName(p, parent ? [parent] : undefined);
}

/**
 * A variant nested under its parent's row carries no `parent` of its own: give it one before it is
 * picked, so the line it becomes is named "<Parent> - <Variant>" (displayProductName).
 */
export function attachParent<T extends PickerRow>(
  variant: T,
  parent: { id?: string; name: string },
): T {
  return variant.parent ? variant : { ...variant, parent: { id: parent.id, name: parent.name } };
}

/**
 * A FLAT list of everything a search result lets the operator add (typeahead / "first match"
 * paths that have no expandable group): variants (nested or top-level, named under their parent)
 * and standalones, de-duplicated; a FAMILY itself is never in it (B1215 C7).
 */
export function sellableFlat<T extends PickerRow>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  const push = (p: T) => {
    if (seen.has(p.id) || isFamilyProduct(p)) return;
    seen.add(p.id);
    out.push(p);
  };
  for (const r of rows) {
    if (isFamilyProduct(r)) {
      for (const v of r.variants ?? []) push(attachParent(v as T, r));
    } else {
      push(r);
    }
  }
  return out;
}

/** What Enter does on a grouped picker's first shown row (row 503, SA must). */
export type GroupEnterAction<T> =
  { kind: "add"; product: T } | { kind: "expand"; id: string } | { kind: "none" };

/**
 * Row 503: Enter does what a click on the first shown row does, never adds a product the operator cannot
 * see. A standalone row, and a non-family parent with variants (#3323), add themselves. A FAMILY row
 * EXPANDS (as a click does), except that a family with exactly one sellable variant adds it; once the
 * family is open, Enter adds the highlighted visible variant (the first by default).
 */
export function groupEnterAction<T extends PickerRow>(
  first: T | undefined,
  expanded: boolean,
  highlight = 0,
): GroupEnterAction<T> {
  if (!first) return { kind: "none" };
  if (!isFamilyProduct(first)) return { kind: "add", product: first };
  const variants = (first.variants ?? []) as T[];
  if (variants.length === 0) return { kind: "none" };
  if (variants.length === 1) return { kind: "add", product: attachParent(variants[0], first) };
  if (!expanded) return { kind: "expand", id: first.id };
  const i = Math.min(Math.max(highlight, 0), variants.length - 1);
  return { kind: "add", product: attachParent(variants[i], first) };
}

/** Every product a grouped list offers, in display order (each sellable row, then its variants). */
export function groupOffered<T extends PickerRow>(rows: readonly T[]): T[] {
  const out: T[] = [];
  for (const r of rows) {
    if (!isFamilyProduct(r)) out.push(r);
    for (const v of r.variants ?? []) out.push(attachParent(v as T, r));
  }
  return out;
}
