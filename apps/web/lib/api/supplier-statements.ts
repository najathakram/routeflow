import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { StatementAiError, StatementAiErrorCode } from "@routeflow/types";
export type { StatementAiError, StatementAiErrorCode } from "@routeflow/types";

// ─── Types ────────────────────────────────────────────────────────────────────
// PR-F WP4 — the web client for the AI supplier-statement reconciliation
// pipeline. Reconciled directly against WP1/WP2's actual, already-landed
// implementation (`apps/api/src/supplier-statements/*`) rather than guessed
// from the plan alone — see the field-by-field notes below wherever the two
// diverge.
//
// `POST /supplier-statements/:id/apply` is registered by
// `SupplierStatementsController` and backed by `StatementApplyService`; the
// body is validated by `ApplyStatementBodyDto`, so the shapes below are the
// real contract, not a hoped-for one.

export type SupplierStatementScanStatus = "SCANNED" | "APPLIED" | "DISCARDED";

export type StatementLineKind = "INVOICE" | "PAYMENT" | "CREDIT" | "ADJUSTMENT";

/** One line as the model read it off the statement. */
export interface ParsedStatementLine {
  date: string | null;
  kind: StatementLineKind;
  refNumber: string | null;
  amount: number;
  runningBalance: number | null;
}

export type MatchTier = "EXACT_REF" | "FUZZY" | "UNMATCHED";

export interface StatementMatchCandidate {
  billId: string;
  billNumber: string;
  /** The bill's own stated total (`totalOwed`) — for side-by-side display
   *  only. `statement-matcher.ts`'s wire shape does NOT carry `totalPaid`, so
   *  this is NOT necessarily what's still outstanding on a partially-paid
   *  bill; the review screen cross-references `useVendorBills` for the real
   *  `totalOwed − totalPaid` wherever it can (see `StatementReviewGrid`). The
   *  apply transaction re-derives and enforces the true outstanding balance
   *  server-side regardless of what this client shows or sends. */
  total: number;
  date: string | null;
}

/**
 * Mirrors `statement-matcher.ts`'s `StatementLineMatch` exactly — note there
 * is no `lineIndex` field on the wire type. `matches[i]` corresponds to
 * `lines[i]` (same order, same length, one entry per parsed line) — callers
 * key rows by the array index, not a field on the match itself.
 */
export interface StatementLineMatch {
  line: ParsedStatementLine;
  tier: MatchTier;
  billId: string | null;
  candidates: StatementMatchCandidate[];
  /** Only an EXACT_REF match whose amount also agrees arrives pre-checked.
   *  Always false across the board when the closing-balance sanity guard
   *  tripped (see `computeLinesAgree` in `StatementReviewGrid`, which
   *  replicates that guard client-side for the warning banner — the API
   *  applies it to `preChecked` but doesn't surface the boolean itself). */
  preChecked: boolean;
}

/** One `BillPayment` an apply wrote, read back off the scan's payment group. */
export interface AppliedStatementPaymentRow {
  id: string;
  /** Null only if the bill was deleted out from under the payment. */
  billId: string | null;
  billNumber: string | null;
  amount: number;
  /** Written by the implied-paid panel rather than a confirmed statement line. */
  impliedPaid: boolean;
  paidAt: string | null;
}

/**
 * The scan's read model, reconciled field-for-field against
 * `SupplierStatementsService.scanStatement` / `getScan` (via
 * `rematchStoredScan`). The two server code paths return DIFFERENT subsets:
 * a brand-new scan (never seen before) has no `status`/`fileName`/`fileUrl`/
 * `createdAt`/`appliedAt`/`appliedPaymentGroupId` at all — only a re-fetch
 * (same fileHash re-upload, or a plain `GET /:id`) rematches the stored row
 * and includes them. Every field below is typed to match, so a fresh-scan
 * response is honestly `undefined` rather than silently wrong.
 */
