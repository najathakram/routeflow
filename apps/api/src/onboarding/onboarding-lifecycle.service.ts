import { Injectable, Logger } from "@nestjs/common";
import type { IntakeSectionKey, OnboardingStage } from "@prisma/client";
import type { OnboardingFunnel, OnboardingFunnelStageDays } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { StorageService } from "../storage/storage.service";
import { LeaderCron } from "../common/cron-lock";
import { escapeHtml } from "../common/html-escape";
import { STAGE_ORDER, stageIndex } from "./onboarding-catalog";
import { SECTION_LABEL } from "./onboarding-intake.service";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A customer who has gone this long without touching the intake page gets a nudge. */
export const REMINDER_QUIET_DAYS = 3;
/** Never more than this many reminders for one intake link. */
export const REMINDER_MAX_PER_LINK = 3;
/** Raw intake files are deleted this long after a case goes LIVE (plan §6 S5). */
export const PURGE_AFTER_LIVE_DAYS = 30;
/** Bounded work per cron run. */
const PURGE_BATCH = 500;

/** Section states that still owe the customer's input. */
const OWED: readonly string[] = ["EMPTY", "DRAFT", "CHANGES_REQUESTED"];

/**
 * Onboarding lifecycle jobs (#2159 S5): customer reminders, the raw-file purge after go-live,
 * and the funnel metrics. PLATFORM-LEVEL rows, base Prisma client (like OnboardingService).
 *
 * Both jobs are `@LeaderCron` (one replica runs each tick) and idempotent: every reminder and
 * purge is recorded as an `OnboardingEvent`, which is also what the next run reads back.
 */
@Injectable()
export class OnboardingLifecycleService {
  private readonly logger = new Logger(OnboardingLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly storage: StorageService,
  ) {}

  // ─── Reminders ──────────────────────────────────────────────────────────────────

  @LeaderCron("0 15 * * *", "onboarding.sendReminders")
  async sendRemindersCron(): Promise<void> {
    const r = await this.sendReminders(new Date());
    if (r.sent > 0) this.logger.log(`onboarding reminders: ${r.sent} sent`);
  }

