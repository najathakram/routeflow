import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { Prisma, RestrictionJurisdiction, RestrictionSurface } from "@prisma/client";
import type {
  BulkRestrictionResponse,
  LiftBatchResponse,
  ProductLimitDto,
  ProductLimitsResponse,
  RestrictionStatus,
  RuleTargetSummary,
  SellingRestrictionListItemDto,
} from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { normalizeUsState } from "../common/us-states";
import { activeRuleWhere, ruleIsActive } from "../selling-restrictions/selling-restrictions.core";
import { CreateRestrictionDto } from "./dto/create-restriction.dto";
import { LiftRestrictionDto } from "./dto/lift-restriction.dto";
import { BULK_RESTRICTION_MAX, BulkRestrictionDto } from "./dto/bulk-restriction.dto";
import { assertMayManageRule } from "./rule-lock";
import {
  activeTargetsWhere,
  decodeCursor,
  encodeCursor,
  EMPTY_TARGET_SUMMARY,
  normalizeTargetIds,
  resolveTargetIds,
  targetSummaries,
} from "./rule-target-read";

const INCLUDE = {
  category: { select: { name: true } },
  product: { select: { name: true } },
} as const;
type Row = Prisma.SellingRestrictionGetPayload<{ include: typeof INCLUDE }>;

/** More rules than this per tenant is not a legal-hold list; the read is bounded, never unbounded. */
const LIST_CAP = 500;

/** The reason a bulk portal limit carries when the admin leaves the note blank. */
export const DEFAULT_BULK_REASON = "Portal limit";

/** The reason a batch lift records when the admin leaves the note blank. */
export const DEFAULT_LIFT_REASON = "Limit lifted";

/** Chips per page of GET /selling-restrictions?productId= (a product carries a handful in practice). */
export const PRODUCT_LIMITS_PAGE_SIZE = 50;

/** The 409 of a batch lift: nothing was changed; names what blocked it. */
function liftConflict(notFoundIds: string[], alreadyLiftedIds: string[]): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: "Conflict",
    message:
      alreadyLiftedIds.length > 0 && notFoundIds.length === 0
        ? "Some of these limits were already lifted. Nothing was changed."
        : "Some of these limits could not be lifted. Nothing was changed. Reload and try again.",
    notFoundIds,
    alreadyLiftedIds,
  });
}

/** The (already normalised) ids a create covers: products first when any, then labels. */
interface TargetIds {
  productIds: string[];
  categoryIds: string[];
}

/** What single and bulk create hand the shared validation path. */
interface RuleInput {
  target: TargetIds;
  jurisdiction: RestrictionJurisdiction;
  states?: string[];
  surface: RestrictionSurface;
  effectiveFrom?: string;
  effectiveTo?: string;
  reason: string;
}

/** A validated create: the target ids, normalised states, a checked window. */
interface PreparedRules {
  target: TargetIds;
  jurisdiction: RestrictionJurisdiction;
  states: string[];
  surface: RestrictionSurface;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  reason: string;
  now: Date;
}

/**
 * Rules still LIVE at `now` for the identical-rule check: not lifted and not expired. A rule whose
 * `effectiveTo` (or `liftedAt`) is already at or before `now` is not live, so it is never identical
 * — a new rule is written. An `AND` list, for a caller's `where.AND`.
 */
