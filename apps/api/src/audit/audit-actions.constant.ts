/**
 * Tenant-level audit ACTION names written by the API's own services (platform-admin actions have their own
 * table in platform-admin/audit-actions.constant.ts). One named constant per action so a rename is one edit.
 *
 * The values are dotted lowercase, like the existing `counter-sale.price-edited`, and deliberately NOT the same
 * word as an API error code: api-error-codes-parity.spec.ts fails on a bare error-code literal anywhere else.
 */
export const AUDIT_ACTIONS = {
  /** SA-762r: a counter sale voided in one transaction; meta {orderId, reason, handBack, actor} feeds the replay. */
  COUNTER_SALE_VOIDED: "counter-sale.voided",
} as const;

export type AuditActionName = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
