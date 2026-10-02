import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, FeatureOverrideKind } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { isRegisteredFeatureKey } from "./feature-registry";
import {
  FEATURE_OVERRIDE_AUDIT_ENTITY_TYPE,
  FEATURE_OVERRIDE_EXPIRED_REVIEW_ACTION,
} from "./feature-override-audit.constants";
import { API_ERROR_CODES } from "../common/api-error-codes";

export type FeatureOverrideEffect = "GRANT" | "DENY";
export type { FeatureOverrideKind };

export interface CreateFeatureOverrideParams {
  tenantId: string;
  featureKey: string;
  effect: FeatureOverrideEffect;
  // Feature grants v2 PR-3 (brief B): why the override exists, for MRR-truth + the console's
  // "why" trace. Optional — defaults to COMP (a plain comp, never a Stripe item / never MRR)
  // when the caller omits it, matching the column's own `@default(COMP)` for every pre-PR-3
  // row. Imported straight from `@prisma/client` (a real npm dep, safe to value-import at API
  // runtime) rather than hand-typed — unlike the DTO layer, which deliberately avoids a VALUE
  // import from the @routeflow/types workspace package (L-151: crashes prod boot).
  kind?: FeatureOverrideKind;
  reason: string;
  expiresAt: Date | null;
  createdById: string | null;
}

const CACHE_TTL_MS = 30_000;

/** `revokeExpired` scans expired overrides this many rows at a time, for review-flagged ones. */
const SCAN_PAGE_SIZE = 500;
const MAX_SCAN_PAGES = 20;

/** What `revokeExpired()` reports for each row it actually closed. */
export interface RevokedExpiredRow {
  id: string;
  tenantId: string;
  featureKey: string;
  kind: string;
  effect: string;
  expiresAt: Date | null;
}

interface CachedRow {
  featureKey: string;
  effect: FeatureOverrideEffect;
  expiresAt: Date | null;
}

interface CacheEntry {
  rows: CachedRow[];
  cacheExpiresAt: number;
}

/**
 * Per-tenant entitlement overrides. When a non-revoked, non-expired row exists for
 * (tenantId, featureKey) it decides the gate outright — GRANT allows, DENY denies —
 * regardless of plan/addon state or dark/enforced gate mode (owner ruling, feature-grants
 * PR-1): only the absence of a row falls through to today's plan+dark behaviour.
 *
 * Mirrors EntitlementsService's own cache shape (30s Map + invalidate/invalidateAll) so the
 * two collaborators behave identically to callers already familiar with one of them.
 */
