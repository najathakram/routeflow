import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export type MigrationSource = "ZOHO" | "QUICKBOOKS" | "CSV" | "PAPER";
export type MigrationJobStatus = "FETCHING" | "STAGED" | "CONFIRMED" | "UNDONE" | "FAILED";

export interface MigrationJob {
  id: string;
  source: MigrationSource;
  status: MigrationJobStatus;
  scopeCounts: Record<string, number>;
  confirmedAt: string | null;
  undoDeadline: string | null;
  undoneAt: string | null;
  createdAt: string;
}

export interface MigrationJobDetail {
  job: MigrationJob;
  statusCounts: Record<string, number>;
  duplicates: {
    id: string;
    entityType: string;
    externalId: string | null;
    matchedEntityId: string | null;
  }[];
}

const KEY = ["import", "migration"] as const;

export function useMigrationJobs() {
  return useQuery<MigrationJob[]>({
    queryKey: KEY,
    queryFn: () => apiClient.get("/import/migration").then((r) => r.data),
  });
}

export function useMigrationJob(id: string | undefined) {
  return useQuery<MigrationJobDetail>({
    queryKey: [...KEY, id],
    queryFn: () => apiClient.get(`/import/migration/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateMigrationJob() {
  const qc = useQueryClient();
  return useMutation<MigrationJob, Error, { source: MigrationSource }>({
    mutationFn: (dto) => apiClient.post("/import/migration", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export interface StageRow {
  entityType: string;
  externalId?: string;
  payload: Record<string, unknown>;
}

export function useStageRecords() {
  const qc = useQueryClient();
  return useMutation<MigrationJobDetail, Error, { id: string; rows: StageRow[] }>({
    mutationFn: ({ id, rows }) =>
      apiClient.post(`/import/migration/${id}/stage`, { rows }).then((r) => r.data),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}

export function useConfirmMigration() {
  const qc = useQueryClient();
  return useMutation<
    { committed: number; skipped: number; undoDeadline: string },
    Error,
    { id: string }
  >({
    mutationFn: ({ id }) => apiClient.post(`/import/migration/${id}/confirm`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUndoMigration() {
  const qc = useQueryClient();
  return useMutation<{ reversed: number }, Error, { id: string }>({
    mutationFn: ({ id }) => apiClient.post(`/import/migration/${id}/undo`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
