import { BadRequestException, ConflictException } from "@nestjs/common";
import type { TenantBucket, TenantBucketCounts } from "@routeflow/types";
import type { MrrService } from "../billing/mrr.service";
import {
  BUCKET_SET,
  classifyTenantBucket,
  isPayingScanRow,
  type TenantBucketInput,
  type TenantBucketResult,
} from "../billing/tenant-bucket";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * SA-1535 / W-1462 PR-1: the super admin tenant list with business tabs. One slim scan of the businesses matching search
 * and plan (id + the helper's inputs), classified in JS by `classifyTenantBucket`, gives every tab's count; the open
 * tab's page is then fetched in full by id. Above `TENANT_BUCKET_SCAN_CAP` a bucket or attention request is refused with
 * a coded 409 (never a partial page that looks complete) and the plain list still pages with no counts. The follow-up at
 * that size is a Prisma `where` per bucket with a parity spec (the payingWhere shape).
 */
export const TENANT_BUCKET_SCAN_CAP = 5000;
/** `GET platform-admin/tenants?limit=` above this is a 400 (the web sends 50). */
export const TENANT_LIST_MAX_LIMIT = 200;

const SCAN_SELECT = {
  id: true,
  slug: true,
  class: true,
  status: true,
  deletedAt: true,
  trialEndsAt: true,
  readOnlyReason: true,
  subscription: {
    select: {
      planKey: true,
      couponFull: true,
      pastDueSince: true,
      needsReconcile: true,
      cancelAtPeriodEnd: true,
      stripeSubId: true,
      stripeCustomerId: true,
      catchupState: true,
      // the price class inputs (SA-1539); they never ride on the wire row
      basePriceSnapshot: true,
      discount: true,
    },
  },
} as const;

type ScanRow = TenantBucketInput & {
  id: string;
  subscription:
    | (NonNullable<TenantBucketInput["subscription"]> & {
        basePriceSnapshot: unknown;
        discount: unknown;
      })
    | null;
};

/**
 * Classify rows (a scan, or the one detail row): the rows where the helper says isPayingRow is true are priced in ONE
 * add-on read by MrrService, and every row gets its verdict. No pricing and no paying rule in this file.
 */
export async function classifyRows(
  mrr: Pick<MrrService, "payingPriceClasses">,
  rows: ScanRow[],
  now: Date,
): Promise<Map<string, TenantBucketResult>> {
  const candidates = rows.filter((r) => isPayingScanRow(r));
  const classes = await mrr.payingPriceClasses(
    candidates.map((r) => ({
      tenantId: r.id,
      basePriceSnapshot: r.subscription?.basePriceSnapshot,
      discount: r.subscription?.discount,
    })),
  );
  return new Map(rows.map((r) => [r.id, classifyTenantBucket(r, classes.get(r.id) ?? null, now)]));
}

export function parseBucketParam(raw: string | null | undefined): TenantBucket[] | null {
  if (raw == null) return null;
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const unknown = parts.filter((p) => !Object.prototype.hasOwnProperty.call(BUCKET_SET, p));
  if (unknown.length > 0) {
    throw new BadRequestException(
      `Unknown bucket "${unknown[0]}". Use one of: ${Object.keys(BUCKET_SET).join(", ")}.`,
    );
  }
  return [...new Set(parts)] as TenantBucket[];
}

export function assertListLimit(limit: number): void {
  if (limit > TENANT_LIST_MAX_LIMIT) {
    throw new BadRequestException(`limit must be ${TENANT_LIST_MAX_LIMIT} or less.`);
  }
}

/** The four explicit top-level fields a list row and the detail page gain. */
export function tenantBucketWire(t: { class: string }, verdict: TenantBucketResult) {
  return {
    class: t.class,
    bucket: verdict.bucket,
    attention: verdict.attention,
    trialDaysLeft: verdict.trialDaysLeft,
  };
}

const zeroCounts = (): TenantBucketCounts =>
  Object.fromEntries(Object.keys(BUCKET_SET).map((b) => [b, 0])) as TenantBucketCounts;

export interface TenantListQuery {
  /** Search and plan only: status, deleted and bucket are applied here, in JS, over the scan. */
  scopeWhere: Record<string, unknown>;
  orderBy: Record<string, unknown>;
  page: number;
  limit: number;
  status: string | null;
  includeDeleted: boolean;
  buckets: TenantBucket[] | null;
  attention: boolean;
  /** The full-row include for the page fetch. */
  include: Record<string, unknown>;
  now?: Date;
}

export async function listTenantsByBucket(
  prisma: PrismaService,
  mrr: Pick<MrrService, "payingPriceClasses">,
  q: TenantListQuery,
) {
  const now = q.now ?? new Date();
  const skip = (q.page - 1) * q.limit;
  // `id` last: a stable order, so a page boundary never repeats or skips a row between two calls.
  const orderBy = [q.orderBy, { id: "asc" }];
  const wantsBuckets = q.buckets != null || q.attention;

  const scan = (await prisma.tenant.findMany({
    where: q.scopeWhere,
    orderBy,
    take: TENANT_BUCKET_SCAN_CAP + 1,
    select: SCAN_SELECT,
  } as never)) as unknown as ScanRow[];
  // Total soft-deleted businesses, independent of every filter, so "Show deleted (N)" has a real count.
  const countDeleted = () => prisma.tenant.count({ where: { deletedAt: { not: null } } });

  if (scan.length > TENANT_BUCKET_SCAN_CAP) {
    if (wantsBuckets) {
      throw new ConflictException({
        statusCode: 409,
        code: API_ERROR_CODES.TENANT_BUCKET_SCAN_CAP_EXCEEDED,
        message: `There are more than ${TENANT_BUCKET_SCAN_CAP} businesses, so tabs and counts are not available. Use search or a plan filter to narrow the list.`,
      });
    }
    const where = {
      ...q.scopeWhere,
      ...(q.includeDeleted ? {} : { deletedAt: null }),
      ...(q.status ? { status: q.status } : {}),
    };
    const [tenants, total, deletedCount] = await Promise.all([
      prisma.tenant.findMany({
        where,
        skip,
        take: q.limit,
        orderBy,
        include: q.include,
      } as never),
      prisma.tenant.count({ where } as never),
      countDeleted(),
    ]);
    return {
      tenants: tenants as any[],
      meta: {
        total,
        page: q.page,
        limit: q.limit,
        pages: Math.ceil(total / q.limit),
        deletedCount,
        bucketCounts: null,
        attentionCount: null,
        truncated: true,
      },
      verdicts: new Map<string, TenantBucketResult>(),
    };
  }

  const bucketCounts = zeroCounts();
  let attentionCount = 0;
  const shown: string[] = [];
  const wanted = q.buckets ? new Set<TenantBucket>(q.buckets) : null;
  const verdicts = await classifyRows(mrr, scan, now);
  for (const r of scan) {
    const c = verdicts.get(r.id)!;
    const deleted = r.deletedAt != null;
    // A deleted business of the real-customer class is always under Closed; any other deleted row only with the toggle.
    const counted = !deleted || q.includeDeleted || c.bucket === "closed";
    if (counted) {
      bucketCounts[c.bucket] += 1;
      if (c.attention.length > 0) attentionCount += 1;
    }
    const visible =
      !deleted || q.includeDeleted || (wanted?.has("closed") && c.bucket === "closed");
    if (!visible) continue;
    if (wanted && !wanted.has(c.bucket)) continue;
    if (q.status && r.status !== q.status) continue;
    if (q.attention && c.attention.length === 0) continue;
    shown.push(r.id);
  }

  const pageIds = shown.slice(skip, skip + q.limit);
  const fetched =
    pageIds.length === 0
      ? []
      : ((await prisma.tenant.findMany({
          where: { id: { in: pageIds } },
          include: q.include,
        } as never)) as unknown as Array<{ id: string }>);
  const byId = new Map(fetched.map((t) => [t.id, t]));
  const tenants = pageIds.map((id) => byId.get(id)).filter((t): t is { id: string } => t != null);

  return {
    tenants: tenants as any[],
    meta: {
      total: shown.length,
      page: q.page,
      limit: q.limit,
      pages: Math.ceil(shown.length / q.limit),
      deletedCount: await countDeleted(),
      bucketCounts,
      attentionCount,
      truncated: false,
    },
    verdicts,
  };
}
