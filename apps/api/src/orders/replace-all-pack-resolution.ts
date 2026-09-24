/**
 * SA-124g/SA-124h — R1's scope. The full SA-077 pack-resolution order (payload -> prior
 * snapshot -> live, plus R-PRICE) that SA-124e originally wired into `updateOrderItems`'
 * replace-all rebuild was reverted to master byte-for-byte (round 4): a pack-keyed fold
 * (SA-124a/SA-124c/SA-124e MED-5) deciding a line's price AND its split independently of the
 * rebuild turned out to need ONE coherent price rule across every replace-all caller
 * (staff, buyer, sweep, forceConsolidate) — R-PRICE — which is R2's scope, gated by its own
 * real-Postgres chain spec (fold -> updateOrderItems -> the stored row).
 *
 * Until R2 lands, this module carries ONLY the ONE guard R1 needs: refuse a replace-all item
 * whose OWN resolved pack disagrees with the live product pack, rather than letting the
 * reverted (pre-B776) rebuild silently re-split it at the wrong size — SA-124e's original bug,
 * now fail-closed instead of fixed. Runs inside the replace-all's own transaction, so a refusal
 * here rolls back any creates the loop already made for earlier items in the same payload.
 */

import { ConflictException } from "@nestjs/common";
import { packFromOwnSplit } from "@routeflow/pricing";

/**
 * The item's own resolved pack: `foldMergeItems`'s bucket-pack fact (`unitsPerBox`) if the
 * payload carries one, else derived from the item's own boxes/pieces/qty split. `undefined`
 * when neither resolves (a genuinely box-unaware item) — never a reason to refuse.
 */
function ownPackOf(item: {
  boxes?: number | null;
  pieces?: number | null;
  qty?: number;
  unitsPerBox?: number | null;
}): number | undefined {
  if (item.unitsPerBox != null && item.unitsPerBox > 1) return item.unitsPerBox;
  return (
    packFromOwnSplit({ qty: item.qty ?? 0, boxes: item.boxes, pieces: item.pieces }) ?? undefined
  );
}

/**
 * Throws `ConflictException` (`MERGE_PACK_MISMATCH`, matching `foldMergeItems`'s own refusal
 * shape) when the item's own resolved pack is KNOWN (> 1) and the live product pack is ALSO
 * KNOWN (> 1) and they disagree. Every other case — no own pack, no live pack, or the two
 * agree — passes through untouched; the rebuild's pre-existing live-pack split is unchanged.
 */
export function assertReplaceAllPackMatchesLive(
  item: {
    productId?: string | null;
    boxes?: number | null;
    pieces?: number | null;
    qty?: number;
    unitsPerBox?: number | null;
  },
  livePack: number,
): void {
  const ownPack = ownPackOf(item);
  if (ownPack == null || !(ownPack > 1) || !(livePack > 1) || ownPack === livePack) return;
  throw new ConflictException({
    code: "MERGE_PACK_MISMATCH",
    message: `Product ${item.productId} is priced at a ${ownPack}-pack, but the live product pack is now ${livePack} — resolve the mismatch before saving.`,
    productId: item.productId,
    existingPacks: [ownPack],
    incomingPack: livePack,
  });
}
