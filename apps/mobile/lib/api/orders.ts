import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { ChangeRequest } from "./change-requests";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrderItem {
  id: string;
  /** Null for an unlisted (ad-hoc, non-catalog) line — `name` carries the label instead. */
  productId: string | null;
  /** Free-text label for an unlisted line (productId null, priceType "MANUAL"). */
  name?: string | null;
  product?: {
    id: string;
    name: string;
    unit: string;
    unitsPerBox?: number | null; // NEW — boxed-line steppers (at-door adjust, P10-POS-3)
    averageCost?: number | string | null; // NEW
    category?: string | null; // NEW
  };
  qty: number;
  unitPrice: number;
  /** Catalog base for an override line; unitPrice > originalPrice = upsell. */
  originalPrice?: number | null;
  /** STANDARD | SPECIAL | DISCOUNTED | MANUAL | PROMO. */
  priceType?: string;
  /** Server-stored line subtotal (the agreed money). Prefer this over recomputing. */
  subtotal?: number;
  /**
   * RF-4: server-stored per-line regulated (category) tax, already folded into the
   * order total. Sum the non-cancelled lines to render the "Regulated tax" line.
   */
  categoryTaxAmount?: number;
  /** Boxed split persisted server-side; boxes==null means qty is in selling units. */
  boxes?: number | null;
  pieces?: number | null;
  /**
   * BUY_N_GET_M snapshot: whole free SELLING units on this line (BOXES for a
   * boxed line). The stored `subtotal` already nets them off — any local
   * recompute MUST pass them to `computeLineSubtotal` or it over-charges.
   */
  promoFreeUnits?: number | null;
  /** Cumulative qty already covered by issued invoices for this item. */
  invoicedQty?: number;
  /** Cumulative qty already delivered — gates at-door adjustability (server: LINE_ALREADY_DELIVERED). */
  deliveredQty?: number; // NEW
  status: string;
}

export type OrderStatus =
  | "DRAFT"
  | "PENDING"
  | "CONFIRMED"
  | "OUT_FOR_DELIVERY"
  | "PARTIALLY_DELIVERED"
  | "DELIVERED"
  | "CANCELLED";

export interface Order {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  urgent: boolean;
  subtotal: number;
  tax: number;
  total: number;
  /** Optional flat shipping fee added to the order total (never taxed). */
  shippingFee?: number | string;
  notes?: string;
  driverNote?: string;
  requestedDeliveryDate?: string;
  deliveredAt?: string;
  /** Carrier shipment tracking (when goods ship via a carrier, not our own route). */
  shippingCarrier?: string | null;
  shippingTrackingNumber?: string | null;
  shippedAt?: string | null;
  lineItems: OrderItem[];
  createdAt: string;
  /** P5-09 post-dispatch change requests on this order, newest first. */
  changeRequests?: ChangeRequest[]; // NEW
  /** P5-08 edit-window gate — direct PATCH /items vs. change-request flow. */
  editWindow?: { editable: boolean; editableUntil: string | null; closedReason: string | null }; // NEW
  /**
   * Order-scoped credit-note INTENTS (server: `OrderCreditNote`). `amount` is the
   * requested dollars — null means "up to the credit's remaining balance". Applied
   * dollars-so-far live on `invoices[].payments` (CREDIT_NOTE rows), not here.
   */
  orderCreditNotes?: Array<{
    id: string;
    creditNoteId: string;
    amount?: number | string | null;
    creditNote?: {
      id: string;
      creditNoteNumber: string;
      reason?: string | null;
      amount: number | string;
      amountUsed: number | string;
      status: string;
      expiresAt?: string | null;
    };
  }>;
  /** CREDIT_NOTE payments per invoice (present when `orderCreditNotes` is). */
  invoices?: Array<{
    id: string;
    invoiceNumber: string;
    status: string;
    total: number;
    payments?: Array<{ id: string; amount: number | string; creditNoteId: string | null }>;
  }>;
}

/** One order-selected credit-note intent in a create/edit payload. */
export interface AppliedCreditNoteInput {
  creditNoteId: string;
  /** Dollars to apply from this credit. Omit = up to the credit's remaining balance. */
  amount?: number;
}

export interface CreateOrderDto {
  items: { productId: string; qty: number }[];
  notes?: string;
  urgent?: boolean;
  requestedDeliveryDate?: string;
}

