import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DocumentNumberType = "INVOICE" | "ESTIMATE" | "CREDIT_NOTE" | "PAYMENT";

export interface NumberingSetting {
  docType: DocumentNumberType;
  prefix: string;
  nextNumber: number;
  padding: number;
  /** Formatted next number (what will be minted next), from the server. */
  preview: string;
  /** false when this is still a default the tenant has not saved. */
  configured: boolean;
}

export interface UpdateNumberingInput {
  prefix?: string;
  nextNumber?: number;
  padding?: number;
}

/** Client-side mirror of the server's `format()` for live previews while editing. */
export function formatDocumentNumber(prefix: string, nextNumber: number, padding: number): string {
  const digits = String(Math.max(0, Math.trunc(nextNumber || 0)));
  return `${prefix}${padding > 0 ? digits.padStart(padding, "0") : digits}`;
}

const KEY = ["import", "numbering"] as const;

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useNumberingSettings() {
  return useQuery<NumberingSetting[]>({
    queryKey: KEY,
    queryFn: () => apiClient.get("/import/numbering").then((r) => r.data),
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useUpdateNumbering() {
  const qc = useQueryClient();
  return useMutation<
    NumberingSetting,
    Error,
    { docType: DocumentNumberType; data: UpdateNumberingInput }
  >({
    mutationFn: ({ docType, data }) =>
      apiClient.put(`/import/numbering/${docType}`, data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
