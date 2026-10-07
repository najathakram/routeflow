/**
 * The tenant billing export (`GET /billing/export`) is a PROJECTION through explicit allowlists,
 * never a raw row dump (B1187, SA-718). Same philosophy as `common/staff-only-fields.ts`: a new
 * column on RfInvoice / BillingEvent, or a new key in an event payload, stays internal until it is
 * listed here.
 *
 * - Invoices: exactly the fields below (never pdfKey, tenantId, id).
 * - Events: {type, createdAt, amountDelta, actor, payload}. `actorId` is REPLACED by a derived
 *   `actor` label and never exported as an id. `payload` keeps only the keys listed for that
 *   event type (scalar values only); a type with no entry exports an empty payload.
 */
import { BILLING_EVENTS } from "./plan-catalog.constants";

export const BILLING_EXPORT_INVOICE_FIELDS = [
  "number",
  "amount",
  "status",
  "cycle",
  "issuedAt",
] as const;

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
  // Internal staff classification and a backfill marker: type/createdAt/amountDelta only.
  [BILLING_EVENTS.TENANT_CLASS_CHANGED]: [],
  [BILLING_EVENTS.RECONCILIATION_SNAPSHOT_BACKFILLED]: [],
};

function isScalar(v: unknown): boolean {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

export function projectInvoiceForExport(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of BILLING_EXPORT_INVOICE_FIELDS) out[k] = row[k];
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

/** Only a positively identified user of THIS tenant is "you"; any other actor id is staff. */
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
