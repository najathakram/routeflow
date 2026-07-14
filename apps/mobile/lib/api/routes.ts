import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeliveryMutation {
  id: string;
  orderItemId: string;
  productId: string;
  type: "DELIVERED" | "PARTIAL" | "REFUSED" | "ADD_ON";
  quantityDelivered: number;
  note?: string;
  createdAt: string;
  product?: { id: string; name: string; unit: string };
}

export interface RouteRunOrderItem {
  id: string;
  productId: string;
  product?: { id: string; name: string; unit: string };
  qty: number;
  unitPrice: number;
  status: string;
}

export interface RouteRunOrder {
  id: string;
  orderNumber: string;
  status: string;
  urgent: boolean;
  notes?: string;
  invoiceId?: string;
  lineItems: RouteRunOrderItem[];
}

export interface RouteRunStop {
  id: string;
  stopNumber: number;
  customerId: string;
  customer?: {
    id: string;
    businessName: string;
    contactName: string;
    phone?: string;
    deliveryWindowStart?: string;
    deliveryWindowEnd?: string;
  };
  customerAddress?: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    zip: string;
    lat?: number;
    lng?: number;
  };
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED";
  completedAt?: string;
  arrivedAt?: string;
  driverNote?: string;
  podPhotoUrls?: string[];
  safeDropEnabled?: boolean;
  signatureUrl?: string;
  // Phase 4 (W7b): regulated-delivery requirement flags + captured checks.
  ageCheckRequired?: boolean;
  identityCheckRequired?: boolean;
  ageVerified?: boolean;
  identityVerified?: boolean;
  identityType?: string | null;
  identityVerifiedAt?: string | null;
  notes?: string;
  orders?: RouteRunOrder[];
  deliveryMutations?: DeliveryMutation[];
}

export interface RouteRun {
  id: string;
  route?: { id: string; name: string };
  driver?: { id: string; contactName: string };
  status: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  scheduledDate: string;
  startedAt?: string;
  completedAt?: string;
  stops?: RouteRunStop[];
}

