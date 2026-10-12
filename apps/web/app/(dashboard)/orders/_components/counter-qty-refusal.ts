/**
 * CQ-12: why a typed quantity was not taken. `setLineQty` (counter-sale-line-edit.ts) decides WHAT is accepted and is not
 * changed; this only words the refusals so the field never snaps back silently. Fixed copy, one short sentence each.
 */

/** Which field the text was typed into: a plain line's quantity, or a boxed line's boxes / pieces. */
export type QtyFieldKind = "qty" | "boxes" | "pieces";

export const QTY_NOT_A_NUMBER_COPY = "Enter a whole number, like 2.";
export const QTY_NEGATIVE_COPY = "A quantity can't be below 0.";
export const QTY_NOT_WHOLE_COPY = "Enter a whole number. Items can't be split here.";
export const QTY_ZERO_COPY = "Quantity must be at least 1. To take the item off the sale, use ×.";
export const QTY_ZERO_BOXED_COPY =
  "Enter at least one box or piece. To take the item off the sale, use ×.";
export const QTY_TOO_LARGE_COPY = "That quantity is too large.";

/**
 * The sentence for a refused typed quantity. `text` is the raw field value ("" is what a number field reports for letters).
 * Called only for a text the screen refused, so it always returns a sentence.
 */
export function qtyRefusalMessage(text: string, kind: QtyFieldKind): string {
  const t = text.trim();
  const n = Number(t);
  if (t === "" || !Number.isFinite(n)) return QTY_NOT_A_NUMBER_COPY;
  if (n < 0) return QTY_NEGATIVE_COPY;
  if (!Number.isInteger(n)) return QTY_NOT_WHOLE_COPY;
  if (!Number.isSafeInteger(n)) return QTY_TOO_LARGE_COPY;
  return kind === "qty" ? QTY_ZERO_COPY : QTY_ZERO_BOXED_COPY;
}
