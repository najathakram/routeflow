import { Prisma } from "@prisma/client";
import { DELIVERY_EVIDENCE_TYPES } from "./delivery-evidence";

/**
 * SA-093a/SA-113b (rounds 6-7, #1185): the delivered basis for coverage/billing is
 * EVIDENCE-keyed — real `DeliveryMutation` rows — never `order.status` and never
 * `OrderItem.deliveredQty`.
 *
 * Why: on master, `DeliveryMutation` rows are written by THREE independent sites
 * (`routes.service.ts`'s `completeStop` and `completeWithPayment`, `orders.service.ts`'s
 * at-door change-request approval), but the `deliveredQty` COLUMN is written by
 * `completeWithPayment` alone. `changeStatus` ("mark delivered" from the office), the van
 * sale, and `completeStop` can all set `order.status = "DELIVERED"` without ever stamping
 * `deliveredQty` or writing a single mutation row. Keying coverage on `order.status ===
 * "DELIVERED"` (round 5's rule) therefore read every line on those orders as billable 0 and
 * `finalizeOrderRecompute` cancelled all of them — a $100 order silently going to $0
 * (independent Opus 5.5 re-read, finding 1, verified on master by the fleet lead).
 *
 * SA-113b, the EVIDENCE definition (shared with the at-door payment reconcile, SA-113a): a row
 * is evidence iff `quantityDelivered != null` AND its type is DELIVERED/PARTIAL/SUBSTITUTED
 * (delivered = quantityDelivered) or REFUSED (delivered = 0, the row's own quantityDelivered
 * value is never read once it qualifies). `completeStop`/`completeWithPayment` always set
 * `quantityDelivered`; `orders.service.ts`'s at-door change-request approval NEVER does, even
 * for its REFUSED-typed REMOVE_ITEM rows — its `qty` field is a SIGNED CHANGE-REQUEST DELTA
 * (split.qty − src.qty for a cut, an added line's own qty, −src.qty for a removal), not an
 * absolute delivered amount. ADD_ON rows and any row with a null `quantityDelivered` are
 * order-change provenance, not delivery evidence, and are IGNORED entirely (round 7, #1185,
 * independent Opus 5.5 full re-read of round 6, finding 1, HIGH/money): treating a change-
 * request row as evidence let a door cut from 10 to 7 write basis −3 (finalizeOrderRecompute
 * then cancelled a never-billed line — B667's own failure reintroduced) and a door raise from
 * 10 to 12 write basis 2 (a partial invoice of 4 read as fully covered, dropping 8 units). A
 * line touched only by change-request rows is simply a line with no evidence row of its own —
 * the next rule already covers it correctly.
 *
 * The rule, precisely:
 *  - A line's billable qty = min(qty, its own Σ evidence). A line with NO evidence row of its
 *    own keeps `qty` unconstrained (round 4's rule) — evidence elsewhere on the order, or a
 *    non-evidence row for this line, says nothing about a delivery never touched.
 *  - An order with NO evidence rows AT ALL behaves as undelivered, regardless of its status —
 *    `order.status` is read for nothing here, and neither is a change-request-only history.
 *  - `OrderItem.deliveredQty` is NEVER read for coverage. It may still be written (legacy,
 *    `completeWithPayment`) but this module never consults it.
 *
 * ONE core, never two derivations: `checkOrderCoverage`, `finalizeOrderRecompute` AND (once
 * B760/B785 resume) the invoice "remaining to bill" calculations and the at-door payment
 * reconcile all call `billableQtyFromBasis` against the SAME `DeliveredBasis` a caller computes
 * once via `deliveredBasisByLine`.
 */
export interface DeliveredBasis {
  /** True iff the order has at least one QUALIFYING DeliveryMutation row (see below), any line. */
  hasMutations: boolean;
  /** orderItemId -> Σ delivered qty from that line's own qualifying rows (REFUSED contributes 0). */
  byLineId: Map<string, number>;
}

/**
 * SA-131a/B785: the evidence-type list is shared with the at-door reconcile
 * (delivery-evidence.ts) — one evidence definition, not two.
 *
 * SA-113b: an evidence row needs BOTH a qualifying type AND a non-null `quantityDelivered` --
 * the close paths (completeStop/completeWithPayment) always set it; the at-door change-request
 * path never does, even for its REFUSED-typed REMOVE_ITEM rows (qty carries the signed delta,
 * not a delivered amount). A REFUSED row's own quantityDelivered value is never read (delivered
 * is always forced to 0 for it) -- its non-null PRESENCE is only the qualification signal.
 */
export function isEvidenceRow(m: { type: string; quantityDelivered: unknown }): boolean {
  return (
    m.quantityDelivered != null && (DELIVERY_EVIDENCE_TYPES as readonly string[]).includes(m.type)
  );
}

export async function deliveredBasisByLine(
  db: Prisma.TransactionClient,
  orderId: string,
): Promise<DeliveredBasis> {
  const mutations = await db.deliveryMutation.findMany({
    where: { orderId },
    select: { orderItemId: true, type: true, quantityDelivered: true },
  });
  const qualifying = mutations.filter(isEvidenceRow);
  const byLineId = new Map<string, number>();
  for (const m of qualifying) {
    if (!m.orderItemId) continue; // a free-text/no-line mutation attributes to nothing
    const delta = m.type === "REFUSED" ? 0 : Number(m.quantityDelivered);
    byLineId.set(m.orderItemId, (byLineId.get(m.orderItemId) ?? 0) + delta);
  }
  return { hasMutations: qualifying.length > 0, byLineId };
}

export function billableQtyFromBasis(
  li: { id: string; qty: unknown },
  basis: DeliveredBasis,
): number {
  const qty = Number(li.qty ?? 0);
  if (!basis.hasMutations) return qty;
  const delivered = basis.byLineId.get(li.id);
  if (delivered === undefined) return qty;
  return Math.min(qty, delivered);
}

/**
 * SA-345/345a: the "delivered" READER — what a line has actually been delivered, used by the
 * delivered-basis invoice rebuilds (reconcileOrderDraftInvoice, rebuildSiblingDrafts and, through
 * it, the deposit-mirror rebuild) and, via `deliveredSoFarForLine`, by the stepper's remaining.
 * SAME `DeliveredBasis` object as `billableQtyFromBasis`, a different question: coverage asks
 * "what may still be billed" (no rows ⇒ the full qty, SA-093a); this asks "what was delivered"
 * (no rows ⇒ nothing is assumed beyond the legacy column).
 *
 * PER LINE: a line WITH its own qualifying rows takes Σrows (rows beat a stale SET column,
 * SA-113a); a line with NO own row takes `deliveredQty ?? 0` — master's rule, never the full qty
 * and never 0 just because it is unseen. Orders delivered before evidence rows existed (or whose
 * rows a pre-B803 reopen deleted) carry the column as their ONLY evidence. The order-level "no
 * rows at all" case is unreachable from today's close (a reconciled order always got a row in the
 * same tx, routes.service.ts completeWithPayment) but is exactly a legacy order, and falls out of
 * the same per-line rule. Capped at qty so a stale column can never bill units nobody ordered.
 */
export function deliveredQtyFromBasis(
  li: { id: string; qty: unknown; deliveredQty?: unknown },
  basis: DeliveredBasis,
): number {
  const qty = Number(li.qty ?? 0);
  const own = basis.byLineId.get(li.id);
  const delivered = own !== undefined ? own : Number(li.deliveredQty ?? 0);
  return Math.max(0, Math.min(qty, delivered));
}
