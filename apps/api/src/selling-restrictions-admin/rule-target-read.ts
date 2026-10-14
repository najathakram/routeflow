import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { RuleTargetKind, RuleTargetSummary, RuleTargetsInput } from "@routeflow/types";
import { RULE_TARGETS_MAX_PER_REQUEST } from "./dto/rule-targets.dto";
import { ruleTargetLimit, ruleTargetsNotFound } from "./rule-errors";

/**
 * Row 509 — the helpers every rule-target reader and writer shares (list, chips, detail, add/remove, create):
 * input normalisation, tenant resolution of ids, the "<Family> - <Variant>" name, the target summary, the legacy
 * zero-target materialisation and the keyset cursor. Nothing here decides who may write (rule-lock.ts) or what the
 * engine matches (selling-restrictions.core.ts).
 */

type Ids = { productIds: string[]; categoryIds: string[] };

/** The raw-SQL surface both a transaction client and the tenant client expose. */
type RawDb = {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ): Promise<T>;
};

/**
 * A target row is active NOW: added on/before `now` and not removed. The SQL twin of the engine's `activeTargetWhere`
 * (a private helper of selling-restrictions.service.ts, which this PR does not edit); kept identical on purpose.
 */
export const activeTargetsWhere = (now: Date) =>
  ({
    addedAt: { lte: now },
    OR: [{ removedAt: null }, { removedAt: { gt: now } }],
  }) satisfies Prisma.SellingRestrictionTargetWhereInput;

/** "<Family> - <Variant>" for a variant, the product's own name otherwise. */
export function ruleTargetName(p: { name: string; parent?: { name: string } | null }): string {
  return p.parent ? `${p.parent.name} - ${p.name}` : p.name;
}

/**
 * Dedupes the ids of a request and enforces its size: at least one id in all (400), at most
 * RULE_TARGETS_MAX_PER_REQUEST in all (coded RULE_TARGET_LIMIT, field "request"). Empty strings are dropped.
 */
export function normalizeTargetIds(input: RuleTargetsInput | undefined): Ids {
  const productIds = [...new Set((input?.productIds ?? []).filter((id) => id !== ""))];
  const categoryIds = [...new Set((input?.categoryIds ?? []).filter((id) => id !== ""))];
  const total = productIds.length + categoryIds.length;
  if (total === 0) {
    throw new BadRequestException("Choose at least one product or label.");
  }
  if (total > RULE_TARGETS_MAX_PER_REQUEST)
    throw ruleTargetLimit("request", RULE_TARGETS_MAX_PER_REQUEST);
  return { productIds, categoryIds };
}

/**
 * Every id must be THIS tenant's product (any kind; a FAMILY covers its variants) or label (non-archived, unless
 * `allowArchivedLabels`: removing an archived label from a rule is fine). Anything else is the coded 409 naming the
 * ids, before the caller writes anything.
 */
export async function resolveTargetIds(
  tx: Prisma.TransactionClient,
  tenantId: string,
  ids: Ids,
  opts: { allowArchivedLabels?: boolean } = {},
): Promise<void> {
  const missing: string[] = [];
  if (ids.productIds.length > 0) {
    const found: Array<{ id: string }> = await tx.product.findMany({
      where: { tenantId, id: { in: ids.productIds } },
      select: { id: true },
    });
    const have = new Set(found.map((r) => r.id));
    for (const id of ids.productIds) if (!have.has(id)) missing.push(id);
  }
  if (ids.categoryIds.length > 0) {
    const found: Array<{ id: string }> = await tx.productCategory.findMany({
      where: {
        tenantId,
        id: { in: ids.categoryIds },
        ...(opts.allowArchivedLabels ? {} : { archivedAt: null }),
      },
      select: { id: true },
    });
    const have = new Set(found.map((r) => r.id));
    for (const id of ids.categoryIds) if (!have.has(id)) missing.push(id);
  }
  if (missing.length > 0) throw ruleTargetsNotFound(missing);
}

/** The rule columns `ensureLegacyTarget` needs. */
export interface LegacyRuleFacts {
  id: string;
  tenantId: string;
  productId: string | null;
  categoryId: string | null;
  createdAt: Date;
  effectiveFrom: Date;
  createdById: string | null;
  createdByName: string | null;
}

/**
 * SA condition 1: a rule with ZERO target rows (ever) is matched by its legacy productId / categoryId. The first
 * edit to such a rule must not change what it covers, so it materialises that column as a real target row first,
 * in the same transaction, dated LEAST(createdAt, effectiveFrom) like the migration's backfill (a backdated rule
 * never reads as ALLOW between its effectiveFrom and createdAt). Call it with the rule row LOCKED.
 */
