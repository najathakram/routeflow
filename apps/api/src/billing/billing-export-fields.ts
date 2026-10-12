/**
 * The tenant billing export (`GET /billing/export`) is a PROJECTION through explicit allowlists,
 * never a raw row dump (B1187, SA-718). Same philosophy as `common/staff-only-fields.ts`: a new
 * column on RfInvoice / BillingEvent, or a new key in an event payload, stays internal until it is
 * listed here.
 *
 * - Invoices: exactly the fields below (never pdfKey, tenantId, id, nor the admin-only manual-invoice
 *   columns: issuedById, paid{Method,Ref,Note,ById}, lastSentAt, sendCount, voidedAt, voidReason,
 *   periodKey, needsReview). `getExport` derives its Prisma `select` from this ONE list.
 * - Events: {type, createdAt, amountDelta, actor, payload}. `actorId` is REPLACED by a derived
 *   `actor` label and never exported as an id. `payload` keeps only the keys listed for that
 *   event type (scalar values only); a type with no entry exports an empty payload.
 */
import { BILLING_EVENTS } from "./plan-catalog.constants";

export const BILLING_EXPORT_INVOICE_FIELDS = [
  "number",
  "amount",
  "currency",
  "status",
  "cycle",
  "issuedAt",
  "dueDate",
  "periodStart",
  "periodEnd",
  "paidAt",
  "lines",
] as const;

/**
 * The keys of one entry of an invoice's `lines` that a tenant may see (RfInvoice.lines is Json, so a
 * future internal key on a line must not ride along). Same six keys as RfInvoiceLine.
 */
export const BILLING_EXPORT_LINE_FIELDS = [
  "kind",
  "code",
  "label",
  "quantity",
  "unitAmount",
  "amount",
] as const;

export function projectInvoiceLinesForExport(lines: unknown): Record<string, unknown>[] {
  if (!Array.isArray(lines)) return [];
  return lines
    .filter((l): l is Record<string, unknown> => !!l && typeof l === "object" && !Array.isArray(l))
    .map((l) => {
      const out: Record<string, unknown> = {};
      for (const k of BILLING_EXPORT_LINE_FIELDS) out[k] = l[k];
      return out;
    });
}

export type BillingExportActor = "you" | "RouteFlow support" | "system";

/**
 * Per-event-type payload keys a tenant may see about its own billing. Keyed by the BILLING_EVENTS
 * values; the emit-site inventory in billing-export-fields.spec.ts fails when a declared type has
 * no entry. Deliberately absent everywhere: source, stripeReason, stripeSynced, stripeStatus,
 * reason, platformAdmin, externalActivation, priceOverrideBackfill, retainedUserIds, sessionId,
 * billed, reconciled, applied-by internals.
 */
export const BILLING_EVENT_PAYLOAD_FIELDS: Readonly<Record<string, readonly string[]>> = {
  [BILLING_EVENTS.PLAN_CHANGED]: [
    "fromPlan",
    "toPlan",
    "planKey",
    "cycle",
    "instant",
    "prorated",
    "scheduled",
    "applied",
    "oldMonthly",
    "newMonthly",
  ],
  [BILLING_EVENTS.PLAN_DOWNGRADE_SCHEDULED]: ["fromPlan", "toPlan", "effectiveAt"],
  // Literal keys: addon bookings route only through addon-ledger.ts (mrr-paying-predicate parity pin).
  "addon.enabled": ["sku", "quantity", "prorated"],
  "addon.disabled": ["sku", "quantity", "prorated"],
  [BILLING_EVENTS.SEAT_ADDED]: ["quantity"],
  [BILLING_EVENTS.SEAT_FREED]: ["quantity"],
  [BILLING_EVENTS.GRACE_STARTED]: [],
  [BILLING_EVENTS.GRACE_EXPIRED]: [],
  [BILLING_EVENTS.TRIAL_CONVERTED]: ["planKey"],
  [BILLING_EVENTS.TRIAL_EXPIRED]: ["at"],
  [BILLING_EVENTS.TRIAL_CANCELLED]: ["at"],
  [BILLING_EVENTS.SUBSCRIPTION_CANCELED]: ["fromStatus", "toStatus", "effectiveAt", "appliedAt"],
  [BILLING_EVENTS.SUBSCRIPTION_SUSPENDED]: ["fromStatus", "toStatus"],
  [BILLING_EVENTS.SUBSCRIPTION_RESUMED]: ["fromStatus", "toStatus"],
};

