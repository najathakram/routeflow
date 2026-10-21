import { unitWords } from "@routeflow/pricing";

interface QtyLine {
  qty: number | string;
  boxes?: number | string | null;
  pieces?: number | string | null;
  unitLabel?: string | null;
  product?: { unit?: string | null } | null;
}

const num = (v: unknown): number => Number(v ?? 0) || 0;
const GENERIC_PIECE = /^(each|ea|piece|pc|unit)s?$/i;

/**
 * F03 / F19: the Total quantity line, per unit ("3 boxes + 6 bottles"), instead of one unitless sum that mixes cases
 * and bottles. A box-split line contributes its boxes and loose pieces (qty is pieces there); a plain line counts in
 * its own unit, and generic "each" lines merge with loose pieces. No money maths: counts only.
 */
export function summarizeQtyByUnit(lines: ReadonlyArray<QtyLine>): string {
  const words = unitWords();
  const buckets = new Map<string, number>(); // key: "pack" | "base" | custom label (display fixed on output)
  const add = (key: string, n: number) => n > 0 && buckets.set(key, (buckets.get(key) ?? 0) + n);
  for (const li of lines) {
    if (li.boxes != null || li.pieces != null) {
      add("\u0000pack", num(li.boxes));
      add("\u0000base", num(li.pieces));
      continue;
    }
    const label = (li.unitLabel ?? li.product?.unit ?? "").trim();
    add(!label || GENERIC_PIECE.test(label) ? "\u0000base" : label, num(li.qty));
  }
  if (buckets.size === 0) return "0";
  return [...buckets]
    .map(([key, n]) => {
      const shown = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
      if (key === "\u0000pack") return `${shown} ${words.packFor(n)}`;
      if (key === "\u0000base") return `${shown} ${words.baseShortFor(n)}`;
      const plural = n === 1 || /s$/i.test(key) ? key : `${key}s`;
      return `${shown} ${plural}`;
    })
    .join(" + ");
}
