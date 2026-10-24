import type { FamilyRowConflict } from "@routeflow/types";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { CatalogTx } from "./product-catalog-sync";
import { findCodeHolders, type CodeField } from "./product-code-release";

/** One value a families write wants to put on a row. `row` = the variant index, or "family". */
export interface FamilyCodeInput {
  row: number | "family";
  field: CodeField;
  value: string;
  /** The existing product this value is being written onto (its own holding is not a conflict). */
  ownerId?: string;
}

export interface FamilyNameInput {
  row: number | "family";
  name: string;
  /** null = a standalone/root name; a family id = a sibling name under that family. */
  parentProductId: string | null;
  /** The product being edited (its own name is not a conflict). */
  excludeId?: string;
}

/** Namespaces that collide with each other (SA-572b legacy rules): sku~sku|unitSku, barcode~barcode|unitSku, unitSku~all. */
const sameNamespace = (a: CodeField, b: CodeField): boolean =>
  a === b || a === "unitSku" || b === "unitSku";

const clean = (v: string | undefined | null): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

/**
 * IN-REQUEST duplicates (pure): a code repeated across ALL code columns of ALL rows (respecting the namespaces above)
 * and variant names repeated case-insensitively. EVERY row that repeats is reported, not the first.
 */
export function familyGridConflicts(
  rows: ReadonlyArray<{
    row: number | "family";
    name: string;
    sku?: string;
    barcode?: string;
    unitSku?: string;
  }>,
): FamilyRowConflict[] {
  const out: FamilyRowConflict[] = [];
  const codes: Array<{ row: number | "family"; field: CodeField; value: string }> = [];
  for (const r of rows) {
    for (const field of ["sku", "barcode", "unitSku"] as const) {
      const value = clean(r[field]);
      if (value) codes.push({ row: r.row, field, value });
    }
  }
  for (const c of codes) {
    const clash = codes.some(
      (o) =>
        o !== c &&
        o.value === c.value &&
        sameNamespace(o.field, c.field) &&
        !(o.row === c.row && o.field === c.field),
    );
    if (clash)
      out.push({ row: c.row, field: c.field, value: c.value, reason: "DUPLICATE_IN_REQUEST" });
  }
  const names = rows.map((r) => ({
    row: r.row,
    raw: r.name.trim(),
    key: r.name.trim().toLowerCase(),
  }));
  for (const n of names) {
    if (names.filter((o) => o.key === n.key).length > 1) {
      out.push({ row: n.row, field: "name", value: n.raw, reason: "DUPLICATE_IN_REQUEST" });
    }
  }
  return out;
}

/**
 * The ONE DB check for codes (POST /products/families, PATCH /products/:id/variants, GET /products/sku-available):
 * ACTIVE holders of the same tenant only (retired codes and inactive owners are free, SA-603). The caller has taken the
 * code locks for a write; the advisory GET calls it without. Every conflict is returned, not the first.
 */
export async function codeTakenBy(
  tx: CatalogTx,
  tenantId: string,
  codes: readonly FamilyCodeInput[],
  opts?: { excludeProductIds?: readonly string[] },
): Promise<FamilyRowConflict[]> {
  // Only rows the SAME write deactivates (released before the claim) and the row's OWN id are excluded: a sibling that
  // merely stays in the request still holds its code until its own write, so taking it is a real conflict (Opus #2881 B3).
  const exclude = new Set(opts?.excludeProductIds ?? []);
  const out: FamilyRowConflict[] = [];
  for (const c of codes) {
    // eslint-disable-next-line no-await-in-loop -- a bounded grid, each code under the caller's lock
    const holders = await findCodeHolders(tx, tenantId, null, c.field, c.value);
    const active = holders.find((h) => h.isActive && !exclude.has(h.id) && h.id !== c.ownerId);
    if (active) {
      out.push({
        row: c.row,
        field: c.field,
        value: c.value,
        reason: API_ERROR_CODES.CODE_TAKEN,
        conflictProductId: active.id,
      });
    }
  }
  return out;
}

/** The active-only name rule (SA-603a): an ACTIVE same-name product in the same parent scope conflicts. */
export async function nameTakenBy(
  tx: CatalogTx,
  tenantId: string,
  names: readonly FamilyNameInput[],
  opts?: { excludeProductIds?: readonly string[] },
): Promise<FamilyRowConflict[]> {
  const out: FamilyRowConflict[] = [];
  const gone = [...(opts?.excludeProductIds ?? [])];
  for (const n of names) {
    // eslint-disable-next-line no-await-in-loop
    const holder: { id: string } | null = await tx.product.findFirst({
      where: {
        tenantId,
        isActive: true,
        name: { equals: n.name.trim(), mode: "insensitive" },
        parentProductId: n.parentProductId,
        ...(n.excludeId || gone.length > 0
          ? { id: { notIn: [...gone, ...(n.excludeId ? [n.excludeId] : [])] } }
          : {}),
      },
      select: { id: true },
    });
    if (holder) {
      out.push({
        row: n.row,
        field: "name",
        value: n.name,
        reason: API_ERROR_CODES.NAME_TAKEN,
        conflictProductId: holder.id,
      });
    }
  }
  return out;
}
