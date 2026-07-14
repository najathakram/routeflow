import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { ReportCadence } from "./tracked-categories";

// ─── Filings — mirrors apps/web/lib/api/tracked-categories.ts (Filings, W5b) ────

export type RegulatedFilingStatus = "GENERATED" | "FAILED";

export interface RegulatedFiling {
  id: string;
  trackedCategoryId: string;
  reportTemplate: string;
  cadence: ReportCadence;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  status: RegulatedFilingStatus;
  totalQty: string; // Prisma Decimal serialized as a string
  totalUnitBasisQty: string;
  totalNetSales: string;
  totalCategoryTax: string;
  csvKey: string | null;
  generationCount: number;
  generatedAt: string;
}

export interface PrepareFilingInput {
  trackedCategoryId: string;
  cadence?: ReportCadence;
  year: number;
  index?: number; // month 1-12 (MONTHLY) or quarter 1-4 (QUARTERLY); ignored ANNUAL
}

export function useRegulatedFilings(categoryId?: string) {
  return useQuery<RegulatedFiling[]>({
    queryKey: ["regulated-filings", categoryId ?? null],
    queryFn: () =>
      apiClient
        .get("/regulated/filings", { params: categoryId ? { category: categoryId } : {} })
        .then((r) => r.data),
  });
}

export function usePrepareFiling() {
  const qc = useQueryClient();
  return useMutation<RegulatedFiling, Error, PrepareFilingInput>({
    mutationFn: (dto) => apiClient.post("/regulated/filings/prepare", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["regulated-filings"] }),
  });
}

/**
 * Fetch a short-lived presigned URL for a filing's stored artifact. Only "csv" is
 * ever actually generated server-side today (mirrors web's RegulatedFilingsTable
 * comment) — "pdf" is accepted by the signature for parity but callers in this
 * codebase should not request it; it may 404.
 */
export async function fetchRegulatedFilingUrl(id: string, format: "csv" | "pdf" = "csv") {
  const { data } = await apiClient.get(`/regulated/filings/${id}/${format}`);
  return data.url as string;
}

// ─── Ledger (per-section net sales / tax by period) ──────────────────────────────

export interface RegulatedLedgerRow {
  trackedCategoryId: string;
  categoryName: string;
  periodBucket: string; // "YYYY-MM" (UTC month)
  qty: number;
  unitBasisQty: number;
  netSales: number; // signed net (reversals net it down)
  categoryTax: number; // signed net — snapshot 0 until the W3 tax engine lands
}

export interface RegulatedLedgerResponse {
  rows: RegulatedLedgerRow[];
  /** Note: `totals` intentionally omits `unitBasisQty` (sum the rows for that). */
  totals: { qty: number; netSales: number; categoryTax: number };
}

/**
 * Net-sales / tax grouped by (section, month). `to` is INCLUSIVE on this endpoint.
 * Amounts come back as numbers (the ledger endpoint Number()-casts, unlike filings).
 */
export function useRegulatedLedger(
  params?: { category?: string; from?: string; to?: string },
  options?: { enabled?: boolean },
) {
  return useQuery<RegulatedLedgerResponse>({
    queryKey: ["regulated-ledger", params ?? {}],
    queryFn: () =>
      apiClient
        .get("/regulated/ledger", {
          params: {
            ...(params?.category ? { category: params.category } : {}),
            ...(params?.from ? { from: params.from } : {}),
            ...(params?.to ? { to: params.to } : {}),
          },
        })
        .then((r) => r.data),
    enabled: options?.enabled ?? true,
  });
}
