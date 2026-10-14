import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import type {
  AddRuleTargetsRequest,
  AddRuleTargetsResponse,
  RemoveRuleTargetsRequest,
  RemoveRuleTargetsResponse,
  RuleDetailDto,
  RuleTargetDto,
  RuleTargetEventDto,
  RulesHoldingRequest,
  RulesHoldingResponse,
} from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { RULE_TARGETS_MAX_PER_REQUEST, RULE_TARGETS_MAX_PER_RULE } from "./dto/rule-targets.dto";
import { assertMayManageRule, lockEditableRule } from "./rule-lock";
import { ruleNeedsATarget, ruleTargetLimit } from "./rule-errors";
import {
  decodeCursor,
  EMPTY_TARGET_SUMMARY,
  encodeCursor,
  ensureLegacyTarget,
  normalizeTargetIds,
  resolveTargetIds,
  ruleTargetName,
  targetSummaries,
} from "./rule-target-read";
import {
  RULE_INCLUDE,
  type RuleRow,
  statusWhere,
  toDto,
} from "./selling-restrictions-admin.service";

/** Targets per page of GET /selling-restrictions/:id (the shared RULE_TARGETS_PAGE_SIZE). */
export const RULE_TARGETS_PAGE_SIZE = 100;

/** The reason a removal records when the caller leaves it blank. */
export const DEFAULT_REMOVE_REASON = "Removed from rule";

/** History events shown on the rule detail. */
const TARGET_EVENTS_MAX = 50;

/** Most rules `holding` returns (the same bound as the rules list). */
const HOLDING_CAP = 500;

const TARGET_PRODUCT_SELECT = {
  id: true,
  name: true,
  sku: true,
  kind: true,
  parent: { select: { name: true } },
} as const;

/** The rule row the target writes read after taking the lock (the legacy columns and the dates the backfill uses). */
const RULE_FACTS_SELECT = {
  id: true,
  tenantId: true,
  productId: true,
  categoryId: true,
  createdAt: true,
  effectiveFrom: true,
  createdById: true,
  createdByName: true,
} as const;

/**
 * Row 509 — a rule's targets: the detail read, add, remove and "which rules hold these products". Every write is one
 * `tenantTransaction` that takes the rule row's `FOR UPDATE` lock FIRST (`lockEditableRule`, shared with settings
 * edits and lifts), so edits serialize with each other and with a lift, then checks who may write the rule
 * (`assertMayManageRule`). Target edits never bump a revision. Targets are history rows: a removal stamps
 * `removedAt`, nothing is deleted. The audit row carries counts and ids, never names.
 */
