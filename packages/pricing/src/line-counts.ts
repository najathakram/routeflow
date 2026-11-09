import { unitLineCount } from "./unit-line-count";
import { INVARIANT_UNIT_WORDS, plural, unitWords } from "./unit-words";

/**
 * W-1185: the ONE count of an order's or invoice's lines and units ("12 lines · 30 boxes · 6 pcs").
 * Web (invoice, order, builder, till), the invoice PDF and the invoice email all import this; there
 * are no copies. Counts only, no money maths. Boxes and pieces are NEVER added together: a boxed
 * line contributes its boxes and its loose pieces separately, a named unit ("Case") counts in its
 * own word, and a plain line counts in its own selling unit.
 *
 * Fields are `unknown` so every line shape fits (numbers, Decimal-as-string JSON, till snapshots).
 */
export interface CountableLine {
  qty?: unknown;
  boxes?: unknown;
  pieces?: unknown;
  unitsPerBox?: unknown;
  /** units_v1 named selling unit ("Case", "Pallet"): stored boxes = count, pieces = 0, qty = count x factor. */
  unitLabel?: string | null;
  /** The product's own pack / base words (till snapshot). */
  packLabel?: string | null;
  baseLabel?: string | null;
  /** The selling unit of an unboxed line ("each", "bottle", "kg"). */
  unit?: string | null;
  product?: { unit?: string | null } | null;
  /** A system-written line (the NSF bounce fee): never goods, never counted. */
  systemKind?: string | null;
}

/** `word` is the singular, lower-case form ("box", "pc", "case", "bottle"). */
export interface UnitCount {
  word: string;
  count: number;
}

export interface LineCounts {
  lines: number;
  boxes: number;
  pieces: number;
  byUnit: UnitCount[];
}

const BOX = "box";
const PIECE = "pc";
const SEPARATOR = " · ";
const GENERIC_PIECE = /^(each|ea|piece|pc|unit)s?$/i;
const BOX_LIKE = /^box(es)?$/i;

const num = (v: unknown): number => Number(v ?? 0) || 0;

/**
 * The singular, lower-case form of a free-text unit word: the inverse of `pluralize`, so a tenant's
 * "Cases", "Pcs" or "pc." lands in the same bucket as "Case", "Pc" and "pc". A trailing "." goes
 * first; an invariant word stays; "...ies" -> "...y"; "...(ch|sh|x|z)es" -> strip "es"; "...ss"
 * stays; a two-letter word stays; any other "...s" -> strip "s".
 */
export function singularOf(word: string): string {
  const w = word.trim().replace(/\.$/, "").trim().toLowerCase();
  // A two-letter word is an abbreviation ("cs", "ea", "kg"), never a plural.
  if (w.length <= 2 || INVARIANT_UNIT_WORDS.has(w) || w.endsWith("ss")) return w;
  if (w.endsWith("ies") && w.length > 3) return `${w.slice(0, -3)}y`;
  if (/(ch|sh|x|z)es$/.test(w)) return w.slice(0, -2);
  return w.endsWith("s") ? w.slice(0, -1) : w;
}

/** A label's counting word: generic piece words fold into "pc", box words into "box". */
function wordOf(label: string | null | undefined): string {
  const t = singularOf(label ?? "");
  if (!t || GENERIC_PIECE.test(t)) return PIECE;
  if (BOX_LIKE.test(t)) return BOX;
  return t;
}

export interface SummarizeOptions {
  /**
   * How a plain (unboxed, unnamed) line is worded. "unit" (default): its own selling unit
   * (`unit` / `product.unit`), the live documents. "stored-only": only a frozen, non-generic
   * `baseLabel`; with none, the qty counts under the generic piece word (an invoice prints a bare
   * quantity, and a bare number is pieces by default). The live catalog unit is never read.
   */
  unboxedWord?: "unit" | "stored-only";
}