export function liveRuleWhere(now: Date): Prisma.SellingRestrictionWhereInput[] {
  return [
    { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
    { OR: [{ liftedAt: null }, { liftedAt: { gt: now } }] },
  ];
}

/**
 * The SQL half of "the existing window COVERS the requested one": it starts no later than the
 * request, and ends (at `effectiveTo` or a future `liftedAt`, whichever is earlier) no earlier —
 * never, when the request is open-ended. `windowCovers` is its JS twin. An `AND` list.
 */
export function coveringWindowWhere(window: {
  effectiveFrom: Date;
  effectiveTo: Date | null;
}): Prisma.SellingRestrictionWhereInput[] {
  const to = window.effectiveTo;
  return [
    { effectiveFrom: { lte: window.effectiveFrom } },
    to === null
      ? { effectiveTo: null, liftedAt: null }
      : {
          AND: [
            { OR: [{ effectiveTo: null }, { effectiveTo: { gte: to } }] },
            { OR: [{ liftedAt: null }, { liftedAt: { gte: to } }] },
          ],
        },
  ];
}

/** The JS twin of `coveringWindowWhere`: does `existing`'s window cover `requested`'s? */
export function windowCovers(
  existing: { effectiveFrom: Date; effectiveTo: Date | null; liftedAt: Date | null },
  requested: { effectiveFrom: Date; effectiveTo: Date | null },
): boolean {
  if (existing.effectiveFrom.getTime() > requested.effectiveFrom.getTime()) return false;
  const ends = [existing.effectiveTo, existing.liftedAt].filter((d): d is Date => d !== null);
  if (ends.length === 0) return true;
  if (requested.effectiveTo === null) return false;
  const end = Math.min(...ends.map((d) => d.getTime()));
  return end >= requested.effectiveTo.getTime();
}

/** A states list as a comparable key: USPS codes, de-duplicated, sorted. */
function sortedStatesKey(states: readonly string[]): string {
  return [...new Set(states.map((s) => normalizeUsState(s) ?? s.trim().toUpperCase()))]
    .sort()
    .join(",");
}

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

/** A chip row: the rule, its active targets that touch the product, and its FULL target-row count. */
type ChipRow = Row & {
  targets: Array<{
    productId: string | null;
    categoryId: string | null;
    product: { name: string } | null;
    category: { name: string } | null;
  }>;
  _count: { targets: number };
};

/**
 * How a rule reaches `productId` (row 509): a direct product target (PRODUCT, "Remove from rule" applies), an
 * ancestor's product target (PARENT), or a label target (CATEGORY). A rule with ZERO target rows is read by its
 * legacy column, exactly as the engine does (SA condition 1).
 */
function chipReach(
  row: ChipRow,
  productId: string,
  lineage: ReadonlySet<string>,
): { via: ProductLimitDto["via"]; viaLabel: string | null; direct: boolean } {
  if (row._count.targets === 0) {
    if (row.productId && lineage.has(row.productId)) {
      return row.productId === productId
        ? { via: "PRODUCT", viaLabel: null, direct: true }
        : { via: "PARENT", viaLabel: row.product?.name ?? null, direct: false };
    }
    return { via: "CATEGORY", viaLabel: row.category?.name ?? null, direct: false };
  }
  if (row.targets.some((t) => t.productId === productId)) {
    return { via: "PRODUCT", viaLabel: null, direct: true };
  }
  const parent = row.targets.find((t) => t.productId !== null);
  if (parent) return { via: "PARENT", viaLabel: parent.product?.name ?? null, direct: false };
  const label = row.targets.find((t) => t.categoryId !== null);
  return { via: "CATEGORY", viaLabel: label?.category?.name ?? null, direct: false };
}

/** One chip: how the rule reaches `productId` (its own, an ancestor's, or a label's), and through what. */
function toProductLimit(
  row: ChipRow,
  productId: string,
  lineage: ReadonlySet<string>,
  summary: RuleTargetSummary | undefined,
): ProductLimitDto {
  const { via, viaLabel, direct } = chipReach(row, productId, lineage);
  return {
    id: row.id,
    jurisdiction: row.jurisdiction,
    states: row.states,
    surface: row.surface,
    reason: row.reason,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
    via,
    viaLabel,
    liftedAt: row.liftedAt ? row.liftedAt.toISOString() : null,
    directTarget: direct,
    targetSummary: summary ?? EMPTY_TARGET_SUMMARY,
  };
}

export function toDto(
  row: Row,
  now: Date,
  summary?: RuleTargetSummary,
): SellingRestrictionListItemDto {
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
    ...(summary ? { targetSummary: summary } : {}),
  };
}

export { INCLUDE as RULE_INCLUDE };
export type { Row as RuleRow };

