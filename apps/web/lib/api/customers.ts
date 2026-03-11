import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export function useCustomers(params?: { search?: string; status?: string; page?: number }) {
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
