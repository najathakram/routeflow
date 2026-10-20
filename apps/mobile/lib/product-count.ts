import {
  ADJUSTMENT_REASON_NOTE_MAX,
  ADJUSTMENT_REASON_NOTE_MIN,
  type AdjustmentReason,
  type ProductCountRequest,
} from "@routeflow/types";

/**
 * SA-828 (row 657): the pure logic behind the product page's "Count / Adjust" (web + mobile carry the
 * SAME module; `apps/web/lib/product-count.ts` is the twin of this file). The server resolves a unit's
 * factor from the ladder and re-validates everything; the client only PREVIEWS the resulting count
 * and refuses the obvious mistakes before a round trip.
 */

export interface CountUnitOption {
  /** The ladder label sent to the server ("Case", "Piece"). */
  label: string;
  /** Pieces per ONE of this unit. */
  factor: number;
}

export type CountMode = "SET" | "ADJUST";

export interface CountForm {
  mode: CountMode;
  /** Only read for ADJUST. */
  sign: "+" | "-";
  /** The raw input text. */
  quantity: string;
  /** A `CountUnitOption.label`. */
  unit: string;
  reason: AdjustmentReason | "";
  note: string;
  /** "YYYY-MM-DD"; "" = today (nothing is sent). */
  date: string;
}

/** The units a user can count in: the ladder when there is one, else the pack and pieces. */
export function countUnitOptions(
  product: { unit?: string | null; unitsPerBox?: number | null },
  ladder?: { label: string; factorToBase: number }[] | null,
): CountUnitOption[] {
  if (ladder && ladder.length > 0)
    return ladder.map((l) => ({ label: l.label, factor: Number(l.factorToBase) }));
  const upb = Number(product.unitsPerBox ?? 0);
  if (upb > 1) return [{ label: product.unit?.trim() || "Box", factor: upb }, pieceOption()];
  return [pieceOption()];
}

function pieceOption(): CountUnitOption {
  return { label: "Piece", factor: 1 };
}

/** Pieces in `quantity` of a unit (rounded to kill float noise). */
export function previewPieces(quantity: number, factor: number): number {
  return Math.round(quantity * factor * 1e6) / 1e6;
}

const pcs = (n: number) => `${n.toLocaleString("en-US")} pcs`;

/** The stock the count would leave, or null while the form has no usable quantity. */
export function resultingStock(
  form: Pick<CountForm, "mode" | "sign" | "quantity" | "unit">,
  options: CountUnitOption[],
  currentStock: number,
): number | null {
  const qty = parseQuantity(form.quantity);
  const opt = options.find((o) => o.label === form.unit);
  if (qty === null || !opt) return null;
  const pieces = previewPieces(qty, opt.factor);
  if (form.mode === "SET") return pieces;
  return previewPieces(form.sign === "-" ? currentStock - pieces : currentStock + pieces, 1);
}

/** "Stock will be 36 pcs (was 10)" / "Stock will be 10 − 12 = -2 pcs"; null when there is nothing to show. */
export function previewLine(
  form: Pick<CountForm, "mode" | "sign" | "quantity" | "unit">,
  options: CountUnitOption[],
  currentStock: number,
): string | null {
  const after = resultingStock(form, options, currentStock);
  if (after === null) return null;
  if (form.mode === "SET")
    return `Stock will be ${pcs(after)} (was ${currentStock.toLocaleString("en-US")})`;
  const opt = options.find((o) => o.label === form.unit) as CountUnitOption;
  const pieces = previewPieces(parseQuantity(form.quantity) as number, opt.factor);
  const op = form.sign === "-" ? "−" : "+";
  return `Stock will be ${currentStock.toLocaleString("en-US")} ${op} ${pieces.toLocaleString("en-US")} = ${pcs(after)}`;
}

function parseQuantity(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The first thing wrong with the form (shown inline), or null when it can be saved. */
export function validateCount(form: CountForm, options: CountUnitOption[]): string | null {
  const qty = parseQuantity(form.quantity);
  const opt = options.find((o) => o.label === form.unit);
  if (qty === null) return "Enter a quantity.";
  if (!opt) return "Pick a unit.";
  if (qty < 0) return "Enter zero or more. Use Adjust to take stock off.";
  if (form.mode === "ADJUST" && qty === 0) return "Enter a quantity above zero.";
  if (opt.factor > 1 && !Number.isInteger(qty))
    return `Count whole ${opt.label.toLowerCase()}s, or switch to pieces.`;
  if (!form.reason) return "Pick a reason.";
  if (form.reason === "OTHER") {
    const n = form.note.trim().length;
    if (n < ADJUSTMENT_REASON_NOTE_MIN || n > ADJUSTMENT_REASON_NOTE_MAX)
      return `Add a note of ${ADJUSTMENT_REASON_NOTE_MIN} to ${ADJUSTMENT_REASON_NOTE_MAX} characters.`;
  }
  return null;
}

/** The request body. Call only when `validateCount` returned null. */
export function buildCountRequest(form: CountForm): ProductCountRequest {
  const quantity = Number(form.quantity.trim());
  const note = form.note.trim();
  const extra = {
    reason: form.reason as AdjustmentReason,
    ...(note ? { reasonNote: note } : {}),
    ...(form.date ? { effectiveDate: form.date } : {}),
  };
  return form.mode === "SET"
    ? { mode: "SET", count: { unit: form.unit, quantity }, ...extra }
    : { mode: "ADJUST", delta: { unit: form.unit, quantity, sign: form.sign }, ...extra };
}

/** Today as "YYYY-MM-DD" (local), the date picker's max. */
export function todayISO(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
