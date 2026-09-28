import { RecurringFrequency } from "@prisma/client";
import { CronExpression } from "@nestjs/schedule";
import { CronTime } from "cron";

/**
 * The midnight run's OWN schedule: the SAME `CronExpression` member `RecurringInvoicesService.generateDueRecurringInvoices`
 * is decorated with (`@LeaderCron` sites must carry an inline expression, so the decorator names the member and this
 * constant names it too; a structural pin fails if either drifts). A customer restore asks THIS definition when a
 * billing tick fell (SA-308: never a second, hand-typed definition of "when does the cron run"). The cron's "due"
 * rule is `nextRunAt <= tick`.
 */
export const RECURRING_INVOICES_CRON = CronExpression.EVERY_DAY_AT_MIDNIGHT;

/** The first billing tick AT OR AFTER `t`, from the cron's own schedule (server-local time, like `@Cron`). */
export function firstTickAtOrAfter(t: Date): Date {
  return new CronTime(RECURRING_INVOICES_CRON)
    .getNextDateFrom(new Date(t.getTime() - 1))
    .toJSDate();
}

/**
 * The next run of a recurring template strictly after `from`'s calendar day (REG-B46 rules), moved verbatim out
 * of RecurringInvoicesService so a customer RESTORE can advance its templates' schedules without depending on
 * the service. Pure: no query, no write.
 */
export function calcNextRunAt(
  frequency: RecurringFrequency,
  dayOfWeek?: number | null,
  dayOfMonth?: number | null,
  from: Date = new Date(),
): Date {
  if (frequency === RecurringFrequency.MONTHLY) {
    // REG-B46: the old branch called d.setDate(1) BEFORE testing d.getDate() > dom, so
    // the test was always `1 > dom` (false) and the month never advanced — the midnight
    // cron re-selected every MONTHLY template nightly. Decide from `from` itself: the
    // template's dayOfMonth in the earliest month whose occurrence is STRICTLY after
    // `from`'s calendar day, re-applied from `dom` each month and clamped to that
    // month's length (dom 31 → Feb 28 → Mar 31, no drift; Dec → Jan of next year).
    // Clamp first: `dayOfMonth` is a nullable Int with no DB constraint and the PATCH was
    // unvalidated until REG-B92, so a stored 0 or negative is reachable — and it would
    // make the loop below never advance (occurrence(y, m) would land in month m-1 and
    // come straight back to the same date), hanging the event loop and with it the cron
    // and the whole API process. A corrupt row degrades to day 1, never to a hang.
    const dom = Math.min(31, Math.max(1, Math.trunc(Number(dayOfMonth)) || 1));
    const base = new Date(from);
    base.setHours(0, 0, 0, 0);
    const occurrence = (year: number, monthIndex: number): Date => {
      const lastDay = new Date(year, monthIndex + 1, 0).getDate();
      return new Date(year, monthIndex, Math.min(dom, lastDay));
    };
    let next = occurrence(base.getFullYear(), base.getMonth());
    while (next.getTime() <= base.getTime()) {
      next = occurrence(next.getFullYear(), next.getMonth() + 1);
    }
    return next;
  }

  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1); // always at least tomorrow

  // WEEKLY or BIWEEKLY — find next occurrence of dayOfWeek   ← UNCHANGED from here down
  const dow = dayOfWeek ?? 1; // default Monday
  const current = d.getDay();
  const daysUntil = (dow - current + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntil);
  if (frequency === RecurringFrequency.BIWEEKLY) d.setDate(d.getDate() + 7);
  return d;
}

/**
 * F-05 (SA-290, SA-308): a customer RESTORE is a pause ending — but only cycles the removal actually skipped are
 * skipped. For each of the customer's ACTIVE templates that is due (`nextRunAt <= now`, the cron's own rule), a
 * billing tick T fell INSIDE the removal iff `max(nextRunAt, deletedAt) <= T <= now`, with T taken from the cron's
 * own schedule (`firstTickAtOrAfter`, i.e. `RECURRING_INVOICES_CRON`). Then, in the restore's own transaction, the
 * template is advanced to the next occurrence after now and the reactivation-class audit row (reason
 * CUSTOMER_RESTORED, the skipped cycle, the restoring actor) is written. Otherwise nextRunAt is untouched and the
 * cron bills it normally: an Undo within the same day, a template due today that was never billed, or a failed run
 * given back for retry with no tick inside the removal. A make-up is only an explicit "Run now".
 * The write is conditional on the row still being active AND still at the date we read, so a concurrent change is
 * a no-op, never a second advance.
 */
export async function resumeSchedulesOnRestore(
  tx: any,
  customer: { id: string; tenantId: string | null; deletedAt: Date | null },
  actorUserId: string | null = null,
  now: Date = new Date(),
): Promise<number> {
  const rows: {
    id: string;
    frequency: RecurringFrequency;
    dayOfWeek: number | null;
    dayOfMonth: number | null;
    nextRunAt: Date;
  }[] = await tx.recurringInvoice.findMany({
    where: { customerId: customer.id, isActive: true, nextRunAt: { lte: now } },
    select: { id: true, frequency: true, dayOfWeek: true, dayOfMonth: true, nextRunAt: true },
  });
  let advanced = 0;
  for (const r of rows) {
    const gone = customer.deletedAt;
    const from = gone && gone.getTime() > r.nextRunAt.getTime() ? gone : r.nextRunAt;
    if (firstTickAtOrAfter(from).getTime() > now.getTime()) continue; // no billing tick fell inside the removal
    const resumedAt = calcNextRunAt(r.frequency, r.dayOfWeek, r.dayOfMonth, now);
    const { count } = await tx.recurringInvoice.updateMany({
      where: { id: r.id, isActive: true, nextRunAt: r.nextRunAt },
      data: { nextRunAt: resumedAt },
    });
    if (count === 0) continue;
    advanced += 1;
    await tx.auditLog.create({
      data: {
        tenantId: customer.tenantId,
        userId: actorUserId,
        action: "recurring-invoice.reactivated",
        entityType: "recurring-invoices",
        entityId: r.id,
        meta: {
          reason: "CUSTOMER_RESTORED",
          skippedCycleDueAt: r.nextRunAt.toISOString(),
          resumedAt: resumedAt.toISOString(),
        },
      },
    });
  }
  return advanced;
}
