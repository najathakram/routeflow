/**
 * Pack-size parsing and suggestion — the single shared implementation, consumed
 * by apps/api, apps/web, and apps/mobile (unlike `pricing.ts`, this is NOT
 * triple-mirrored; a subtle parser with refusal semantics is exactly the wrong
 * thing to keep three hand-synced copies of).
 *
 * Ported, verbatim in behaviour, from `apps/api/scripts/propose-pack-sizes.mjs`
 * (`parsePackSizeDetailed` / `classify`) — that script now mirrors this file
 * rather than being the source of truth; see its header.
 *
 * THE RULE THIS EXISTS TO ENFORCE: never guess. "…5CT - 12Pack" states two
 * DIFFERENT counts (12 packs of 5) and there is no way to tell which number the
 * price refers to, so `packSize` comes back `null` and the caller is told
 * AMBIGUOUS rather than handed a guessed value. A false null costs one prompt a
 * human can answer; a false positive mis-prices every loose sale of that
 * product from then on.
 */

export type PackSizeConfidence = "HIGH" | "MEDIUM" | "LOW" | "AMBIGUOUS" | "PIECE_UNIT";

export interface PackSizeParse {
  packSize: number | null;
  counts: number[];
}

export interface PackSizeSuggestion {
  packSize: number | null;
  counts: number[];
  confidence: PackSizeConfidence | null;
  /** Operator-facing reason, e.g. "Two different counts in the name (5 and 12)
   *  — tell us which one the price is for." Never phrased as a guess. */
  reason: string | null;
}

/**
 * Returns `{ packSize, counts }` where `counts` is every distinct count-like
 * token found. More than one DISTINCT count means the name describes nested
 * packaging ("5CT - 12Pack" = 12 packs of 5) and we cannot tell which number
 * the price refers to — so `packSize` comes back `null` rather than guessed.
 */
export function parsePackSizeDetailed(name: string | null | undefined): PackSizeParse {
  if (!name) return { packSize: null, counts: [] };
  const s = String(name).toUpperCase();
  const counts: number[] = [];

  // `exec` loops rather than `for…of …matchAll()`, and `Array.from` rather than
  // spreading a Set: `apps/web`'s tsconfig sets no `target`, so it compiles as
  // ES5 and TS refuses to iterate an iterator there (TS2802). Same behaviour.
  let m: RegExpExecArray | null;

  // "12/1.93OZ" — N units of a given size. Read BEFORE measurements are
  // stripped, because the measurement is what identifies this as a pack-of-N.
  const packOfRe = /\b(\d{1,4})\s*\/\s*[\d.]+\s*(OZ|ML|L|G|MG|LB|KG|CT)\b/g;
  while ((m = packOfRe.exec(s)) !== null) {
    counts.push(Number(m[1]));
  }

  // Strip measurements so "5 HOUR" / "65MG" / "3OZ" can't read as counts.
  const cleaned = s.replace(/\b[\d.]+\s*(HOUR|HR|ML|OZ|LB|KG|MG|G|L|CM|MM|IN|FT|%)\b/g, " ");

  // 12CT / 12 CT / 12-CT / 24PK / 24 PACK / 10 COUNT — and their plurals
  // (12CTS / 24PKS / 24 PACKS / 10 COUNTS). The suffix alternation is
  // non-capturing with a trailing `S?` rather than listing "PACKS" etc. as
  // their own alternatives, because a bare trailing `\b` after each literal
  // used to make the plural forms invisible: "CT", "PK", "PACK", "COUNT" are
  // all word characters, so "PACKS" has no word/non-word transition right
  // after "PACK" and the old `(CT|CNT|COUNT|PK|PACK|PCS|PC)\b` alternation
  // simply failed to match there. That let a nested-packaging name like
  // "…5CT - 12Packs" read as ONLY the "5" — a false single count returned at
  // HIGH confidence instead of the AMBIGUOUS refusal two distinct counts
  // require. `PCS` no longer needs its own alternative: it's `PC` + `S?`.
  // The suffix group is non-capturing on purpose — `m[2]` was never read
  // (only `m[1]`, the count, was), but it existed as a capture group before;
  // grep for `m[2]`/`match[2]` on any future edit near this regex before
  // assuming a numbered group still holds the suffix text.
  // "N PACK(S) OF M" / "N BOXES OF M" states BOTH numbers: N outer packs of
  // M inner pieces. Only the first carries a suffix, so the count regex
  // below sees just the N and would return it as a confident single count —
  // the exact nested-packaging conflict AMBIGUOUS exists for. Read the pair
  // FIRST and push both, so the >1-distinct rule refuses. Without this,
  // adding the plural S? below turned "Gum 2 PACKS OF 12" from a quiet ask
  // into a pre-filled one-click proposal of 2, prorating a loose piece 12x.
  const ofPairRe =
    /\b(\d{1,4})\s*(?:CT|CNT|COUNT|PK|PACK|PC|BOX|BOXES|CASE|CASES)S?\s+OF\s+(\d{1,4})\b/g;
  while ((m = ofPairRe.exec(cleaned)) !== null) {
    counts.push(Number(m[1]), Number(m[2]));
  }

  const countRe = /\b(\d{1,4})\s*[-\s]?\s*(?:CT|CNT|COUNT|PK|PACK|PC)S?\b/g;
  while ((m = countRe.exec(cleaned)) !== null) {
    counts.push(Number(m[1]));
  }

  const valid = Array.from(new Set(counts.filter((n) => Number.isFinite(n) && n > 1 && n <= 1000)));
  return { packSize: valid.length === 1 ? (valid[0] ?? null) : null, counts: valid };
}

