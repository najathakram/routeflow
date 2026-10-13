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

/** The opaque keyset cursor of the chips list: the last id of the page, base64url-wrapped. */
function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const id = (parsed as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.length > 0 && id.length <= 64) return id;
  } catch {
    /* fall through to the 400 */
  }
  throw new BadRequestException("That page cursor is not valid. Reload the list.");
}

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

/** What single and bulk create hand the shared validation path. */
interface RuleInput {
  categoryId?: string;
  productIds?: string[];
  jurisdiction: RestrictionJurisdiction;
  states?: string[];
  surface: RestrictionSurface;
  effectiveFrom?: string;
  effectiveTo?: string;
  reason: string;
}

/** A validated create: one target scope, normalised states, a checked window. */
interface PreparedRules {
  target: { categoryId: string } | { productIds: string[] };
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

/** One chip: how the rule reaches `productId` (its own, an ancestor's, or a category's), and through what. */
function toProductLimit(row: Row, productId: string): ProductLimitDto {
  const via = row.categoryId ? "CATEGORY" : row.productId === productId ? "PRODUCT" : "PARENT";
  return {
    id: row.id,
    jurisdiction: row.jurisdiction,
    states: row.states,
    surface: row.surface,
    reason: row.reason,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
    via,
    viaLabel:
      via === "CATEGORY"
        ? (row.category?.name ?? null)
        : via === "PARENT"
          ? (row.product?.name ?? null)
          : null,
    liftedAt: row.liftedAt ? row.liftedAt.toISOString() : null,
  };
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
    return rows.map((r) => toDto(r, now));
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
   * The ONE validation path for single and bulk create (pure; no reads): exactly one target
   * (a category, or 1..BULK_RESTRICTION_MAX products), the states rules, the date window.
   */
  private prepare(input: RuleInput): PreparedRules {
    const productIds = [...new Set(input.productIds ?? [])];
    if (!input.categoryId === (productIds.length === 0)) {
      throw new BadRequestException("Target exactly one of a category or a product.");
    }
    if (productIds.length > BULK_RESTRICTION_MAX) {
      throw new BadRequestException(
        `Send at most ${BULK_RESTRICTION_MAX} products at once, or limit a whole category instead.`,
      );
    }
    const states = this.normalizeStates(input.jurisdiction, input.states);
    const now = new Date();
    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : now;
    const effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : null;
    if (effectiveTo && effectiveTo.getTime() <= effectiveFrom.getTime()) {
      throw new BadRequestException("The end date must be after the start date.");
    }
    return {
      target: input.categoryId ? { categoryId: input.categoryId } : { productIds },
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
   * Inside the caller's transaction: the target must be this tenant's (a category that is not
   * archived; every product), identical live rules are skipped when asked, then ONE createMany.
   * Ids are minted here so the audit row and the response can name them.
   */
  private async writeRules(
    tx: Prisma.TransactionClient,
    tenantId: string,
    p: PreparedRules,
    user: JwtPayload,
    opts: { skipIdentical: boolean },
  ): Promise<{ createdIds: string[]; skippedProductIds: string[]; skippedCategory: boolean }> {
    if ("categoryId" in p.target) {
      const cat = await tx.productCategory.findFirst({
        where: { tenantId, id: p.target.categoryId },
      });
      if (!cat) throw new NotFoundException("Category not found");
      if (cat.archivedAt)
        throw new ConflictException("That category is archived. Restore it first.");
    } else {
      const wanted = p.target.productIds;
      const found: Array<{ id: string }> = await tx.product.findMany({
        where: { tenantId, id: { in: wanted } },
        select: { id: true },
      });
      const have = new Set(found.map((r) => r.id));
      const missing = wanted.filter((id) => !have.has(id));
      if (missing.length > 0) {
        throw new NotFoundException(
          wanted.length === 1
            ? "Product not found"
            : `${missing.length} of the products were not found.`,
        );
      }
    }

    const identical = opts.skipIdentical ? await this.identicalTargets(tx, tenantId, p) : new Set();
    const targets: Array<{ categoryId: string | null; productId: string | null }> =
      "categoryId" in p.target
        ? identical.has(p.target.categoryId)
          ? []
          : [{ categoryId: p.target.categoryId, productId: null }]
        : p.target.productIds
            .filter((id) => !identical.has(id))
            .map((id) => ({ categoryId: null, productId: id }));
    const skippedProductIds =
      "productIds" in p.target ? p.target.productIds.filter((id) => identical.has(id)) : [];

    const data = targets.map((t) => ({
      id: randomUUID(),
      tenantId,
      categoryId: t.categoryId,
      productId: t.productId,
      jurisdiction: p.jurisdiction,
      states: p.states,
      surface: p.surface,
      effectiveFrom: p.effectiveFrom,
      effectiveTo: p.effectiveTo,
      reason: p.reason,
      createdById: user.sub,
      createdByName: user.username,
    }));
    if (data.length > 0) await tx.sellingRestriction.createMany({ data });
    return {
      createdIds: data.map((d) => d.id),
      skippedProductIds,
      skippedCategory: "categoryId" in p.target && targets.length === 0,
    };
  }

  /**
   * The targets (product ids, or the category id) that already carry an IDENTICAL live rule:
   * same target, same jurisdiction, same set of states (order and spelling ignored), same surface,
   * not lifted and not expired at `now`, AND a window that COVERS the requested one (starts no
   * later; ends no earlier, or never when the request is open-ended — a future lift is an end).
   * A rule that expires sooner or starts later is not identical: skipping it would leave the
   * target sellable in the gap, so a new rule is written.
   */
  private async identicalTargets(
    tx: Prisma.TransactionClient,
    tenantId: string,
    p: PreparedRules,
  ): Promise<Set<string>> {
    const rows: Array<{
      productId: string | null;
      categoryId: string | null;
      jurisdiction: string;
      states: string[];
      surface: string;
      effectiveFrom: Date;
      effectiveTo: Date | null;
      liftedAt: Date | null;
    }> = await tx.sellingRestriction.findMany({
      where: {
        tenantId,
        ...("categoryId" in p.target
          ? { categoryId: p.target.categoryId }
          : { productId: { in: p.target.productIds } }),
        jurisdiction: p.jurisdiction,
        surface: p.surface,
        AND: [...liveRuleWhere(p.now), ...coveringWindowWhere(p)],
      },
      select: {
        productId: true,
        categoryId: true,
        jurisdiction: true,
        states: true,
        surface: true,
        effectiveFrom: true,
        effectiveTo: true,
        liftedAt: true,
      },
    });
    const key = sortedStatesKey(p.states);
    const out = new Set<string>();
    for (const r of rows) {
      if (r.jurisdiction !== p.jurisdiction || r.surface !== p.surface) continue;
      if (sortedStatesKey(r.states) !== key) continue;
      if (!windowCovers(r, p)) continue;
      const target = r.productId ?? r.categoryId;
      if (target) out.add(target);
    }
    return out;
  }

  /** Single create: a bulk of one (same validation and write path); never skips, keeps its response. */
  async create(
    dto: CreateRestrictionDto,
    user: JwtPayload,
  ): Promise<SellingRestrictionListItemDto> {
    const tenantId = this.requireTenant();
    const p = this.prepare({
      categoryId: dto.categoryId,
      productIds: dto.productId ? [dto.productId] : undefined,
      jurisdiction: dto.jurisdiction,
      states: dto.states,
      surface: dto.surface ?? "ALL",
      effectiveFrom: dto.effectiveFrom,
      effectiveTo: dto.effectiveTo,
      reason: dto.reason,
    });
    return this.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
      const { createdIds } = await this.writeRules(tx, tenantId, p, user, {
        skipIdentical: false,
      });
      const row: Row | null = await tx.sellingRestriction.findFirst({
        where: { id: createdIds[0] },
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
          meta: {
            scope: dto.categoryId ? { categoryId: dto.categoryId } : { productId: dto.productId },
            jurisdiction: dto.jurisdiction,
            states: p.states,
            surface: row.surface,
            effectiveFrom: p.effectiveFrom.toISOString(),
            effectiveTo: p.effectiveTo?.toISOString() ?? null,
            reason: dto.reason,
          },
        },
      });
      return toDto(row, p.now);
    });
  }

