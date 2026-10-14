import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { activeRuleWhere, ruleTargetSets } from "../selling-restrictions/selling-restrictions.core";

/**
 * Row 509 — the ONE seam every rule write shares (target add/remove, settings edit, lift). Two rules:
 *
 *  1. `lockEditableRule`: `SELECT … FOR UPDATE` on the rule row inside the caller's transaction, scoped to the
 *     tenant (another tenant's id reads as missing: 404), then refuses a lifted or expired rule with 409
 *     RULE_NOT_EDITABLE. Target edits and settings edits take this same lock, so they serialize with each other
 *     and with a lift; a target edit never bumps the revision (SA re-rule).
 *  2. `assertMayManageRule`: an all-customer rule (jurisdiction FEDERAL: hides from every portal customer, owner
 *     L5) is TENANT_ADMIN-only for every write, and so is turning a rule INTO one. Every other rule follows the
 *     controller's OPERATOR gate (owner 10-07 / Q7).
 */

/** The rule columns the shared checks read (a superset is fine). */
export interface LockedRule {
  id: string;
  tenantId: string;
  jurisdiction: string;
  surface: string;
  effectiveTo: Date | null;
  liftedAt: Date | null;
}

type RawTx = {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
};

/** 409 RULE_NOT_EDITABLE when the rule is lifted or has ended at `now`. */
export function assertRuleEditable(rule: LockedRule, now: Date): void {
  const lifted = rule.liftedAt !== null && rule.liftedAt.getTime() <= now.getTime();
  const expired = rule.effectiveTo !== null && rule.effectiveTo.getTime() <= now.getTime();
  if (lifted || expired) {
    throw new ConflictException({
      code: API_ERROR_CODES.RULE_NOT_EDITABLE,
      message: lifted
        ? "This rule has been lifted, so it can't be changed. Add a new rule instead."
        : "This rule has ended, so it can't be changed. Add a new rule instead.",
    });
  }
}

/** Locks the tenant's rule row and returns it; 404 when it is not this tenant's, 409 when it is lifted/expired. */
export async function lockEditableRule(
  tx: RawTx,
  tenantId: string,
  ruleId: string,
  now: Date,
): Promise<LockedRule> {
  const rows = await tx.$queryRaw<LockedRule[]>`
    SELECT "id", "tenantId", "jurisdiction"::text AS "jurisdiction", "surface"::text AS "surface",
           "effectiveTo", "liftedAt"
    FROM "SellingRestriction"
    WHERE "id" = ${ruleId} AND "tenantId" = ${tenantId}
    FOR UPDATE`;
  const rule = rows[0];
  if (!rule) throw new NotFoundException("Restriction not found");
  assertRuleEditable(rule, now);
  return rule;
}

/**
 * The same checks as `lockEditableRule` WITHOUT the lock: for a read that must not hold the rule while it works (the
 * edit preview's impact scan). A plain tenant-scoped read; whatever it decides is re-verified under the lock at commit.
 */
export async function readEditableRule(
  db: RawTx,
  tenantId: string,
  ruleId: string,
  now: Date,
): Promise<LockedRule> {
  const rows = await db.$queryRaw<LockedRule[]>`
    SELECT "id", "tenantId", "jurisdiction"::text AS "jurisdiction", "surface"::text AS "surface",
           "effectiveTo", "liftedAt"
    FROM "SellingRestriction"
    WHERE "id" = ${ruleId} AND "tenantId" = ${tenantId}`;
  const rule = rows[0];
  if (!rule) throw new NotFoundException("Restriction not found");
  assertRuleEditable(rule, now);
  return rule;
}

/** True for a rule that hides from EVERY portal customer (owner L5's "all customers" rule). */
export function isAllCustomerRule(rule: { jurisdiction: string }): boolean {
  return rule.jurisdiction === "FEDERAL";
}

const isTenantAdmin = (user: Pick<JwtPayload, "role">): boolean =>
  user.role === UserRole.TENANT_ADMIN || user.role === UserRole.SUPER_ADMIN;

/**
 * 403 unless `user` may write this rule: an all-customer rule (now, or after the proposed change) needs a
 * TENANT_ADMIN. Call it after the lock, with the LOCKED row and, for an edit, the proposed settings.
 */
export function assertMayManageRule(
  user: Pick<JwtPayload, "role">,
  current: { jurisdiction: string } | null,
  proposed?: { jurisdiction: string },
): void {
  const allCustomer =
    (current !== null && isAllCustomerRule(current)) ||
    (proposed !== undefined && isAllCustomerRule(proposed));
  if (allCustomer && !isTenantAdmin(user)) {
    throw new ForbiddenException({
      code: API_ERROR_CODES.RULE_ADMIN_ONLY,
      message: "Only an account admin can change (or lift) a federal rule.",
    });
  }
}

type LabelRuleTx = {
  sellingRestriction: {
    findMany(args: unknown): Promise<
      Array<{
        jurisdiction: string;
        categoryId: string | null;
        targets: Array<{
          productId: string | null;
          categoryId: string | null;
          addedAt: Date;
          removedAt: Date | null;
        }>;
        _count: { targets: number };
      }>
    >;
  };
};

/**
 * The label (category) ids an ACTIVE all-customer rule covers at `now`: its active label target rows, or its legacy
 * categoryId when it has no target rows at all (the engine's own matching, `ruleTargetSets`). `onlyCategoryId`
 * narrows the read to one label.
 */
export async function activeFederalCategoryIds(
  db: LabelRuleTx,
  tenantId: string,
  now: Date = new Date(),
  onlyCategoryId?: string,
): Promise<Set<string>> {
  const cat = onlyCategoryId ? { categoryId: onlyCategoryId } : { categoryId: { not: null } };
  const rules = await db.sellingRestriction.findMany({
    where: {
      tenantId,
      jurisdiction: "FEDERAL",
      AND: [
        activeRuleWhere(now),
        onlyCategoryId
          ? {
              OR: [
                { categoryId: onlyCategoryId },
                { targets: { some: { categoryId: onlyCategoryId } } },
              ],
            }
          : {},
      ],
    },
    select: {
      jurisdiction: true,
      categoryId: true,
      targets: {
        where: cat,
        select: { productId: true, categoryId: true, addedAt: true, removedAt: true },
      },
      _count: { select: { targets: true } },
    },
  });
  const out = new Set<string>();
  for (const r of rules) {
    if (!isAllCustomerRule(r)) continue;
    const sets = ruleTargetSets(r.targets, r._count.targets, now);
    if (sets) for (const c of sets.categoryIds) out.add(c);
    else if (r.categoryId) out.add(r.categoryId);
  }
  if (onlyCategoryId) for (const c of [...out]) if (c !== onlyCategoryId) out.delete(c);
  return out;
}

/**
 * Owner ruling 2026-10-14 (SA option A): an operator may add or remove a product label, EXCEPT one an ACTIVE
 * all-customer rule covers. Writing such a label changes what that rule hides, so it is a federal-rule change: the
 * caller follows a true here with `assertMayManageRule(user, { jurisdiction: "FEDERAL" })`. Read inside the label
 * writer's transaction, after its category lock.
 */
export async function labelHasActiveFederalRule(
  tx: LabelRuleTx,
  tenantId: string,
  categoryId: string,
  now: Date = new Date(),
): Promise<boolean> {
  return (await activeFederalCategoryIds(tx, tenantId, now, categoryId)).has(categoryId);
}