export async function ensureLegacyTarget(
  tx: Prisma.TransactionClient,
  rule: LegacyRuleFacts,
): Promise<void> {
  if (!rule.id || !rule.tenantId)
    throw new BadRequestException("A rule and a tenant are required.");
  const rows = await tx.sellingRestrictionTarget.count({
    where: { tenantId: rule.tenantId, ruleId: rule.id },
  });
  if (rows > 0) return;
  if (!rule.productId && !rule.categoryId) return;
  await tx.sellingRestrictionTarget.create({
    data: {
      tenantId: rule.tenantId,
      ruleId: rule.id,
      productId: rule.productId,
      categoryId: rule.categoryId,
      addedAt: new Date(Math.min(rule.createdAt.getTime(), rule.effectiveFrom.getTime())),
      addedById: rule.createdById,
      addedByName: rule.createdByName,
    },
  });
}

/** Preview entries on a list card / chip: the first three targets by name. */
export const TARGET_PREVIEW_SIZE = 3;

interface CountRow {
  ruleId: string;
  products: number;
  categories: number;
}
interface PreviewRow {
  ruleId: string;
  kind: RuleTargetKind;
  id: string;
  name: string;
}

/**
 * What each rule covers NOW: how many products and labels, and the first three by name. A rule with ZERO target rows
 * (legacy) is summarised from its productId / categoryId column (the UNION ALL half), so no list or chip loses a
 * pre-509 rule. One count query and one preview query for all `ruleIds`.
 */
export async function targetSummaries(
  db: RawDb,
  tenantId: string,
  ruleIds: readonly string[],
): Promise<Map<string, RuleTargetSummary>> {
  const out = new Map<string, RuleTargetSummary>();
  if (!tenantId || ruleIds.length === 0) return out;
  const ids = [...ruleIds];
  const covered = Prisma.sql`
    SELECT t."ruleId" AS "ruleId", t."id" AS "tid", t."productId" AS "productId", t."categoryId" AS "categoryId"
    FROM "SellingRestrictionTarget" t
    WHERE t."tenantId" = ${tenantId} AND t."ruleId" = ANY(${ids}::text[]) AND t."removedAt" IS NULL
    UNION ALL
    SELECT r."id", r."id", r."productId", r."categoryId"
    FROM "SellingRestriction" r
    WHERE r."tenantId" = ${tenantId} AND r."id" = ANY(${ids}::text[])
      AND NOT EXISTS (SELECT 1 FROM "SellingRestrictionTarget" x WHERE x."ruleId" = r."id")`;
  const counts = await db.$queryRaw<CountRow[]>(Prisma.sql`
    SELECT c."ruleId" AS "ruleId",
           COUNT(*) FILTER (WHERE c."productId" IS NOT NULL)::int AS "products",
           COUNT(*) FILTER (WHERE c."categoryId" IS NOT NULL)::int AS "categories"
    FROM (${covered}) c GROUP BY c."ruleId"`);
  const previews = await db.$queryRaw<PreviewRow[]>(Prisma.sql`
    SELECT n."ruleId" AS "ruleId", n."kind" AS "kind", n."id" AS "id", n."name" AS "name"
    FROM (
      SELECT named.*, ROW_NUMBER() OVER (PARTITION BY named."ruleId" ORDER BY named."name" COLLATE "C", named."tid") AS "rn"
      FROM (
        SELECT c."ruleId" AS "ruleId", c."tid" AS "tid",
               CASE WHEN c."productId" IS NOT NULL THEN 'PRODUCT' ELSE 'CATEGORY' END AS "kind",
               COALESCE(c."productId", c."categoryId") AS "id",
               CASE WHEN c."productId" IS NULL THEN cat."name"
                    WHEN par."name" IS NOT NULL THEN par."name" || ' - ' || p."name"
                    ELSE p."name" END AS "name"
        FROM (${covered}) c
        LEFT JOIN "Product" p ON p."id" = c."productId"
        LEFT JOIN "Product" par ON par."id" = p."parentProductId"
        LEFT JOIN "ProductCategory" cat ON cat."id" = c."categoryId"
      ) named
    ) n
    WHERE n."rn" <= ${TARGET_PREVIEW_SIZE}
    ORDER BY n."ruleId", n."rn"`);
  for (const row of counts) {
    out.set(row.ruleId, { products: row.products, categories: row.categories, preview: [] });
  }
  for (const row of previews) {
    out.get(row.ruleId)?.preview.push({ kind: row.kind, id: row.id, name: row.name });
  }
  return out;
}

/** What a rule with nothing active (should not exist) reports. */
export const EMPTY_TARGET_SUMMARY: RuleTargetSummary = { products: 0, categories: 0, preview: [] };

/** The opaque keyset cursor of the target and chip lists: the last id of the page, base64url-wrapped. */
export function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const id = (parsed as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.length > 0 && id.length <= 64) return id;
  } catch {
    /* fall through to the 400 */
  }
  throw new BadRequestException("That page cursor is not valid. Reload the list.");
}
