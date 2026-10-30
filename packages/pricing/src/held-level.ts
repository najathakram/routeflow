import { roundMoney } from "./pricing";
import {
  resolveLadderLevel,
  UnknownUnitError,
  type LadderProduct,
  type LadderUnit,
  type Numeric,
} from "./unit-levels";

// SA-1044 (B11a): what an EXISTING line's held unit level is worth against the LIVE ladder. One
// predicate, shared by the orders and invoice write paths, so the two can never disagree:
//  - "gone":    the ladder no longer names the held label (level deleted or renamed);
//  - "resized": it names it, but at a different factor than the line was sold at (the Case went
//               100 -> 200, or a legacy label is now the pack word);
//  - "live":    same label, same factor — re-resolve from the ladder as today;
//  - "unknown": the held snapshot itself is unusable (blank label, no positive factor, no valid
//               price). Never silently "live": the caller keeps today's path and warns once.
// A held line that is gone or resized bills at its SNAPSHOT (`heldSnapshotPrices`); B11a never
// converts it to the new size.

export type HeldLevelState = "live" | "gone" | "resized" | "unknown";

export interface HeldLevel {
  unitLabel?: string | null;
  unitsPerBox?: number | null;
  unitPrice?: Numeric | null;
  originalPrice?: Numeric | null;
}

/** Does the live ladder still name `label`? (the pack, the base, or a level row) */
export function ladderNames(
  product: LadderProduct,
  units: readonly LadderUnit[],
  label: string,
): boolean {
  try {
    resolveLadderLevel(product, units, label);
    return true;
  } catch (e) {
    if (e instanceof UnknownUnitError) return false;
    throw e;
  }
}

export function heldLevelState(
  held: HeldLevel,
  product: LadderProduct,
  units: readonly LadderUnit[],
): HeldLevelState {
  const label = (held.unitLabel ?? "").trim();
  const factor = held.unitsPerBox == null ? Number.NaN : Number(held.unitsPerBox);
  const price = held.unitPrice == null ? Number.NaN : Number(held.unitPrice);
  if (label === "" || !Number.isInteger(factor) || factor < 1) return "unknown";
  if (!Number.isFinite(price) || price < 0) return "unknown";
  let factorToBase: number;
  try {
    factorToBase = resolveLadderLevel(product, units, label).factorToBase;
  } catch (e) {
    if (e instanceof UnknownUnitError) return "gone";
    throw e;
  }
  return factorToBase === factor ? "live" : "resized";
}

/** The list / tier prices a gone-or-resized held line keeps: its own snapshot, rounded. */
export function heldSnapshotPrices(held: Pick<HeldLevel, "unitPrice" | "originalPrice">): {
  tierPrice: number;
  listPrice: number;
} {
  const tier = Number(held.unitPrice);
  return {
    tierPrice: roundMoney(tier),
    listPrice: roundMoney(held.originalPrice == null ? tier : Number(held.originalPrice)),
  };
}
