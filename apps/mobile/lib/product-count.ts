import { buildLadderOptions, type LadderProduct } from "@routeflow/pricing";
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
  /** What the picker shows ("jug", "Case", "Piece"). */
  label: string;
  /** Pieces per ONE of this unit. */
  factor: number;
  /** The option's identity and request value: "" = the pack (sent as `unit: null`), else the ladder label. */
  value: string;
}

export const COUNT_WHOLE_NUMBER_COPY = "Use a whole number, or switch to pcs.";

export type CountMode = "SET" | "ADJUST";

export interface CountForm {
  mode: CountMode;
  /** Only read for ADJUST. */
  sign: "+" | "-";
  /** The raw input text. */
  quantity: string;
  /** A `CountUnitOption.value`. */
  unit: string;
  reason: AdjustmentReason | "";
  note: string;
  /** "YYYY-MM-DD"; "" = today (nothing is sent). */
  date: string;
}

/** A ladder row as the count picker needs it (prices are irrelevant to a count). */
export interface CountLadderRow {
  label: string;
  factorToBase: number;
}

/**
 * The units a user can count in, from THE shared order-entry builder: the pack first (`value: ""`),
 * the ladder levels largest to smallest (a row named like the pack is shadowed), then Piece.
 */
export function countUnitOptions(
  product: Partial<LadderProduct>,
  ladder?: CountLadderRow[] | null,
): CountUnitOption[] {
  const units = (ladder ?? []).map((l) => ({
    label: l.label,
    factorToBase: Number(l.factorToBase),
    price: null,
    priceTier2: null,
    priceTier3: null,
    priceTier4: null,
    priceTier5: null,
  }));
  const options: CountUnitOption[] = buildLadderOptions(
    { pricePerUnit: 0, ...product },
    units,
    1,
  ).map((o) => ({
    label: o.label,
    factor: o.kind === "pack" && o.factorToBase <= 1 ? 1 : o.factorToBase,
    value: o.value,
  }));
  // A boxed product with no ladder rows can still be counted in pieces.
  const upb = Number(product.unitsPerBox ?? 0);
  if (upb > 1 && !options.some((o) => o.factor === 1)) {
    options.push({
      label: product.baseUnitLabel?.trim() || "Piece",
      factor: 1,
      value: product.baseUnitLabel?.trim() || "Piece",
    });
  }
  return options;
}

/** Pieces in `quantity` of a unit (rounded to kill float noise). */
export function previewPieces(quantity: number, factor: number): number {
  return Math.round(quantity * factor * 1e6) / 1e6;
}

/** A stock number for display: thousands separators and a true minus sign (U+2212) for negatives. */
export function formatStockQty(n: number): string {
  const body = Math.abs(n).toLocaleString("en-US");
  return n < 0 ? `\u2212${body}` : body;
}

const pcs = (n: number) => `${formatStockQty(n)} pcs`;

/** The unit as shown in text: the factor-1 "Piece" reads "pcs" (the request still sends the label). */
export function unitDisplayLabel(opt: CountUnitOption): string {
  return opt.factor === 1 && opt.label === "Piece" ? "pcs" : opt.label;
}

/** The stock the count would leave, or null while the form has no usable quantity. */
export function resultingStock(
  form: Pick<CountForm, "mode" | "sign" | "quantity" | "unit">,
  options: CountUnitOption[],
  currentStock: number,
): number | null {
  const qty = parseQuantity(form.quantity);
  const opt = options.find((o) => o.value === form.unit);
  if (qty === null || !opt) return null;
  const pieces = previewPieces(qty, opt.factor);
  if (form.mode === "SET") return pieces;
  return previewPieces(form.sign === "-" ? currentStock - pieces : currentStock + pieces, 1);
}

/** "Stock will be 36 pcs (was 10)" / "Stock will be 10 − 12 = −2 pcs"; null when there is nothing to show. */
export function previewLine(
  form: Pick<CountForm, "mode" | "sign" | "quantity" | "unit">,
  options: CountUnitOption[],
  currentStock: number,
): string | null {
  const after = resultingStock(form, options, currentStock);
  if (after === null) return null;
  if (form.mode === "SET")
    return `Stock will be ${pcs(after)} (was ${formatStockQty(currentStock)})`;
  const opt = options.find((o) => o.value === form.unit) as CountUnitOption;
  const pieces = previewPieces(parseQuantity(form.quantity) as number, opt.factor);
  const op = form.sign === "-" ? "−" : "+";
  return `Stock will be ${formatStockQty(currentStock)} ${op} ${formatStockQty(pieces)} = ${pcs(after)}`;
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
  const opt = options.find((o) => o.value === form.unit);
  if (qty === null) return "Enter a quantity.";
  if (!opt) return "Pick a unit.";
  if (qty < 0) return "Enter zero or more. Use Adjust to take stock off.";
  if (form.mode === "ADJUST" && qty === 0) return "Enter a quantity above zero.";
  if (opt.factor > 1 && !Number.isInteger(qty)) return COUNT_WHOLE_NUMBER_COPY;
  if (!form.reason) return "Pick a reason.";
  if (form.reason === "OTHER") {
    const n = form.note.trim().length;
    if (n < ADJUSTMENT_REASON_NOTE_MIN || n > ADJUSTMENT_REASON_NOTE_MAX)
      return "Add a note for Other.";
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
  // The pack is `unit: null` (the server's own pack label); any other option sends its ladder label.
  const unit = form.unit === "" ? null : form.unit;
  return form.mode === "SET"
    ? { mode: "SET", count: { unit, quantity }, ...extra }
    : { mode: "ADJUST", delta: { unit, quantity, sign: form.sign }, ...extra };
}

/** Today as "YYYY-MM-DD" (local), the date picker's max. */
export function todayISO(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
