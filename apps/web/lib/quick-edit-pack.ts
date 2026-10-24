import type { ProductPackAtOpen } from "@routeflow/types";
import { expectedPackFor } from "./product-edit-unit";

/** Shown (plain copy) when a Quick Edit "Pieces per box" cell is not a whole number of 1 or more. */
export const PACK_SIZE_INVALID_MESSAGE = "Pieces per box must be a whole number of 1 or more.";

/**
 * The size a Quick Edit cell holds, as the API's integer (`@IsInt` + `@Min(1)`): blank = no pack size (`null`,
 * unboxed). Only plain ASCII digits with a value of 1 or more count; "abc", "12abc", "1.5", "0" and "-3" are
 * `invalid` — never coerced (parseInt turned "abc" into an unbox and "12abc" into 12).
 */
const packSizeOf = (raw: string): { ok: true; size: number | null } | { ok: false } => {
  const t = raw.trim();
  if (!t) return { ok: true, size: null };
  if (!/^\d+$/.test(t)) return { ok: false };
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 1 ? { ok: true, size: n } : { ok: false };
};

/**
 * SA-797a: a Quick Edit "Pieces per box" commit. Each patch carries the expected pack it was computed from, so
 * the server compares it with the row under its lock (a stale cell is a 409 PRODUCT_PACK_STALE, never a silent
 * revert), and the size is a number. `undo` restores the old size against the POST-save pack; `redo`
 * re-applies the new size against the pre-save pack (the same patch as `save`). An invalid cell returns
 * `{ ok: false, message }`: the caller sends NO patch and keeps the cell open.
 */
export function quickPackEdit(
  row: ProductPackAtOpen,
  raw: string,
):
  | {
      ok: true;
      save: Record<string, unknown>;
      undo: Record<string, unknown>;
      redo: Record<string, unknown>;
    }
  | { ok: false; message: string } {
  const before = row.unitsPerBox ?? null;
  const parsed = packSizeOf(raw);
  if (!parsed.ok) return { ok: false, message: PACK_SIZE_INVALID_MESSAGE };
  const after = parsed.size;
  const save = { unitsPerBox: after, ...expectedPackFor({ unitsPerBox: after }, row) };
  const undo = {
    unitsPerBox: before,
    ...expectedPackFor({ unitsPerBox: before }, { ...row, unitsPerBox: after }),
  };
  return { ok: true, save, undo, redo: save };
}
