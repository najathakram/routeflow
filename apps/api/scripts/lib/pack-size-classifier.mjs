// The pack-size classifier shared by propose-pack-sizes.mjs and report-units-fold-readiness.mjs (SA-984 C-2):
// ONE implementation, extracted verbatim from propose-pack-sizes.mjs (which runs top-level code and so could not be
// imported). Pure: no I/O, no environment, no database.
//
// MIRROR, NOT SOURCE OF TRUTH: `parsePackSizeDetailed` and the classification logic below are a copy of
// `packages/types/pack-size.ts` (`parsePackSizeDetailed` / `suggestPackSize`), which is the canonical implementation
// consumed by apps/api, apps/web, and apps/mobile. This file keeps its own copy only because the scripts run
// standalone under plain `node` (invoked directly via `railway run`) and cannot import the TS package. Any
// behavioural change belongs in `packages/types/pack-size.ts` first, ported here in step - never the other way around.

/**
 * Pull a pack size out of a product name. Deliberately conservative: only
 * patterns that state a COUNT of pieces. Ambiguous multi-number names
 * ("2/12", "5 HOUR") are rejected rather than guessed, because a wrong pack
 * size mis-prices every loose sale of that product.
 *
 * Mirrors `packages/types/pack-size.ts` (the canonical implementation) — keep
 * the two in step; see the file header for why this copy exists.
 */
export function parsePackSize(name) {
  const r = parsePackSizeDetailed(name);
  return r.packSize;
}

/**
 * Returns { packSize, counts } where `counts` is every distinct count-like token
 * found. More than one DISTINCT count means the name describes nested packaging
 * ("5CT - 12Pack" = 12 packs of 5) and we cannot tell which number the price
 * refers to — so packSize comes back null and the row is reported AMBIGUOUS
 * rather than guessed. Guessing here mis-prices every loose sale of that
 * product, which is worse than leaving it for a human.
 */
export function parsePackSizeDetailed(name) {
  if (!name) return { packSize: null, counts: [] };
  const s = String(name).toUpperCase();
  const counts = [];

  // "12/1.93OZ" — N units of a given size. Read BEFORE measurements are stripped,
  // because the measurement is what identifies this as a pack-of-N.
  for (const m of s.matchAll(/\b(\d{1,4})\s*\/\s*[\d.]+\s*(OZ|ML|L|G|MG|LB|KG|CT)\b/g)) {
    counts.push(Number(m[1]));
  }

  // Strip measurements so "5 HOUR" / "65MG" / "3OZ" can't read as counts.
  const cleaned = s.replace(/\b[\d.]+\s*(HOUR|HR|ML|OZ|LB|KG|MG|G|L|CM|MM|IN|FT|%)\b/g, " ");

  // 12CT / 12 CT / 12-CT / 24PK / 24 PACK / 10 COUNT — and their plurals
  // (12CTS / 24PKS / 24 PACKS / 10 COUNTS). Mirrors the fix in
  // packages/types/pack-size.ts: the suffix alternation is non-capturing with
  // a trailing `S?` rather than listing "PACKS" etc. as their own
  // alternatives, because a bare trailing `\b` after each literal used to
  // make the plural forms invisible ("PACKS" has no word/non-word transition
  // right after "PACK", so the old `(CT|CNT|COUNT|PK|PACK|PCS|PC)\b`
  // alternation simply failed to match there). That let a nested-packaging
  // name like "…5CT - 12Packs" read as ONLY the "5" — a false single count at
  // HIGH confidence instead of the AMBIGUOUS refusal two distinct counts
  // require. `PCS` no longer needs its own alternative: it's `PC` + `S?`.
  // The suffix group is non-capturing on purpose — `m[2]` was never read
  // (only `m[1]`, the count, was), but it existed as a capture group before;
  // grep for `m[2]`/`match[2]` on any future edit near this regex before
  // assuming a numbered group still holds the suffix text.
  //
  // ⚠️ This fix landed 2026-08-20. Any pack-size proposal report generated
  // before that date — including the 812-product proposal already reviewed
  // for this tenant batch — was produced with the OLD (buggy) regex, and may
  // have classified a nested-packaging name (a plural count suffix hiding a
  // second, different count) as a single confident count instead of
  // AMBIGUOUS. Re-run this script to regenerate any proposal relied on for a
  // write, rather than trusting an old report's output.
  // "N PACK(S) OF M" states BOTH numbers (N outer packs of M inner). Only
  // the first carries a suffix, so the matcher below would see just the N
  // and report a confident single count. Read the pair first and push both
  // so the >1-distinct rule refuses. Mirrors packages/types/pack-size.ts.
  for (const m of cleaned.matchAll(
    /\b(\d{1,4})\s*(?:CT|CNT|COUNT|PK|PACK|PC|BOX|BOXES|CASE|CASES)S?\s+OF\s+(\d{1,4})\b/g,
  )) {
    counts.push(Number(m[1]), Number(m[2]));
  }

  for (const m of cleaned.matchAll(/\b(\d{1,4})\s*[-\s]?\s*(?:CT|CNT|COUNT|PK|PACK|PC)S?\b/g)) {
    counts.push(Number(m[1]));
  }

  const valid = [...new Set(counts.filter((n) => Number.isFinite(n) && n > 1 && n <= 1000))];
  return { packSize: valid.length === 1 ? valid[0] : null, counts: valid };
}

export const PACKISH_UNIT =
  /\b(box|case|carton|pack|pk|ct|dozen|dz|bundle|tray|sleeve|showcase)\b/i;
/** Unit nouns that say "this row IS one piece" — a pack size here would divide
 *  a piece price by the pack and undercharge by that factor. Never propose. */
export const PIECE_UNIT =
  /^\s*(pcs?|pieces?|ea|each|singles?|units?|bottles?|cans?|sticks?|rolls?|sheets?|strips?|bags?|jars?|tubes?|pouch(?:es)?)\s*$/i;

export function classify(p) {
  const { packSize, counts } = parsePackSizeDetailed(p.name);
  const unit = String(p.unit ?? "");
  const packishUnit = PACKISH_UNIT.test(unit);
  const pieceUnit = PIECE_UNIT.test(unit);
  const hasPieceBarcode = !!(p.unitSku && String(p.unitSku).trim());

  // A piece-level SKU sold by the piece: the count in its name describes the
  // case it was broken out of, not this row. Report, never propose.
  if (pieceUnit) return { confidence: "PIECE_UNIT", packSize: null, counts };

  // Nested packaging — two different counts, no way to know which the price is.
  if (!packSize && counts.length > 1) return { confidence: "AMBIGUOUS", packSize: null, counts };

  if (packSize && (packishUnit || hasPieceBarcode)) return { confidence: "HIGH", packSize, counts };
  if (packSize) return { confidence: "MEDIUM", packSize, counts };
  if (packishUnit) return { confidence: "LOW", packSize: null, counts };
  return null;
}