  /**
   * One reminder per quiet OPEN case whose intake link is live and which still owes at least
   * one section: "quiet" means no customer use of the link, and no earlier reminder, for
   * REMINDER_QUIET_DAYS. At most REMINDER_MAX_PER_LINK per link. The raw token is never
   * stored (only its hash), so the email points back to the original link email instead of
   * carrying the link — the back office issues a fresh link on request.
   */
  async sendReminders(now: Date): Promise<{ sent: number; skipped: number }> {
    const cases = await this.prisma.onboardingCase.findMany({
      where: {
        status: "OPEN",
        tokens: { some: { revokedAt: null, expiresAt: { gt: now } } },
      },
      include: {
        tokens: {
          where: { revokedAt: null, expiresAt: { gt: now } },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        sections: { select: { key: true, status: true } },
      },
    });

    let sent = 0;
    let skipped = 0;
    for (const c of cases) {
      const token = c.tokens[0];
      const owed = c.sections
        .filter((s) => OWED.includes(s.status))
        .map((s) => s.key as IntakeSectionKey);
      if (!token || owed.length === 0) {
        skipped++;
        continue;
      }
      const reminders = await this.prisma.onboardingEvent.findMany({
        where: { caseId: c.id, type: "reminder.sent" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, payload: true },
      });
      const forThisLink = reminders.filter(
        (e) => (e.payload as { tokenId?: unknown } | null)?.tokenId === token.id,
      );
      if (forThisLink.length >= REMINDER_MAX_PER_LINK) {
        skipped++;
        continue;
      }
      const quietSince = Math.max(
        token.createdAt.getTime(),
        token.lastUsedAt?.getTime() ?? 0,
        forThisLink[0]?.createdAt.getTime() ?? 0,
      );
      if (now.getTime() - quietSince < REMINDER_QUIET_DAYS * DAY_MS) {
        skipped++;
        continue;
      }

      let delivered = false;
      try {
        const r = await this.email.sendPlatform({
          to: c.contactEmail,
          subject: "Your RouteFlow setup is waiting for you",
          html: reminderEmailHtml({
            contactName: c.contactName,
            companyName: c.companyName,
            owed: owed.map((k) => SECTION_LABEL[k]),
            linkSentOn: token.createdAt,
            linkExpiresOn: token.expiresAt,
          }),
        });
        delivered = r.delivered;
      } catch (err) {
        this.logger.warn(`onboarding reminder failed for case ${c.id}: ${(err as Error).message}`);
      }
      await this.prisma.onboardingEvent.create({
        data: {
          caseId: c.id,
          type: "reminder.sent",
          createdAt: now, // the job clock: the next run measures the quiet window from it
          actorType: "SYSTEM",
          actorId: null,
          payload: { tokenId: token.id, delivered, sections: owed },
        },
      });
      sent++;
    }
    return { sent, skipped };
  }

  // ─── Raw-file purge ───────────────────────────────────────────────────────────────

  @LeaderCron("30 3 * * *", "onboarding.purgeIntakeFiles")
  async purgeIntakeFilesCron(): Promise<void> {
    const r = await this.purgeIntakeFiles(new Date());
    if (r.purged > 0 || r.failed > 0) {
      this.logger.log(`onboarding purge: ${r.purged} purged, ${r.failed} failed`);
    }
  }

  /**
   * Deletes the stored object of every intake file (including ones the customer removed —
   * their object is still in storage) on cases LIVE for PURGE_AFTER_LIVE_DAYS, then stamps
   * `purgedAt`. The row itself stays as the audit record. A storage failure leaves the row
   * un-stamped so the next run retries it.
   */
  async purgeIntakeFiles(now: Date): Promise<{ purged: number; failed: number }> {
    const cutoff = new Date(now.getTime() - PURGE_AFTER_LIVE_DAYS * DAY_MS);
    const files = await this.prisma.intakeFile.findMany({
      where: { purgedAt: null, case: { status: "LIVE", closedAt: { lte: cutoff } } },
      select: { id: true, caseId: true, storageKey: true },
      orderBy: { createdAt: "asc" },
      take: PURGE_BATCH,
    });
    let purged = 0;
    let failed = 0;
    const perCase = new Map<string, number>();
    for (const f of files) {
      try {
        await this.storage.delete(f.storageKey);
      } catch (err) {
        failed++;
        this.logger.warn(`intake file ${f.id} purge failed: ${(err as Error).message}`);
        continue;
      }
      await this.prisma.intakeFile.update({ where: { id: f.id }, data: { purgedAt: now } });
      purged++;
      perCase.set(f.caseId, (perCase.get(f.caseId) ?? 0) + 1);
    }
    for (const [caseId, count] of perCase) {
      await this.prisma.onboardingEvent.create({
        data: {
          caseId,
          type: "files.purged",
          createdAt: now,
          actorType: "SYSTEM",
          actorId: null,
          payload: { count },
        },
      });
    }
    return { purged, failed };
  }

  // ─── Funnel ─────────────────────────────────────────────────────────────────────

  /**
   * Demo → case → signed → paid → live for cases OPENED in [from, to), plus how long cases
   * spent in each stage they have left (from the `stage.advanced` / `case.live` events).
   * "Paid" = past the ACTIVATE gate, whose required steps include the payment.
   */
  async funnel(from: Date, to: Date): Promise<OnboardingFunnel> {
    const range = { gte: from, lt: to };
    const [demosBooked, cases] = await Promise.all([
      this.prisma.demoBooking.count({ where: { createdAt: range } }),
      this.prisma.onboardingCase.findMany({
        where: { createdAt: range },
        select: {
          id: true,
          stage: true,
          status: true,
          createdAt: true,
          acceptances: { where: { supersededAt: null }, select: { id: true }, take: 1 },
          events: {
            where: { type: { in: ["stage.advanced", "case.live"] } },
            orderBy: { createdAt: "asc" },
            select: { type: true, payload: true, createdAt: true },
          },
        },
      }),
    ]);

    const activate = stageIndex("ACTIVATE");
    const durations = new Map<OnboardingStage, number[]>();
    for (const c of cases) {
      let enteredAt = c.createdAt;
      for (const e of c.events) {
        const from = (e.payload as { from?: unknown } | null)?.from;
        if (typeof from !== "string" || !STAGE_ORDER.includes(from as OnboardingStage)) continue;
        const days = (e.createdAt.getTime() - enteredAt.getTime()) / DAY_MS;
        const list = durations.get(from as OnboardingStage) ?? [];
        list.push(days);
        durations.set(from as OnboardingStage, list);
        enteredAt = e.createdAt;
      }
    }

    const stageDays = Object.fromEntries(
      STAGE_ORDER.map((s) => {
        const list = durations.get(s) ?? [];
        return [s, { cases: list.length, medianDays: median(list) }];
      }),
    ) as Record<OnboardingStage, OnboardingFunnelStageDays>;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      demosBooked,
      casesOpened: cases.length,
      signed: cases.filter((c) => c.acceptances.length > 0).length,
      paid: cases.filter((c) => c.status === "LIVE" || stageIndex(c.stage) > activate).length,
      live: cases.filter((c) => c.status === "LIVE").length,
      lost: cases.filter((c) => c.status === "LOST").length,
      stageDays,
    };
  }
}

/** Median in days, one decimal; null for no data. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return Math.round(m * 10) / 10;
}

export function reminderEmailHtml(p: {
  contactName: string;
  companyName: string;
  owed: string[];
  linkSentOn: Date;
  linkExpiresOn: Date;
}): string {
  const first = p.contactName.trim().split(/\s+/)[0] || "there";
  const items = p.owed.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
  const sent = escapeHtml(p.linkSentOn.toISOString().slice(0, 10));
  const expires = escapeHtml(p.linkExpiresOn.toISOString().slice(0, 10));
  return `<p>Hi ${escapeHtml(first)},</p>
<p>Your RouteFlow setup for ${escapeHtml(p.companyName)} is waiting on a few answers:</p>
<ul>${items}</ul>
<p>Use the secure link from our email of ${sent}; it works until ${expires}. Can't find it? Ask your onboarding lead for a fresh one — we never send it in a reminder.</p>
<p>— The RouteFlow team</p>`;
}
