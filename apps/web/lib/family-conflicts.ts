import { API_ERROR_CODES } from "@routeflow/types";
import type { FamilyRowConflict, FamilyRowsConflictError } from "@routeflow/types";

/**
 * WS8: a families write (POST /products/families, PATCH /products/:id/variants) is all-or-nothing.
 * When it is refused the API lists EVERY conflicting row; this maps that list to one fixed message per
 * grid cell so the operator fixes them all in one pass. The server `message` is never carried.
 */

export type FamilyField = FamilyRowConflict["field"];

export interface FamilyCellConflict {
  message: string;
  /** The ACTIVE holder of a taken code or name, when the server named one. */
  productId?: string;
}

export type FamilyConflicts =
  | {
      kind: "ROWS";
      /** `row:field` -> message (variant rows only). */
      cells: Record<string, FamilyCellConflict>;
      /** Messages for the family container itself (its name). */
      familyMessages: string[];
      count: number;
      summary: string;
    }
  | { kind: "NOT_FOUND" }
  | { kind: "PRICE_AUTHORITY" };

export const familyCellKey = (row: number, field: FamilyField): string => `${row}:${field}`;

const CODE_NOUN: Record<string, string> = {
  sku: "SKU",
  barcode: "barcode",
  unitSku: "unit code",
};

function message(c: FamilyRowConflict): string {
  if (c.reason === "DUPLICATE_IN_REQUEST")
    return `"${c.value}" appears more than once in this list.`;
  if (c.reason === API_ERROR_CODES.NAME_TAKEN)
    return `A product named "${c.value}" already exists.`;
  if (c.reason === API_ERROR_CODES.CODE_TAKEN && CODE_NOUN[c.field]) {
    return `The ${CODE_NOUN[c.field]} "${c.value}" is already used by another product.`;
  }
  return `"${c.value}" conflicts with another product.`;
}

export function getFamilyConflicts(err: unknown): FamilyConflicts | null {
  const res = (err as { response?: { status?: number; data?: unknown } } | null)?.response;
  const data = res?.data as Partial<FamilyRowsConflictError> | { code?: unknown } | undefined;
  if (!data || typeof data !== "object") return null;
  if (data.code === API_ERROR_CODES.FAMILY_NOT_FOUND) return { kind: "NOT_FOUND" };
  if (data.code === API_ERROR_CODES.FAMILY_PRICE_AUTHORITY) return { kind: "PRICE_AUTHORITY" };
  if (data.code !== API_ERROR_CODES.FAMILY_ROWS_CONFLICT) return null;
  const rows = (data as Partial<FamilyRowsConflictError>).rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const cells: Record<string, FamilyCellConflict> = {};
  const familyMessages: string[] = [];
  for (const c of rows) {
    if (c.row === "family") {
      familyMessages.push(message(c));
    } else {
      cells[familyCellKey(c.row, c.field)] = {
        message: message(c),
        ...(c.conflictProductId ? { productId: c.conflictProductId } : {}),
      };
    }
  }
  const count = rows.length;
  return {
    kind: "ROWS",
    cells,
    familyMessages,
    count,
    summary:
      count === 1
        ? "Nothing was saved. Fix the marked field and try again."
        : `Nothing was saved. Fix the ${count} marked cells and try again.`,
  };
}
