"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { buyerApiClient } from "@/lib/buyer-api-client";
import type { ExpiringAuthorization } from "./authorizations";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BuyerProduct {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  unit: string;
  category: string | null;
  buyerPrice: number;
  unitsPerBox: number | null;
  thumbnailUrl: string | null;
  imageKeys: string[];
  isFeatured: boolean;
}

export interface BuyerProductDetail extends BuyerProduct {
  imageUrls: string[];
  variants: Array<{
    id: string;
    name: string;
    sku: string | null;
    buyerPrice: number;
    unit: string;
  }>;
}

export interface BuyerOrder {
  id: string;
  orderNumber: string;
  status: string;
  total: number;
  subtotal: number;
  tax: number;
  discountAmount: number;
  urgent: boolean;
  notes: string | null;
  requestedDeliveryDate: string | null;
  createdAt: string;
  customer: { id: string; businessName: string };
  lineItems: Array<{
    id: string;
    productId: string;
    qty: number;
    unitPrice: number;
    subtotal: number;
    priceType: string;
    originalPrice: number | null;
    notes: string | null;
    status: string;
    deliveredQty: number;
    boxes: number | null;
    pieces: number | null;
    product: { id: string; name: string; unit: string; unitsPerBox?: number | null };
  }>;
  invoices?: Array<{ id: string; invoiceNumber: string; status: string; total: number }>;
}

export interface DashboardData {
  recentOrders: Array<{
    id: string;
    orderNumber: string;
    status: string;
    total: number;
    createdAt: string;
    requestedDeliveryDate: string | null;
    itemCount: number;
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

export interface OrderTemplate {
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
    product: { id: string; name: string; unit: string };
  }>;
  customer: { id: string; businessName: string };
}

interface Paginated<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

/** A regulated category hidden from this buyer pending license verification (W7b). */
export interface LockedCategory {
  id: string;
  name: string;
  status: "NONE" | "PENDING_REVIEW" | "EXPIRED" | "REJECTED";
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
}) {
  return useQuery<BuyerCatalogResult>({
    queryKey: ["buyer", "products", params],
    queryFn: () => buyerApiClient.get("/buyer/products", { params }).then((r) => r.data),
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

// ─── Promotions (P5-04) ─────────────────────────────────────────────────────────

/** Active promotion rule for the current seller (GET /buyer/promotions). Shape
 * matches PromotionsService.activeForCatalog + the `PromotionRule` the shared
 * `applyBestPromotion` (lib/pricing) evaluator consumes. */
export interface BuyerPromotion {
  id: string;
  name: string;
  bannerText: string | null;
  type: "PERCENT" | "FIXED" | "QTY_BREAK";
  value: number;
  minQty: number | null;
  scope: "ALL" | "CATEGORY" | "PRODUCTS";
  category: string | null;
  startsAt: string;
  endsAt: string;
  productIds: string[];
}

export function useBuyerPromotions() {
  return useQuery<BuyerPromotion[]>({
    queryKey: ["buyer", "promotions"],
    queryFn: () => buyerApiClient.get("/buyer/promotions").then((r) => r.data),
    staleTime: 5 * 60 * 1000, // 5 min
  });
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export function useBuyerActiveOrder() {
  return useQuery<BuyerOrder | null>({
    queryKey: ["buyer", "activeOrder"],
    queryFn: () => buyerApiClient.get("/buyer/orders/active").then((r) => r.data),
  });
}

export interface BuyerOrderListItem {
  id: string;
  orderNumber: string;
  status: string;
  total: number;
  totalAmount?: number;
  createdAt: string;
  itemCount?: number;
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

export function useBuyerCreateOrder() {
  const qc = useQueryClient();
  return useMutation({
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
    }) => buyerApiClient.post("/buyer/orders", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer", "orders"] });
      qc.invalidateQueries({ queryKey: ["buyer", "dashboard"] });
      qc.invalidateQueries({ queryKey: ["buyer", "activeOrder"] });
    },
  });
}

export function useBuyerUpdateOrderItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      orderId,
      items,
    }: {
      orderId: string;
      items: Array<{ productId: string; qty: number }>;
    }) => buyerApiClient.patch(`/buyer/orders/${orderId}/items`, { items }).then((r) => r.data),
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

// ─── Invoice Detail ──────────────────────────────────────────────────────────

export interface BuyerInvoiceDetail {
  id: string;
  invoiceNumber: string;
  status: string;
  subtotal: number;
  taxAmount: number;
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
  items: Array<{
    id: string;
    description: string;
    productId: string | null;
    qty: number;
    unitPrice: number;
    discount: number;
    subtotal: number;
    priceType: string;
  }>;
  payments: Array<{
    id: string;
    amount: number;
    method: string;
    recordedAt: string;
  }>;
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
  });
}