export interface PackingListItem {
  productId: string;
  productName: string;
  sku?: string;
  unit?: string;
  totalQty: number;
  customers: { name: string; qty: number }[];
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useActiveRouteRun() {
  return useQuery<{ data: RouteRun[]; meta: any }>({
    queryKey: ["route-runs", "active"],
    queryFn: () =>
      apiClient
        .get("/route-runs", { params: { assignedToMe: true, status: "IN_PROGRESS" } })
        .then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useScheduledRouteRuns() {
  return useQuery<{ data: RouteRun[]; meta: any }>({
    queryKey: ["route-runs", "scheduled"],
    queryFn: () =>
      apiClient
        .get("/route-runs", { params: { assignedToMe: true, status: "SCHEDULED" } })
        .then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useRouteRun(id: string) {
  return useQuery<RouteRun>({
    queryKey: ["route-runs", id],
    queryFn: () => apiClient.get(`/route-runs/${id}`).then((r) => r.data),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function usePackingList(runId: string) {
  return useQuery<PackingListItem[]>({
    queryKey: ["route-runs", runId, "packing-list"],
    queryFn: () =>
      apiClient.get(`/route-runs/${runId}/packing-list`).then((r) => r.data?.packingList ?? r.data),
    enabled: !!runId,
    staleTime: 60_000,
  });
}

export function useDriverHistory() {
  return useQuery<{ data: RouteRun[]; meta: any }>({
    queryKey: ["route-runs", "history"],
    queryFn: () =>
      apiClient
        .get("/route-runs", { params: { assignedToMe: true, limit: 30 } })
        .then((r) => r.data),
    staleTime: 60_000,
  });
}

export interface DriverStats {
  totalStopsCompleted: number;
  onTimeDeliveryPct: number;
  avgStopsPerRoute: number;
  returnsRate: number;
}

export function useDriverStats() {
  return useQuery<DriverStats>({
    queryKey: ["route-runs", "my-stats"],
    queryFn: () =>
      apiClient
        .get("/route-runs/my-stats")
        .then((r) => r.data)
        .catch((err) => {
          // Gracefully handle 404 — endpoint may not exist yet
          if (err?.response?.status === 404) return null;
          throw err;
        }),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useUpdateRunStatus() {
  const qc = useQueryClient();
  return useMutation<RouteRun, Error, { id: string; status: string }>({
    mutationFn: ({ id, status }) =>
      apiClient.patch(`/route-runs/${id}/status`, { status }).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["route-runs"] });
      qc.invalidateQueries({ queryKey: ["route-runs", id] });
    },
  });
}

export type ItemDeliveryType = "DELIVERED" | "PARTIAL" | "REFUSED" | "ADD_ON";

export interface CompleteStopItemDto {
  orderItemId?: string; // undefined for ADD_ON items
  productId: string;
  type: ItemDeliveryType;
  qty: number;
  driverNote?: string;
}

/** Allowed RouteRunStop.identityType values (mirrors the API). */
export const IDENTITY_TYPES = [
  "DRIVERS_LICENSE",
  "PASSPORT",
  "STATE_ID",
  "MILITARY_ID",
  "OTHER",
] as const;
export type IdentityType = (typeof IDENTITY_TYPES)[number];

export const IDENTITY_TYPE_LABELS: Record<IdentityType, string> = {
  DRIVERS_LICENSE: "Driver's license",
  PASSPORT: "Passport",
  STATE_ID: "State ID",
  MILITARY_ID: "Military ID",
  OTHER: "Other",
};

export interface CompleteStopDto {
  runId: string;
  stopId: string;
  driverNote?: string;
  items: CompleteStopItemDto[];
  podPhotoUrls?: string[];
  signatureUrl?: string;
  safeDropEnabled?: boolean;
  // Phase 4 (W7b): regulated-delivery POD capture.
  ageVerified?: boolean;
  identityVerified?: boolean;
  identityType?: string | null;
}

export function useCompleteStop() {
  const qc = useQueryClient();
  return useMutation<RouteRunStop, Error, CompleteStopDto>({
    mutationFn: ({
      runId,
      stopId,
      driverNote,
      items,
      podPhotoUrls,
      signatureUrl,
      safeDropEnabled,
      ageVerified,
      identityVerified,
      identityType,
    }) => {
      const deliveries = items
        .filter((i) => i.orderItemId) // API requires orderItemId; skip ADD_ON items without one
        .map((i) => ({
          orderItemId: i.orderItemId!,
          type: i.type,
          quantityDelivered: Math.round(i.qty),
          note: i.driverNote,
        }));
      return apiClient
        .post(`/route-runs/${runId}/stops/${stopId}/complete`, {
          driverNote,
          deliveries,
          podPhotoUrls,
          signatureUrl,
          safeDropEnabled,
          ageVerified,
          identityVerified,
          identityType,
        })
        .then((r) => r.data);
    },
    onSuccess: (_, { runId }) => {
      qc.invalidateQueries({ queryKey: ["route-runs", runId] });
      qc.invalidateQueries({ queryKey: ["route-runs", "active"] });
    },
  });
}

// RF-005: Atomic complete + payment hook
export interface CompleteWithPaymentDto {
  runId: string;
  stopId: string;
  driverNote?: string;
  deliveries?: Array<{
    orderItemId: string;
    // Null for an unlisted (ad-hoc) line; the server keys on orderItemId and
    // derives productId from the DB row, so this field is ignored server-side.
    productId: string | null;
    type: string;
    quantityDelivered: number;
  }>;
  podPhotoUrls?: string[];
  signatureUrl?: string;
  safeDropEnabled?: boolean;
  // Phase 4 (W7b): regulated-delivery POD capture.
  ageVerified?: boolean;
  identityVerified?: boolean;
  identityType?: string | null;
  payment?: {
    // Resolved server-side from the delivered orders; no longer sent by the client.
    invoiceId?: string;
    amount: number;
    method: string;
  };
  idempotencyKey?: string;
}

export function useCompleteWithPayment() {
  const qc = useQueryClient();
  return useMutation<RouteRunStop, Error, CompleteWithPaymentDto>({
    mutationFn: ({
      runId,
      stopId,
      driverNote,
      deliveries,
      podPhotoUrls,
      signatureUrl,
      safeDropEnabled,
      ageVerified,
      identityVerified,
      identityType,
      payment,
      idempotencyKey,
    }) => {
      const headers: Record<string, string> = {};
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
      return apiClient
        .post(
          `/route-runs/${runId}/stops/${stopId}/complete-with-payment`,
          {
            driverNote,
            deliveries,
            podPhotoUrls,
            signatureUrl,
            safeDropEnabled,
            ageVerified,
            identityVerified,
            identityType,
            payment,
          },
          { headers },
        )
        .then((r) => r.data);
    },
    onSuccess: (_, { runId }) => {
      qc.invalidateQueries({ queryKey: ["route-runs", runId] });
      qc.invalidateQueries({ queryKey: ["route-runs", "active"] });
    },
  });
}

export function useUpdateStopStatus() {
  const qc = useQueryClient();
  return useMutation<
    RouteRunStop,
    Error,
    { runId: string; stopId: string; status: "IN_PROGRESS" | "SKIPPED"; driverNote?: string }
  >({
    mutationFn: ({ runId, stopId, ...body }) =>
      apiClient.patch(`/route-runs/${runId}/stops/${stopId}`, body).then((r) => r.data),
    onSuccess: (_, { runId }) => {
      qc.invalidateQueries({ queryKey: ["route-runs", runId] });
      qc.invalidateQueries({ queryKey: ["route-runs", "active"] });
    },
  });
}

export function useCreateRun() {
  const qc = useQueryClient();
  return useMutation<RouteRun, Error, { routeId: string; scheduledDate: string; notes?: string }>({
    mutationFn: (dto) => apiClient.post("/route-runs", dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["route-runs"] });
    },
  });
}

export function useUpdateRun() {
  const qc = useQueryClient();
  return useMutation<RouteRun, Error, { id: string; scheduledDate?: string; notes?: string }>({
    mutationFn: ({ id, ...dto }) => apiClient.patch(`/route-runs/${id}`, dto).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["route-runs"] });
      qc.invalidateQueries({ queryKey: ["route-runs", id] });
    },
  });
}

export function useAllRoutes() {
  return useQuery<{ data: { id: string; name: string; isActive: boolean }[]; meta: any }>({
    queryKey: ["routes"],
    queryFn: () => apiClient.get("/routes", { params: { limit: 100 } }).then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

// ─── Route templates (operator) ───────────────────────────────────────────────

export interface CreateRouteDto {
  name: string;
  description?: string;
  stops?: { customerId: string; notes?: string }[];
}

export function useCreateRoute() {
  const qc = useQueryClient();
  return useMutation<{ id: string }, Error, CreateRouteDto>({
    mutationFn: (dto) => apiClient.post("/routes", dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["routes"] });
      qc.invalidateQueries({ queryKey: ["admin", "routes"] });
    },
  });
}

export function useUpdateRoute() {
  const qc = useQueryClient();
  return useMutation<
    { id: string },
    Error,
    {
      id: string;
      name?: string;
      description?: string;
      isActive?: boolean;
      driverId?: string | null;
    }
  >({
    mutationFn: ({ id, ...dto }) => apiClient.patch(`/routes/${id}`, dto).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["routes"] });
      qc.invalidateQueries({ queryKey: ["admin", "routes"] });
      qc.invalidateQueries({ queryKey: ["admin", "routes", id] });
    },
  });
}

export function useDeleteRoute() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiClient.delete(`/routes/${id}`).then(() => undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["routes"] });
      qc.invalidateQueries({ queryKey: ["admin", "routes"] });
    },
  });
}

