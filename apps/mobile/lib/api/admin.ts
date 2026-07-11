import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export interface AdminDashboardStats {
  pendingOrders: number;
  activeRoutes: number;
  activeDrivers: number;
  totalCustomers: number;
  revenueThisMonth: number;
  invoicesOverdue: number;
  lowStockProducts: number;
  returnsToProcess: number;
}

/**
 * There is no single /dashboard/stats endpoint on the API, so we aggregate
 * the counts client-side from existing list endpoints using their `meta.total`
 * values (limit=1 keeps payloads small). The web dashboard does the same kind
 * of aggregation per-panel.
 */
async function fetchDashboardStats(): Promise<AdminDashboardStats> {
  const safeTotal = async (path: string, params?: Record<string, unknown>): Promise<number> => {
    try {
      const r = await apiClient.get(path, { params: { ...(params ?? {}), limit: 1 } });
      return Number(r.data?.meta?.total ?? 0);
    } catch {
      return 0;
    }
  };
  const safeGet = async <T>(path: string): Promise<T | null> => {
    try {
      const r = await apiClient.get(path);
      return r.data as T;
    } catch {
      return null;
    }
  };

  const [
    pendingOrders,
    activeDrivers,
    totalCustomers,
    invoicesOverdue,
    lowTotal,
    outOfStockTotal,
    returnsToProcess,
    routesResp,
    bookkeeping,
  ] = await Promise.all([
    safeTotal("/orders", { status: "PENDING" }),
    safeTotal("/drivers", { status: "ACTIVE" }),
    safeTotal("/customers"),
    // Use bookkeeping summary's overdueCount: SENT/VIEWED/PARTIAL with dueDate < now
    safeGet<{ overdueCount?: number }>("/bookkeeping/summary").then((r) =>
      Number(r?.overdueCount ?? 0),
    ),
    // Server's LOW filter matches `currentStock <= 5` which includes zeros /
    // negatives (out-of-stock). Subtract OUT_OF_STOCK to get items that are
    // actually low but still available to sell (1–5 units).
    safeTotal("/products", { stockStatus: "LOW" }),
    safeTotal("/products", { stockStatus: "OUT_OF_STOCK" }),
    safeTotal("/returns", { status: "PENDING" }),
    apiClient
      .get("/routes", { params: { limit: 100 } })
      .then((r) => r.data as { data: Array<{ runs?: Array<{ status?: string }> }> })
      .catch(() => ({ data: [] as Array<{ runs?: Array<{ status?: string }> }> })),
    safeGet<{ revenue?: number }>("/bookkeeping/summary"),
  ]);

  const activeRoutes = (routesResp.data ?? []).filter(
    (r) => r.runs?.[0]?.status === "IN_PROGRESS" || r.runs?.[0]?.status === "COMPLETED",
  ).length;

  return {
    pendingOrders,
    activeRoutes,
    activeDrivers,
    totalCustomers,
    revenueThisMonth: Number(bookkeeping?.revenue ?? 0),
    invoicesOverdue,
    lowStockProducts: Math.max(0, lowTotal - outOfStockTotal),
    returnsToProcess,
  };
}

