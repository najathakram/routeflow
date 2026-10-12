"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { buyerApiClient } from "@/lib/buyer-api-client";
import { getStoredActiveSeller, getStoredBuyerId } from "@/lib/buyer-auth";
import { buyerSubmitKeyFor, clearBuyerSubmitKey } from "./buyer-submit-key";
import type { ExpiringAuthorization } from "./authorizations";
import type { PromotionRule } from "@routeflow/pricing";
import type { BuyerOrderItemEdit } from "@routeflow/types";
import type { ChangeRequest } from "@/lib/change-requests";
import { buyerOrderConflict } from "@/lib/buyer-order-conflict";
import {
  isTrackingLive,
  type FulfilmentMethod,
  type InvoiceStatus,
  type OrderTrackingResponse,
} from "@routeflow/types";
import type {
  BuyerAnalytics,
  BuyerAuthorizationRow,
  BuyerCreateChangeRequestInput,
  BuyerFavoriteProduct,
  BuyerInvoiceItem,
  BuyerInvoicePayment,
  BuyerOrder,
  BuyerOrderListItem,
  BuyerPayment,
  BuyerProduct,
  BuyerProductDetailExtras,
  BuyerPromotion,
  BuyerRemittance,
  BuyerStatement,
  BuyerStockAlerts,
  LockedCategory,
  ReplenishmentEstimate,
  ShelfResponse,
  SubmitBuyerAuthorizationInput,
} from "@routeflow/types";
export type {
  BuyerAnalytics,
  BuyerAuthorizationRow,
  BuyerCreateChangeRequestInput,
  BuyerPayment,
  BuyerPromotion,
  BuyerRemittance,
  BuyerStatement,
  BuyerStatementTransaction,
  BuyerStockAlerts,
  LockedCategory,
  ReplenishmentEstimate,
  ShelfActiveOrder,
  ShelfEstimate,
  ShelfResponse,
  SubmitBuyerAuthorizationInput,
} from "@routeflow/types";

// ─── Types ────────────────────────────────────────────────────────────────────

// #2703 (SA-562): catalog row + favorites = ONE declaration in @routeflow/types.
export type {
  BuyerFavoriteProduct,
  BuyerOrder,
  BuyerOrderLine,
  BuyerOrderListItem,
  BuyerProduct,
} from "@routeflow/types";

/** Detail-only fields are shared with mobile via @routeflow/types (#2345). */
export interface BuyerProductDetail
  extends Omit<BuyerProduct, "imageUrls">, BuyerProductDetailExtras {}

export interface DashboardData {
  recentOrders: Array<{
    id: string;
    orderNumber: string;
    status: string;
    total: number;
    createdAt: string;
    requestedDeliveryDate: string | null;
    itemCount: number;
    /** Business profiles 1B: the badge reads the order detail's label (buyerOrderStatusLabel). */
    fulfillPath: string;
    shippedAt: string | null;
  }>;
  stats: {
    activeOrders: number;
    pendingDeliveries: number;
    templateCount: number;
    spend30d: number;
    spend90d: number;
    spendAllTime: number;
  };
  frequentlyOrdered: Array<{
    productId: string;
    name: string;
    sku: string | null;
    unit: string;
    category: string | null;
    buyerPrice: number;
    thumbnailUrl: string | null;
    orderCount: number;
    totalQty: number;
  }>;
  newFromSeller: Array<{
    id: string;
    name: string;
    sku: string | null;
    unit: string;
    category: string | null;
    buyerPrice: number;
    thumbnailUrl: string | null;
  }>;
  featuredItems: Array<{
    id: string;
    name: string;
    sku: string | null;
    unit: string;
    category: string | null;
    buyerPrice: number;
    thumbnailUrl: string | null;
  }>;
  suggestedItems: Array<{
    id: string;
    name: string;
    sku: string | null;
    unit: string;
    category: string | null;
    buyerPrice: number;
    thumbnailUrl: string | null;
  }>;
}

/** Wave E / imp-10b R2: renamed from `OrderTemplate` — collided in name (but not
 *  shape) with `./order-templates.ts`'s divergent `OrderTemplate` within this same
 *  app; disambiguated rather than shared, since the two shapes are unrelated. */
