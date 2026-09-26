/**
 * SA-133 (B785): `deliveredSoFar` at a given stop S is the Σ `quantityDelivered` over a line's
 * evidence rows (`DELIVERY_EVIDENCE_WHERE`, delivery-evidence.ts — same "one evidence
 * definition" as the invoice-side basis) whose `routeRunStopId != S` — prior visits, at ANY
 * run/stop, excluding S's own rows. REFUSED contributes 0 either way. Excluding S's own rows
 * matters for two shared consumers:
 *  - `assertDeliveriesFitStop` (delivery-lines.util.ts): runs BEFORE this completion's own rows
 *    are inserted in the ordinary flow, so there is nothing of S's to exclude yet — but an
 *    idempotency replay or a defensive re-check must not double-count S's own prior attempt.
 *  - the run/stop READ projection (run-delivered-so-far.ts): a stop that already ran shows what
 *    was delivered BEFORE it, not a number inflated by its own completion.
 *
 * An omitted line on a later visit therefore reads as REMAINING (qty − deliveredSoFar), never the
 * full ordered qty — deliveredSoFar already nets out every OTHER visit's contribution.
 */
import { DELIVERY_EVIDENCE_WHERE } from "../invoices/delivery-evidence";
import { deliveredBasisByLine, isEvidenceRow } from "../invoices/delivered-basis-by-line";

export function deliveredSoFarFindManyArgs(orderIds: string[]) {
  return {
    where: { orderId: { in: orderIds }, ...DELIVERY_EVIDENCE_WHERE },
    select: {
      orderId: true,
      orderItemId: true,
      routeRunStopId: true,
      type: true,
      quantityDelivered: true,
    },
  };
}

export interface RawEvidenceRowWithStop {
  orderId: string;
  orderItemId: string | null;
  routeRunStopId: string | null;
  type: string;
  quantityDelivered: unknown;
}

/** orderId -> orderItemId -> every qualifying row (kept raw, not pre-summed, so a caller can
 *  exclude a specific stop's rows before summing). */
export function groupEvidenceRowsByLine(
  rows: RawEvidenceRowWithStop[],
): Record<string, Record<string, RawEvidenceRowWithStop[]>> {
  const result: Record<string, Record<string, RawEvidenceRowWithStop[]>> = {};
  for (const r of rows) {
    if (!r.orderItemId) continue; // a free-text/no-line mutation attributes to nothing
    const byOrder = result[r.orderId] ?? (result[r.orderId] = {});
    (byOrder[r.orderItemId] ??= []).push(r);
  }
  return result;
}

/** Σ a line's evidence rows, EXCLUDING any row written at `excludeStopId` (REFUSED contributes 0). */
export function sumDeliveredSoFar(
  rows: RawEvidenceRowWithStop[] | undefined,
  excludeStopId: string | null | undefined,
): number {
  if (!rows) return 0;
  return rows
    .filter((r) => r.routeRunStopId !== excludeStopId)
    .reduce((s, r) => s + (r.type === "REFUSED" ? 0 : Number(r.quantityDelivered)), 0);
}

/**
 * SA-345a: the PER-LINE delivered-so-far reader — the stepper's remaining (`qty − this`) and the
 * delivered-basis billable figure are ONE number (`deliveredQtyFromBasis`, delivered-basis-by-
 * line.ts, is its invoice-side twin). A line WITH its own qualifying rows takes their stop-
 * relative Σ (rows beat a stale column, SA-113a); a line with NO row anywhere takes the legacy
 * `deliveredQty ?? 0` — the column IS the evidence for orders delivered before rows existed.
 * "Has rows" is judged BEFORE excluding stop S: a line whose only rows are S's own reads 0
 * (they are excluded), never the column those very rows produced. The column fallback is capped
 * at the line's `qty` (when given), exactly like `deliveredQtyFromBasis`, so a stale column above
 * qty never yields a negative remaining and the stepper and billing stay ONE number.
 */
export function deliveredSoFarForLine(
  rows: RawEvidenceRowWithStop[] | undefined,
  excludeStopId: string | null | undefined,
  columnQty: unknown,
  qty?: unknown,
): number {
  if (!rows || rows.length === 0) {
    const column = Math.max(0, Number(columnQty ?? 0));
    return qty != null && Number.isFinite(Number(qty)) ? Math.min(column, Number(qty)) : column;
  }
  return sumDeliveredSoFar(rows, excludeStopId);
}

