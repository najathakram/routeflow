import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export interface RouteTemplateStop {
  id: string;
  stopNumber: number;
  customerId: string;
  customer?: { id: string; businessName: string };
  customerAddress?: {
    id: string;
    label?: string;
    line1: string;
    city: string;
    state: string;
    lat?: number;
    lng?: number;
  };
  notes?: string;
}

export interface Route {
  id: string;
  name: string;
  isActive: boolean;
  kind: "SCHEDULED" | "ADHOC";
  createdAt: string;
  depotLat?: number | null;
  depotLng?: number | null;
  depotAddress?: string | null;
  // findAllRoutes (the list endpoint) carries a run summary + counts so the
  // Deliveries history page can render driver/date/status without a second
  // round-trip per row — narrower than RouteRun since the API `select`s only
  // these fields on the list, not the full run shape.
  _count?: { runs: number; stops: number };
  runs?: {
    id: string;
    status: string;
    scheduledDate?: string | null;
    completedAt?: string | null;
    driver?: { id: string; contactName?: string | null } | null;
  }[];
  stops?: RouteTemplateStop[];
}

export interface RouteRun {
  id: string;
  routeId: string;
  route?: { id: string; name: string };
  driverId?: string;
  driver?: { id: string; contactName: string };
  status: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  scheduledDate: string;
  startTime?: string | null;
  depotLat?: number | null;
  depotLng?: number | null;
  depotAddress?: string | null;
  startedAt?: string;
  completedAt?: string;
  notes?: string;
  stops?: RouteRunStop[];
  _count?: { stops: number };
  /** Dispatch response only — how many orders the sweep actually attached to
   *  this run (an ad-hoc trip can lose orders between build and send). */
  attachedOrderCount?: number;
}

export interface RouteRunStop {
  id: string;
  stopNumber: number;
  customerId: string;
  customer?: { id: string; businessName: string; contactName: string };
  customerAddress?: { line1: string; city: string; state: string; lat?: number; lng?: number };
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED";
  completedAt?: string;
  driverNote?: string;
  orders?: { id: string; orderNumber: string; status: string }[];
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

// Routes
export function useRoutes(params?: {
  search?: string;
  isActive?: boolean;
  page?: number;
  kind?: "SCHEDULED" | "ADHOC";
}) {
  return useQuery<PaginatedResponse<Route>>({
    queryKey: ["routes", params],
    queryFn: () => apiClient.get("/routes", { params }).then((r) => r.data),
  });
}

export function useRoute(id: string) {
  return useQuery<Route>({
    queryKey: ["routes", id],
    queryFn: () => apiClient.get(`/routes/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateRoute() {
  return useMutation<
    Route,
    Error,
    { name: string; driverId?: string; depotLat?: number; depotLng?: number; depotAddress?: string }
  >({
    mutationFn: (dto) => apiClient.post("/routes", dto).then((r) => r.data),
    // NOTE: No auto-invalidation — caller must invalidate after stops are added
    // to avoid the race condition where the route list refreshes before stops exist.
  });
}

export function useAddStopToRoute() {
  const qc = useQueryClient();
  return useMutation<
    { id: string },
    Error,
    { routeId: string; customerId: string; customerAddressId?: string; notes?: string }
  >({
    mutationFn: ({ routeId, ...dto }) =>
      apiClient.post(`/routes/${routeId}/stops`, dto).then((r) => r.data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["routes", vars.routeId] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customer-route-assignments"] });
    },
  });
}

export function useUpdateRoute() {
  const qc = useQueryClient();
  return useMutation<
    Route,
    Error,
    {
      id: string;
      name?: string;
      driverId?: string;
      isActive?: boolean;
      depotLat?: number | null;
      depotLng?: number | null;
      depotAddress?: string | null;
    }
  >({
    mutationFn: ({ id, ...dto }) => apiClient.patch(`/routes/${id}`, dto).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["routes", id] });
      qc.invalidateQueries({ queryKey: ["routes"] });
    },
  });
}

export function useRemoveStop() {
  const qc = useQueryClient();
  return useMutation<void, Error, { routeId: string; stopId: string }>({
    mutationFn: ({ routeId, stopId }) =>
      apiClient.delete(`/routes/${routeId}/stops/${stopId}`).then((r) => r.data),
    onSuccess: (_, { routeId }) => {
      qc.invalidateQueries({ queryKey: ["routes", routeId] });
      qc.invalidateQueries({ queryKey: ["customer-route-assignments"] });
      qc.invalidateQueries({ queryKey: ["route-packing-list", routeId] });
    },
  });
}

export function useReorderStops() {
  const qc = useQueryClient();
  return useMutation<void, Error, { routeId: string; order: { id: string; stopNumber: number }[] }>(
    {
      mutationFn: ({ routeId, order }) =>
        apiClient.patch(`/routes/${routeId}/stops/reorder`, { order }).then((r) => r.data),
      onSuccess: (_, { routeId }) => qc.invalidateQueries({ queryKey: ["routes", routeId] }),
    },
  );
}

export function useDeleteRoute() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiClient.delete(`/routes/${id}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["routes"] });
      qc.invalidateQueries({ queryKey: ["customer-route-assignments"] });
    },
  });
}

