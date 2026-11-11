import { ItemStatus, type Prisma, type PriceType } from "@prisma/client";
import { computeLineSubtotal } from "@routeflow/pricing";
import { resolvedLineAuthor, type OrderItemAuthorChannel } from "./line-author-channel";

/** A catalog-free loser line, ready to be appended to the merge winner as its own new line. */
export interface UnlistedMergeItem {
  name: string | null;
  qty: number;
  unitPrice: number;
  priceType: PriceType;
  originalPrice: number | null;
  overrideReason: string | null;
  overriddenBy: string | null;
  notes: string | null;
  /** SA ruling (#3418): the moved line's own author (its marker, else its loser order's rule). */
  authorChannel: OrderItemAuthorChannel;
  /** W-1187 (D4): the line's rank in the sequence the merge appends in (`loserLineRanks`), shared with the catalog creates. */
  appendRank: number;
}

/**
 * Unlisted (catalog-free) loser lines can't be keyed by product — each is appended to the winner as its
 * own new line (never boxed, unaffected by B776). A verbatim move of the loop `mergeAllPendingForCustomer`
 * and `forceConsolidateCustomer` each carried inline (pure: no query, no write).
 * `createUnlistedLoserLine` below is the one write both merges share.
 */
export function collectUnlistedLoserItems(
  losers: ReadonlyArray<{
    source?: string | null;
    sourceRecorded?: boolean | null;
    lineItems: ReadonlyArray<{
      id: string;
      authorChannel?: string | null;
      productId: string | null;
      name: string | null;
      qty: unknown;
      unitPrice: unknown;
      priceType: PriceType;
      originalPrice: unknown;
      overrideReason: string | null;
      overriddenBy: string | null;
      notes: string | null;
    }>;
  }>,
  ranks: ReadonlyMap<string, number>,
): UnlistedMergeItem[] {
  const unlistedNewItems: UnlistedMergeItem[] = [];
  for (const loser of losers) {
    for (const li of loser.lineItems) {
      if (li.productId) continue;
      unlistedNewItems.push({
        name: li.name,
        qty: Number(li.qty),
        unitPrice: Number(li.unitPrice),
        priceType: li.priceType,
        originalPrice: li.originalPrice !== null ? Number(li.originalPrice) : null,
        overrideReason: li.overrideReason,
        overriddenBy: li.overriddenBy,
        notes: li.notes,
        authorChannel: resolvedLineAuthor(li, loser),
        appendRank: ranks.get(li.id) ?? Number.MAX_SAFE_INTEGER,
      });
    }
  }
  return unlistedNewItems;
}

/** Appends one unlisted loser line to the merge winner as its own new line, in the slot the caller's allocator gave it. */
export async function createUnlistedLoserLine(
  tx: Prisma.TransactionClient,
  winnerId: string,
  data: UnlistedMergeItem,
  position: number,
): Promise<void> {
  await tx.orderItem.create({
    data: {
      orderId: winnerId,
      productId: null,
      name: data.name,
      qty: data.qty,
      unitPrice: data.unitPrice,
      subtotal: computeLineSubtotal({ unitPrice: data.unitPrice, qty: data.qty }),
      status: ItemStatus.PENDING,
      priceType: data.priceType,
      originalPrice: data.originalPrice,
      overrideReason: data.overrideReason,
      overriddenBy: data.overriddenBy,
      notes: data.notes,
      authorChannel: data.authorChannel, // SA ruling #3418: the moved line's own author
      position,
    },
  });
}
