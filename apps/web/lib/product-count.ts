import {
  buildLadderOptions,
  countFactorOf,
  countPieces,
  pluralize,
  type LadderProduct,
} from "@routeflow/pricing";
import {
  ADJUSTMENT_REASON_NOTE_MAX,
  ADJUSTMENT_REASON_NOTE_MIN,
  type AdjustmentReason,
  type ProductCountRequest,
} from "@routeflow/types";

/**
 * SA-828 (row 657) + SA-957 / SA-958: the pure logic behind the product page's "Count / Adjust". The
 * form is one quantity row per unit the product offers (blank = 0); the request carries the non-blank
 * rows as `parts`. The server resolves every factor from the ladder and re-validates everything; the
 * client only PREVIEWS the resulting count (with @routeflow/pricing's `countFactorOf` / `countPieces`,
 * the same two the API's `piecesOf` uses) and refuses the obvious mistakes before a round trip.
 */

export interface CountUnitOption {
  /** What the row shows ("jug", "Case", "Piece"). */
  label: string;
  /** Pieces per ONE of this unit. */
  factor: number;
  /** The option's identity and request value: "" = the pack (sent as `unit: null`), else the ladder label. */
  value: string;
}

/** The server's COUNT_FRACTIONAL_PACK, which does not say which row; the form names the row itself. */
export const COUNT_WHOLE_NUMBER_COPY =
  "Count whole numbers, or count the rest in the smallest unit.";

export type CountMode = "SET" | "ADJUST";

