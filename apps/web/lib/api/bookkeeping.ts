import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export interface Transaction {
  id: string;
  orderId: string;
  customerId: string;
  customer?: { id: string; businessName: string; contactName?: string };
  order?: { id: string; orderNumber: string };
  status: "UNPAID" | "PARTIAL" | "PAID";
  totalOwed: number;
  totalPaid: number;
  dueDate?: string;
  paidAt?: string;
  createdAt: string;
  payments?: Payment[];
}

export interface Payment {
  id: string;
  amount: number;
  method: "CASH" | "CHECK" | "ACH" | "OTHER";
  reference?: string;
  notes?: string;
  createdAt: string;
}

export interface BookkeepingSummary {
  totalRevenue: number;
  outstandingReceivables: number;
  paymentsThisWeek: number;
  overdueCount: number;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export function useBookkeepingSummary() {
  return useQuery<BookkeepingSummary>({
    queryKey: ["bookkeeping", "summary"],
    queryFn: () => apiClient.get("/bookkeeping/summary").then((r) => r.data),
  });
}

export function useTransactions(params?: {
  status?: string;
  customerId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
}) {
  return useQuery<PaginatedResponse<Transaction>>({
    queryKey: ["bookkeeping", "transactions", params],
    queryFn: () => apiClient.get("/bookkeeping/transactions", { params }).then((r) => r.data),
  });
}

export function useTransaction(id: string) {
  return useQuery<Transaction>({
    queryKey: ["bookkeeping", "transactions", id],
    queryFn: () => apiClient.get(`/bookkeeping/transactions/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useRecordPayment() {
  const qc = useQueryClient();
  return useMutation<
    Transaction,
    Error,
    { id: string; amount: number; method: string; reference?: string; notes?: string }
  >({
    mutationFn: ({ id, ...data }) =>
      apiClient.post(`/bookkeeping/transactions/${id}/payments`, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bookkeeping"] });
    },
  });
}

export function useDownloadInvoice() {
  return useMutation<{ url: string } | null, Error, string>({
    mutationFn: async (id: string) => {
      // NestJS returns 202 when the PDF is still generating. Axios treats all
      // 2xx as successes so we check the status code in the response, not in
      // the catch block.
      const response = await apiClient.get<{ url?: string; message?: string }>(
        `/bookkeeping/transactions/${id}/pdf`,
        { validateStatus: (s) => s >= 200 && s < 300 },
      );

      if (response.status === 202 || !response.data?.url) return null;

      return { url: response.data.url };
    },
  });
}
