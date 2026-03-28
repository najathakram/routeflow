import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export interface Supplier {
  id: string;
  name: string;
  contactName?: string;
  phone?: string;
  email?: string;
  notes?: string;
  isActive: boolean;
  leadTimeDays?: number;
  createdAt: string;
  updatedAt: string;
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
    mutationFn: (data: Partial<Supplier>) =>
      apiClient.post("/suppliers", data).then((r) => r.data),
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

export function useDeleteSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete(`/suppliers/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["suppliers"] }),
  });
}