export interface BuyerOrderTemplate {
  id: string;
  name: string;
  isActive: boolean;
  daysOfWeek: number[];
  notes: string | null;
  nextFireDate: string | null;
  items: Array<{
    id: string;
    productId: string;
    qty: number;
    notes: string | null;
    /** Set when the seller suspended this line — a manual reorder never places it. */
    suspendedAt?: string | null;
    product: { id: string; name: string; unit: string };
  }>;
  customer: { id: string; businessName: string };
}

interface Paginated<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export interface BuyerCatalogResult extends Paginated<BuyerProduct> {
  hiddenCategories?: LockedCategory[];
}

// ─── Product catalog ──────────────────────────────────────────────────────────

export function useBuyerProducts(params?: {
  search?: string;
  category?: string;
  page?: number;
  limit?: number;
  sort?: string;
  collection?: "usuals" | "favorites" | "new" | "deals";
  /** Resolve exactly these products (cart pricing) — returns all of them, unpaged. */
  ids?: string[];
}) {
  const { ids, ...rest } = params ?? {};
  const query = ids?.length ? { ...rest, ids: ids.join(",") } : rest;
  return useQuery<BuyerCatalogResult>({
    queryKey: ["buyer", "products", query],
    queryFn: () => buyerApiClient.get("/buyer/products", { params: query }).then((r) => r.data),
  });
}

export function useBuyerProduct(productId: string) {
  return useQuery<BuyerProductDetail>({
    queryKey: ["buyer", "product", productId],
    queryFn: () => buyerApiClient.get(`/buyer/products/${productId}`).then((r) => r.data),
    enabled: !!productId,
  });
}

/** Buyer: the caller's own expiring/expired licenses at this seller (W7b bell).
 *  Pass `enabled=false` when no seller is active (the endpoint needs a seller). */
export function useBuyerExpiringAuthorizations(enabled = true) {
  return useQuery<ExpiringAuthorization[]>({
    queryKey: ["buyer", "authorizations", "expiring"],
    queryFn: () => buyerApiClient.get("/buyer/authorizations/expiring").then((r) => r.data),
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
}

export function useBuyerCategories() {
  return useQuery<string[]>({
    queryKey: ["buyer", "categories"],
    queryFn: () => buyerApiClient.get("/buyer/products/categories").then((r) => r.data),
    staleTime: 5 * 60 * 1000, // 5 min
  });
}

/** Category-rail data (P5-02): total + per-category + smart-collection counts + locked categories. */
export interface BuyerCatalogCounts {
  total: number;
  categories: Array<{ name: string; count: number }>;
  collections: { usuals: number; favorites: number; new: number; deals: number };
  lockedCategories: LockedCategory[];
}

export function useBuyerCatalogCounts() {
  return useQuery<BuyerCatalogCounts>({
    queryKey: ["buyer", "catalog-counts"],
    queryFn: () => buyerApiClient.get("/buyer/products/counts").then((r) => r.data),
    staleTime: 60 * 1000,
  });
}

// ─── Replenishment (P5-05) ───────────────────────────────────────────────────

export function useBuyerReplenishment() {
  return useQuery<ReplenishmentEstimate[]>({
    queryKey: ["buyer", "replenishment"],
    queryFn: () => buyerApiClient.get("/buyer/replenishment").then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  });
}

// ─── Your Shelf (P5-06/07) ───────────────────────────────────────────────────

/**
 * THE single data source for Your Shelf, the shop running-low strip and the
 * dashboard chips — all three read this payload (strip/chips filter
 * `state === "low" && !snoozed` client-side), so the low list and the
 * suggested quantities can never disagree between surfaces.
 */
export function useBuyerShelf() {
  return useQuery<ShelfResponse>({
    queryKey: ["buyer", "shelf"],
    queryFn: () => buyerApiClient.get("/buyer/shelf").then((r) => r.data),
    staleTime: 60 * 1000,
    // A5: without an active seller there is no X-Tenant-Slug header and the
    // request 400s server-side — don't fire a doomed request.
    enabled: !!getStoredActiveSeller(),
  });
}

/** Snooze one product for one cycle (server computes now + cadence, 14d fallback). */
export function useSnoozeReplenishment() {
  const qc = useQueryClient();
  return useMutation<{ snoozedUntil: string }, Error, string>({
    mutationFn: (productId) =>
      buyerApiClient.post(`/buyer/replenishment/${productId}/snooze`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer", "shelf"] });
      qc.invalidateQueries({ queryKey: ["buyer", "replenishment"] });
    },
  });
}

export function useUnsnoozeReplenishment() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (productId) =>
      buyerApiClient.delete(`/buyer/replenishment/${productId}/snooze`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer", "shelf"] });
      qc.invalidateQueries({ queryKey: ["buyer", "replenishment"] });
    },
  });
}

