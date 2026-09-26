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
import { deliveredBasisByLine } from "../invoices/delivered-basis-by-line";

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
 * (they are excluded), never the column those very rows produced.
 */
export function deliveredSoFarForLine(
  rows: RawEvidenceRowWithStop[] | undefined,
  excludeStopId: string | null | undefined,
  columnQty: unknown,
): number {
  if (!rows || rows.length === 0) return Math.max(0, Number(columnQty ?? 0));
  return sumDeliveredSoFar(rows, excludeStopId);
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

/**
 * SA-133: what each of `itemIds` should be RECOMPUTED to — Σ each line's own qualifying
 * evidence rows, never incremented or overwritten. READ-ONLY (the caller issues the actual
 * `orderItem.update` writes itself, so the units_v1/selling-restrictions AST writer-classifiers
 * — which only scan class-method bodies — still see every deliveredQty write where it happens).
 *
 * SA-345a: a line with NO qualifying row is NOT returned — its `deliveredQty` column is the
 * legacy evidence (orders delivered before rows existed) and must survive a later visit that
 * touched a sibling line. The one exception is `deletedRows` (reopenStop): a line whose rows
 * were just deleted recomputes to its remaining Σ (0 when none is left), because its column
 * was derived from exactly those rows.
 */
export async function deliveredQtyRecompute(
  db: { deliveryMutation: { findMany(args: any): Promise<any[]> } },
  orderId: string,
  itemIds: string[],
  deletedRows: ReadonlyArray<{ orderItemId?: string | null }> = [],
): Promise<Array<{ id: string; deliveredQty: number }>> {
  const basis = await deliveredBasisByLine(db as any, orderId);
  const lost = new Set(deletedRows.map((r) => r.orderItemId));
  return itemIds
    .filter((id) => basis.byLineId.has(id) || lost.has(id))
    .map((id) => ({ id, deliveredQty: basis.byLineId.get(id) ?? 0 }));
}
