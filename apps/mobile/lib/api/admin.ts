import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

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

export function useAdminDashboard() {
  return useQuery<AdminDashboardStats>({
    queryKey: ['admin', 'dashboard'],
    queryFn: () =>
      apiClient
        .get('/dashboard/stats')
        .then((r) => r.data)
        .catch(() => ({
          pendingOrders: 0,
          activeRoutes: 0,
          activeDrivers: 0,
          totalCustomers: 0,
          revenueThisMonth: 0,
          invoicesOverdue: 0,
          lowStockProducts: 0,
          returnsToProcess: 0,
        })),
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
  createdAt: string;
  customer?: {
    id: string;
    businessName: string;
    contactName?: string;
    phone?: string;
  };
  lineItems: Array<{
    id: string;
    productId: string;
    qty: number;
    unitPrice: number;
    subtotal: number;
    status: string;
    product?: { name: string; unit: string };
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
  return useQuery<{ data: AdminOrder[]; meta: any }>({
    queryKey: ['admin', 'orders', params],
    queryFn: () => apiClient.get('/orders', { params }).then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useAdminOrder(id: string) {
  return useQuery<AdminOrder>({
    queryKey: ['admin', 'orders', id],
    queryFn: () => apiClient.get(`/orders/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useConfirmAdminOrder() {
  const qc = useQueryClient();
  return useMutation<AdminOrder, Error, string>({
    mutationFn: (id) =>
      apiClient
        .patch(`/orders/${id}/status`, { status: 'CONFIRMED' })
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'orders'] }),
  });
}

export function useCancelAdminOrder() {
  const qc = useQueryClient();
  return useMutation<AdminOrder, Error, string>({
    mutationFn: (id) =>
      apiClient
        .patch(`/orders/${id}/status`, { status: 'CANCELLED' })
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'orders'] }),
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
  return useQuery<{ data: AdminCustomer[]; meta: any }>({
    queryKey: ['admin', 'customers', params],
    queryFn: () => apiClient.get('/customers', { params }).then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useAdminCustomer(id: string) {
  return useQuery<AdminCustomer>({
    queryKey: ['admin', 'customers', id],
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
  createdAt: string;
  customer?: { id: string; businessName: string };
  payments?: Array<{
    id: string;
    amount: number;
    method: string;
    createdAt: string;
  }>;
}

export function useAdminInvoices(params?: {
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
  customerId?: string;
}) {
  return useQuery<{ data: AdminInvoice[]; meta: any }>({
    queryKey: ['admin', 'invoices', params],
    queryFn: () => apiClient.get('/invoices', { params }).then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useAdminInvoice(id: string) {
  return useQuery<AdminInvoice>({
    queryKey: ['admin', 'invoices', id],
    queryFn: () => apiClient.get(`/invoices/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useVoidAdminInvoice() {
  const qc = useQueryClient();
  return useMutation<AdminInvoice, Error, string>({
    mutationFn: (id) =>
      apiClient.post(`/invoices/${id}/void`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'invoices'] }),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'invoices'] }),
  });
}

// ─── Products (Admin) ─────────────────────────────────────────────────────────

export interface AdminProduct {
  id: string;
  name: string;
  barcode?: string;
  sku?: string;
  unit: string;
  pricePerUnit: number;
  currentStock: number;
  reorderLevel?: number;
  isActive: boolean;
  supplier?: { id: string; name: string };
}

export function useAdminProducts(params?: {
  search?: string;
  page?: number;
  limit?: number;
  lowStock?: boolean;
}) {
  return useQuery<{ data: AdminProduct[]; meta: any }>({
    queryKey: ['admin', 'products', params],
    queryFn: () => apiClient.get('/products', { params }).then((r) => r.data),
    staleTime: 60_000,
  });
}

// ─── Routes & Drivers (Admin) ─────────────────────────────────────────────────

export interface AdminRoute {
  id: string;
  name: string;
  description?: string;
  status?: string;
  driverId?: string;
  driver?: {
    id: string;
    user?: { firstName: string; lastName: string };
  };
  stops?: Array<{
    id: string;
    customerId: string;
    customer?: { businessName: string };
    order: number;
  }>;
  activeRun?: { id: string; status: string; startedAt?: string };
}

export function useAdminRoutes(params?: {
  status?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery<{ data: AdminRoute[]; meta: any }>({
    queryKey: ['admin', 'routes', params],
    queryFn: () => apiClient.get('/routes', { params }).then((r) => r.data),
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

export function useAdminDrivers(params?: {
  status?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery<{ data: AdminDriver[]; meta: any }>({
    queryKey: ['admin', 'drivers', params],
    queryFn: () => apiClient.get('/drivers', { params }).then((r) => r.data),
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

export function useAdminReturns(params?: {
  status?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery<{ data: AdminReturn[]; meta: any }>({
    queryKey: ['admin', 'returns', params],
    queryFn: () => apiClient.get('/returns', { params }).then((r) => r.data),
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
    queryKey: ['admin', 'finance', 'dashboard'],
    queryFn: () =>
      apiClient
        .get('/bookkeeping/dashboard')
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

export interface RevenuePeriod { period: string; revenue: number; }
export interface TopProduct { id: string; name: string; totalRevenue: number; unitsSold: number; }
export interface TopCustomer { id: string; name: string; totalRevenue: number; orderCount: number; }
export interface RoutePerformance { id: string; name: string; totalRuns: number; completedRuns: number; completionRate: number; }
export interface DriverPerformance { id: string; name: string; totalDeliveries: number; completedDeliveries: number; completionRate: number; }
export interface InventoryTurnover { id: string; name: string; unitsSold: number; currentStock: number; turnoverRate: number; }
export interface DeadStock { id: string; name: string; currentStock: number; daysInactive: number; }
export interface GrossMargin { revenue: number; cogs: number; grossProfit: number; grossMarginPct: number; }
export interface SalesByCategory { category: string; revenue: number; }

export function useAnalyticsRevenue(from?: string, to?: string) {
  return useQuery<RevenuePeriod[]>({
    queryKey: ['analytics', 'revenue', from, to],
    queryFn: () => apiClient.get('/analytics/revenue', { params: { from, to } }).then(r => r.data).catch(() => []),
    staleTime: 120_000,
  });
}
export function useAnalyticsTopProducts(metric = 'revenue') {
  return useQuery<TopProduct[]>({
    queryKey: ['analytics', 'products', 'top', metric],
    queryFn: () => apiClient.get('/analytics/products/top', { params: { metric } }).then(r => r.data).catch(() => []),
    staleTime: 120_000,
  });
}
export function useAnalyticsTopCustomers() {
  return useQuery<TopCustomer[]>({
    queryKey: ['analytics', 'customers', 'top'],
    queryFn: () => apiClient.get('/analytics/customers/top').then(r => r.data).catch(() => []),
    staleTime: 120_000,
  });
}
export function useAnalyticsRoutePerformance() {
  return useQuery<RoutePerformance[]>({
    queryKey: ['analytics', 'routes', 'performance'],
    queryFn: () => apiClient.get('/analytics/routes/performance').then(r => r.data).catch(() => []),
    staleTime: 120_000,
  });
}
export function useAnalyticsDriverPerformance() {
  return useQuery<DriverPerformance[]>({
    queryKey: ['analytics', 'drivers', 'performance'],
    queryFn: () => apiClient.get('/analytics/drivers/performance').then(r => r.data).catch(() => []),
    staleTime: 120_000,
  });
}
export function useAnalyticsGrossMargin(from?: string, to?: string) {
  return useQuery<GrossMargin>({
    queryKey: ['analytics', 'gross-margin', from, to],
    queryFn: () => apiClient.get('/analytics/gross-margin', { params: { from, to } }).then(r => r.data).catch(() => ({ revenue: 0, cogs: 0, grossProfit: 0, grossMarginPct: 0 })),
    staleTime: 120_000,
  });
}
export function useAnalyticsSalesByCategory(from?: string, to?: string) {
  return useQuery<SalesByCategory[]>({
    queryKey: ['analytics', 'sales-by-category', from, to],
    queryFn: () => apiClient.get('/analytics/sales-by-category', { params: { from, to } }).then(r => r.data).catch(() => []),
    staleTime: 120_000,
  });
}
export function useAnalyticsInventoryTurnover() {
  return useQuery<InventoryTurnover[]>({
    queryKey: ['analytics', 'inventory', 'turnover'],
    queryFn: () => apiClient.get('/analytics/inventory/turnover').then(r => r.data).catch(() => []),
    staleTime: 120_000,
  });
}
export function useAnalyticsDeadStock() {
  return useQuery<DeadStock[]>({
    queryKey: ['analytics', 'inventory', 'dead-stock'],
    queryFn: () => apiClient.get('/analytics/inventory/dead-stock').then(r => r.data).catch(() => []),
    staleTime: 120_000,
  });
}
export function useAnalyticsDso() {
  return useQuery<{ dso: number; count: number }>({
    queryKey: ['analytics', 'dso'],
    queryFn: () => apiClient.get('/analytics/dso').then(r => r.data).catch(() => ({ dso: 0, count: 0 })),
    staleTime: 120_000,
  });
}
export function useAnalyticsAov(from?: string, to?: string) {
  return useQuery<{ aov: number }>({
    queryKey: ['analytics', 'aov', from, to],
    queryFn: () => apiClient.get('/analytics/aov', { params: { from, to } }).then(r => r.data).catch(() => ({ aov: 0 })),
    staleTime: 120_000,
  });
}

// ─── Reports ─────────────────────────────────────────────────────────────────

export interface ArAgingRow { bucket: string; count: number; total: number; }
export interface SalesByCustomerRow { customerId: string; customerName: string; totalRevenue: number; orderCount: number; }
export interface SalesByItemRow { productId: string; productName: string; totalRevenue: number; unitsSold: number; }
export interface PaymentReceivedRow { id: string; invoiceNumber: string; customerName: string; amount: number; method: string; paidAt: string; }
export interface ProfitLoss { revenue: number; cogs: number; grossProfit: number; expenses: number; netIncome: number; grossMarginPct: number; }
export interface CustomerBalanceRow { customerId: string; customerName: string; totalInvoiced: number; totalPaid: number; balance: number; }

export function useReportArAging() {
  return useQuery<ArAgingRow[]>({
    queryKey: ['reports', 'ar-aging'],
    queryFn: () => apiClient.get('/bookkeeping/reports/aging').then(r => r.data).catch(() => []),
    staleTime: 120_000,
  });
}
export function useReportSalesByCustomer(from?: string, to?: string) {
  return useQuery<SalesByCustomerRow[]>({
    queryKey: ['reports', 'sales-by-customer', from, to],
    queryFn: () => apiClient.get('/bookkeeping/reports/sales-by-customer', { params: { from, to } }).then(r => r.data).catch(() => []),
    staleTime: 120_000,
  });
}
export function useReportSalesByItem(from?: string, to?: string) {
  return useQuery<SalesByItemRow[]>({
    queryKey: ['reports', 'sales-by-item', from, to],
    queryFn: () => apiClient.get('/bookkeeping/reports/sales-by-item', { params: { from, to } }).then(r => r.data).catch(() => []),
    staleTime: 120_000,
  });
}
export function useReportPaymentsReceived(from?: string, to?: string) {
  return useQuery<PaymentReceivedRow[]>({
    queryKey: ['reports', 'payments-received', from, to],
    queryFn: () => apiClient.get('/bookkeeping/reports/payments-received', { params: { from, to } }).then(r => r.data).catch(() => []),
    staleTime: 120_000,
  });
}
export function useReportProfitLoss(from?: string, to?: string) {
  return useQuery<ProfitLoss>({
    queryKey: ['reports', 'pl', from, to],
    queryFn: () => apiClient.get('/bookkeeping/reports/pl', { params: { from, to } }).then(r => r.data).catch(() => ({ revenue: 0, cogs: 0, grossProfit: 0, expenses: 0, netIncome: 0, grossMarginPct: 0 })),
    staleTime: 120_000,
  });
}
export function useReportCustomerBalance() {
  return useQuery<CustomerBalanceRow[]>({
    queryKey: ['reports', 'customer-balance'],
    queryFn: () => apiClient.get('/bookkeeping/reports/customer-balance').then(r => r.data).catch(() => []),
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
    queryKey: ['settings'],
    queryFn: () => apiClient.get('/settings').then(r => r.data).catch(() => ({})),
    staleTime: 300_000,
  });
}

export function useUpdateBusinessSettings() {
  const qc = useQueryClient();
  return useMutation<BusinessSettings, Error, BusinessSettings>({
    mutationFn: (data) => apiClient.patch('/settings', data).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
}

export function useAdminUsers() {
  return useQuery<AppUser[]>({
    queryKey: ['admin', 'users'],
    queryFn: () => apiClient.get('/users').then(r => r.data).catch(() => []),
    staleTime: 60_000,
  });
}

export function useCreateAdminUser() {
  const qc = useQueryClient();
  return useMutation<AppUser, Error, { firstName: string; lastName: string; username: string; email?: string; role: string; password: string }>({
    mutationFn: (data) => apiClient.post('/users/operator', data).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });
}

export function useToggleUserStatus() {
  const qc = useQueryClient();
  return useMutation<AppUser, Error, { id: string; isActive: boolean }>({
    mutationFn: ({ id, isActive }) => apiClient.patch(`/users/${id}/status`, { isActive }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });
}