/** Seed the active order with every running-low item at its suggested qty. */
export function useAddAllLow() {
  const qc = useQueryClient();
  return useMutation<BuyerOrder | null, Error, void>({
    mutationFn: () => buyerApiClient.post("/buyer/shelf/add-all-low").then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer", "shelf"] });
      qc.invalidateQueries({ queryKey: ["buyer", "replenishment"] });
      qc.invalidateQueries({ queryKey: ["buyer", "activeOrder"] });
      qc.invalidateQueries({ queryKey: ["buyer", "orders"] });
      qc.invalidateQueries({ queryKey: ["buyer", "dashboard"] });
    },
  });
}

// ─── Promotions (P5-04) ─────────────────────────────────────────────────────────

// `BuyerPromotion` now imported from @routeflow/types (wave E / imp-10b) —
// shape matches PromotionsService.activeForCatalog + the `PromotionRule` the
// shared `applyBestPromotion` (lib/pricing) evaluator consumes.

export function useBuyerPromotions() {
  return useQuery<BuyerPromotion[]>({
    queryKey: ["buyer", "promotions"],
    queryFn: () => buyerApiClient.get("/buyer/promotions").then((r) => r.data),
    staleTime: 5 * 60 * 1000, // 5 min
  });
}

/**
 * Map server promotions to the `PromotionRule` shape `applyBestPromotion`
 * consumes. THE single mapping — the shop tile and the cart page must both use
 * it so their promo evaluation inputs are byte-identical (cent parity).
 */
export function toPromotionRules(promos: BuyerPromotion[] | undefined): PromotionRule[] {
  return (promos ?? []).map((p) => ({
    id: p.id,
    type: p.type,
    value: p.value,
    minQty: p.minQty,
    scope: p.scope,
    category: p.category,
    productIds: p.productIds,
  }));
}

// ─── Orders ───────────────────────────────────────────────────────────────────

/**
 * `fulfillPath` scopes the read to the order a cart on that path would fold into (the server's own
 * merge search); omitted = the buyer's most recent active order, as before.
 */
export function useBuyerActiveOrder(fulfillPath?: string) {
  return useQuery<BuyerOrder | null>({
    queryKey: fulfillPath ? ["buyer", "activeOrder", fulfillPath] : ["buyer", "activeOrder"],
    queryFn: () =>
      buyerApiClient
        .get("/buyer/orders/active", fulfillPath ? { params: { fulfillPath } } : undefined)
        .then((r) => r.data),
  });
}

export function useBuyerOrders(params?: { page?: number; limit?: number; status?: string }) {
  return useQuery<Paginated<BuyerOrderListItem>>({
    queryKey: ["buyer", "orders", params],
    queryFn: () => buyerApiClient.get("/buyer/orders", { params }).then((r) => r.data),
  });
}

export function useBuyerOrder(orderId: string) {
  return useQuery<BuyerOrder>({
    queryKey: ["buyer", "order", orderId],
    queryFn: () => buyerApiClient.get(`/buyer/orders/${orderId}`).then((r) => r.data),
    enabled: !!orderId,
  });
}

/** How often a live "Track your delivery" card refreshes (#2095). */
export const BUYER_TRACKING_POLL_MS = 60_000;

/**
 * TanStack `refetchInterval` for the tracking card: every minute while the delivery is live, and
 * never once the order is delivered or cancelled. WHEN is the shared `isTrackingLive` rule (the
 * one mobile polls on); only the cadence is the web's.
 */
export function buyerTrackingRefetchInterval(
  data: OrderTrackingResponse | undefined,
): number | false {
  return isTrackingLive(data) ? BUYER_TRACKING_POLL_MS : false;
}

/**
 * #2095: the order's delivery tracking (driver first name, stops before you, delivery window).
 * Keyed UNDER the order's own key, so every invalidation of the order (cancel, edit, a realtime
 * order.statusChanged push) refreshes the card with it.
 */
