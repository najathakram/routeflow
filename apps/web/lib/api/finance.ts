import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FinanceDashboard {
  arAging: {
    total: number;
    current: number;
    days1_15: number;
    days16_30: number;
    days31_45: number;
    days45plus: number;
  };
  monthlySales: {
    data: Array<{ month: string; sales: number; receipts: number; expenses: number }>;
    totalSales: number;
    totalReceipts: number;
    totalExpenses: number;
  };
  topExpenses: Array<{ name: string; amount: number }>;
  summaryTable: {
    today: { sales: number; receipts: number; due: number };
    thisWeek: { sales: number; receipts: number; due: number };
    thisMonth: { sales: number; receipts: number; due: number };
    thisQuarter: { sales: number; receipts: number; due: number };
    thisYear: { sales: number; receipts: number; due: number };
  };
}

export interface ArAgingBucket {
  id: string;
  invoiceNumber: string;
  customer: { id: string; businessName: string };
  total: number;
  balance: number;
  dueDate?: string;
  status: string;
}

export interface ExpenseCategory {
  id: string;
  name: string;
  code: string;
  isCustom: boolean;
}

export interface ExpenseLineItem {
  id: string;
  account: string;
  notes?: string;
  amount: number;
}

export interface MileageRate {
  id: string;
  startDate: string;
  ratePerUnit: number;
  unit: string;
  createdAt: string;
}

export interface Expense {
  id: string;
  date: string;
  category?: ExpenseCategory;
  supplier?: { id: string; name: string };
  customer?: { id: string; businessName: string };
  amount: number;
  description?: string;
  paymentMethod?: string;
  notes?: string;
  referenceNumber?: string;
  isItemized: boolean;
  isMileage: boolean;
  isBillable: boolean;
  employeeName?: string;
  mileageUnit?: string;
  distance?: number;
  mileageRateSnapshot?: number;
  lineItems?: ExpenseLineItem[];
  createdAt?: string;
  receiptKey?: string | null;
  receiptOriginalName?: string | null;
  receiptMimeType?: string | null;
  vendorBillId?: string | null;
  status?: 'PENDING' | 'RECEIVED' | 'PAID' | 'VOID';
  receivedAt?: string | null;
  paidAt?: string | null;
}

export interface CustomerBalance {
  customerId: string;
  businessName: string;
  contactName?: string;
  phone?: string;
  invoiceCount: number;
  balance: number;
  overdue: number;
}

// ─── Finance Dashboard ────────────────────────────────────────────────────────

export function useFinanceDashboard() {
  return useQuery<FinanceDashboard>({
    queryKey: ['finance-dashboard'],
    queryFn: () => apiClient.get('/bookkeeping/finance-dashboard').then((r) => r.data),
    staleTime: 60_000,
  });
}

// ─── AR Aging ─────────────────────────────────────────────────────────────────

export function useArAgingInvoices(intervalDays?: number) {
  return useQuery<{
    buckets: { current: ArAgingBucket[]; days1_30: ArAgingBucket[]; days31_60: ArAgingBucket[]; days61_90: ArAgingBucket[]; days90plus: ArAgingBucket[] };
    totals: { current: number; days1_30: number; days31_60: number; days61_90: number; days90plus: number; total: number };
  }>({
    queryKey: ['reports', 'ar-aging-invoices', intervalDays],
    queryFn: () =>
      apiClient
        .get('/bookkeeping/reports/ar-aging-invoices',
          { params: intervalDays ? { intervalDays } : undefined })
        .then((r) => r.data),
  });
}

// ─── Sales Reports ────────────────────────────────────────────────────────────

export function useSalesByCustomer(from?: string, to?: string) {
  return useQuery({
    queryKey: ['reports', 'sales-by-customer', from, to],
    queryFn: () => apiClient.get('/bookkeeping/reports/sales-by-customer', { params: { from, to } }).then((r) => r.data),
  });
}

export function useSalesByItem(from?: string, to?: string) {
  return useQuery({
    queryKey: ['reports', 'sales-by-item', from, to],
    queryFn: () => apiClient.get('/bookkeeping/reports/sales-by-item', { params: { from, to } }).then((r) => r.data),
  });
}

// ─── Customer Balance ─────────────────────────────────────────────────────────

export function useCustomerBalanceSummary() {
  return useQuery<{ data: CustomerBalance[] }>({
    queryKey: ['reports', 'customer-balance'],
    queryFn: () => apiClient.get('/bookkeeping/reports/customer-balance').then((r) => r.data),
  });
}

// ─── Invoice Reports ──────────────────────────────────────────────────────────

