import { Prisma } from "@prisma/client";
import { needsLivePack, toPieces, type StockLineUnits } from "../../orders/order-stock";

/**
 * Row 635 PR B — B562 D2 (SA-136 §5, SA-373 a–e, SA-902 MUST 4): where a LEGACY order's stock events sat.
 *
 * Before B562 PR-2 an order moved `Product.currentStock` with no StockMovement, so the ledger is blind to when its sales
 * happened. Each event is placed on the COUNTER's clock (PR-2 dates live rows at the counter write, so D2 must too; never
 * `orderDate`):
 * - the CREATE (its lines, or the FIRST revision snapshot when there are revisions) at `createdAt`;
 * - with revisions: a snapshot is the state AFTER an edit and none is written at create; each later revision adds its Δ
 *   at its own `createdAt`, window [the previous revision, it]; the lines now differing from the last snapshot add a
 *   final Δ at `updatedAt`, window [the last revision, updatedAt];
 * - a CANCELLED order also credits back its undelivered pieces at `updatedAt`, window [the last known event, updatedAt]
 *   (D2-3: never dropped).
 * SA-921 (supersedes SA-911's draft rule): a promotion, a demote/re-promote and a cancel → reopen moved stock at a time
 * nothing stores, each bounded by `updatedAt`. So EVERY event of a legacy order takes the window [createdAt, updatedAt],
 * except a counter sale (created DELIVERED, never a draft) and an order never updated after creation; a costful row in
 * that window makes the product APPROX ("its stock may have moved any time from created to last updated").
 * Quantities are pieces, through the order path's one conversion (`toPieces`, PR-2/B703). A line that needs the product's
 * LIVE pack is sized by it but makes the product APPROX (the pack may have changed since).
 * The interposition stops at the cutover (SA-902 MUST 4, SA-911, SA-921 Q5):
 * - an order whose ledger holds its `ORDER:<id>` PROMOTE row for this product was still a DRAFT at the cutover: its stock
 *   moved only at that (ledgered) promotion, so nothing of it is interposed;
 * - an event at or after the cutover of an order that HAS `ORDER:<id>` rows for this product IS one of those rows: it is
 *   dropped (SKIP). For an order with NO such row it can only be a legacy change: it is clamped to 1 ms before the cutover
 *   and the product is APPROX (as is any event whose window crosses the cutover);
 * - Q5: an order with `ORDER:<id>` rows places exactly (its net effect now − Σ those rows): the difference, the
 *   post-cutover part a snapshot may embed, comes off its LAST pre-cutover event (known exactly, so no APPROX; its windows
 *   are clamped). With no pre-cutover event it is placed at the CREATE and named (SA-911's SHOULD).
 * Stock-wise a sale is negative and a credit positive (the signs `StockMovement.quantity` uses).
 */
export interface LegacyLine extends StockLineUnits {
  productId: string | null;
  qty: unknown;
  deliveredQty?: unknown;
  status?: unknown;
}
export interface LegacyOrder {
  id: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  /** The order's current lines, every status. */
  lines: LegacyLine[];
  /** OrderRevision snapshots' line items, oldest first. */
  revisions: Array<{ createdAt: Date; lineItems: LegacyLine[] }>;
  /** A counter sale (created DELIVERED): never a draft, so its CREATE is a point (SA-911). */
  counterSale?: boolean;
  /** This product's `ORDER:<id>` ledger rows for the order (PR-2, after the cutover): Σ quantity, and a PROMOTE among them. */
  ledger?: { rows: number; qty: Prisma.Decimal; promoted: boolean };
}
export type EventKind = "CREATE" | "REVISION" | "FINAL" | "CANCEL";
export interface PlacedEvent {
  orderId: string;
  kind: EventKind;
  at: Date;
  /** Signed pieces: a sale is negative, a credit positive. */
  qty: Prisma.Decimal;
  /** Where the event may really have happened, inclusive; clamped to before the cutover. */
  window: [Date, Date];
  /** SA-921: the order may have moved stock at an unrecorded time, so the window is its whole [createdAt, updatedAt]. */
  unrecorded?: boolean;
}

const isLive = (li: LegacyLine) => li.status !== "CANCELLED";

