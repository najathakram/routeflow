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

// ─── Reports (arbitrary date range, in-app preview + TX Comptroller) ─────────────
// Mirrors apps/api/src/regulated/report-types.ts (WP11) / apps/web/lib/api/tracked-categories.ts
// (WP12). Stateless — computed on demand server-side, nothing is persisted here.

export interface RegulatedReportColumn {
  key: string;
  label: string;
  align?: "right";
}

export type RegulatedReportWarningCode =
  | "MISSING_WHOLESALER_LICENSE"
  | "MISSING_ITEM_TYPE"
  | "MISSING_UOM"
  | "MISSING_TAXPAYER_ID"
  | "INVALID_TAXPAYER_ID"
  | "MISSING_RETAILER_LICENSE"
  | "INVALID_RETAILER_LICENSE"
  | "INVALID_WHOLESALER_LICENSE"
  | "MISSING_ADDRESS"
  | "NEGATIVE_NET_INVOICE"
  | "FRACTIONAL_QTY"
  | "UNLINKED_LEDGER_ROWS"
  | "UNMATCHED_LEDGER_LINE"
  | "UNLISTED_PRODUCT_LINE";

export interface RegulatedReportWarning {
  code: RegulatedReportWarningCode;
  /** A complete human sentence, ready to render as-is. */
  message: string;
  invoiceId?: string;
  customerName?: string;
  productId?: string;
}

/** One report, in the same shape the JSON preview and the CSV file are both built from. */
export interface RegulatedReportPreview {
  template: string;
  title: string;
  categoryId: string;
  categoryName: string;
  /** Inclusive YYYY-MM-DD range, echoed back for display. */
  from: string;
  to: string;
  columns: RegulatedReportColumn[];
  /** Fully formatted cells, in `columns` order — never re-derived from raw numbers. */
  rows: string[][];
  /** Aggregate templates only; null for per-sale templates like TX. */
  totalsRow: string[] | null;
  /** Headline figures for the preview UI (not necessarily present in the CSV). */
  displayTotals: { label: string; value: string }[];
  warnings: RegulatedReportWarning[];
  /**
   * True when the column layout deviates from the template's official default.
   * Mobile never requests custom columns (it never sends `columns`), but the
   * field is still typed here so the shared preview type matches the API's.
   */
  custom?: boolean;
}

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
