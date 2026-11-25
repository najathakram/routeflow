// R-2 (SA-1297): the platform-admin "Record staff refund" and the billing-events list. Plain async functions over
// `superAdminClient`, like platform-catchup.ts. The server decides every figure (amount, currency, paid date, deadline);
// these only carry its JSON, and the web never computes or types a money value.
import { API_ERROR_CODES } from "@routeflow/types";
import { superAdminClient } from "@/lib/admin-api";

/** The latest yearly payment, as `GET .../staff-refunds/refundable` carries it. `amount` is the record's own string. */
export interface RefundablePayment {
  invoiceId: string;
  amount: string;
  currency: string;
  paidAt: string;
}

/** A staff refund already recorded for that payment. */
export interface ExistingStaffRefund {
  createdAt: string;
  providerRef: string | null;
  actorName: string | null;
  refundDate: string | null;
}

export interface RefundableView {
  payment: RefundablePayment | null;
  /** paidAt + 14 x 24h; null when there is no payment. */
  deadline: string | null;
  refusal:
    | null
    | typeof API_ERROR_CODES.STAFF_REFUND_NO_YEARLY_PAYMENT
    | typeof API_ERROR_CODES.STAFF_REFUND_ALREADY_RECORDED;
  existing: ExistingStaffRefund | null;
}

export interface StaffRefundBody {
  refundedInFull: true;
  cancelledImmediately: true;
  providerRef: string;
  /** YYYY-MM-DD, a UTC day. */
  refundDate: string;
  note?: string;
}

/** One row of `GET .../billing-events` (newest first). `label` is the server's; null for every unlabelled type. */
export interface BillingEventRow {
  id: string;
  type: string;
  label: string | null;
  createdAt: string;
  actorName: string | null;
  payload: Record<string, unknown> | null;
}

const base = (tenantId: string) => `/platform-admin/tenants/${tenantId}`;

/** The UTC calendar day (YYYY-MM-DD) of a timestamp. Dates here are always UTC days, never the browser's local day. */
export const utcDay = (d: Date | string): string => new Date(d).toISOString().slice(0, 10);

/** `GET .../staff-refunds/refundable`. A body with no `payment` key reads as "no yearly payment". */
export async function getRefundable(tenantId: string): Promise<RefundableView> {
  const res = await superAdminClient.get(`${base(tenantId)}/staff-refunds/refundable`);
  const d = (res?.data ?? {}) as Partial<RefundableView>;
  return {
    payment: d.payment ?? null,
    deadline: d.deadline ?? null,
    refusal: d.refusal ?? (d.payment ? null : API_ERROR_CODES.STAFF_REFUND_NO_YEARLY_PAYMENT),
    existing: d.existing ?? null,
  };
}

/** `POST .../staff-refunds`: records the refund. Refusals reject with the API's coded error. */
export async function recordStaffRefund(tenantId: string, body: StaffRefundBody): Promise<void> {
  await superAdminClient.post(`${base(tenantId)}/staff-refunds`, body);
}

/** `GET .../billing-events`. Anything but an array reads as an empty list. */
export async function listBillingEvents(tenantId: string): Promise<BillingEventRow[]> {
  const res = await superAdminClient.get(`${base(tenantId)}/billing-events`);
  return Array.isArray(res?.data) ? (res.data as BillingEventRow[]) : [];
}

// A recorded refund changes both the button's state and the list; the two live in different cards of the tab, so a
// tiny per-tenant listener set refreshes them without the page owning the state.
const listeners = new Map<string, Set<() => void>>();

/** Calls `fn` whenever billing events of `tenantId` changed. Returns the unsubscribe. */
export function onBillingEventsChanged(tenantId: string, fn: () => void): () => void {
  const set = listeners.get(tenantId) ?? new Set<() => void>();
  set.add(fn);
  listeners.set(tenantId, set);
  return () => {
    set.delete(fn);
  };
}

export function notifyBillingEventsChanged(tenantId: string): void {
  listeners.get(tenantId)?.forEach((fn) => fn());
}
