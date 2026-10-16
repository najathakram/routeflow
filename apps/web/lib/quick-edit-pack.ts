import type { ProductPackAtOpen } from "@routeflow/types";
import { expectedPackFor } from "./product-edit-unit";

/** The size a Quick Edit cell holds, as the API's integer (`@IsInt`): blank = no pack size (null). */
const packSizeOf = (raw: string): number | null => {
  const t = raw.trim();
  if (!t) return null;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
};

/**
 * SA-797a: a Quick Edit "Pieces per box" commit. Each patch carries the expected pack it was computed from, so
 * the server compares it with the row under its lock (a stale cell is a 409 PRODUCT_PACK_STALE, never a silent
 * revert), and the size is a number. `undo` restores the old size against the POST-save pack; `redo`
 * re-applies the new size against the pre-save pack (the same patch as `save`).
 */
export function quickPackEdit(
  row: ProductPackAtOpen,
  raw: string,
): {
  save: Record<string, unknown>;
  undo: Record<string, unknown>;
  redo: Record<string, unknown>;
} {
  const before = row.unitsPerBox ?? null;
  const after = packSizeOf(raw);
  const save = { unitsPerBox: after, ...expectedPackFor({ unitsPerBox: after }, row) };
  const undo = {
    unitsPerBox: before,
    ...expectedPackFor({ unitsPerBox: before }, { ...row, unitsPerBox: after }),
  };
  return { save, undo, redo: save };
}
