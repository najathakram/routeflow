import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  AUTO_LOCK_SKIP_MILESTONE_PREFIX,
  autoLockKindOfMilestone,
  type AutoLockKind,
} from "./auto-lock-gate";
import { AutoLockSwitchService } from "./auto-lock-switch.service";
import {
  dunningPauseDueWhere,
  expiredTrialWhere,
  overdueGraceDeadline,
  overdueSubscriptionWhere,
  scheduledCancellationWhere,
} from "./auto-lock-candidates";
import { DUNNING_MILESTONES, DUNNING_PAUSE_HOURS, billingPauseMode } from "./dunning-config";
import { episodeKey } from "./dunning-clock";
import { isFinalKeyOfEpisode, latestCountingFinal } from "./dunning-final";

export interface WouldLockRow {
  tenantId: string;
  kind: AutoLockKind;
  key: string;
  /**
   * `stripe_check_pending`: the nightly job still asks Stripe before it locks. `fresh_final_first` (row 412): the
   * tenant's final notice was sent before the pause started, so the sweep after an unpause sends a FRESH final and
   * the lock follows 24 h later - not "within the hour".
   */
  via?: "stripe_check_pending" | "fresh_final_first";
}
export interface SkippedRow {
  tenantId: string;
  kind: AutoLockKind;
  key: string;
  at: Date;
}

const SKIPPED_LIMIT = 200;
/** Real-world scale guard: a preview over more tenants than this is cut off and says so by its length. */
const PREVIEW_LIMIT = 500;
const PRODUCTION = { class: "PRODUCTION" } as const;

/**
 * SA-775: the super-admin side of the rollout pause - the switch with its provenance, the list of locks that
 * were held, and the UNPAUSE PREVIEW. The preview is strictly read-only: it runs the SAME selection predicates
 * the crons scan with (`auto-lock-candidates.ts`, narrowed to PRODUCTION tenants) and writes nothing, so the
 * owner can see "Unpausing will lock these N tenants within the hour" before the switch flips. Tenants appear
 * by id only. The flip itself is audited by the controller (`PLATFORM_AUTO_LOCKS_SWITCHED`).
 */