function isScalar(v: unknown): boolean {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

/**
 * Internal bookkeeping event types that are NOT tenant-facing billing history: they are excluded
 * from the export entirely (filtered in the Prisma `where`, so they never consume the row limit).
 * - tenant.class_changed: platform staff reclassifying a tenant (production/demo/...) so MRR scope
 *   moves; an internal ledger row, not a charge the tenant sees.
 * - reconciliation.snapshot_backfilled: a one-off ops script marker writing subscription snapshots.
 * Every declared BILLING_EVENTS type must be EITHER allowlisted above OR listed here (inventory spec).
 * Literal strings: the .mjs backfill re-types its own copy of the second one.
 */
export const EXPORT_EXCLUDED_EVENT_TYPES: readonly string[] = [
  "tenant.class_changed",
  "reconciliation.snapshot_backfilled",
  // SA-736r: MRR-only ledger rows booked when a coupon makes the next invoice $0 (or stops doing so).
  "coupon.unbilled",
  "coupon.billed",
];

export function projectInvoiceForExport(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of BILLING_EXPORT_INVOICE_FIELDS) out[k] = row[k];
  out.lines = projectInvoiceLinesForExport(row.lines);
  return out;
}

export function projectEventPayloadForExport(
  type: string,
  payload: unknown,
): Record<string, string | number | boolean | null> {
  const allowed = Object.prototype.hasOwnProperty.call(BILLING_EVENT_PAYLOAD_FIELDS, type)
    ? BILLING_EVENT_PAYLOAD_FIELDS[type]
    : [];
  const out: Record<string, string | number | boolean | null> = {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return out;
  const src = payload as Record<string, unknown>;
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(src, k) && isScalar(src[k])) {
      out[k] = src[k] as string | number | boolean | null;
    }
  }
  return out;
}

/**
 * Only a positively identified user of THIS tenant is "you"; any other actor id is staff.
 * The lookup is tenant-scoped and skips nothing silently: a hard-deleted user (the id no longer
 * resolves), another tenant's user and platform staff all fall to "RouteFlow support". That is the
 * safe default because the wrong label is never "you" (which would claim the tenant did something
 * it may not have), and no id or identity of the actor is revealed either way.
 */
export function deriveExportActor(
  actorId: string | null | undefined,
  user: { role: string; tenantId: string | null } | undefined,
  tenantId: string,
): BillingExportActor {
  if (!actorId) return "system";
  if (user && user.role !== "SUPER_ADMIN" && user.tenantId === tenantId) return "you";
  return "RouteFlow support";
}

export function projectBillingEventForExport(
  row: { type: string; payload: unknown; amountDelta: unknown; createdAt: unknown },
  actor: BillingExportActor,
) {
  return {
    type: row.type,
    createdAt: row.createdAt,
    amountDelta: row.amountDelta,
    actor,
    payload: projectEventPayloadForExport(row.type, row.payload),
  };
}

/** Subscription block (the settings-billing header's own tenant-facing fields). `addons` and `flags` are projected below. */
export const BILLING_EXPORT_SUBSCRIPTION_FIELDS = [
  "planKey",
  "flags",
  "paymentRequired",
  "planName",
  "status",
  "readOnlyReason",
  "cycle",
  "monthlyPrice",
  "annualPrice",
  "isCustom",
  "renewalAt",
  "cancelAtPeriodEnd",
  "downgradeToPlanKey",
  "downgradeEffectiveAt",
  "trialEndsAt",
  "addons",
] as const;

export const BILLING_EXPORT_SUBSCRIPTION_ADDON_FIELDS = [
  "sku",
  "name",
  "quantity",
  "comp",
  "monthly",
] as const;

export const BILLING_EXPORT_USAGE_FIELDS = [
  "meter",
  "used",
  "included",
  "remaining",
  "resetsAt",
] as const;

function pick(row: unknown, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!row || typeof row !== "object") return out;
  const src = row as Record<string, unknown>;
  for (const k of fields) if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  return out;
}

export function projectSubscriptionForExport(sub: unknown): Record<string, unknown> {
  const out = pick(sub, BILLING_EXPORT_SUBSCRIPTION_FIELDS);
  // Fail closed: a non-array addons/flags becomes [] rather than passing through unprojected.
  out.addons = Array.isArray(out.addons)
    ? out.addons.map((a) => pick(a, BILLING_EXPORT_SUBSCRIPTION_ADDON_FIELDS))
    : [];
  out.flags = Array.isArray(out.flags) ? out.flags.filter((f) => typeof f === "string") : [];
  return out;
}

export function projectUsageForExport(usage: unknown): Record<string, unknown>[] {
  return Array.isArray(usage) ? usage.map((u) => pick(u, BILLING_EXPORT_USAGE_FIELDS)) : [];
}
