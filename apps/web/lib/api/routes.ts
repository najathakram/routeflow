import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type {
  RouteAnalysisResult,
  RouteSettings,
  TripEligibilityRow,
  TripOrigin,
} from "@routeflow/types";
export type {
  RouteAnalysisResult,
  RouteSettings,
  StopETA,
  TripEligibilityRow,
  TripIneligibleReason,
  TripOrigin,
} from "@routeflow/types";

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

// ─── Route planning options (start/end points, tolls, objective) ─────────────
// All optional/nullable for backward compat: legacy rows predate these
// columns (null), and endpoints that don't select them omit them entirely.

export type RouteOriginKind = "TENANT" | "DRIVER" | "ADDRESS";
export type RouteEndKind = "NONE" | "RETURN_TO_START" | "DRIVER_HOME" | "ADDRESS";
export type RouteOptimizeMetric = "TIME" | "DISTANCE";

export interface Route {
  id: string;
  name: string;
  isActive: boolean;
  kind: "SCHEDULED" | "ADHOC";
  createdAt: string;
  /** The TEMPLATE's default driver — distinct from a given run's driver, which
   *  can be swapped per run. `originKind: "DRIVER"` resolves against this one. */
  driverId?: string | null;
  depotLat?: number | null;
  depotLng?: number | null;
  depotAddress?: string | null;
  /** How depotLat/depotLng/depotAddress were chosen; null on legacy rows. */
  originKind?: RouteOriginKind | null;
  endKind?: RouteEndKind | null;
  endLat?: number | null;
  endLng?: number | null;
  endAddress?: string | null;
  avoidTolls?: boolean | null;
  optimizeBy?: RouteOptimizeMetric | null;
  /** Encoded road polyline of the currently chosen route — map views render
   *  this instead of re-calling Google. Any stop reorder outside the variant
   *  "apply" endpoint nulls it out (stale polyline is worse than none). */
  plannedPolyline?: string | null;
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
  route?: { id: string; name: string; kind?: "SCHEDULED" | "ADHOC" };
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
  /** F05 / R6 — POST /route-runs/:id/settlement writes these; legacy runs (or
   *  a pre-F05 mobile build mid-deploy-skew) instead carry their settlement
   *  text in `notes` above, so a reader must check both. */
  settlementNote?: string | null;
  /** Prisma `Decimal` column — serializes over JSON as a numeric string, so
   *  callers must `Number(...)` before formatting or comparing it. */
  settlementVariance?: number | string | null;
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
export function useRoutes(
  params?: {
    search?: string;
    isActive?: boolean;
    page?: number;
    kind?: "SCHEDULED" | "ADHOC";
  },
  options?: { enabled?: boolean },
) {
  return useQuery<PaginatedResponse<Route>>({
    queryKey: ["routes", params],
    queryFn: () => apiClient.get("/routes", { params }).then((r) => r.data),
    ...options,
  });
}

export function useRoute(id: string) {
  return useQuery<Route>({
    queryKey: ["routes", id],
    queryFn: () => apiClient.get(`/routes/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

/** `origin`/`end`/`avoidTolls`/`optimizeBy` are optional planning fields
 *  (WP5's additive extension of POST /routes) — omit them to create exactly
 *  as before. TENANT origin is resolved client-side (send resolved
 *  depotLat/depotLng/depotAddress alongside `origin: {type: "TENANT"}`);
 *  DRIVER/ADDRESS origins resolve server-side. */
export function useCreateRoute() {
  return useMutation<
    Route,
    Error,
    {
      name: string;
      driverId?: string;
      depotLat?: number;
      depotLng?: number;
      depotAddress?: string;
      origin?: TripOrigin;
      end?: RoutePlanningEndDto;
      avoidTolls?: boolean;
      optimizeBy?: RouteOptimizeMetric;
    }
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
  options?: { refetchInterval?: number; enabled?: boolean },
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

/**
 * Proof-of-delivery artifacts for one run stop. `photos`/`signatureUrl` are
 * presigned (or directly renderable data) URLs; artifacts captured by older
 * driver builds stored device-local strings and surface only as
 * `legacyPhotoCount` / `signatureCaptured` so the UI stays honest about
 * what it cannot display.
 */
export interface StopPod {
  photos: { url: string }[];
  legacyPhotoCount: number;
  signatureUrl: string | null;
  signatureCaptured: boolean;
  driverNote: string | null;
  completedAt: string | null;
  ageCheckRequired: boolean;
  ageVerified: boolean;
  identityCheckRequired: boolean;
  identityVerified: boolean;
  identityType: string | null;
}

export function useStopPod(runId: string, stopId: string, enabled = true) {
  return useQuery<StopPod>({
    queryKey: ["route-runs", runId, "stops", stopId, "pod"],
    queryFn: () => apiClient.get(`/route-runs/${runId}/stops/${stopId}/pod`).then((r) => r.data),
    enabled: enabled && !!runId && !!stopId,
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
      // F11: a CANCELLED/COMPLETED write releases undelivered orders — refresh order lists so they reappear as dispatchable.
      qc.invalidateQueries({ queryKey: ["orders"] });
      // F11: same release also frees the pointer the trip builder reads — both the
      // picker list of addable orders (trips.ts `useEligibleTripOrders`) and the
      // per-selection eligibility verdict (`useTripEligibility` below).
      qc.invalidateQueries({ queryKey: ["trips-eligible-orders"] });
      qc.invalidateQueries({ queryKey: ["trip-eligibility"] });
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
  | "ORS_NETWORK_ERROR"
  // Google was the primary source (a Maps key is configured) but
  // computeRouteMatrix failed or came back sparse, so straight-line estimates
  // were used. The ORS pathway wasn't reached at all — don't offer ORS advice.
  | "GOOGLE_MATRIX_FALLBACK";

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
 *  ZERO order writes — orders attach to it only at dispatch (useCreateRouteRun).
 *  `end`/`avoidTolls`/`optimizeBy` are optional planning fields (WP2's
 *  create-path changes on POST /trips) — omit them to build exactly as before. */
export function useCreateTrip() {
  const qc = useQueryClient();
  return useMutation<
    Route,
    Error,
    {
      orderIds: string[];
      name?: string;
      driverId?: string;
      origin: TripOrigin;
      end?: RoutePlanningEndDto;
      avoidTolls?: boolean;
      optimizeBy?: RouteOptimizeMetric;
    }
  >({
    mutationFn: (dto) => apiClient.post("/trips", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["routes"] }),
  });
}

// ─── Route Planning (start/end points, tolls, objective, variants) ───────────

export type RoutePlanningEndType = "NONE" | "RETURN_TO_START" | "DRIVER_HOME" | "ADDRESS";

export interface RoutePlanningEndDto {
  type: RoutePlanningEndType;
  /** DRIVER_HOME — defaults server-side to the route's assigned driver. */
  driverId?: string;
  /** ADDRESS */
  line1?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export interface UpdateRoutePlanningDto {
  routeId: string;
  origin?: TripOrigin;
  end?: RoutePlanningEndDto;
  avoidTolls?: boolean;
  optimizeBy?: RouteOptimizeMetric;
}

export interface UpdateRoutePlanningResult extends Route {
  /** True whenever origin/end/optimizeBy/avoidTolls changed — the endpoint
   *  never reorders stops itself, so the caller should offer a re-optimize. */
  reoptimizeRecommended?: boolean;
}

/** PATCH /trips/routes/:routeId/planning — edits start/end/tolls/objective on
 *  an existing route. 409s if the route has an IN_PROGRESS run. */
export function useUpdateRoutePlanning() {
  const qc = useQueryClient();
  return useMutation<UpdateRoutePlanningResult, Error, UpdateRoutePlanningDto>({
    mutationFn: ({ routeId, ...dto }) =>
      apiClient.patch(`/trips/routes/${routeId}/planning`, dto).then((r) => r.data),
    onSuccess: (_, { routeId }) => {
      qc.invalidateQueries({ queryKey: ["routes", routeId] });
      qc.invalidateQueries({ queryKey: ["routes"] });
    },
  });
}

export interface RouteVariant {
  key: "FASTEST" | "SHORTEST" | "NO_TOLLS";
  stopIds: string[];
  durationSec: number;
  distanceMeters: number;
  hasTolls: boolean;
  encodedPolyline: string | null;
}

export interface RouteVariantsResult {
  variants: RouteVariant[];
}

/** POST /routes/:id/variants — solves the SAME stops under Fastest/Shortest/
 *  No-tolls settings for the user to compare and pick. Never rejects on a
 *  Google failure (falls back to a single solver-only result with
 *  `encodedPolyline: null`) — always check for an empty array, not a thrown
 *  error, when deciding whether to show the comparison UI. */
export function useRouteVariants() {
  return useMutation<RouteVariantsResult, Error, string>({
    mutationFn: (routeId) =>
      apiClient.post<RouteVariantsResult>(`/routes/${routeId}/variants`).then((r) => r.data),
  });
}

export interface ApplyRouteVariantDto {
  routeId: string;
  key: RouteVariant["key"];
  stopIds: string[];
  optimizeBy: RouteOptimizeMetric;
  avoidTolls: boolean;
  encodedPolyline?: string | null;
  /** SCHEDULED run to re-number to the same order in the same transaction.
   *  Omit to persist onto the route template only (future runs). The server
   *  409s if the named run isn't SCHEDULED, and — when omitted — if any run of
   *  the route is IN_PROGRESS. */
  runId?: string;
}

/** POST /routes/:id/variants/apply — persists the chosen variant's stop
 *  order, objective/tolls, and polyline onto the route (and, with `runId`,
 *  re-numbers that run's stops to match). Returns `{ applied }`, not a Route. */
export function useApplyRouteVariant() {
  const qc = useQueryClient();
  return useMutation<{ applied: boolean }, Error, ApplyRouteVariantDto>({
    mutationFn: ({ routeId, ...dto }) =>
      apiClient.post(`/routes/${routeId}/variants/apply`, dto).then((r) => r.data),
    onSuccess: (_, { routeId, runId }) => {
      qc.invalidateQueries({ queryKey: ["routes", routeId] });
      qc.invalidateQueries({ queryKey: ["routes"] });
      if (runId) qc.invalidateQueries({ queryKey: ["route-runs", runId] });
    },
  });
}

// ─── Route Analysis (AI + ETAs) ───────────────────────────────────────────────

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