export function useInvoiceDetailsReport(from?: string, to?: string, status?: string, customerId?: string) {
  return useQuery({
    queryKey: ['reports', 'invoice-details', from, to, status, customerId],
    queryFn: () => apiClient.get('/bookkeeping/reports/invoice-details', { params: { from, to, status, customerId } }).then((r) => r.data),
  });
}

export function useBadDebtsReport() {
  return useQuery({
    queryKey: ['reports', 'bad-debts'],
    queryFn: () => apiClient.get('/bookkeeping/reports/bad-debts').then((r) => r.data),
  });
}

// ─── Payments Reports ─────────────────────────────────────────────────────────

export function usePaymentsReceivedReport(from?: string, to?: string) {
  return useQuery({
    queryKey: ['reports', 'payments-received', from, to],
    queryFn: () => apiClient.get('/bookkeeping/reports/payments-received', { params: { from, to } }).then((r) => r.data),
  });
}

export function useTimeToGetPaid(from?: string, to?: string) {
  return useQuery({
    queryKey: ['reports', 'time-to-get-paid', from, to],
    queryFn: () => apiClient.get('/bookkeeping/reports/time-to-get-paid', { params: { from, to } }).then((r) => r.data),
  });
}

// ─── Expense Reports ──────────────────────────────────────────────────────────

export function useExpenseDetailsReport(from?: string, to?: string, categoryId?: string) {
  return useQuery({
    queryKey: ['reports', 'expense-details', from, to, categoryId],
    queryFn: () => apiClient.get('/bookkeeping/reports/expense-details', { params: { from, to, categoryId } }).then((r) => r.data),
  });
}

export function useExpensesByCategoryReport(from?: string, to?: string) {
  return useQuery({
    queryKey: ['reports', 'expenses-by-category', from, to],
    queryFn: () => apiClient.get('/bookkeeping/reports/expenses-by-category', { params: { from, to } }).then((r) => r.data),
  });
}

// ─── Expenses CRUD ────────────────────────────────────────────────────────────

export function useExpenses(params?: { categoryId?: string; supplierId?: string; customerId?: string; from?: string; to?: string; type?: string; page?: number; limit?: number }) {
  return useQuery<{ data: Expense[]; meta: { total: number; page: number; limit: number; totalPages: number } }>({
    queryKey: ['expenses', params],
    queryFn: () => apiClient.get('/bookkeeping/expenses', { params }).then((r) => r.data),
  });
}

export function useExpenseCategories() {
  return useQuery<ExpenseCategory[]>({
    queryKey: ['expense-categories'],
    queryFn: () => apiClient.get('/bookkeeping/expense-categories').then((r) => r.data),
  });
}

