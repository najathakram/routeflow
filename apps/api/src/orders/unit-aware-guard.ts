import { ConflictException } from "@nestjs/common";

/**
 * units_v1 — the fail-closed net under every path that REWRITES existing lines.
 *
 * A "unit-aware" line is one sold by a non-pack unit (`unitLabel != null`: a Case, a Pallet, or a
 * Piece off a boxed pack) and carries its OWN factor in `unitsPerBox`. Most order/invoice
 * rewrite paths were written when a line's unit could only ever be the pack, so they re-derive the
 * factor, the price and the tier from the LIVE product and match "the same line" by `productId`
 * alone — which would silently re-price a Case line at the pack's size (the verified 4× overcharge)
 * or fold it into a pack line of the same product.
 *
 * Until each path is converted to `resolveLineUnits` (./products/line-units.ts), it must REFUSE to
 * touch such a line, with a message an operator can act on. `unit-aware-guard-callsites.spec.ts`
 * fails the build if any listed rewrite path stops calling this. Converting a path means deleting
 * its guard call in the same PR that makes it unit-aware and updating that spec.
 *
 * Nothing can create a unit-aware line yet (no DTO accepts `unitLabel`), so this is inert today.
 */
export const UNIT_AWARE_LINE = "UNIT_AWARE_LINE";

interface LineLike {
  unitLabel?: string | null;
  status?: string | null;
}

/** A live (not CANCELLED) line sold by a non-pack unit. */
export const isUnitAwareLine = (li: LineLike | null | undefined): boolean =>
  !!li && li.unitLabel != null && li.unitLabel !== "" && li.status !== "CANCELLED";

/**
 * Prisma `where` fragment: orders with NO live unit-aware line. Add it to any query that picks
 * merge candidates, so a unit-aware order is treated like an operator-separated (skipAutoMerge) one.
 */
export const ORDER_HAS_NO_UNIT_AWARE_LINE = {
  lineItems: { none: { unitLabel: { not: null }, status: { not: "CANCELLED" } } },
} as const;

/** Throws 409 `UNIT_AWARE_LINE` if any of `lines` is a live unit-aware line. */
export function assertNoUnitAwareLines(
  lines: ReadonlyArray<LineLike> | null | undefined,
  action = "edited this way",
): void {
  const hit = (lines ?? []).find(isUnitAwareLine);
  if (!hit) return;
  throw new ConflictException({
    code: UNIT_AWARE_LINE,
    message: `A line on this order is sold by the ${hit.unitLabel}, so it can't be ${action} yet. Edit it from the web order screen.`,
  });
}
