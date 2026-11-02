import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { LeaderCron } from "../common/cron-lock";
import { GoogleCalendarService } from "../demo-booking/google-calendar.service";
import { PrismaService } from "../prisma/prisma.service";
import { RETENTION_BATCH, RETENTION_MAX_ROWS_PER_RUN, recordRetentionRun } from "./retention-run";
import {
  RETENTION_DEMO_BOOKING_SWITCH,
  RetentionMode,
  RetentionSwitchService,
} from "./retention-switch.service";

export const DEMO_BOOKING_RETENTION_MONTHS = 12;

export interface DemoBookingRetentionResult {
  mode: RetentionMode;
  cutoff: Date;
  /** Bookings past the cutoff that the job may remove. */
  due: number;
  dueWithEvent: number;
  deleted: number;
  /** Past the cutoff and kept: the booking's onboarding case has a tenant. */
  keptWithTenant: number;
  /** Kept for the next run: `googleEventId` is the only way back to the event. */
  calendarFailed: number;
  capped: boolean;
}

function cutoffFrom(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - DEMO_BOOKING_RETENTION_MONTHS);
  return cutoff;
}

/** A booking whose case became a tenant never matches. Spelled out so a booking with no case does. */
function removableWhere(cutoff: Date): Prisma.DemoBookingWhereInput {
  return {
    startsAt: { lt: cutoff },
    OR: [{ onboardingCase: { is: null } }, { onboardingCase: { is: { tenantId: null } } }],
  };
}

/**
 * SA-1083: demo bookings 12 months after the booked time. The calendar event holds the same details, so it goes first,
 * and a booking whose event can't be removed stays. Report-only until its switch is on: the same plan runs, the calendar
 * isn't called, and only the counts are written.
 */
@Injectable()
export class DemoBookingRetentionService {
  private readonly logger = new Logger(DemoBookingRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly switches: RetentionSwitchService,
    private readonly calendar: GoogleCalendarService,
  ) {}

  @LeaderCron("45 3 * * *", "retention.demoBookings")
  async runCron(): Promise<void> {
    await this.run();
  }

  async run(now: Date = new Date()): Promise<DemoBookingRetentionResult> {
    const mode = await this.switches.modeOf(RETENTION_DEMO_BOOKING_SWITCH);
    const cutoff = cutoffFrom(now);
    const removable = removableWhere(cutoff);
    const [due, dueWithEvent, keptWithTenant] = await Promise.all([
      this.prisma.demoBooking.count({ where: removable }),
      this.prisma.demoBooking.count({ where: { ...removable, googleEventId: { not: null } } }),
      this.prisma.demoBooking.count({
        where: {
          startsAt: { lt: cutoff },
          onboardingCase: { is: { tenantId: { not: null } } },
        },
      }),
    ]);
    const out: DemoBookingRetentionResult = {
      mode,
      cutoff,
      due,
      dueWithEvent,
      deleted: 0,
      keptWithTenant,
      calendarFailed: 0,
      capped: false,
    };
    if (mode === "enforce") await this.removeDue(removable, out);

    await recordRetentionRun(this.prisma, this.logger, AUDIT_ACTIONS.RETENTION_DEMO_BOOKINGS_RUN, {
      mode,
      cutoff: cutoff.toISOString(),
      due,
      dueWithEvent,
      deleted: out.deleted,
      keptWithTenant,
      calendarFailed: out.calendarFailed,
      capped: out.capped,
    });
    this.logger.log(
      `Demo booking retention (${mode}): ${due} due, ${out.deleted} deleted, ${keptWithTenant} kept with a tenant, ${out.calendarFailed} calendar failures`,
    );
    return out;
  }

  /**
   * Walks by id, so a booking kept after a calendar failure isn't selected again in this run. The delete repeats the
   * test, so a booking that gained a tenant since the select stays.
   */
  private async removeDue(
    removable: Prisma.DemoBookingWhereInput,
    out: DemoBookingRetentionResult,
  ): Promise<void> {
    let budget = RETENTION_MAX_ROWS_PER_RUN;
    let after: string | undefined;
    while (budget > 0) {
      const rows: { id: string; googleEventId: string | null }[] =
        await this.prisma.demoBooking.findMany({
          where: after ? { ...removable, id: { gt: after } } : removable,
          select: { id: true, googleEventId: true },
          orderBy: { id: "asc" },
          take: Math.min(RETENTION_BATCH, budget),
        });
      if (rows.length === 0) return;
      after = rows[rows.length - 1].id;
      budget -= rows.length;

      const cleared: string[] = [];
      for (const row of rows) {
        if (await this.removeEvent(row)) cleared.push(row.id);
        else out.calendarFailed += 1;
      }
      if (cleared.length > 0) {
        const { count } = await this.prisma.demoBooking.deleteMany({
          where: { ...removable, id: { in: cleared } },
        });
        out.deleted += count;
      }
    }
    out.capped = true;
  }

  private async removeEvent(row: { id: string; googleEventId: string | null }): Promise<boolean> {
    if (!row.googleEventId) return true;
    try {
      await this.calendar.deleteEvent(row.googleEventId);
      return true;
    } catch (err) {
      this.logger.warn(
        `Demo booking ${row.id} stays: its calendar event wasn't removed (${(err as Error)?.message})`,
      );
      return false;
    }
  }
}