export function useReorderRunStops() {
  const qc = useQueryClient();
  return useMutation<void, Error, { runId: string; order: { id: string; stopNumber: number }[] }>({
    mutationFn: ({ runId, order }) =>
      apiClient.patch(`/route-runs/${runId}/stops/reorder`, { order }).then((r) => r.data),
    onSuccess: (_, { runId }) => qc.invalidateQueries({ queryKey: ["route-runs", runId] }),
  });
}

export interface PackingItem {
  productId: string;
  productName: string;
  sku?: string | null;
  totalQty: number;
  customers: { name: string; qty: number }[];
}

export interface PackingListResponse {
  orders: Array<{
    id: string;
    orderNumber: string;
    status: string;
    createdAt: string;
    total?: number;
    customer?: { id: string; businessName: string };
    lineItems: Array<{
      id: string;
      qty: number;
      unitPrice: number;
      product?: { id: string; name: string; sku?: string };
    }>;
  }>;
  packingList: PackingItem[];
}

export function useRoutePackingList(id: string) {
  return useQuery<PackingListResponse>({
    queryKey: ["route-packing-list", id],
    queryFn: () => apiClient.get(`/routes/${id}/packing-list`).then((r) => r.data),
    enabled: !!id,
  });
}

// Customer Route Assignments
export function useCustomerRouteAssignments() {
  return useQuery<Record<string, { routeId: string; routeName: string }[]>>({
    queryKey: ["customer-route-assignments"],
    queryFn: () => apiClient.get("/routes/customer-assignments").then((r) => r.data),
  });
}

// Route Runs
export function useRouteRuns(
  params?: {
    status?: string;
    activeOnly?: boolean;
    date?: string;
    assignedToMe?: boolean;
    page?: number;
    limit?: number;
  },
  options?: { refetchInterval?: number },
) {
  return useQuery<PaginatedResponse<RouteRun>>({
    queryKey: ["route-runs", params],
    queryFn: () => apiClient.get("/route-runs", { params }).then((r) => r.data),
    ...options,
  });
}