export function useBuyerOrderTracking(orderId: string) {
  return useQuery<OrderTrackingResponse>({
    queryKey: ["buyer", "order", orderId, "tracking"],
    queryFn: () => buyerApiClient.get(`/buyer/orders/${orderId}/tracking`).then((r) => r.data),
    enabled: !!orderId,
    refetchInterval: (query) => buyerTrackingRefetchInterval(query.state.data),
  });
}

export function useBuyerCreateOrder() {
  const qc = useQueryClient();
  return useMutation({
    // The cart and shelf render their own sentence for the "order already placed" refusals.
    meta: { localErrorToast: (err: unknown) => buyerOrderConflict(err) !== null },
    mutationFn: (data: {
      items: Array<{
        productId: string;
        qty: number;
        boxes?: number;
        pieces?: number;
        notes?: string;
      }>;
      notes?: string;
      urgent?: boolean;
      requestedDeliveryDate?: string;
      status?: "DRAFT" | "PENDING";
      forceNew?: boolean;
      /** order ahead: the buyer's pickup / ship choice; omitted = the server's own default */
      fulfillPath?: FulfilmentMethod;
    }) =>
      // B1094: the same cart carries the same key, so a double click / timeout retry applies once.
      buyerApiClient
        .post("/buyer/orders", data, {
          headers: {
            "Idempotency-Key": buyerSubmitKeyFor(
              data,
              `${getStoredBuyerId() ?? ""}|${getStoredActiveSeller()?.tenant.id ?? ""}`,
            ),
          },
        })
        .then((r) => r.data),
    onSuccess: () => {
      clearBuyerSubmitKey();
      qc.invalidateQueries({ queryKey: ["buyer", "orders"] });
      qc.invalidateQueries({ queryKey: ["buyer", "dashboard"] });
      qc.invalidateQueries({ queryKey: ["buyer", "activeOrder"] });
    },
  });
}

export function useBuyerUpdateOrderItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, items }: { orderId: string; items: BuyerOrderItemEdit[] }) =>
      buyerApiClient
        .patch(`/buyer/orders/${orderId}/items`, { items, namesLines: true })
        .then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["buyer", "order", vars.orderId] });
      qc.invalidateQueries({ queryKey: ["buyer", "orders"] });
      qc.invalidateQueries({ queryKey: ["buyer", "dashboard"] });
      qc.invalidateQueries({ queryKey: ["buyer", "activeOrder"] });
    },
  });
}

export function useBuyerCancelOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) =>
      buyerApiClient.post(`/buyer/orders/${orderId}/cancel`).then((r) => r.data),
    onSuccess: (_d, orderId) => {
      qc.invalidateQueries({ queryKey: ["buyer", "order", orderId] });
      qc.invalidateQueries({ queryKey: ["buyer", "orders"] });
      qc.invalidateQueries({ queryKey: ["buyer", "dashboard"] });
      qc.invalidateQueries({ queryKey: ["buyer", "activeOrder"] });
    },
  });
}

/**
 * P5-10: file a post-dispatch change request against an order. Only valid once
 * the order's run has dispatched — the server 409s EDIT_WINDOW_OPEN while
 * direct editing is still available and CHANGE_WINDOW_CLOSED once the run is
 * no longer active (both mapped to friendly copy by the caller).
 */
export function useBuyerCreateChangeRequest() {
  const qc = useQueryClient();
  return useMutation<ChangeRequest, Error, BuyerCreateChangeRequestInput>({
    mutationFn: ({ orderId, ...dto }) =>
      buyerApiClient.post(`/buyer/orders/${orderId}/change-requests`, dto).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["buyer", "order", vars.orderId] });
    },
  });
}

// ─── Invoice Detail ──────────────────────────────────────────────────────────