export function interposeOrder(
  order: LegacyOrder,
  productId: string,
  livePack: unknown,
  cutover: Date,
): { events: PlacedEvent[]; approx: string[] } {
  const approx = new Set<string>();
  /** Σ pieces of `productId` over `lines`, at the column's 3 decimals. */
  const pieces = (lines: LegacyLine[], qtyOf: (li: LegacyLine) => unknown = (li) => li.qty) => {
    let sum = new Prisma.Decimal(0);
    for (const li of lines) {
      if (li.productId !== productId) continue;
      if (needsLivePack(li)) approx.add(`order ${order.id}: a line sized by the live pack`);
      sum = sum.add(toPieces(li, qtyOf(li), livePack));
    }
    return sum;
  };

  const cancelled = order.status === "CANCELLED";
  // What the order held just before now (or before its cancel): a cancel flips the held lines to CANCELLED.
  const held = cancelled ? order.lines : order.lines.filter(isLive);
  const raw: Array<Omit<PlacedEvent, "orderId">> = [];
  const place = (kind: EventKind, at: Date, saleQty: Prisma.Decimal, window: [Date, Date]) => {
    if (!saleQty.isZero()) raw.push({ kind, at, qty: saleQty, window });
  };

  // SA-911: a draft promoted after the cutover took its stock at that ledgered PROMOTE: nothing here is legacy.
  if (order.ledger?.promoted) return { events: [], approx: [] };
  const revs = order.revisions;
  // SA-921: a promotion, a demote/re-promote or a cancel → reopen moved stock at a time nothing stores, but each is an
  // update. Only a counter sale (never a draft) and an order never updated after creation keep their placed windows.
  const unrecorded = !order.counterSale && order.createdAt.getTime() !== order.updatedAt.getTime();
  const createWindow = (pointEnd: Date): [Date, Date] => [order.createdAt, pointEnd];
  if (revs.length === 0) {
    place("CREATE", order.createdAt, pieces(held).neg(), createWindow(order.createdAt));
  } else {
    let prev = pieces(revs[0].lineItems.filter(isLive));
    // The first snapshot may embed edits made before it. SA-921 Q5: a snapshot written after the cutover of an order with
    // ledger rows embeds only post-cutover edits, which are backed out exactly below, so the CREATE stays a point.
    const firstIsLedgers = revs[0].createdAt >= cutover && (order.ledger?.rows ?? 0) > 0;
    place(
      "CREATE",
      order.createdAt,
      prev.neg(),
      createWindow(firstIsLedgers ? order.createdAt : revs[0].createdAt),
    );
    for (let k = 1; k < revs.length; k += 1) {
      const cur = pieces(revs[k].lineItems.filter(isLive));
      place("REVISION", revs[k].createdAt, cur.sub(prev).neg(), [
        revs[k - 1].createdAt,
        revs[k].createdAt,
      ]);
      prev = cur;
    }
    const last = revs[revs.length - 1].createdAt;
    place("FINAL", order.updatedAt, pieces(held).sub(prev).neg(), [last, order.updatedAt]);
  }
  if (cancelled) {
    const lastKnown = revs.length ? revs[revs.length - 1].createdAt : order.createdAt;
    const undelivered = pieces(held, (li) =>
      Math.max(0, Number(li.qty ?? 0) - Number(li.deliveredQty ?? 0)),
    );
    place("CANCEL", order.updatedAt, undelivered, [lastKnown, order.updatedAt]);
  }

  // The interposition stops at the cutover (SA-902 MUST 4, SA-911).
  const beforeCut = new Date(cutover.getTime() - 1);
  if (unrecorded) {
    for (const e of raw) {
      e.window = [order.createdAt, order.updatedAt];
      e.unrecorded = true;
    }
  }
  const ledgered = (order.ledger?.rows ?? 0) > 0;
  const events: PlacedEvent[] = [];
  for (const e of raw) {
    const [start, end] = e.window;
    if (start >= cutover) continue; // wholly the ledger's
    if (e.at >= cutover && ledgered) continue; // SKIP: this event IS one of the order's ORDER:<id> rows
    if (end >= cutover || e.at >= cutover) {
      // SA-921 Q5: an order with ledger rows has its post-cutover part backed out below, so only the window is clamped.
      if (!ledgered) approx.add(`order ${order.id}: a ${e.kind} window crosses the cutover`);
      events.push({
        ...e,
        orderId: order.id,
        at: e.at >= cutover ? beforeCut : e.at,
        window: [start, beforeCut],
      });
      continue;
    }
    events.push({ ...e, orderId: order.id });
  }
  // SA-921 Q5: for an order with ledger rows, the pre-cutover net is its net effect now minus those rows; the difference
  // (the post-cutover part a snapshot may embed, known exactly from the ledger) comes off its LAST pre-cutover event.
  if (ledgered) {
    const net = cancelled
      ? pieces(held, (li) => Number(li.deliveredQty ?? 0)).neg() // a cancel keeps only the delivered pieces out
      : pieces(held).neg();
    const placed = events.reduce((s, e) => s.add(e.qty), new Prisma.Decimal(0));
    const diff = net.sub(order.ledger!.qty).sub(placed);
    if (!diff.isZero()) {
      const last = events[events.length - 1];
      if (last) last.qty = last.qty.add(diff);
      else {
        // SHOULD (SA-911): nothing to adjust — placed at its CREATE and named, so the owner sees which order.
        approx.add(
          `order ${order.id}: ${diff.toString()} pieces had no pre-cutover event; placed at its CREATE`,
        );
        const w = unrecorded ? [order.createdAt, order.updatedAt] : createWindow(order.createdAt);
        events.push({
          orderId: order.id,
          kind: "CREATE",
          at: order.createdAt,
          qty: diff,
          window: [w[0], w[1] >= cutover ? beforeCut : w[1]],
          ...(unrecorded ? { unrecorded: true } : {}),
        });
      }
    }
  }
  return { events, approx: [...approx] };
}
