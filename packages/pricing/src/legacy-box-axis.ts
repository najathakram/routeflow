/**
 * classifySaleAxis — B681/SA-058/SA-070(a), Senior Architect ruling 2026-09-22. ONE predicate
 * shared by the B681 correction routine and its write-time guard (the guard imports this exact
 * function — never a second copy; that duplication is precisely what B681 itself is repairing
 * the cost of).
 *
 * A box-unaware line (no stored boxes/pieces/unitLabel split) that IS boxed today books its SALE
 * row's `unitBasisQty` two different ways depending on when it was written: before B661
 * (`f45eaf52`), `unitBasisQty` was a straight copy of `qty` — the BOX axis. After B661,
 * `regulatedUnitBasis`'s box-unaware branch expands it to `qty * packAtSale` — the PIECES axis.
 * THREE-STATE, never a boolean — `"unknown"` is a first-class, distinct outcome from `"legacy"`,
 * exactly as `legacyLinePieces` treats it: a caller REFUSES or PARKS on `unknown`, it never
 * defaults to a guess.
 *
 * IDEMPOTENCY: evaluated on the row PLUS its own prior correction rows (every row whose
 * `correctsEntryId` names this row), never the bare stored row alone — their `qty`/`unitBasisQty`
 * deltas are summed onto the row's own figures before the axis check, so a row this routine
 * already corrected reads as `"piece-axis"` from then on and is never re-corrected or re-parked.
 *
 * EVALUATION ORDER — first hit wins, never re-ordered:
 *   1. `row.entryType !== "SALE"` → unknown (a REVERSAL takes its SALE's axis, decided by the
 *      correction routine's own per-line classification, never this predicate).
 *   2. `line === null` → unknown (no line to read a shape from — the row's invoice/order item
 *      is gone or was never resolved).
 *   3. `line.boxes` or `line.pieces` non-null → piece-axis (a split line's qty is pieces by the
 *      OrderItem/InvoiceItem invariant, whatever the ledger row says).
 *   4. `line.unitLabel` non-blank → piece-axis (a unit-sold line's qty is base units).
 *   5. Boxed gate: `line.unitsPerBox > 1` when that snapshot exists (SA-609: a snapshot-less line
 *      never short-circuits on the live pack — it goes on to the write-time test below; a product un-boxed since the sale is
 *      not a never-boxed product). Else `productPackNow` when the caller supplied one (a GATE only, never a multiplier — same convention as
 *      `legacyLinePieces`/`line-pack-factors.ts`: `null` means "product exists, no box size",
 *      OMITTING the argument means "caller doesn't know / product not found", and only the
 *      OMITTED case with no line-level snapshot is `unknown`; an explicit `null` still decides
 *      "not boxed" → piece-axis, same as a numeric non-boxed value). A snapshot-less ratio-1 row with `productPackNow` <= 1/null is
 *      piece-axis only when written at or after `B661_CUTOFF`; before it (or with a null/unparseable
 *      `writtenAt`) it is unknown and parks. Not boxed otherwise → piece-axis (a never-boxed line's
 *      qty was always already pieces, nothing to correct).
 *   6. Fold every correction's `qty`/`unitBasisQty` onto the row's own (`effQty`, `effUbq`).
 *      `effQty <= 0` → unknown (nothing genuine left to classify). `effUbq ≈ effQty` (within
 *      0.0005) → legacy (box axis — this is exactly the defect). `effUbq > effQty` → piece-axis
 *      (already correct). `effUbq < effQty` → unknown ("malformed" — a corrected/booked shape
 *      that doesn't fit either axis; never silently treated as either).
 *
 * Every number is read through `Number()` with a finite check — a Prisma `Decimal` compared with
 * `===` against a plain `number` is always `false`; `Number()` coerces it correctly (see
 * `legacyLinePieces`'s own `finiteNumber` helper, same convention).
 */

export type SaleAxisState = "legacy" | "piece-axis" | "unknown";

export interface SaleAxisResult {
  state: SaleAxisState;
  reason: string;
}

/** The one ledger row being asked about — a RegulatedSalesLedger row's own figures. */
export interface SaleAxisRow {
  entryType: string;
  qty: unknown;
  unitBasisQty: unknown;
  /** The row's `createdAt` — when it was WRITTEN (SA-609), never `soldAt` (a back-datable business
   *  date). REQUIRED so tsc flags every caller; `null` = unknown, read as pre-cutoff (parks). */
  writtenAt: Date | string | null;
}

/**
 * The row's LINE — its linked InvoiceItem when one exists, else its OrderItem, else `null` (no
 * line resolved at all, e.g. a since-deleted invoice item on a reconciled order). Shaped exactly
 * like `b681-sizing.sql`'s per-row shape join: `boxes`/`pieces`/`unitLabel` are the line's OWN
 * stored split; `unitsPerBox` is the line's OWN stored pack snapshot (`ii."unitsPerBox"` /
 * `oi."unitsPerBox"` in the query) — distinct from the LIVE product's pack, which only ever
 * arrives via `productPackNow`.
 */
export interface SaleAxisLine {
  boxes?: unknown;
  pieces?: unknown;
  unitLabel?: unknown;
  unitsPerBox?: unknown;
}

/** One correction row already booked against this SALE row (`correctsEntryId === row`'s id) —
 *  only its `qty`/`unitBasisQty` deltas matter here. */
export interface SaleAxisCorrection {
  qty: unknown;
  unitBasisQty: unknown;
}

const EPS = 0.0005;

