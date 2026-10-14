import { BadRequestException, Injectable } from "@nestjs/common";
import type {
  UnknownStateBucket,
  UnknownStateBucketName,
  UnknownStateCustomerRow,
  UnknownStateCustomersResponse,
} from "@routeflow/types";
import { US_STATES } from "../common/us-states";
import { excludeWalkIn } from "../customers/walk-in-protected";
import { PrismaService } from "../prisma/prisma.service";
import {
  ENABLE_READINESS_MAX_PAGES,
  ENABLE_READINESS_PAGE_SIZE,
  SellingRestrictionsService,
} from "../selling-restrictions/selling-restrictions.service";
import {
  UNKNOWN_STATE_ADDRESS_SELECT,
  UNKNOWN_STATE_BUCKETS,
  UNKNOWN_STATE_PAGE_DEFAULT_API,
  decodeUnknownStateCursor,
  encodeUnknownStateCursor,
  placeUnknownState,
  toRow,
  type UnknownStateCursor,
  type UnknownStateCustomer,
  type UnknownStatePlacement,
} from "./unknown-state";

const STATE_CODES = US_STATES.map((s) => s.code);

/**
 * SQL pre-filter for the three state buckets: every customer that CAN sit in one (no address, or an
 * address with no usable code or flagged for review). A superset — `placeUnknownState` decides
 * exactly. needsDefault cannot be pre-filtered (Prisma cannot say "2+ addresses" or "2+ defaults"),
 * so every read that feeds needsDefault (all totals, a needsDefault page) sweeps every live customer.
 */
const CANDIDATE_WHERE = {
  OR: [
    { addresses: { none: {} } },
    {
      addresses: {
        some: {
          OR: [
            { stateNeedsReview: true },
            { stateCode: null },
            { stateCode: { notIn: STATE_CODES } },
          ],
        },
      },
    },
  ],
};

/** The customer columns a bucket row reads; the nested address select is not tenant-rewritten (as readiness). */
export const UNKNOWN_STATE_CUSTOMER_SELECT = {
  id: true,
  businessName: true,
  addresses: { select: UNKNOWN_STATE_ADDRESS_SELECT },
} as const;

/** One wire row: needsDefault rows carry every address as a choice; the others name the problem address. */
function rowFor(
  customer: UnknownStateCustomer,
  bucket: UnknownStateBucketName,
  placed: UnknownStatePlacement[UnknownStateBucketName],
): UnknownStateCustomerRow {
  if (bucket === "needsDefault") return toRow(customer, null, placed?.others ?? []);
  return toRow(customer, placed?.address ?? null);
}

/** Rows after `after` in (businessName, id) order, compared by the DB in the same collation it sorts with. */
function afterWhere(after: UnknownStateCursor) {
  return {
    OR: [{ businessName: { gt: after.name } }, { businessName: after.name, id: { gt: after.id } }],
  };
}

export interface UnknownStateCustomersParams {
  bucket?: UnknownStateBucketName;
  cursor?: string;
  limit?: number;
}

/**
 * GET /settings/restrictions/unknown-state-customers (Addendum D): the customers whose governing
 * state the engine cannot resolve, split into the four buckets `placeUnknownState` defines, sorted
 * by name then id, keyset-paged per bucket. Customer scope and paging (the retired readiness probe's idiom):
 * live customers of this tenant, the system walk-in excluded by `excludeWalkIn`,
 * read in pages of ENABLE_READINESS_PAGE_SIZE up to ENABLE_READINESS_MAX_PAGES. READ-ONLY.
 */
