import type { Prisma } from "@prisma/client";

/**
 * W-1187 (SA ruling, D3): the order owns its line order. `OrderItem.position` is the slot a line shows in; this module
 * is the ONE place that says how slots are read, ranked and handed out, so no writer computes a position by hand.
 *
 * Reads: `ORDER_LINE_ORDER_BY` is the one read order. It is a total order: lines made in one write share a
 * `createdAt`, so position decides, and a line with NO position (legacy rows) sorts LAST (Postgres NULLS LAST on ASC,
 * which Prisma does not add). `id` makes it stable. A pin (`line-position-writers.spec.ts`) keeps it the only such
 * literal in the API.
 *
 * Writes: a writer that APPENDS a line takes its slot from `linePositionAllocator`, which first fills the holes of an
 * order it has not written before (NULL or duplicate positions become dense 0..n-1 in the order the user sees today,
 * so nothing visibly moves) and then hands out n, n+1, ... A writer that REPLACES every line stamps its own payload
 * index, or its prior slots (`densifyOrderLines`), and needs no allocator.
 */
export const ORDER_LINE_ORDER_BY = [
  { position: "asc" as const },
  { createdAt: "asc" as const },
  { id: "asc" as const },
];

/** The fields a line is ranked on. */
export interface RankableLine {
  id: string;
  position?: number | null;
  createdAt?: Date | string | null;
}

const ms = (d: Date | string | null | undefined): number => (d ? new Date(d).getTime() : 0);

