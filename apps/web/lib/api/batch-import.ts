import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export type ImportFileStatus =
  | "QUEUED"
  | "PROCESSING"
  | "CLEAN"
  | "NEEDS_REVIEW"
  | "DUPLICATE"
  | "FAILED"
  | "POSTED";
export type ImportBatchStatus = "PROCESSING" | "READY" | "POSTED" | "PARTIALLY_POSTED";

export interface ImportBatch {
  id: string;
  status: ImportBatchStatus;
  totalFiles: number;
  cleanCount: number;
  reviewCount: number;
  dupeCount: number;
  postedCount: number;
  meteredScans: number;
  createdAt: string;
  postedAt: string | null;
}

/** One line item as extracted by the AI scan, echoed back inside extractedPayload. */
export interface ImportScanLine {
  extractedName?: string;
  qty?: number;
  unitCost?: number;
  lineTotal?: number | null;
  matchedProductId?: string | null;
  matchedProductName?: string | null;
  confidence?: "high" | "medium" | "low" | "none";
  /** True once the operator has explicitly mapped or dismissed this line. */
  reviewed?: boolean;
}

export interface ImportExtractedPayload {
  supplier?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  total?: number | null;
  items?: ImportScanLine[];
}

export interface ImportQueueItem {
  id: string;
  batchId: string;
  filename: string | null;
  status: ImportFileStatus;
  supplierName: string | null;
  /** Resolved Supplier id, once the extracted name was matched (or the operator picked one). */
  supplierMatchId: string | null;
  invoiceNumber: string | null;
  total: string | null;
  unmatchedLines: number;
  duplicateOfInvoiceId: string | null;
  errorMessage: string | null;
  createdAt: string;
  extractedPayload: ImportExtractedPayload | null;
  /** Lines with no product match that the operator hasn't looked at yet — blocks resolving. */
  unreviewedLines: number;
  /** A supplier name was detected but never linked to a Supplier record — also blocks resolving. */
  supplierUnresolved: boolean;
}

export interface BatchDetail {
  batch: ImportBatch;
  items: ImportQueueItem[];
}

const KEY = ["import", "batch"] as const;

export function useBatches() {
  return useQuery<ImportBatch[]>({
    queryKey: [...KEY, "list"],
    queryFn: () => apiClient.get("/import/batch").then((r) => r.data),
  });
}

export function useBatch(id: string | undefined) {
  return useQuery<BatchDetail>({
    queryKey: [...KEY, id],
    queryFn: () => apiClient.get(`/import/batch/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateBatch() {
  return useMutation<ImportBatch, Error, void>({
    mutationFn: () => apiClient.post("/import/batch", {}).then((r) => r.data),
  });
}

export function useScanFile() {
  const qc = useQueryClient();
  return useMutation<ImportQueueItem, Error, { batchId: string; file: File }>({
    mutationFn: ({ batchId, file }) => {
      const form = new FormData();
      form.append("files", file);
      return apiClient
        .post(`/import/batch/${batchId}/scan`, form, {
          headers: { "Content-Type": "multipart/form-data" },
          timeout: 120_000,
        })
        .then((r) => r.data);
    },
    onSuccess: (_d, { batchId }) => qc.invalidateQueries({ queryKey: [...KEY, batchId] }),
  });
}

export function useResolveItem() {
  const qc = useQueryClient();
  return useMutation<ImportQueueItem, Error, { batchId: string; itemId: string }>({
    mutationFn: ({ itemId }) =>
      apiClient.post(`/import/batch/items/${itemId}/resolve`).then((r) => r.data),
    onSuccess: (_d, { batchId }) => qc.invalidateQueries({ queryKey: [...KEY, batchId] }),
  });
}

export interface UpdateBatchItemLinePatch {
  index: number;
  productId?: string;
  keepCustom?: boolean;
}

/** Review UI: remap lines to products, keep some as custom, and/or link a supplier. */
export function useUpdateBatchItem() {
  const qc = useQueryClient();
  return useMutation<
    ImportQueueItem,
    Error,
    { batchId: string; itemId: string; supplierId?: string; lines?: UpdateBatchItemLinePatch[] }
  >({
    mutationFn: ({ itemId, supplierId, lines }) =>
      apiClient.patch(`/import/batch/items/${itemId}`, { supplierId, lines }).then((r) => r.data),
    onSuccess: (_d, { batchId }) => qc.invalidateQueries({ queryKey: [...KEY, batchId] }),
  });
}

export function usePostBatch() {
  const qc = useQueryClient();
  return useMutation<{ posted: number; batchStatus: string }, Error, { id: string }>({
    mutationFn: ({ id }) => apiClient.post(`/import/batch/${id}/post`).then((r) => r.data),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: [...KEY, id] });
      qc.invalidateQueries({ queryKey: ["vendor-bills"] });
    },
  });
}
