/**
 * Pure returns helpers — status pill + which actions the current status allows.
 * The action flags mirror the server's transition guards exactly so the UI never
 * fires a doomed request (approve/reject only from PENDING; in-transit only from
 * APPROVED; receive from APPROVED or IN_TRANSIT; refund only from RECEIVED).
 */
import { prorateLineSubtotal, roundMoney } from "@routeflow/pricing";
import { freeUnitSizeFor } from "./short-pick";
import type { CreateReturnItemDto, ReturnReason } from "./api/returns";
import type { RouteRunStop } from "./api/routes";

export type ReturnPillVariant = "orange" | "brand" | "green" | "gray" | "red";

export function returnPillFor(status: string): { variant: ReturnPillVariant; label: string } {
  switch (status) {
    case "PENDING":
      return { variant: "orange", label: "Pending" };
    case "APPROVED":
      return { variant: "brand", label: "Approved" };
    case "IN_TRANSIT":
      return { variant: "brand", label: "In transit" };
    case "RECEIVED":
      return { variant: "brand", label: "Received" };
    case "REFUNDED":
      return { variant: "green", label: "Refunded" };
    case "PROCESSED":
      return { variant: "green", label: "Processed" };
    case "REJECTED":
      return { variant: "red", label: "Rejected" };
    case "CANCELLED":
      return { variant: "gray", label: "Cancelled" };
    default:
      return { variant: "gray", label: status };
  }
}

export interface ReturnActionFlags {
  canApprove: boolean;
  canReject: boolean;
  canMarkInTransit: boolean;
  canReceive: boolean;
  /**
   * "Resolve without receiving": receive with restocking suppressed, then resolve
   * straight away — same predicate as canReceive (APPROVED or IN_TRANSIT), offered
   * as a secondary action alongside the normal physical-receipt path.
   */
  canResolveWithoutReceipt: boolean;
  canRefund: boolean;
  /**
   * REG-B21: mirrors the web ruling's cancel predicate exactly — PENDING,
   * APPROVED, IN_TRANSIT, or RECEIVED can still be cancelled; a return that
   * already resolved (refunded/processed) or is already terminal
   * (rejected/cancelled) cannot.
   */
  canCancel: boolean;
  /** No further action — a terminal status. */
  terminal: boolean;
}

export interface ReturnLineInput {
  productId: string | null;
  orderedQty: number;
}

/**
 * REG-B61: mirrors the server's `defaultRestockForReason` exactly (ruling §9)
 * so a client-computed default never disagrees with what the server would
 * apply anyway — DAMAGED and QUALITY_ISSUE goods are assumed unsellable and
 * do not restock; every other reason (WRONG_ITEM, CUSTOMER_REFUSED,
 * EXCESS_ORDER) restocks by default.
 */
export function restockForReason(reason: string): boolean {
  return reason !== "DAMAGED" && reason !== "QUALITY_ISSUE";
}

/**
 * Build the create-return items payload from the operator's per-line qty inputs:
 * skip unlisted/zero/blank lines, and cap each return qty at the ordered qty.
 * REG-B61: an explicit per-line restock choice wins; otherwise the default
 * comes from the return `reason` (`restockForReason`), never a hardcoded
 * `true` that silently overrides the server's own reason-aware default.
 */
export function buildReturnItems(
  lines: ReturnLineInput[],
  qtyByProduct: Record<string, string>,
  restockByProduct: Record<string, boolean>,
  reason: string,
): { productId: string; qty: number; restock: boolean }[] {
  const out: { productId: string; qty: number; restock: boolean }[] = [];
  const defaultRestock = restockForReason(reason);
  for (const li of lines) {
    if (!li.productId) continue;
    const qty = Math.floor(Number(qtyByProduct[li.productId] ?? ""));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    out.push({
      productId: li.productId,
      qty: Math.min(qty, Math.max(0, Math.floor(li.orderedQty))),
      restock: restockByProduct[li.productId] ?? defaultRestock,
    });
  }
  return out;
}

/** Mirrors the driver return screen's `reasonForApi` label mapping (ruling §9 B128). */
const REASON_FOR_MUTATION_TYPE: Record<string, ReturnReason> = {
  REFUSED: "CUSTOMER_REFUSED",
  PARTIAL: "EXCESS_ORDER",
};

export interface UndeliveredReturnRow {
  orderId: string;
  /** The order line this row came from — the stable key for the per-row damaged toggle. */
  lineItemId: string;
  /** Always a catalog product: an unlisted line can never be returned here (see `unlistedCount`). */
  productId: string;
  /** Undelivered qty (ordered − delivered), always > 0. */
  qty: number;
  /** Credit for the undelivered portion — stored subtotal minus the delivered/paid share. */
  amount: number;
  reason: ReturnReason;
  restock: boolean;
}

