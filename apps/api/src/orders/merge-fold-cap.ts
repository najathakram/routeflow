/**
 * B1386 (REG-B1386 S1-S6): the buyer line cap on the AFTER-CREATE sweep (`mergeAllPendingForCustomer`). The sweep runs
 * after the new order has committed, so it cannot answer a request with the 400 that create and the portal fold give.
 * It keeps the order apart instead: BEFORE any write, a loser order whose fold would push a merged line past
 * `BUYER_LINE_QTY_MAX` (and above what the winner's line already holds: rise-only) is simply not folded, and stays its
 * own pending order. No partial fold of an order and no line splitting.
 *
 * The merged piece totals are read off `buildMergeLineWrites`' own output (the very writes the sweep would apply), never
 * re-derived: an `update` or a `create` carries `qty` in pieces (a boxed merge is emitted piece-denominated by
 * `mergeBoxedContributions`; a plain line's qty is its pieces). The limit check is the shared `buyerLinesOverCap`.
 */
import { buyerLinesOverCap, type BuyerCapLine } from "./buyer-line-cap";
import * as authorship from "./line-author-channel";
import { buildMergeLineWrites, type MergeLine, type MergeLineWrite } from "./merge-line-writes";

type LineShape = {
  id?: string | null;
  productId?: string | null;
  qty: unknown;
  boxes?: unknown;
  pieces?: unknown;
};

const isSplit = (l: { boxes?: unknown; pieces?: unknown }) => l.boxes != null || l.pieces != null;

/**
 * A stored line's pieces at the pack the merge used for it (`unitsPerBox` of the write): a box-split line's qty is
 * already pieces; a box-unaware line holds selling units. A write with no pack (`null`) means the group has no pack.
 */
const storedPieces = (line: LineShape, writePack: unknown): number => {
  const pack = Number(writePack ?? 0);
  return isSplit(line) ? Number(line.qty) : Number(line.qty) * (pack > 1 ? pack : 1);
};

/**
 * The merged lines of `writes` that pass the cap and rise. Each write's pieces are its `qty`. The stored side:
 * an `update` is judged against the winner line it updates; a `create` (loser-only product, or a moved line) against
 * the largest loser line of that product, so a loser line moved over intact is not a rise.
 */
export function mergeWritesOverCap(
  writes: readonly MergeLineWrite[],
  winnerLines: readonly LineShape[],
  loserLines: readonly LineShape[],
): BuyerCapLine[] {
  const winnerById = new Map(winnerLines.filter((l) => l.id).map((l) => [l.id as string, l]));
  return buyerLinesOverCap(
    writes.map((w): BuyerCapLine => {
      if (w.kind === "update") {
        const own = winnerById.get(w.lineId);
        return {
          productId: own?.productId ?? null,
          pieces: Number(w.data.qty),
          storedPieces: own ? storedPieces(own, w.data.unitsPerBox) : 0,
        };
      }
      return {
        productId: w.data.productId,
        pieces: Number(w.data.qty),
        storedPieces: Math.max(
          0,
          ...loserLines
            .filter((l) => l.productId === w.data.productId)
            .map((l) => storedPieces(l, w.data.unitsPerBox)),
        ),
      };
    }),
  );
}

/** Does this fold involve a buyer? The sweep was buyer-initiated, or any contributing line is buyer-authored. */
export function foldInvolvesBuyer(
  orders: ReadonlyArray<
    authorship.AuthorOrder & { lineItems: ReadonlyArray<{ authorChannel?: unknown }> }
  >,
  buyerInitiated: boolean,
): boolean {
  return (
    buyerInitiated ||
    orders.some((o) => o.lineItems.some((li) => authorship.resolvedLineAuthor(li, o) === "BUYER"))
  );
}

type FoldOrder = authorship.AuthorOrder & {
  id: string;
  lineItems: ReadonlyArray<LineShape & { authorChannel?: string | null }>;
};

/**
 * Greedy in the sweep's own order (newest loser first): a loser is folded when the merged lines stay within the cap with
 * every loser already kept, else it is kept apart. Pure.
 */
export function splitLosersByCap(
  winner: FoldOrder,
  losers: readonly FoldOrder[],
  liveUnitsPerBoxFor: (productId: string) => number,
): { fold: FoldOrder[]; apart: Array<{ order: FoldOrder; over: BuyerCapLine[] }> } {
  const winnerLines = winner.lineItems.filter((li) => li.productId);
  const fold: FoldOrder[] = [];
  const apart: Array<{ order: FoldOrder; over: BuyerCapLine[] }> = [];
  for (const loser of losers) {
    const trial = [...fold, loser];
    const loserLines = authorship.loserLinesOf(trial);
    const { writes } = buildMergeLineWrites(
      winnerLines as unknown as MergeLine[],
      loserLines.filter((li) => li.productId) as unknown as MergeLine[],
      { promos: [], canEarnNew: false, categoryFor: () => null, liveUnitsPerBoxFor },
    );
    const over = mergeWritesOverCap(writes, winnerLines, loserLines);
    if (over.length > 0) apart.push({ order: loser, over });
    else fold.push(loser);
  }
  return { fold, apart };
}
