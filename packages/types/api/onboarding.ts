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
  code: "ONBOARDING_GATE_BLOCKED";
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
  status: "CONFIRMED" | "CANCELLED" | "COMPLETED";
  meetUrl: string | null;
  createdAt: string;
  /** The onboarding case opened from this booking, if any. */
  onboardingCaseId: string | null;
}

/** Every 409 `code` the onboarding endpoints return — the web maps each to fixed copy. */
export const ONBOARDING_CONFLICT_CODES = [
  "ONBOARDING_GATE_BLOCKED",
  "ONBOARDING_CASE_NOT_OPEN",
  "ONBOARDING_CASE_CLOSED",
  "ONBOARDING_STEP_NOT_REACHED",
  "ONBOARDING_STEP_BEHIND_GATE",
  "ONBOARDING_STEP_WAIVED",
  "ONBOARDING_STEP_NOT_PENDING",
] as const;
export type OnboardingConflictCode = (typeof ONBOARDING_CONFLICT_CODES)[number];
