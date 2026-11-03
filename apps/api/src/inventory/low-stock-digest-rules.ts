/**
 * N4 low-stock digest: the rules that decide WHICH products count and WHO gets the mail, in one place.
 * `LowStockDigestService` (the cron) and `low-stock-digest-report.ts` (the owner-run read-only report,
 * ops item 545) both read them here, so the report can never describe a rule the cron no longer follows.
 */
import type { Prisma, UserRole } from "@prisma/client";

/** The `UserPreference.key` a tenant admin's opt-out is stored under (N4). Missing row = enabled, same
 * convention as `notifications.service.ts`'s `pushEnabled` (B04). */
export const LOW_STOCK_DIGEST_PREF_KEY = "lowStockDigestEnabled";

/** Active TENANT_ADMINs and OPERATORs (owner 10-07 OK-6) get the digest. */
export const LOW_STOCK_DIGEST_ROLES: readonly UserRole[] = ["TENANT_ADMIN", "OPERATOR"];

/** `reorderPoint` unset (null) means the tenant never opted this product into alerting at all, not "always alert". */
export function lowStockProductWhere(tenantId: string): Prisma.ProductWhereInput {
  return { tenantId, isActive: true, reorderPoint: { not: null } };
}

/** Same predicate as `inventory.service.ts#getForecasting`'s `needsReorder` — one rule for "below threshold". */
export function isBelowReorderPoint(p: {
  currentStock: unknown;
  reorderPoint: number | null;
}): boolean {
  return p.reorderPoint != null && Number(p.currentStock) < p.reorderPoint;
}

/** Candidate recipients before the email and opt-out filters. */
export function digestRecipientWhere(tenantId: string): Prisma.UserWhereInput {
  return {
    tenantId,
    role: { in: [...LOW_STOCK_DIGEST_ROLES] },
    status: "ACTIVE",
    deletedAt: null,
  };
}

/** The opt-out rows of `userIds`: an explicit "false" under `LOW_STOCK_DIGEST_PREF_KEY`. */
export function digestOptOutWhere(userIds: string[]): Prisma.UserPreferenceWhereInput {
  return { userId: { in: userIds }, key: LOW_STOCK_DIGEST_PREF_KEY, value: "false" };
}

/**
 * Two admin ROWS can carry the same mailbox in different casing (a duplicate account, or an email edited to
 * differ only in case) — that mailbox gets exactly one digest, not one per row. Keeps the first row's address.
 */
export function dedupeMailboxes<T extends { email: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const key = r.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
