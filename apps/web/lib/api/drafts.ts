import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

/**
 * Minimize & resume drafts (pos-cost-roles-spec §2). A parked builder draft;
 * `payload` is the full builder state so a draft restores exactly. Per-user,
 * tenant-scoped server-side.
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
 * (the builder passes null until the user actually resumes), so a fresh builder
 * open never fires a request.
 */
export function useDraft(id: string | null | undefined) {
  return useQuery<SaleDraft>({
    queryKey: ["drafts", id],
    queryFn: () => apiClient.get(`/drafts/${id}`).then((r) => r.data),
    enabled: !!id,
    staleTime: 0,
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
