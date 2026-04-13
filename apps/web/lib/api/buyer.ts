"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { buyerApiClient } from "@/lib/buyer-api-client";

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
    product: { id: string; name: string; unit: string };
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

// ─── Product catalog ──────────────────────────────────────────────────────────

export function useBuyerProducts(params?: {
  search?: string;
  category?: string;
  page?: number;
  limit?: number;
  sort?: string;
}) {
  return useQuery<Paginated<BuyerProduct>>({
    queryKey: ["buyer", "products", params],
    queryFn: () =>
      buyerApiClient
        .get("/buyer/products", { params })
        .then((r) => r.data),
  });
}

export function useBuyerProduct(productId: string) {
  return useQuery<BuyerProductDetail>({
    queryKey: ["buyer", "product", productId],
    queryFn: () => buyerApiClient.get(`/buyer/products/${productId}`).then((r) => r.data),
    enabled: !!productId,
  });
}

export function useBuyerCategories() {
  return useQuery<string[]>({
    queryKey: ["buyer", "categories"],
    queryFn: () => buyerApiClient.get("/buyer/products/categories").then((r) => r.data),
    staleTime: 5 * 60 * 1000, // 5 min
  });
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export function useBuyerActiveOrder() {
  return useQuery<BuyerOrder | null>({
    queryKey: ["buyer", "activeOrder"],
    queryFn: () =>
      buyerApiClient.get("/buyer/orders/active").then((r) => r.data),
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
    queryFn: () =>
      buyerApiClient.get("/buyer/orders", { params }).then((r) => r.data),
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
      items: Array<{ productId: string; qty: number; notes?: string }>;
      notes?: string;
      urgent?: boolean;
      requestedDeliveryDate?: string;
      status?: "DRAFT" | "PENDING";
    }) => buyerApiClient.post("/buyer/orders", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer", "orders"] });
      qc.invalidateQueries({ queryKey: ["buyer", "dashboard"] });
    },
  });
}

export function useBuyerUpdateOrderItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, items }: { orderId: string; items: Array<{ productId: string; qty: number }> }) =>
      buyerApiClient.patch(`/buyer/orders/${orderId}/items`, { items }).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["buyer", "order", vars.orderId] });
      qc.invalidateQueries({ queryKey: ["buyer", "orders"] });
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
    },
  });
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export function useBuyerDashboard(frequentWindow?: "30d" | "90d" | "all") {
  return useQuery<DashboardData>({
    queryKey: ["buyer", "dashboard", frequentWindow],
    queryFn: () =>
      buyerApiClient
        .get("/buyer/dashboard", { params: { frequentWindow } })
        .then((r) => r.data),
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