export function useRouteRun(id: string) {
  return useQuery<RouteRun>({
    queryKey: ["route-runs", id],
    queryFn: () => apiClient.get(`/route-runs/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateRouteRun() {
  const qc = useQueryClient();
  return useMutation<
    RouteRun,
    Error,
    {
      routeId: string;
      scheduledDate: string;
      driverId?: string;
      startTime?: string;
      notes?: string;
      /** ADHOC trips only — narrows the dispatch sweep to exactly these orders. */
      orderIds?: string[];
    }
  >({
    mutationFn: (dto) => apiClient.post("/route-runs", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["route-runs"] }),
  });
}

export function useUpdateRouteRunStatus() {
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

export function useUpdateRouteRun() {
  const qc = useQueryClient();
  return useMutation<
    RouteRun,
    Error,
    { id: string; driverId?: string | null; scheduledDate?: string; notes?: string }
  >({
    mutationFn: ({ id, ...body }) => apiClient.patch(`/route-runs/${id}`, body).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["route-runs", id] });
      qc.invalidateQueries({ queryKey: ["route-runs"] });
    },
  });
}

export function useDeleteRouteRun() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiClient.delete(`/route-runs/${id}`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["route-runs"] });
    },
  });
}

export type OptimizeFallbackReason =
  | "ORS_NOT_CONFIGURED"
  | "ORS_RATE_LIMITED"
  | "ORS_HTTP_ERROR"
  | "ORS_NETWORK_ERROR";

export interface OptimizeResult {
  stopOrder: Array<{ stopId: string; stopNumber: number }>;
  reorderedCount: number;
  usedFallback: boolean;
  fallbackReason?: OptimizeFallbackReason;
}

export interface RunPackingStop {
  id: string;
  stopNumber: number;
  customerId: string | null;
  customer?: {
    id: string;
    businessName: string;
    deliveryWindowStart?: string | null;
    deliveryWindowEnd?: string | null;
  } | null;
  customerAddress?: {
    line1: string;
    city: string;
    state: string;
    lat?: number;
    lng?: number;
  } | null;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED";
  driverNote?: string | null;
  completedAt?: string | null;
  orders: Array<{
    id: string;
    orderNumber: string | null;
    status: string;
    lineItems: Array<{
      id: string;
      qty: number;
      unitPrice: number;
      product?: { id: string; name: string; sku?: string | null } | null;
    }>;
  }>;
}

export interface RunPackingListResponse {
  stops: RunPackingStop[];
  packingList: PackingItem[];
}

export function useRunPackingList(id: string) {
  return useQuery<RunPackingListResponse>({
    queryKey: ["run-packing-list", id],
    queryFn: () => apiClient.get(`/route-runs/${id}/packing-list`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useOptimizeRoute() {
  const qc = useQueryClient();
  return useMutation<OptimizeResult, Error, string>({
    mutationFn: (id) =>
      apiClient.post<OptimizeResult>(`/route-runs/${id}/optimize`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["route-runs", id] });
      qc.invalidateQueries({ queryKey: ["route-runs"] });
    },
  });
}

export function useOptimizeTemplate() {
  const qc = useQueryClient();
  return useMutation<OptimizeResult, Error, string>({
    mutationFn: (id) =>
      apiClient.post<OptimizeResult>(`/routes/${id}/optimize`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["routes", id] });
      qc.invalidateQueries({ queryKey: ["routes"] });
    },
  });
}

// ─── Trips (ad-hoc) ────────────────────────────────────────────────────────────

export type TripIneligibleReason =
  | "SHIP_FULFILLMENT"
  | "INELIGIBLE_STATUS"
  | "ON_ACTIVE_RUN"
  | "PREVIOUSLY_DISPATCHED"
  | "NO_ADDRESS"
  | "NOT_FOUND";

export interface TripEligibilityRow {
  orderId: string;
  orderNumber: string | null;
  customerId: string | null;
  customerName: string | null;
  eligible: boolean;
  reason?: TripIneligibleReason;
  detail?: string;
}

export type TripOrigin =
  | { type: "TENANT" }
  | { type: "DRIVER"; driverId: string }
  | { type: "ADDRESS"; line1: string; city?: string; state?: string; zip?: string };

/** Eligibility check for a candidate set of orders — feeds the trip builder's
 *  stop preview and skipped-orders panel. Enabled only while orders are selected. */
export function useTripEligibility(orderIds: string[]) {
  return useQuery<TripEligibilityRow[]>({
    queryKey: ["trip-eligibility", orderIds],
    queryFn: () =>
      apiClient
        .get("/trips/eligibility", { params: { orderIds: orderIds.join(",") } })
        .then((r) => r.data),
    enabled: orderIds.length > 0,
  });
}

/** Creates a DRAFT ad-hoc route (kind ADHOC) from a set of orders. Performs
 *  ZERO order writes — orders attach to it only at dispatch (useCreateRouteRun). */
export function useCreateTrip() {
  const qc = useQueryClient();
  return useMutation<
    Route,
    Error,
    { orderIds: string[]; name?: string; driverId?: string; origin: TripOrigin }
  >({
    mutationFn: (dto) => apiClient.post("/trips", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["routes"] }),
  });
}

// ─── Route Analysis (AI + ETAs) ───────────────────────────────────────────────

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
  stops?: Array<{
    stopNumber: number;
    status: "ok" | "warning" | "critical";
    message: string;
  }>;
  suggestions?: string[];
  etas: StopETA[];
}

export function useAnalyzeRoute() {
  return useMutation<RouteAnalysisResult, Error, { routeId: string; startTime?: string }>({
    mutationFn: ({ routeId, startTime }) =>
      apiClient
        .post<RouteAnalysisResult>(`/routes/${routeId}/analyze`, { startTime })
        .then((r) => r.data),
  });
}

export function useAnalyzeRouteRun() {
  return useMutation<RouteAnalysisResult, Error, { runId: string; startTime?: string }>({
    mutationFn: ({ runId, startTime }) =>
      apiClient
        .post<RouteAnalysisResult>(`/route-runs/${runId}/analyze`, { startTime })
        .then((r) => r.data),
  });
}

// ─── Route Settings ───────────────────────────────────────────────────────────

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
    queryFn: () => apiClient.get("/settings/route").then((r) => r.data),
  });
}

export function useUpdateRouteSettings() {
  const qc = useQueryClient();
  return useMutation<
    RouteSettings,
    Error,
    Partial<Pick<RouteSettings, "averageSpeedKmh" | "serviceTimeMinutes" | "defaultStartTime">>
  >({
    mutationFn: (dto) => apiClient.patch("/settings/route", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["route-settings"] }),
  });
}