// ─── Templates ────────────────────────────────────────────────────────────────

export function useBuyerTemplates() {
  return useQuery<{ data: OrderTemplate[]; meta: { total: number } }>({
    queryKey: ["buyer", "templates"],
    queryFn: () => buyerApiClient.get("/buyer/templates").then((r) => r.data),
  });
}

export function useBuyerReorder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) =>
      buyerApiClient.post(`/buyer/templates/${templateId}/reorder`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer", "orders"] });
      qc.invalidateQueries({ queryKey: ["buyer", "dashboard"] });
    },
  });
}

// ─── Favorites ───────────────────────────────────────────────────────────────

export interface BuyerFavoriteItem {
  id: string;
  productId: string;
  name: string;
  sku: string | null;
  unit: string;
  category: string | null;
  buyerPrice: number;
  thumbnailUrl: string | null;
  imageKeys: string[];
  createdAt: string;
}

export function useBuyerFavorites() {
  return useQuery<BuyerFavoriteItem[]>({
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
    },
  });
}

// ─── Analytics ────────────────────────────────────────────────────────────────

export interface BuyerAnalytics {
  monthlySpend: Array<{ month: string; spend: number; orderCount: number }>;
  summary: {
    totalOrders: number;
    totalSpend: number;
    avgOrderValue: number;
    unpaidInvoiceCount: number;
    unpaidInvoiceTotal: number;
  };
  invoiceBreakdown: { paid: number; unpaid: number; overdue: number };
  recentPayments: Array<{ date: string; amount: number; method: string; invoiceNumber: string }>;
}

export function useBuyerAnalytics() {
  return useQuery<BuyerAnalytics>({
    queryKey: ["buyer", "analytics"],
    queryFn: () => buyerApiClient.get("/buyer/analytics").then((r) => r.data),
  });
}

// ─── Licenses & Authorizations (W6b — buyer self-serve) ──────────────────────────

export interface BuyerAuthorizationRow {
  trackedCategoryId: string;
  categoryName: string;
  status: "NONE" | "PENDING_REVIEW" | "VERIFIED" | "EXPIRED" | "REJECTED";
  source: "RETAILER_SUBMITTED" | "WHOLESALER_ADDED" | null;
  licenseNumber: string | null;
  expiresAt: string | null;
  documentKey: string | null;
  submittedAt: string | null;
  verifiedAt: string | null;
}

export interface SubmitBuyerAuthorizationInput {
  trackedCategoryId: string;
  licenseNumber: string;
  expiresAt: string; // ISO 8601
  documentKey?: string;
  shareConsent: boolean;
}

/** License-required categories at the active seller, each with the buyer's status. */
export function useBuyerAuthorizations() {
  return useQuery<BuyerAuthorizationRow[]>({
    queryKey: ["buyer", "authorizations"],
    queryFn: () => buyerApiClient.get("/buyer/authorizations").then((r) => r.data),
  });
}

/** Submit or renew a license for the active seller's review (→ PENDING_REVIEW). */
export function useSubmitBuyerAuthorization() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, SubmitBuyerAuthorizationInput>({
    mutationFn: (dto) => buyerApiClient.post("/buyer/authorizations", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["buyer", "authorizations"] }),
  });
}