export interface CountForm {
  mode: CountMode;
  /** Only read for ADJUST: one direction for the whole delta. */
  sign: "+" | "-";
  /** The raw input text per row, keyed by `CountUnitOption.value`. A missing or blank row is 0 and is not sent. */
  quantities: Record<string, string>;
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
    factor: countFactorOf(o),
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

/** A stock number for display: thousands separators and a true minus sign (U+2212) for negatives. */
export function formatStockQty(n: number): string {
  const body = Math.abs(n).toLocaleString("en-US");
  return n < 0 ? `\u2212${body}` : body;
}

/** The word a total is counted in: the factor-1 row's label ("bag", "Piece"), else "Piece". */
export function baseWord(options: CountUnitOption[]): string {
  return options.find((o) => o.factor === 1)?.label || "Piece";
}

/** "10 bags", "1 Piece", "−8 Pieces": a number with the base word, pluralised unless it is exactly one. */
export function stockWithWord(n: number, options: CountUnitOption[]): string {
  const word = baseWord(options);
  return `${formatStockQty(n)} ${Math.abs(n) === 1 ? word : pluralize(word)}`;
}

function parseQuantity(text: string | undefined): number | null {
  const t = (text ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The rows with a usable number, in the options' order (zero included; blank and unparsable are not parts). */
export function countParts(
  form: Pick<CountForm, "quantities">,
  options: CountUnitOption[],
): Array<{ option: CountUnitOption; quantity: number }> {
  return options.flatMap((option) => {
    const quantity = parseQuantity(form.quantities[option.value]);
    return quantity === null ? [] : [{ option, quantity }];
  });
}

const piecesOfParts = (parts: Array<{ option: CountUnitOption; quantity: number }>) =>
  countPieces(parts.map((p) => ({ quantity: p.quantity, factor: p.option.factor })));

/** The stock the count would leave, or null while no row has a usable number. */
export function resultingStock(
  form: Pick<CountForm, "mode" | "sign" | "quantities">,
  options: CountUnitOption[],
  currentStock: number,
): number | null {
  const parts = countParts(form, options);
  if (parts.length === 0) return null;
  const pieces = piecesOfParts(parts);
  if (form.mode === "SET") return pieces;
  return countPieces([
    { quantity: form.sign === "-" ? currentStock - pieces : currentStock + pieces, factor: 1 },
  ]);
}

/**
 * The preview, one string per line. With two or more non-zero rows the parts come first, the same shape as
 * the movement note ("3 Case (×24) + 4 jug (×12) = 120 Pieces"); then the stock it leaves
 * ("Stock will be 120 Pieces (was 88)" / "Stock will be 88 − 48 = 40 Pieces"). Empty while nothing is typed.
 */
export function previewLines(
  form: Pick<CountForm, "mode" | "sign" | "quantities">,
  options: CountUnitOption[],
  currentStock: number,
): string[] {
  const after = resultingStock(form, options, currentStock);
  if (after === null) return [];
  const parts = countParts(form, options);
  const pieces = piecesOfParts(parts);
  const lines: string[] = [];
  const nonZero = parts.filter((p) => p.quantity !== 0);
  if (nonZero.length >= 2) {
    const each = nonZero
      .map((p) => `${p.quantity} ${p.option.label} (\u00d7${p.option.factor})`)
      .join(" + ");
    lines.push(`${each} = ${stockWithWord(pieces, options)}`);
  }
  lines.push(
    form.mode === "SET"
      ? `Stock will be ${stockWithWord(after, options)} (was ${formatStockQty(currentStock)})`
      : `Stock will be ${formatStockQty(currentStock)} ${form.sign === "-" ? "\u2212" : "+"} ${formatStockQty(pieces)} = ${stockWithWord(after, options)}`,
  );
  return lines;
}

/** Why one row's text cannot be counted (shown under that row), or null. Blank is fine: it is 0. */
export function rowProblem(
  option: CountUnitOption,
  text: string,
  options: CountUnitOption[],
): string | null {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return "Enter a number.";
  if (n < 0) return "Enter zero or more. Use Remove to take stock off.";
  if (option.factor > 1 && !Number.isInteger(n))
    return `Count whole ${pluralize(option.label).toLowerCase()}, or count the rest in ${baseWord(options)} rows.`;
  return null;
}

/** "Pick a reason." until one is chosen (shown under the Reason field). */
export function reasonHint(form: Pick<CountForm, "reason">): string | null {
  return form.reason ? null : "Pick a reason.";
}

/** "Add a note for Other." when the reason is Other and the note is not 3-200 characters (under the Note field). */
export function noteHint(form: Pick<CountForm, "reason" | "note">): string | null {
  if (form.reason !== "OTHER") return null;
  const n = form.note.trim().length;
  return n < ADJUSTMENT_REASON_NOTE_MIN || n > ADJUSTMENT_REASON_NOTE_MAX
    ? "Add a note for Other."
    : null;
}

/**
 * An amber line (a WARNING, never a block: SA-828 section 3 / SA-958, the book may already be wrong and a
 * later count fixes it) when a Remove would leave the stock under zero.
 */
export function belowZeroWarning(
  form: Pick<CountForm, "mode" | "sign" | "quantities">,
  options: CountUnitOption[],
  currentStock: number,
): string | null {
  const after = resultingStock(form, options, currentStock);
  return after !== null && after < 0
    ? `This takes stock below zero (${stockWithWord(after, options)}).`
    : null;
}

/** The first thing wrong with the form (a row's problem, then the reason and note), or null when it can be saved. */
export function validateCount(form: CountForm, options: CountUnitOption[]): string | null {
  for (const o of options) {
    const p = rowProblem(o, form.quantities[o.value] ?? "", options);
    if (p) return p;
  }
  const parts = countParts(form, options);
  if (parts.length === 0) return form.mode === "SET" ? "Enter a count." : "Enter a quantity.";
  if (form.mode === "ADJUST" && piecesOfParts(parts) === 0) return "Enter a quantity above zero.";
  return reasonHint(form) ?? noteHint(form);
}

/** The request body: the non-blank rows as parts. Call only when `validateCount` returned null. */
export function buildCountRequest(
  form: CountForm,
  options: CountUnitOption[],
): ProductCountRequest {
  const note = form.note.trim();
  const extra = {
    reason: form.reason as AdjustmentReason,
    ...(note ? { reasonNote: note } : {}),
    ...(form.date ? { effectiveDate: form.date } : {}),
  };
  // The pack is `unit: null` (the server's own pack label); any other row sends its ladder label.
  const parts = countParts(form, options).map((p) => ({
    unit: p.option.value === "" ? null : p.option.value,
    quantity: p.quantity,
  }));
  return form.mode === "SET"
    ? { mode: "SET", parts, ...extra }
    : { mode: "ADJUST", parts, sign: form.sign, ...extra };
}

/** Today as "YYYY-MM-DD" (local), the date picker's max. */
export function todayISO(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
