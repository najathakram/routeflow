import { AdminAuditAction } from "../platform-admin/audit-actions.constant";
import { CATCHUP_GO_LIVE, isAnchorFirst, type ActivationRecord } from "./catchup-plan";

/**
 * SA-733r11 + r12 (row 385): the AuditLog markers the catch-up reads. ONE query loads all of them
 * ({@link CATCHUP_MARKER_ACTIONS}), ONE function turns them into what the planner needs. History is append-only:
 * a correction is a NEW row, never an edit of the original activation marker.
 *
 *   TENANT_MANUAL_ACTIVATION_MARKER / TENANT_SUBSCRIPTION_ACTIVATED   the activation (marker + trail row)
 *   TENANT_MANUAL_ACTIVATION_COVERAGE_VOID    { voidsMarkerId, reason, actor, ownerApprovedAt }
 *   TENANT_MANUAL_ACTIVATION_COVERAGE_RESTORE { restoresMarkerId, reason, actor, ownerApprovedAt }
 *   TENANT_BILLING_START_OVERRIDE             { billingStart, reason, actor, ownerApprovedAt }
 *
 * Per activation marker the LATEST VOID / RESTORE wins (createdAt, then id: the greater id is the later row); a VOID
 * means its window is ignored, a RESTORE or no row means it counts. The latest billing-start override wins.
 */
export const CATCHUP_MARKER_ACTIONS = [
  AdminAuditAction.TENANT_MANUAL_ACTIVATION_MARKER,
  AdminAuditAction.TENANT_SUBSCRIPTION_ACTIVATED,
  AdminAuditAction.TENANT_MANUAL_ACTIVATION_COVERAGE_VOID,
  AdminAuditAction.TENANT_MANUAL_ACTIVATION_COVERAGE_RESTORE,
  AdminAuditAction.TENANT_BILLING_START_OVERRIDE,
] as const;

/** The columns the marker read selects (`id`: a VOID / RESTORE names an activation marker by its row id). */
export const CATCHUP_MARKER_SELECT = {
  id: true,
  action: true,
  createdAt: true,
  meta: true,
} as const;

export interface MarkerAuditRow {
  id?: string | null;
  action: string;
  createdAt: Date;
  meta: Record<string, unknown> | null;
}

export type BillingStartOverride =
  { ok: true; billingStart: Date } | { ok: false; error: string; raw: unknown };

export interface CatchupMarkers {
  /** Activation rows (marker + trail), each marker flagged `voided` when its latest correction is a VOID. */
  activations: ActivationRecord[];
  /** The latest billing-start override: null when none, `ok:false` when it is not a valid billing start. */
  billingStartOverride: BillingStartOverride | null;
}

const asDate = (v: unknown): Date | null =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : null;

/** createdAt, then id (the greater id is the later row) - ascending. */
const byTime = (a: MarkerAuditRow, b: MarkerAuditRow) =>
  a.createdAt.getTime() - b.createdAt.getTime() ||
  String(a.id ?? "").localeCompare(String(b.id ?? ""));

/**
 * A billing start must be an ANCHOR 1st at exactly 12:00Z (not the legacy 00:00Z spelling) and not before go-live
 * (Oct 1 12:00Z). Anything else is refused - never silently snapped.
 */
export function validateBillingStart(d: Date | null): BillingStartOverride {
  if (!d) return { ok: false, error: "billing_start_not_a_date", raw: null };
  if (!isAnchorFirst(d) || d.getUTCHours() !== 12) {
    return { ok: false, error: "billing_start_not_an_anchor_first", raw: d.toISOString() };
  }
  if (d.getTime() < CATCHUP_GO_LIVE.getTime()) {
    return { ok: false, error: "billing_start_before_go_live", raw: d.toISOString() };
  }
  return { ok: true, billingStart: d };
}

/** Which activation marker ids are voided right now: the latest VOID / RESTORE per marker id wins. */
export function voidedMarkerIds(rows: readonly MarkerAuditRow[]): Set<string> {
  const corrections = rows
    .filter(
      (r) =>
        r.action === AdminAuditAction.TENANT_MANUAL_ACTIVATION_COVERAGE_VOID ||
        r.action === AdminAuditAction.TENANT_MANUAL_ACTIVATION_COVERAGE_RESTORE,
    )
    .sort(byTime);
  const voided = new Set<string>();
  for (const r of corrections) {
    const isVoid = r.action === AdminAuditAction.TENANT_MANUAL_ACTIVATION_COVERAGE_VOID;
    const id = r.meta?.[isVoid ? "voidsMarkerId" : "restoresMarkerId"];
    if (typeof id !== "string" || !id) continue;
    if (isVoid) voided.add(id);
    else voided.delete(id);
  }
  return voided;
}

/** Turn the rows ONE query returned into the planner's inputs. */
export function readCatchupMarkers(rows: readonly MarkerAuditRow[]): CatchupMarkers {
  const voided = voidedMarkerIds(rows);
  const activations: ActivationRecord[] = rows
    .filter(
      (r) =>
        r.action === AdminAuditAction.TENANT_MANUAL_ACTIVATION_MARKER ||
        r.action === AdminAuditAction.TENANT_SUBSCRIPTION_ACTIVATED,
    )
    .map((r) => ({
      action: r.action,
      at: r.createdAt,
      ...(r.id ? { id: r.id } : {}),
      ...(r.id && r.action === AdminAuditAction.TENANT_MANUAL_ACTIVATION_MARKER && voided.has(r.id)
        ? { voided: true }
        : {}),
      periodStart: asDate(r.meta?.periodStart),
      periodEnd: asDate(r.meta?.periodEnd),
    }));
  const overrides = rows
    .filter((r) => r.action === AdminAuditAction.TENANT_BILLING_START_OVERRIDE)
    .sort(byTime);
  const latest = overrides[overrides.length - 1];
  return {
    activations,
    billingStartOverride: latest ? validateBillingStart(asDate(latest.meta?.billingStart)) : null,
  };
}
