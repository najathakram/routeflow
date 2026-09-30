import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { SaleDraft, SaveDraftInput } from "@routeflow/types";
export type { SaleDraft, SaveDraftInput } from "@routeflow/types";

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
