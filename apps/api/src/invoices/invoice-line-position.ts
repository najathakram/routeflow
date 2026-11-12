import { lineRanks, type RankableLine } from "../orders/line-position";
import { sortInvoiceLines, type InvoiceLineOrderFacts } from "./invoice-line-order";

/**
 * W-1187 (D1, D6): an invoice line's `position` is the slot the staff gave its ORDER line, so the printed bill follows
 * the order. Two helpers, nothing else computes a position or a shown order:
 *
 *  - `rankInvoiceLines` / `stampInvoicePositions` (write side): every InvoiceItem writer calls one of them. Lines that
 *    carry an `orderItemId` the order ranks come first, in the ORDER's read order (`orders/line-position.ts`, never the
 *    request or array order: a partial bill requested [Apple, Zebra] on an order built [Zebra, Apple] stores Zebra
 *    first); the rest (a manual line, the NSF fee) follow in the order they were handed in. Dense 0..n-1.
 *  - `invoiceLinesInOrder` (read side): the ONE shown order. Every line positioned -> `[position, createdAt, id]`.
 *    Any line without a position -> `sortInvoiceLines` (SA-1058), the permanent A-Z fallback of a legacy invoice
 *    (owner Q2: old invoices print as they did, no backfill ever). It returns a NEW array (SA-874: the hashed send
 *    snapshot is never sorted in place), and `position` is not a fingerprint field.
 */

/** order line id -> its 0-based rank in the order's read order. */
export type OrderLineRanks = ReadonlyMap<string, number>;

/** The ranks of an order's lines (the slot each shows in today). Pass the order's UNCANCELLED lines. */
export function orderLineRanks(orderLines: readonly RankableLine[]): OrderLineRanks {
  return lineRanks(orderLines);
}

/** The position for each line, index-aligned with `lines`: dense 0..n-1, linked lines by the order's rank first. */
export function rankInvoiceLines(lines: readonly object[], ranks?: OrderLineRanks): number[] {
  const link = (l: object) => (l as { orderItemId?: string | null }).orderItemId ?? null;
  const linked: number[] = [];
  const rest: number[] = [];
  lines.forEach((l, i) => {
    const to = link(l);
    (to && ranks?.has(to) ? linked : rest).push(i);
  });
  linked.sort((a, b) => ranks!.get(link(lines[a])!)! - ranks!.get(link(lines[b])!)! || a - b);
  const out = new Array<number>(lines.length);
  [...linked, ...rest].forEach((lineIndex, rank) => {
    out[lineIndex] = rank;
  });
  return out;
}

/** Writes `position` onto each line's own data object (the writer keeps its references) and returns the array. */
export function stampInvoicePositions<T extends object>(lines: T[], ranks?: OrderLineRanks): T[] {
  const positions = rankInvoiceLines(lines, ranks);
  lines.forEach((l, i) => {
    (l as { position?: number }).position = positions[i];
  });
  return lines;
}

type ShownLine = InvoiceLineOrderFacts & { position?: unknown; createdAt?: Date | string | null };

const ms = (d: Date | string | null | undefined): number => (d ? new Date(d).getTime() : 0);

