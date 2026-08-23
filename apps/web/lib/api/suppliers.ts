import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

/**
 * Supplier lists are cached under TWO key families: ["suppliers"] (this file)
 * and ["inventory", "suppliers"] (lib/api/inventory.ts — used by the purchase /
 * scan-invoice / vendor-bill supplier dropdowns). Every supplier mutation must
 * invalidate both, or a supplier created in one surface never appears in the
 * other until a full reload.
 */
export function invalidateSupplierLists(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["suppliers"] });
  qc.invalidateQueries({ queryKey: ["inventory", "suppliers"] });
}

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
    onSuccess: () => invalidateSupplierLists(qc),
  });
}

export function useUpdateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<Supplier>) =>
      apiClient.patch(`/suppliers/${id}`, data).then((r) => r.data),
    onSuccess: () => invalidateSupplierLists(qc),
  });
}

export function useDeactivateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.patch(`/suppliers/${id}/deactivate`).then((r) => r.data),
    onSuccess: () => invalidateSupplierLists(qc),
  });
}

export function useDeleteSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/suppliers/${id}`).then((r) => r.data),
    onSuccess: () => invalidateSupplierLists(qc),
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
      invalidateSupplierLists(qc);
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}