@Injectable()
export class UnknownStateCustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: SellingRestrictionsService,
  ) {}

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }

  async list(params: UnknownStateCustomersParams): Promise<UnknownStateCustomersResponse> {
    const tenantId = this.requireTenant();
    const limit = params.limit ?? UNKNOWN_STATE_PAGE_DEFAULT_API;
    const after = params.cursor !== undefined ? decodeUnknownStateCursor(params.cursor) : null;
    if (after && !params.bucket) {
      throw new BadRequestException("A page cursor needs the bucket it came from.");
    }
    const { addressPrecedence } = await this.engine.getPolicy(tenantId);
    const businessStateMissing = await this.engine.businessStateMissing(tenantId);

    const totals: Record<UnknownStateBucketName, number> = {
      noAddress: 0,
      unusableState: 0,
      needsReview: 0,
      needsDefault: 0,
    };
    const rows: Record<UnknownStateBucketName, UnknownStateCustomerRow[]> = {
      noAddress: [],
      unusableState: [],
      needsReview: [],
      needsDefault: [],
    };
    const wantsRows = (b: UnknownStateBucketName) =>
      after === null && (params.bucket === undefined || params.bucket === b);
    let customersTotal = 0;
    let truncated = false;

    // Pass 1: every bucket's total (and, with no cursor, each wanted bucket's first page + 1 lookahead).
    // Unfiltered: needsDefault's total needs every customer (the state buckets' results are unchanged).
    truncated = await this.sweep(tenantId, null, false, (customer) => {
      const placement = placeUnknownState(customer, addressPrecedence);
      const names = UNKNOWN_STATE_BUCKETS.filter((b) => placement[b]);
      if (names.length > 0) customersTotal++;
      for (const b of names) {
        totals[b]++;
        if (wantsRows(b) && rows[b].length <= limit) {
          rows[b].push(rowFor(customer, b, placement[b]));
        }
      }
      return false;
    });

    // Pass 2 (a later page): only the named bucket, from the cursor, stopping at the lookahead row.
    if (after && params.bucket) {
      const bucket = params.bucket;
      const pageTruncated = await this.sweep(
        tenantId,
        after,
        bucket !== "needsDefault",
        (customer) => {
          const placed = placeUnknownState(customer, addressPrecedence)[bucket];
          if (placed) rows[bucket].push(rowFor(customer, bucket, placed));
          return rows[bucket].length > limit;
        },
      );
      truncated = truncated || pageTruncated;
    }

    const page = (b: UnknownStateBucketName): UnknownStateBucket => {
      const r = rows[b];
      if (r.length <= limit) return { total: totals[b], rows: r, nextCursor: null };
      const shown = r.slice(0, limit);
      const last = shown[shown.length - 1];
      return {
        total: totals[b],
        rows: shown,
        nextCursor: encodeUnknownStateCursor({ name: last.name, id: last.customerId }),
      };
    };
    return {
      noAddress: page("noAddress"),
      unusableState: page("unusableState"),
      needsReview: page("needsReview"),
      needsDefault: page("needsDefault"),
      customersTotal,
      businessStateMissing,
      truncated,
    };
  }

  /**
   * Visits the customers in (businessName, id) order, in cursor pages (the readiness idiom), until
   * `visit` returns true or the customers run out: only CANDIDATE_WHERE's when `candidatesOnly`, else
   * every live customer. Every query carries the explicit tenantId. Returns true when it stopped at
   * ENABLE_READINESS_MAX_PAGES with more customers left (the counts are partial), as readiness does.
   */
  private async sweep(
    tenantId: string,
    after: UnknownStateCursor | null,
    candidatesOnly: boolean,
    visit: (customer: UnknownStateCustomer) => boolean,
  ): Promise<boolean> {
    const db = this.prisma.forTenant();
    let cursor: string | undefined;
    for (let pages = 0; pages < ENABLE_READINESS_MAX_PAGES; pages++) {
      const page: UnknownStateCustomer[] = await db.customer.findMany({
        where: excludeWalkIn({
          tenantId,
          deletedAt: null,
          AND: [
            ...(candidatesOnly ? [CANDIDATE_WHERE] : []),
            ...(after ? [afterWhere(after)] : []),
          ],
        }),
        orderBy: [{ businessName: "asc" }, { id: "asc" }],
        take: ENABLE_READINESS_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: UNKNOWN_STATE_CUSTOMER_SELECT,
      });
      for (const customer of page) if (visit(customer)) return false;
      if (page.length < ENABLE_READINESS_PAGE_SIZE) return false;
      cursor = page[page.length - 1].id;
    }
    return true;
  }
}