@Injectable()
export class FeatureOverrideService {
  private readonly logger = new Logger(FeatureOverrideService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Non-revoked rows for a tenant, cached 30s. `revokedAt` is filtered at the DB query (a
   * write-driven state, fully covered by invalidate() on every create()/revoke()) but
   * `expiresAt` is deliberately NOT filtered here — it drifts stale purely by wall-clock time
   * within an otherwise-valid cache window, so it is rechecked on every read in effectAt().
   */
  private async activeRows(tenantId: string): Promise<CachedRow[]> {
    const now = Date.now();
    const cached = this.cache.get(tenantId);
    if (cached && cached.cacheExpiresAt > now) return cached.rows;

    const rows = await this.prisma.tenantFeatureOverride.findMany({
      where: { tenantId, revokedAt: null },
      select: { featureKey: true, effect: true, expiresAt: true },
    });
    const value = rows.map((r) => ({
      featureKey: r.featureKey,
      effect: r.effect,
      expiresAt: r.expiresAt,
    }));
    this.cache.set(tenantId, { rows: value, cacheExpiresAt: now + CACHE_TTL_MS });
    if (this.cache.size > 1000) this.pruneExpired(now);
    return value;
  }

  private effectAt(
    rows: CachedRow[],
    featureKey: string,
    now: number,
  ): FeatureOverrideEffect | null {
    const row = rows.find(
      (r) => r.featureKey === featureKey && (r.expiresAt === null || r.expiresAt.getTime() > now),
    );
    return row?.effect ?? null;
  }

  /**
   * The active override effect for one key, or null when none applies. Fails open to null on
   * a DB error — every consulting guard/read path then falls back to its plan-only decision,
   * never a 500 into a guarded route.
   */
  async get(tenantId: string, featureKey: string): Promise<FeatureOverrideEffect | null> {
    try {
      const rows = await this.activeRows(tenantId);
      return this.effectAt(rows, featureKey, Date.now());
    } catch (err) {
      this.logger.error(
        `Override lookup failed for tenant ${tenantId} key ${featureKey}`,
        err as Error,
      );
      return null;
    }
  }

  /** Batch form for an any-of key set (AddonGuard). Same fail-open contract as get(). */
  async getMany(
    tenantId: string,
    featureKeys: readonly string[],
  ): Promise<Map<string, FeatureOverrideEffect>> {
    try {
      const rows = await this.activeRows(tenantId);
      const now = Date.now();
      const result = new Map<string, FeatureOverrideEffect>();
      for (const key of featureKeys) {
        const effect = this.effectAt(rows, key, now);
        if (effect) result.set(key, effect);
      }
      return result;
    } catch (err) {
      this.logger.error(`Override lookup failed for tenant ${tenantId}`, err as Error);
      return new Map();
    }
  }

  /**
   * Every active override for a tenant, keyed by featureKey — for a caller that needs the
   * full set rather than a specific candidate list (e.g. /tenants/me/addons, which must also
   * surface a GRANT-overridden key the tenant holds no addon row for at all). Same fail-open
   * contract as get()/getMany().
   */
  async allActive(tenantId: string): Promise<Map<string, FeatureOverrideEffect>> {
    try {
      const rows = await this.activeRows(tenantId);
      const now = Date.now();
      const result = new Map<string, FeatureOverrideEffect>();
      for (const row of rows) {
        const effect = this.effectAt(rows, row.featureKey, now);
        if (effect) result.set(row.featureKey, effect);
      }
      return result;
    } catch (err) {
      this.logger.error(`Override lookup failed for tenant ${tenantId}`, err as Error);
      return new Map();
    }
  }

  /** Every row (including revoked/expired) for the platform-admin history table. */
  async list(tenantId: string) {
    return this.prisma.tenantFeatureOverride.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
  }

  async create(params: CreateFeatureOverrideParams) {
    if (!isRegisteredFeatureKey(params.featureKey)) {
      throw new BadRequestException({
        statusCode: 400,
        code: API_ERROR_CODES.FEATURE_KEY_UNKNOWN,
        message: `"${params.featureKey}" is not a registered feature key.`,
      });
    }
    // Opus review of 8130b204, item 7a: an already-past expiresAt would create a row that is
    // never active for even one read — a nonsensical state to allow, not just a redundant one.
    if (params.expiresAt && params.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException({
        statusCode: 400,
        code: API_ERROR_CODES.EXPIRES_AT_MUST_BE_FUTURE,
        message: "expiresAt must be in the future.",
      });
    }
    try {
      // The partial unique index is `WHERE revokedAt IS NULL` -- an expired-but-never-revoked
      // row still counts toward it, blocking a re-grant/re-deny of the same key until someone
      // manually revokes the stale row (Opus review of 8130b204, item 5). Auto-close it first;
      // updateMany no-ops (0 rows) in the common case where nothing has expired.
      await this.prisma.tenantFeatureOverride.updateMany({
        where: {
          tenantId: params.tenantId,
          featureKey: params.featureKey,
          revokedAt: null,
          expiresAt: { lte: new Date() },
        },
        data: { revokedAt: new Date() },
      });
      const row = await this.prisma.tenantFeatureOverride.create({
        data: {
          tenantId: params.tenantId,
          featureKey: params.featureKey,
          effect: params.effect,
          // Explicit default here (not just the column's own `@default(COMP)`) so a caller
          // that omits `kind` gets a value it can read straight back off the returned row —
          // e.g. the controller's audit payload, which logs the row's actual persisted kind.
          kind: params.kind ?? "COMP",
          reason: params.reason,
          expiresAt: params.expiresAt,
          createdById: params.createdById,
        },
      });
      this.invalidate(params.tenantId);
      return row;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException(
          `An active override already exists for "${params.featureKey}" on this tenant — revoke it first.`,
        );
      }
      throw e;
    }
  }

