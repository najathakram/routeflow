import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { ChangeRequest, ChangeRequestResolveAction } from "@/lib/change-requests";

export type { ChangeRequest } from "@/lib/change-requests";

export type PriceType = "STANDARD" | "SPECIAL" | "DISCOUNTED" | "MANUAL" | "PROMO";

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
  urgent: boolean;
  subtotal: number;
  tax: number;
  total: number;
  discountAmount?: number;
  notes?: string;
  requestedDeliveryDate?: string;
  templateId?: string;
  lineItems: OrderItem[];
  /** Invoices generated from this order (sibling split invoices share invoiceGroupId). */
  invoices?: Array<{
    id: string;
    invoiceNumber: string;
    status: string;
    total: number;
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
  /** Server-stored line subtotal (the agreed money). Prefer this over recomputing. */
  subtotal?: number;
  status: string;
  notes?: string;
  /** Cumulative qty already covered by issued invoices for this item. */
  invoicedQty?: number;
  /** Cumulative qty actually delivered — advanced by the route completeStop flow. */
  deliveredQty?: number;
}

export interface ActiveOrderSummary {
  id: string;
  orderNumber: string | null;
  status: "DRAFT" | "PENDING";
  itemCount: number;
  total: number;
  createdAt: string;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export function useOrders(
  params?: {
    customerId?: string;
    status?: string;
    urgent?: boolean;
    page?: number;
    limit?: number;
    deliveryDateFrom?: string;
    deliveryDateTo?: string;
  },
  options?: { refetchInterval?: number },
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
      notes?: string;
    }
  | {
      name: string;
      qty: number;
      unitPrice: number;
      notes?: string;
    };

export function useCreateOrder() {
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
      discountAmount?: number;
      /**
       * Operator's choice when an active draft/pending order already exists for the customer.
       * If omitted and an active order exists, the API responds 409 with the active-order
       * summary so the UI can prompt.
       */
      mergeChoice?: "merge" | "separate";
    }
  >({
    mutationFn: (dto) => apiClient.post("/orders", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orders"] }),
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
  notes?: string;
  discountAmount?: number;
  requestedDeliveryDate?: string;
  /** Only when deliveredNow=false: send (issue) the draft invoice now instead of leaving it a draft. */
  send?: boolean;
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

export function useUpdateOrderStatus() {
  const qc = useQueryClient();
  return useMutation<Order, Error, { id: string; status: string; reason?: string }>({
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
  productId?: string; // for new catalog items
  /** Free-text label for a new unlisted line (no id, no productId) or a rename of one. */
  name?: string;
  action?: "CANCEL" | "DELETE" | "UPDATE";
  qty?: number;
  /** Boxed split so the server prorates by BOX price (unitPrice is the box price).
   *  Omit for non-boxed lines — the server then charges unitPrice * qty. */
  boxes?: number;
  pieces?: number;
  substituteProductId?: string;
  notes?: string;
  unitPrice?: number; // one-time per-line price override (DRAFT only, operator)
  overrideReason?: string; // optional note explaining the override
}

export function useUpdateOrderItems() {
  const qc = useQueryClient();
  return useMutation<
    Order,
    Error,
    { id: string; items: ItemUpdate[]; orderNotes?: string; replaceAll?: boolean }
  >({
    mutationFn: ({ id, items, orderNotes, replaceAll }) =>
      apiClient
        .patch<Order>(`/orders/${id}/items`, { items, orderNotes, replaceAll })
        .then((r) => r.data),
    onSuccess: (data) => {
      qc.setQueryData(["orders", data.id], data);
      qc.invalidateQueries({ queryKey: ["orders"] });
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

export function useDeleteOrder() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, string>({
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
      qc.setQueryData(["orders", data.id], data);
      qc.invalidateQueries({ queryKey: ["orders"] });
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