export interface StatementScanResult {
  /** Null when the row failed to persist (still a valid read — WP2 returns
   *  the extraction anyway — but there is nothing to revisit or apply). */
  scanId: string | null;
  status?: SupplierStatementScanStatus | null;
  fileName?: string | null;
  fileUrl?: string | null;
  /** Raw supplier name exactly as the model read it. */
  supplier: string | null;
  /** Server-resolved supplier id (tenant-scoped name match), or null if it
   *  couldn't be resolved — matching against local bills is then impossible
   *  (every line comes back UNMATCHED, which is the honest answer). */
  supplierId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  lines: ParsedStatementLine[];
  matches: StatementLineMatch[];
  notes: string | null;
  createdAt?: string | null;
  appliedAt?: string | null;
  appliedPaymentGroupId?: string | null;
  /** Everything the apply wrote, so a scan re-opened later still shows its
   *  breakdown rather than a bare date. Only a re-fetch carries it (a
   *  brand-new scan has no apply behind it), and it is empty until applied. */
  appliedPayments?: AppliedStatementPaymentRow[];
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

/**
 * Upload (or re-upload) a supplier statement — one PDF, or the photographed
 * pages of one statement as multiple image files (server combines them into
 * one read). A document already on file (same fileHash) comes back instantly
 * rematched against the CURRENT bills — no second AI call. Field name MUST be
 * `files` — multer matches it exactly (`FilesInterceptor("files", 10, ...)`
 * in `supplier-statements.controller.ts`).
 */
export async function scanStatement(
  files: File | File[],
  signal?: AbortSignal,
): Promise<StatementScanResult> {
  const formData = new FormData();
  const arr = Array.isArray(files) ? files : [files];
  for (const f of arr) formData.append("files", f, f.name);
  const response = await apiClient.post("/supplier-statements/scan", formData, {
    headers: { "Content-Type": "multipart/form-data" },
    // The model call itself is capped server-side at 110s (maxRetries: 0) —
    // this just needs to outlive that.
    timeout: 120_000,
    signal,
  });
  return response.data as StatementScanResult;
}

export function useSupplierStatementScan(scanId: string | null) {
  return useQuery<StatementScanResult>({
    queryKey: ["supplier-statements", scanId],
    queryFn: () => apiClient.get(`/supplier-statements/${scanId}`).then((r) => r.data),
    enabled: !!scanId,
  });
}

// ─── Apply ──────────────────────────────────────────────────────────────────

export interface ConfirmedStatementMatch {
  billId: string;
  amount: number;
  /** Index into `matches` / `lines` of the row this bill was picked on. The
   *  candidate picker lets the operator choose ANY candidate of a line, not
   *  just the matcher's suggestion, so the server needs the line to cap the
   *  amount against — without it a hand-picked non-suggested candidate is
   *  rejected and the whole apply fails. */
  lineIndex: number;
}

export interface ApplyStatementDto {
  confirmed: ConfirmedStatementMatch[];
  /** SEPARATE from `confirmed`, by design — only ever populated once the
   *  operator has been through the implied-paid panel's own second
   *  confirmation. Never folded into the main Apply silently. */
  impliedPaid?: { billIds: string[] };
  notes?: string;
}

/** Mirrors `StatementApplyService`'s `ApplyStatementResult` field for field —
 *  it does NOT echo back a bill number, so the review screen still builds its
 *  post-apply summary from what the operator confirmed client-side. */
export interface ApplyStatementResult {
  paymentGroupId: string | null;
  /** True when this scan was already APPLIED and nothing new was written —
   *  the idempotent replay path (`payments`/`bills` come back empty). */
  alreadyApplied: boolean;
  payments: { id: string; vendorBillId: string; amount: number }[];
  /** Overpayment banked as on-account `SupplierCredit`. **Always 0 on this
   *  flow** — the apply carries no cash total to overshoot and every amount is
   *  capped at the bill's outstanding balance, so a surplus is impossible.
   *  Kept only so the shape matches `recordSupplierPayment`'s. */
  excess: number;
  bills: { id: string; status: string; totalPaid: number }[];
}

/**
 * Apply a scan's confirmed matches (and, separately, its confirmed
 * implied-paid list). ONE transaction, idempotent — calling this again on an
 * already-APPLIED scan changes nothing and just returns the stored result,
 * so a double-click (or a re-open of an applied scan) can never write twice.
 */
export function useApplyStatement(scanId: string) {
  const qc = useQueryClient();
  return useMutation<ApplyStatementResult, Error, ApplyStatementDto>({
    mutationFn: (dto) =>
      apiClient.post(`/supplier-statements/${scanId}/apply`, dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["supplier-statements"] });
      qc.invalidateQueries({ queryKey: ["vendor-bills"] });
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      qc.invalidateQueries({ queryKey: ["finance-dashboard"] });
    },
  });
}

// ─── Typed AI error contract ────────────────────────────────────────────────
// Reproduced verbatim from `SupplierStatementsService.scanStatement`'s own
// catch/parse branches (it duplicates, rather than imports, the invoice
// scanner's contract — the four codes and their conditions are identical).

const KNOWN_CODES: StatementAiErrorCode[] = [
  "AI_KEY_INVALID",
  "AI_SCAN_REJECTED",
  "AI_UNAVAILABLE",
  "AI_PARSE_FAILED",
];

/** Read the typed AI error off a failed scan request. `code: null` covers
 *  both the no-key case (a plain `BadRequestException`, no `code` at all)
 *  and anything genuinely unexpected — callers must still have a fallback
 *  branch for it, never assume one of the four. */
export function getStatementAiError(error: unknown): StatementAiError {
  const data = (error as { response?: { data?: { code?: string; message?: string } } })?.response
    ?.data;
  const code = data?.code as StatementAiErrorCode | undefined;
  return {
    code: code && KNOWN_CODES.includes(code) ? code : null,
    message: data?.message || "Failed to scan the statement.",
  };
}
