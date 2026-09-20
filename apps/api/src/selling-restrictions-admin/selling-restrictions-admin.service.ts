import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { RestrictionStatus, SellingRestrictionListItemDto } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { normalizeUsState } from "../common/us-states";
import { activeRuleWhere, ruleIsActive } from "../selling-restrictions/selling-restrictions.core";
import { CreateRestrictionDto } from "./dto/create-restriction.dto";

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
 * Rule ADMIN (Lane R step 5a): list / create / lift `SellingRestriction` rows (this slice: list + create).
 * Reads OPERATOR, writes TENANT_ADMIN, all audited. It only WRITES rows the engine reads — the engine (rule shape,
 * `ruleIsActive`/`activeRuleWhere`) is imported, never re-decided here. Reading the list is LIVE for
 * OPERATOR; but nothing enforces the rules yet, so writing one changes no tenant's behaviour until
 * the feature is switched on (step 6).
 * A rule is never edited or deleted: it is lifted (with a reason), so the history stays.
 */
@Injectable()
export class SellingRestrictionsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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

  /**
   * STATE names must all be real states: the engine treats a rule naming anything it can't read as
   * "blocks everywhere", so a typo written here would silently over-block — refuse it at the door.
   */
  private normalizeStates(dto: CreateRestrictionDto): string[] {
    const given = (dto.states ?? []).map((s) => s.trim()).filter((s) => s !== "");
    if (dto.jurisdiction === "FEDERAL") {
      if (given.length > 0) {
        throw new BadRequestException(
          "A federal restriction applies everywhere; remove the states.",
        );
      }
      return [];
    }
    if (given.length === 0) {
      throw new BadRequestException("A state restriction needs at least one state.");
    }
    const codes: string[] = [];
    for (const s of given) {
      const code = normalizeUsState(s);
      if (!code) throw new BadRequestException(`"${s}" is not a recognised US state.`);
      if (!codes.includes(code)) codes.push(code);
    }
    return codes;
  }

  async create(
    dto: CreateRestrictionDto,
    user: JwtPayload,
  ): Promise<SellingRestrictionListItemDto> {
    const tenantId = this.requireTenant();
    if (!dto.categoryId === !dto.productId) {
      throw new BadRequestException("Target exactly one of a category or a product.");
    }
    const states = this.normalizeStates(dto);

    const now = new Date();
    const effectiveFrom = dto.effectiveFrom ? new Date(dto.effectiveFrom) : now;
    const effectiveTo = dto.effectiveTo ? new Date(dto.effectiveTo) : null;
    if (effectiveTo && effectiveTo.getTime() <= effectiveFrom.getTime()) {
      throw new BadRequestException("The end date must be after the start date.");
    }

    const db = this.prisma.forTenant();
    if (dto.categoryId) {
      const cat = await db.productCategory.findFirst({ where: { id: dto.categoryId } });
      if (!cat) throw new NotFoundException("Category not found");
      if (cat.archivedAt)
        throw new ConflictException("That category is archived. Restore it first.");
    } else {
      const product = await db.product.findFirst({
        where: { id: dto.productId },
        select: { id: true },
      });
      if (!product) throw new NotFoundException("Product not found");
    }

    const row = await db.sellingRestriction.create({
      data: {
        tenantId,
        categoryId: dto.categoryId ?? null,
        productId: dto.productId ?? null,
        jurisdiction: dto.jurisdiction,
        states,
        surface: dto.surface ?? "ALL",
        effectiveFrom,
        effectiveTo,
        reason: dto.reason,
        createdById: user.sub,
        createdByName: user.username,
      },
      include: INCLUDE,
    });
    await this.audit.log({
      tenantId,
      userId: user.sub,
      action: "selling_restriction.created",
      entityType: "SellingRestriction",
      entityId: row.id,
      meta: {
        scope: dto.categoryId ? { categoryId: dto.categoryId } : { productId: dto.productId },
        jurisdiction: dto.jurisdiction,
        states,
        surface: row.surface,
        effectiveFrom: effectiveFrom.toISOString(),
        effectiveTo: effectiveTo?.toISOString() ?? null,
        reason: dto.reason,
      },
    });
    return toDto(row, now);
  }
}
