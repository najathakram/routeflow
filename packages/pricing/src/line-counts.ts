import { roundMoney } from "./pricing";
import { unitLineCount } from "./unit-line-count";
import { plural, unitWords } from "./unit-words";

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

/** A label's counting word: generic piece words fold into "pc", box words into "box". */
function wordOf(label: string | null | undefined): string {
  const t = (label ?? "").trim();
  if (!t || GENERIC_PIECE.test(t)) return PIECE;
  if (BOX_LIKE.test(t)) return BOX;
  return t.toLowerCase();
}

export function summarizeLineCounts(lines: ReadonlyArray<CountableLine>): LineCounts {
  const buckets = new Map<string, number>();
  let counted = 0;
  for (const li of lines) {
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
      add(wordOf(named), unitLineCount(li) ?? num(li.qty));
    } else if (li.boxes != null || li.pieces != null) {
      const pack = (li.packLabel ?? "").trim();
      const base = (li.baseLabel ?? "").trim();
      add(!pack || BOX_LIKE.test(pack) ? BOX : pack.toLowerCase(), num(li.boxes));
      add(!base || GENERIC_PIECE.test(base) ? PIECE : base.toLowerCase(), num(li.pieces));
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

function shown(n: number): string {
  return String(Number.isInteger(n) ? n : roundMoney(n));
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
 * unitLabel): the same fields its qty column prints (`invoiceLineQtyText`). The catalog's live
 * `product.unit` is never read, so the web page, the PDF and the email always agree.
 */
export function formatInvoiceLineCounts(items: ReadonlyArray<CountableLine>): string {
  return formatLineCounts(
    summarizeLineCounts(
      items.map(({ qty, boxes, pieces, unitsPerBox, unitLabel }) => ({
        qty,
        boxes,
        pieces,
        unitsPerBox,
        unitLabel,
      })),
    ),
  );
}
