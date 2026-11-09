import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { FeatureOverrideKind, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { FeatureOverrideService, FeatureOverrideEffect } from "../billing/feature-override.service";
import {
  checkFeatureRequires,
  describeUnmetFeatureRequirement,
  featureDefByKey,
  isRegisteredFeatureKey,
} from "../billing/feature-registry";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { ADMIN_AUDIT_ENTITY, AdminAuditAction } from "./audit-actions.constant";
import {
  ApplyFeatureChangesDto,
  FEATURE_CHANGE_SET_CAP,
  FeatureChangeDto,
} from "./dto/feature-changes.dto";

/** What one key's live override looked like, as data (R53): enough to put it back exactly. */
export interface OverrideSnapshot {
  id: string;
  effect: FeatureOverrideEffect;
  kind: FeatureOverrideKind;
  reason: string;
  expiresAt: string | null;
}

/** One change inside a saved set. `type` leaves room for another kind later (a comp add-on). */
export interface FeatureChangeRecord {
  type: "override";
  key: string;
  /** The key's live override before the save, or null (the plan and add-ons decide). */
  before: OverrideSnapshot | null;
  /** The key's live override after the save, or null. */
  after: OverrideSnapshot | null;
  createdIds: string[];
  revokedIds: string[];
  /** The rows this change revoked, as they were: undo re-creates them from this. */
  revoked: OverrideSnapshot[];
}

/** The whole saved set, stored as the audit row's meta (R53: before, after, actor, ids). */
export interface FeatureChangeSetMeta {
  changeSetId: string;
  reason: string;
  actor: string;
  hashBefore: string;
  hashAfter: string;
  changes: FeatureChangeRecord[];
  undoOf?: string;
}

export interface FeatureChangePreviewRow {
  type: "override";
  key: string;
  action: FeatureChangeDto["action"];
  before: OverrideSnapshot | null;
  after: Pick<OverrideSnapshot, "effect" | "kind" | "expiresAt"> | null;
  unchanged: boolean;
}

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

const snap = (r: {
  id: string;
  effect: FeatureOverrideEffect;
  kind: FeatureOverrideKind;
  reason: string;
  expiresAt: Date | null;
}): OverrideSnapshot => ({
  id: r.id,
  effect: r.effect,
  kind: r.kind,
  reason: r.reason,
  expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
});

const refuse = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  new ConflictException({ statusCode: 409, code, message, ...extra });

/**
 * WP11 (SA-1106 C2, R27 R28 R32 R48 R53): the review-then-save write path for a business's feature overrides.
 *
 * One saved set is ONE database transaction: the tenant row is locked, `expected` is compared with the inputs hash
 * read inside the transaction (compare-and-set, so two saves at the same hash cannot both pass), every change goes
 * through `FeatureOverrideService.create` / `.revoke` (no second writer of the table's rules), and the audit row
 * is written in the same transaction with `tx.auditLog.create` (AuditService.log swallows errors, a failed audit
 * write must fail the set). Any failure rolls everything back. The cache is invalidated only after the commit.
 *
 * Second caller of `FeatureOverrideService.create`, named in `feature-override-single-caller.spec.ts`: the set is
 * validated whole first (key, overridable, requires counted across the set, future end date, reason, cap).
 */
@Injectable()
export class FeatureChangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly overrides: FeatureOverrideService,
    private readonly authority: EntitlementAuthority,
  ) {}

  /**
   * The hash `expected` is compared with. It moves whenever a plan, a plan version, an add-on row or an override
   * row (id, effect, kind, end date, whether it is still live) changes. Read on `db` so a transaction sees its own
   * writes and the locked state.
   */
  async inputsHash(
    tenantId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<string> {
    const now = Date.now();
    const [tenant, addonRows, overrideRows] = await Promise.all([
      db.tenant.findUnique({
        where: { id: tenantId },
        select: { plan: true, planVersionId: true },
      }),
      db.tenantAddon.findMany({
        where: { tenantId },
        select: { addonKey: true, sku: true, quantity: true, active: true, isComp: true },
        orderBy: { addonKey: "asc" },
      }),
      db.tenantFeatureOverride.findMany({
        where: { tenantId, revokedAt: null },
        select: { id: true, featureKey: true, effect: true, kind: true, expiresAt: true },
        orderBy: [{ featureKey: "asc" }, { id: "asc" }],
      }),
    ]);
    return digest({
      plan: tenant?.plan ?? null,
      version: tenant?.planVersionId ?? null,
      addonRows,
      overrideRows: overrideRows.map((r) => ({
        ...r,
        live: r.expiresAt == null || r.expiresAt.getTime() > now,
      })),
    });
  }

  /** Whole-set checks that need no write and no lock. Throws the first problem naming the key. */
  private async validate(tenantId: string, dto: ApplyFeatureChangesDto): Promise<void> {
    if (dto.changes.length > FEATURE_CHANGE_SET_CAP) {
      throw new BadRequestException(`A save holds at most ${FEATURE_CHANGE_SET_CAP} changes.`);
    }
    const seen = new Set<string>();
    for (const c of dto.changes) {
      if (seen.has(c.key)) {
        throw new BadRequestException(`"${c.key}" appears twice in this save.`);
      }
      seen.add(c.key);
      if (!isRegisteredFeatureKey(c.key)) {
        throw new BadRequestException({
          statusCode: 400,
          code: API_ERROR_CODES.FEATURE_KEY_UNKNOWN,
          message: `"${c.key}" is not a registered feature key.`,
        });
      }
      if (c.action === "CLEAR") continue;
      if (featureDefByKey(c.key)?.grant.override === false) {
        throw new ConflictException({
          statusCode: 409,
          code: API_ERROR_CODES.FEATURE_NOT_OVERRIDABLE,
          key: c.key,
          message: `An override can't change "${c.key}", so nothing was saved.`,
        });
      }
      if (c.expiresAt && new Date(c.expiresAt).getTime() <= Date.now()) {
        throw new BadRequestException({
          statusCode: 400,
          code: API_ERROR_CODES.EXPIRES_AT_MUST_BE_FUTURE,
          key: c.key,
          message: "expiresAt must be in the future.",
        });
      }
    }
    // `requires` is counted across the set: granting a feature and the one it needs in one save is fine.
    const grants = dto.changes.filter((c) => c.action === "GRANT");
    if (grants.some((c) => featureDefByKey(c.key)?.requires)) {
      const resolved = await this.authority.resolveAll(tenantId);
      if (resolved) {
        const have = new Set(
          [...resolved.byKey.entries()].filter(([, v]) => v.strict).map(([k]) => k),
        );
        for (const c of dto.changes) {
          if (c.action === "GRANT") have.add(c.key);
          else if (c.action === "DENY") have.delete(c.key);
        }
        for (const c of grants) {
          const def = featureDefByKey(c.key);
          if (!def?.requires) continue;
          const status = checkFeatureRequires(def.requires, have);
          if (!status.satisfied) {
            throw new BadRequestException({
              statusCode: 400,
              code: API_ERROR_CODES.FEATURE_REQUIRES_UNMET,
              key: c.key,
              missing: describeUnmetFeatureRequirement(status),
              message: `"${c.key}" depends on ${describeUnmetFeatureRequirement(status)}, which this save does not turn on, so nothing was saved.`,
            });
          }
        }
      }
    }
  }

  private async liveRows(
    db: Prisma.TransactionClient | PrismaService,
    tenantId: string,
    key: string,
  ) {
    return db.tenantFeatureOverride.findMany({
      where: { tenantId, featureKey: key, revokedAt: null },
      orderBy: { createdAt: "asc" },
    });
  }

  private sameAsLive(
    live:
      | { effect: FeatureOverrideEffect; kind: FeatureOverrideKind; expiresAt: Date | null }
      | undefined,
    c: FeatureChangeDto,
  ): boolean {
    if (!live || c.action === "CLEAR") return false;
    const wantExpires = c.expiresAt ? new Date(c.expiresAt).getTime() : null;
    return (
      live.effect === c.action &&
      live.kind === (c.kind ?? "COMP") &&
      (live.expiresAt ? live.expiresAt.getTime() : null) === wantExpires
    );
  }

  /** What the save would do, per key, with the current hash. Writes nothing. */
  async preview(tenantId: string, dto: ApplyFeatureChangesDto) {
    await this.assertTenant(tenantId);
    await this.validate(tenantId, dto);
    const rows: FeatureChangePreviewRow[] = [];
    for (const c of dto.changes) {
      const live = (await this.liveRows(this.prisma, tenantId, c.key))[0];
      rows.push({
        type: "override",
        key: c.key,
        action: c.action,
        before: live ? snap(live) : null,
        after:
          c.action === "CLEAR"
            ? null
            : { effect: c.action, kind: c.kind ?? "COMP", expiresAt: c.expiresAt ?? null },
        unchanged: c.action === "CLEAR" ? !live : this.sameAsLive(live, c),
      });
    }
    const inputsHash = await this.inputsHash(tenantId);
    return { inputsHash, stale: inputsHash !== dto.expected, changes: rows };
  }

  /** Save the set. All or nothing. Returns the audit id (the change set's id) and the new hash. */
  async apply(tenantId: string, actorId: string, dto: ApplyFeatureChangesDto) {
    await this.assertTenant(tenantId);
    await this.validate(tenantId, dto);

    const result = await this.prisma.$transaction(
      async (tx) => {
        await this.lockTenant(tx, tenantId);
        const hashBefore = await this.inputsHash(tenantId, tx);
        if (hashBefore !== dto.expected) {
          throw refuse(
            API_ERROR_CODES.FEATURE_INPUTS_CHANGED,
            "Changed by someone else. Nothing was saved. Reload and review again.",
          );
        }
        const records: FeatureChangeRecord[] = [];
        for (const c of dto.changes) {
          const live = await this.liveRows(tx, tenantId, c.key);
          if (c.action === "CLEAR") {
            if (live.length === 0) continue; // nothing to clear
            const revoked: OverrideSnapshot[] = [];
            for (const row of live) {
              revoked.push(snap(row));
              await this.overrides.revoke(tenantId, row.id, tx);
            }
            records.push({
              type: "override",
              key: c.key,
              before: revoked[0] ?? null,
              after: null,
              createdIds: [],
              revokedIds: revoked.map((r) => r.id),
              revoked,
            });
            continue;
          }
          if (this.sameAsLive(live[0], c)) continue; // already exactly this
          const revoked: OverrideSnapshot[] = [];
          for (const row of live) {
            revoked.push(snap(row));
            await this.overrides.revoke(tenantId, row.id, tx);
          }
          const created = await this.overrides.create(
            {
              tenantId,
              featureKey: c.key,
              effect: c.action,
              kind: c.kind,
              reason: dto.reason,
              expiresAt: c.expiresAt ? new Date(c.expiresAt) : null,
              createdById: actorId,
            },
            tx,
          );
          records.push({
            type: "override",
            key: c.key,
            before: revoked[0] ?? null,
            after: snap(created),
            createdIds: [created.id],
            revokedIds: revoked.map((r) => r.id),
            revoked,
          });
        }
        if (records.length === 0) {
          throw new BadRequestException("Nothing to change: every key is already set that way.");
        }
        const hashAfter = await this.inputsHash(tenantId, tx);
        const changeSetId = await this.writeAudit(tx, tenantId, actorId, {
          action: AdminAuditAction.FEATURE_CHANGE_SET_APPLIED,
          meta: { reason: dto.reason, actor: actorId, hashBefore, hashAfter, changes: records },
        });
        return { changeSetId, hashAfter, changes: records };
      },
      { timeout: 20_000 },
    );
    this.afterCommit(tenantId);
    return result;
  }

  /** Put one saved set back, if nothing has changed since it was saved. Once. */
  async undo(tenantId: string, actorId: string, auditId: string, reason: string) {
    const set = await this.prisma.auditLog.findFirst({
      where: {
        id: auditId,
        tenantId,
        action: AdminAuditAction.FEATURE_CHANGE_SET_APPLIED,
        entityType: ADMIN_AUDIT_ENTITY,
      },
    });
    if (!set) throw new NotFoundException("No saved change set with that id for this business.");
    const meta = set.meta as unknown as FeatureChangeSetMeta | null;
    if (!meta || !Array.isArray(meta.changes) || typeof meta.hashAfter !== "string") {
      throw refuse(
        API_ERROR_CODES.FEATURE_CHANGE_NOT_UNDOABLE,
        "This save was recorded before undo existed, so it can't be undone here.",
      );
    }

    const result = await this.prisma.$transaction(
      async (tx) => {
        await this.lockTenant(tx, tenantId);
        const already = await tx.auditLog.findFirst({
          where: {
            tenantId,
            action: AdminAuditAction.FEATURE_CHANGE_SET_UNDONE,
            entityType: ADMIN_AUDIT_ENTITY,
            meta: { path: ["undoOf"], equals: auditId },
          },
          select: { id: true },
        });
        if (already) {
          throw refuse(
            API_ERROR_CODES.FEATURE_CHANGE_NOT_UNDOABLE,
            "This save was already undone.",
          );
        }
        const hashBefore = await this.inputsHash(tenantId, tx);
        if (hashBefore !== meta.hashAfter) {
          throw refuse(
            API_ERROR_CODES.FEATURE_CHANGE_NOT_UNDOABLE,
            "Something changed after this save, so it can't be undone without undoing newer work.",
          );
        }
        const records: FeatureChangeRecord[] = [];
        for (const c of meta.changes) {
          for (const id of c.createdIds) await this.overrides.revoke(tenantId, id, tx);
          const recreated: OverrideSnapshot[] = [];
          for (const old of c.revoked) {
            const row = await this.overrides.create(
              {
                tenantId,
                featureKey: c.key,
                effect: old.effect,
                kind: old.kind,
                reason: old.reason,
                expiresAt: old.expiresAt ? new Date(old.expiresAt) : null,
                createdById: actorId,
              },
              tx,
            );
            recreated.push(snap(row));
          }
          records.push({
            type: "override",
            key: c.key,
            before: c.after,
            after: recreated[0] ?? null,
            createdIds: recreated.map((r) => r.id),
            revokedIds: c.createdIds,
            revoked: [],
          });
        }
        const hashAfter = await this.inputsHash(tenantId, tx);
        const changeSetId = await this.writeAudit(tx, tenantId, actorId, {
          action: AdminAuditAction.FEATURE_CHANGE_SET_UNDONE,
          meta: {
            reason,
            actor: actorId,
            hashBefore,
            hashAfter,
            changes: records,
            undoOf: auditId,
          },
        });
        return { changeSetId, hashAfter, undoOf: auditId, changes: records };
      },
      { timeout: 20_000 },
    );
    this.afterCommit(tenantId);
    return result;
  }

  /** The audit row, same fields as `PlatformAdminService.recordAdminAction`, but inside the transaction. */
  async writeAudit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actorId: string,
    entry: { action: string; meta: Record<string, unknown> },
  ): Promise<string> {
    const row = await tx.auditLog.create({
      data: auditRowData(tenantId, actorId, entry.action, entry.meta),
      select: { id: true },
    });
    return row.id;
  }

  private afterCommit(tenantId: string): void {
    this.overrides.invalidate(tenantId);
    this.authority.invalidate(tenantId);
  }

  private async assertTenant(tenantId: string): Promise<void> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!t) throw new NotFoundException("Business not found.");
  }

  /** Serializes saves for one business: the second waits here, then fails the hash check. */
  private async lockTenant(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundException("Business not found.");
  }
}

/**
 * The fields of an admin audit row. `PlatformAdminService.recordAdminAction` writes the same shape through
 * `AuditService.log`; `feature-change.audit-shape.spec.ts` pins the two together so they cannot drift.
 */
export function auditRowData(
  tenantId: string,
  actorId: string | null,
  action: string,
  meta: Record<string, unknown>,
) {
  return {
    tenantId,
    userId: actorId,
    action,
    entityType: ADMIN_AUDIT_ENTITY,
    entityId: tenantId,
    meta: { platformAdmin: true, ...meta } as Prisma.InputJsonValue,
  };
}