  async revoke(tenantId: string, id: string) {
    try {
      // `where: { id, tenantId }` -- not just `{ id }` (Opus review of 8130b204, item 3): id
      // alone would let tenant B revoke tenant A's row by id under tenant B's URL, mis-audited
      // and mis-invalidated (tenant A's own cache never cleared). Prisma enforces both
      // conditions together and throws P2025 when the row doesn't belong to this tenant.
      const row = await this.prisma.tenantFeatureOverride.update({
        where: { id, tenantId },
        data: { revokedAt: new Date() },
      });
      this.invalidate(tenantId);
      return row;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
        throw new NotFoundException(`No feature override "${id}" found for this tenant.`);
      }
      throw e;
    }
  }

  /**
   * B569 expiry sweep — revokes every row whose `expiresAt` has passed, freeing the partial
   * unique index slot (`WHERE revokedAt IS NULL`) an expired-but-never-revoked row would keep.
   * Returns the rows it ACTUALLY revoked so the caller can audit exactly those.
   *
   * Never touches a row without an `expiresAt` (`not: null`, explicit rather than relying on
   * SQL's NULL <= x being false) and never re-touches a revoked one (`revokedAt: null` in both
   * the select and the write), so a second run is a no-op that keeps the first `revokedAt`.
   * Row-by-row with the tenant in the write's `where` for the same cross-tenant reason as
   * `revoke()`; a P2025 (a human revoked it between select and write) is a skip, not an error.
   * Capped per call, oldest `expiresAt` first (id breaks ties, so the order — and therefore which
   * rows a capped batch takes — is total and repeatable), so a backlog drains FIFO across nightly
   * ticks. A row is taken ONLY once the review job has flagged it (its once-ever
   * `FEATURE_OVERRIDE_EXPIRED_REVIEW` audit row exists — B589), so a missed review tick can never
   * cost a row its review audit: the sweep simply waits for the flag (slot latency is unchanged:
   * a row expiring at 06:31 is flagged next 06:00 and swept at 06:30 — up to ~24h, more if the
   * review job's 500/tick cap is saturated). `graceMs` only additionally
   * takes rows expired at least that long ago; it is required, never defaulted.
   */
  async revokeExpired(
    now: Date,
    {
      limit = 500,
      graceMs,
      inTransaction,
    }: {
      limit?: number;
      /**
       * Only rows expired at least this long ago. Explicit on purpose (no silent default):
       * pass 0 to take every review-flagged row.
       */
      graceMs: number;
      /**
       * Runs INSIDE the same transaction as each row's revoke (B580): whatever it writes (the
       * sweep's audit row) commits or rolls back TOGETHER with that row's `revokedAt`. Before
       * this the revokes committed one by one and the caller audited only after the whole batch
       * returned, so a DB error at row N threw away the audit rows of rows 1..N-1 — already
       * revoked, so no later sweep would ever see them again.
       */
      inTransaction?: (tx: Prisma.TransactionClient, row: RevokedExpiredRow) => Promise<void>;
    },
  ): Promise<RevokedExpiredRow[]> {
    const due = await this.selectReviewedExpired(new Date(now.getTime() - graceMs), limit);
    const revoked: RevokedExpiredRow[] = [];
    for (const row of due) {
      try {
        // One transaction PER ROW: a failure on row N leaves rows 1..N-1 fully done (revoked AND
        // audited) and row N untouched (still unrevoked, so a later sweep retries it). The error
        // is rethrown, so rows N+1.. wait for that next sweep too — deliberate: a failing head
        // row surfaces as a failed cron run instead of being swallowed.
        await this.prisma.$transaction(async (tx) => {
          await tx.tenantFeatureOverride.update({
            where: { id: row.id, tenantId: row.tenantId, revokedAt: null },
            data: { revokedAt: now },
          });
          if (inTransaction) await inTransaction(tx, row);
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") continue;
        throw e;
      }
      this.invalidate(row.tenantId);
      revoked.push(row);
    }
    return revoked;
  }

  /**
   * The rows `revokeExpired` may take: expired + unrevoked + already review-flagged, oldest first
   * (`expiresAt`, then `id`), at most `limit`. AuditLog has no relation to the override, so the
   * flag is checked a page at a time (`entityId IN page`) and pages are scanned until `limit`
   * flagged rows are found — an unflagged head of the queue can never starve the flagged rows
   * behind it. Bounded at MAX_SCAN_PAGES pages; hitting either bound is logged, because a full
   * batch looks exactly like an empty one from outside.
   */
  private async selectReviewedExpired(cutoff: Date, limit: number): Promise<RevokedExpiredRow[]> {
    const due: RevokedExpiredRow[] = [];
    let scanned = 0;
    let cursor: { id: string } | undefined;
    for (let page = 0; page < MAX_SCAN_PAGES; page++) {
      const chunk = await this.prisma.tenantFeatureOverride.findMany({
        where: { revokedAt: null, expiresAt: { not: null, lte: cutoff } },
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
        take: SCAN_PAGE_SIZE,
        ...(cursor ? { cursor, skip: 1 } : {}),
        select: {
          id: true,
          tenantId: true,
          featureKey: true,
          kind: true,
          effect: true,
          expiresAt: true,
        },
      });
      if (chunk.length === 0) break;
      scanned += chunk.length;
      const flagged = new Set(
        (
          await this.prisma.auditLog.findMany({
            where: {
              action: FEATURE_OVERRIDE_EXPIRED_REVIEW_ACTION,
              entityType: FEATURE_OVERRIDE_AUDIT_ENTITY_TYPE,
              entityId: { in: chunk.map((r) => r.id) },
            },
            select: { entityId: true },
          })
        ).map((a) => a.entityId),
      );
      for (const row of chunk) {
        if (!flagged.has(row.id)) continue;
        due.push(row);
        if (due.length >= limit) {
          this.logger.warn(
            `revokeExpired hit its batch cap of ${limit} — more review-flagged expired ` +
              `overrides may be waiting; the next sweep continues from the oldest.`,
          );
          return due;
        }
      }
      if (chunk.length < SCAN_PAGE_SIZE) break;
      cursor = { id: chunk[chunk.length - 1].id };
      if (page === MAX_SCAN_PAGES - 1) {
        this.logger.warn(
          `revokeExpired scanned ${MAX_SCAN_PAGES * SCAN_PAGE_SIZE} expired overrides without ` +
            `exhausting them — rows beyond that are not considered until the head clears.`,
        );
      }
    }
    if (due.length === 0 && scanned > 0) {
      // The sweep now depends on the review job's flag (B589): if that job stops flagging, this
      // is the ONLY signal that expired rows are piling up unswept (they hold the unique-index slot).
      this.logger.warn(
        `revokeExpired: ${scanned} expired override(s) are waiting on billing.reviewExpiredOverrides ` +
          `to flag them; none swept. If this repeats, check that job.`,
      );
    }
    return due;
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.cacheExpiresAt <= now) this.cache.delete(key);
    }
  }
}