  /**
   * POST /selling-restrictions/bulk: products (1..BULK_RESTRICTION_MAX) or one category, in ONE
   * transaction — one createMany and one audit row, or nothing at all. A target that already has
   * an identical live rule is skipped and reported, never duplicated.
   */
  async bulkCreate(dto: BulkRestrictionDto, user: JwtPayload): Promise<BulkRestrictionResponse> {
    const tenantId = this.requireTenant();
    const p = this.prepare({
      categoryId: dto.categoryId,
      productIds: dto.productIds,
      jurisdiction: dto.jurisdiction,
      states: dto.states,
      surface: dto.surface ?? "BUYER_PORTAL",
      effectiveFrom: dto.effectiveFrom,
      effectiveTo: dto.effectiveTo,
      reason: dto.reason ?? DEFAULT_BULK_REASON,
    });
    return this.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
      const { createdIds, skippedProductIds, skippedCategory } = await this.writeRules(
        tx,
        tenantId,
        p,
        user,
        { skipIdentical: true },
      );
      const skipped = skippedProductIds.length + (skippedCategory ? 1 : 0);
      const base: BulkRestrictionResponse = {
        created: createdIds.length,
        skipped,
        createdIds,
        ...("productIds" in p.target ? { skippedProductIds } : {}),
      };
      if (createdIds.length === 0) return base;
      const audit: { id: string } = await tx.auditLog.create({
        data: {
          tenantId,
          userId: user.sub,
          impersonatedBy: user.impersonatedBy ?? null,
          action: "selling_restriction.bulk_created",
          entityType: "SellingRestriction",
          entityId: null,
          meta: {
            ids: createdIds,
            scope: p.target,
            states: p.states,
            jurisdiction: p.jurisdiction,
            surface: p.surface,
            effectiveFrom: p.effectiveFrom.toISOString(),
            effectiveTo: p.effectiveTo?.toISOString() ?? null,
            reason: p.reason,
            skippedProductIds,
          },
        },
      });
      return { ...base, auditId: audit.id };
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
   * GET /selling-restrictions?productId=: every ACTIVE rule binding the product, for the product-page
   * chips — its own (PRODUCT), an ancestor's (PARENT), and a category it is EFFECTIVELY labelled
   * with (CATEGORY; `effectiveLabels` applies EXCLUDE opt-outs, so an opted-out category never
   * shows). The same reach as the engine's `evaluate()`. Keyset-paged by id with an opaque cursor.
   */
  async productLimits(productId: string, cursor?: string): Promise<ProductLimitsResponse> {
    const tenantId = this.requireTenant();
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    const labels = (await this.productLabels.effectiveLabels(tenantId, [productId])).get(productId);
    if (!labels?.nameKnown) throw new NotFoundException("Product not found");
    const lineage = [...labels.lineageIds];
    const categoryIds = [...labels.effectiveCategoryIds];
    const now = new Date();
    const rows = await this.prisma.forTenant().sellingRestriction.findMany({
      where: {
        tenantId,
        OR: [
          { productId: { in: lineage } },
          ...(categoryIds.length > 0 ? [{ categoryId: { in: categoryIds } }] : []),
        ],
        AND: [activeRuleWhere(now), ...(after ? [{ id: { gt: after } }] : [])],
      },
      include: INCLUDE,
      orderBy: { id: "asc" },
      take: PRODUCT_LIMITS_PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PRODUCT_LIMITS_PAGE_SIZE);
    return {
      items: page.map((r) => toProductLimit(r, productId)),
      nextCursor:
        rows.length > PRODUCT_LIMITS_PAGE_SIZE ? encodeCursor(page[page.length - 1].id) : null,
    };
  }
}