/** `ORDER_LINE_ORDER_BY` in memory: position asc with NULL last, then createdAt, then id. */
export function compareOrderLines(a: RankableLine, b: RankableLine): number {
  const pa = a.position ?? Number.POSITIVE_INFINITY;
  const pb = b.position ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa < pb ? -1 : 1;
  return ms(a.createdAt) - ms(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** A copy of `lines` in the read order. */
export function sortOrderLines<T extends RankableLine>(lines: readonly T[]): T[] {
  return [...lines].sort(compareOrderLines);
}

/** line id -> its 0-based rank in the read order (the slot a line shows in today). */
export function lineRanks(lines: readonly RankableLine[]): Map<string, number> {
  return new Map(sortOrderLines(lines).map((l, i) => [l.id, i]));
}

/**
 * The sequence a merge appends the losers' lines in: losers by the order they were started (`createdAt`, then id,
 * independent of which cart was touched last), inside each loser its lines in the read order. Returns line id ->
 * sequence rank, for EVERY loser line (catalog and unlisted).
 */
export function loserLineRanks(
  losers: ReadonlyArray<{
    id: string;
    createdAt?: Date | string | null;
    lineItems: ReadonlyArray<RankableLine>;
  }>,
): Map<string, number> {
  const ordered = [...losers].sort(
    (a, b) => ms(a.createdAt) - ms(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const ranks = new Map<string, number>();
  for (const loser of ordered) {
    for (const line of sortOrderLines(loser.lineItems)) ranks.set(line.id, ranks.size);
  }
  return ranks;
}

export interface SlotPlanner {
  /** The slot a line already holds today (its rank in the read order), or undefined for an unknown id. */
  slotOf(lineId: string): number | undefined;
  /**
   * The slot for one line of a replace payload: the slot of the stored line it replaces (`sourceLineId`; an unlisted
   * entry, which names no line, takes the first unclaimed stored unlisted line of the same name), else the next slot
   * after every stored line. A stored line's slot is handed out once.
   */
  slotFor(entry: {
    sourceLineId?: string | null;
    productId?: string | null;
    name?: string | null;
  }): number;
}

/**
 * Plans the slots of a REPLACE edit (a buyer's or driver's list: every line is deleted and recreated under a new id) from
 * the lines as they are stored BEFORE the delete. A replace that keeps each surviving line in its own slot never reorders.
 */
export function replaceSlotPlanner(
  stored: ReadonlyArray<RankableLine & { productId?: string | null; name?: string | null }>,
): SlotPlanner {
  const ranks = lineRanks(stored);
  const claimed = new Set<string>();
  const unlistedByName = new Map<string, string[]>();
  for (const l of sortOrderLines(stored)) {
    if (l.productId) continue;
    const key = (l.name ?? "").trim();
    unlistedByName.set(key, [...(unlistedByName.get(key) ?? []), l.id]);
  }
  let appendAt = ranks.size;
  const take = (id: string | undefined): number | undefined => {
    if (!id || claimed.has(id)) return undefined;
    const slot = ranks.get(id);
    if (slot !== undefined) claimed.add(id);
    return slot;
  };
  return {
    slotOf: (lineId) => ranks.get(lineId),
    slotFor(entry) {
      const named = entry.sourceLineId ? take(entry.sourceLineId) : undefined;
      if (named !== undefined) return named;
      if (!entry.productId) {
        const queue = unlistedByName.get((entry.name ?? "").trim()) ?? [];
        while (queue.length > 0) {
          const slot = take(queue.shift());
          if (slot !== undefined) return slot;
        }
      }
      return appendAt++;
    },
  };
}

/**
 * Rewrites an order's lines (CANCELLED rows included: they hold a slot too) to dense, unique positions 0..n-1 in the read
 * order, touching only the rows whose value changes. Returns n. Never reorders: it only fills holes and breaks ties the
 * way the read order already did.
 */
export async function densifyOrderLines(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<number> {
  const lines = await tx.orderItem.findMany({
    where: { orderId },
    select: { id: true, position: true },
    orderBy: ORDER_LINE_ORDER_BY,
  });
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].position !== i) {
      await tx.orderItem.update({ where: { id: lines[i].id }, data: { position: i } });
    }
  }
  return lines.length;
}

export interface LinePositionAllocator {
  /** The next free slot. The first call densifies the order, so a writer that never appends costs nothing. */
  next(): Promise<number>;
}

/**
 * Hands out append slots for `orderId` inside the caller's transaction (which already holds the order row lock). Lazy: the
 * read and the densify happen on the first `next()`, so an edit that adds nothing issues no query.
 */
export function linePositionAllocator(
  tx: Prisma.TransactionClient,
  orderId: string,
): LinePositionAllocator {
  let following: number | null = null;
  return {
    async next() {
      if (following === null) following = await densifyOrderLines(tx, orderId);
      return following++;
    },
  };
}

/**
 * A buyer's or driver's replace deletes only its own lines; the rows it never deleted (unlisted lines, the seller's
 * CANCELLED rows) keep the slot the plan gives them. Writes only the rows whose slot differs.
 */
export async function restampKeptLines(
  tx: Prisma.TransactionClient,
  lines: ReadonlyArray<{
    id: string;
    position?: number | null;
    productId?: string | null;
    status?: string | null;
  }>,
  plan: SlotPlanner,
): Promise<void> {
  for (const kept of lines) {
    const slot = plan.slotOf(kept.id);
    const keptRow = kept.productId == null || kept.status === "CANCELLED";
    if (keptRow && slot !== undefined && kept.position !== slot) {
      await tx.orderItem.update({ where: { id: kept.id }, data: { position: slot } });
    }
  }
}

/**
 * The tail of a buyer's or driver's replace (B51): the rows it never deleted (`kept`: staff unlisted lines, CANCELLED
 * rows; a buyer's edit only, `restamp`) keep the slot the plan gives them, then one dense renumber closes the gaps a removed line
 * leaves and breaks any tie.
 */
export async function settleReplaceSlots(
  tx: Prisma.TransactionClient,
  orderId: string,
  kept: Parameters<typeof restampKeptLines>[1],
  plan: SlotPlanner,
  restamp: boolean,
): Promise<void> {
  if (restamp) await restampKeptLines(tx, kept, plan);
  await densifyOrderLines(tx, orderId);
}
