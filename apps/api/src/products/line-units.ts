import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  PIECE_LABEL,
  UnknownUnitError,
  resolveLadderLevel,
  type LadderProduct,
  type LadderUnit,
} from "@routeflow/pricing";

/**
 * THE one place an order/invoice line's pack factor is decided (units_v1, step 4).
 *
 * Every line writer used to read `product.unitsPerBox` straight off the LIVE product — which is
 * only safe while a line's unit can never differ from the pack. With unit levels (Case, Pallet,
 * Piece) a line carries its OWN factor + `unitLabel`, and re-deriving the factor from the live
 * pack would silently re-price a case line at the pack's size (the verified 4× money bug).
 * So the rules are:
 *   1. The SERVER resolves the factor from the product's ladder by label — never from the client.
 *   2. A line that already carries a `unitLabel` keeps ITS snapshot factor on a rewrite; the live
 *      product is not consulted. (If the snapshot is missing it is recovered from the ladder by
 *      label — never guessed from the pack.)
 *   3. No label anywhere ⇒ exactly today's behaviour: `Number(product.unitsPerBox ?? 0)`, and no
 *      `unitLabel` is persisted (NULL = the pack, byte for byte).
 *
 * `requested.unitLabel`: `undefined` = "unchanged" (keep the line's unit); `null`/"" = an explicit
 * "sell by the pack" (clears a unit-aware line); a string = that unit.
 *
 * `line-units-callsites.spec.ts` ratchets the remaining direct `product.unitsPerBox` reads in the
 * line-writing services down to zero.
 */

/** All the helper reads off a product: the pack's label and size. */
export type LineUnitsProduct = Pick<LadderProduct, "unit" | "unitsPerBox">;

export interface LineUnitsExisting {
  unitLabel?: string | null;
  /** The line's own snapshotted factor (OrderItem/InvoiceItem.unitsPerBox). */
  unitsPerBox?: number | null;
}

export interface ResolvedLineUnits {
  /** Pieces per ONE of the line's selling unit — the factor every downstream helper uses. */
  unitsPerBox: number;
  /** Persist on the line. NULL for a plain pack line (today's data, unchanged). */
  unitLabel: string | null;
  kind: "pack" | "piece" | "level";
}

const toFactor = (v: unknown): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : 0;
};
const norm = (s: string) => s.trim().toLowerCase();
const kindOf = (label: string, factor: number): "piece" | "level" =>
  norm(label) === norm(PIECE_LABEL) || factor === 1 ? "piece" : "level";

/** The pack as a resolved (label-less) line — byte-identical to every pre-units site. */
const packLine = (product: LineUnitsProduct): ResolvedLineUnits => ({
  unitsPerBox: Number(product.unitsPerBox ?? 0),
  unitLabel: null,
  kind: "pack",
});

export function resolveLineUnits(
  product: LineUnitsProduct,
  units: readonly LadderUnit[],
  requested?: { unitLabel?: string | null } | null,
  existing?: LineUnitsExisting | null,
): ResolvedLineUnits {
  const explicit = requested?.unitLabel; // undefined = unchanged
  const asked = (explicit ?? "").trim();
  const held = (existing?.unitLabel ?? "").trim();
  const ladderProduct: LadderProduct = { pricePerUnit: 0, ...product };

  // Rule 2: a rewrite that leaves the unit unchanged (or re-sends the same one) keeps the line.
  if (held && (explicit === undefined || (asked !== "" && norm(asked) === norm(held)))) {
    let factor = toFactor(existing?.unitsPerBox);
    if (factor === 0) {
      // Snapshot missing/corrupt: recover it from the ladder BY LABEL, never from the pack.
      try {
        const lvl = resolveLadderLevel(ladderProduct, units, held);
        factor = lvl.kind === "pack" ? 0 : lvl.factorToBase;
      } catch {
        factor = 0;
      }
    }
    if (factor === 0) {
      throw new ConflictException(
        `This line is sold by the ${held} but its size is unknown, so it can't be edited safely. Ask an admin to fix the line.`,
      );
    }
    return { unitsPerBox: factor, unitLabel: held, kind: kindOf(held, factor) };
  }

  // Rule 1 / 3: resolve by label against the server ladder (absent/cleared = the pack).
  let level;
  try {
    level = resolveLadderLevel(ladderProduct, units, asked || null);
  } catch (e) {
    if (e instanceof UnknownUnitError) {
      throw new BadRequestException(`"${e.unitLabel}" is not a unit of this product.`);
    }
    throw e;
  }
  // "Piece" on a product with no pack size is just the product itself — no unit-aware line.
  const packIsBoxed = Number(product.unitsPerBox ?? 0) > 1;
  if (level.kind === "pack" || (level.kind === "piece" && !packIsBoxed)) return packLine(product);
  return { unitsPerBox: level.factorToBase, unitLabel: level.label, kind: level.kind };
}

/**
 * What to store in `line.unitsPerBox`. A unit-aware line ALWAYS snapshots its factor (even 1, for a
 * Piece line on a boxed product — otherwise a later rewrite would re-derive the live pack size).
 * A plain pack line keeps the calling site's EXISTING rule, named so a conversion cannot drift:
 *   - "boxed" (orders, invoices create/update): only a box-split line over a real pack snapshots
 *     (`boxes != null && upb > 1`).
 *   - "positive" (invoice-from-order copy, regroup): any positive factor snapshots (`upb > 0`).
 */
export function lineUnitsPerBoxSnapshot(
  resolved: ResolvedLineUnits,
  boxes: number | null | undefined,
  packRule: "boxed" | "positive" = "boxed",
): number | null {
  if (resolved.unitLabel != null) return resolved.unitsPerBox;
  if (packRule === "positive") return resolved.unitsPerBox > 0 ? resolved.unitsPerBox : null;
  return boxes != null && resolved.unitsPerBox > 1 ? resolved.unitsPerBox : null;
}
