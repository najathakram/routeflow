import type { OnboardingStage, OnboardingStepOwner } from "@routeflow/types";

/**
 * The onboarding step catalog (#2159 S1) — the playbook's per-client checklist
 * (docs/runbooks/wholesaler-onboarding.md, Appendix D) as data, one entry per line.
 *
 * Rows are COPIED into `OnboardingStep` when a case is created and stamped with
 * `CATALOG_VERSION`; a later change here never rewrites an in-flight case. Bump
 * `CATALOG_VERSION` whenever a key is added, and never rename or remove a key a case
 * may hold — "adopt catalog" adds new keys as PENDING and never deletes rows.
 *
 * `required` steps gate the advance out of their stage (DONE or WAIVED); optional
 * steps are the playbook's "(if any)" / "(if needed)" / "(if bought)" lines. Each
 * stage's `**GATE**` line is the advance action itself, not a step. `autoCheck` names
 * a checker in onboarding-auto-checks.ts; its result is advisory (shown beside the
 * step) and never changes a step's status by itself.
 */
export const CATALOG_VERSION = 1;

/**
 * The customer's written sign-off (VERIFY_TRAIN). The tenant-side sign-off (S4) marks exactly
 * this step; pinned equal to `ONBOARDING_SIGN_OFF_STEP_KEY` in @routeflow/types.
 */
export const SIGN_OFF_STEP_KEY = "verify.signOff";

export const STAGE_ORDER: readonly OnboardingStage[] = [
  "FOLLOW_UP",
  "AGREE",
  "ACTIVATE",
  "COLLECT",
  "CONFIGURE",
  "VERIFY_TRAIN",
  "GO_LIVE",
  "HYPERCARE",
];

export const AUTO_CHECK_KEYS = [
  "workspace.created",
  "payment.recorded",
  "tenant.active",
  "profile.complete",
  "email.connected",
  "numbering.set",
  "catalog.productsPriced",
  "catalog.skuUnique",
  "customers.geocoded",
  "customers.exemptCertificates",
  "customers.licencesValid",
  "admin.signedIn",
  "drivers.signedIn",
  "golive.firstCycle",
] as const;
export type AutoCheckKey = (typeof AUTO_CHECK_KEYS)[number];

export interface CatalogStep {
  key: string;
  stage: OnboardingStage;
  title: string;
  owner: OnboardingStepOwner;
  required: boolean;
  autoCheck?: AutoCheckKey;
  evidenceHint: string;
}

const RF = "ROUTEFLOW" as const;
const CU = "CUSTOMER" as const;

