import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Mirrors `SupplierStatementScanStatus` (Prisma enum, `STATEMENT_SCAN_STATUSES`
 *  in `supplier-statements.service.ts`). Unlike the invoice scanner, DISCARDED
 *  rows are NOT filtered out of the list here. */
export type SupplierStatementScanStatus = "SCANNED" | "APPLIED" | "DISCARDED";

/**
 * Row shape as `GET /supplier-statements` returns it — mirrors
 * `STATEMENT_SCAN_LIST_SELECT` in `supplier-statements.service.ts` exactly
 * (promoted columns only; `extractedPayload`/`lines`/`matches` are the
 * reconciliation grid's data and never travel to this app, which only reads
 * scan status and the applied result).
 */
export interface SupplierStatementScanSummary {
  id: string;
  status: SupplierStatementScanStatus;
  fileName: string | null;
  supplierNameRaw: string | null;
  supplierId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  openingBalance: number | string | null;
  closingBalance: number | string | null;
  lineCount: number | null;
  /** Set once applied — the paymentGroupId of the payments this scan wrote. */
  appliedPaymentGroupId: string | null;
  appliedAt: string | null;
  createdAt: string;
}

/**
 * Loose shape of whatever `POST /supplier-statements/scan` hands back for a
 * freshly-read statement — normalized into `SupplierStatementScanSummary` by
 * `toScanSummary` below rather than trusted field-for-field, because the
 * parse endpoint's own service code returns two different shapes depending on
 * whether the upload was a fileHash cache-hit (the fuller stored-row shape,
 * keyed `scanId`) or a brand-new read (a flatter `{ scanId, supplier, lines,
 * … }` object with no `status`/`createdAt` yet). A new scan is always
 * SCANNED, so that's the safe default when the field is absent.
 */
interface RawScanStatementResponse {
  id?: string;
  scanId?: string | null;
  status?: SupplierStatementScanStatus | null;
  fileName?: string | null;
  supplier?: string | null;
  supplierNameRaw?: string | null;
  supplierId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  openingBalance?: number | string | null;
  closingBalance?: number | string | null;
  lineCount?: number | null;
  lines?: unknown[];
  appliedPaymentGroupId?: string | null;
  appliedAt?: string | null;
  createdAt?: string | null;
}

function toScanSummary(raw: RawScanStatementResponse): SupplierStatementScanSummary {
  return {
    id: raw.id ?? raw.scanId ?? "",
    status: raw.status ?? "SCANNED",
    fileName: raw.fileName ?? null,
    supplierNameRaw: raw.supplierNameRaw ?? raw.supplier ?? null,
    supplierId: raw.supplierId ?? null,
    periodStart: raw.periodStart ?? null,
    periodEnd: raw.periodEnd ?? null,
    openingBalance: raw.openingBalance ?? null,
    closingBalance: raw.closingBalance ?? null,
    lineCount: raw.lineCount ?? (Array.isArray(raw.lines) ? raw.lines.length : null),
    appliedPaymentGroupId: raw.appliedPaymentGroupId ?? null,
    appliedAt: raw.appliedAt ?? null,
    createdAt: raw.createdAt ?? new Date().toISOString(),
  };
}

/** One of the four typed codes the parse endpoint reproduces verbatim from the
 *  invoice scanner's error contract (see `supplier-statements.service.ts`).
 *  Names match the web client's `StatementAiError` 1:1 — same wire contract,
 *  same shape on both clients. */
export type StatementAiErrorCode =
  | "AI_KEY_INVALID"
  | "AI_SCAN_REJECTED"
  | "AI_UNAVAILABLE"
  | "AI_PARSE_FAILED";

export interface StatementAiError {
  /** null covers both the no-API-key case (a plain, code-less
   *  BadRequestException) and anything genuinely unexpected — callers must
   *  still have a fallback branch, never assume one of the four. */
  code: StatementAiErrorCode | null;
  message: string;
}

const KNOWN_CODES: StatementAiErrorCode[] = [
  "AI_KEY_INVALID",
  "AI_SCAN_REJECTED",
  "AI_UNAVAILABLE",
  "AI_PARSE_FAILED",
];

/** Read the typed AI error off a failed scan request. */
export function getStatementAiError(error: unknown): StatementAiError {
  const data = (error as { response?: { data?: { code?: string; message?: string } } })?.response
    ?.data;
  const code = data?.code as StatementAiErrorCode | undefined;
  return {
    code: code && KNOWN_CODES.includes(code) ? code : null,
    message: data?.message || "Failed to scan the statement.",
  };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useSupplierStatements(params?: {
  status?: SupplierStatementScanStatus;
  limit?: number;
}) {
  return useQuery<{ data: SupplierStatementScanSummary[]; meta: any }>({
    queryKey: ["supplier-statements", params],
    queryFn: () =>
      apiClient
        .get("/supplier-statements", { params: { limit: 30, ...params } })
        .then((r) => r.data),
    staleTime: 15_000,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/**
 * Upload/photograph a statement and have the model read it. Mirrors
 * `useScanInvoice`'s shape — a single multipart POST that returns the read
 * synchronously — but under field name "files" (a statement page can be a
 * PDF or an image, unlike the invoice scanner's all-image "images" field;
 * matches the web client's `scanStatement`, which the same endpoint serves).
 * No polling here: reconciliation happens later, on the web review screen.
 */
export function useScanStatement() {
  const qc = useQueryClient();
  return useMutation<SupplierStatementScanSummary, Error, FormData>({
    mutationFn: (formData) =>
      apiClient
        .post("/supplier-statements/scan", formData, {
          headers: { "Content-Type": "multipart/form-data" },
          // Statements run a slower, more capable model than the invoice
          // scanner and the server holds a 110s ceiling on that call — keep
          // this above it (matches the web client's 120s scan timeout).
          timeout: 120_000,
        })
        .then((r) => toScanSummary(r.data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["supplier-statements"] }),
  });
}