@Injectable()
export class RuleTargetsService {
  constructor(private readonly prisma: PrismaService) {}

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }

  /** A P2002 on the partial unique "one ACTIVE row per (rule, product|label)" means a concurrent writer won: retry. */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException({
          code: API_ERROR_CODES.CONCURRENT_UPDATE,
          message: "Someone changed this rule at the same moment. Try again.",
        });
      }
      throw e;
    }
  }

  // ─── GET /selling-restrictions/:id ───────────────────────────────────────────────────────────

  async detail(id: string, cursor?: string): Promise<RuleDetailDto> {
    const tenantId = this.requireTenant();
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    const db = this.prisma.forTenant();
    const now = new Date();
    const rule: RuleRow | null = await db.sellingRestriction.findFirst({
      where: { id, tenantId },
      include: RULE_INCLUDE,
    });
    if (!rule) throw new NotFoundException("Restriction not found");

    const summaries = await targetSummaries(db, tenantId, [id]);
    const rows = await db.sellingRestrictionTarget.findMany({
      where: { tenantId, ruleId: id, removedAt: null, ...(after ? { id: { gt: after } } : {}) },
      include: { product: { select: TARGET_PRODUCT_SELECT }, category: { select: { name: true } } },
      orderBy: { id: "asc" },
      take: RULE_TARGETS_PAGE_SIZE + 1,
    });
    const page = rows.slice(0, RULE_TARGETS_PAGE_SIZE);
    let targets: RuleTargetDto[];
    if (page.length === 0 && after === undefined) {
      targets = await this.legacyTarget(db, tenantId, rule);
    } else {
      const parentIds = page.filter((t) => t.product !== null).map((t) => t.productId as string);
      const variantCounts = await this.variantCounts(db, tenantId, parentIds);
      targets = page.map((t) => {
        const count = variantCounts.get(t.productId ?? "") ?? 0;
        const isFamily = t.product?.kind === "FAMILY";
        return {
          id: t.id,
          kind: t.productId ? "PRODUCT" : "CATEGORY",
          productId: t.productId,
          categoryId: t.categoryId,
          name: t.product ? ruleTargetName(t.product) : (t.category?.name ?? ""),
          sku: t.product?.sku ?? null,
          isFamily,
          variantCount: t.product && (isFamily || count > 0) ? count : null,
          addedAt: t.addedAt.toISOString(),
          addedByName: t.addedByName,
        };
      });
    }
    return {
      ...toDto(rule, now, summaries.get(id) ?? EMPTY_TARGET_SUMMARY),
      targets,
      nextCursor:
        rows.length > RULE_TARGETS_PAGE_SIZE ? encodeCursor(page[page.length - 1].id) : null,
      revisions: [], // PR3 fills this
      targetEvents: await this.targetEvents(db, tenantId, id),
    };
  }

  /** A pre-509 rule (ZERO target rows) shows its legacy column as its one target. */
  private async legacyTarget(
    db: ReturnType<PrismaService["forTenant"]>,
    tenantId: string,
    rule: RuleRow,
  ): Promise<RuleTargetDto[]> {
    const any = await db.sellingRestrictionTarget.count({ where: { tenantId, ruleId: rule.id } });
    if (any > 0 || (!rule.productId && !rule.categoryId)) return [];
    const base = {
      id: `legacy:${rule.id}`,
      productId: rule.productId,
      categoryId: rule.categoryId,
      addedAt: new Date(
        Math.min(rule.createdAt.getTime(), rule.effectiveFrom.getTime()),
      ).toISOString(),
      addedByName: rule.createdByName,
    };
    if (rule.productId) {
      const p = await db.product.findFirst({
        where: { id: rule.productId, tenantId },
        select: TARGET_PRODUCT_SELECT,
      });
      const count =
        (await this.variantCounts(db, tenantId, [rule.productId])).get(rule.productId) ?? 0;
      const isFamily = p?.kind === "FAMILY";
      return [
        {
          ...base,
          kind: "PRODUCT",
          name: p ? ruleTargetName(p) : "",
          sku: p?.sku ?? null,
          isFamily,
          variantCount: isFamily || count > 0 ? count : null,
        },
      ];
    }
    return [
      {
        ...base,
        kind: "CATEGORY",
        name: rule.category?.name ?? "",
        sku: null,
        isFamily: false,
        variantCount: null,
      },
    ];
  }

  private async variantCounts(
    db: ReturnType<PrismaService["forTenant"]>,
    tenantId: string,
    productIds: string[],
  ): Promise<Map<string, number>> {
    if (productIds.length === 0) return new Map();
    const rows = await db.$queryRaw<
      Array<{ parentProductId: string; variants: number }>
    >(Prisma.sql`
      SELECT p."parentProductId" AS "parentProductId", COUNT(*)::int AS "variants"
      FROM "Product" p
      WHERE p."tenantId" = ${tenantId} AND p."parentProductId" = ANY(${productIds}::text[])
      GROUP BY p."parentProductId"`);
    return new Map(rows.map((r) => [r.parentProductId, r.variants]));
  }

  private async targetEvents(
    db: ReturnType<PrismaService["forTenant"]>,
    tenantId: string,
    ruleId: string,
  ): Promise<RuleTargetEventDto[]> {
    const rows = await db.auditLog.findMany({
      where: {
        tenantId,
        entityType: "SellingRestriction",
        entityId: ruleId,
        action: {
          in: ["selling_restriction.targets_added", "selling_restriction.targets_removed"],
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: TARGET_EVENTS_MAX,
    });
    return rows.map((r: { action: string; meta: unknown; createdAt: Date }) => {
      const meta = (r.meta ?? {}) as { count?: number; byName?: string; reason?: string };
      return {
        kind: r.action === "selling_restriction.targets_added" ? "ADDED" : "REMOVED",
        count: typeof meta.count === "number" ? meta.count : 0,
        byName: typeof meta.byName === "string" ? meta.byName : null,
        at: r.createdAt.toISOString(),
        reason: typeof meta.reason === "string" ? meta.reason : null,
      };
    });
  }

  // ─── POST /selling-restrictions/:id/targets ──────────────────────────────────────────────────

  async addTargets(
    id: string,
    input: AddRuleTargetsRequest,
    user: JwtPayload,
  ): Promise<AddRuleTargetsResponse> {
    const tenantId = this.requireTenant();
    const wanted = normalizeTargetIds(input);
    const now = new Date();
    return this.guarded(() =>
      this.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
        const locked = await lockEditableRule(tx, tenantId, id, now);
        assertMayManageRule(user, locked);
        await resolveTargetIds(tx, tenantId, wanted);
        await this.materialiseLegacy(tx, tenantId, id);

        const present: Array<{ productId: string | null; categoryId: string | null }> =
          await tx.sellingRestrictionTarget.findMany({
            where: {
              tenantId,
              ruleId: id,
              removedAt: null,
              OR: [
                ...(wanted.productIds.length > 0 ? [{ productId: { in: wanted.productIds } }] : []),
                ...(wanted.categoryIds.length > 0
                  ? [{ categoryId: { in: wanted.categoryIds } }]
                  : []),
              ],
            },
            select: { productId: true, categoryId: true },
          });
        const have = new Set(present.map((t) => t.productId ?? t.categoryId));
        const addProducts = wanted.productIds.filter((x) => !have.has(x));
        const addCategories = wanted.categoryIds.filter((x) => !have.has(x));
        const skippedIds = [...wanted.productIds, ...wanted.categoryIds].filter((x) => have.has(x));

        const activeBefore = await tx.sellingRestrictionTarget.count({
          where: { tenantId, ruleId: id, removedAt: null },
        });
        const adding = addProducts.length + addCategories.length;
        if (activeBefore + adding > RULE_TARGETS_MAX_PER_RULE) {
          throw ruleTargetLimit("rule", RULE_TARGETS_MAX_PER_RULE);
        }
        if (adding === 0) {
          return { added: 0, skippedIds, addedTargetIds: [], activeTargets: activeBefore };
        }
        const stamp = {
          tenantId,
          ruleId: id,
          addedAt: now,
          addedById: user.sub,
          addedByName: user.username,
        };
        const rows = [
          ...addProducts.map((productId) => ({
            id: randomUUID(),
            ...stamp,
            productId,
            categoryId: null,
          })),
          ...addCategories.map((categoryId) => ({
            id: randomUUID(),
            ...stamp,
            productId: null,
            categoryId,
          })),
        ];
        await tx.sellingRestrictionTarget.createMany({ data: rows });
        await tx.auditLog.create({
          data: {
            tenantId,
            userId: user.sub,
            impersonatedBy: user.impersonatedBy ?? null,
            action: "selling_restriction.targets_added",
            entityType: "SellingRestriction",
            entityId: id,
            meta: {
              ruleId: id,
              count: adding,
              productIds: addProducts,
              categoryIds: addCategories,
              byName: user.username,
            },
          },
        });
        return {
          added: adding,
          skippedIds,
          addedTargetIds: rows.map((r) => r.id),
          activeTargets: activeBefore + adding,
        };
      }),
    );
  }

  // ─── POST /selling-restrictions/:id/targets/remove ───────────────────────────────────────────

  async removeTargets(
    id: string,
    input: RemoveRuleTargetsRequest,
    user: JwtPayload,
  ): Promise<RemoveRuleTargetsResponse> {
    const tenantId = this.requireTenant();
    const wanted = normalizeTargetIds(input);
    const reason = (input.reason ?? "").trim().slice(0, 500) || DEFAULT_REMOVE_REASON;
    const now = new Date();
    return this.guarded(() =>
      this.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
        const locked = await lockEditableRule(tx, tenantId, id, now);
        assertMayManageRule(user, locked);
        await resolveTargetIds(tx, tenantId, wanted, { allowArchivedLabels: true });
        await this.materialiseLegacy(tx, tenantId, id);

        const present: Array<{ id: string; productId: string | null; categoryId: string | null }> =
          await tx.sellingRestrictionTarget.findMany({
            where: {
              tenantId,
              ruleId: id,
              removedAt: null,
              OR: [
                ...(wanted.productIds.length > 0 ? [{ productId: { in: wanted.productIds } }] : []),
                ...(wanted.categoryIds.length > 0
                  ? [{ categoryId: { in: wanted.categoryIds } }]
                  : []),
              ],
            },
            select: { id: true, productId: true, categoryId: true },
          });
        const inRule = new Set(present.map((t) => t.productId ?? t.categoryId));
        const notInRule = [...wanted.productIds, ...wanted.categoryIds].filter(
          (x) => !inRule.has(x),
        );
        const activeBefore = await tx.sellingRestrictionTarget.count({
          where: { tenantId, ruleId: id, removedAt: null },
        });
        if (present.length === 0) return { removed: 0, notInRule, activeTargets: activeBefore };
        if (activeBefore - present.length <= 0) throw ruleNeedsATarget();

        const rowIds = present.map((t) => t.id);
        if (!tenantId || !id || rowIds.some((x) => !x)) {
          throw new BadRequestException("Name at least one target to remove.");
        }
        const { count } = await tx.sellingRestrictionTarget.updateMany({
          where: { tenantId, ruleId: id, id: { in: rowIds }, removedAt: null },
          data: {
            removedAt: now,
            removedById: user.sub,
            removedByName: user.username,
            removeReason: reason,
          },
        });
        if (count !== rowIds.length) {
          throw new ConflictException({
            code: API_ERROR_CODES.CONCURRENT_UPDATE,
            message: "Someone changed this rule at the same moment. Try again.",
          });
        }
        await tx.auditLog.create({
          data: {
            tenantId,
            userId: user.sub,
            impersonatedBy: user.impersonatedBy ?? null,
            action: "selling_restriction.targets_removed",
            entityType: "SellingRestriction",
            entityId: id,
            meta: {
              ruleId: id,
              count,
              productIds: present.filter((t) => t.productId).map((t) => t.productId),
              categoryIds: present.filter((t) => t.categoryId).map((t) => t.categoryId),
              reason,
              byName: user.username,
            },
          },
        });
        return { removed: count, notInRule, activeTargets: activeBefore - count };
      }),
    );
  }

  /** SA condition 1: the first edit of a zero-target legacy rule writes its column as a target row, rule locked. */
  private async materialiseLegacy(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ruleId: string,
  ): Promise<void> {
    const rule = await tx.sellingRestriction.findFirst({
      where: { id: ruleId, tenantId },
      select: RULE_FACTS_SELECT,
    });
    if (!rule) throw new NotFoundException("Restriction not found");
    await ensureLegacyTarget(tx, rule);
  }

  // ─── POST /selling-restrictions/holding ──────────────────────────────────────────────────────

  /**
   * The ACTIVE / SCHEDULED rules that hold at least one of the products as a DIRECT target (not through a parent or
   * a label), with how many of the asked products each holds. A rule with zero target rows is read by its column.
   */
  async holding(input: RulesHoldingRequest): Promise<RulesHoldingResponse> {
    const tenantId = this.requireTenant();
    const productIds = [...new Set((input.productIds ?? []).filter((x) => x !== ""))];
    if (productIds.length === 0) throw new BadRequestException("Choose at least one product.");
    if (productIds.length > RULE_TARGETS_MAX_PER_REQUEST) {
      throw ruleTargetLimit("request", RULE_TARGETS_MAX_PER_REQUEST);
    }
    const db = this.prisma.forTenant();
    const now = new Date();
    const inForce = { OR: [statusWhere("ACTIVE", now), statusWhere("SCHEDULED", now)] };

    const direct: Array<{ ruleId: string; productId: string | null }> =
      await db.sellingRestrictionTarget.findMany({
        where: { tenantId, removedAt: null, productId: { in: productIds }, rule: inForce },
        select: { ruleId: true, productId: true },
      });
    const legacy: Array<{ id: string; productId: string | null }> =
      await db.sellingRestriction.findMany({
        where: { tenantId, productId: { in: productIds }, targets: { none: {} }, ...inForce },
        select: { id: true, productId: true },
      });
    const holds = new Map<string, Set<string>>();
    for (const t of direct) {
      if (t.productId)
        (holds.get(t.ruleId) ?? holds.set(t.ruleId, new Set()).get(t.ruleId))?.add(t.productId);
    }
    for (const r of legacy) {
      if (r.productId) (holds.get(r.id) ?? holds.set(r.id, new Set()).get(r.id))?.add(r.productId);
    }
    if (holds.size === 0) return { items: [] };

    const ruleIds = [...holds.keys()];
    const rules: RuleRow[] = await db.sellingRestriction.findMany({
      where: { tenantId, id: { in: ruleIds } },
      include: RULE_INCLUDE,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: HOLDING_CAP,
    });
    const summaries = await targetSummaries(db, tenantId, ruleIds);
    const items = rules.map((r) => ({
      rule: toDto(r, now, summaries.get(r.id) ?? EMPTY_TARGET_SUMMARY),
      holds: holds.get(r.id)?.size ?? 0,
    }));
    items.sort((a, b) => b.holds - a.holds); // stable: newest first within equal counts
    return { items };
  }
}