export function summarizeLineCounts(
  lines: ReadonlyArray<CountableLine>,
  options: SummarizeOptions = {},
): LineCounts {
  const storedOnly = options.unboxedWord === "stored-only";
  const buckets = new Map<string, number>();
  let counted = 0;
  for (const li of lines) {
    // A system line (the NSF bounce fee) is a charge, not goods.
    if (li.systemKind != null && String(li.systemKind).trim() !== "") continue;
    let added = false;
    const add = (word: string, n: number) => {
      if (!(n > 0)) return;
      buckets.set(word, (buckets.get(word) ?? 0) + n);
      added = true;
    };
    // A named-unit line is stored boxes=count, pieces=0, qty=count x factor, so it is checked
    // BEFORE the boxed branch and counted in its own unit.
    const named = (li.unitLabel ?? "").trim();
    if (named) {
      const count = unitLineCount(li);
      if (count != null) add(wordOf(named), count);
      else {
        // No safe count. Raw qty is base pieces (qty = count x factor), so reading it as the count
        // is the 12x class unitLineCount's doc warns about; only a factor of 1 (or none) makes
        // qty the count. Otherwise the line is counted and no unit is claimed.
        const factor = li.unitsPerBox == null ? null : Number(li.unitsPerBox);
        if (factor == null || factor === 1) add(wordOf(named), num(li.qty));
        else if (num(li.qty) > 0) added = true;
      }
    } else if (li.boxes != null || li.pieces != null) {
      const pack = singularOf(li.packLabel ?? "");
      const base = singularOf(li.baseLabel ?? "");
      add(!pack || BOX_LIKE.test(pack) ? BOX : pack, num(li.boxes));
      add(!base || GENERIC_PIECE.test(base) ? PIECE : base, num(li.pieces));
    } else if (storedOnly) {
      const frozen = wordOf(li.baseLabel);
      add(frozen, num(li.qty));
    } else {
      add(wordOf(li.unit ?? li.product?.unit), num(li.qty));
    }
    if (added) counted += 1;
  }
  // Box words first, other words in first-seen order, pieces last.
  const others = [...buckets].filter(([w]) => w !== BOX && w !== PIECE);
  const ordered: Array<[string, number]> = [];
  const boxes = buckets.get(BOX) ?? 0;
  const pieces = buckets.get(PIECE) ?? 0;
  if (boxes > 0) ordered.push([BOX, boxes]);
  ordered.push(...others);
  if (pieces > 0) ordered.push([PIECE, pieces]);
  return {
    lines: counted,
    boxes,
    pieces,
    byUnit: ordered.map(([word, count]) => ({ word, count })),
  };
}

/** "1 line", "12 lines", "0 lines". */
export function formatLineWord(n: number): string {
  return n === 1 ? "1 line" : `${n} lines`;
}

/** A quantity, not money: up to 3 decimals like the qty column, trailing zeros dropped. */
function shown(n: number): string {
  return String(Number.isInteger(n) ? n : Math.round(n * 1000) / 1000);
}

function wordFor(word: string, n: number): string {
  const words = unitWords();
  if (word === BOX) return words.packFor(n);
  if (word === PIECE) return words.baseShortFor(n);
  return plural(word, n);
}

/** "30 boxes · 6 pcs"; "" when nothing was counted. */
export function formatUnitCounts(c: LineCounts): string {
  return c.byUnit.map((u) => `${shown(u.count)} ${wordFor(u.word, u.count)}`).join(SEPARATOR);
}

/** "12 lines · 30 boxes · 6 pcs"; "0 lines" when empty. */
export function formatLineCounts(c: LineCounts): string {
  const units = formatUnitCounts(c);
  const lines = formatLineWord(c.lines);
  return units ? `${lines}${SEPARATOR}${units}` : lines;
}

/**
 * An invoice's count, from the line's OWN stored fields only (qty, boxes, pieces, unitsPerBox,
 * unitLabel, and the sale-time `packLabel` / `baseLabel` snapshots frozen at issue): the same
 * fields its qty column prints. The catalog's live `product` / `unit` is never read, so a reprint
 * after a catalog edit, and the web page, the PDF and the email, always agree. A system line (the
 * NSF fee) is skipped; a plain line with no frozen word counts its qty as pieces (the bare
 * number in the qty column).
 */
export function formatInvoiceLineCounts(items: ReadonlyArray<CountableLine>): string {
  return formatLineCounts(
    summarizeLineCounts(
      items.map(
        ({ qty, boxes, pieces, unitsPerBox, unitLabel, packLabel, baseLabel, systemKind }) => ({
          qty,
          boxes,
          pieces,
          unitsPerBox,
          unitLabel,
          packLabel,
          baseLabel,
          systemKind,
        }),
      ),
      { unboxedWord: "stored-only" },
    ),
  );
}
