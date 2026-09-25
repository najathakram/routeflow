import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DocumentNumberType = "INVOICE" | "ESTIMATE" | "CREDIT_NOTE";

export interface NumberingSetting {
  docType: DocumentNumberType;
  prefix: string;
  nextNumber: number;
  padding: number;
  /** The true next live number, from the server: yearly series until a row is saved. */
  preview: string;
  /** false when this is still a default the tenant has not saved. */
  configured: boolean;
}

export interface UpdateNumberingInput {
  prefix?: string;
  nextNumber?: number;
  padding?: number;
  /**
   * The nextNumber the card loaded — the server 409s if the row moved
   * (SA-274 Q3).
   */
  expectedNextNumber?: number;
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
    // Invalidate on settle (success OR error) so a 409 refetches the row that moved.
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