/**
 * F-05 (#2093, owner ruling 2026-09-25): a CANCELLED line — or any line of a CANCELLED / DRAFT order
 * still riding a stop — is no longer ordered, so nothing may be delivered against it.
 */
export function isNotOrdered(
  lineStatus: string | null | undefined,
  orderStatus: string | null | undefined,
): boolean {
  return lineStatus === "CANCELLED" || orderStatus === "CANCELLED" || orderStatus === "DRAFT";
}

/**
 * SA-366: the ONE per-line "what may still be delivered" figure — the value the stop-completion
 * bound (`assertDeliveriesFitStop`) accepts up to AND the value the run projection serves as
 * `remaining` for the driver's stepper default, so no client ever re-derives it (SA-070). 0 when
 * the line is not ordered (F-05's exact 0 ceiling overrides any evidence); otherwise
 * `max(0, qty − deliveredSoFar)`. No epsilon here — the tolerance lives only in the bound.
 */
export function lineRemaining(line: {
  qty: unknown;
  lineStatus: string | null | undefined;
  orderStatus: string | null | undefined;
  deliveredSoFar: number;
}): number {
  if (isNotOrdered(line.lineStatus, line.orderStatus)) return 0;
  return Math.max(0, Number(line.qty) - line.deliveredSoFar);
}

/** Structural contract for the one Prisma call this needs — never the whole client. */
export interface DeliveryMutationFindManyClient {
  deliveryMutation: {
    findMany(
      args: ReturnType<typeof deliveredSoFarFindManyArgs>,
    ): Promise<RawEvidenceRowWithStop[]>;
  };
}

/**
 * Fetches every qualifying evidence row for the given orders (ONE batched query) and groups
 * them by line — the shared read both `assertDeliveriesFitStop` and the run/stop projection
 * build their own stop-relative sum from, via `sumDeliveredSoFar`.
 */
export async function fetchEvidenceByLine(
  db: DeliveryMutationFindManyClient,
  orderIds: string[],
): Promise<Record<string, Record<string, RawEvidenceRowWithStop[]>>> {
  if (orderIds.length === 0) return {};
  const rows = await db.deliveryMutation.findMany(deliveredSoFarFindManyArgs(orderIds));
  return groupEvidenceRowsByLine(rows);
}

/** A row `reopenStop` just deleted — the shape its pre-delete `findMany` selects. */
export interface DeletedEvidenceRow {
  orderId: string;
  orderItemId: string | null;
  type: string;
  quantityDelivered: unknown;
}

/**
 * SA-133/SA-346: what each of `itemIds` should be RECOMPUTED to. READ-ONLY (the caller issues the
 * actual `orderItem.update` writes itself, so the units_v1/selling-restrictions AST writer-
 * classifiers — which only scan class-method bodies — still see every deliveredQty write where
 * it happens). A line's column is returned ONLY when
 *  (a) it has ≥1 qualifying row anywhere → Σrows, capped at the line's qty; or
 *  (b) it is in the FORCE SET — a line whose qualifying rows `deletedRows` (reopenStop's pre-
 *      delete `findMany` of the rows it ACTUALLY deleted, never the order's line list) just
 *      removed → Σ of what remains, or 0.
 * A row-less line outside the force set is untouched: its column IS the legacy evidence (orders
 * delivered before rows existed), and a deleted NON-qualifying row (change-request provenance)
 * never fed the column, so it forces nothing.
 */
export async function deliveredQtyRecompute(
  db: {
    deliveryMutation: { findMany(args: any): Promise<any[]> };
    orderItem: { findMany(args: any): Promise<any[]> };
  },
  orderId: string,
  itemIds: string[],
  deletedRows: ReadonlyArray<DeletedEvidenceRow> = [],
): Promise<Array<{ id: string; deliveredQty: number }>> {
  const basis = await deliveredBasisByLine(db as any, orderId);
  const forced = new Set(deletedRows.filter(isEvidenceRow).map((r) => r.orderItemId));
  const ids = itemIds.filter((id) => basis.byLineId.has(id) || forced.has(id));
  if (ids.length === 0) return [];
  const lines = await db.orderItem.findMany({
    where: { id: { in: ids } },
    select: { id: true, qty: true },
  });
  const qtyById = new Map(lines.map((l: { id: string; qty: unknown }) => [l.id, Number(l.qty)]));
  return ids.map((id) => {
    const sum = basis.byLineId.get(id) ?? 0;
    const qty = qtyById.get(id);
    return {
      id,
      deliveredQty: qty !== undefined && Number.isFinite(qty) ? Math.min(sum, qty) : sum,
    };
  });
}
