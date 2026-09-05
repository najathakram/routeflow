import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { CommitStockCountItem } from "../stock-count-logic";
import type {
  CommitStockCountPayload,
  CommitStockCountResponse,
  CommitStockCountSessionResponse,
} from "@routeflow/types";
export type {
  CommitStockCountPayload,
  CommitStockCountResponse,
  CommitStockCountSessionResponse,
} from "@routeflow/types";
import type {
  StartStockCountResult,
  StockCountSessionDetail,
  StockCountSessionLine,
  StockCountSessionSummary,
} from "../stock-count-logic";

// Mirrors apps/web/lib/api/stock-count.ts (once built) — the legacy one-shot
// commit below is untouched. PR-C adds a DURABLE server-side session on top
// (apps/api/src/inventory/inventory.controller.ts `/inventory/stock-counts*`)
// so a count can be paused, resumed on another device, and carries per-line
// attribution + history. See lib/stock-count-autosave.ts for the debounced
// per-line write queue that drives the PUT .../lines calls.

export function useCommitStockCount() {
  const qc = useQueryClient();
  return useMutation<CommitStockCountResponse, Error, CommitStockCountPayload>({
    mutationFn: (data) => apiClient.post("/inventory/stock-count/commit", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["admin", "products"] });
    },
  });
}

// ─── Durable stock-count sessions (PR-C) ────────────────────────────────────

function invalidateStockCountQueries(qc: ReturnType<typeof useQueryClient>, sessionId?: string) {
  qc.invalidateQueries({ queryKey: ["stock-counts"] });
  if (sessionId) qc.invalidateQueries({ queryKey: ["stock-counts", sessionId] });
}

/** Both OPEN and REVIEW sessions are resumable/editable; only these two statuses. */
export function isEditableStockCountStatus(status: StockCountSessionSummary["status"]): boolean {
  return status === "OPEN" || status === "REVIEW";
}

export interface ListStockCountSessionsParams {
  status?: StockCountSessionSummary["status"];
  page?: number;
  limit?: number;
}

export interface ListStockCountSessionsResponse {
  data: StockCountSessionSummary[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export function useStockCountSessions(params?: ListStockCountSessionsParams) {
  return useQuery<ListStockCountSessionsResponse>({
    queryKey: ["stock-counts", "list", params ?? {}],
    queryFn: () => apiClient.get("/inventory/stock-counts", { params }).then((r) => r.data),
    staleTime: 10_000,
  });
}

export function useStockCountSession(id: string | null | undefined) {
  return useQuery<StockCountSessionDetail>({
    queryKey: ["stock-counts", id],
    queryFn: () => apiClient.get(`/inventory/stock-counts/${id}`).then((r) => r.data),
    enabled: !!id,
    staleTime: 0,
  });
}

export function useStartStockCount() {
  const qc = useQueryClient();
  return useMutation<StartStockCountResult, Error, { name?: string; amendsSessionId?: string }>({
    mutationFn: (dto) => apiClient.post("/inventory/stock-counts", dto).then((r) => r.data),
    onSuccess: () => invalidateStockCountQueries(qc),
  });
}

export interface UpsertStockCountLinePayload {
  productId: string;
  countedQty?: number;
  boxes?: number;
  pieces?: number;
  /** true = ADD this to the line's existing count (the scan path). Absent/false
   * = REPLACE the line's count with this absolute total (inline edits). */
  increment?: boolean;
  mode?: StockCountSessionLine["mode"];
  /** null clears a previously-entered override. */
  unitCostOverride?: number | null;
}

/**
 * Autosave one line. Called by lib/stock-count-autosave.ts's debounced queue —
 * screens should go through that, not this hook directly, so scans and edits
 * get the right increment-vs-absolute treatment and retry-on-failure.
 */
export function useUpsertStockCountLine(sessionId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<StockCountSessionLine, Error, UpsertStockCountLinePayload>({
    mutationFn: (dto) =>
      apiClient.put(`/inventory/stock-counts/${sessionId}/lines`, dto).then((r) => r.data),
    onSuccess: () => invalidateStockCountQueries(qc, sessionId ?? undefined),
  });
}

export function useRemoveStockCountLine(sessionId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<{ removed: true }, Error, string>({
    mutationFn: (productId) =>
      apiClient
        .delete(`/inventory/stock-counts/${sessionId}/lines/${productId}`)
        .then((r) => r.data),
    onSuccess: () => invalidateStockCountQueries(qc, sessionId ?? undefined),
  });
}

export function useCommitStockCountSession(sessionId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<
    CommitStockCountSessionResponse,
    Error,
    { notes?: string; effectiveDate?: string }
  >({
    mutationFn: (dto) =>
      apiClient.post(`/inventory/stock-counts/${sessionId}/commit`, dto).then((r) => r.data),
    onSuccess: () => {
      invalidateStockCountQueries(qc, sessionId ?? undefined);
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["admin", "products"] });
    },
  });
}

export function useDiscardStockCountSession() {
  const qc = useQueryClient();
  return useMutation<StockCountSessionSummary, Error, string>({
    mutationFn: (sessionId) =>
      apiClient.post(`/inventory/stock-counts/${sessionId}/discard`).then((r) => r.data),
    onSuccess: (_, sessionId) => invalidateStockCountQueries(qc, sessionId),
  });
}
