import { BadRequestException } from "@nestjs/common";

/**
 * B652 / SA-176: a unit (Case/Pallet) line's quantity is a count of its unit, so an invoice line
 * built from it may only bill a WHOLE number of units. Order/invoice `qty` on such a line is base
 * pieces (count x factor), so `billQty` must be a multiple of the LINE's own `unitsPerBox` (never the
 * live product's — SA-029/SA-158). Anything else would print "4 boxes + 4 pcs" under a Case label,
 * silently changing the denomination the customer bought. Refuse before any write; a full remainder
 * is always a multiple, so the normal path is untouched. A pack line (no unitLabel) is not checked.
 *
 * A non-multiple reaching the delivered-basis path means a delivery evidence row for a unit line was
 * written in pieces: a data error surfaced loudly here, never billed around.
 */
export function assertWholeUnitQty(
  li: {
    unitLabel?: string | null;
    unitsPerBox?: unknown;
    name?: string | null;
    product?: { name?: string | null } | null;
  },
  billQty: number,
  unitsPerBoxOverride?: number | null,
): void {
  const label = (li.unitLabel ?? "").trim();
  if (label === "") return;
  const per = Number(unitsPerBoxOverride ?? li.unitsPerBox ?? 0);
  if (!(per > 1)) return; // a factor-1 unit is a plain per-piece line
  const remainder = Math.abs(billQty / per - Math.round(billQty / per)) * per;
  if (remainder < 0.001) return;
  const lo = Math.floor(billQty / per) * per;
  const hi = lo + per;
  const name = li.product?.name ?? li.name ?? "this line";
  const nearest = lo > 0 ? `${lo} or ${hi}` : `${hi}`;
  throw new BadRequestException(
    `Requested qty ${billQty} of ${name} is not a whole ${label} (1 ${label} = ${per} pieces); bill ${nearest} instead.`,
  );
}
