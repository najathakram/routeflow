import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  countFactorOf,
  countPieces,
  packLabelOf,
  pluralize,
  type LadderUnit,
} from "@routeflow/pricing";
import { loadUnitLadders } from "../orders/unit-line-build";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { resolveLineUnits, type LineUnitsProduct } from "../products/line-units";
import { lockTenantUnits } from "../units/tenant-units-lock";

/**
 * SA-828 (row 657): the pure unit -> pieces conversion behind `POST /inventory/products/:id/count`.
 * The factor is the SERVER's (the product's ladder through `resolveLineUnits`, the one place a
 * line's factor is decided) - a client never sends one. A packed unit is counted whole: half a Case
 * is a 400 COUNT_FRACTIONAL_PACK ("count in pieces" instead); only a factor-1 unit may be fractional.
 * SA-828a: a count takes parts ("3 cases + 4 boxes"), at most one per unit (400 COUNT_DUPLICATE_UNIT).
 */

export interface CountPart {
  /** A ladder label ("Case", "Piece"); null / blank = the product's own pack. */
  unit?: string | null;
  quantity: number;
}

export interface CountedPart {
  /** What the person counted in: the resolved level's label, else the pack's label. */
  unit: string;
  quantity: number;
  /** Pieces in ONE of `unit`. */
  factor: number;
  pieces: Prisma.Decimal;
}

/** The product fields the ladder reads (a Prisma product row satisfies it). */
export type CountProduct = LineUnitsProduct & {
  baseUnitLabel?: string | null;
  packLabel?: string | null;
};

export const MAX_PIECES = new Prisma.Decimal("9999999.999");

/**
 * The pieces in `parts` (each part resolved and checked on its own, then summed), rounded to 3 dp -
 * the movement column's scale. Pieces are unsigned; the caller applies an ADJUST's sign afterwards.
 */
export function piecesOf(
  product: CountProduct,
  ladder: readonly LadderUnit[],
  parts: readonly CountPart[],
): { pieces: Prisma.Decimal; parts: CountedPart[] } {
  const seen = new Set<string>();
  const counted = parts.map((part): CountedPart => {
    const resolved = resolveLineUnits(product, ladder, { unitLabel: part.unit ?? null });
    // The factor rule and the sum are @routeflow/pricing's (SA-957 M2): the web preview uses the same two.
    const factor = countFactorOf({ kind: resolved.kind, factorToBase: resolved.unitsPerBox });
    const unit = resolved.unitLabel ?? packLabelOf(product);
    // At most one part per ladder level, judged on the RESOLVED unit: the pack named two ways
    // (no unit and its own label) is one unit, as are labels that differ only in case.
    const key = unit.trim().toLowerCase();
    if (seen.has(key)) {
      throw new BadRequestException({
        code: API_ERROR_CODES.COUNT_DUPLICATE_UNIT,
        message: `Count ${pluralize(unit)} once.`,
      });
    }
    seen.add(key);
    if (factor > 1 && !Number.isInteger(part.quantity)) {
      throw new BadRequestException({
        code: API_ERROR_CODES.COUNT_FRACTIONAL_PACK,
        message: `Count whole ${pluralize(unit)}, or count in pieces.`,
      });
    }
    return {
      unit,
      quantity: part.quantity,
      factor,
      pieces: new Prisma.Decimal(part.quantity).times(factor),
    };
  });
  const pieces = new Prisma.Decimal(
    countPieces(counted.map((p) => ({ quantity: p.quantity, factor: p.factor }))),
  );
  // The movement column is Decimal(10,3): a count that cannot be stored is a 400, not a database error.
  if (pieces.gt(MAX_PIECES)) {
    throw new BadRequestException("That is more pieces than one count can hold. Count less.");
  }
  return { pieces, parts: counted };
}

/**
 * "3 Case (x24) + 4 Box (x12) = 120 pieces" - what was counted, with the factors the server resolved,
 * for the movement's note: a later ladder change can still explain the number (SA-828a).
 */
export function describeParts(
  parts: readonly Pick<CountedPart, "unit" | "quantity" | "factor">[],
  pieces: Prisma.Decimal,
): string {
  const each = parts.map((p) => `${p.quantity} ${p.unit} (x${p.factor})`).join(" + ");
  return `${each} = ${pieces.toString()} pieces`;
}

/**
 * SA-828a (the SA-826 order): the count's ladder, read INSIDE its transaction after the tenant-units
 * SHARED lock, so a unit rename can't change a factor mid-count. Take it first in the tx, before the
 * stock lock (tenant-units SHARED -> product rows), as every holder of the tenant lock does.
 */
export async function lockedLadderOf(
  tx: Parameters<typeof lockTenantUnits>[0] & Parameters<typeof loadUnitLadders>[0],
  tenantId: string,
  productId: string,
): Promise<LadderUnit[]> {
  await lockTenantUnits(tx, tenantId, "shared");
  return (await loadUnitLadders(tx, [productId])).get(productId) ?? [];
}
