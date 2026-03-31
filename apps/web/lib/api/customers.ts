import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export interface Customer {
  id: string;
  businessName: string;
  contactName: string;
  phone?: string;
  notes?: string;
  fulfillPath: string;
  deliveryWindowStart?: string;
  deliveryWindowEnd?: string;
  createdAt: string;
  updatedAt: string;
}

export function useCustomers(params?: { search?: string; status?: string; page?: number; limit?: number }) {
  return useQuery({
    queryKey: ["customers", params],
    queryFn: () => apiClient.get("/customers", { params }).then((r) => r.data),
  });
}

export function useCustomer(id: string) {
  return useQuery({
    queryKey: ["customers", id],
    queryFn: () => apiClient.get(`/customers/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiClient.post("/customers", data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers"] }),
  });
}

export function useUpdateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; [k: string]: unknown }) =>
      apiClient.patch(`/customers/${id}`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["customers", vars.id] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

export function useUpdateCustomerStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiClient.patch(`/customers/${id}/status`, { status }).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["customers", vars.id] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

export function useCustomerOrders(id: string) {
  return useQuery({
    queryKey: ["customers", id, "orders"],
    queryFn: () => apiClient.get(`/customers/${id}/orders`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCustomerRoutes(id: string) {
  return useQuery({
    queryKey: ["customers", id, "routes"],
    queryFn: () => apiClient.get(`/customers/${id}/routes`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useAddCustomerAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; [k: string]: unknown }) =>
      apiClient.post(`/customers/${id}/addresses`, data).then((r) => r.data),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ["customers", vars.id] }),
  });
}

// ─── Statement ────────────────────────────────────────────────────────────────

export interface StatementTransaction {
  date: string;
  type: "invoice" | "payment" | "credit_note" | "advance";
  description: string;
  amount: number;
  balance: number;
  invoiceId?: string;
  invoiceNumber?: string;
}

export interface CustomerStatement {
  outstandingAmount: number;
  overdueAmount: number;
  availableCredit: number;
  advanceBalance: number;
  transactions: StatementTransaction[];
}

export function useCustomerStatement(id: string) {
  return useQuery<CustomerStatement>({
    queryKey: ["customers", id, "statement"],
    queryFn: () => apiClient.get(`/customers/${id}/statement`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Advance payments ─────────────────────────────────────────────────────────

export interface AdvancePayment {
  id: string;
  customerId: string;
  amount: number;
  balance: number;
  method: "CASH" | "CHECK" | "ACH" | "OTHER";
  reference?: string;
  notes?: string;
  createdAt: string;
}

export function useCustomerAdvancePayments(customerId: string) {
  return useQuery<AdvancePayment[]>({
    queryKey: ["customers", customerId, "advance-payments"],
    queryFn: () => apiClient.get(`/customers/${customerId}/advance-payments`).then((r) => r.data),
    enabled: !!customerId,
  });
}

export function useCreateAdvancePayment() {
  const qc = useQueryClient();
  return useMutation<AdvancePayment, Error, { customerId: string; amount: number; method: string; reference?: string; notes?: string }>({
    mutationFn: ({ customerId, ...data }) =>
      apiClient.post(`/customers/${customerId}/advance-payments`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "advance-payments"] });
      qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "statement"] });
    },
  });
}

export function useApplyAdvancePayment() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { customerId: string; advancePaymentId: string; invoiceId: string; amount?: number }>({
    mutationFn: ({ customerId, advancePaymentId, ...data }) =>
      apiClient.post(`/customers/${customerId}/advance-payments/${advancePaymentId}/apply`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "advance-payments"] });
      qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "statement"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}

// ─── Customer Special Prices ──────────────────────────────────────────────────

export interface CustomerPrice {
  id: string;
  customerId: string;
  productId: string;
  specialPrice: number | string;
  notes?: string;
  product?: {
    id: string;
    name: string;
    sku?: string;
    unit: string;
    pricePerUnit: number | string;
  };
}

export function useCustomerPrices(customerId: string | undefined) {
  return useQuery({
    queryKey: ['customer-prices', customerId],
    queryFn: () => apiClient.get(`/customers/${customerId}/prices`).then((r) => r.data),
    enabled: !!customerId,
  });
}

export function useUpsertCustomerPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, ...data }: { customerId: string; productId: string; specialPrice: string; notes?: string }) =>
      apiClient.post(`/customers/${customerId}/prices`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['customer-prices', vars.customerId] });
    },
  });
}

export function useDeleteCustomerPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, priceId }: { customerId: string; priceId: string }) =>
      apiClient.delete(`/customers/${customerId}/prices/${priceId}`).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['customer-prices', vars.customerId] });
    },
  });
}

export function useDeleteCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/customers/${id}`).then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["customers"] }); },
  });
}

export function useDeleteAllCustomers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.delete("/customers/all").then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["customers"] }); },
  });
}
