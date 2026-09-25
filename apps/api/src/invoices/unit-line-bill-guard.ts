import { BadRequestException } from "@nestjs/common";

/**
 * B652 / SA-178: billing a PARTIAL unit is legitimate (44 of a 96-piece, 12-per-Case line bills as
 * 3 Cases + 8 pcs, label kept, money prorated), so nothing here refuses a partial Case. Two rules:
 *
 *  1. `billPackOf`: a unit line's OWN `unitsPerBox` always wins for the split and the guard. A prior
 *     draft's pack applies only to a line with no unitLabel (a Pallet -> Case edit left the draft on
 *     the Pallet factor while the line said 12, which threw on every reconcile).
 *  2. `assertIntegerPieces`: once a line has a pack factor > 1, its quantity is a whole number of
 *     pieces (`boxes`/`pieces` are integer columns). A fractional qty (47.9995) is refused with a 400
 *     before any write: no tolerance, no snapping. A non-boxed Decimal qty (1.5 kg) is untouched, as
 *     is a quantity that is not positive (0, negative, NaN), which the callers already drop.
 */
export function billPackOf(
  li: { unitLabel?: string | null; unitsPerBox?: unknown },
  priorPack?: number | null,
  livePack?: unknown,
): number {
  if ((li.unitLabel ?? "").trim() !== "") return Number(li.unitsPerBox ?? 0);
  return Number(priorPack ?? li.unitsPerBox ?? livePack ?? 0);
}

export function assertIntegerPieces(
  li: {
    unitLabel?: string | null;
    name?: string | null;
    product?: { name?: string | null } | null;
  },
  billQty: number,
  pack: number,
): void {
  if (!(pack > 1) || !(billQty > 0.001) || Number.isInteger(billQty)) return;
  const unit = (li.unitLabel ?? "").trim() || "box";
  throw new BadRequestException(
    `Requested qty ${billQty} of ${li.product?.name ?? li.name ?? "this line"} is not a whole number of pieces (1 ${unit} = ${pack} pieces).`,
  );
}
