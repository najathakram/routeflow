/**
 * The classifier for a STORED line whose own split may be missing (the box-unaware convention
 * this design retires — #938, 2026-09-21). Ruled once by the Senior Architect, with a HOLD round
 * fixing the ruling itself (non-boxed lines flooding `unknown`, a partial matching a source's
 * `boxes` by coincidence, a loose-pieces source, `Decimal` inputs). Signature and evidence order
 * are canonical — any caller (B661's write refusal, B646's read path, the history report)
 * imports THIS, never re-derives a piece count itself. `apps/api`'s
 * `no-second-legacy-line-pieces.spec.ts` fails the build if a second implementation appears.
 *
 * NEVER multiplies a qty by a product's `unitsPerBox` — a product's pack size can change after
 * the sale, so that would silently misclassify an old row with today's size. `productPackNow` is
 * consulted as a GATE only (is the product boxed AT ALL today, so a bare qty is plausibly already
 * pieces), never as a multiplier. `unknown` is a first-class result: a caller REFUSES or FLAGS on
 * it, never defaults to a guessed number.
 *
 * Every numeric field is compared through `Number()` with a finite check — a Prisma `Decimal`
 * compared with `===` against a plain `number` is always `false`, which used to fail safe (every
 * row became `unknown`) but silently, for every caller. Callers should still pass plain numbers;
 * this only guards against one that forgets.
 *
 * Evidence, in order:
 *   (a) the line itself carries a split (`boxes` or `pieces` given) — its `qty` is already
 *       pieces. basis `"split"`.
 *   (b) `sourceLine` is given, is for the SAME PRODUCT and the SAME RECORD as `line` (verifying
 *       that is the CALLER's job — `opts.relation` states which; this function trusts whichever
 *       `sourceLine` it's given) and carries a split:
 *       - `opts.relation === "full"` (a line against the ONE line it was copied from whole — an
 *         order line against its own InvoiceItem, an estimate line against its own invoice line;
 *         SIBLING lines are never a source):
 *           - `line.qty === sourceLine.boxes`, `!== sourceLine.qty`, AND the source has NO loose
 *             pieces (`sourceLine.pieces` null or 0) — the line's `qty` was a BOX count copied
 *             from the source. `pieces = sourceLine.qty`. basis `"source-boxes"`. A source WITH
 *             loose pieces is excluded: a box-count copy of "2 boxes + 3 loose" losing the split
 *             would have lost the 3 loose pieces too, so a coincidental `qty === boxes` there is
 *             NOT evidence of a copy — it's just as likely a genuine, unrelated 2-piece sale.
 *           - `line.qty === sourceLine.qty` — the line's `qty` was already a piece count, copied
 *             straight through. `pieces = line.qty`. basis `"source-pieces"`. (A tie between the
 *             two conditions above resolves HERE, never `"source-boxes"`.)
 *       - `opts.relation` omitted or `"partial"` (the SAFE default — a partial invoice/return
 *         against a bigger order line, where `qty` coincidentally matching the source's `boxes`
 *         is a real, observed false-positive shape [B660]): ONLY `line.qty === sourceLine.qty`
 *         may fire (basis `"source-pieces"`) — the box-count inference is disabled entirely,
 *         because a partial's `qty` has no reason to equal the FULL source's box count except
 *         coincidence.
 *       - neither condition holds — `unknown`.
 *   (c) NO usable source (missing, or itself has no split) — falls back to `opts.productPackNow`:
 *       if given and NOT boxed now (`<= 1` / a product that exists but has no box size),
 *       `pieces = line.qty`, basis `"non-boxed-now"` (weaker evidence than the others — an
 *       ordinary never-boxed product's line has no split and usually no usable source either,
 *       and defaulting those to `unknown` would flood every consumer with false negatives). If
 *       `productPackNow` is boxed now, or wasn't given at all, this fallback does not apply —
 *       `unknown`. Gated on the source having NO split (not merely "didn't match"): a source WITH
 *       a split proves the product WAS boxed when it sold, so a non-boxed pack size today means
 *       the pack changed after the sale — exactly the case the live product must not decide.
 *       That stays `unknown`, never `"non-boxed-now"`, even with a matching `productPackNow`.
 */

