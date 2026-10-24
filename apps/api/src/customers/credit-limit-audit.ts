import type { AuditService } from "../audit/audit.service";

/**
 * B1018 / SA-642: a change to a customer's credit limit (set, change, clear to null, or to a real $0) leaves one audit row with
 * the old and new figure (numbers only). An omitted field (`undefined`) or an unchanged value writes nothing. The global
 * interceptor's generic "PATCH /customers/:id" row never carried the values.
 */
export type CreditLimitActor = { sub?: string | null; impersonatedBy?: string | null };

export async function recordCreditLimitChange(
  audit: AuditService | undefined,
  tenantId: string | null | undefined,
  existing: { id: string; creditLimit?: unknown },
  dto: { creditLimit?: number | null },
  actor?: CreditLimitActor,
): Promise<void> {
  const next = dto.creditLimit;
  if (next === undefined || !audit) return;
  const before = existing.creditLimit;
  const customerId = existing.id;
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