export interface BuyerInvoiceDetail {
  id: string;
  invoiceNumber: string;
  /** Row 401: the server's answer to "a counter sale paid at the till" — no due date / terms shown. */
  paidAtSale?: boolean;
  revisedAt?: string | null;
  overpaidBy?: number | null;
  status: InvoiceStatus;
  subtotal: number;
  /** The stored header: the regular tax PLUS the regulated levy. Show `regularTaxAmount` and `chargeLines` instead. */
  taxAmount: number;
  /** Row 398: the regular tax alone (the header minus the lines' levy). Absent from an older server. */
  regularTaxAmount?: number;
  /** Row 398: one named charge per regulated category ("CRV deposit"), the same lines the PDF prints. */
  chargeLines?: Array<{ key: string; label: string; amount: number }>;
  discount: number;
  shippingFee: number;
  total: number;
  dueDate: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  paidAt: string | null;
  issueDate: string;
  pdfUrl: string | null;
  notes: string | null;
  terms: string | null;
  orderId: string | null;
  /** Server-computed CASH-ONLY amount paid (B421) — the API's `findOne` has
   *  always returned this field; the type simply hadn't declared it. */
  paidAmount?: number;
  /** Server-computed balance due — full confirmed total (cash + credit +
   *  advance), same basis as every other surface. */
  balanceDue?: number;
  /** Confirmed credit-note applications (B421) — reduces balanceDue but is
   *  never cash the buyer paid. */
  creditApplied?: number;
  /** Confirmed advance-payment applications (B421) — same treatment. */
  advanceApplied?: number;
  /** #2703: one declaration in @routeflow/types, shared with mobile. */
  items: BuyerInvoiceItem[];
  payments: BuyerInvoicePayment[];
  customer: { id: string; businessName: string };
}

export function useBuyerInvoice(invoiceId: string) {
  return useQuery<BuyerInvoiceDetail>({
    queryKey: ["buyer", "invoice", invoiceId],
    queryFn: () => buyerApiClient.get(`/buyer/invoices/${invoiceId}`).then((r) => r.data),
    enabled: !!invoiceId,
  });
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export function useBuyerDashboard(frequentWindow?: "30d" | "90d" | "all") {
  return useQuery<DashboardData>({
    queryKey: ["buyer", "dashboard", frequentWindow],
    queryFn: () =>
      buyerApiClient.get("/buyer/dashboard", { params: { frequentWindow } }).then((r) => r.data),
    // A5: seller-scoped — a call without X-Tenant-Slug 400s (see useBuyerShelf).
    enabled: !!getStoredActiveSeller(),
  });
}

// ─── Templates ────────────────────────────────────────────────────────────────

export function useBuyerTemplates() {
  return useQuery<{ data: BuyerOrderTemplate[]; meta: { total: number } }>({
    queryKey: ["buyer", "templates"],
    queryFn: () => buyerApiClient.get("/buyer/templates").then((r) => r.data),
    // A5: seller-scoped — a call without X-Tenant-Slug 400s (see useBuyerShelf).
    enabled: !!getStoredActiveSeller(),
  });
}

/** `localErrorToast`: the caller (the reorder review sheet) renders its own fixed error sentence,
 *  so the app-wide "Something went wrong…" toast must not also fire (one message per failure). */
export function useBuyerReorder(options?: { localErrorToast?: boolean }) {
  const qc = useQueryClient();
  return useMutation({
    meta: options?.localErrorToast ? { localErrorToast: true } : undefined,
    mutationFn: (templateId: string) =>
      buyerApiClient.post(`/buyer/templates/${templateId}/reorder`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer", "orders"] });
      qc.invalidateQueries({ queryKey: ["buyer", "dashboard"] });
    },
  });
}

// ─── Favorites ───────────────────────────────────────────────────────────────

export function useBuyerFavorites() {
  return useQuery<BuyerFavoriteProduct[]>({
    queryKey: ["buyer", "favorites"],
    queryFn: () => buyerApiClient.get("/buyer/favorites").then((r) => r.data),
  });
}

export function useBuyerAddFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (productId: string) =>
      buyerApiClient.post(`/buyer/favorites/${productId}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer", "favorites"] });
      qc.invalidateQueries({ queryKey: ["buyer", "catalog-counts"] });
      qc.invalidateQueries({ queryKey: ["buyer", "products"] });
    },
  });
}

export function useBuyerRemoveFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (productId: string) =>
      buyerApiClient.delete(`/buyer/favorites/${productId}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer", "favorites"] });
      qc.invalidateQueries({ queryKey: ["buyer", "catalog-counts"] });
      qc.invalidateQueries({ queryKey: ["buyer", "products"] });
    },
  });
}

