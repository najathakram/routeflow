import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { ChangeRequest, ChangeRequestResolveAction } from "@/lib/change-requests";
import type {
  ActiveOrderSummary,
  CancelImpact,
  CustomerPriceHistory,
  InlineReturnLinesRequest,
  LineComponentView,
  PriceType,
} from "@routeflow/types";
import type { LocalErrorToastOption } from "@/lib/local-error-toast";

export type { ChangeRequest } from "@/lib/change-requests";

// `PriceType` re-exported from @routeflow/types (wave E / imp-10b R2: was
// declared identically here AND in `invoices.ts` — collapsed to one import).
export type {
  ActiveOrderSummary,
  CancelImpact,
  CustomerPriceHistory,
  PriceType,
} from "@routeflow/types";

export interface Order {
  id: string;
  orderNumber: string;
  customerId: string;
  customer?: {
    id: string;
    businessName: string;
    contactName?: string;
    phone?: string | null;
    mobile?: string | null;
    email?: string | null;
  };
  status: "DRAFT" | "PENDING" | "CONFIRMED" | "OUT_FOR_DELIVERY" | "DELIVERED" | "CANCELLED";
  /** ROUTE = dispatched on a delivery route (default); SHIP = supplier/carrier-shipped, excluded from trip/route dispatch. */
  fulfillPath: "ROUTE" | "SHIP";
  urgent: boolean;
  subtotal: number;
  tax: number;
  total: number;
  discountAmount?: number;
  shippingFee?: number | string;
  notes?: string;
  requestedDeliveryDate?: string;
  /** Business date the order actually happened on. Null = `createdAt` is the date. */
  orderDate?: string | null;
  /** Staff-only per-order commission override. `0` = exempt (no commission); `null`/absent = agent/customer default. */
  commissionRatePct?: number | string | null;
  templateId?: string;
  lineItems: OrderItem[];
  /** Invoices generated from this order (sibling split invoices share invoiceGroupId). */
  invoices?: Array<{
    id: string;
    invoiceNumber: string;
    status: string;
    total: number;
    /** CREDIT_NOTE payments only (server-scoped include), listed by the order's
     *  "Applied credits" panel (#2404). `creditNote` is attached by the order read
     *  (InvoicePayment has no relation); `autoApplied` is SA-436 PR-1's column. */
    payments?: Array<{
      id: string;
      amount: number | string;
      creditNoteId?: string | null;
      autoApplied: boolean;
      creditNote?: {
        id: string;
        creditNoteNumber: string;
        reason?: string | null;
        autoApplied?: boolean;
      } | null;
    }>;
  }>;
  /**
   * Credit-note intents applied to this order (join table — survives invoice
   * rebuilds because it never references invoice rows). `amount` null means
   * "up to the credit's remaining balance". `creditNote` carries the
   * display-only reason/status snapshot for the read-mode "Applied credits" list.
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
  /** Carrier shipment tracking (when goods ship via a carrier, not our own route). */
  shippingCarrier?: string | null;
  shippingTrackingNumber?: string | null;
  shippedAt?: string | null;
  /** P5-08: append-only edit history (one row per pre-dispatch edit). */
  revisions?: OrderRevision[];
  /** P5-08: whether the order can still be edited directly (closes on dispatch). */
  editWindow?: {
    editable: boolean;
    editableUntil: string | null;
    closedReason: "DISPATCHED" | "STATUS" | null;
  };
  /** P5-09: post-dispatch change requests, newest first (absent on older API). */
  changeRequests?: ChangeRequest[];
  /** P5-11: filtered relation counts from the LIST endpoint — `changeRequests`
   *  counts PENDING requests only (absent on detail payloads / older API). */
  _count?: { changeRequests?: number };
  createdAt: string;
}

/** P5-08: immutable post-edit snapshot of an order's line set + money totals. */
export interface OrderRevision {
  id: string;
  revisionNumber: number;
  editedByName?: string | null;
  editedByRole?: string | null;
  source: string;
  reason?: string | null;
  snapshot: {
    subtotal: number;
    tax: number;
    total: number;
    lineItems: Array<{
      productId: string | null;
      name: string | null;
      qty: number;
      unitPrice: number;
      subtotal: number;
    }>;
  };
  createdAt: string;
}

