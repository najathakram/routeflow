import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { buyerApiClient } from "../buyer-auth";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BuyerProduct {
  id: string;
  name: string;
  description?: string;
  category?: string;
  unit?: string;
  /** Legacy field — may be absent. Prefer buyerPrice then basePrice. */
  price?: number;
  buyerPrice?: number;
  basePrice?: number;
  imageUrl?: string;
  isFavorite?: boolean;
}

export interface BuyerOrder {
  id: string;
  orderNumber?: string;
  status: string;
  createdAt: string;
  requestedDeliveryDate?: string;
  notes?: string;
  urgent?: boolean;
  lineItems: Array<{
    id: string;
    productId: string;
    qty: number;
    unitPrice: number;
    product?: { id: string; name: string; unit?: string };
  }>;
  total?: number;
}

export interface BuyerInvoiceItem {
  id: string;
  description: string;
  qty: number;
  unitPrice: number;
  discount?: number;
  subtotal: number;
  product?: { id: string; name: string; unit?: string };
}

export interface BuyerInvoicePayment {
  id: string;
  amount: number;
  createdAt: string;
  paymentMethod?: string;
  reference?: string;
  notes?: string;
}

export interface BuyerInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  issueDate?: string;
  dueDate?: string;
  subtotal?: number;
  tax?: number;
  total: number;
  amountPaid?: number;
  paidAmount?: number;
  amountDue?: number;
  balanceDue?: number;
  isOverdue?: boolean;
  customer?: { id: string; businessName: string };
  items?: BuyerInvoiceItem[];
  payments?: BuyerInvoicePayment[];
}

export interface BuyerProfile {
  id: string;
  businessName: string;
  email?: string;
  phone?: string;
  address?: { line1?: string; city?: string; postcode?: string };
}

export interface BuyerDashboard {
  recentOrders: BuyerOrder[];
  frequentItems: Array<{ productId: string; name: string; totalQty: number }>;
  stats: { totalOrders: number; totalSpend: number; unpaidInvoices: number };
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

export function useBuyerProducts(params?: {
  search?: string;
  category?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery<{ data: BuyerProduct[]; meta: { total: number } }>({
    queryKey: ["buyer-products", params],
    queryFn: () =>
      buyerApiClient
        .get("/buyer/products", { params: { limit: 50, ...params } })
        .then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useBuyerCategories() {
  return useQuery<string[]>({
    queryKey: ["buyer-categories"],
    queryFn: () => buyerApiClient.get("/buyer/products/categories").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function useBuyerFavorites() {
  return useQuery<BuyerProduct[]>({
    queryKey: ["buyer-favorites"],
    queryFn: () => buyerApiClient.get("/buyer/favorites").then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useToggleFavorite() {
  const qc = useQueryClient();
  return useMutation<void, Error, { productId: string; isFavorite: boolean }>({
    mutationFn: ({ productId, isFavorite }) =>
      isFavorite
        ? buyerApiClient.delete(`/buyer/favorites/${productId}`).then(() => undefined)
        : buyerApiClient.post(`/buyer/favorites/${productId}`).then(() => undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buyer-favorites"] });
      qc.invalidateQueries({ queryKey: ["buyer-products"] });
    },
  });
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export function useBuyerOrders(params?: { status?: string; page?: number; limit?: number }) {
  return useQuery<{ data: BuyerOrder[]; meta: any }>({
    queryKey: ["buyer-orders", params],
    queryFn: () =>
      buyerApiClient
        .get("/buyer/orders", { params: { limit: 30, ...params } })
        .then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useBuyerOrder(id: string) {
  return useQuery<BuyerOrder>({
    queryKey: ["buyer-orders", id],
    queryFn: () => buyerApiClient.get(`/buyer/orders/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useBuyerCreateOrder() {
  const qc = useQueryClient();
  return useMutation<
    BuyerOrder,
    Error,
    {
      items: Array<{ productId: string; qty: number }>;
      notes?: string;
      urgent?: boolean;
      requestedDeliveryDate?: string;
    }
  >({
    mutationFn: (dto) => buyerApiClient.post("/buyer/orders", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["buyer-orders"] }),
  });
}

export function useBuyerCancelOrder() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) =>
      buyerApiClient.post(`/buyer/orders/${id}/cancel`).then(() => undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["buyer-orders"] }),
  });
}

// ─── Invoices ─────────────────────────────────────────────────────────────────

export function useBuyerInvoices(params?: { status?: string; statuses?: string[]; page?: number; limit?: number }) {
  return useQuery<{ data: BuyerInvoice[]; meta: any }>({
    queryKey: ["buyer-invoices", params],
    queryFn: () =>
      buyerApiClient
        .get("/buyer/invoices", { params: { limit: 30, ...params } })
        .then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useBuyerInvoice(id: string) {
  return useQuery<BuyerInvoice>({
    queryKey: ["buyer-invoices", id],
    queryFn: () => buyerApiClient.get(`/buyer/invoices/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Profile & Dashboard ──────────────────────────────────────────────────────

export function useBuyerProfile() {
  return useQuery<BuyerProfile>({
    queryKey: ["buyer-profile"],
    queryFn: () => buyerApiClient.get("/buyer/profile").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function useBuyerDashboard() {
  return useQuery<BuyerDashboard>({
    queryKey: ["buyer-dashboard"],
    queryFn: () => buyerApiClient.get("/buyer/dashboard").then((r) => r.data),
    staleTime: 60_000,
  });
}

// ─── Standing orders ──────────────────────────────────────────────────────────

export function useBuyerTemplates() {
  return useQuery<any[]>({
    queryKey: ["buyer-templates"],
    queryFn: () =>
      buyerApiClient.get("/buyer/templates").then((r) => {
        const body = r.data;
        return Array.isArray(body) ? body : (body?.data ?? []);
      }),
    staleTime: 60_000,
  });
}

export function useBuyerReorder() {
  const qc = useQueryClient();
  return useMutation<BuyerOrder, Error, string>({
    mutationFn: (templateId) =>
      buyerApiClient.post(`/buyer/templates/${templateId}/reorder`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["buyer-orders"] }),
  });
}

export function useBuyerUpdateTemplate() {
  const qc = useQueryClient();
  return useMutation<any, Error, { id: string; isActive: boolean }>({
    mutationFn: ({ id, isActive }) =>
      buyerApiClient.patch(`/buyer/templates/${id}`, { isActive }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["buyer-templates"] }),
  });
}

export function useBuyerUpdateOrderItems() {
  const qc = useQueryClient();
  return useMutation<
    BuyerOrder,
    Error,
    { orderId: string; items: Array<{ productId: string; qty: number }> }
  >({
    mutationFn: ({ orderId, items }) =>
      buyerApiClient.patch(`/buyer/orders/${orderId}/items`, { items }).then((r) => r.data),
    onSuccess: (_, { orderId }) => {
      qc.invalidateQueries({ queryKey: ["buyer-orders"] });
      qc.invalidateQueries({ queryKey: ["buyer-order", orderId] });
    },
  });
}