export const STEPS: readonly CatalogStep[] = [
  // ── 1 Follow-up (≤ 1 business day) ──
  {
    key: "followup.fitNotes",
    stage: "FOLLOW_UP",
    title: "Fit notes recorded",
    owner: RF,
    required: true,
    evidenceHint: "Segment, size, current systems, regulated goods, must-haves, decision maker",
  },
  {
    key: "followup.package",
    stage: "FOLLOW_UP",
    title: "Package chosen from Plans & Pricing; setup fee set by the owner",
    owner: RF,
    required: true,
    evidenceHint: "Plan, add-ons, cycle and setup fee in the deal terms",
  },
  {
    key: "followup.routesAddon",
    stage: "FOLLOW_UP",
    title: "Routes add-on included (if they deliver on routes)",
    owner: RF,
    required: false,
    evidenceHint: "Recurring routes or Ad hoc order delivery in the package",
  },
  {
    key: "followup.recapSent",
    stage: "FOLLOW_UP",
    title: "B1 recap sent",
    owner: RF,
    required: true,
    evidenceHint: "Date sent",
  },
  {
    key: "followup.decision",
    stage: "FOLLOW_UP",
    title: "Decision: Go",
    owner: CU,
    required: true,
    evidenceHint: "Go, or put the case on hold / mark it lost with the reason",
  },

  // ── 2 Agree ──
  {
    key: "agree.summarySent",
    stage: "AGREE",
    title: "B2 order summary + questionnaire sent",
    owner: RF,
    required: true,
    evidenceHint: "Date sent",
  },
  {
    key: "agree.acceptanceSaved",
    stage: "AGREE",
    title: "Written acceptance saved",
    owner: CU,
    required: true,
    evidenceHint: "Acceptance date and the Terms version (Last updated)",
  },
  {
    key: "agree.sectionB",
    stage: "AGREE",
    title: "Section B received and checked (business name spelling, slug rules, admin email)",
    owner: CU,
    required: true,
    evidenceHint: "Checked by, date",
  },
  {
    key: "agree.reminders",
    stage: "AGREE",
    title: "Reminders day 3 / day 7 (if needed)",
    owner: RF,
    required: false,
    evidenceHint: "Dates sent",
  },

  // ── 3 Activate ──
  {
    key: "activate.headsUp",
    stage: "ACTIVATE",
    title: "B3 heads-up sent",
    owner: RF,
    required: true,
    evidenceHint: "Date sent",
  },
  {
    key: "activate.workspaceCreated",
    stage: "ACTIVATE",
    title: "Workspace created (password left blank)",
    owner: RF,
    required: true,
    autoCheck: "workspace.created",
    evidenceHint: "Workspace slug",
  },
  {
    key: "activate.paid",
    stage: "ACTIVATE",
    title: "Paid: card (Stripe) or bank",
    owner: CU,
    required: true,
    autoCheck: "payment.recorded",
    evidenceHint: "Stripe receipt or bank/Zelle/check reference",
  },
  {
    key: "activate.setupFee",
    stage: "ACTIVATE",
    title: "Setup fee recorded",
    owner: RF,
    required: true,
    evidenceHint: "Receipt or reference",
  },
  {
    key: "activate.active",
    stage: "ACTIVATE",
    title: "Overview shows ACTIVE (before the trial end)",
    owner: RF,
    required: true,
    autoCheck: "tenant.active",
    evidenceHint: "Date seen",
  },

  // ── 4 Collect & review ──
  {
    key: "collect.sections",
    stage: "COLLECT",
    title: "Sections C, D, E, F, G, H received",
    owner: CU,
    required: true,
    evidenceHint: "Date received",
  },
  {
    key: "collect.files",
    stage: "COLLECT",
    title:
      "Files received: products, customers, suppliers, stock, AR aging, open docs, certificates, photos",
    owner: CU,
    required: true,
    evidenceHint: "Which files, date received",
  },
  {
    key: "collect.sectionsApproved",
    stage: "COLLECT",
    title: "Each section approved (or B5 sent back)",
    owner: RF,
    required: true,
    evidenceHint: "Reviewer, date",
  },
  {
    key: "collect.requiredList",
    stage: "COLLECT",
    title: "Required-for-this-client list decided",
    owner: RF,
    required: true,
    evidenceHint: "Which checks apply to this client",
  },

  // ── 5 Configure & load ──
  {
    key: "configure.settings",
    stage: "CONFIGURE",
    title: "Settings: profile, tax, logo, invoice text, deposits, costing",
    owner: RF,
    required: true,
    autoCheck: "profile.complete",
    evidenceHint: "Checked by, date",
  },
  {
    key: "configure.addons",
    stage: "CONFIGURE",
    title: "Add-ons match the order",
    owner: RF,
    required: true,
    evidenceHint: "Add-ons enabled",
  },
  {
    key: "configure.regulated",
    stage: "CONFIGURE",
    title: "Regulated goods + restrictions (if any)",
    owner: RF,
    required: false,
    evidenceHint: "Which categories and states",
  },
  {
    key: "configure.productsImported",
    stage: "CONFIGURE",
    title: "Products imported",
    owner: RF,
    required: true,
    evidenceHint: "File rows / imported / skipped (explained)",
  },
  {
    key: "configure.customersImported",
    stage: "CONFIGURE",
    title: "Customers imported",
    owner: RF,
    required: true,
    evidenceHint: "File rows / created / skipped",
  },
  {
    key: "configure.suppliers",
    stage: "CONFIGURE",
    title: "Suppliers added by hand",
    owner: RF,
    required: false,
    evidenceHint: "How many",
  },
  {
    key: "configure.stockImported",
    stage: "CONFIGURE",
    title: "Stock imported (no new products created)",
    owner: RF,
    required: true,
    evidenceHint: "Rows / matched",
  },
  {
    key: "configure.openInvoices",
    stage: "CONFIGURE",
    title: "Open invoices imported; unpaid total equals their aging total",
    owner: RF,
    required: true,
    evidenceHint: "Count, RouteFlow unpaid total, their aging total",
  },
  {
    key: "configure.productFields",
    stage: "CONFIGURE",
    title: "Hand-set product fields done (pack sizes, tiers, barcodes, costs, tobacco)",
    owner: RF,
    required: true,
    autoCheck: "catalog.productsPriced",
    evidenceHint: "Checked by, date",
  },
  {
    key: "configure.customerFields",
    stage: "CONFIGURE",
    title: "Hand-set customer fields done (terms, tiers, limits, exemptions, licences)",
    owner: RF,
    required: true,
    evidenceHint: "Checked by, date",
  },
  {
    key: "configure.routes",
    stage: "CONFIGURE",
    title: "Routes built (no default driver yet)",
    owner: RF,
    required: true,
    evidenceHint: "Routes built",
  },
  {
    key: "configure.qualityDuplicates",
    stage: "CONFIGURE",
    title: "Quality gate: duplicates 0",
    owner: RF,
    required: true,
    autoCheck: "catalog.skuUnique",
    evidenceHint: "Checked by, date",
  },
  {
    key: "configure.qualityGeocoded",
    stage: "CONFIGURE",
    title: "Quality gate: every customer placed on the map",
    owner: RF,
    required: true,
    autoCheck: "customers.geocoded",
    evidenceHint: "Checked by, date",
  },
  {
    key: "configure.qualityExempt",
    stage: "CONFIGURE",
    title: "Quality gate: no tax-exempt customer without a certificate",
    owner: RF,
    required: true,
    autoCheck: "customers.exemptCertificates",
    evidenceHint: "Checked by, date",
  },
  {
    key: "configure.qualityLicences",
    stage: "CONFIGURE",
    title: "Quality gate: expired licences flagged",
    owner: RF,
    required: true,
    autoCheck: "customers.licencesValid",
    evidenceHint: "Which customers, and what was agreed",
  },
  {
    key: "configure.qualityCredit",
    stage: "CONFIGURE",
    title: "Quality gate: over-limit customers agreed",
    owner: RF,
    required: true,
    evidenceHint: "Which customers, and what was agreed",
  },
  {
    key: "configure.qualityStock",
    stage: "CONFIGURE",
    title: "Quality gate: stock spot-check 10/10",
    owner: RF,
    required: true,
    evidenceHint: "Checked by, date",
  },

  // ── 6 Verify & train ──
  {
    key: "verify.adminSignedIn",
    stage: "VERIFY_TRAIN",
    title: "B6 sent; admin signed in",
    owner: CU,
    required: true,
    autoCheck: "admin.signedIn",
    evidenceHint: "Date",
  },
  {
    key: "verify.officeLogins",
    stage: "VERIFY_TRAIN",
    title: "Office logins created (Add User — never for drivers)",
    owner: CU,
    required: true,
    evidenceHint: "How many",
  },
  {
    key: "verify.emailConnected",
    stage: "VERIFY_TRAIN",
    title: "Email connected + test sent",
    owner: CU,
    required: true,
    autoCheck: "email.connected",
    evidenceHint: "Test sent to, date",
  },
  {
    key: "verify.howToPay",
    stage: "VERIFY_TRAIN",
    title: '"How to pay" entered by them',
    owner: CU,
    required: true,
    evidenceHint: "Checked by, date",
  },
  {
    key: "verify.officeTraining",
    stage: "VERIFY_TRAIN",
    title: "Office training held (fix list closed)",
    owner: RF,
    required: true,
    evidenceHint: "Date, attendees",
  },
  {
    key: "verify.practice",
    stage: "VERIFY_TRAIN",
    title: "Practice on the demo workspace",
    owner: CU,
    required: false,
    evidenceHint: "Date",
  },
  {
    key: "verify.drivers",
    stage: "VERIFY_TRAIN",
    title: "Drivers created (Drivers → New Driver) and signed in",
    owner: CU,
    required: true,
    autoCheck: "drivers.signedIn",
    evidenceHint: "Signed in / total",
  },
  {
    key: "verify.routeDrivers",
    stage: "VERIFY_TRAIN",
    title: "Routes' default drivers set",
    owner: CU,
    required: true,
    evidenceHint: "Checked by, date",
  },
  {
    key: "verify.invoicePdf",
    stage: "VERIFY_TRAIN",
    title: "Imported invoice PDF checked (logo, terms, How to pay) — no test invoice created",
    owner: RF,
    required: true,
    evidenceHint: "Invoice checked",
  },
  {
    key: "verify.cutoverAgreed",
    stage: "VERIFY_TRAIN",
    title: "Cutover date agreed; rollback rule agreed",
    owner: CU,
    required: true,
    evidenceHint: "Cutover date",
  },
  {
    key: "verify.signOff",
    stage: "VERIFY_TRAIN",
    title: "Written sign-off saved",
    owner: CU,
    required: true,
    evidenceHint: "Sign-off date",
  },

  // ── 7 Go-live ──
  {
    key: "golive.retailerNotice",
    stage: "GO_LIVE",
    title: "B7 retailer notice sent",
    owner: CU,
    required: true,
    evidenceHint: "Date sent",
  },
  {
    key: "golive.finalStock",
    stage: "GO_LIVE",
    title: "Final stock count imported",
    owner: RF,
    required: true,
    evidenceHint: "Rows / matched",
  },
  {
    key: "golive.deltas",
    stage: "GO_LIVE",
    title: "Delta invoices/payments imported",
    owner: RF,
    required: true,
    evidenceHint: "Counts",
  },
  {
    key: "golive.openDocs",
    stage: "GO_LIVE",
    title: "Open orders/quotes/credits decided",
    owner: RF,
    required: true,
    evidenceHint: "What was decided",
  },
  {
    key: "golive.numbering",
    stage: "GO_LIVE",
    title: "Told them: new invoices start at INV-<year>-0001",
    owner: RF,
    required: true,
    autoCheck: "numbering.set",
    evidenceHint: "Date told (continuing the old sequence waits on B861)",
  },
  {
    key: "golive.oldFrozen",
    stage: "GO_LIVE",
    title: "Old system frozen (their confirmation)",
    owner: CU,
    required: true,
    evidenceHint: "Confirmation date",
  },
  {
    key: "golive.firstCycle",
    stage: "GO_LIVE",
    title: "First cycle: order → delivery → invoice sent → payment recorded",
    owner: CU,
    required: true,
    autoCheck: "golive.firstCycle",
    evidenceHint: "Invoice number",
  },

  // ── 8 Hypercare & close ──
  {
    key: "hypercare.checkins",
    stage: "HYPERCARE",
    title: "Check-ins days 1–3, then Tue/Thu to day 14",
    owner: RF,
    required: true,
    evidenceHint: "Dates",
  },
  {
    key: "hypercare.issuesClear",
    stage: "HYPERCARE",
    title: "Issue list clear of blockers",
    owner: RF,
    required: true,
    evidenceHint: "Checked by, date",
  },
  {
    key: "hypercare.buyerPortal",
    stage: "HYPERCARE",
    title: "Buyer-portal invites (if bought), week 2",
    owner: CU,
    required: false,
    evidenceHint: "Date sent",
  },
  {
    key: "hypercare.renewal",
    stage: "HYPERCARE",
    title: "Renewal: card auto, or manual reminder set",
    owner: RF,
    required: true,
    evidenceHint: "Card, or the reminder date",
  },
  {
    key: "hypercare.rawFilesDeleted",
    stage: "HYPERCARE",
    title: "Raw files deleted (day 30)",
    owner: RF,
    required: true,
    evidenceHint: "Date deleted",
  },
  {
    key: "hypercare.review",
    stage: "HYPERCARE",
    title: "B8 30-day review held",
    owner: RF,
    required: true,
    evidenceHint: "Date",
  },
  {
    key: "hypercare.hours",
    stage: "HYPERCARE",
    title: "Hours per stage recorded",
    owner: RF,
    required: false,
    evidenceHint: "Hours for stages 1–8",
  },
];

const STEP_BY_KEY = new Map(STEPS.map((s) => [s.key, s]));

export function catalogStep(key: string): CatalogStep | undefined {
  return STEP_BY_KEY.get(key);
}

export function stageIndex(stage: OnboardingStage): number {
  return STAGE_ORDER.indexOf(stage);
}

/** The stage after `stage`, or null for the last one (HYPERCARE → LIVE). */
export function nextStage(stage: OnboardingStage): OnboardingStage | null {
  const i = stageIndex(stage);
  return i >= 0 && i < STAGE_ORDER.length - 1 ? STAGE_ORDER[i + 1] : null;
}

export interface GateStep {
  key: string;
  stage: OnboardingStage;
  title: string;
  required: boolean;
  status: "PENDING" | "DONE" | "WAIVED";
}

/**
 * The advance gate: the REQUIRED steps of `stage` that are still PENDING. An empty list
 * means the case may advance out of `stage`. Optional steps never block.
 */
export function gateBlockers(
  steps: readonly GateStep[],
  stage: OnboardingStage,
): { key: string; title: string }[] {
  return steps
    .filter((s) => s.stage === stage && s.required && s.status === "PENDING")
    .map((s) => ({ key: s.key, title: s.title }));
}
