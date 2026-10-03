import type { AuditService } from "../audit/audit.service";

/**
 * B1018 / SA-642: a change to a customer's credit limit (set, change, clear to null, or to a real $0) leaves one audit row with
 * the old and new figure (numbers only). An omitted field (`undefined`) or an unchanged value writes nothing. The global
 * interceptor's generic "PATCH /customers/:id" row never carried the values.
 */
export async function recordCreditLimitChange(
  audit: AuditService | undefined,
  tenantId: string | null | undefined,
  customerId: string,
  before: unknown,
  next: number | null | undefined,
  actor?: { sub?: string | null; impersonatedBy?: string | null },
): Promise<void> {
  if (next === undefined || !audit) return;
  const from = before == null ? null : Number(before);
  if (from === next) return;
  await audit.log({
    tenantId: tenantId ?? null,
    userId: actor?.sub ?? null,
    impersonatedBy: actor?.impersonatedBy ?? null,
    action: "CUSTOMER_CREDIT_LIMIT_CHANGED",
    entityType: "customer",
    entityId: customerId,
    meta: { from, to: next },
  });
}
