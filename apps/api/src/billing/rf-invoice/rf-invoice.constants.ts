/**
 * Manual invoices due: constants the API needs at RUNTIME. The API may not value-import
 * `@routeflow/types` (no-runtime-workspace-imports.spec.ts), so the shared arrays in
 * `packages/types/api/rf-invoices.ts` are mirrored here; `rf-invoice-constants-parity.spec.ts`
 * pins the two equal.
 */
import { AdminAuditAction } from "../../platform-admin/audit-actions.constant";
import { assertApprovedTestTenantSlug } from "../../common/tenant-class.util";

/** `RfInvoice.status` - a plain string column. The legacy FAILED is never written. */
export const RF_INVOICE_STATUS_VALUES = ["OPEN", "PAID", "VOID"] as const;
export type RfInvoiceStatus = (typeof RF_INVOICE_STATUS_VALUES)[number];

export const RF_INVOICE_VIEW_VALUES = [
  "overdue",
  "due_soon",
  "open",
  "paid",
  "void",
  "all",
] as const;

export const RF_INVOICE_LINE_KINDS = ["PLAN", "ADDON"] as const;
export type RfInvoiceLineKind = (typeof RF_INVOICE_LINE_KINDS)[number];

export interface RfInvoiceLine {
  kind: RfInvoiceLineKind;
  code: string;
  label: string;
  quantity: number;
  unitAmount: number;
  amount: number;
}

export const RF_INVOICE_AUDIT_ACTIONS = {
  ISSUED: AdminAuditAction.RF_INVOICE_ISSUED,
  NEEDS_PRICE: AdminAuditAction.RF_INVOICE_NEEDS_PRICE,
  STALE_PERIOD: AdminAuditAction.RF_INVOICE_STALE_PERIOD,
  IRREGULAR_PERIOD: AdminAuditAction.RF_INVOICE_IRREGULAR_PERIOD,
  SENT: AdminAuditAction.RF_INVOICE_SENT,
} as const;

/** What one send attempt resolved to (mirrored in packages/types; a plain string enum, not an error code). */
export const RF_INVOICE_SEND_OUTCOME_VALUES = [
  "sent",
  "cooldown",
  "not_open",
  "not_found",
  "no_recipients",
  "failed",
] as const;
export type RfInvoiceSendOutcome = (typeof RF_INVOICE_SEND_OUTCOME_VALUES)[number];

/** Why an invoice email went out: a super-admin resend, the issue email, or a d0 / d7 / d14 reminder. */
export const RF_INVOICE_SEND_TRIGGERS = ["manual", "issue", "d0", "d7", "d14"] as const;
export type RfInvoiceSendTrigger = (typeof RF_INVOICE_SEND_TRIGGERS)[number];

/** The reminder stages: days after the due date (UTC) on which each fires. Nothing fires after the last. */
export const RF_INVOICE_REMINDER_STAGES = [
  { trigger: "d0", days: 0 },
  { trigger: "d7", days: 7 },
  { trigger: "d14", days: 14 },
] as const;

/** A manual resend of one invoice is refused for this long after the previous send. */
export const RF_INVOICE_SEND_COOLDOWN_MS = 10 * 60 * 1000;
/** Most invoices one bulk resend accepts. */
export const RF_INVOICE_SEND_MAX_IDS = 50;

/**
 * The exact unique-index names a P2002 is matched against (`uniqueViolationOn(e, name, { exact: true })`,
 * SA M1). Prisma derives them as `<Model>_<fields>_key`; the migration creates them verbatim.
 */
export const RF_INVOICE_PERIOD_INDEX = "RfInvoice_tenantId_periodKey_key";
export const RF_INVOICE_NUMBER_INDEX = "RfInvoice_number_key";

/** RF_INVOICING_MODE: `off` (default) makes the cron do nothing at all; `silent` and `live` issue rows. */
export type RfInvoicingMode = "off" | "silent" | "live";
export function rfInvoicingMode(
  raw: string | undefined = process.env.RF_INVOICING_MODE,
): RfInvoicingMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "silent" || v === "live" ? v : "off";
}

/** Issue the next period this many days before it starts. */
export const RF_INVOICE_LEAD_DAYS = 7;

/** A subscription whose period ended more than this many days ago is stale (rollCycles lagging): never invoiced. */
export const RF_INVOICE_STALE_DAYS = 1;

/**
 * RF_INVOICE_TEST_TENANT_SLUGS: a comma list of approved TEST tenants (default none) that the platform-admin
 * queue treats as eligible for the list, the summary and issue-now even though they are not PRODUCTION. The
 * cron never reads it. Every slug must pass the test-tenant policy: a live tenant's slug throws.
 */
export function rfInvoiceTestTenantSlugs(
  raw: string | undefined = process.env.RF_INVOICE_TEST_TENANT_SLUGS,
): string[] {
  const slugs = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const slug of slugs) assertApprovedTestTenantSlug(slug, "RF_INVOICE_TEST_TENANT_SLUGS");
  return [...new Set(slugs)];
}

/**
 * Tenants the queue and the mailer act on: PRODUCTION and undeleted, plus any RF_INVOICE_TEST_TENANT_SLUGS
 * (approved test tenants, e.g. for an e2e run). With no allowlist this is exactly the PRODUCTION scope.
 */
export function rfInvoiceTenantScope(slugs: string[]): Record<string, unknown> {
  return slugs.length
    ? { deletedAt: null, OR: [{ class: "PRODUCTION" }, { slug: { in: slugs } }] }
    : { class: "PRODUCTION", deletedAt: null };
}