// ─── Stock Alerts / Notify-me (P5-03) ─────────────────────────────────────────

export function useBuyerStockAlerts() {
  return useQuery<BuyerStockAlerts>({
    queryKey: ["buyer", "stock-alerts"],
    queryFn: () => buyerApiClient.get("/buyer/stock-alerts").then((r) => r.data),
    staleTime: 60 * 1000,
  });
}

export function useSubscribeStockAlert() {
  const qc = useQueryClient();
  return useMutation<{ subscribed: true }, Error, string>({
    mutationFn: (productId) =>
      buyerApiClient.post(`/buyer/products/${productId}/stock-alert`).then((r) => r.data),
    onSuccess: (_d, productId) => {
      qc.invalidateQueries({ queryKey: ["buyer", "stock-alerts"] });
      qc.invalidateQueries({ queryKey: ["buyer", "products"] });
      qc.invalidateQueries({ queryKey: ["buyer", "product", productId] });
    },
  });
}

export function useUnsubscribeStockAlert() {
  const qc = useQueryClient();
  return useMutation<{ subscribed: false }, Error, string>({
    mutationFn: (productId) =>
      buyerApiClient.delete(`/buyer/products/${productId}/stock-alert`).then((r) => r.data),
    onSuccess: (_d, productId) => {
      qc.invalidateQueries({ queryKey: ["buyer", "stock-alerts"] });
      qc.invalidateQueries({ queryKey: ["buyer", "products"] });
      qc.invalidateQueries({ queryKey: ["buyer", "product", productId] });
    },
  });
}

// ─── Analytics ────────────────────────────────────────────────────────────────

export function useBuyerAnalytics() {
  return useQuery<BuyerAnalytics>({
    queryKey: ["buyer", "analytics"],
    queryFn: () => buyerApiClient.get("/buyer/analytics").then((r) => r.data),
  });
}

// ─── Account Statement / Store Credit wallet (P5-13) ──────────────────────────

export function useBuyerStatement() {
  return useQuery<BuyerStatement>({
    queryKey: ["buyer", "statement"],
    queryFn: () => buyerApiClient.get("/buyer/statement").then((r) => r.data),
    staleTime: 30 * 1000,
  });
}

// ─── Payments & Remittance (P5-14) ────────────────────────────────────────────

export function useBuyerPayments(params?: { page?: number; limit?: number }) {
  return useQuery<Paginated<BuyerPayment>>({
    queryKey: ["buyer", "payments", params],
    queryFn: () => buyerApiClient.get("/buyer/payments", { params }).then((r) => r.data),
  });
}

export function useBuyerRemittance() {
  return useQuery<BuyerRemittance>({
    queryKey: ["buyer", "remittance"],
    queryFn: () => buyerApiClient.get("/buyer/remittance").then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  });
}

// ─── Monthly statements (P5-15) ───────────────────────────────────────────────
export function useBuyerStatementMonths() {
  return useQuery<{ months: string[] }>({
    queryKey: ["buyer", "statement-months"],
    queryFn: () => buyerApiClient.get("/buyer/statements").then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  });
}

/** Imperative (generation is slow): returns the presigned URL. Callers MUST
 *  download via fetchPdfBlob + programmatic <a download> — never <a href>/window.open. */
export async function fetchStatementPdfUrl(month: string): Promise<string> {
  const r = await buyerApiClient.get<{ url: string }>(`/buyer/statements/${month}`);
  return r.data.url;
}

// ─── Licenses & Authorizations (W6b — buyer self-serve) ──────────────────────────

/** License-required categories at the active seller, each with the buyer's status. */
export function useBuyerAuthorizations() {
  return useQuery<BuyerAuthorizationRow[]>({
    queryKey: ["buyer", "authorizations"],
    queryFn: () => buyerApiClient.get("/buyer/authorizations").then((r) => r.data),
  });
}

/** Submit or renew a license for the active seller's review (→ PENDING_REVIEW). */
export function useSubmitBuyerAuthorization(options?: { localErrorToast?: boolean }) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, SubmitBuyerAuthorizationInput>({
    meta: options?.localErrorToast ? { localErrorToast: true } : undefined,
    mutationFn: (dto) => buyerApiClient.post("/buyer/authorizations", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["buyer", "authorizations"] }),
  });
}
