import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Shared types ───────────────────────────────────────────────────────────

export type StockCountMode = "REPLACE" | "ADD";
export type StockCountStatus = "OPEN" | "REVIEW" | "COMMITTED" | "DISCARDED";

// ─── Legacy one-shot commit (`/inventory/stock-count/commit`) — UNCHANGED ───
// Kept exactly as it was: a client-generated sessionId, commit-in-one-shot.
// The durable PR-C session below is additive and does not touch this path.

export interface CommitStockCountItem {
  productId: string;
  quantity: number;
  mode: StockCountMode;
}

export interface CommitStockCountPayload {
  sessionId: string;
  items: CommitStockCountItem[];
  notes?: string;
  effectiveDate?: string;
}

export interface CommitStockCountResponse {
  sessionId: string;
  reference: string;
  applied: number;
  skipped: number;
  movementIds: string[];
}

export function useCommitStockCount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CommitStockCountPayload) =>
      apiClient
        .post<CommitStockCountResponse>("/inventory/stock-count/commit", data)
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

// ─── Durable stock-count sessions (PR-C) ─────────────────────────────────────
// A count now lives on the server: it can be paused and resumed from another
// device, carries per-line attribution, and leaves a readable history. The
// one-shot endpoint above is untouched.

/** A row from the local scan/review table — the client's live mirror of a
 *  `StockCountLine`, kept in sync via the autosave queue in `StockCountTab`. */
export interface StockCountLocalRow {
  productId: string;
  name: string;
  sku?: string | null;
  unit: string;
  /** Live current stock, for display only. */
  currentStock: number;
  /** On-hand snapshotted the moment this line was first counted — what the
   *  review screen's variance compares against. Frozen server-side. */
  expectedQty: number;
  /** The running counted total, in base units. */
  countedQty: number;
  mode: StockCountMode;
  /** Optional per-line cost correction (4dp). Set ⇒ commit also writes the
   *  audited COST_BASIS movement for this product. */
  unitCostOverride?: number | null;
  /** Live average cost — the $ variance basis ("at current avg cost"). */
  averageCost?: number | null;
  countedById: string;
  updatedAt: string;
  /** The server `StockCountLine.id`, once known (absent until first synced). */
  lineId?: string;
}

export interface StockCountSessionRef {
  id: string;
  name?: string | null;
  startedAt: string;
  startedById: string;
}

export interface StockCountUserRef {
  id: string;
  username: string;
}

export interface StockCountSessionSummary {
  id: string;
  name?: string | null;
  status: StockCountStatus;
  startedById: string;
  startedAt: string;
  committedAt?: string | null;
  committedById?: string | null;
  discardedAt?: string | null;
  notes?: string | null;
  movementReference?: string | null;
  amendsSessionId?: string | null;
  startedBy?: StockCountUserRef | null;
  committedBy?: StockCountUserRef | null;
  _count?: { lines: number };
  /** Server-computed net variance $ for this session (list rows don't carry
   *  `lines`, so this is the ONLY source for it there) — same delta rule as
   *  commit (REPLACE = counted − expected, ADD = counted) valued at each
   *  product's current `averageCost` via the server's `roundMoney`. Always
   *  prefer this over any client recomputation so web/mobile never drift. */
  netVarianceMoney: number;
}

export interface StockCountLineProduct {
  id: string;
  name: string;
  sku?: string | null;
  unit: string;
  unitsPerBox?: number | null;
  currentStock: number | string;
  averageCost?: number | string | null;
}

export interface StockCountLine {
  id: string;
  productId: string;
  mode: StockCountMode;
  countedQty: number | string;
  boxes?: number | null;
  pieces?: number | null;
  expectedQty: number | string;
  unitCostOverride?: number | string | null;
  countedById: string;
  updatedAt: string;
  product: StockCountLineProduct;
}

export interface StockCountSessionDetail extends StockCountSessionSummary {
  lines: StockCountLine[];
}

export interface StartStockCountResponse extends StockCountSessionSummary {
  otherOpenSessions: StockCountSessionRef[];
}

export interface StockCountSessionListResponse {
  data: StockCountSessionSummary[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export function useStockCountSessions(params?: {
  status?: StockCountStatus;
  page?: number;
  limit?: number;
}) {
  return useQuery({
    queryKey: ["inventory", "stockCountSessions", params],
    queryFn: () =>
      apiClient
        .get<StockCountSessionListResponse>("/inventory/stock-counts", { params })
        .then((r) => r.data),
  });
}

export function useStockCountSession(id: string | null | undefined) {
  return useQuery({
    queryKey: ["inventory", "stockCountSession", id],
    queryFn: () =>
      apiClient.get<StockCountSessionDetail>(`/inventory/stock-counts/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useStartStockCount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: { name?: string; amendsSessionId?: string }) =>
      apiClient.post<StartStockCountResponse>("/inventory/stock-counts", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory", "stockCountSessions"] }),
  });
}

export interface UpsertStockCountLineInput {
  productId: string;
  countedQty?: number;
  boxes?: number;
  pieces?: number;
  /** true = additive (the live scan path); absent/false = the running total
   *  (review-screen edits). Increment is deliberately NOT idempotent. */
  increment?: boolean;
  mode?: StockCountMode;
  unitCostOverride?: number | null;
}

/** Autosave one counted line. Deliberately does NOT invalidate the session
 *  detail query on success — the caller's local state is authoritative while
 *  a count is in progress, and a background refetch here would clobber
 *  in-flight edits. The caller merges the returned row itself. */
export function useUpsertStockCountLine() {
  return useMutation({
    mutationFn: ({ sessionId, ...dto }: { sessionId: string } & UpsertStockCountLineInput) =>
      apiClient
        .put<StockCountLine>(`/inventory/stock-counts/${sessionId}/lines`, dto)
        .then((r) => r.data),
  });
}

export function useRemoveStockCountLine() {
  return useMutation({
    mutationFn: ({ sessionId, productId }: { sessionId: string; productId: string }) =>
      apiClient
        .delete(`/inventory/stock-counts/${sessionId}/lines/${productId}`)
        .then((r) => r.data as { removed: boolean }),
  });
}

export interface CommitStockCountSessionResponse {
  sessionId: string;
  reference: string | null;
  applied: number;
  skipped: number;
  movementIds: string[];
  costMovementIds?: string[];
  alreadyCommitted?: boolean;
}

export function useCommitStockCountSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      sessionId,
      ...dto
    }: {
      sessionId: string;
      notes?: string;
      effectiveDate?: string;
    }) =>
      apiClient
        .post<CommitStockCountSessionResponse>(`/inventory/stock-counts/${sessionId}/commit`, dto)
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

export function useDiscardStockCountSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      apiClient.post(`/inventory/stock-counts/${sessionId}/discard`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory", "stockCountSessions"] }),
  });
}

// ─── Pure helpers (shared by StockCountTab + the review/history screens) ────

/** REPLACE = "on-hand IS this"; ADD = "add this to on-hand" — mirrors the
 *  server's `applyStockCountItemsInTx`. */
export function computeCountedAfter(row: {
  mode: StockCountMode;
  countedQty: number;
  expectedQty: number;
}): number {
  return row.mode === "REPLACE" ? row.countedQty : row.expectedQty + row.countedQty;
}

export function computeQtyVariance(row: {
  mode: StockCountMode;
  countedQty: number;
  expectedQty: number;
}): number {
  return computeCountedAfter(row) - row.expectedQty;
}