@Injectable()
export class AutoLockAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoLocks: AutoLockSwitchService,
  ) {}

  /** PRODUCTION tenants the automatic jobs would lock on their next pass if the switch were unpaused. */
  async wouldLockNow(now: Date = new Date()): Promise<WouldLockRow[]> {
    const out: WouldLockRow[] = [];

    const trials = await this.prisma.tenant.findMany({
      where: expiredTrialWhere(now, PRODUCTION),
      select: { id: true, trialEndsAt: true },
      orderBy: { id: "asc" },
      take: PREVIEW_LIMIT,
    });
    for (const t of trials) {
      out.push({
        tenantId: t.id,
        kind: "trial_expired",
        key: (t.trialEndsAt as Date).toISOString(),
      });
    }

    const cancellations = await this.prisma.tenantSubscription.findMany({
      where: scheduledCancellationWhere(now, PRODUCTION),
      select: { tenantId: true, periodEnd: true },
      orderBy: { tenantId: "asc" },
      take: PREVIEW_LIMIT,
    });
    for (const s of cancellations) {
      out.push({
        tenantId: s.tenantId,
        kind: "subscription_cancelled",
        key: (s.periodEnd as Date).toISOString(),
      });
    }

    const overdue = await this.prisma.tenantSubscription.findMany({
      where: overdueSubscriptionWhere(overdueGraceDeadline(now), PRODUCTION),
      select: { tenantId: true, stripeSubId: true },
      orderBy: { tenantId: "asc" },
      take: PREVIEW_LIMIT,
    });
    for (const s of overdue) {
      out.push({
        tenantId: s.tenantId,
        kind: "overdue_suspended",
        key: s.stripeSubId as string,
        via: "stripe_check_pending",
      });
    }

    // The dunning pause only exists in `enforced` mode (dark / off never change a status).
    if (billingPauseMode() === "enforced") {
      const dunning = await this.prisma.tenantSubscription.findMany({
        where: dunningPauseDueWhere(now, DUNNING_PAUSE_HOURS, PRODUCTION),
        select: { tenantId: true, pastDueInvoiceId: true, pastDueSince: true },
        orderBy: { tenantId: "asc" },
        take: PREVIEW_LIMIT,
      });
      // Row 412: an unpause starts a new boundary (now, while paused; the last unpause otherwise). A tenant whose
      // final notice predates it gets a fresh final first, so it is listed but not as "locks within the hour".
      const state = await this.autoLocks.getState();
      const boundary = state.paused ? now : state.unpausedAt;
      const finals = boundary
        ? await this.prisma.billingNotificationLog.findMany({
            where: {
              milestone: DUNNING_MILESTONES.FINAL,
              tenantId: { in: dunning.map((d) => d.tenantId) },
            },
            select: { tenantId: true, key: true, sentAt: true },
          })
        : [];
      for (const s of dunning) {
        const episode = s.pastDueSince
          ? episodeKey(s.pastDueInvoiceId as string, s.pastDueSince)
          : null;
        const claims = episode
          ? finals.filter((f) => f.tenantId === s.tenantId && isFinalKeyOfEpisode(f.key, episode))
          : [];
        const stale = !!boundary && claims.length > 0 && !latestCountingFinal(claims, boundary);
        out.push({
          tenantId: s.tenantId,
          kind: "payment_overdue",
          key: s.pastDueInvoiceId as string,
          ...(stale ? { via: "fresh_final_first" as const } : {}),
        });
      }
    }
    return out;
  }

  /** The durable skip records (one per held case), newest first. */
  async skipped(limit: number = SKIPPED_LIMIT): Promise<SkippedRow[]> {
    const rows = await this.prisma.billingNotificationLog.findMany({
      where: { milestone: { startsWith: AUTO_LOCK_SKIP_MILESTONE_PREFIX } },
      select: { tenantId: true, milestone: true, key: true, sentAt: true },
      orderBy: { sentAt: "desc" },
      take: limit,
    });
    const out: SkippedRow[] = [];
    for (const r of rows) {
      const kind = autoLockKindOfMilestone(r.milestone);
      if (kind) out.push({ tenantId: r.tenantId, kind, key: r.key, at: r.sentAt });
    }
    return out;
  }

  /** `GET /platform-admin/config/auto-locks`. */
  async getState(now: Date = new Date()) {
    const [state, wouldLockNow, skipped] = await Promise.all([
      this.autoLocks.getState(),
      this.wouldLockNow(now),
      this.skipped(),
    ]);
    return {
      paused: state.paused,
      since: state.since ? state.since.toISOString() : null,
      reason: state.reason,
      wouldLockNow,
      skipped: skipped.map((s) => ({ ...s, at: s.at.toISOString() })),
    };
  }

  /** `GET /platform-admin/config/auto-locks/preview` - read-only. */
  async preview(now: Date = new Date()) {
    const [state, wouldLock] = await Promise.all([
      this.autoLocks.getState(),
      this.wouldLockNow(now),
    ]);
    return { generatedAt: now.toISOString(), paused: state.paused, wouldLock };
  }

  /**
   * `PATCH /platform-admin/config/auto-locks`: flips the switch (refreshing this process' cache) and returns
   * both the new and the previous state, so the controller's audit row can say what it replaced.
   */
  async setPaused(paused: boolean, reason: string, actorId: string | null) {
    this.autoLocks.invalidate(); // `previous` is the last committed value, not a cached one
    const previous = await this.autoLocks.getState();
    const next = await this.autoLocks.setPaused(paused, reason, actorId);
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      paused: next.paused,
      since: iso(next.since),
      reason: next.reason,
      previous: { paused: previous.paused, since: iso(previous.since), reason: previous.reason },
    };
  }
}
