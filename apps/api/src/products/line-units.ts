import { BadRequestException, ConflictException } from "@nestjs/common";
import {
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
 *      product is not consulted.
 *   3. No label anywhere ⇒ exactly today's behaviour: `Number(product.unitsPerBox ?? 0)`, and no
 *      `unitLabel` is persisted (NULL = the pack, byte for byte).
 *
 * `line-units-callsites.spec.ts` ratchets the remaining direct `product.unitsPerBox` reads in the
 * line-writing services down to zero.
 */

export interface LineUnitsExisting {
  unitLabel?: string | null;
  /** The line's own snapshotted factor (OrderItem/InvoiceItem.unitsPerBox). */
  unitsPerBox?: number | string | null;
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

export function resolveLineUnits(
  product: LadderProduct,
  units: readonly LadderUnit[],
  requested?: { unitLabel?: string | null } | null,
  existing?: LineUnitsExisting | null,
): ResolvedLineUnits {
  const askedRaw = (requested?.unitLabel ?? "").trim();
  const held = (existing?.unitLabel ?? "").trim();

  // Rule 2: a rewrite that names no (different) unit keeps the line's own snapshot.
  if (held && (!askedRaw || askedRaw.toLowerCase() === held.toLowerCase())) {
    const snap = toFactor(existing?.unitsPerBox);
    if (snap === 0) {
      throw new ConflictException(
        `This line is sold by the ${held} but has no recorded size, so it can't be edited safely. Remove it and add it again.`,
      );
    }
    return { unitsPerBox: snap, unitLabel: held, kind: snap === 1 ? "piece" : "level" };
  }

  // Rule 1 / 3: resolve by label against the server ladder (absent label = the pack).
  let level;
  try {
    level = resolveLadderLevel(product, units, askedRaw || null);
  } catch (e) {
    if (e instanceof UnknownUnitError) {
      throw new BadRequestException(`"${e.unitLabel}" is not a unit of this product.`);
    }
    throw e;
  }
  // "Piece" on a product with no pack size is just the product itself — no unit-aware line.
  const packIsBoxed = Number(product.unitsPerBox ?? 0) > 1;
  if (level.kind === "pack" || (level.kind === "piece" && !packIsBoxed)) {
    // Byte-identical to every pre-units site: 0/null stays 0, never coerced to 1.
    return { unitsPerBox: Number(product.unitsPerBox ?? 0), unitLabel: null, kind: "pack" };
  }
  return { unitsPerBox: level.factorToBase, unitLabel: level.label, kind: level.kind };
}

/**
 * What to store in `line.unitsPerBox`. A unit-aware line ALWAYS snapshots its factor (even 1, for a
 * Piece line on a boxed product — otherwise a later rewrite would re-derive the live pack size);
 * a plain pack line keeps today's rule: only a box-split line over a real pack snapshots it.
 */
export function lineUnitsPerBoxSnapshot(
  resolved: ResolvedLineUnits,
  boxes: number | null | undefined,
): number | null {
  if (resolved.unitLabel != null) return resolved.unitsPerBox;
  return boxes != null && resolved.unitsPerBox > 1 ? resolved.unitsPerBox : null;
}
