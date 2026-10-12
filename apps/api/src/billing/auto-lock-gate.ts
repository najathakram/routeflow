import type { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * SA-775 (row 381): the rollout pause on AUTOMATIC tenant locks.
 *
 * One switch (`platform.autoLocksPaused`, `AutoLockSwitchService`), one gate (`autoLockAllowed`), one skip
 * record (`recordAutoLockSkip`). Every code path that moves a tenant to READ_ONLY / SUSPENDED / CANCELLED on
 * its own (a cron, a webhook, a tenant's own trial cancel) asks the gate BEFORE it writes; a super admin's
 * manual lock never does. `auto-lock-writers.pin.spec.ts` fails the build for a writer that is not classed.
 */

/** Why a lock was about to be written; also the suffix of the durable skip claim (`AUTO_LOCK_PAUSED:<kind>`). */
export const AUTO_LOCK_KINDS = [
  "trial_expired",
  "subscription_cancelled",
  "overdue_suspended",
  "stripe_cancelled",
  "payment_overdue",
  "trial_cancelled",
] as const;
export type AutoLockKind = (typeof AUTO_LOCK_KINDS)[number];

/** `PlatformConfig.key` of the switch. Missing = PAUSED. */
export const AUTO_LOCKS_PAUSED_KEY = "platform.autoLocksPaused";
/** `BillingNotificationLog.milestone` prefix of a skip claim. */
export const AUTO_LOCK_SKIP_MILESTONE_PREFIX = "AUTO_LOCK_PAUSED:";
/** `AuditLog.action` written once per newly claimed skip. */
export const AUTO_LOCK_SKIP_AUDIT_ACTION = "tenant.auto-lock-skipped";
export const AUTO_LOCK_SKIP_REASON = "paused by rollout switch";

/** What a writer needs from the switch (the service implements it; a spec can pass a stub). */
export interface AutoLockSwitch {
  isPaused(): Promise<boolean>;
}

/** The kind of a skip claim row, or null when `milestone` is not one of ours. */
export function autoLockKindOfMilestone(milestone: string): AutoLockKind | null {
  if (!milestone.startsWith(AUTO_LOCK_SKIP_MILESTONE_PREFIX)) return null;
  const kind = milestone.slice(AUTO_LOCK_SKIP_MILESTONE_PREFIX.length);
  return (AUTO_LOCK_KINDS as readonly string[]).includes(kind) ? (kind as AutoLockKind) : null;
}

/**
 * May this AUTOMATIC lock be written? `false` exactly when the switch is paused AND the tenant is PRODUCTION
 * (TEST / DEMO / INTERNAL tenants keep locking so QA can still exercise the locks). `switch` is undefined only
 * for a service built bare in a unit spec; `billing.module-wiring.spec.ts` pins that production injects it.
 * The switch read is cached (<= 30 s) and fails CLOSED (paused) on a read error, so the gate is safe to call
 * from inside a transaction. `kind` is the seam for a per-tenant or per-kind hold (SA-775 G8).
 */
export async function autoLockAllowed(
  autoLocks: AutoLockSwitch | null | undefined,
  tenant: { id: string; class: string | null | undefined },
  kind: AutoLockKind,
): Promise<boolean> {
  void kind;
  if (!autoLocks) return true;
  if (tenant.class !== "PRODUCTION") return true;
  return !(await autoLocks.isPaused());
}

export interface AutoLockSkip {
  tenantId: string;
  kind: AutoLockKind;
  /** The case: trialEndsAt ISO / periodEnd ISO / Stripe sub id / dunning invoice id. */
  key: string;
  /** What the skipped lock would have written, for the audit trail. */
  wouldHaveSet: Record<string, unknown>;
  /** The user whose own click was held (only the tenant-admin trial cancel). */
  actorId?: string | null;
}

type SkipClient = PrismaService | Prisma.TransactionClient;
type SkipLogger = { warn: (message: string) => void };

/**
 * Nothing is silent: record ONE durable claim per `(tenantId, kind, key)` - a `BillingNotificationLog` row with
 * milestone `AUTO_LOCK_PAUSED:<kind>` - and, only when the claim is NEW, one `tenant.auto-lock-skipped` audit
 * row. `createMany({ skipDuplicates })` is `ON CONFLICT DO NOTHING`, so the hourly cron meeting the same case
 * again claims nothing and writes nothing (and, unlike a caught unique violation, cannot abort an open
 * transaction). Returns true when THIS call recorded the skip. Never throws: the lock is already skipped, and
 * a failing record must not stop the rest of a sweep (it is retried by the next pass).
 */
export async function recordAutoLockSkip(
  client: SkipClient,
  skip: AutoLockSkip,
  logger?: SkipLogger,
): Promise<boolean> {
  const write = async (tx: Prisma.TransactionClient): Promise<boolean> => {
    const claim = await tx.billingNotificationLog.createMany({
      data: [
        {
          tenantId: skip.tenantId,
          milestone: `${AUTO_LOCK_SKIP_MILESTONE_PREFIX}${skip.kind}`,
          key: skip.key,
        },
      ],
      skipDuplicates: true,
    });
    if (claim.count !== 1) return false;
    await tx.auditLog.create({
      data: {
        tenantId: skip.tenantId,
        userId: skip.actorId ?? null,
        action: AUTO_LOCK_SKIP_AUDIT_ACTION,
        entityType: "Tenant",
        entityId: skip.tenantId,
        meta: {
          kind: skip.kind,
          wouldHaveSet: skip.wouldHaveSet,
          reason: AUTO_LOCK_SKIP_REASON,
          key: skip.key,
        } as Prisma.InputJsonObject,
      },
    });
    return true;
  };
  try {
    return "$transaction" in client
      ? await (client as PrismaService).$transaction((tx) => write(tx))
      : await write(client as Prisma.TransactionClient);
  } catch (err) {
    logger?.warn(
      `billing.autoLock.skip_record_failed tenant=${skip.tenantId} kind=${skip.kind}: ${(err as Error)?.message}`,
    );
    return false;
  }
}