/**
 * A line on a create-order request. EITHER a catalog line (productId set,
 * unitPrice optional) OR an unlisted ad-hoc line (`name` set, NO productId,
 * unitPrice REQUIRED, never boxed). Mirrors the API contract.
 */
export type CreateOrderItemInput =
  | {
      productId: string;
      qty: number;
      boxes?: number;
      pieces?: number;
      /** One-time discounted price override (per catalog unit; box price for boxed). */
      unitPrice?: number;
      /** Optional per-line note — carried onto the invoice line (buyer-visible). */
      notes?: string;
    }
  | {
      /** Free-text label for an unlisted (non-catalog) line. */
      name: string;
      qty: number;
      /** Required for unlisted lines — there is no catalog price to fall back to. */
      unitPrice: number;
      /** Optional per-line note — carried onto the invoice line (buyer-visible). */
      notes?: string;
    };

export interface CreateOrderAsDriverDto {
  customerId: string;
  /**
   * `qty` is total pieces. When the operator splits a boxed product into
   * boxes+pieces, also include those — the server recomputes `qty` from
   * them and uses them for line-subtotal proration (BOX price × box-equivalent).
   * An unlisted line is `{ name, qty, unitPrice }` (no productId/boxes/pieces).
   */
  items: CreateOrderItemInput[];
  /**
   * Save as a DRAFT (parked, resumable) instead of the default PENDING. A DRAFT
   * may have zero items server-side; it re-runs the license guard on the
   * DRAFT→PENDING "Submit for review" transition. Omit for a normal submit.
   */
  status?: "DRAFT" | "PENDING";
  notes?: string;
  /** Mark the order urgent at creation (same flag the detail-screen toggle sets). */
  urgent?: boolean;
  /** Requested delivery date as "YYYY-MM-DD" (server @IsDateString). */
  requestedDeliveryDate?: string;
  /** Order-level discount in currency (NOT `discount`). Only send when > 0. */
  discountAmount?: number;
  /** Optional flat shipping fee added to the order total (never taxed). Only send when > 0. */
  shippingFee?: number;
  routeRunId?: string;
  routeRunStopId?: string;
  immediateDelivery?: boolean;
  /**
   * Operator's choice when an active draft/pending order already exists for the customer.
   * If omitted and an active order exists, the API responds 409 with the active-order
   * summary so the UI can prompt.
   */
  mergeChoice?: "merge" | "separate";
  /**
   * Credit notes to apply to this order's invoice(s). Omit = leave untouched;
   * [] = remove all; otherwise the FULL desired set (server diffs).
   */
  appliedCreditNotes?: AppliedCreditNoteInput[];
}