export function useAddRouteStop() {
  const qc = useQueryClient();
  return useMutation<
    { id: string },
    Error,
    { routeId: string; customerId: string; notes?: string }
  >({
    mutationFn: ({ routeId, ...body }) =>
      apiClient.post(`/routes/${routeId}/stops`, body).then((r) => r.data),
    onSuccess: (_, { routeId }) => {
      qc.invalidateQueries({ queryKey: ["admin", "routes", routeId] });
    },
  });
}

export function useRemoveRouteStop() {
  const qc = useQueryClient();
  return useMutation<void, Error, { routeId: string; stopId: string }>({
    mutationFn: ({ routeId, stopId }) =>
      apiClient.delete(`/routes/${routeId}/stops/${stopId}`).then(() => undefined),
    onSuccess: (_, { routeId }) => {
      qc.invalidateQueries({ queryKey: ["admin", "routes", routeId] });
    },
  });
}

export function useReorderRouteStops() {
  const qc = useQueryClient();
  return useMutation<void, Error, { routeId: string; order: { id: string; stopNumber: number }[] }>(
    {
      mutationFn: ({ routeId, order }) =>
        apiClient.patch(`/routes/${routeId}/stops/reorder`, { order }).then(() => undefined),
      onSuccess: (_, { routeId }) => {
        qc.invalidateQueries({ queryKey: ["admin", "routes", routeId] });
      },
    },
  );
}

// ─── Live fleet (operator) ────────────────────────────────────────────────────

export interface LiveRoute {
  runId: string;
  routeId: string;
  routeName: string;
  driverId: string | null;
  driverName: string | null;
  status: string;
  latestLocation: {
    lat: number;
    lng: number;
    recordedAt: string;
    speedKph?: number | null;
    heading?: number | null;
  } | null;
  stops: {
    id: string;
    customerId: string;
    customerName: string;
    lat: number | null;
    lng: number | null;
    stopNumber: number;
    status: string;
  }[];
  nextStopIndex: number;
}

