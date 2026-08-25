import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export interface Driver {
  id: string;
  contactName: string;
  phone?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleColour?: string;
  vehiclePlate?: string;
  /** Composed home base ("line1, city, state, zip"), set via the four home* update fields. */
  homeAddress?: string | null;
  homeLat?: number | null;
  homeLng?: number | null;
  status: "ACTIVE" | "INACTIVE";
  user: {
    id: string;
    username: string;
    email: string;
    status: string;
    forcePasswordChange: boolean;
  };
  createdAt: string;
}

interface ListParams {
  search?: string;
  status?: string;
  page?: number;
  limit?: number;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export function useDrivers(params?: ListParams, options?: { refetchInterval?: number }) {
  return useQuery<PaginatedResponse<Driver>>({
    queryKey: ["drivers", params],
    queryFn: () => apiClient.get("/drivers", { params }).then((r) => r.data),
    ...options,
  });
}

export function useDriver(id: string) {
  return useQuery<Driver>({
    queryKey: ["drivers", id],
    queryFn: () => apiClient.get(`/drivers/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateDriver() {
  const qc = useQueryClient();
  return useMutation<
    { driver: Driver; tempPassword: string },
    Error,
    {
      contactName: string;
      email: string;
      username: string;
      phone?: string;
      vehicleMake?: string;
      vehicleModel?: string;
      vehicleColour?: string;
      vehiclePlate?: string;
    }
  >({
    mutationFn: (dto) => apiClient.post("/drivers", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["drivers"] }),
  });
}

/**
 * PATCH /drivers/:id body. The home base is WRITTEN as four structured fields
 * (the API composes + geocodes them into `homeAddress`/`homeLat`/`homeLng`) but
 * READ back as the composed string, so the write shape isn't `Partial<Driver>`.
 */
export type UpdateDriverInput = Partial<Driver> & {
  homeLine1?: string;
  homeCity?: string;
  homeState?: string;
  homeZip?: string;
};

export function useUpdateDriver() {
  const qc = useQueryClient();
  return useMutation<Driver, Error, { id: string; data: UpdateDriverInput }>({
    mutationFn: ({ id, data }) => apiClient.patch(`/drivers/${id}`, data).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["drivers"] });
      qc.invalidateQueries({ queryKey: ["drivers", id] });
    },
  });
}

export function useChangeDriverStatus() {
  const qc = useQueryClient();
  return useMutation<void, Error, { id: string; status: "ACTIVE" | "INACTIVE" }>({
    mutationFn: ({ id, status }) =>
      apiClient.patch(`/drivers/${id}/status`, { status }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["drivers"] }),
  });
}

export function useDeleteDriver() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, string>({
    mutationFn: (id) => apiClient.delete(`/drivers/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["drivers"] }),
  });
}

export function useDriverHistory(id: string) {
  return useQuery({
    queryKey: ["drivers", id, "history"],
    queryFn: () => apiClient.get(`/drivers/${id}/history`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useDriverMetrics(id: string) {
  return useQuery({
    queryKey: ["drivers", id, "metrics"],
    queryFn: () => apiClient.get(`/drivers/${id}/metrics`).then((r) => r.data),
    enabled: !!id,
  });
}