export function useCreateExpenseCategory() {
  const qc = useQueryClient();
  return useMutation<ExpenseCategory, Error, { name: string; code: string }>({
    mutationFn: (dto) => apiClient.post('/bookkeeping/expense-categories', dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expense-categories'] }),
  });
}

export function useMileageRates() {
  return useQuery<MileageRate[]>({
    queryKey: ['mileage-rates'],
    queryFn: () => apiClient.get('/bookkeeping/mileage-rates').then((r) => r.data),
  });
}

export function useCreateMileageRate() {
  const qc = useQueryClient();
  return useMutation<MileageRate, Error, { startDate: string; ratePerUnit: number; unit?: string }>({
    mutationFn: (dto) => apiClient.post('/bookkeeping/mileage-rates', dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mileage-rates'] }),
  });
}

export function useDeleteMileageRate() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiClient.delete(`/bookkeeping/mileage-rates/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mileage-rates'] }),
  });
}

export interface CreateExpenseDto {
  categoryId?: string;
  supplierId?: string;
  customerId?: string;
  amount: number;
  date: string;
  description?: string;
  paymentMethod?: string;
  notes?: string;
  referenceNumber?: string;
  isItemized?: boolean;
  isMileage?: boolean;
  isBillable?: boolean;
  employeeName?: string;
  mileageUnit?: string;
  distance?: number;
  mileageRateSnapshot?: number;
  lineItems?: { account: string; notes?: string; amount: number }[];
}

export function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation<Expense, Error, CreateExpenseDto>({
    mutationFn: (dto) => apiClient.post('/bookkeeping/expenses', dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['finance-dashboard'] });
    },
  });
}

export function useBulkCreateExpenses() {
  const qc = useQueryClient();
  return useMutation<{ created: number; errors: string[] }, Error, CreateExpenseDto[]>({
    mutationFn: (expenses) => apiClient.post('/bookkeeping/expenses/bulk', { expenses }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['finance-dashboard'] });
    },
  });
}

export function useUpdateExpense() {
  const qc = useQueryClient();
  return useMutation<Expense, Error, { id: string } & Partial<CreateExpenseDto>>({
    mutationFn: ({ id, ...dto }) => apiClient.patch(`/bookkeeping/expenses/${id}`, dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  });
}

export function useDeleteExpense() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiClient.post(`/bookkeeping/expenses/${id}/delete`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['finance-dashboard'] });
    },
  });
}

export type ExpenseStatus = 'PENDING' | 'RECEIVED' | 'PAID' | 'VOID';

export function useBatchUpdateExpenseStatus() {
  const qc = useQueryClient();
  return useMutation<
    { updated: number; failed: { id: string; reason: string }[] },
    Error,
    { ids: string[]; status: ExpenseStatus }
  >({
    mutationFn: (body) =>
      apiClient.post('/bookkeeping/expenses/batch-status', body).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['finance-dashboard'] });
    },
  });
}

export function useUploadExpenseReceipt() {
  const qc = useQueryClient();
  return useMutation<{ url: string }, Error, { id: string; file: File }>({
    mutationFn: ({ id, file }) => {
      const form = new FormData();
      form.append('file', file);
      return apiClient.post(`/bookkeeping/expenses/${id}/receipt`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      }).then((r) => r.data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  });
}

export function useDeleteExpenseReceipt() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, string>({
    mutationFn: (id) => apiClient.delete(`/bookkeeping/expenses/${id}/receipt`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  });
}

export function useGetExpenseReceiptUrl() {
  return useMutation<{ url: string }, Error, string>({
    mutationFn: (id) => apiClient.get(`/bookkeeping/expenses/${id}/receipt`).then((r) => r.data),
  });
}

export function useExtractExpenseItems() {
  const qc = useQueryClient();
  return useMutation<Expense, Error, string>({
    mutationFn: (id) => apiClient.post(`/bookkeeping/expenses/${id}/extract-items`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  });
}

// ─── P&L, Cash Flow ──────────────────────────────────────────────────────────

export function useProfitAndLoss(from?: string, to?: string) {
  return useQuery({
    queryKey: ['reports', 'pl', from, to],
    queryFn: () => apiClient.get('/bookkeeping/reports/pl', { params: { from, to } }).then((r) => r.data),
  });
}

export function useCashFlow(from?: string, to?: string) {
  return useQuery({
    queryKey: ['reports', 'cashflow', from, to],
    queryFn: () => apiClient.get('/bookkeeping/reports/cashflow', { params: { from, to } }).then((r) => r.data),
  });
}

// ─── New Reports (Zoho Parity) ──────────────────────────────────────────────

export function useSalesByDriver(from?: string, to?: string) {
  return useQuery({
    queryKey: ['reports', 'sales-by-driver', from, to],
    queryFn: () => apiClient.get('/bookkeeping/reports/sales-by-driver', { params: { from, to } }).then((r) => r.data),
  });
}

export function useArAgingDetails(from?: string, to?: string, customerId?: string) {
  return useQuery({
    queryKey: ['reports', 'ar-aging-details', from, to, customerId],
    queryFn: () => apiClient.get('/bookkeeping/reports/ar-aging-details', { params: { from, to, customerId } }).then((r) => r.data),
  });
}

export function useEstimateDetails(from?: string, to?: string, status?: string) {
  return useQuery({
    queryKey: ['reports', 'estimate-details', from, to, status],
    queryFn: () => apiClient.get('/bookkeeping/reports/estimate-details', { params: { from, to, status } }).then((r) => r.data),
  });
}

export function useRefundHistory(from?: string, to?: string) {
  return useQuery({
    queryKey: ['reports', 'refund-history', from, to],
    queryFn: () => apiClient.get('/bookkeeping/reports/refund-history', { params: { from, to } }).then((r) => r.data),
  });
}

export function useReceivableSummary(from?: string, to?: string) {
  return useQuery({
    queryKey: ['reports', 'receivable-summary', from, to],
    queryFn: () => apiClient.get('/bookkeeping/reports/receivable-summary', { params: { from, to } }).then((r) => r.data),
  });
}

export function useExpensesByCustomer(from?: string, to?: string) {
  return useQuery({
    queryKey: ['reports', 'expenses-by-customer', from, to],
    queryFn: () => apiClient.get('/bookkeeping/reports/expenses-by-customer', { params: { from, to } }).then((r) => r.data),
  });
}