/**
 * Rule ADMIN (Lane R step 5a; portal limits Branch B): list / create (single and bulk) / lift
 * `SellingRestriction` rows. OPERATOR and TENANT_ADMIN (owner 10-07: operators are near-admins);
 * creates are audited IN their own transaction. It only WRITES rows the engine reads — the engine
 * (rule shape, `ruleIsActive`/`activeRuleWhere`) is imported, never re-decided here.
 * Single create is a bulk of one: one validation path (`prepare`), one write path (`writeRules`).
 * A rule is never edited or deleted: it is lifted (with a reason), so the history stays.
 */
@Injectable()
export class SellingRestrictionsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly productLabels: ProductLabelsService,
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
    const summaries = await targetSummaries(
      this.prisma.forTenant(),
      this.requireTenant(),
      rows.map((r) => r.id),
    );
    return rows.map((r) => toDto(r, now, summaries.get(r.id) ?? EMPTY_TARGET_SUMMARY));
  }

  /**
   * STATE names must all be real states: the engine treats a rule naming anything it can't read as
   * "blocks everywhere", so a typo written here would silently over-block — refuse it at the door.
   */
  private normalizeStates(jurisdiction: RestrictionJurisdiction, states?: string[]): string[] {
    const given = (states ?? []).map((s) => s.trim()).filter((s) => s !== "");
    if (jurisdiction === "FEDERAL") {
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

  /**
   * The ONE validation path for single and bulk create (pure; no reads): the states rules and the date window.
   * The target ids arrive already normalised (`createTargets` / `bulkTargets`).
   */
  private prepare(input: RuleInput): PreparedRules {
    const states = this.normalizeStates(input.jurisdiction, input.states);
    const now = new Date();
    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : now;
    const effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : null;
    if (effectiveTo && effectiveTo.getTime() <= effectiveFrom.getTime()) {
      throw new BadRequestException("The end date must be after the start date.");
    }
    return {
      target: input.target,
      jurisdiction: input.jurisdiction,
      states,
      surface: input.surface,
      effectiveFrom,
      effectiveTo,
      reason: input.reason,
      now,
    };
  }

  /**
   * Single create's targets: the legacy single `productId` / `categoryId`, OR row 509 `targets` (products and/or
   * labels, mixed, 1..RULE_TARGETS_MAX_PER_REQUEST in all); exactly one form.
   */
  private createTargets(dto: CreateRestrictionDto): TargetIds {
    const legacy = (dto.productId ? 1 : 0) + (dto.categoryId ? 1 : 0);
    if (dto.targets) {
      if (legacy > 0) {
        throw new BadRequestException(
          "Send either targets, or a single product or category, not both.",
        );
      }
      return normalizeTargetIds(dto.targets);
    }
    if (legacy !== 1)
      throw new BadRequestException("Target exactly one of a category or a product.");
    return dto.productId
      ? { productIds: [dto.productId], categoryIds: [] }
      : { productIds: [], categoryIds: [dto.categoryId as string] };
  }

  /** Bulk create's targets: 1..BULK_RESTRICTION_MAX products XOR one label (the pre-509 request shape). */
  private bulkTargets(dto: BulkRestrictionDto): TargetIds {
    const productIds = [...new Set(dto.productIds ?? [])];
    if (!dto.categoryId === (productIds.length === 0)) {
      throw new BadRequestException("Target exactly one of a category or a product.");
    }
    if (productIds.length > BULK_RESTRICTION_MAX) {
      throw new BadRequestException(
        `Send at most ${BULK_RESTRICTION_MAX} products at once, or limit a whole category instead.`,
      );
    }
    return dto.categoryId
      ? { productIds: [], categoryIds: [dto.categoryId] }
      : { productIds, categoryIds: [] };
  }

  /**
   * Inside the caller's transaction, writes ONE rule that covers every target (row 509). Order: who may write it
   * (an all-customer rule is admin-only), every id resolves in THIS tenant (else the coded 409, nothing written),
   * the optional identical-rule skip, then the rule row (its legacy column mirrors the FIRST target, product first:
   * SA condition 2) and one target row per id. `addedAt` is the rule's effectiveFrom when that is earlier than now
   * (a backdated rule covers its products from then), else now. Returns null when an identical live rule skipped it.
   */
  private async writeRule(
    tx: Prisma.TransactionClient,
    tenantId: string,
    p: PreparedRules,
    user: JwtPayload,
    opts: { skipIdentical: boolean },
  ): Promise<{ ruleId: string } | null> {
    assertMayManageRule(user, null, { jurisdiction: p.jurisdiction });
    await resolveTargetIds(tx, tenantId, p.target);
    if (opts.skipIdentical && (await this.identicalRuleHoldsAll(tx, tenantId, p))) return null;

    const ruleId = randomUUID();
    const first =
      p.target.productIds.length > 0
        ? { productId: p.target.productIds[0], categoryId: null }
        : { productId: null, categoryId: p.target.categoryIds[0] };
    await tx.sellingRestriction.create({
      data: {
        id: ruleId,
        tenantId,
        ...first,
        jurisdiction: p.jurisdiction,
        states: p.states,
        surface: p.surface,
        effectiveFrom: p.effectiveFrom,
        effectiveTo: p.effectiveTo,
        reason: p.reason,
        createdById: user.sub,
        createdByName: user.username,
      },
    });
    const addedAt = p.effectiveFrom.getTime() < p.now.getTime() ? p.effectiveFrom : p.now;
    const stamp = { tenantId, ruleId, addedAt, addedById: user.sub, addedByName: user.username };
    await tx.sellingRestrictionTarget.createMany({
      data: [
        ...p.target.productIds.map((productId) => ({ ...stamp, productId, categoryId: null })),
        ...p.target.categoryIds.map((categoryId) => ({ ...stamp, productId: null, categoryId })),
      ],
    });
    return { ruleId };
  }

  /**
   * Does ONE live rule with the same jurisdiction, states set (order and spelling ignored) and surface, whose window
   * COVERS the requested one, already hold ALL of the requested targets (as active target rows, or, for a rule with
   * zero target rows, as its legacy column)? Then a new rule would only duplicate it. A rule that expires sooner or
   * starts later does not cover the window (skipping would leave the products sellable in the gap), and a rule that
   * holds only SOME of the targets is not identical: the new rule is written.
   */
  private async identicalRuleHoldsAll(
    tx: Prisma.TransactionClient,
    tenantId: string,
    p: PreparedRules,
  ): Promise<boolean> {
    const rows: Array<{
      id: string;
      productId: string | null;
      categoryId: string | null;
      jurisdiction: string;
      states: string[];
      surface: string;
      effectiveFrom: Date;
      effectiveTo: Date | null;
      liftedAt: Date | null;
      _count: { targets: number };
    }> = await tx.sellingRestriction.findMany({
      where: {
        tenantId,
        jurisdiction: p.jurisdiction,
        surface: p.surface,
        AND: [...liveRuleWhere(p.now), ...coveringWindowWhere(p)],
      },
      select: {
        id: true,
        productId: true,
        categoryId: true,
        jurisdiction: true,
        states: true,
        surface: true,
        effectiveFrom: true,
        effectiveTo: true,
        liftedAt: true,
        _count: { select: { targets: true } },
      },
    });
    const key = sortedStatesKey(p.states);
    // The SQL already matched jurisdiction + surface; the JS twin keeps a wrong row from ever skipping a create.
    const same = rows.filter(
      (r) =>
        r.jurisdiction === p.jurisdiction &&
        r.surface === p.surface &&
        sortedStatesKey(r.states) === key &&
        windowCovers(r, p),
    );
    const wanted = p.target.productIds.length + p.target.categoryIds.length;
    // A legacy rule (zero target rows) holds exactly its one column.
    for (const r of same) {
      if (r._count.targets !== 0 || wanted !== 1) continue;
      if (r.productId && r.productId === p.target.productIds[0]) return true;
      if (r.categoryId && r.categoryId === p.target.categoryIds[0]) return true;
    }
    const withRows = same.filter((r) => r._count.targets > 0).map((r) => r.id);
    if (withRows.length === 0) return false;
    const held: Array<{ ruleId: string }> = await tx.sellingRestrictionTarget.findMany({
      where: {
        tenantId,
        ruleId: { in: withRows },
        removedAt: null,
        OR: [
          ...(p.target.productIds.length > 0 ? [{ productId: { in: p.target.productIds } }] : []),
          ...(p.target.categoryIds.length > 0
            ? [{ categoryId: { in: p.target.categoryIds } }]
            : []),
        ],
      },
      select: { ruleId: true },
    });
    const perRule = new Map<string, number>();
    for (const t of held) perRule.set(t.ruleId, (perRule.get(t.ruleId) ?? 0) + 1);
    return [...perRule.values()].some((n) => n >= wanted);
  }

  /** Single create: one rule that covers the legacy single target, or `targets` (row 509); never skips. */
  async create(
    dto: CreateRestrictionDto,
    user: JwtPayload,
  ): Promise<SellingRestrictionListItemDto> {
    const tenantId = this.requireTenant();
    const target = this.createTargets(dto);
    const p = this.prepare({
      target,
      jurisdiction: dto.jurisdiction,
      states: dto.states,
      surface: dto.surface ?? "ALL",
      effectiveFrom: dto.effectiveFrom,
      effectiveTo: dto.effectiveTo,
      reason: dto.reason,
    });
    return this.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
      const written = await this.writeRule(tx, tenantId, p, user, { skipIdentical: false });
      if (!written) throw new NotFoundException("Restriction not found");
      const row: Row | null = await tx.sellingRestriction.findFirst({
        where: { id: written.ruleId, tenantId },
        include: INCLUDE,
      });
      if (!row) throw new NotFoundException("Restriction not found");
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: user.sub,
          impersonatedBy: user.impersonatedBy ?? null,
          action: "selling_restriction.created",
          entityType: "SellingRestriction",
          entityId: row.id,
          // Counts plus ids; never names. `scope` stays for the legacy single-target form.
          meta: {
            ...(dto.targets
              ? {}
              : {
                  scope: dto.categoryId
                    ? { categoryId: dto.categoryId }
                    : { productId: dto.productId },
                }),
            targets: { productIds: target.productIds, categoryIds: target.categoryIds },
            productCount: target.productIds.length,
            categoryCount: target.categoryIds.length,
            jurisdiction: dto.jurisdiction,
            states: p.states,
            surface: row.surface,
            effectiveFrom: p.effectiveFrom.toISOString(),
            effectiveTo: p.effectiveTo?.toISOString() ?? null,
            reason: dto.reason,
          },
        },
      });
      const summaries = await targetSummaries(tx, tenantId, [row.id]);
      return toDto(row, p.now, summaries.get(row.id) ?? EMPTY_TARGET_SUMMARY);
    });
  }

  /**
   * POST /selling-restrictions/bulk (owner Q6): products (1..BULK_RESTRICTION_MAX) or one label become the targets of
   * ONE rule, in ONE transaction with one audit row, or nothing at all. When an identical live rule already holds ALL
   * of them nothing is written and every product is reported skipped. `createdIds` is `[ruleId]` (the web's Undo
   * lifts that one rule).
   */
  async bulkCreate(dto: BulkRestrictionDto, user: JwtPayload): Promise<BulkRestrictionResponse> {
    const tenantId = this.requireTenant();
    const target = this.bulkTargets(dto);
    const p = this.prepare({
      target,
      jurisdiction: dto.jurisdiction,
      states: dto.states,
      surface: dto.surface ?? "BUYER_PORTAL",
      effectiveFrom: dto.effectiveFrom,
      effectiveTo: dto.effectiveTo,
      reason: dto.reason ?? DEFAULT_BULK_REASON,
    });
    return this.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
      const written = await this.writeRule(tx, tenantId, p, user, { skipIdentical: true });
      const byCategory = target.categoryIds.length > 0;
      if (!written) {
        return {
          created: 0,
          skipped: byCategory ? 1 : target.productIds.length,
          createdIds: [],
          ...(byCategory ? {} : { skippedProductIds: target.productIds }),
        };
      }
      const audit: { id: string } = await tx.auditLog.create({
        data: {
          tenantId,
          userId: user.sub,
          impersonatedBy: user.impersonatedBy ?? null,
          action: "selling_restriction.bulk_created",
          entityType: "SellingRestriction",
          entityId: written.ruleId,
          meta: {
            ids: [written.ruleId],
            scope: byCategory
              ? { categoryId: target.categoryIds[0] }
              : { productIds: target.productIds },
            productCount: target.productIds.length,
            categoryCount: target.categoryIds.length,
            states: p.states,
            jurisdiction: p.jurisdiction,
            surface: p.surface,
            effectiveFrom: p.effectiveFrom.toISOString(),
            effectiveTo: p.effectiveTo?.toISOString() ?? null,
            reason: p.reason,
            skippedProductIds: [],
          },
        },
      });
      return {
        created: 1,
        skipped: 0,
        createdIds: [written.ruleId],
        ...(byCategory ? {} : { skippedProductIds: [] }),
        auditId: audit.id,
        ruleId: written.ruleId,
      };
    });
  }

  /**
   * The ONE lift write (single and batch): stamps the lift on exactly `ids`, in this tenant, and only
   * where `liftedAt IS NULL` — so an earlier lift is never overwritten. Returns how many rows it
   * lifted; the caller compares that to what it asked for. Refuses to run with no tenant or no ids:
   * Prisma drops an `undefined` where key, and a many-write must never widen.
   */
  private async liftRules(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ids: readonly string[],
    reason: string,
    user: JwtPayload,
    now: Date,
  ): Promise<number> {
    if (!tenantId || ids.length === 0 || ids.some((id) => !id)) {
      throw new BadRequestException("Name at least one restriction to lift.");
    }
    // Row 509: the SAME row lock target add/remove take (rule-lock.ts), in id order so two batches cannot deadlock:
    // a lift waits for an in-flight target edit, and an edit that starts after it sees the rule lifted.
    const locked = await tx.$queryRaw<Array<{ id: string; jurisdiction: string }>>`
      SELECT "id", "jurisdiction"::text AS "jurisdiction" FROM "SellingRestriction"
      WHERE "tenantId" = ${tenantId} AND "id" = ANY(${[...ids]}::text[])
      ORDER BY "id" FOR UPDATE`;
    // Who may lift: an all-customer rule is TENANT_ADMIN-only, as for every other write to it (rule-lock.ts). One such
    // rule in a batch refuses the whole call, before anything is written.
    for (const rule of locked ?? []) assertMayManageRule(user, rule);
    const { count } = await tx.sellingRestriction.updateMany({
      where: { tenantId, id: { in: [...ids] }, liftedAt: null },
      data: {
        liftedAt: now,
        liftedById: user.sub,
        liftedByName: user.username,
        liftReason: reason,
      },
    });
    return count;
  }

  /** Lifts a rule now, through the guarded `liftRules`: a double lift is a 409, never an overwrite. */
  async lift(
    id: string,
    dto: LiftRestrictionDto,
    user: JwtPayload,
  ): Promise<SellingRestrictionListItemDto> {
    const tenantId = this.requireTenant();
    const now = new Date();
    return this.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
      const count = await this.liftRules(tx, tenantId, [id], dto.reason, user, now);
      const row: Row | null = await tx.sellingRestriction.findFirst({
        where: { id },
        include: INCLUDE,
      });
      if (!row) throw new NotFoundException("Restriction not found");
      if (count === 0) throw new ConflictException("This restriction has already been lifted.");
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: user.sub,
          impersonatedBy: user.impersonatedBy ?? null,
          action: "selling_restriction.lifted",
          entityType: "SellingRestriction",
          entityId: id,
          meta: { reason: dto.reason },
        },
      });
      return toDto(row, now);
    });
  }

  /**
   * POST /selling-restrictions/lift-batch: lifts every named rule or none. One transaction: a read
   * names any id that is unknown here (another tenant's reads the same) or already lifted — a 409
   * before any write — then ONE guarded write; if it lifts fewer rows than asked (a concurrent lift
   * won a row), the 409 rolls the whole batch back. One audit row.
   */
  async liftBatch(
    dto: { ids: string[]; reason?: string },
    user: JwtPayload,
  ): Promise<LiftBatchResponse> {
    const tenantId = this.requireTenant();
    const ids = [...new Set(dto.ids ?? [])];
    if (ids.length === 0) throw new BadRequestException("Name at least one restriction to lift.");
    if (ids.length > BULK_RESTRICTION_MAX) {
      throw new BadRequestException(`Lift at most ${BULK_RESTRICTION_MAX} limits at once.`);
    }
    const reason = dto.reason ?? DEFAULT_LIFT_REASON;
    const now = new Date();
    return this.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
      const rows = await tx.sellingRestriction.findMany({
        where: { tenantId, id: { in: ids } },
        select: { id: true, liftedAt: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const notFoundIds = ids.filter((id) => !byId.has(id));
      const alreadyLiftedIds = ids.filter((id) => byId.get(id)?.liftedAt);
      if (notFoundIds.length > 0 || alreadyLiftedIds.length > 0) {
        throw liftConflict(notFoundIds, alreadyLiftedIds);
      }
      const count = await this.liftRules(tx, tenantId, ids, reason, user, now);
      if (count !== ids.length) throw liftConflict([], []);
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: user.sub,
          impersonatedBy: user.impersonatedBy ?? null,
          action: "selling_restriction.batch_lifted",
          entityType: "SellingRestriction",
          entityId: null,
          meta: { ids, reason },
        },
      });
      return { lifted: count, ids };
    });
  }

  /**
   * GET /selling-restrictions?productId=: every ACTIVE rule binding the product, for the product-page chips — via
   * a direct product target (PRODUCT), an ancestor's (PARENT), or a label target (CATEGORY) the product is
   * EFFECTIVELY labelled with (`effectiveLabels` applies EXCLUDE opt-outs, so an opted-out label never shows). A rule
   * with zero target rows is read by its legacy column. The same reach as the engine's `evaluate()`. Keyset-paged by
   * id with an opaque cursor; each chip carries the rule's `targetSummary` and whether the product is a direct target.
   */
  async productLimits(productId: string, cursor?: string): Promise<ProductLimitsResponse> {
    const tenantId = this.requireTenant();
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    const labels = (await this.productLabels.effectiveLabels(tenantId, [productId])).get(productId);
    if (!labels?.nameKnown) throw new NotFoundException("Product not found");
    const lineage = [...labels.lineageIds];
    const categoryIds = [...labels.effectiveCategoryIds];
    const now = new Date();
    const touches = [
      { productId: { in: lineage } },
      ...(categoryIds.length > 0 ? [{ categoryId: { in: categoryIds } }] : []),
    ];
    const rows = (await this.prisma.forTenant().sellingRestriction.findMany({
      where: {
        tenantId,
        OR: [
          { targets: { some: { AND: [activeTargetsWhere(now), { OR: touches }] } } },
          { AND: [{ targets: { none: {} } }, { OR: touches }] },
        ],
        AND: [activeRuleWhere(now), ...(after ? [{ id: { gt: after } }] : [])],
      },
      include: {
        ...INCLUDE,
        targets: {
          where: { AND: [activeTargetsWhere(now), { OR: touches }] },
          select: {
            productId: true,
            categoryId: true,
            product: { select: { name: true } },
            category: { select: { name: true } },
          },
        },
        _count: { select: { targets: true } },
      },
      orderBy: { id: "asc" },
      take: PRODUCT_LIMITS_PAGE_SIZE + 1,
    })) as ChipRow[];
    const page = rows.slice(0, PRODUCT_LIMITS_PAGE_SIZE);
    const summaries = await targetSummaries(
      this.prisma.forTenant(),
      tenantId,
      page.map((r) => r.id),
    );
    const lineageSet = new Set(lineage);
    return {
      items: page.map((r) => toProductLimit(r, productId, lineageSet, summaries.get(r.id))),
      nextCursor:
        rows.length > PRODUCT_LIMITS_PAGE_SIZE ? encodeCursor(page[page.length - 1].id) : null,
    };
  }
}
