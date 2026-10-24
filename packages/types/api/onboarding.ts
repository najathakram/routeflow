// ─── Wholesaler onboarding (#2159) — the shared contract ────────────────────────────────────
//
// Back-office onboarding cases (S1). The `*_VALUES` arrays mirror the Prisma enums in
// apps/api/prisma/schema/platform.prisma and are pinned set-equal to `@prisma/client` by
// apps/api/src/common/enum-parity.spec.ts. The request/response shapes below are the API
// contract the web back office (`admin/onboarding`) renders from — never redeclare them there.
//
// Routes (all `JwtAuthGuard` + `SuperAdminGuard`, prefix `/api/v1`):
//   GET    platform-admin/onboarding/cases?stage=&status=&ownerAdminId=&q=  → OnboardingCaseSummary[]
//   GET    platform-admin/onboarding/cases/counts                           → OnboardingStageCounts
//   POST   platform-admin/onboarding/cases                                  → OnboardingCaseDetail (201)
//   GET    platform-admin/onboarding/cases/:id                              → OnboardingCaseDetail
//   PATCH  platform-admin/onboarding/cases/:id                              → OnboardingCaseDetail
//   POST   platform-admin/onboarding/cases/:id/advance                      → OnboardingCaseDetail | 409 OnboardingGateBlocked
//   POST   platform-admin/onboarding/cases/:id/steps/:key/complete          → OnboardingCaseDetail
//   POST   platform-admin/onboarding/cases/:id/steps/:key/waive             → OnboardingCaseDetail
//   POST   platform-admin/onboarding/cases/:id/steps/:key/reopen            → OnboardingCaseDetail
//   POST   platform-admin/onboarding/cases/:id/auto-checks                  → OnboardingCaseDetail
//   POST   platform-admin/onboarding/cases/:id/adopt-catalog                → OnboardingCaseDetail
//   GET    platform-admin/demo-bookings?status=&from=&to=                   → DemoBookingListItem[]

import type { DemoBookingStatus } from "./enums";
import { API_ERROR_CODES } from "./error-codes";

export const ONBOARDING_STAGE_VALUES = [
  "FOLLOW_UP",
  "AGREE",
  "ACTIVATE",
  "COLLECT",
  "CONFIGURE",
  "VERIFY_TRAIN",
  "GO_LIVE",
  "HYPERCARE",
] as const;
export type OnboardingStage = (typeof ONBOARDING_STAGE_VALUES)[number];

export const ONBOARDING_CASE_STATUS_VALUES = ["OPEN", "ON_HOLD", "LIVE", "LOST"] as const;
export type OnboardingCaseStatus = (typeof ONBOARDING_CASE_STATUS_VALUES)[number];

export const ONBOARDING_STEP_STATUS_VALUES = ["PENDING", "DONE", "WAIVED"] as const;
export type OnboardingStepStatus = (typeof ONBOARDING_STEP_STATUS_VALUES)[number];

export const ONBOARDING_ACTOR_TYPE_VALUES = ["ADMIN", "CUSTOMER", "SYSTEM"] as const;
export type OnboardingActorType = (typeof ONBOARDING_ACTOR_TYPE_VALUES)[number];

/** Who does the step: us, or the wholesaler. Catalog metadata, not a Prisma enum. */
export const ONBOARDING_STEP_OWNER_VALUES = ["ROUTEFLOW", "CUSTOMER"] as const;
export type OnboardingStepOwner = (typeof ONBOARDING_STEP_OWNER_VALUES)[number];

/** Deal terms as agreed; S3b reads `setupFeeCents`. All fields optional. */
export interface OnboardingDealTerms {
  planKey?: string;
  addonSkus?: string[];
  interval?: "month" | "year";
  setupFeeCents?: number;
  note?: string;
}

export interface OnboardingAutoResult {
  ok: boolean;
  detail: string;
  /** ISO timestamp. */
  checkedAt: string;
}

