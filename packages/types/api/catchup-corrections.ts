/**
 * SA-1122 (i) / D14: the catch-up correction routes (super admin only). One server writer
 * (`CatchupCorrectionService`) appends the three correction markers; the screen and the CLI are clients.
 * Every amount is an integer number of cents the planner computed; no client prices anything.
 */

/** One activation marker and whether its window still counts as paid coverage. */
export type CatchupMarkerState = "counts" | "voided" | "restored";

export interface CatchupMarkerView {
  id: string;
  /** Always the activation marker action; the window is what the owner recognises. */
  action: string;
  periodStart: string | null;
  periodEnd: string | null;
  state: CatchupMarkerState;
}

/** What the catch-up comes to under one set of markers (ISO instants, integer cents). */
export interface CatchupPlanSummary {
  floor: string;
  paidThrough: string;
  /** The catch-up line's span. */
  from: string;
  to: string;
  stubCents: number;
  voidInvoiceIds: string[];
}

export interface CatchupCorrectionsView {
  tenantId: string;
  /** CATCHUP_MARKERS_VERSION: the marker semantics the server applies (a client built for another number refuses). */
  markersVersion: number;
  /** SESSION_OPEN / AWAITING_FIRST_PAYMENT / RELEASING while a payment link is held, else null. */
  claimState: string | null;
  markers: CatchupMarkerView[];
  billingStartOverride: { billingStart: string | null; valid: boolean } | null;
  /** Null when the catch-up cannot be planned (see `note`). */
  summary: CatchupPlanSummary | null;
  note: string | null;
}

/** The change a correction asks for. At least one of the three; a marker is never in both lists. */
export interface CatchupCorrectionRequest {
  voidCoverage?: string[];
  restoreCoverage?: string[];
  /** The 1st of a month (`YYYY-MM-DD`, read as 12:00Z) or that exact instant; not before go-live. */
  billingStart?: string;
}

export interface CatchupCorrectionApplyRequest extends CatchupCorrectionRequest {
  /** Trimmed, 10 to 500 characters. */
  reason: string;
  /** The BEFORE catch-up line the screen showed, in cents; null when the screen showed none. */
  expectedBefore: number | null;
  /** The tenant's name, typed back. Required for every tenant. */
  confirmTenantName: string;
}

export interface CatchupCorrectionPreview {
  tenantId: string;
  markersVersion: number;
  claimState: string | null;
  /** The activation markers with their state AFTER this change. */
  markers: (CatchupMarkerView & { stateBefore: CatchupMarkerState })[];
  before: CatchupPlanSummary | null;
  after: CatchupPlanSummary | null;
  notes: string[];
}

export interface CatchupCorrectionApplied {
  tenantId: string;
  /** The ids of the marker rows appended, in the order written. */
  appended: string[];
}

export const CATCHUP_REASON_MIN = 10;
export const CATCHUP_REASON_MAX = 500;
