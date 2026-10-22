import { perUnitPrice, unitWords } from "@routeflow/pricing";
import { formatMoney } from "@/lib/format";

const UW = unitWords();

/**
 * B1261: the ONE note that says what a priced order line's unit price is per: the pack word and, for a boxed line sold in
 * pieces, the price each. Used by the order table's Unit Price cell and by the card list, so there is no second formatter.
 * The pack word is the line's own unit label when it was sold by a named unit; the per-piece figure is the display-only
 * `perUnitPrice` (never fed back into money math). Null for a plain single-unit line.
 */
export function unitPriceNote(line: {
  unitPrice: number | string;
  unitsPerBox?: number | string | null;
  unitLabel?: string | null;
  pieces?: number | string | null;
}): { per: string; each: string | null; text: string } | null {
  const upb = Number(line.unitsPerBox ?? 0);
  if (!(upb > 1)) return null;
  const unitLabel = (line.unitLabel ?? "").trim();
  const per = unitLabel ? unitLabel.toLowerCase() : UW.pack.lower;
  const each = perUnitPrice(Number(line.unitPrice), upb);
  const inPieces = !unitLabel && Number(line.pieces ?? 0) > 0;
  const eachText = inPieces && each != null ? `${formatMoney(each)} each` : null;
  return { per, each: eachText, text: `/ ${per}${eachText ? ` · ${eachText}` : ""}` };
}