/**
 * Joins the distinct counts for operator-facing copy — "5 or 12", "4, 8 or 16".
 * Shared so no surface hardcodes "two": a name can state three or more counts
 * ("Widget 4CT 8PK 16 COUNT"), and saying "two" there misstates the very
 * conflict the message exists to explain.
 */
export function formatCountList(counts: number[]): string {
  if (counts.length < 2) return counts.join("");
  return `${counts.slice(0, -1).join(", ")} or ${counts.slice(-1).join("")}`;
}

const PACKISH_UNIT = /\b(box|case|carton|pack|pk|ct|dozen|dz|bundle|tray|sleeve|showcase)\b/i;
/** Unit nouns that say "this row IS one piece" — a pack size here would divide
 *  a piece price by the pack and undercharge by that factor. Never propose. */
const PIECE_UNIT =
  /^\s*(pcs?|pieces?|ea|each|singles?|units?|bottles?|cans?|sticks?|rolls?|sheets?|strips?|bags?|jars?|tubes?|pouch(?:es)?)\s*$/i;

/**
 * Suggests a pack size for a product that doesn't have one yet, with an
 * operator-facing `reason` and this confidence ladder:
 *   `PIECE_UNIT` (never propose) → `AMBIGUOUS` (>1 distinct count) →
 *   `HIGH` (a count AND (packish unit OR a piece-level `unitSku`)) →
 *   `MEDIUM` (count only) → `LOW` (packish unit, no count) → `null` (nothing found).
 *
 * Returns `confidence: null` when `unitsPerBox` is already set (> 1) — there is
 * nothing to suggest — so every caller can invoke this unconditionally without
 * first checking whether the product already has a pack size.
 */
export function suggestPackSize(input: {
  name?: string | null;
  unit?: string | null;
  unitSku?: string | null;
  unitsPerBox?: number | null;
}): PackSizeSuggestion {
  if (input.unitsPerBox != null && input.unitsPerBox > 1) {
    return { packSize: null, counts: [], confidence: null, reason: null };
  }

  const { packSize, counts } = parsePackSizeDetailed(input.name);
  const unit = String(input.unit ?? "");
  const packishUnit = PACKISH_UNIT.test(unit);
  const pieceUnit = PIECE_UNIT.test(unit);
  const hasPieceBarcode = !!(input.unitSku && String(input.unitSku).trim());

  // A piece-level SKU sold by the piece: the count in its name describes the
  // case it was broken out of, not this row. Never propose — even when the
  // name contains a clean, unambiguous count.
  if (pieceUnit) {
    return {
      packSize: null,
      counts,
      confidence: "PIECE_UNIT",
      reason:
        "Sold by the piece already — a pack size here would divide the piece price and undercharge.",
    };
  }

  // Nested packaging — several different counts, no way to know which the price
  // is for. Never guess: state the conflict and ask.
  if (!packSize && counts.length > 1) {
    return {
      packSize: null,
      counts,
      confidence: "AMBIGUOUS",
      reason: `This name mentions ${counts.length} different counts (${formatCountList(counts)}) — tell us which one the price is for.`,
    };
  }

  if (packSize && (packishUnit || hasPieceBarcode)) {
    return {
      packSize,
      counts,
      confidence: "HIGH",
      reason: `Looks like this is sold in a box of ${packSize}. Set pack size?`,
    };
  }

  if (packSize) {
    return {
      packSize,
      counts,
      confidence: "MEDIUM",
      reason: `The name mentions a count of ${packSize} — is this sold in a box of ${packSize}?`,
    };
  }

  if (packishUnit) {
    return {
      packSize: null,
      counts,
      confidence: "LOW",
      reason: "How many pieces are in a box?",
    };
  }

  return { packSize: null, counts, confidence: null, reason: null };
}