export interface OnboardingStepView {
  id: string;
  key: string;
  stage: OnboardingStage;
  title: string;
  required: boolean;
  /** Catalog auto-check key, or null for a manual step. */
  autoCheck: string | null;
  /** From the current code catalog; null when the key is no longer in it. */
  owner: OnboardingStepOwner | null;
  evidenceHint: string | null;
  status: OnboardingStepStatus;
  autoResult: OnboardingAutoResult | null;
  evidence: Record<string, unknown> | null;
  doneById: string | null;
  doneAt: string | null;
  waivedReason: string | null;
  waivedById: string | null;
  waivedAt: string | null;
}

export interface OnboardingEventView {
  id: string;
  type: string;
  actorType: OnboardingActorType;
  actorId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface OnboardingGateBlocker {
  key: string;
  title: string;
}

export interface OnboardingCaseSummary {
  id: string;
  companyName: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  stage: OnboardingStage;
  status: OnboardingCaseStatus;
  tenantId: string | null;
  demoBookingId: string | null;
  ownerAdminId: string | null;
  /** YYYY-MM-DD. */
  targetGoLiveOn: string | null;
  stepCounts: { total: number; done: number; waived: number; pending: number };
  /** Required steps of the CURRENT stage still pending — the advance gate. */
  blockerCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OnboardingCaseDetail extends OnboardingCaseSummary {
  catalogVersion: number;
  /** The code catalog's version now; > catalogVersion means "adopt catalog" has new keys. */
  currentCatalogVersion: number;
  fitNotes: Record<string, unknown> | null;
  dealTerms: OnboardingDealTerms;
  cutoverAt: string | null;
  lostReason: string | null;
  closedAt: string | null;
  createdById: string;
  steps: OnboardingStepView[];
  blockers: OnboardingGateBlocker[];
  /** Newest first, at most 200. */
  events: OnboardingEventView[];
}

export type OnboardingStageCounts = Record<OnboardingStage, number> & {
  /** OPEN + ON_HOLD cases per stage are counted above; these are the closed totals. */
  LIVE_TOTAL: number;
  LOST_TOTAL: number;
};

/** 409 body when `advance` is refused. */
export interface OnboardingGateBlocked {
  statusCode: 409;
  code: typeof API_ERROR_CODES.ONBOARDING_GATE_BLOCKED;
  message: string;
  stage: OnboardingStage;
  blockers: OnboardingGateBlocker[];
}

/**
 * `companyName`/`contactName`/`contactEmail` are required unless `demoBookingId` is given —
 * then any that are omitted are filled from the booking (400 if one is still blank). A booking
 * opens at most one case (409 on a second).
 */
export interface CreateOnboardingCaseRequest {
  companyName?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  /** Opens the case from a demo booking (one case per booking). */
  demoBookingId?: string;
  ownerAdminId?: string;
  /** YYYY-MM-DD. */
  targetGoLiveOn?: string;
  fitNotes?: Record<string, unknown>;
  dealTerms?: OnboardingDealTerms;
}

/**
 * Partial update. `status` may move OPEN ↔ ON_HOLD, or to LOST (requires `lostReason`).
 * LIVE is reached only through `advance` from HYPERCARE; LIVE and LOST cases are read-only.
 */
export interface UpdateOnboardingCaseRequest {
  companyName?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string | null;
  ownerAdminId?: string | null;
  targetGoLiveOn?: string | null;
  cutoverAt?: string | null;
  fitNotes?: Record<string, unknown> | null;
  dealTerms?: OnboardingDealTerms;
  status?: "OPEN" | "ON_HOLD" | "LOST";
  lostReason?: string;
}

export interface CompleteOnboardingStepRequest {
  evidence?: Record<string, unknown>;
}

export interface WaiveOnboardingStepRequest {
  /** Required, non-blank — the waiver log's "why". */
  reason: string;
}

export interface DemoBookingListItem {
  id: string;
  name: string;
  email: string;
  company: string;
  phone: string | null;
  notes: string | null;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  status: DemoBookingStatus;
  meetUrl: string | null;
  createdAt: string;
  /** The onboarding case opened from this booking, if any. */
  onboardingCaseId: string | null;
}

/** Every 409 `code` the onboarding endpoints return — the web maps each to fixed copy. */
export const ONBOARDING_CONFLICT_CODES = [
  API_ERROR_CODES.ONBOARDING_GATE_BLOCKED,
  API_ERROR_CODES.ONBOARDING_CASE_NOT_OPEN,
  API_ERROR_CODES.ONBOARDING_CASE_CLOSED,
  API_ERROR_CODES.ONBOARDING_STEP_NOT_REACHED,
  API_ERROR_CODES.ONBOARDING_STEP_BEHIND_GATE,
  API_ERROR_CODES.ONBOARDING_STEP_WAIVED,
  API_ERROR_CODES.ONBOARDING_STEP_NOT_PENDING,
  API_ERROR_CODES.ONBOARDING_BOOKING_HAS_CASE,
] as const;
export type OnboardingConflictCode = (typeof ONBOARDING_CONFLICT_CODES)[number];

// ─── S2 — the secure intake link ────────────────────────────────────────────────────────────
//
// Public routes (no auth; the token travels ONLY in POST bodies — never a URL, L-188; every
// token failure is the same 404 "Link not found or expired."):
//   POST public/onboarding/session           { token }                          → IntakeSessionView
//   POST public/onboarding/sections/save     { token, key, answers }            → IntakeSessionView
//   POST public/onboarding/sections/submit   { token, key }                     → IntakeSessionView
//   POST public/onboarding/accept            { token, acceptedName, acceptedEmail, agree: true } → IntakeSessionView
//   POST public/onboarding/files             multipart: token, sectionKey, kind, file (≤ 25 MB; csv/xlsx/pdf/png/jpg) → IntakeSessionView
//   POST public/onboarding/files/delete      { token, fileId }                  → IntakeSessionView
// Back office (JwtAuthGuard + SuperAdminGuard):
//   POST platform-admin/onboarding/cases/:id/intake-link          { send?: boolean } → IssueIntakeLinkResponse (the URL is shown ONCE)
//   POST platform-admin/onboarding/cases/:id/intake-link/revoke                     → OnboardingIntakeAdminView
//   GET  platform-admin/onboarding/cases/:id/intake                                 → OnboardingIntakeAdminView
//   POST platform-admin/onboarding/cases/:id/sections/:key/review { action, note? } → OnboardingIntakeAdminView
//   POST platform-admin/onboarding/cases/:id/files                multipart: sectionKey, kind, file → OnboardingIntakeAdminView
//   GET  platform-admin/onboarding/cases/:id/files/:fileId/url                      → { url } (short-lived signed URL)

export const INTAKE_SECTION_KEY_VALUES = [
  "ACCOUNT",
  "TAX_COMPLIANCE",
  "INVOICING",
  "TEAM",
  "OPERATIONS",
  "DATA_FILES",
  "GO_LIVE_PREFS",
] as const;
export type IntakeSectionKey = (typeof INTAKE_SECTION_KEY_VALUES)[number];

export const INTAKE_SECTION_STATUS_VALUES = [
  "EMPTY",
  "DRAFT",
  "SUBMITTED",
  "CHANGES_REQUESTED",
  "APPROVED",
  "APPLIED",
  "WAIVED",
] as const;
export type IntakeSectionStatus = (typeof INTAKE_SECTION_STATUS_VALUES)[number];

/** File kinds (IntakeFile.kind). `containsPii` is derived server-side from the kind. */
export const INTAKE_FILE_KIND_VALUES = [
  "products",
  "customers",
  "suppliers",
  "stock",
  "ar_aging",
  "open_docs",
  "tax_cert",
  "licence",
  "logo",
  "other",
] as const;
export type IntakeFileKind = (typeof INTAKE_FILE_KIND_VALUES)[number];

export const INTAKE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const INTAKE_UPLOAD_EXTENSIONS = [".csv", ".xlsx", ".pdf", ".png", ".jpg", ".jpeg"] as const;

/** The one generic public error body (L-178): expired, revoked, unknown and forged all look alike. */
export const INTAKE_LINK_NOT_FOUND = "Link not found or expired." as const;

// Section answers — playbook Appendix A (sections B–H). No field ever carries a secret
// (password, bank/card number, API key): unknown fields are refused by the server.

export interface IntakeAccountAnswers {
  legalName: string;
  displayName?: string;
  /** 3–30 chars, lowercase letters/digits/hyphens, starts with a letter or digit, not reserved. */
  slug: string;
  ownerName: string;
  adminName: string;
  adminEmail: string;
  adminUsername?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  replyToEmail?: string;
  website?: string;
  /** IANA zone, e.g. America/Chicago. */
  timeZone: string;
}

export interface IntakeTaxComplianceAnswers {
  salesTaxRatePercent?: number;
  federalEin?: string;
  regulatedGoods: {
    category: "tobacco" | "vape" | "nicotine" | "alcohol" | "other";
    states: string[];
    note?: string;
  }[];
  licences: { name: string; number: string; state?: string; expiresOn?: string }[];
  statesSoldInto: string[];
  exciseNotes?: string;
  hasTaxExemptCustomers: boolean;
  retailLicenceNotes?: string;
}

export interface IntakeInvoicingAnswers {
  lastInvoiceNumber?: string;
  invoiceNumberFormat?: string;
  lastQuoteNumber?: string;
  lastCreditNoteNumber?: string;
  paymentTerms: "COD" | "NET_7" | "NET_15" | "NET_30" | "NET_45" | "NET_60" | "OTHER";
  paymentTermsOther?: string;
  invoiceFooterText?: string;
  takesDeposits: boolean;
  depositPercent?: number;
  paymentMethods: ("cash" | "check" | "ach" | "card" | "zelle" | "other")[];
  paymentMethodsOther?: string;
  wantsOnlineCardPay: boolean;
}

export interface IntakeTeamAnswers {
  staff: { name: string; email: string; role: "admin" | "office" }[];
  drivers: { name: string; mobile: string; email?: string }[];
  vehicleCount?: number;
  vehicleNames?: string[];
}

export interface IntakeOperationsAnswers {
  depotAddress: string;
  deliveryDays: ("MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN")[];
  deliveryAreas?: string;
  /** HH:MM, 24-hour. */
  orderCutoffTime?: string;
  hasTimeWindowCustomers: boolean;
  timeWindowNotes?: string;
  offersCustomerPickup: boolean;
}

export interface IntakeDataFilesAnswers {
  currentSystems: string;
  /** YYYY-MM-DD — the date the stock file was counted. */
  stockCountDate?: string;
  notes?: string;
}

export interface IntakeGoLivePrefsAnswers {
  /** YYYY-MM-DD. */
  earliestGoLiveDate?: string;
  trainingAttendees?: string;
  trainingAvailability?: string;
  notes?: string;
}

export interface IntakeSectionAnswersByKey {
  ACCOUNT: IntakeAccountAnswers;
  TAX_COMPLIANCE: IntakeTaxComplianceAnswers;
  INVOICING: IntakeInvoicingAnswers;
  TEAM: IntakeTeamAnswers;
  OPERATIONS: IntakeOperationsAnswers;
  DATA_FILES: IntakeDataFilesAnswers;
  GO_LIVE_PREFS: IntakeGoLivePrefsAnswers;
}

export interface IntakeSectionView {
  key: IntakeSectionKey;
  status: IntakeSectionStatus;
  schemaVersion: number;
  /** Draft answers may be partial; a SUBMITTED section passed full validation. */
  answers: Record<string, unknown>;
  reviewNote: string | null;
  submittedAt: string | null;
  /** The customer may save/submit only EMPTY, DRAFT or CHANGES_REQUESTED sections. */
  editable: boolean;
}

export interface IntakeFileView {
  id: string;
  sectionKey: IntakeSectionKey;
  kind: IntakeFileKind;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: "customer" | "admin";
  createdAt: string;
}

/** The frozen order, computed server-side from the case's deal terms + the LIVE catalog. */
export interface IntakeOrderSnapshot {
  planKey: string;
  planName: string;
  cycle: "MONTHLY" | "ANNUAL";
  isCustom: boolean;
  lines: {
    type: "plan" | "addon";
    key: string;
    name: string;
    quantity: number;
    monthly: number;
    cyclePrice: number;
    included: boolean;
  }[];
  /** Recurring charge for the cycle (dollars). */
  recurringDue: number;
  /** One-time setup fee (dollars; never MRR). */
  setupFee: number;
  setupFeeCents: number;
  /** recurringDue + setupFee. */
  dueToday: number;
  catalogVersion: number | null;
  currency: "USD";
  computedAt: string;
}

export interface OrderAcceptanceView {
  id: string;
  orderSnapshot: IntakeOrderSnapshot;
  termsVersion: string;
  privacyVersion: string;
  acceptedName: string;
  acceptedEmail: string;
  acceptedAt: string;
  supersededAt: string | null;
}

export interface IntakeSessionView {
  companyName: string;
  contactName: string;
  expiresAt: string;
  sections: IntakeSectionView[];
  files: IntakeFileView[];
  /** Live order preview; null (with `orderUnavailable`) when the deal terms can't be priced yet. */
  order: IntakeOrderSnapshot | null;
  orderUnavailable: boolean;
  terms: { termsVersion: string; privacyVersion: string };
  /** The current (non-superseded) acceptance, if any. */
  acceptance: OrderAcceptanceView | null;
}

export interface IntakeTokenRequest {
  token: string;
}
export interface SaveIntakeSectionRequest extends IntakeTokenRequest {
  key: IntakeSectionKey;
  answers: Record<string, unknown>;
}
export interface SubmitIntakeSectionRequest extends IntakeTokenRequest {
  key: IntakeSectionKey;
}
export interface AcceptIntakeOrderRequest extends IntakeTokenRequest {
  acceptedName: string;
  acceptedEmail: string;
  /** Must be true — the Terms/Privacy checkbox. */
  agree: true;
}
export interface DeleteIntakeFileRequest extends IntakeTokenRequest {
  fileId: string;
}

export interface IssueIntakeLinkResponse {
  /** `<WEB_URL>/onboarding#token=<token>` — shown once; only a hash is stored. */
  url: string;
  expiresAt: string;
  emailed: boolean;
}

export interface ReviewIntakeSectionRequest {
  action: "approve" | "request_changes" | "waive";
  /** Required for request_changes and waive. */
  note?: string;
}

export interface OnboardingIntakeAdminView {
  link: { active: boolean; expiresAt: string | null; lastUsedAt: string | null };
  sections: (IntakeSectionView & { reviewedById: string | null; reviewedAt: string | null })[];
  files: (IntakeFileView & { containsPii: boolean; sha256: string })[];
  acceptances: OrderAcceptanceView[];
}

/**
 * Non-token intake errors (token failures are always the one 404 above). 409s carry `code`;
 * INTAKE_ANSWERS_INVALID is a 400 with `errors: [{ field, messages[] }]`.
 */
export const INTAKE_ERROR_CODES = [
  API_ERROR_CODES.INTAKE_SECTION_LOCKED,
  API_ERROR_CODES.INTAKE_ORDER_NOT_READY,
  API_ERROR_CODES.INTAKE_SECTION_NOT_REVIEWABLE,
  API_ERROR_CODES.INTAKE_ANSWERS_INVALID,
] as const;
export type IntakeErrorCode = (typeof INTAKE_ERROR_CODES)[number];

// ─── Tenant side: "Getting started" (#2159 S4) ────────────────────────────────────

/** The catalog key of the customer's written sign-off (VERIFY_TRAIN). */
export const ONBOARDING_SIGN_OFF_STEP_KEY = "verify.signOff";

/**
 * One CUSTOMER-owned step as the workspace's own staff see it. Deliberately narrow: no
 * back-office evidence, waiver reasons or admin ids ever reach the tenant.
 */
export interface TenantOnboardingStep {
  key: string;
  stage: OnboardingStage;
  title: string;
  required: boolean;
  status: OnboardingStepStatus;
  /** ISO timestamp, when DONE. */
  doneAt: string | null;
  /** The latest advisory auto-check on the workspace's own data, if the step has one. */
  check: { ok: boolean; detail: string } | null;
}

export interface TenantOnboardingSignOff {
  status: OnboardingStepStatus;
  /** ISO timestamp, when signed. */
  signedAt: string | null;
  signedName: string | null;
  /** True only while the case is OPEN, at VERIFY_TRAIN, and the step is still PENDING. */
  available: boolean;
}

export interface TenantOnboardingView {
  stage: OnboardingStage;
  status: OnboardingCaseStatus;
  /** YYYY-MM-DD. */
  targetGoLiveOn: string | null;
  /** CUSTOMER-owned steps, in checklist order. */
  steps: TenantOnboardingStep[];
  signOff: TenantOnboardingSignOff | null;
}

/** `GET /onboarding/me` — `onboarding` is null when the workspace has no (visible) case. */
export interface TenantOnboardingResponse {
  onboarding: TenantOnboardingView | null;
}

/** `POST /onboarding/me/sign-off` (TENANT_ADMIN, never under impersonation). */
export interface OnboardingSignOffRequest {
  /** The signer's full name, typed. */
  signedName: string;
}

/** The only 409 code the tenant-side endpoints return. */
export const TENANT_ONBOARDING_CONFLICT_CODES = [
  API_ERROR_CODES.ONBOARDING_SIGN_OFF_NOT_AVAILABLE,
] as const;
export type TenantOnboardingConflictCode = (typeof TENANT_ONBOARDING_CONFLICT_CODES)[number];

/** Customer-facing stage names — web and mobile render the same words (#2159 S4). */
export const ONBOARDING_STAGE_CUSTOMER_LABEL: Record<OnboardingStage, string> = {
  FOLLOW_UP: "Getting in touch",
  AGREE: "Agreement",
  ACTIVATE: "Workspace activation",
  COLLECT: "Your information",
  CONFIGURE: "Setup",
  VERIFY_TRAIN: "Training & sign-off",
  GO_LIVE: "Go-live",
  HYPERCARE: "First weeks",
};

/** True only while onboarding is actually in progress (the banner/card are hidden otherwise). */
export function tenantOnboardingInProgress(o: TenantOnboardingView | null | undefined): boolean {
  return !!o && (o.status === "OPEN" || o.status === "ON_HOLD");
}

/** The one-line banner/card summary, or null when nothing should show. */
export function tenantOnboardingSummary(o: TenantOnboardingView | null | undefined): string | null {
  if (!o || !tenantOnboardingInProgress(o)) return null;
  if (o.status === "ON_HOLD") return "Onboarding is paused for now.";
  if (o.signOff?.available) return "Sign-off is open for your workspace admin.";
  const n = o.steps.filter((s) => s.stage === o.stage && s.status === "PENDING").length;
  return n > 0
    ? `${n} ${n === 1 ? "item needs" : "items need"} your team right now.`
    : "Nothing needed from you right now.";
}

/** Fixed copy for a failed sign-off — never the server's raw message. */
export function tenantOnboardingSignOffErrorCopy(err: unknown): string {
  const res = (err as { response?: { status?: number; data?: { code?: string } } } | null)
    ?.response;
  if (res?.data?.code === API_ERROR_CODES.ONBOARDING_SIGN_OFF_NOT_AVAILABLE) {
    return "Sign-off isn't open yet. Your onboarding lead will let you know when it is.";
  }
  if (res?.status === 403) {
    return "Only the workspace admin, signed in as themselves, can give the sign-off.";
  }
  if (res?.status === 400) return "Type your full name to sign off.";
  return "Couldn't record your sign-off. Please try again.";
}

// ─── Funnel metrics (#2159 S5) ────────────────────────────────────────────────────

export interface OnboardingFunnelStageDays {
  /** Cases (of the cohort) that have LEFT this stage. */
  cases: number;
  /** Median days spent in the stage, one decimal; null when no case has left it. */
  medianDays: number | null;
}

/**
 * `GET /platform-admin/onboarding/funnel?from=&to=` — the cohort is the cases OPENED in
 * [from, to); demos are the bookings created in the same window.
 */
export interface OnboardingFunnel {
  from: string;
  to: string;
  demosBooked: number;
  casesOpened: number;
  /** Cases with a current (non-superseded) order acceptance. */
  signed: number;
  /** Cases past the ACTIVATE gate (payment is one of its required steps), or LIVE. */
  paid: number;
  live: number;
  lost: number;
  stageDays: Record<OnboardingStage, OnboardingFunnelStageDays>;
}
