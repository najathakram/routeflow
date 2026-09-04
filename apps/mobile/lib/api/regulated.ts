import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { ReportCadence } from "./tracked-categories";
import type {
  RegulatedLedgerResponse,
  RegulatedLedgerRow,
  RegulatedReportColumn,
  RegulatedReportPreview,
  RegulatedReportWarning,
  RegulatedReportWarningCode,
} from "@routeflow/types";
export type {
  RegulatedLedgerResponse,
  RegulatedLedgerRow,
  RegulatedReportColumn,
  RegulatedReportPreview,
  RegulatedReportWarning,
  RegulatedReportWarningCode,
} from "@routeflow/types";

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

export function useRegulatedFilings(categoryId?: string, options?: { enabled?: boolean }) {
  return useQuery<RegulatedFiling[]>({
    queryKey: ["regulated-filings", categoryId ?? null],
    queryFn: () =>
      apiClient
        .get("/regulated/filings", { params: categoryId ? { category: categoryId } : {} })
        .then((r) => r.data),
    enabled: options?.enabled ?? true,
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

// ─── Reports (arbitrary date range, in-app preview + TX Comptroller) ─────────────
// Mirrors apps/api/src/regulated/report-types.ts (WP11) / apps/web/lib/api/tracked-categories.ts
// (WP12). Stateless — computed on demand server-side, nothing is persisted here.

export interface RegulatedReportParams {
  category: string;
  /** Inclusive start date, YYYY-MM-DD. */
  from: string;
  /** Inclusive end date, YYYY-MM-DD. */
  to: string;
  /** Omitted = the category's configured reportTemplate. */
  template?: string;
}

/**
 * JSON preview for an arbitrary date range. `params: null` (nothing chosen yet, or the
 * operator hasn't tapped Preview) keeps the query disabled — mirrors the ledger/filings
 * hooks above, key-namespaced with a dash like the rest of this file.
 */
export function useRegulatedReportPreview(params: RegulatedReportParams | null) {
  return useQuery<RegulatedReportPreview>({
    queryKey: ["regulated-report", params ?? {}],
    queryFn: () =>
      apiClient.get("/regulated/reports/preview", { params: params ?? {} }).then((r) => r.data),
    enabled: !!params,
  });
}

/**
 * Fetches the report's CSV as TEXT rather than a URL — `GET /regulated/reports/csv` needs
 * the same auth header as every other API call, which the OS share sheet cannot attach to
 * a bare URL. `shareCsvText` (lib/share-pdf.ts) writes this string straight to disk/Blob
 * instead of downloading from a signed link.
 */
export async function fetchRegulatedReportCsvText(params: RegulatedReportParams): Promise<string> {
  const { data } = await apiClient.get<string>("/regulated/reports/csv", {
    params,
    responseType: "text",
  });
  return data;
}