/** The one order an invoice's lines are shown in. A copy; `items` is never mutated. */
export function invoiceLinesInOrder<T extends ShownLine>(items: readonly T[]): T[] {
  if (items.length === 0) return [];
  const allPositioned = items.every((l) => typeof l.position === "number");
  if (!allPositioned) return sortInvoiceLines(items);
  return [...items].sort(
    (a, b) =>
      (a.position as number) - (b.position as number) ||
      ms(a.createdAt) - ms(b.createdAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * An edit of a LEGACY invoice (a stored line with no position: it prints A-Z for good, owner Q2 / D2) that leaves the
 * surviving lines in the order they are shown in must write no position: an unchanged save stays a no-op, and the
 * invoice stays legacy. Only an edit that actually changes the order stamps (the invoice then follows its own order).
 * `editRowIds` is the saved payload in order: the stored row id of each line, null/undefined for a new line.
 */
export function legacyOrderKept<S extends ShownLine>(
  stored: readonly S[],
  editRowIds: ReadonlyArray<string | null | undefined>,
): boolean {
  if (stored.length === 0 || stored.every((l) => typeof l.position === "number")) return false;
  const surviving = new Set(editRowIds.filter((id): id is string => !!id));
  const shown = invoiceLinesInOrder(stored)
    .map((l) => l.id)
    .filter((id) => surviving.has(id));
  const saved = editRowIds.filter((id): id is string => !!id);
  return shown.length === saved.length && shown.every((id, i) => id === saved[i]);
}

/** `stampInvoicePositions` for lines billed from an order: ranks come from the order's UNCANCELLED lines. */
export function stampFromOrder<T extends object>(
  lines: T[],
  orderLines: readonly RankableLine[],
): T[] {
  return stampInvoicePositions(lines, orderLineRanks(orderLines));
}

/** The slice of a Prisma client the DB-side helpers use (a transaction or the tenant client). */
interface PositionDb {
  order: {
    findUnique: (args: any) => Promise<any>;
  };
  invoiceItem: { update: (args: any) => Promise<unknown> };
}

/** Ranks of an order's uncancelled lines, read inside the caller's transaction (an edit of a linked invoice). */
export async function loadOrderLineRanks(
  db: Pick<PositionDb, "order">,
  orderId: string,
): Promise<OrderLineRanks> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      lineItems: {
        where: { status: { not: "CANCELLED" } },
        select: { id: true, position: true, createdAt: true },
      },
    },
  });
  return orderLineRanks(order?.lineItems ?? []);
}

/**
 * A rebuild keeps the NSF fee rows in place; the rebuilt lines take 0..n-1, so the kept fee rows move to n, n+1, ...
 * (last, in the order they are handed in). No query when nothing was kept.
 */
/**
 * The `update` stamp: the payload's order for a standalone invoice, the ORDER's order for a linked one (the payload never
 * overrides it). A legacy invoice saved in the order it is shown in writes nothing (`legacyOrderKept`).
 */
export async function stampEditedPositions(
  db: Pick<PositionDb, "order">,
  stored: readonly ShownLine[],
  editLines: ReadonlyArray<{ rowId?: string | null }>,
  itemsData: object[],
  orderId: string | null | undefined,
): Promise<void> {
  if (
    legacyOrderKept(
      stored,
      editLines.map((l) => l.rowId),
    )
  )
    return;
  stampInvoicePositions(itemsData, orderId ? await loadOrderLineRanks(db, orderId) : undefined);
}

/** The slot a line appended LAST takes (the invoice's max + 1; an all-NULL legacy invoice starts at 0). */
export async function nextTailPosition(
  db: { invoiceItem: { aggregate: (args: any) => Promise<any> } },
  invoiceId: string,
): Promise<number> {
  const tail = await db.invoiceItem.aggregate({ where: { invoiceId }, _max: { position: true } });
  return ((tail._max.position as number | null) ?? -1) + 1;
}

export async function restampKeptTail(
  db: Pick<PositionDb, "invoiceItem">,
  keptIds: readonly string[],
  start: number,
): Promise<void> {
  for (const [k, id] of keptIds.entries()) {
    await db.invoiceItem.update({ where: { id }, data: { position: start + k } });
  }
}

/**
 * A duplicate copies its source's SHOWN order: each copied line takes the rank of its source line in
 * `invoiceLinesInOrder`, so a legacy (NULL-position) source duplicates in A-Z. `data` is index-aligned with `source`.
 */
export function copyInvoicePositions<S extends ShownLine>(
  source: readonly S[],
  data: object[],
): void {
  const rank = new Map(invoiceLinesInOrder(source).map((l, i) => [l.id, i]));
  source.forEach((s, i) => {
    (data[i] as { position?: number }).position = rank.get(s.id) ?? i;
  });
}