/**
 * SA-609 / SA-791 (#2052, #2859 review): the instant after which every SALE writer stops writing
 * box-axis rows. B661 (f45eaf52b) went live on Railway @routeflow/api at 2026-09-22T06:39:52Z
 * (GitHub deployment SUCCESS 06:43:26Z). Since B661, `writeSaleEntries` is the single place a SALE
 * row's `unitBasisQty` is derived, so that one deploy fixed every SALE writer. The pack-at-sale
 * follow-ups a5b91f44a (B700, live 2026-09-22T17:18:06Z) and 4fa978826 (SA-078(b), live
 * 2026-09-23T00:37:09Z) were both live before this cutoff. B679 (f5120f3bd) changed category-tax
 * piece counts only and writes no ledger `unitBasisQty`, so it is out of scope. The +24h margin is
 * deliberate and conservative: a later cutoff only parks (an operator attestation), never
 * mis-reverses. A row is judged on its WRITE time (`createdAt`), never `soldAt` (a business date
 * that can be back-dated or imported).
 */
export const B661_CUTOFF = new Date("2026-09-23T06:43:26Z");

/** A row's write time in ms; `null` when absent or unparseable (treated as pre-cutoff: parks). */
function writtenAtMs(v: Date | string | null | undefined): number | null {
  if (v == null) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** `Number()` with a finite check — `null` for anything that isn't a real, usable number
 *  (including a non-numeric string, `null`, `undefined`, `NaN`, `Infinity`). Prisma's `Decimal`
 *  coerces correctly through `Number()` — this is a guard, not a replacement for it. */
function finiteOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function classifySaleAxis(
  row: SaleAxisRow,
  line: SaleAxisLine | null,
  corrections: SaleAxisCorrection[] = [],
  productPackNow?: number | null,
): SaleAxisResult {
  // (1)
  if (row.entryType !== "SALE") {
    return { state: "unknown", reason: "a reversal takes its SALE's axis" };
  }
  // (2)
  if (line == null) {
    return { state: "unknown", reason: "no line to read a shape from" };
  }
  // (3)
  if (finiteOrNull(line.boxes) != null || finiteOrNull(line.pieces) != null) {
    return { state: "piece-axis", reason: "split line: qty is pieces by invariant" };
  }
  // (4)
  const label = typeof line.unitLabel === "string" ? line.unitLabel.trim() : line.unitLabel;
  if (label != null && label !== "") {
    return { state: "piece-axis", reason: "unit line: qty is base units" };
  }
  // (5)
  const unitsPerBox = finiteOrNull(line.unitsPerBox);
  // SA-609 (#2052): a line WITH a pack snapshot decides "boxed" on it. A snapshot-less line may not
  // let the LIVE pack short-circuit to piece-axis — a product un-boxed AFTER the sale reads "not
  // boxed" though the row sold N boxes — so it falls through to the ratio test (6), which reads the
  // row's own figures and its write time.
  let packNow: number | null = null;
  let snapshotless = false;
  if (unitsPerBox != null) {
    if (!(unitsPerBox > 1)) {
      return { state: "piece-axis", reason: "not boxed — qty is already pieces" };
    }
  } else if (productPackNow !== undefined) {
    snapshotless = true;
    packNow = finiteOrNull(productPackNow);
  } else {
    return { state: "unknown", reason: "no snapshot and no product to gate on" };
  }
  // (6)
  // Snapshot-less and not boxed now: ONLY the ratio-1 case below changes (SA-609); every other
  // outcome keeps today's "not boxed — piece-axis" (a zeroed row, a malformed figure — the ratio
  // test says nothing about them, and parking them would strand returns on rows that book nothing).
  const notBoxedNow = snapshotless && !(packNow != null && packNow > 1);
  const notBoxed: SaleAxisResult = {
    state: "piece-axis",
    reason: "not boxed — qty is already pieces",
  };
  const rowQty = finiteOrNull(row.qty);
  const rowUbq = finiteOrNull(row.unitBasisQty);
  if (rowQty == null || rowUbq == null) {
    if (notBoxedNow) return notBoxed;
    return { state: "unknown", reason: "row qty/unitBasisQty is not a usable number" };
  }
  let effQty = rowQty;
  let effUbq = rowUbq;
  for (const c of corrections) {
    const cQty = finiteOrNull(c.qty);
    const cUbq = finiteOrNull(c.unitBasisQty);
    // SA-073: a non-finite correction figure is folded in as a no-op (skipped silently) rather
    // than refused — acceptable because a Decimal-typed ledger column can never actually hold a
    // non-finite value, so this branch is unreachable for a real correction row.
    if (cQty != null) effQty += cQty;
    if (cUbq != null) effUbq += cUbq;
  }
  if (effQty <= 0) {
    if (notBoxedNow) return notBoxed;
    return { state: "unknown", reason: "corrected qty is not positive" };
  }
  if (Math.abs(effUbq - effQty) < EPS) {
    if (notBoxedNow) {
      // Ratio 1, no snapshot, pack now <= 1: box axis (un-boxed since) or never boxed. Only the
      // row's WRITE time tells them apart — B661 writes boxed rows expanded, so ratio 1 after the
      // cutoff proves pack 1; before it, it cannot be told: park for the operator's attested pack.
      const written = writtenAtMs(row.writtenAt);
      if (written != null && written >= B661_CUTOFF.getTime()) return notBoxed;
      return {
        state: "unknown",
        reason: "box or piece axis can't be told — product un-boxed since",
      };
    }
    return { state: "legacy", reason: "box axis" };
  }
  if (effUbq > effQty) {
    return notBoxedNow ? notBoxed : { state: "piece-axis", reason: "pieces axis" };
  }
  if (notBoxedNow) return notBoxed;
  return { state: "unknown", reason: "malformed — unitBasisQty is less than qty" };
}