export interface UndeliveredReturnPayload {
  orderId: string;
  reason: ReturnReason;
  /**
   * Exactly the body the driver screen POSTs per order. The delivered side is
   * deliberately NOT sent: capping a refund by what was already delivered needs
   * a `ReturnItem.deliveredQty` column (migration), so the B53 x B128
   * composition is filed separately rather than shipped half-built.
   */
  items: CreateReturnItemDto[];
}

export interface UndeliveredReturnLineItem {
  id: string;
  productId: string | null;
  qty: number;
  unitPrice?: number | null;
  subtotal?: number | null;
  boxes?: number | null;
  unitsPerBox?: number | null;
  product?: { unitsPerBox?: number | null } | null;
  freeUnits?: number;
}

export interface UndeliveredReturnStopOrder {
  id: string;
  lineItems?: UndeliveredReturnLineItem[];
}

export interface UndeliveredReturnDeliveryMutation {
  id: string;
  orderItemId: string;
  productId?: string | null;
  type: string;
  quantityDelivered: number;
}

export interface UndeliveredReturnStop {
  orders?: UndeliveredReturnStopOrder[];
  deliveryMutations?: UndeliveredReturnDeliveryMutation[];
}

/**
 * Adapts the route-run stop shape to `undeliveredReturnLines`' input — line-item
 * `subtotal` can arrive as a Prisma Decimal string over the wire; the helper wants
 * a number. Lives here, next to its only consumer, so the shipped adapter is the
 * tested one.
 *
 * `lineExtras` (keyed by ORDER-LINE id) carries the promo/box facts the run read
 * path does not ship — `RUN_LINE_ITEMS_SELECT` (routes.service.ts) selects no
 * `promoFreeUnits`. Without it the free-unit basis would be a hardcoded 0 sitting
 * next to a REAL `freeUnitSize`, and a boxed BOGO line would credit back goods the
 * customer never paid for. The caller sources them from the order detail exactly
 * the way payment.tsx / short-pick.tsx do (REG-B50).
 */
export function toUndeliveredStop(
  stop: RouteRunStop,
  lineExtras?: Record<string, { promoFreeUnits?: number | null; unitsPerBox?: number | null }>,
): UndeliveredReturnStop {
  return {
    orders: (stop.orders ?? []).map((o) => ({
      id: o.id,
      lineItems: (o.lineItems ?? []).map((li) => {
        const extra = lineExtras?.[li.id];
        return {
          id: li.id,
          productId: li.productId,
          qty: li.qty,
          unitPrice: li.unitPrice,
          subtotal: li.subtotal == null ? null : Number(li.subtotal),
          boxes: li.boxes,
          // Prefer the run line's own SALE-TIME snapshot; the order detail only
          // fills the gap (and carries the live product fallback).
          unitsPerBox: li.unitsPerBox ?? extra?.unitsPerBox ?? null,
          freeUnits: Math.max(0, Math.trunc(Number(extra?.promoFreeUnits ?? 0)) || 0),
        };
      }),
    })),
    deliveryMutations: stop.deliveryMutations ?? [],
  };
}

/**
 * REG-B128: the driver's PARTIAL/REFUSED mutations record what was DELIVERED,
 * not what should come back — this derives the return side (box-safe, via the
 * real `@routeflow/pricing` exports, never `quantityDelivered` re-billed as
 * the return qty) in ONE place so rows, the displayed total, and the POST
 * payload can never drift apart. DELIVERED mutations are skipped entirely; a
 * PARTIAL that happened to deliver the full ordered qty yields undelivered
 * qty 0 and is dropped rather than emitted as a zero-qty row/payload item.
 * Rows/payloads are grouped by orderId — a stop can carry several orders, and
 * `issue()` must POST one return per order.
 *
 * `opts.damagedKeys` holds `undeliveredRowKey` values the driver flagged as
 * damaged-in-transit: that row alone becomes DAMAGED / `restock: false` (the
 * server's own reason-aware default, mirrored by `restockForReason`), while
 * every other row keeps the reason derived from its mutation type. A global
 * reason chip is deliberately NOT offered — it would overwrite every row's
 * derived reason.
 *
 * A line with no catalog product (`OrderItem.productId` is nullable — unlisted
 * ad-hoc lines) can NOT be returned through this endpoint: `create()` matches
 * payload items to order lines by productId, so an empty id fails the whole
 * order's return. Such lines are dropped from rows/total/payloads and counted
 * in `unlistedCount` so the screen can say so.
 */