export function useAdminDashboard() {
  return useQuery<AdminDashboardStats>({
    queryKey: ["admin", "dashboard"],
    queryFn: fetchDashboardStats,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

// ─── Orders (Admin) ───────────────────────────────────────────────────────────

export interface AdminOrder {
  id: string;
  orderNumber: string;
  status: string;
  urgent: boolean;
  subtotal: number;
  tax: number;
  total: number;
  notes?: string;
  requestedDeliveryDate?: string;
  deliveredAt?: string;
  /** Carrier shipment tracking (when goods ship via a carrier, not our own route). */
  shippingCarrier?: string | null;
  shippingTrackingNumber?: string | null;
  shippedAt?: string | null;
  createdAt: string;
  customer?: {
    id: string;
    businessName: string;
    contactName?: string;
    phone?: string;
    /** Mobile number — preferred for WhatsApp/SMS over the landline `phone`. */
    mobile?: string;
    email?: string;
  };
  lineItems: Array<{
    id: string;
    /** Null for an unlisted (ad-hoc, non-catalog) line — `name` carries the label. */
    productId: string | null;
    /** Free-text label for an unlisted line (productId null, priceType "MANUAL"). */
    name?: string | null;
    qty: number;
    /**
     * Total pieces already invoiced across all partial invoices for this
     * order line. The split-invoice flow reads `qty - invoicedQty` to
     * compute "remaining" — without this exposed in the type, the screens
     * had to cast through `any`, which masked stale-cache bugs.
     */
    invoicedQty?: number;
    /**
     * When the operator split a boxed product, `boxes` + `pieces` are stored
     * alongside the total `qty`. The line subtotal uses BOX-price proration
     * (unitPrice × (boxes + pieces / unitsPerBox)) — see common/pricing.ts.
     */
    boxes?: number | null;
    pieces?: number | null;
    unitPrice: number;
    /** Catalog base for an override line; unitPrice > originalPrice = upsell. */
    originalPrice?: number | null;
    /** STANDARD | SPECIAL | DISCOUNTED | MANUAL | PROMO. */
    priceType?: string;
    subtotal: number;
    status: string;
    overrideReason?: string | null;
    /** Per-line note — carried onto the invoice line (buyer-visible). */
    notes?: string | null;
    product?: {
      id?: string;
      name: string;
      unit: string;
      unitsPerBox?: number | null;
      pricePerUnit?: number | string;
    };
  }>;
}

export function useAdminOrders(params?: {
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
  urgent?: boolean;
  customerId?: string;
}) {
  return useQuery<{ data: AdminOrder[]; meta: PaginationMeta }>({
    queryKey: ["admin", "orders", params],
    queryFn: () => apiClient.get("/orders", { params }).then((r) => r.data),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useAdminOrder(id: string) {
  return useQuery<AdminOrder>({
    queryKey: ["admin", "orders", id],
    queryFn: () => apiClient.get(`/orders/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useConfirmAdminOrder() {
  const qc = useQueryClient();
  return useMutation<AdminOrder, Error, string>({
    mutationFn: (id) =>
      apiClient.patch(`/orders/${id}/status`, { status: "CONFIRMED" }).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["admin", "orders"] });
      qc.invalidateQueries({ queryKey: ["admin", "orders", id] });
    },
  });
}

export function useCancelAdminOrder() {
  const qc = useQueryClient();
  return useMutation<AdminOrder, Error, string>({
    mutationFn: (id) =>
      apiClient.patch(`/orders/${id}/status`, { status: "CANCELLED" }).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["admin", "orders"] });
      qc.invalidateQueries({ queryKey: ["admin", "orders", id] });
    },
  });
}

// ─── Customers (Admin) ────────────────────────────────────────────────────────

export interface AdminCustomer {
  id: string;
  businessName: string;
  contactName?: string;
  phone?: string;
  email?: string;
  status: string;
  creditLimit?: number;
  userId?: string;
  createdAt: string;
}

export function useAdminCustomers(params?: {
  search?: string;
  status?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery<{ data: AdminCustomer[]; meta: PaginationMeta }>({
    queryKey: ["admin", "customers", params],
    queryFn: () => apiClient.get("/customers", { params }).then((r) => r.data),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useAdminCustomer(id: string) {
  return useQuery<AdminCustomer>({
    queryKey: ["admin", "customers", id],
    queryFn: () => apiClient.get(`/customers/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Invoices (Admin) ─────────────────────────────────────────────────────────

export interface AdminInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  total: number;
  subtotal: number;
  taxAmount?: number;
  discount?: number;
  dueDate?: string;
  issueDate?: string;
  balanceDue?: number;
  paidAmount?: number;
  isOverdue?: boolean;
  /** Carrier shipment tracking (when goods ship via a carrier, not our own route). */
  shippingCarrier?: string | null;
  shippingTrackingNumber?: string | null;
  shippedAt?: string | null;
  createdAt: string;
  customer?: { id: string; businessName: string; email?: string };
  payments?: Array<{
    id: string;
    amount: number;
    method: string;
    paymentNumber?: string;
    reference?: string;
    notes?: string;
    status?: string;
    bankCharges?: number;
    paidAt: string;
    createdAt: string;
  }>;
  items?: Array<{
    id: string;
    description: string;
    qty: number;
    /** Boxed denomination snapshot — when set, unitPrice is the BOX price. */
    boxes?: number | null;
    pieces?: number | null;
    unitsPerBox?: number | null;
    unitPrice: number;
    /** Catalog base for an override line; unitPrice > originalPrice = upsell. */
    originalPrice?: number | null;
    /** STANDARD | SPECIAL | DISCOUNTED | MANUAL | PROMO. */
    priceType?: string;
    subtotal: number;
    /** Per-line note carried from the order line (buyer-visible). */
    notes?: string | null;
  }>;
}

export function useAdminInvoices(params?: {
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
  customerId?: string;
  isOverdue?: boolean;
  /** When true, return ONLY invoices that have a tracking number (shipments list). */
  shipped?: boolean;
}) {
  return useQuery<{ data: AdminInvoice[]; meta: PaginationMeta }>({
    queryKey: ["admin", "invoices", params],
    queryFn: () => apiClient.get("/invoices", { params }).then((r) => r.data),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useAdminInvoice(id: string) {
  return useQuery<AdminInvoice>({
    queryKey: ["admin", "invoices", id],
    queryFn: () => apiClient.get(`/invoices/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useVoidAdminInvoice() {
  const qc = useQueryClient();
  return useMutation<AdminInvoice, Error, string>({
    mutationFn: (id) => apiClient.post(`/invoices/${id}/void`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices", id] });
    },
  });
}

export function useRecordAdminPayment() {
  const qc = useQueryClient();
  return useMutation<
    AdminInvoice,
    Error,
    { id: string; amount: number; method: string; reference?: string }
  >({
    mutationFn: ({ id, ...dto }) =>
      apiClient.post(`/invoices/${id}/payments`, dto).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices", id] });
    },
  });
}

// ─── Products (Admin) ─────────────────────────────────────────────────────────

/**
 * Shape returned by `GET /products`. Note that Prisma Decimal columns
 * (`pricePerUnit`, `currentStock`) serialize to strings over JSON, so the
 * type reflects that and callers should coerce with `Number(...)` before
 * arithmetic. The Prisma schema field is `reorderPoint` (not `reorderLevel`).
 */
export interface AdminProduct {
  id: string;
  name: string;
  barcode?: string;
  sku?: string;
  unit: string;
  unitsPerBox?: number | null;
  pricePerUnit: number | string;
  priceTier2?: number | string;
  priceTier3?: number | string;
  priceTier4?: number | string;
  priceTier5?: number | string;
  standardCost?: number | string | null;
  currentStock: number | string;
  reorderPoint?: number | null;
  reorderQty?: number | null;
  isActive: boolean;
  /** Set when this product is a variant of another (self-referential). */
  parentProductId?: string | null;
  parent?: { id: string; name: string } | null;
  supplier?: { id: string; name: string };
}

export type StockStatusFilter = "IN_STOCK" | "LOW" | "OUT_OF_STOCK";

export function useAdminProducts(params?: {
  search?: string;
  page?: number;
  limit?: number;
  stockStatus?: StockStatusFilter;
  isActive?: boolean;
}) {
  return useQuery<{ data: AdminProduct[]; meta: PaginationMeta }>({
    queryKey: ["admin", "products", params],
    queryFn: () => apiClient.get("/products", { params }).then((r) => r.data),
    staleTime: 60_000,
  });
}

/**
 * Paged product list for scrollable screens. Pages through the WHOLE catalog
 * (the old single-shot `limit:100` call silently dropped everything past row
 * 100 — the "products missing on mobile" report). Key stays under
 * ["admin","products"] so the existing socket invalidation covers it.
 */
export function useAdminProductsInfinite(params?: {
  search?: string;
  stockStatus?: StockStatusFilter;
  isActive?: boolean;
  limit?: number;
}) {
  const limit = params?.limit ?? 50;
  return useInfiniteQuery({
    queryKey: ["admin", "products", "infinite", params],
    queryFn: ({ pageParam }) =>
      apiClient
        .get("/products", { params: { ...params, limit, page: pageParam } })
        .then((r) => r.data as { data: AdminProduct[]; meta: PaginationMeta }),
    initialPageParam: 1,
    getNextPageParam: (last) =>
      last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined,
    staleTime: 15_000,
  });
}

// ─── Routes & Drivers (Admin) ─────────────────────────────────────────────────

export interface AdminRouteRunSummary {
  id: string;
  status: string; // "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED"
  startedAt?: string;
  scheduledDate?: string;
}

/**
 * Shape returned by `GET /routes` (apps/api/src/routes/routes.service.ts:29).
 * It includes a `_count.stops` aggregate + the most-recent run (`runs[0]`).
 * Driver is NOT expanded; only `driverId` is returned.
 */
export interface AdminRoute {
  id: string;
  name: string;
  description?: string;
  isActive?: boolean;
  driverId?: string;
  _count?: { stops: number };
  runs?: AdminRouteRunSummary[];
}

export interface AdminRouteDetailStop {
  id: string;
  customerId: string;
  customer?: { id: string; businessName: string };
  customerAddress?: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    zip: string;
    lat?: number;
    lng?: number;
  };
  stopNumber: number;
}

export interface AdminRouteDetail extends AdminRoute {
  stops?: AdminRouteDetailStop[];
}

export function useAdminRoutes(params?: {
  search?: string;
  isActive?: boolean;
  page?: number;
  limit?: number;
}) {
  return useQuery<{ data: AdminRoute[]; meta: PaginationMeta }>({
    queryKey: ["admin", "routes", params],
    queryFn: () => apiClient.get("/routes", { params }).then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useAdminRoute(id: string | null | undefined) {
  return useQuery<AdminRouteDetail>({
    queryKey: ["admin", "routes", id],
    queryFn: () => apiClient.get(`/routes/${id}`).then((r) => r.data),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export interface AdminDriver {
  id: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehiclePlate?: string;
  status: string;
  user?: {
    id: string;
    firstName: string;
    lastName: string;
    username: string;
  };
}

export function useAdminDrivers(params?: { status?: string; page?: number; limit?: number }) {
  return useQuery<{ data: AdminDriver[]; meta: PaginationMeta }>({
    queryKey: ["admin", "drivers", params],
    queryFn: () => apiClient.get("/drivers", { params }).then((r) => r.data),
    staleTime: 60_000,
  });
}

// ─── Returns (Admin) ──────────────────────────────────────────────────────────

export interface AdminReturn {
  id: string;
  returnNumber?: string;
  status: string;
  reason: string;
  notes?: string;
  createdAt: string;
  order?: { orderNumber: string };
  customer?: { businessName: string };
  items?: Array<{
    id: string;
    qty: number;
    reason: string;
    product?: { name: string };
  }>;
}

export function useAdminReturns(params?: { status?: string; page?: number; limit?: number }) {
  return useQuery<{ data: AdminReturn[]; meta: PaginationMeta }>({
    queryKey: ["admin", "returns", params],
    queryFn: () => apiClient.get("/returns", { params }).then((r) => r.data),
    staleTime: 30_000,
  });
}

// ─── Finance Dashboard ────────────────────────────────────────────────────────

export interface FinanceDashboard {
  revenue: number;
  expenses: number;
  netIncome: number;
  totalInvoiced: number;
  totalCollected: number;
  totalOutstanding: number;
}

export function useAdminFinanceDashboard() {
  return useQuery<FinanceDashboard>({
    queryKey: ["admin", "finance", "dashboard"],
    queryFn: () =>
      apiClient
        .get("/bookkeeping/dashboard")
        .then((r) => r.data)
        .catch(() => ({
          revenue: 0,
          expenses: 0,
          netIncome: 0,
          totalInvoiced: 0,
          totalCollected: 0,
          totalOutstanding: 0,
        })),
    staleTime: 120_000,
  });
}

// ─── Analytics ────────────────────────────────────────────────────────────────

export interface RevenuePeriod {
  period: string;
  revenue: number;
}
export interface TopProduct {
  id: string;
  name: string;
  totalRevenue: number;
  unitsSold: number;
}
export interface TopCustomer {
  id: string;
  name: string;
  totalRevenue: number;
  orderCount: number;
}
export interface RoutePerformance {
  id: string;
  name: string;
  totalRuns: number;
  completedRuns: number;
  completionRate: number;
}
export interface DriverPerformance {
  id: string;
  name: string;
  totalDeliveries: number;
  completedDeliveries: number;
  completionRate: number;
}
export interface InventoryTurnover {
  id: string;
  name: string;
  unitsSold: number;
  currentStock: number;
  turnoverRate: number;
}
export interface DeadStock {
  id: string;
  name: string;
  currentStock: number;
  daysInactive: number;
}
export interface GrossMargin {
  revenue: number;
  cogs: number;
  grossProfit: number;
  grossMarginPct: number;
}
export interface SalesByCategory {
  category: string;
  revenue: number;
}

export function useAnalyticsRevenue(from?: string, to?: string) {
  return useQuery<RevenuePeriod[]>({
    queryKey: ["analytics", "revenue", from, to],
    queryFn: () =>
      apiClient
        .get("/analytics/revenue", { params: { from, to } })
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 120_000,
  });
}
export function useAnalyticsTopProducts(metric = "revenue") {
  return useQuery<TopProduct[]>({
    queryKey: ["analytics", "products", "top", metric],
    queryFn: () =>
      apiClient
        .get("/analytics/products/top", { params: { metric } })
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 120_000,
  });
}
export function useAnalyticsTopCustomers() {
  return useQuery<TopCustomer[]>({
    queryKey: ["analytics", "customers", "top"],
    queryFn: () =>
      apiClient
        .get("/analytics/customers/top")
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 120_000,
  });
}
export function useAnalyticsRoutePerformance() {
  return useQuery<RoutePerformance[]>({
    queryKey: ["analytics", "routes", "performance"],
    queryFn: () =>
      apiClient
        .get("/analytics/routes/performance")
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 120_000,
  });
}
export function useAnalyticsDriverPerformance() {
  return useQuery<DriverPerformance[]>({
    queryKey: ["analytics", "drivers", "performance"],
    queryFn: () =>
      apiClient
        .get("/analytics/drivers/performance")
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 120_000,
  });
}
export function useAnalyticsGrossMargin(from?: string, to?: string) {
  return useQuery<GrossMargin>({
    queryKey: ["analytics", "gross-margin", from, to],
    queryFn: () =>
      apiClient
        .get("/analytics/gross-margin", { params: { from, to } })
        .then((r) => r.data)
        .catch(() => ({ revenue: 0, cogs: 0, grossProfit: 0, grossMarginPct: 0 })),
    staleTime: 120_000,
  });
}
export function useAnalyticsSalesByCategory(from?: string, to?: string) {
  return useQuery<SalesByCategory[]>({
    queryKey: ["analytics", "sales-by-category", from, to],
    queryFn: () =>
      apiClient
        .get("/analytics/sales-by-category", { params: { from, to } })
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 120_000,
  });
}
export function useAnalyticsInventoryTurnover() {
  return useQuery<InventoryTurnover[]>({
    queryKey: ["analytics", "inventory", "turnover"],
    queryFn: () =>
      apiClient
        .get("/analytics/inventory/turnover")
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 120_000,
  });
}
export function useAnalyticsDeadStock() {
  return useQuery<DeadStock[]>({
    queryKey: ["analytics", "inventory", "dead-stock"],
    queryFn: () =>
      apiClient
        .get("/analytics/inventory/dead-stock")
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 120_000,
  });
}
export function useAnalyticsDso() {
  return useQuery<{ dso: number; count: number }>({
    queryKey: ["analytics", "dso"],
    queryFn: () =>
      apiClient
        .get("/analytics/dso")
        .then((r) => r.data)
        .catch(() => ({ dso: 0, count: 0 })),
    staleTime: 120_000,
  });
}
export function useAnalyticsAov(from?: string, to?: string) {
  return useQuery<{ aov: number }>({
    queryKey: ["analytics", "aov", from, to],
    queryFn: () =>
      apiClient
        .get("/analytics/aov", { params: { from, to } })
        .then((r) => r.data)
        .catch(() => ({ aov: 0 })),
    staleTime: 120_000,
  });
}

// ─── Reports ─────────────────────────────────────────────────────────────────

export interface ArAgingRow {
  bucket: string;
  count: number;
  total: number;
}
export interface SalesByCustomerRow {
  customerId: string;
  customerName: string;
  totalRevenue: number;
  orderCount: number;
}
export interface SalesByItemRow {
  productId: string;
  productName: string;
  totalRevenue: number;
  unitsSold: number;
}
export interface PaymentReceivedRow {
  id: string;
  invoiceNumber: string;
  customerName: string;
  amount: number;
  method: string;
  paidAt: string;
}
export interface ProfitLoss {
  revenue: number;
  cogs: number;
  grossProfit: number;
  expenses: number;
  netIncome: number;
  grossMarginPct: number;
}
export interface CustomerBalanceRow {
  customerId: string;
  customerName: string;
  totalInvoiced: number;
  totalPaid: number;
  balance: number;
}

export function useReportArAging() {
  return useQuery<ArAgingRow[]>({
    queryKey: ["reports", "ar-aging"],
    queryFn: () =>
      apiClient
        .get("/bookkeeping/reports/aging")
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 120_000,
  });
}
export function useReportSalesByCustomer(from?: string, to?: string) {
  return useQuery<SalesByCustomerRow[]>({
    queryKey: ["reports", "sales-by-customer", from, to],
    queryFn: () =>
      apiClient
        .get("/bookkeeping/reports/sales-by-customer", { params: { from, to } })
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 120_000,
  });
}
export function useReportSalesByItem(from?: string, to?: string) {
  return useQuery<SalesByItemRow[]>({
    queryKey: ["reports", "sales-by-item", from, to],
    queryFn: () =>
      apiClient
        .get("/bookkeeping/reports/sales-by-item", { params: { from, to } })
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 120_000,
  });
}
export function useReportPaymentsReceived(from?: string, to?: string) {
  return useQuery<PaymentReceivedRow[]>({
    queryKey: ["reports", "payments-received", from, to],
    queryFn: () =>
      apiClient
        .get("/bookkeeping/reports/payments-received", { params: { from, to } })
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 120_000,
  });
}
export function useReportProfitLoss(from?: string, to?: string) {
  return useQuery<ProfitLoss>({
    queryKey: ["reports", "pl", from, to],
    queryFn: () =>
      apiClient
        .get("/bookkeeping/reports/pl", { params: { from, to } })
        .then((r) => r.data)
        .catch(() => ({
          revenue: 0,
          cogs: 0,
          grossProfit: 0,
          expenses: 0,
          netIncome: 0,
          grossMarginPct: 0,
        })),
    staleTime: 120_000,
  });
}
export function useReportCustomerBalance() {
  return useQuery<CustomerBalanceRow[]>({
    queryKey: ["reports", "customer-balance"],
    queryFn: () =>
      apiClient
        .get("/bookkeeping/reports/customer-balance")
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 120_000,
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export interface BusinessSettings {
  businessName?: string;
  ownerName?: string;
  phone?: string;
  email?: string;
  street?: string;
  city?: string;
  zip?: string;
  taxRate?: number;
}

export interface AppUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  role: string;
  isActive: boolean;
  createdAt: string;
}

export function useBusinessSettings() {
  return useQuery<BusinessSettings>({
    queryKey: ["settings"],
    queryFn: () =>
      apiClient
        .get("/settings")
        .then((r) => r.data)
        .catch(() => ({})),
    staleTime: 300_000,
  });
}

export function useUpdateBusinessSettings() {
  const qc = useQueryClient();
  return useMutation<BusinessSettings, Error, BusinessSettings>({
    mutationFn: (data) => apiClient.patch("/settings", data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
}

export function useAdminUsers(params?: {
  search?: string;
  status?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery<{ data: AppUser[]; meta: PaginationMeta }>({
    queryKey: ["admin", "users", params],
    queryFn: () =>
      apiClient
        .get("/users", { params: { limit: 100, ...params } })
        .then((r) => {
          // NEW-vop-5: API returns status: "ACTIVE" | "INACTIVE" | "SUSPENDED" but
          // the UI + toggle mutation expect a derived isActive boolean. Map here so
          // every consumer of useAdminUsers gets the boolean shape.
          const raw = r.data as {
            data?: Array<AppUser & { status?: string }>;
            meta?: PaginationMeta;
          };
          const list = (raw.data ?? []).map((u) => ({
            ...u,
            isActive: u.isActive ?? u.status === "ACTIVE",
          }));
          return {
            data: list,
            meta: raw.meta ?? { total: list.length, page: 1, limit: 100, totalPages: 1 },
          };
        })
        .catch(() => ({
          data: [] as AppUser[],
          meta: { total: 0, page: 1, limit: 100, totalPages: 0 },
        })),
    staleTime: 60_000,
  });
}

export function useCreateAdminUser() {
  const qc = useQueryClient();
  return useMutation<
    AppUser,
    Error,
    {
      firstName: string;
      lastName: string;
      username: string;
      email?: string;
      role: string;
      password: string;
    }
  >({
    mutationFn: (data) => apiClient.post("/users/operator", data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}

export function useToggleUserStatus() {
  const qc = useQueryClient();
  return useMutation<AppUser, Error, { id: string; isActive: boolean }>({
    mutationFn: ({ id, isActive }) =>
      apiClient.patch(`/users/${id}/status`, { isActive }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}
