import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma, type PolicyScopeType, type PolicyValue } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { LockTimeoutError, LockUnavailableError, withAdvisoryLock } from "../common/db-locks";
import {
  POLICY_REGISTRY,
  policyEntry,
  type PolicyEntry,
  type PolicyKey,
  type PolicyValueOf,
} from "./policy-registry";

/** The request-path scope a caller resolves a policy for. Absent ids skip that layer. */
export interface PolicyScope {
  categoryId?: string | null;
  customerId?: string | null;
}

/** Who wrote a policy value — stamped on the row and on its audit row. */
export interface PolicyActor {
  id: string | null;
  name: string | null;
  /** Platform-admin id when the write happened under impersonation (AuditLog.impersonatedBy). */
  impersonatedBy?: string | null;
}

export interface SetPolicyParams {
  tenantId: string;
  key: string;
  scopeType: PolicyScopeType;
  scopeId?: string | null;
  value: unknown;
  reason: string;
  actor: PolicyActor;
}

export interface ClearPolicyParams {
  tenantId: string;
  key: string;
  scopeType: PolicyScopeType;
  scopeId?: string | null;
  reason: string;
  actor: PolicyActor;
}

export const POLICY_AUDIT_ENTITY_TYPE = "PolicyValue";
export const POLICY_SET_ACTION = "policy.set";
export const POLICY_CLEAR_ACTION = "policy.clear";

interface CachedRow {
  id: string;
  key: string;
  scopeType: PolicyScopeType;
  scopeId: string | null;
  value: unknown;
  createdAt: Date;
}

interface CacheEntry {
  rows: CachedRow[];
  expiresAt: number;
}

/**
 * Same TTL and shape as EntitlementsService / FeatureOverrideService: a per-process Map,
 * `invalidate(tenantId)` on every write, so on more than one replica the TTL is the convergence
 * window for the others (accepted for money policies by the owner, SA-138 Q2). A policy is read
 * when a decision is MADE and the decision is stamped on the row it governs, so a stale read can
 * delay a flip by up to 30 s but can never reinterpret an existing row.
 */
const CACHE_TTL_MS = 30_000;

/** Wait budget on the `policy-write` lock — a settings action, so a loser 503s rather than hangs. */
const WRITE_LOCK_WAIT_MS = 10_000;

/** Layers in resolution order, least → most specific. */
const LAYERS: readonly PolicyScopeType[] = ["TENANT", "CATEGORY", "CUSTOMER"];

/**
 * SA-138 phase 1 — resolves and writes per-tenant POLICY values (policy-registry.ts).
 *
 * `resolve` NEVER throws: a DB error, an unknown key or a stored value that no longer validates
 * all yield the registry default (= today's behaviour) with `logger.error`. Writes are
 * append-only — supersede + insert in one transaction under the `policy-write` advisory lock —
 * and each writes exactly one AuditLog row.
 *
 * Never imported by a `*.guard.ts` (policy-registry.spec.ts P2c): a policy is how the tenant runs
 * its own operation, never whether it may use a capability.
 */
@Injectable()
export class PolicyService {
  private readonly logger = new Logger(PolicyService.name);
  private readonly cache = new Map<string, CacheEntry>();
  /** Bumped by invalidate(): a read that started before a write never re-caches its old rows. */
  private readonly generation = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  // ─── Read ────────────────────────────────────────────────────────────────

  /**
   * The effective value of `key` for `tenantId`: default → TENANT → CATEGORY(scope.categoryId) →
   * CUSTOMER(scope.customerId), the most specific valid layer winning. Never throws.
   */
  async resolve<K extends PolicyKey>(
    tenantId: string,
    key: K,
    scope: PolicyScope = {},
  ): Promise<PolicyValueOf<K>> {
    const entry = policyEntry(key);
    if (!entry) {
      // Unreachable through the typed signature; a cast caller gets `undefined`, never a throw.
      this.logger.error(`Policy resolve for unregistered key "${key}" (tenant ${tenantId})`);
      return undefined as PolicyValueOf<K>;
    }
    try {
      const rows = await this.activeRows(tenantId);
      return this.layer(entry, rows, tenantId, scope) as PolicyValueOf<K>;
    } catch (err) {
      this.logger.error(
        `Policy lookup failed for tenant ${tenantId} key ${key} — using the default`,
        err as Error,
      );
      return entry.default as PolicyValueOf<K>;
    }
  }