export function useRoutesLive() {
  return useQuery<{ routes: LiveRoute[] }>({
    queryKey: ["routes", "live"],
    queryFn: () =>
      apiClient
        .get("/routes/live")
        .then((r) => r.data)
        .catch((err) => {
          if (err?.response?.status === 404) return { routes: [] };
          throw err;
        }),
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export function useOperatorRouteRuns(params?: { status?: string; date?: string; limit?: number }) {
  return useQuery<{ data: RouteRun[]; meta: any }>({
    queryKey: ["route-runs", "operator", params],
    queryFn: () =>
      apiClient.get("/route-runs", { params: { limit: 50, ...params } }).then((r) => r.data),
    staleTime: 30_000,
  });
}

// ─── Route Optimization (template + run) ──────────────────────────────────────

export interface OptimizeResult {
  success: boolean;
  stops?: { id: string; stopNumber: number }[];
  usedFallback?: boolean;
  message?: string;
}

export function useOptimizeTemplate() {
  const qc = useQueryClient();
  return useMutation<OptimizeResult, Error, string>({
    mutationFn: (id) => apiClient.post(`/routes/${id}/optimize`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["admin", "routes", id] });
      qc.invalidateQueries({ queryKey: ["admin", "routes"] });
    },
  });
}

export interface OptimizeRunInput {
  id: string;
  originLat?: number;
  originLng?: number;
}

export function useOptimizeRouteRun() {
  const qc = useQueryClient();
  return useMutation<OptimizeResult, Error, string | OptimizeRunInput>({
    mutationFn: (input) => {
      const args: OptimizeRunInput = typeof input === "string" ? { id: input } : input;
      const body =
        typeof args.originLat === "number" && typeof args.originLng === "number"
          ? { originLat: args.originLat, originLng: args.originLng }
          : {};
      return apiClient.post(`/route-runs/${args.id}/optimize`, body).then((r) => r.data);
    },
    onSuccess: (_, input) => {
      const id = typeof input === "string" ? input : input.id;
      qc.invalidateQueries({ queryKey: ["route-runs", id] });
      qc.invalidateQueries({ queryKey: ["route-runs"] });
    },
  });
}

// ─── Route Analysis (ETAs + delivery windows) ────────────────────────────────

export interface StopETA {
  stopId: string;
  stopNumber: number;
  customerName: string;
  arrivalTime: string;
  departureTime: string;
  travelTimeMinutes: number;
  deliveryWindowStart?: string | null;
  deliveryWindowEnd?: string | null;
  withinWindow: boolean | null;
}

export interface RouteAnalysisResult {
  configured: boolean;
  summary?: string;
  stops?: Array<{ stopNumber: number; status: "ok" | "warning" | "critical"; message: string }>;
  suggestions?: string[];
  etas: StopETA[];
}

export function useAnalyzeRoute() {
  return useMutation<RouteAnalysisResult, Error, { routeId: string; startTime?: string }>({
    mutationFn: ({ routeId, startTime }) =>
      apiClient.post(`/routes/${routeId}/analyze`, { startTime }).then((r) => r.data),
  });
}

export function useAnalyzeRouteRun() {
  return useMutation<RouteAnalysisResult, Error, { runId: string; startTime?: string }>({
    mutationFn: ({ runId, startTime }) =>
      apiClient.post(`/route-runs/${runId}/analyze`, { startTime }).then((r) => r.data),
  });
}

// ─── Route Settings (depot + service time) ───────────────────────────────────

export interface RouteSettings {
  averageSpeedKmh: number;
  serviceTimeMinutes: number;
  defaultStartTime: string;
  depotLat: number | null;
  depotLng: number | null;
  depotAddress: string;
}

export function useRouteSettings() {
  return useQuery<RouteSettings>({
    queryKey: ["route-settings"],
    queryFn: () =>
      apiClient
        .get("/settings/route")
        .then((r) => r.data)
        .catch((err) => {
          if (err?.response?.status === 404) return null;
          throw err;
        }),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useReopenStop() {
  const qc = useQueryClient();
  return useMutation<
    { success: boolean; message: string },
    Error,
    { runId: string; stopId: string }
  >({
    mutationFn: ({ runId, stopId }) =>
      apiClient.post(`/route-runs/${runId}/stops/${stopId}/reopen`).then((r) => r.data),
    onSuccess: (_, { runId }) => {
      qc.invalidateQueries({ queryKey: ["route-runs", runId] });
      qc.invalidateQueries({ queryKey: ["route-runs", "active"] });
      qc.invalidateQueries({ queryKey: ["route-runs", "history"] });
    },
  });
}
