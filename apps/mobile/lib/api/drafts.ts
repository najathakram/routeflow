import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

/**
 * Minimize & resume drafts (pos-cost-roles-spec §2) — mobile mirror of
 * apps/web/lib/api/drafts.ts. `payload` is the full order-builder state (see
 * ../drafts-payload.ts for the pure shape + conversion helpers) so a parked
 * draft restores exactly — on the SAME device or the other one, since the
 * payload shape is shared with web. Per-user, tenant-scoped server-side
 * (apps/api/src/drafts/): `/drafts` is used exactly as it exists, no API change.
 */
export interface SaleDraft {
  id: string;
  kind: "ORDER" | "INVOICE";
  customerId?: string | null;
  customerName?: string | null;
  title?: string | null;
  payload: Record<string, unknown>;
  device?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SaveDraftInput = Partial<
  Pick<SaleDraft, "kind" | "customerId" | "customerName" | "title" | "payload" | "device">
>;

export function useDrafts() {
  return useQuery<SaleDraft[]>({
    queryKey: ["drafts"],
    queryFn: () => apiClient.get("/drafts").then((r) => r.data),
    staleTime: 10_000,
  });
}

/**
 * Load a single draft for resume-hydration. Only enabled once an id is present
 * (the builder passes null until the operator actually resumes), so a fresh
 * builder open never fires a request.
 */
export function useDraft(id: string | null | undefined) {
  return useQuery<SaleDraft>({
    queryKey: ["drafts", id],
    queryFn: () => apiClient.get(`/drafts/${id}`).then((r) => r.data),
    enabled: !!id,
    staleTime: 0,
    // A stale DraftStrip card (resumed or deleted on another device) 404s, and
    // the app's default `retry: 3` would keep `isFetching` true through ~7s of
    // exponential backoff — i.e. a blank full-screen spinner before the
    // "That draft is gone" alert. A gone draft is never coming back: don't retry it.
    retry: (count, err) =>
      (err as { response?: { status?: number } })?.response?.status !== 404 && count < 2,
  });
}

export function useCreateDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: SaveDraftInput) =>
      apiClient.post("/drafts", dto).then((r) => r.data as SaleDraft),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["drafts"] }),
  });
}

export function useUpdateDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...dto }: { id: string } & SaveDraftInput) =>
      apiClient.patch(`/drafts/${id}`, dto).then((r) => r.data as SaleDraft),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["drafts"] }),
  });
}

export function useDeleteDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/drafts/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["drafts"] }),
  });
}
