import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import { invalidateOrderCaches } from "./orders";
import type { RouteAnalysisResult, RouteSettings, StopETA } from "@routeflow/types";
export type { RouteAnalysisResult, RouteSettings, StopETA } from "@routeflow/types";

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
  // F05 / R2 / G7: box-aware line money, straight off `RUN_LINE_ITEMS_SELECT`.
  // Prisma Decimals may arrive as strings — see lib/run-money.ts#lineItemSubtotal.
  subtotal?: number | string | null;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  // B305 round 2 (RULING 1/3): sale-time regulated-category tax snapshot
  // (sales.prisma OrderItem.categoryTaxAmount), straight off
  // `RUN_LINE_ITEMS_SELECT`. Feeds lib/run-money.ts#deliveredCategoryTax's
  // per-unit proration for the short-pick payment estimate.
  categoryTaxAmount?: number | string | null;
}

export interface RouteRunOrder {
  id: string;
  orderNumber: string;
  status: string;
  urgent: boolean;
  notes?: string;
  invoiceId?: string;
  lineItems: RouteRunOrderItem[];
  // REG-B305: tax-inclusive amount due (Prisma Decimals — may arrive as
  // strings over the wire). See lib/run-money.ts#orderAmountDue.
  subtotal?: number | string | null;
  tax?: number | string | null;
  total?: number | string | null;
  // REG-B305 round 2: `Order.total` above carries NO discount and, on a
  // split delivery, the WHOLE shipping fee on every visit — projected but no
  // longer read by orderAmountDue's money math (RULING 2: no client-side
  // total-minus-discount guess is ever safe). `invoices` — ALL open drafts
  // (RULING 1; a regulated split order can have several: base + `-R#`
  // siblings) — is the real basis. See lib/run-money.ts#orderAmountDue.
  discountAmount?: number | string | null;
  shippingFee?: number | string | null;
  invoices?: Array<{
    id: string;
    subtotal: number | string | null;
    taxAmount: number | string | null;
    discount: number | string | null;
    shippingFee: number | string | null;
    total: number | string | null;
  }>;
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
    // B305 round 3: mirrors RUN_STOP_INCLUDE.customer.select.isTaxExempt
    // (sales.prisma Customer.isTaxExempt) — feeds reconciledAmountDue's
    // isTaxExempt input so a short-picked stop's estimate zeroes tax for an
    // exempt customer exactly as the server does.
    isTaxExempt?: boolean;
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
  route?: {
    id: string;
    name: string;
    kind?: "SCHEDULED" | "ADHOC";
    depotLat?: number | null;
    depotLng?: number | null;
    depotAddress?: string | null;
    endKind?: "NONE" | "RETURN_TO_START" | "DRIVER_HOME" | "ADDRESS";
    endLat?: number | null;
    endLng?: number | null;
  };
  driver?: { id: string; contactName: string };
  status: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  scheduledDate: string;
  startedAt?: string;
  completedAt?: string;
  stops?: RouteRunStop[];
  notes?: string | null;
  // F05 / R6 / R8: end-of-run cash/check settlement, server-truth — the
  // gate `shouldForceSettlement` (lib/run-settlement.ts) reads these.
  settlementNote?: string | null;
  settlementVariance?: number | string | null;
  // F05 / R5: server-computed cash+check collected this run (getRunCashCollections).
  collectedPayments?: { cashTotal: number; checkTotal: number; count: number };
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
      // F11: a CANCELLED/COMPLETED write releases undelivered orders — refresh order lists so
      // they reappear as dispatchable. Goes through invalidateOrderCaches so BOTH key families
      // are hit: the operator route-run screen that issues the cancel reads ["admin", "orders"].
      invalidateOrderCaches(qc);
    },
  });
}

/**
 * F05 / R6 / R8 — POST /route-runs/:id/settlement. Records the driver's (or
 * operator's) end-of-run cash/check count against the server-computed
 * expected total; the server derives `expected` itself (never trusts a
 * client-supplied figure) and returns the updated run plus
 * expectedCash/countedCash/variance. Same invalidation as useUpdateRunStatus
 * since both mutate the same run resource.
 */
export function useSettleRun() {
  const qc = useQueryClient();
  return useMutation<RouteRun, Error, { id: string; countedCash: number; varianceReason?: string }>(
    {
      mutationFn: ({ id, countedCash, varianceReason }) =>
        apiClient
          .post(`/route-runs/${id}/settlement`, { countedCash, varianceReason })
          .then((r) => r.data),
      onSuccess: (_, { id }) => {
        qc.invalidateQueries({ queryKey: ["route-runs"] });
        qc.invalidateQueries({ queryKey: ["route-runs", id] });
      },
    },
  );
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

/**
 * Durable POD: attach one photo/signature to a run stop as a JSON data URL —
 * deliberately NOT multipart, so an offline attempt is queued by the offline
 * interceptor and replays (FIFO, before the queued completion). The server
 * stores the image and appends its storage key to the stop; `artifactId`
 * makes replays idempotent. 60s timeout mirrors the other image uploads.
 */
export interface AttachPodArtifactDto {
  runId: string;
  stopId: string;
  kind: "photo" | "signature";
  dataUrl: string;
  artifactId?: string;
}

export function useAttachPodArtifact() {
  return useMutation<{ key: string; url: string }, Error, AttachPodArtifactDto>({
    mutationFn: ({ runId, stopId, ...body }) =>
      apiClient
        .post(`/route-runs/${runId}/stops/${stopId}/pod-artifact`, body, { timeout: 60_000 })
        .then((r) => r.data),
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

// F05 removed `useUpdateRun` (PATCH /route-runs/:id with scheduledDate/notes). Its only caller
// was the settlement screen's notes-append, and appending the settlement into free-text `notes`
// is exactly B167: the sole renderer of that column is hidden once a run closes. Settlement now
// posts to /route-runs/:id/settlement (`useSettleRun`), which writes the dedicated
// settlementNote/settlementVariance columns the web run-detail page reads for every status.
// The endpoint itself stays — web still uses it, and its inline unvalidated body is why F05
// added a NEW route rather than retrofitting it.

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

export function useOperatorRouteRuns(
  params?: { status?: string; date?: string; limit?: number },
  options?: { enabled?: boolean },
) {
  return useQuery<{ data: RouteRun[]; meta: any }>({
    queryKey: ["route-runs", "operator", params],
    queryFn: () =>
      apiClient.get("/route-runs", { params: { limit: 50, ...params } }).then((r) => r.data),
    staleTime: 30_000,
    enabled: options?.enabled ?? true,
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