  /**
   * The TENANT-scope effective value of every registry key that allows TENANT scope, encoded for
   * `TenantFeaturesResponse.modes` (a `Record<string, string>`): an enum value verbatim, a
   * money/set value as JSON text. Category/customer values never leave the server this way, and
   * neither does an entry marked `clientVisible: false` (the modes record reaches buyer tokens).
   * Never throws (resolve() doesn't).
   */
  async effectiveForClient(tenantId: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const entry of POLICY_REGISTRY as readonly PolicyEntry<unknown>[]) {
      if (!entry.scopes.includes("TENANT") || entry.clientVisible === false) continue;
      const value = await this.resolve(tenantId, entry.key as PolicyKey);
      out[entry.key] =
        entry.kind === "enum" && typeof value === "string" ? value : JSON.stringify(value);
    }
    return out;
  }

  /** Every active row for a tenant, straight from the DB (the admin view — never cached). */
  async listActive(tenantId: string): Promise<PolicyValue[]> {
    return this.prisma.policyValue.findMany({
      where: { tenantId, supersededAt: null },
      orderBy: [{ key: "asc" }, { createdAt: "desc" }],
    });
  }

  /** Superseded rows for one key, newest first (the history drawer). */
  async history(tenantId: string, key: string): Promise<PolicyValue[]> {
    this.requireEntry(key);
    return this.prisma.policyValue.findMany({
      where: { tenantId, key, supersededAt: { not: null } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  }

  /** Drop a tenant's cached rows — called after every write this process makes. */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
    this.generation.set(tenantId, (this.generation.get(tenantId) ?? 0) + 1);
  }

  // ─── Write ───────────────────────────────────────────────────────────────

  /**
   * Validate against the registry (400), then — under the `policy-write` lock — supersede the
   * active row at this (key, scope) and insert the new one plus ONE `policy.set` AuditLog row,
   * all in one transaction. Returns the new row.
   */
  async set(params: SetPolicyParams): Promise<PolicyValue> {
    this.requireMatchingContext(params.tenantId);
    const entry = this.requireEntry(params.key);
    const scopeId = this.requireScope(entry, params.scopeType, params.scopeId);
    const reason = this.requireReason(params.reason);
    const parsed = entry.schema.safeParse(params.value);
    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        code: "POLICY_VALUE_INVALID",
        message: `Invalid value for policy "${entry.key}".`,
        issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }
    await this.requireScopeTarget(params.tenantId, params.scopeType, scopeId);
    const { tenantId, actor } = params;
    // A `null` value (credit.approvalThreshold's "no band") is stored as JSON null — explicit
    // `Prisma.JsonNull`, never SQL NULL (the column is NOT NULL). The audit meta keeps plain null.
    const value = parsed.data as Prisma.InputJsonValue | null;
    const stored = value === null ? Prisma.JsonNull : value;

    const row = await this.underWriteLock(tenantId, entry.key, () =>
      this.prisma.tenantTransaction(async (tx) => {
        const previous: PolicyValue[] = await tx.policyValue.findMany({
          where: {
            tenantId,
            key: entry.key,
            scopeType: params.scopeType,
            scopeId,
            supersededAt: null,
          },
          orderBy: { createdAt: "desc" },
        });
        const created: PolicyValue = await tx.policyValue.create({
          data: {
            tenantId,
            key: entry.key,
            scopeType: params.scopeType,
            scopeId,
            value: stored,
            reason,
            setById: actor.id,
            setByName: actor.name,
          },
        });
        if (previous.length > 0) {
          await tx.policyValue.updateMany({
            where: { tenantId, id: { in: previous.map((p) => p.id) }, supersededAt: null },
            data: { supersededAt: new Date(), supersededById: created.id },
          });
        }
        await tx.auditLog.create({
          data: {
            tenantId,
            userId: actor.id,
            impersonatedBy: actor.impersonatedBy ?? null,
            action: POLICY_SET_ACTION,
            entityType: POLICY_AUDIT_ENTITY_TYPE,
            entityId: created.id,
            meta: {
              key: entry.key,
              scopeType: params.scopeType,
              scopeId,
              old: (previous[0]?.value ?? null) as Prisma.InputJsonValue,
              new: value,
              reason,
            },
          },
        });
        return created;
      }),
    );
    this.invalidate(tenantId);
    return row;
  }

  /**
   * Supersede the active row at this (key, scope) — the next layer (or the default) then wins —
   * plus ONE `policy.clear` AuditLog row, in one transaction under the `policy-write` lock. 404
   * when nothing is set there. Returns the superseded row.
   */
  async clear(params: ClearPolicyParams): Promise<PolicyValue> {
    this.requireMatchingContext(params.tenantId);
    const entry = this.requireEntry(params.key);
    const scopeId = this.requireScope(entry, params.scopeType, params.scopeId);
    const reason = this.requireReason(params.reason);
    const { tenantId, actor } = params;

    const row = await this.underWriteLock(tenantId, entry.key, () =>
      this.prisma.tenantTransaction(async (tx) => {
        const active: PolicyValue[] = await tx.policyValue.findMany({
          where: {
            tenantId,
            key: entry.key,
            scopeType: params.scopeType,
            scopeId,
            supersededAt: null,
          },
          orderBy: { createdAt: "desc" },
        });
        if (active.length === 0) {
          throw new NotFoundException({
            statusCode: 404,
            code: "POLICY_NOT_SET",
            message: `Policy "${entry.key}" has no value at this scope.`,
          });
        }
        const supersededAt = new Date();
        await tx.policyValue.updateMany({
          where: { tenantId, id: { in: active.map((a) => a.id) }, supersededAt: null },
          data: { supersededAt },
        });
        await tx.auditLog.create({
          data: {
            tenantId,
            userId: actor.id,
            impersonatedBy: actor.impersonatedBy ?? null,
            action: POLICY_CLEAR_ACTION,
            entityType: POLICY_AUDIT_ENTITY_TYPE,
            entityId: active[0].id,
            meta: {
              key: entry.key,
              scopeType: params.scopeType,
              scopeId,
              old: active[0].value as Prisma.InputJsonValue,
              new: null,
              reason,
            },
          },
        });
        return { ...active[0], supersededAt, supersededById: null };
      }),
    );
    this.invalidate(tenantId);
    return row;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  /** Active rows for a tenant, cached 30 s (the EntitlementsService shape, pruned past 1000). */
  private async activeRows(tenantId: string): Promise<CachedRow[]> {
    const now = Date.now();
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > now) return cached.rows;

    const gen = this.generation.get(tenantId) ?? 0;
    const rows = await this.prisma.policyValue.findMany({
      where: { tenantId, supersededAt: null },
      select: { id: true, key: true, scopeType: true, scopeId: true, value: true, createdAt: true },
    });
    // An invalidate() that landed during the await means these rows may predate a write this
    // process just made — serve them to this caller, but never cache them.
    if ((this.generation.get(tenantId) ?? 0) === gen) {
      this.cache.set(tenantId, { rows, expiresAt: now + CACHE_TTL_MS });
      if (this.cache.size > 1000) this.pruneExpired(now);
    }
    return rows;
  }

  private pruneExpired(now: number): void {
    for (const [k, v] of this.cache) if (v.expiresAt <= now) this.cache.delete(k);
  }

  /** default → TENANT → CATEGORY → CUSTOMER; an invalid layer is skipped with logger.error. */
  private layer(
    entry: PolicyEntry<unknown>,
    rows: CachedRow[],
    tenantId: string,
    scope: PolicyScope,
  ): unknown {
    let value = entry.default;
    for (const scopeType of LAYERS) {
      if (!entry.scopes.includes(scopeType)) continue;
      const scopeId =
        scopeType === "TENANT"
          ? null
          : scopeType === "CATEGORY"
            ? (scope.categoryId ?? undefined)
            : (scope.customerId ?? undefined);
      if (scopeId === undefined) continue;
      // Newest createdAt among active rows is the defensive tie-break: the write lock keeps one
      // active row per (key, scope), but the resolver must not depend on that for correctness.
      let newest: CachedRow | undefined;
      for (const r of rows) {
        if (r.key !== entry.key || r.scopeType !== scopeType || r.scopeId !== scopeId) continue;
        if (
          !newest ||
          r.createdAt > newest.createdAt ||
          (r.createdAt.getTime() === newest.createdAt.getTime() && r.id > newest.id)
        ) {
          newest = r;
        }
      }
      if (!newest) continue;
      const parsed = entry.schema.safeParse(newest.value);
      if (!parsed.success) {
        this.logger.error(
          `Policy row ${newest.id} (tenant ${tenantId}, key ${entry.key}, ${scopeType}) no longer ` +
            `validates against the registry — skipping that layer`,
        );
        continue;
      }
      value = parsed.data;
    }
    return value;
  }

  /**
   * `tenantTransaction` scopes every write to the request's ALS tenant, while the lock key, the
   * scope-target check and invalidate() use `params.tenantId` — they must be the same tenant. A
   * caller with no context (a script) is fine: every where/create here names the tenant itself.
   */
  private requireMatchingContext(tenantId: string): void {
    const ctx = this.prisma.getTenantId();
    if (ctx !== null && ctx !== tenantId) {
      throw new ForbiddenException({
        statusCode: 403,
        code: "POLICY_TENANT_MISMATCH",
        message: "Policy writes are limited to the caller's own tenant.",
      });
    }
  }

  private requireEntry(key: string): PolicyEntry<unknown> {
    const entry = policyEntry(key);
    if (!entry) {
      throw new BadRequestException({
        statusCode: 400,
        code: "POLICY_KEY_UNKNOWN",
        message: `"${key}" is not a registered policy key.`,
      });
    }
    return entry;
  }

  /** The scope must be one the entry allows; TENANT takes no scopeId, the others require one. */
  private requireScope(
    entry: PolicyEntry<unknown>,
    scopeType: PolicyScopeType,
    scopeId: string | null | undefined,
  ): string | null {
    if (!entry.scopes.includes(scopeType)) {
      throw new BadRequestException({
        statusCode: 400,
        code: "POLICY_SCOPE_NOT_ALLOWED",
        message: `Policy "${entry.key}" cannot be set at ${scopeType} scope (allowed: ${entry.scopes.join(", ")}).`,
      });
    }
    const id = typeof scopeId === "string" ? scopeId.trim() : "";
    if (scopeType === "TENANT") {
      if (id) {
        throw new BadRequestException({
          statusCode: 400,
          code: "POLICY_SCOPE_ID_INVALID",
          message: "A TENANT-scope policy takes no scopeId.",
        });
      }
      return null;
    }
    if (!id) {
      throw new BadRequestException({
        statusCode: 400,
        code: "POLICY_SCOPE_ID_INVALID",
        message: `A ${scopeType}-scope policy needs a scopeId.`,
      });
    }
    return id;
  }

  private requireReason(reason: unknown): string {
    const r = typeof reason === "string" ? reason.trim() : "";
    if (!r) {
      throw new BadRequestException({
        statusCode: 400,
        code: "POLICY_REASON_REQUIRED",
        message: "A reason is required.",
      });
    }
    return r;
  }

  /** A CUSTOMER / CATEGORY scopeId must name a row of THIS tenant — never another tenant's id. */
  private async requireScopeTarget(
    tenantId: string,
    scopeType: PolicyScopeType,
    scopeId: string | null,
  ): Promise<void> {
    if (scopeType === "TENANT" || scopeId === null) return;
    const found =
      scopeType === "CUSTOMER"
        ? await this.prisma.customer.findFirst({
            where: { id: scopeId, tenantId },
            select: { id: true },
          })
        : await this.prisma.trackedCategory.findFirst({
            where: { id: scopeId, tenantId },
            select: { id: true },
          });
    if (!found) {
      throw new BadRequestException({
        statusCode: 400,
        code: "POLICY_SCOPE_TARGET_UNKNOWN",
        message: `No ${scopeType.toLowerCase()} "${scopeId}" in this tenant.`,
      });
    }
  }

  /** `policy-write` lock, key `${tenantId}:${key}`; lock trouble → 503 to retry. */
  private async underWriteLock<T>(tenantId: string, key: string, fn: () => Promise<T>): Promise<T> {
    try {
      const result = await withAdvisoryLock(
        {
          family: "policy-write",
          key: `${tenantId}:${key}`,
          mode: "wait",
          waitMs: WRITE_LOCK_WAIT_MS,
        },
        fn,
      );
      if (!result.acquired) {
        // Unreachable under mode "wait" — kept so this exhaustively narrows LockResult.
        throw new ServiceUnavailableException("Policy write lock unavailable — please retry.");
      }
      return result.value;
    } catch (err) {
      if (err instanceof LockTimeoutError || err instanceof LockUnavailableError) {
        this.logger.error(`policy-write lock unavailable for ${tenantId}:${key} — ${err.message}`);
        throw new ServiceUnavailableException({
          statusCode: 503,
          code: "POLICY_WRITE_BUSY",
          message: "Another change to this policy is in progress. Please retry.",
        });
      }
      throw err;
    }
  }
}
