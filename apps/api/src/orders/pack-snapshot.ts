import { BadRequestException } from "@nestjs/common";

/**
 * D-20 (#1808, SA-304) — the source line's pack for a copier that re-creates a line through `OrdersService.create`
 * (today: `approveNextDelivery`, copier C8). `create()` splits and prices a NEW line at the LIVE product pack, which is
 * right for a new sale but wrong for a copy of an existing line: if the product's pack changed since the source line
 * was sold, the copy silently re-splits and re-prices at the new pack (B644 / B655 shape). The copier passes the
 * SOURCE pack; `create()` then feeds THAT pack — instead of the live one — into `normalizeBoxesPieces` and
 * `computeLineSubtotal` (`@routeflow/pricing`) for that one line, and writes it as the line's `unitsPerBox` snapshot.
 *
 * INTERNAL ONLY: this lives on `create()`'s `options` argument (a service-to-service parameter), never on a DTO or a
 * controller path (pinned in `pack-snapshot.spec.ts`), so no HTTP caller can choose a line's pack.
 *
 * Keyed by productId because `create()`'s line inputs carry no source-line id. Ambiguity is REFUSED, never resolved by
 * first match (SA-030/036): a snapshot for a product that appears on more than one draft line is a 400.
 */
export type PackSnapshots = Readonly<Record<string, number>>;

export function packForCreateLine(
  productId: string,
  livePack: number,
  snapshots: PackSnapshots | undefined,
  draftProductIds: ReadonlyArray<string | null | undefined>,
): number {
  const snap = snapshots?.[productId];
  if (snap === undefined) return livePack;
  if (!Number.isInteger(snap) || snap <= 1) {
    throw new BadRequestException({
      code: "PACK_SNAPSHOT_INVALID",
      message: `The source pack for product ${productId} is not a real box size (${snap}).`,
    });
  }
  if (draftProductIds.filter((id) => id === productId).length > 1) {
    throw new BadRequestException({
      code: "PACK_SNAPSHOT_AMBIGUOUS",
      message: `Product ${productId} appears on more than one line, so a source pack cannot be applied to a single one.`,
    });
  }
  return snap;
}