export interface ActiveOrderSummary {
  id: string;
  orderNumber: string | null;
  status: "DRAFT" | "PENDING";
  itemCount: number;
  total: number;
  createdAt: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useMyOrders(params?: { status?: string; page?: number; limit?: number }) {
  return useQuery<{ data: Order[]; meta: any }>({
    queryKey: ["orders", "mine", params],
    queryFn: () => apiClient.get("/orders", { params }).then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useOrder(id: string) {
  return useQuery<Order>({
    queryKey: ["orders", id],
    queryFn: () => apiClient.get(`/orders/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

/** What cancelling this order would do to its invoices and applied credits.
 *  Mirrors web's `useCancelImpact` — same endpoint, same shape. */
export interface CancelImpact {
  orderId: string;
  orderNumber: string;
  alreadyCancelled: boolean;
  invoicesToVoid: Array<{ id: string; invoiceNumber: string; status: string; total: number }>;
  creditsToRestore: Array<{ creditNoteId: string; creditNoteNumber: string; amount: number }>;
  advanceToRestore: number;
  blockingPayments: Array<{ invoiceNumber: string; amount: number }>;
  canCancel: boolean;
}

/**
 * Imperative twin of {@link useCancelImpact}. The order screen's confirm is a
 * one-shot call, not a render, so it fetches the preview on demand rather than
 * paying for a query on every order view.
 */
export async function fetchCancelImpact(id: string): Promise<CancelImpact> {
  const r = await apiClient.get(`/orders/${id}/cancel-impact`);
  return r.data;
}

export function useCancelImpact(id: string, enabled = true) {
  return useQuery<CancelImpact>({
    queryKey: ["orders", id, "cancel-impact"],
    queryFn: () => apiClient.get(`/orders/${id}/cancel-impact`).then((r) => r.data),
    enabled: !!id && enabled,
    staleTime: 0,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/**
 * Order data is cached under TWO key families: driver/customer surfaces read
 * ["orders", ...] while the OPERATOR list and detail (useAdminOrders /
 * useAdminOrder in admin.ts) read ["admin", "orders", ...]. Invalidating only
 * ["orders"] leaves the operator screens serving their cache for up to the 30s
 * staleTime — a deleted order kept sitting in the list until the next refresh.
 * Both prefixes also cover every per-id key beneath them, so these two calls
 * are the complete set. EVERY order mutation goes through this helper; do not
 * hand-roll the invalidation again, that is how the families drifted apart.
 */
function invalidateOrderCaches(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ["orders"] });
  void qc.invalidateQueries({ queryKey: ["admin", "orders"] });
}

export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation<Order, Error, CreateOrderDto>({
    mutationFn: (dto) => apiClient.post("/orders", dto).then((r) => r.data),
    onSuccess: () => invalidateOrderCaches(qc),
  });
}

/**
 * A line on a `POST /orders/sell` request. EITHER a catalog line (productId
 * set, boxed split optional) OR an unlisted ad-hoc line (`name` set, no
 * productId) — mirrors {@link CreateOrderItemInput}. Unlisted lines are NOT
 * filtered out here: the sale gate (`lib/sale-mode.ts`) already accounts for
 * them in its total-equality assertion, so they must ride along on the wire.
 */
export type CreateSaleItemInput =
  | {
      productId: string;
      qty: number;
      boxes?: number;
      pieces?: number;
      unitPrice?: number;
      notes?: string;
    }
  | { name: string; qty: number; unitPrice: number; notes?: string };

/**
 * `POST /orders/sell` DTO — the van-sale "collapse" path (create order +
 * mark delivered + move stock + issue/send invoice in one call). Mirrors
 * web's `CreateSaleDto` (`apps/web/lib/api/orders.ts`) but deliberately
 * narrower:
 *  - NO `send`: the server ignores `dto.send` entirely (`orders.service.ts`
 *    ~1681-1685) — it's a dead field, so we don't pretend it does anything.
 *  - NO `discountAmount`: the sale gate (`saleModeGate`, WP1) only ever
 *    allows this path when the invoice-level discount is 0 (an invoice
 *    discount is silently dropped by `createInvoiceFromOrder`), so there is
 *    never a non-zero value to send.
 */
export interface CreateSaleDto {
  customerId: string;
  items: CreateSaleItemInput[];
  /** true = van/cash sale (order DELIVERED + invoice SENT). false = PENDING order + linked DRAFT invoice. */
  deliveredNow: boolean;
  notes?: string;
  shippingFee?: number;
  /** Business date (YYYY-MM-DD) for a sale entered late. Omit for a same-day sale. */
  orderDate?: string;
}

/**
 * What `POST /orders/sell` actually resolves to: the created INVOICE, not the
 * order. `orders.service.ts` `createSale()` returns `invoicesService.send(inv.id)`
 * for a delivered-now sale and `invoices[0]` otherwise — neither payload carries
 * an `invoices` array. Web types it the same way (`apps/web/lib/api/orders.ts`).
 */
export interface CreatedSaleInvoice {
  id: string;
  invoiceNumber: string;
}

/**
 * "Bill now": create an order AND its invoice in one step (POST /orders/sell).
 * Mirrors web's `useCreateSale` — same cache invalidations as {@link useCreateOrder}
 * plus `["invoices"]`, since the sale also issues (and may send) an invoice.
 * Resolves to the created invoice ({@link CreatedSaleInvoice}).
 */
export function useCreateSale() {
  const qc = useQueryClient();
  return useMutation<CreatedSaleInvoice, Error, CreateSaleDto>({
    mutationFn: (dto) => apiClient.post("/orders/sell", dto).then((r) => r.data),
    onSuccess: () => {
      invalidateOrderCaches(qc);
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}

export function useCreateOrderAsDriver() {
  const qc = useQueryClient();
  return useMutation<Order, Error, CreateOrderAsDriverDto>({
    mutationFn: (dto) => apiClient.post("/orders", dto).then((r) => r.data),
    onSuccess: (_, vars) => {
      if (vars.routeRunId) qc.invalidateQueries({ queryKey: ["route-runs", vars.routeRunId] });
      invalidateOrderCaches(qc);
    },
  });
}

export function useConfirmOrder() {
  const qc = useQueryClient();
  return useMutation<Order, Error, string>({
    mutationFn: (orderId) =>
      apiClient.patch(`/orders/${orderId}/status`, { status: "CONFIRMED" }).then((r) => r.data),
    onSuccess: () => {
      // Also route-runs so the "N to confirm" pill updates immediately.
      invalidateOrderCaches(qc);
      qc.invalidateQueries({ queryKey: ["route-runs"] });
    },
  });
}

export function useCancelOrder() {
  const qc = useQueryClient();
  return useMutation<Order, Error, string>({
    mutationFn: (id) =>
      apiClient.patch(`/orders/${id}/status`, { status: "CANCELLED" }).then((r) => r.data),
    onSuccess: () => invalidateOrderCaches(qc),
  });
}

/**
 * One entry in the replace-all edit-items payload. EITHER a catalog line
 * (productId set) OR a NEW unlisted line (`name` set, no productId). The
 * existing mobile edit-items flow sends the full id-less list (legacy
 * replace-all); unlisted lines slot in as `{ name, qty, unitPrice }`.
 */
/**
 * One entry in an incremental order-item edit (mirrors web's `ItemUpdate`).
 * All fields optional so a diff can express: an existing-line UPDATE (`id`+
 * `qty`…), a hard DELETE / soft CANCEL (`id`+`action`), a substitution
 * (`id`+`substituteProductId`), a new catalog line (`productId`…), or a new
 * unlisted line (`name`…). Only DTO-whitelisted keys — never spread a draft.
 * `notes` = per-line note carried onto the invoice line (buyer-visible).
 */
export interface UpdateOrderItemInput {
  id?: string;
  productId?: string;
  name?: string;
  action?: "CANCEL" | "DELETE" | "UPDATE";
  qty?: number;
  boxes?: number;
  pieces?: number;
  substituteProductId?: string;
  unitPrice?: number;
  overrideReason?: string;
  notes?: string;
}

export function useUpdateOrderItems() {
  const qc = useQueryClient();
  return useMutation<
    Order,
    Error,
    {
      orderId: string;
      items: UpdateOrderItemInput[];
      /**
       * `false` = incremental merge: untouched lines (absent from `items`) are
       * left as-is, protecting invoiced qty + override history. Always pass
       * `false` from the edit UI — omitting it lets the server's legacy heuristic
       * flip to full-replace when every entry is id-less (e.g. only new adds).
       */
      replaceAll?: boolean;
      /**
       * Credit notes to apply to this order's invoice(s). Omit = leave untouched
       * (server intent survives edits); [] = remove all; otherwise the FULL
       * desired set.
       */
      appliedCreditNotes?: AppliedCreditNoteInput[];
    }
  >({
    mutationFn: ({ orderId, items, replaceAll, appliedCreditNotes }) =>
      apiClient
        .patch(`/orders/${orderId}/items`, {
          items,
          replaceAll,
          ...(appliedCreditNotes !== undefined ? { appliedCreditNotes } : {}),
        })
        .then((r) => r.data),
    onSuccess: () => invalidateOrderCaches(qc),
  });
}

/**
 * Record / update / clear the carrier shipment on an order. Empty strings
 * clear the carrier + tracking number. Mirrors web's `useUpdateOrderShipment`.
 */
export function useUpdateOrderShipment() {
  const qc = useQueryClient();
  return useMutation<
    Order,
    Error,
    { id: string; shippingCarrier?: string; shippingTrackingNumber?: string }
  >({
    mutationFn: ({ id, ...dto }) =>
      apiClient.patch(`/orders/${id}/shipment`, dto).then((r) => r.data),
    onSuccess: () => invalidateOrderCaches(qc),
  });
}

export function useToggleOrderUrgent() {
  const qc = useQueryClient();
  return useMutation<Order, Error, { id: string; urgent: boolean }>({
    mutationFn: ({ id, urgent }) =>
      apiClient.patch(`/orders/${id}/urgent`, { urgent }).then((r) => r.data),
    onSuccess: () => invalidateOrderCaches(qc),
  });
}

export function useChangeOrderStatus() {
  const qc = useQueryClient();
  return useMutation<Order, Error, { id: string; status: OrderStatus; reason?: string }>({
    mutationFn: ({ id, status, reason }) =>
      apiClient.patch(`/orders/${id}/status`, { status, reason }).then((r) => r.data),
    onSuccess: () => {
      invalidateOrderCaches(qc);
      qc.invalidateQueries({ queryKey: ["route-runs"] });
    },
  });
}

/**
 * Reopen a CANCELLED order back to PENDING (`POST /orders/:id/reopen`,
 * OPERATOR-only). The server 400s if a PAID/PARTIAL/WRITTEN_OFF invoice exists
 * on the order — surface that message.
 *
 * A DELIVERED order canNOT be reopened at all: the server's transition table has
 * `DELIVERED: []` (see `lib/order-status-flow.ts`), so demoting it to CONFIRMED
 * always 400s with "Cannot transition from DELIVERED to CONFIRMED". Correcting
 * an already-delivered order means editing its items, not moving it backwards.
 */
export function useReopenOrder() {
  const qc = useQueryClient();
  return useMutation<Order, Error, string>({
    mutationFn: (id) => apiClient.post(`/orders/${id}/reopen`).then((r) => r.data),
    onSuccess: () => invalidateOrderCaches(qc),
  });
}

export function useCreateAdminOrder() {
  const qc = useQueryClient();
  return useMutation<
    Order,
    Error,
    {
      customerId: string;
      items: { productId: string; qty: number }[];
      notes?: string;
      urgent?: boolean;
      immediateDelivery?: boolean;
      mergeChoice?: "merge" | "separate";
    }
  >({
    mutationFn: (dto) => apiClient.post("/orders", dto).then((r) => r.data),
    onSuccess: () => invalidateOrderCaches(qc),
  });
}

/**
 * Look up the most recent DRAFT/PENDING order for a customer (operator only).
 * Used by the operator's create-order screen to ask whether to merge or keep separate.
 */
export function useActiveOrderForCustomer(customerId: string | null | undefined) {
  return useQuery<ActiveOrderSummary | null>({
    queryKey: ["orders", "active", customerId],
    queryFn: () => apiClient.get("/orders/active", { params: { customerId } }).then((r) => r.data),
    enabled: !!customerId,
  });
}

export interface CustomerPriceHistory {
  [productId: string]: {
    lastPrice: number;
    listPriceAtTime: number;
  };
}

/**
 * Per-product last-given price for a customer. Fetched once when the customer
 * is selected so scanning is instant — no per-item API call needed.
 */
export function useCustomerPriceHistory(customerId: string | null | undefined) {
  return useQuery<CustomerPriceHistory>({
    queryKey: ["orders", "price-history", customerId],
    queryFn: () =>
      apiClient.get("/orders/price-history", { params: { customerId } }).then((r) => r.data),
    enabled: !!customerId,
    staleTime: 60_000,
  });
}

export function useDeleteOrder() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiClient.delete(`/orders/${id}`).then(() => undefined),
    // The reported bug lived here: only ["orders"] was invalidated, so the
    // operator list (["admin","orders",…], 30s staleTime) kept showing the
    // deleted order until the next refresh.
    onSuccess: () => invalidateOrderCaches(qc),
  });
}

// ─── Tracking ─────────────────────────────────────────────────────────────────

export interface OrderTracking {
  runId: string;
  routeName: string | null;
  driverName: string | null;
  runStatus: string;
  stopNumber: number;
  stopStatus: string;
  stopsAhead: number;
  estimatedArrivalWindow: { start: string | null; end: string | null };
}

export function useOrderTracking(orderId: string, orderStatus?: string) {
  return useQuery<{ status: string; tracking: OrderTracking | null }>({
    queryKey: ["orders", orderId, "tracking"],
    queryFn: () => apiClient.get(`/orders/${orderId}/tracking`).then((r) => r.data),
    enabled: !!orderId && orderStatus === "OUT_FOR_DELIVERY",
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
}
