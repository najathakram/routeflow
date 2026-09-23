/**
 * B776 (CRITICAL, SA-101(1)) — a boxed merge (`mergeAllPendingForCustomer`,
 * `forceConsolidateCustomer`, the hourly sweep) used to re-split every contributing line's
 * combined piece count using the PRODUCT'S CURRENT live `unitsPerBox`, while still billing at
 * each contribution's OLD stored `unitPrice` (a per-box price at the OLD pack size). A repack
 * from 12 to 6 doubled the charge on the merged line; a product made unboxed charged roughly
 * `unitsPerBox`-times over.
 *
 * The fix: resolve EACH contribution's own pack independently (never the live product row), then
 * group contributions by that resolved pack before folding. Disagreeing packs are never folded
 * together and the merge/sweep is never refused for it — each pack gets its OWN output line, at
 * its own snapshot and price, with a warn.
 *
 * SA-107a: `deriveUnitsPerBox` (`merge-items.ts`) is the FIRST implementation of the "own
 * snapshot, else derive from the line's own boxes/pieces/qty" precedence — `resolveLinePack` is
 * built ON it, not a second copy of the same two steps. `merge-items.ts` itself is untouched by
 * this import (frozen byte-identical by F06's R12); only its THIRD step (falling back to the
 * live pack) is new here, since `deriveUnitsPerBox` returns 0 rather than knowing what to do
 * with an unresolved pack.
 */
import { deriveUnitsPerBox } from "./merge-items";

/** SA-101(1)(a): per-contribution pack precedence, own snapshot first, live pack last. */
export interface PackCandidate {
  qty: unknown;
  boxes: number | null;
  pieces: number | null;
  /** The pack this line's own `boxes`/`pieces` split was actually priced at, if stamped. */
  unitsPerBox: number | null;
}

export interface PackResolution {
  pack: number;
  /** True only when NEITHER the line's own snapshot NOR its own split could resolve a pack —
   * the live product pack was used instead (SA-101(1)(a)'s last-resort, box-unaware case). */
  usedLivePack: boolean;
}

/**
 * (a)+(b) `deriveUnitsPerBox` (`merge-items.ts`): own `unitsPerBox` snapshot, else derive it from
 * the line's own `boxes`/`pieces`/`qty` triple (`qty` is total pieces = `boxes * pack + pieces`
 * with `pieces < pack` by construction — `normalizeBoxesPieces`'s own invariant — so `pack` is
 * exactly recoverable, regardless of what the live product pack currently is). Else (c) — nothing
 * resolved (a box-unaware line: `boxes`/`pieces` both null, `qty` a bare selling-unit/box count,
 * or a degenerate split `deriveUnitsPerBox` can't derive from) — the ONLY remaining signal is the
 * live product pack, used with a warn.
 */
export function resolveLinePack(c: PackCandidate, liveUnitsPerBox: number): PackResolution {
  const own = deriveUnitsPerBox(c);
  if (own > 1) return { pack: own, usedLivePack: false };
  return { pack: liveUnitsPerBox, usedLivePack: true };
}

export interface PackGroup<T> {
  pack: number;
  /** True when `winner` (the caller's designated "existing line" contribution) belongs here. */
  isWinnerGroup: boolean;
  contributions: T[];
  /**
   * True when this group is exactly one contribution and it is NOT the winner — a loser line
   * simply MOVING onto the winner order, nothing to fold it with. SA-101(1)(b): carried
   * byte-identical, never re-split through `mergeBoxedContributions`/`computeLineSubtotal`.
   */
  isSingleMove: boolean;
}

export interface GroupedContributions<T> {
  groups: PackGroup<T>[];
  /** Every distinct resolved pack seen for this product, ascending — for the warn/counter. */
  packsSeen: number[];
  /** True when 2+ distinct packs were resolved — the caller logs a warn and bumps a counter. */
  disagreement: boolean;
  usedLivePack: boolean;
}

/**
 * Groups every contribution for ONE product by its resolved pack. `winner`, when present, is the
 * contribution object identity (`===`) that already has an existing OrderItem row — its group
 * becomes an UPDATE; every other group becomes a fresh CREATE. Never refuses, never folds across
 * a disagreement (SA-101(1)(b)) — that refusal belongs only to the interactive replace-all/
 * scan-merge site (a different function), never the sweep or the pending-order merge.
 */
export function groupContributionsByPack<T extends PackCandidate>(
  winner: T | undefined,
  losers: readonly T[],
  liveUnitsPerBox: number,
): GroupedContributions<T> {
  const all: T[] = winner ? [winner, ...losers] : [...losers];
  const byPack = new Map<number, T[]>();
  let usedLivePack = false;
  for (const c of all) {
    const { pack, usedLivePack: live } = resolveLinePack(c, liveUnitsPerBox);
    usedLivePack = usedLivePack || live;
    const list = byPack.get(pack) ?? [];
    list.push(c);
    byPack.set(pack, list);
  }
  const packsSeen = [...byPack.keys()].sort((a, b) => a - b);
  const groups: PackGroup<T>[] = packsSeen.map((pack) => {
    const contributions = byPack.get(pack)!;
    return {
      pack,
      isWinnerGroup: winner != null && contributions.includes(winner),
      contributions,
      isSingleMove: contributions.length === 1 && contributions[0] !== winner,
    };
  });
  return { groups, packsSeen, disagreement: packsSeen.length > 1, usedLivePack };
}
