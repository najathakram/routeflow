import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { packLabelOf, type LadderUnit } from "@routeflow/pricing";
import { loadUnitLadders } from "../orders/unit-line-build";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { resolveLineUnits, type LineUnitsProduct } from "../products/line-units";

/**
 * SA-828 (row 657): the pure unit -> pieces conversion behind `POST /inventory/products/:id/count`.
 * The factor is the SERVER's (the product's ladder through `resolveLineUnits`, the one place a
 * line's factor is decided) - a client never sends one. A packed unit is counted whole: half a Case
 * is a 400 COUNT_FRACTIONAL_PACK ("count in pieces" instead); only a factor-1 unit may be fractional.
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

const MAX_PIECES = new Prisma.Decimal("9999999.999");

/** "Case" -> "Cases", "Box" -> "Boxes". */
const plural = (label: string) => (/(s|x|z|ch|sh)$/i.test(label) ? `${label}es` : `${label}s`);

/**
 * The pieces in `parts` (each part resolved and checked on its own, then summed), rounded to 3 dp -
 * the movement column's scale. Pieces are unsigned; the caller applies an ADJUST's sign afterwards.
 */
export function piecesOf(
  product: CountProduct,
  ladder: readonly LadderUnit[],
  parts: readonly CountPart[],
): { pieces: Prisma.Decimal; parts: CountedPart[] } {
  const counted = parts.map((part): CountedPart => {
    const resolved = resolveLineUnits(product, ladder, { unitLabel: part.unit ?? null });
    // A plain pack counts its real size; a pack that has none (or 1) is one piece.
    const factor =
      resolved.kind === "pack"
        ? resolved.unitsPerBox > 1
          ? resolved.unitsPerBox
          : 1
        : resolved.unitsPerBox;
    const unit = resolved.unitLabel ?? packLabelOf(product);
    if (factor > 1 && !Number.isInteger(part.quantity)) {
      throw new BadRequestException({
        code: API_ERROR_CODES.COUNT_FRACTIONAL_PACK,
        message: `Count whole ${plural(unit)}, or count in pieces.`,
      });
    }
    return {
      unit,
      quantity: part.quantity,
      factor,
      pieces: new Prisma.Decimal(part.quantity).times(factor),
    };
  });
  const pieces = counted
    .reduce((sum, p) => sum.plus(p.pieces), new Prisma.Decimal(0))
    .toDecimalPlaces(3);
  // The movement column is Decimal(10,3): a count that cannot be stored is a 400, not a database error.
  if (pieces.gt(MAX_PIECES)) {
    throw new BadRequestException("That is more pieces than one count can hold. Count less.");
  }
  return { pieces, parts: counted };
}

/** "3 Case + 4 Piece" - what was counted, for the movement's note. */
export function describeParts(parts: readonly Pick<CountedPart, "unit" | "quantity">[]): string {
  return parts.map((p) => `${p.quantity} ${p.unit}`).join(" + ");
}

/** The product's ladder for a count (tenant-scoped client, like every ladder read). */
export async function ladderOf(
  db: Parameters<typeof loadUnitLadders>[0],
  productId: string,
): Promise<LadderUnit[]> {
  return (await loadUnitLadders(db, [productId])).get(productId) ?? [];
}
