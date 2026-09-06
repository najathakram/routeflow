import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Driver {
  id: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehiclePlate?: string;
  licenseNumber?: string;
  /** Composed home base ("line1, city, state, zip"); written via the four home* fields below. */
  homeAddress?: string | null;
  status: "ACTIVE" | "INACTIVE" | "ON_LEAVE";
  user?: {
    id: string;
    firstName?: string;
    lastName?: string;
    username: string;
    email?: string;
    phone?: string;
  };
}

export interface CreateDriverDto {
  contactName: string;
  email: string;
  username: string;
  phone?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleColour?: string;
  vehiclePlate?: string;
}

export interface UpdateDriverDto {
  contactName?: string;
  phone?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleColour?: string;
  vehiclePlate?: string;
  // Home base — the API composes these into `homeAddress` and best-effort geocodes
  // them, so a trip can start from the driver's home instead of the depot. Sending
  // ANY of them rewrites the home base; omit them all to leave it untouched.
  homeLine1?: string;
  homeCity?: string;
  homeState?: string;
  homeZip?: string;
  status?: Driver["status"];
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useDrivers(params?: {
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery<{ data: Driver[]; meta: any }>({
    queryKey: ["drivers", params],
    queryFn: () => apiClient.get("/drivers", { params }).then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useDriver(id: string | null | undefined) {
  return useQuery<Driver>({
    queryKey: ["drivers", id],
    queryFn: () => apiClient.get(`/drivers/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export interface DriverMetrics {
  runsCompleted: number;
  stopsCompleted: number;
  itemsDelivered: number;
  avgDeliveryTime?: number;
  distance?: number;
  onTimeRate?: number;
}

export function useDriverMetrics(id: string | null | undefined) {
  return useQuery<DriverMetrics>({
    queryKey: ["drivers", id, "metrics"],
    queryFn: () =>
      apiClient
        .get(`/drivers/${id}/metrics`)
        .then((r) => r.data)
        .catch(() => ({
          runsCompleted: 0,
          stopsCompleted: 0,
          itemsDelivered: 0,
        })),
    enabled: !!id,
    staleTime: 5 * 60_000,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export interface CreateDriverResponse {
  driver: Driver;
  tempPassword: string;
}

export function useCreateDriver() {
  const qc = useQueryClient();
  return useMutation<CreateDriverResponse, Error, CreateDriverDto>({
    mutationFn: (dto) => apiClient.post("/drivers", dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["drivers"] });
      qc.invalidateQueries({ queryKey: ["admin", "drivers"] });
    },
  });
}

export function useUpdateDriver() {
  const qc = useQueryClient();
  return useMutation<Driver, Error, { id: string } & UpdateDriverDto>({
    mutationFn: ({ id, ...dto }) => apiClient.patch(`/drivers/${id}`, dto).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["drivers"] });
      qc.invalidateQueries({ queryKey: ["drivers", id] });
      qc.invalidateQueries({ queryKey: ["admin", "drivers"] });
    },
  });
}
