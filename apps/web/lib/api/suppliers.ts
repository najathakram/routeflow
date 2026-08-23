import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export interface Supplier {
  id: string;
  name: string;
  contactName?: string;
  phone?: string;
  mobile?: string;
  email?: string;
  website?: string;
  notes?: string;
  isActive: boolean;
  leadTimeDays?: number;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  /**
   * Net-terms label seeded onto a new vendor bill for this supplier ("Net 30",
   * "Due on Receipt", …), same VALID_TERMS list as Customer.defaultPaymentTerms.
   * "" clears it back to "no default".
   */
  defaultTerms?: string;
  createdAt: string;
  updatedAt: string;
  // Aggregated from vendor bills
  outstandingBalance?: number;
  totalOwed?: number;
  totalPaid?: number;
  billCount?: number;
}

export interface SuppliersResult {
  data: Supplier[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export function useSuppliers(params?: {
  search?: string;
  isActive?: boolean;
  page?: number;
  limit?: number;
}) {
  return useQuery<SuppliersResult>({
    queryKey: ["suppliers", params],
    queryFn: () => apiClient.get("/suppliers", { params }).then((r) => r.data),
  });
}

export function useSupplier(id: string) {
  return useQuery<Supplier>({
    queryKey: ["suppliers", id],
    queryFn: () => apiClient.get(`/suppliers/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<Supplier>) => apiClient.post("/suppliers", data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["suppliers"] }),
  });
}

export function useUpdateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<Supplier>) =>
      apiClient.patch(`/suppliers/${id}`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["suppliers", vars.id] });
      qc.invalidateQueries({ queryKey: ["suppliers"] });
    },
  });
}

export function useDeactivateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.patch(`/suppliers/${id}/deactivate`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["suppliers"] }),
  });
}

export function useDeleteSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/suppliers/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["suppliers"] }),
  });
}

export function useImportExpenseSuppliers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return apiClient.post("/import/expense-suppliers", form).then((r) => r.data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}
