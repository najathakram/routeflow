import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { RestrictionStatus, SellingRestrictionListItemDto } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { activeRuleWhere, ruleIsActive } from "../selling-restrictions/selling-restrictions.core";

const INCLUDE = {
  category: { select: { name: true } },
  product: { select: { name: true } },
} as const;
type Row = Prisma.SellingRestrictionGetPayload<{ include: typeof INCLUDE }>;

/** More rules than this per tenant is not a legal-hold list; the read is bounded, never unbounded. */
const LIST_CAP = 500;

/**
 * The API-side mirror of the shared status list (the API never imports `@routeflow/types` at
 * runtime); `restriction-status.parity.spec.ts` pins it set-equal to `RESTRICTION_STATUS_VALUES`.
 */
export const RESTRICTION_STATUSES = [
  "ACTIVE",
  "SCHEDULED",
  "EXPIRED",
  "LIFTED",
] as const satisfies readonly RestrictionStatus[];

/**
 * The SQL twin of `restrictionStatus`: a `where` selecting exactly the rows in that stage at `now`,
 * so the status filter is applied BEFORE the read cap (a stage with old rows is never crowded out
 * by newer ones of another stage). `restriction-status.parity.spec.ts` pins the two against each
 * other over every window boundary. Order mirrors the function: ACTIVE, else LIFTED, else EXPIRED,
 * else SCHEDULED.
 */
export function statusWhere(
  status: RestrictionStatus,
  now: Date,
): Prisma.SellingRestrictionWhereInput {
  const notLifted = { OR: [{ liftedAt: null }, { liftedAt: { gt: now } }] };
  switch (status) {
    case "ACTIVE":
      return activeRuleWhere(now);
    case "LIFTED":
      return { liftedAt: { lte: now } };
    case "EXPIRED":
      return { AND: [notLifted, { effectiveTo: { lte: now } }] };
    case "SCHEDULED":
      return {
        effectiveFrom: { gt: now },
        AND: [notLifted, { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }],
      };
  }
}

/** The rule's stage at `now`, decided by the engine's own window rule (`ruleIsActive`). */
export function restrictionStatus(row: Row, now: Date): RestrictionStatus {
  if (ruleIsActive(row, now)) return "ACTIVE";
  if (row.liftedAt && row.liftedAt.getTime() <= now.getTime()) return "LIFTED";
  if (row.effectiveTo && row.effectiveTo.getTime() <= now.getTime()) return "EXPIRED";
  return "SCHEDULED";
}

function toDto(row: Row, now: Date): SellingRestrictionListItemDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    categoryId: row.categoryId,
    productId: row.productId,
    jurisdiction: row.jurisdiction,
    states: row.states,
    surface: row.surface,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
    reason: row.reason,
    createdById: row.createdById,
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
    liftedById: row.liftedById,
    liftedByName: row.liftedByName,
    liftedAt: row.liftedAt ? row.liftedAt.toISOString() : null,
    liftReason: row.liftReason,
    status: restrictionStatus(row, now),
    categoryName: row.category?.name ?? null,
    productName: row.product?.name ?? null,
  };
}

/**
 * Rule ADMIN (Lane R step 5a): list / create / lift `SellingRestriction` rows (this slice: list).
 * Reads OPERATOR, writes TENANT_ADMIN, all audited. It only WRITES rows the engine reads — the engine (rule shape,
 * `ruleIsActive`/`activeRuleWhere`) is imported, never re-decided here. Reading the list is LIVE for
 * OPERATOR; but nothing enforces the rules yet, so writing one changes no tenant's behaviour until
 * the feature is switched on (step 6).
 * A rule is never edited or deleted: it is lifted (with a reason), so the history stays.
 */
@Injectable()
export class SellingRestrictionsAdminService {
  constructor(private readonly prisma: PrismaService) {}

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }

  async list(status?: RestrictionStatus): Promise<SellingRestrictionListItemDto[]> {
    this.requireTenant();
    const now = new Date();
    const rows = await this.prisma.forTenant().sellingRestriction.findMany({
      where: status ? statusWhere(status, now) : {},
      include: INCLUDE,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: LIST_CAP,
    });
    return rows.map((r) => toDto(r, now));
  }
}