export interface OrderItem {
  id: string;
  /** Null for unlisted (ad-hoc, non-catalog) lines — `name` carries the label instead. */
  productId: string | null;
  product?: {
    id: string;
    name: string;
    unit: string;
    unitsPerBox?: number | null;
    averageCost?: string | number | null;
    category?: string | null;
    /** SKU line + read-time name composition (`displayProductName`) — `GET /orders/:id` only. */
    sku?: string | null;
    unitSku?: string | null;
    variantName?: string | null;
    parentProductId?: string | null;
    parent?: { name: string } | null;
  };
  /** Free-text label for an unlisted line (productId null, priceType "MANUAL"). */
  name?: string | null;
  qty: number;
  unitPrice: number;
  originalPrice?: number | null;
  priceType?: PriceType;
  overrideReason?: string | null;
  boxes?: number | null;
  pieces?: number | null;
  /** Sale-time box-size snapshot. Box math must use THIS, not the live product. */
  unitsPerBox?: number | null;
  /** units_v1: set when this line sells by a named unit (Case, Pallet, Piece…) — `boxes` is then
   *  the COUNT of that unit (never a physical box) and `qty` the base-piece total. Null = the pack. */
  unitLabel?: string | null;
  /** BUY_N_GET_M snapshot: whole free selling units on this line (boxes for a
   *  boxed line). Any local re-pricing MUST subtract it — otherwise the line
   *  previews at full price while the server bills the reduced subtotal. */
  promoFreeUnits?: number | null;
  /** Server-stored line subtotal (the agreed money). Prefer this over recomputing. */
  subtotal?: number;
  /**
   * RF-4: server-stored per-line regulated (category) tax, already folded into the
   * order total. Sum the non-cancelled lines to render the "Regulated tax" line so
   * the displayed Subtotal + Tax + Regulated tax reconciles to `order.total`.
   */
  categoryTaxAmount?: number;
  /** Sale-time regulated section id (null for non-regulated lines). */
  trackedCategoryId?: string | null;
  status: string;
  notes?: string;
  /** Cumulative qty already covered by issued invoices for this item. */
  invoicedQty?: number;
  /** #2717 M3: frozen components of a composed (mixed-pack) line; absent on a plain line. */
  components?: LineComponentView[];
  /** Cumulative qty actually delivered — advanced by the route completeStop flow. */
  deliveredQty?: number;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export function useOrders(
  params?: {
    customerId?: string;
    /** PR-B: only orders containing at least one line for this product. */
    productId?: string;
    status?: string;
    urgent?: boolean;
    fulfillPath?: "ROUTE" | "SHIP";
    page?: number;
    limit?: number;
    deliveryDateFrom?: string;
    deliveryDateTo?: string;
    /** Shipped on/after this date (`shippedAt`): the "Shipped this week" card + its list. */
    shippedFrom?: string;
    /** `false` = only orders with no tracking number yet ("Shipped, no tracking"). */
    hasTracking?: boolean;
    /**
     * B144: composes with `customerId` and role scope (never swallowed by
     * either) — matches against order number OR the customer's business
     * name.
     */
    search?: string;
  },
  options?: { refetchInterval?: number; enabled?: boolean },
) {
  return useQuery<PaginatedResponse<Order>>({
    queryKey: ["orders", params],
    queryFn: () => apiClient.get("/orders", { params }).then((r) => r.data),
    ...options,
  });
}

export function useOrder(id: string) {
  return useQuery<Order>({
    queryKey: ["orders", id],
    queryFn: () => apiClient.get(`/orders/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

/**
 * Read-only preview behind the cancel confirmation. Fetched only while the
 * dialog is open (`enabled`) — the list has no use for it, and it is one query
 * per order otherwise.
 */
export function useCancelImpact(id: string, enabled = true) {
  return useQuery<CancelImpact>({
    queryKey: ["orders", id, "cancel-impact"],
    queryFn: () => apiClient.get(`/orders/${id}/cancel-impact`).then((r) => r.data),
    enabled: !!id && enabled,
    staleTime: 0,
  });
}

/**
 * A line item on order creation. EITHER a catalog line (`productId` set,
 * `unitPrice`/`boxes`/`pieces` optional) OR an unlisted ad-hoc line
 * (`name` set, NO `productId`, `unitPrice` REQUIRED, no boxes/pieces).
 */
export type CreateOrderItem =
  | {
      productId: string;
      qty: number;
      boxes?: number;
      pieces?: number;
      unitPrice?: number;
      /** #2696(c): required by the server when unitPrice moves off a special (tier) price. */
      overrideReason?: string;
      notes?: string;
    }
  | {
      name: string;
      qty: number;
      unitPrice: number;
      notes?: string;
    };

export function useCreateOrder(options?: LocalErrorToastOption) {
  const qc = useQueryClient();
  return useMutation<
    Order,
    Error,
    {
      customerId: string;
      items: CreateOrderItem[];
      notes?: string;
      urgent?: boolean;
      requestedDeliveryDate?: string;
      /** Business date (YYYY-MM-DD) for an order entered late. Staff-only; the API
       *  rejects a future date or one more than 2 years back. */
      orderDate?: string;
      discountAmount?: number;
      shippingFee?: number;
      /**
       * Operator's choice when an active draft/pending order already exists for the customer.
       * If omitted and an active order exists, the API responds 409 with the active-order
       * summary so the UI can prompt.
       */
      mergeChoice?: "merge" | "separate";
      /** Customer credit notes to apply to this order's invoice(s) at creation
       *  time — undefined/omitted leaves credits untouched. */
      appliedCreditNotes?: { creditNoteId: string; amount?: number }[];
      /** Staff-only per-order commission override; 0 = exempt. */
      commissionRatePct?: number;
      /** #2406: an inline return to capture in the SAME write as this order — `customerId`/
       *  `orderId` are DERIVED server-side from the order being created, never sent here (see
       *  CreateOrderDto.inlineReturn, apps/api/src/orders/orders.controller.ts). */
      inlineReturn?: InlineReturnLinesRequest;
      /** SA-484a: the B215 replay key, sent as the `Idempotency-Key` HEADER (never in the body),
       *  paired with `inlineReturn.returnKey` — one per save attempt, reused on its retries. */
      idempotencyKey?: string;
    }
  >({
    meta: options?.localErrorToast ? { localErrorToast: options.localErrorToast } : undefined,
    mutationFn: ({ idempotencyKey, ...dto }) =>
      apiClient
        .post(
          "/orders",
          dto,
          idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : undefined,
        )
        .then((r) => r.data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      // #2406: this create carried an inline return — refresh any "Returns on this order"
      // read (GET /returns?orderId=).
      if (variables.inlineReturn) qc.invalidateQueries({ queryKey: ["returns"] });
    },
  });
}

export interface CreateSaleDto {
  customerId: string;
  items: {
    productId: string;
    qty: number;
    boxes?: number;
    pieces?: number;
    unitPrice?: number;
    notes?: string;
  }[];
  /** true = van/cash sale (order DELIVERED + invoice SENT). false = PENDING order + linked DRAFT invoice. */
  deliveredNow: boolean;
  /**
   * Delivery-date picker: when present it REPLACES `deliveredNow`'s binary.
   *  - deliveredOn <= today (tenant-tz calendar compare) → behaves as deliveredNow=true
   *    AND sets deliveredAt to that date (staff-only backdating).
   *  - deliveredOn > today → behaves as deliveredNow=false and sets
   *    requestedDeliveryDate = deliveredOn.
   * `deliveredNow` is still sent for backward compat; when both are present, `deliveredOn` wins.
   */
  deliveredOn?: string;
  notes?: string;
  discountAmount?: number;
  shippingFee?: number;
  requestedDeliveryDate?: string;
  /** Business date (YYYY-MM-DD) for a sale entered late. Staff-only. When set on a
   *  deliveredNow sale it also becomes `deliveredAt`, so omit it for a same-day sale. */
  orderDate?: string;
  /** Only when deliveredNow=false: send (issue) the draft invoice now instead of leaving it a draft. */
  send?: boolean;
  /** Due date (YYYY-MM-DD) for the created invoice. Omit to fall back to the tenant's default terms. */
  dueDate?: string;
  /** Long-form Terms & Conditions text for the created invoice. Omit to fall back to the tenant default. */
  terms?: string;
  /** Customer credit notes to apply to this order's invoice(s) at creation
   *  time — undefined/omitted leaves credits untouched. */
  appliedCreditNotes?: { creditNoteId: string; amount?: number }[];
}

/**
 * "Bill now": create an order AND its invoice in one step (POST /orders/sell).
 * Guarantees the invoice is tied to an order. Returns the created invoice.
 */
export function useCreateSale() {
  const qc = useQueryClient();
  return useMutation<{ id: string; invoiceNumber?: string }, Error, CreateSaleDto>({
    mutationFn: (dto) => apiClient.post("/orders/sell", dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}

/**
 * A customer's orders that still have un-invoiced quantity (qty > invoicedQty on any line item).
 * Backs the invoice screen's "Bill an existing order" flow.
 */
export function useUninvoicedOrders(customerId: string | null | undefined) {
  const query = useOrders(customerId ? { customerId, limit: 50 } : undefined);
  const orders = (query.data?.data ?? []).filter(
    (o) =>
      (!customerId || o.customerId === customerId) &&
      o.status !== "CANCELLED" &&
      (o.lineItems ?? []).some((li) => Number(li.qty) - Number(li.invoicedQty ?? 0) > 0.001),
  );
  return { isLoading: query.isLoading, isError: query.isError, orders };
}

/**
 * Look up the most recent DRAFT/PENDING order for a customer (operator only).
 * Used by the create-order modal to ask the operator whether to merge or keep separate.
 */
export function useActiveOrderForCustomer(customerId: string | null | undefined) {
  return useQuery<ActiveOrderSummary | null>({
    queryKey: ["orders", "active", customerId],
    queryFn: () => apiClient.get("/orders/active", { params: { customerId } }).then((r) => r.data),
    enabled: !!customerId,
  });
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

/**
 * `localErrorToast`: the caller renders its own error UI (the orders list's bulk cancel shows ONE summary
 * toast), so the app-wide generic error toast must not also fire once per request.
 */
export function useUpdateOrderStatus(options?: LocalErrorToastOption) {
  const qc = useQueryClient();
  return useMutation<Order, Error, { id: string; status: string; reason?: string }>({
    meta: options?.localErrorToast ? { localErrorToast: options.localErrorToast } : undefined,
    mutationFn: ({ id, status, reason }) =>
      apiClient.patch(`/orders/${id}/status`, { status, reason }).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["orders", id] });
    },
  });
}

export interface ItemUpdate {
  id?: string; // omitted for new items — the API creates them
  productId?: string; // for new catalog items, and on an existing line's UPDATE when
  // unitLabel is present (see unitLabel below — prepareUnitEditContext needs it to
  // preload the product/ladder; an id-only UPDATE against a plain-pack line silently
  // discards a bare unitLabel otherwise, see unit-line-edit.ts)
  /** Free-text label for a new unlisted line (no id, no productId) or a rename of one. */
  name?: string;
  action?: "CANCEL" | "DELETE" | "UPDATE";
  /** units_v1, STAFF ONLY: with `unitLabel` present, the COUNT of that unit (e.g. 4
   *  Cases) — never expanded to base pieces client-side, and boxes/pieces must be
   *  omitted (assertUnitLabelNamed refuses an unnamed qty/price edit of a unit line). */
  qty?: number;
  /** Boxed split so the server prorates by BOX price (unitPrice is the box price).
   *  Omit for non-boxed lines — the server then charges unitPrice * qty. Never send
   *  alongside unitLabel (units_v1 lines are count + label only). */
  boxes?: number;
  pieces?: number;
  substituteProductId?: string;
  notes?: string;
  /** units_v1: sell this line by a named unit (Case, Pallet, Piece…) instead of the pack.
   *  Absent on an existing unit-aware line's edit is REFUSED server-side (409
   *  UNIT_AWARE_LINE), never interpreted as pieces — see unit-line-edit.ts
   *  assertUnitLabelNamed. Send `productId` alongside it (see above). */
  unitLabel?: string;
  unitPrice?: number; // one-time per-line price override (DRAFT only, operator)
  overrideReason?: string; // optional note explaining the override
}

export function useUpdateOrderItems() {
  const qc = useQueryClient();
  return useMutation<
    Order,
    Error,
    {
      id: string;
      items: ItemUpdate[];
      orderNotes?: string;
      replaceAll?: boolean;
      shippingFee?: number;
      /**
       * Full desired credit-note selection (server diffs against the stored
       * intents) — undefined = leave credits untouched, [] = remove all.
       * Staff-only (operator/tenant-admin); the server ignores it otherwise.
       */
      appliedCreditNotes?: { creditNoteId: string; amount?: number }[];
      /** #2406: an inline return to capture in the SAME write as this edit — `customerId`/
       *  `orderId` are DERIVED server-side from the order being edited, never sent here (see
       *  UpdateOrderItemsDto.inlineReturn). */
      inlineReturn?: InlineReturnLinesRequest;
    }
  >({
    mutationFn: ({
      id,
      items,
      orderNotes,
      replaceAll,
      shippingFee,
      appliedCreditNotes,
      inlineReturn,
    }) =>
      apiClient
        .patch<Order>(`/orders/${id}/items`, {
          items,
          orderNotes,
          replaceAll,
          shippingFee,
          appliedCreditNotes,
          inlineReturn,
        })
        .then((r) => r.data),
    onSuccess: (data, variables) => {
      qc.setQueryData(["orders", data.id], data);
      qc.invalidateQueries({ queryKey: ["orders"] });
      // #2406: this write carried an inline return — refresh the order-detail "Returns on
      // this order" panel (GET /returns?orderId=), which reads the server's own figures.
      if (variables.inlineReturn) qc.invalidateQueries({ queryKey: ["returns"] });
    },
  });
}

export function useToggleUrgent() {
  const qc = useQueryClient();
  return useMutation<Order, Error, string>({
    mutationFn: (id) => apiClient.patch(`/orders/${id}/urgent`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["orders", id] });
    },
  });
}

export function useReopenOrder() {
  const qc = useQueryClient();
  return useMutation<Order, Error, string>({
    mutationFn: (id) => apiClient.post(`/orders/${id}/reopen`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["orders", id] });
    },
  });
}

export function useDeleteOrder(options?: LocalErrorToastOption) {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, string>({
    meta: options?.localErrorToast ? { localErrorToast: options.localErrorToast } : undefined,
    mutationFn: (id) => apiClient.delete(`/orders/${id}`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.removeQueries({ queryKey: ["orders", id] });
    },
  });
}

export function useBulkDeleteOrders() {
  const qc = useQueryClient();
  return useMutation<{ deleted: number; errors: string[] }, Error, string[]>({
    mutationFn: (ids) => apiClient.delete("/orders/bulk", { data: { ids } }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orders"] }),
  });
}

/**
 * Record / update / clear the carrier shipment on an order.
 * Empty strings clear the carrier + tracking number. Returns the updated order.
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
    onSuccess: (data) => {
      // NEVER setQueryData here: PATCH /orders/:id/shipment returns a BARE order row
      // (no lineItems/customer/invoices), and writing it into the detail cache made the
      // order page throw on order.lineItems.filter — the "Application error" full-page
      // crash after adding a tracking number. Invalidate and let GET /orders/:id refill.
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["orders", data.id] });
    },
  });
}

/**
 * P5-11: resolve a PENDING change request from the dashboard (the "office").
 * The driver-at-stop mobile surface is the P10 wave. First resolution wins on
 * the server — a lost race returns 409 { code: "CHANGE_REQUEST_ALREADY_RESOLVED" };
 * callers treat that as "someone else got there first": toast + refetch, never
 * retry. onSettled invalidates on success AND error so a lost race immediately
 * pulls the winning resolution (and the merged totals) into view.
 */
export function useResolveChangeRequest() {
  const qc = useQueryClient();
  return useMutation<
    ChangeRequest,
    Error,
    { orderId: string; crId: string; action: ChangeRequestResolveAction; reason?: string }
  >({
    mutationFn: ({ orderId, crId, action, reason }) =>
      apiClient
        .post(`/orders/${orderId}/change-requests/${crId}/resolve`, { action, reason })
        .then((r) => r.data),
    onSettled: (_data, _err, { orderId }) => {
      qc.invalidateQueries({ queryKey: ["orders", orderId] });
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

export function usePatchOrderCommissionRate() {
  const qc = useQueryClient();
  return useMutation<Order, Error, { id: string; commissionRatePct: number | null }>({
    mutationFn: ({ id, commissionRatePct }) =>
      apiClient.patch(`/orders/${id}/commission-rate`, { commissionRatePct }).then((r) => r.data),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ["orders", vars.id] }),
  });
}

export function usePatchOrderFulfillPath(options?: LocalErrorToastOption) {
  const qc = useQueryClient();
  return useMutation<Order, Error, { id: string; fulfillPath: "ROUTE" | "SHIP" }>({
    meta: options?.localErrorToast ? { localErrorToast: options.localErrorToast } : undefined,
    mutationFn: ({ id, fulfillPath }) =>
      apiClient.patch(`/orders/${id}/fulfill-path`, { fulfillPath }).then((r) => r.data),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ["orders", vars.id] }),
  });
}
