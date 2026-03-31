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