/** A line as this classifier needs it — a stored InvoiceItem/OrderItem/ReturnItem or similar. */
export interface LegacyLine {
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
}

export type LegacyLinePiecesBasis = "split" | "source-boxes" | "source-pieces" | "non-boxed-now";

export type LegacyLinePiecesResult =
  { pieces: number; basis: LegacyLinePiecesBasis } | { unknown: true; reason: string };

export interface LegacyLinePiecesOptions {
  /**
   * How `sourceLine` relates to `line`: `"full"` — `line` is a whole, 1:1 copy of `sourceLine`
   * (an order line against its own InvoiceItem, an estimate line against its own invoice line).
   * `"partial"` (default) — `line` may be a fraction of `sourceLine` (a partial invoice, a
   * return). Get this wrong in the unsafe direction and a coincidental `qty` match to the
   * source's `boxes` misclassifies by a factor of the box size — default is deliberately the
   * SAFE (more restrictive) direction.
   */
  relation?: "full" | "partial";
  /** The product's CURRENT `unitsPerBox` — a GATE ("is this boxed at all today"), NEVER a
   * multiplier. `null` means the product EXISTS and has no box size — NOT "I couldn't find live
   * pack info". A product that wasn't found (deleted, bad id) must be OMITTED, never passed as
   * `null`: passing `null` for a missing product would classify its lines as pieces on no real
   * evidence. Omitting entirely only loses the `"non-boxed-now"` fallback — it never causes a
   * wrong answer. */
  productPackNow?: number | null;
}

/** `Number()` with a finite check — `null` for anything that isn't a real, usable number
 * (including a `Decimal`/string that doesn't parse, `null`, `undefined`, `NaN`, `Infinity`). */
function finiteNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function legacyLinePieces(
  line: LegacyLine,
  sourceLine?: LegacyLine | null,
  opts?: LegacyLinePiecesOptions,
): LegacyLinePiecesResult {
  const lineQty = finiteNumber(line.qty);
  if (lineQty == null) {
    return { unknown: true, reason: `line qty (${line.qty}) is not a usable number` };
  }

  if (line.boxes != null || line.pieces != null) {
    return { pieces: lineQty, basis: "split" };
  }

  const relation = opts?.relation ?? "partial";
  const sourceHasSplit =
    sourceLine != null && (sourceLine.boxes != null || sourceLine.pieces != null);

  if (sourceHasSplit) {
    const srcQty = finiteNumber(sourceLine!.qty);
    const srcBoxes = finiteNumber(sourceLine!.boxes);
    const srcPieces = finiteNumber(sourceLine!.pieces);

    if (srcQty != null) {
      if (
        relation === "full" &&
        srcBoxes != null &&
        lineQty === srcBoxes &&
        lineQty !== srcQty &&
        (srcPieces == null || srcPieces === 0)
      ) {
        return { pieces: srcQty, basis: "source-boxes" };
      }
      if (lineQty === srcQty) {
        return { pieces: lineQty, basis: "source-pieces" };
      }
    }
  }

  // Opt-in only: an OMITTED productPackNow means the caller didn't check (or the product wasn't
  // found), so this must not silently apply — only an explicitly supplied value counts as
  // evidence. Gated on the SOURCE having no split: a source WITH a split proves the product was
  // boxed when it sold, so a non-boxed pack size today is a pack change, not proof the line was
  // always sold loose — the live product must not override that.
  if (opts?.productPackNow !== undefined && !sourceHasSplit) {
    const packNow = finiteNumber(opts.productPackNow);
    if (!(packNow != null && packNow > 1)) {
      return { pieces: lineQty, basis: "non-boxed-now" };
    }
  }

  if (sourceLine == null) {
    return { unknown: true, reason: "no split on the line and no source line to check against" };
  }
  if (!sourceHasSplit) {
    return {
      unknown: true,
      reason: "no split on the line, and the source line has no split either",
    };
  }
  return {
    unknown: true,
    reason:
      relation === "partial"
        ? `line qty (${line.qty}) does not match the source's qty (${sourceLine.qty}) — a partial can only match by qty, never by boxes`
        : `line qty (${line.qty}) matches neither the source's boxes (${sourceLine.boxes}) nor its qty (${sourceLine.qty})`,
  };
}