export function undeliveredReturnLines(
  stop: UndeliveredReturnStop,
  opts?: { damagedKeys?: ReadonlySet<string> },
): {
  rows: UndeliveredReturnRow[];
  total: number;
  payloads: UndeliveredReturnPayload[];
  /** Undelivered lines dropped because they carry no catalog product. */
  unlistedCount: number;
} {
  const orders = stop.orders ?? [];
  const rows: UndeliveredReturnRow[] = [];
  const payloadsByOrder = new Map<string, UndeliveredReturnPayload>();
  let unlistedCount = 0;

  for (const m of stop.deliveryMutations ?? []) {
    if (m.type !== "PARTIAL" && m.type !== "REFUSED") continue;

    let orderId: string | null = null;
    let li: UndeliveredReturnLineItem | null = null;
    for (const order of orders) {
      const found = (order.lineItems ?? []).find((l) => l.id === m.orderItemId);
      if (found) {
        orderId = order.id;
        li = found;
        break;
      }
    }
    if (!orderId || !li) continue;

    const ordered = Math.max(0, Number(li.qty ?? 0));
    const delivered = Math.max(0, Number(m.quantityDelivered ?? 0));
    const undelivered = Math.max(0, ordered - delivered);
    if (undelivered <= 0) continue;

    const productId = li.productId ?? m.productId ?? null;
    if (!productId) {
      unlistedCount += 1;
      continue;
    }

    const damaged = opts?.damagedKeys?.has(undeliveredRowKey(orderId, li.id)) ?? false;
    const reason: ReturnReason = damaged
      ? "DAMAGED"
      : (REASON_FOR_MUTATION_TYPE[m.type] ?? "CUSTOMER_REFUSED");
    const restock = restockForReason(reason);
    const storedSubtotal = Number(li.subtotal) || 0;
    const paidShare = prorateLineSubtotal(
      li.subtotal,
      delivered,
      ordered,
      li.freeUnits ?? 0,
      freeUnitSizeFor(li),
    );
    const amount = roundMoney(Math.max(0, storedSubtotal - paidShare));

    rows.push({
      orderId,
      lineItemId: li.id,
      productId,
      qty: undelivered,
      amount,
      reason,
      restock,
    });

    let payload = payloadsByOrder.get(orderId);
    if (!payload) {
      payload = { orderId, reason, items: [] };
      payloadsByOrder.set(orderId, payload);
    }
    payload.items.push({
      productId,
      qty: undelivered,
      restock,
      reason,
    });
  }

  const total = roundMoney(rows.reduce((sum, r) => sum + r.amount, 0));
  return { rows, total, payloads: Array.from(payloadsByOrder.values()), unlistedCount };
}

/** The `opts.damagedKeys` key for one undelivered row — order + order-line id. */
export function undeliveredRowKey(orderId: string, lineItemId: string): string {
  return `${orderId}:${lineItemId}`;
}

export interface ReturnSubmissionResult {
  orderId: string;
  ok: boolean;
  /** The server/transport message on a rejection. */
  message?: string;
  /** REG-B307/B308: api-client.ts enqueued the POST and rejected — pending, not failed. */
  isOfflineQueued?: boolean;
}

/**
 * Fold ONE `Promise.allSettled` round of per-order create-return POSTs into
 * "which orders have landed" and "which still need a retry". Each POST commits
 * independently, so an all-or-nothing `Promise.all` + single error toast strands
 * the driver: the created return is invisible, and the obvious retry re-POSTs it.
 * A rejection carrying `create()`'s cumulative over-return guard means THIS
 * order's return already exists — count it done, or a retry can never clear.
 */
export function summarizeSubmissions(results: ReturnSubmissionResult[]): {
  done: string[];
  failed: { orderId: string; message: string }[];
  /** REG-B307: present only when at least one result queued offline. */
  queued?: string[];
} {
  const done: string[] = [];
  const failed: { orderId: string; message: string }[] = [];
  const queued: string[] = [];
  for (const r of results) {
    // REG-B307: an offline-queued return counts as submitted, never as failed.
    if (r.isOfflineQueued) {
      queued.push(r.orderId);
      continue;
    }
    const message = r.message ?? "";
    if (r.ok || message.toLowerCase().includes("exceeds remaining returnable")) {
      done.push(r.orderId);
    } else {
      failed.push({ orderId: r.orderId, message: message || "Try again." });
    }
  }
  return queued.length > 0 ? { done, failed, queued } : { done, failed };
}

export function returnActionFlags(status: string): ReturnActionFlags {
  const canApprove = status === "PENDING";
  const canReject = status === "PENDING";
  const canMarkInTransit = status === "APPROVED";
  const canReceive = status === "APPROVED" || status === "IN_TRANSIT";
  const canResolveWithoutReceipt = canReceive;
  const canRefund = status === "RECEIVED";
  const canCancel =
    status === "PENDING" ||
    status === "APPROVED" ||
    status === "IN_TRANSIT" ||
    status === "RECEIVED";
  const terminal =
    status === "REFUNDED" ||
    status === "PROCESSED" ||
    status === "REJECTED" ||
    status === "CANCELLED";
  return {
    canApprove,
    canReject,
    canMarkInTransit,
    canReceive,
    canResolveWithoutReceipt,
    canRefund,
    canCancel,
    terminal,
  };
}
