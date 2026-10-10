import type { PrismaService } from "../../prisma/prisma.service";

/**
 * #2113 (SA-528) — the durable half of the F-10a mailbox admin alert.
 *
 * `MailboxConnection.alertPendingAt` is set in the SAME transaction as an automatic REVOKED /
 * THROTTLED transition that warrants an alert, so a process that dies between that commit and the
 * notification still owes it. Whoever delivers it — the in-process listener right after the
 * commit, or the `mailbox-alert.sweepPending` job — first CLAIMS it with a compare-and-set that
 * moves the value to a lease in the future, delivers, then CLEARS it with a compare-and-set on
 * that lease. So:
 *   - of any number of concurrent deliverers exactly one wins the claim;
 *   - a deliverer that dies or overruns its deadline leaves the lease in place, and the row is
 *     due again (value <= now) only once the lease has passed — a retry, never a race;
 *   - a clear that finds a different value (a newer transition re-pended the row) does nothing,
 *     so the newer alert is still owed and is delivered once.
 * Every CAS needs a real Date read from the row: `null` would match a row that owes nothing and
 * `undefined` makes Prisma drop the predicate, so both are refused before any query is issued.
 */

/** The sweep's cadence, in minutes: MailboxAlertService.sweepPending runs every 5 minutes. */
export const MAILBOX_ALERT_SWEEP_EVERY_MIN = 5;
/** How far ahead a claim moves `alertPendingAt`: ≥ 3× the sweep cadence (SA-528). */
export const MAILBOX_ALERT_LEASE_MS = 15 * 60_000;
/** A deliverer abandons (without clearing) after this long; well inside the lease. */
export const MAILBOX_ALERT_DELIVERY_DEADLINE_MS = 2 * 60_000;
/** Rows one sweep tick takes on; the rest are still due on the next tick. */
export const MAILBOX_ALERT_SWEEP_BATCH = 100;

type OutboxPrisma = Pick<PrismaService, "mailboxConnection">;

function isRealDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export class MailboxAlertOutbox {
  constructor(
    private readonly prisma: OutboxPrisma,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Claim the alert owed at `seen`; returns the lease, or null when another deliverer won, the
   *  value changed, or `seen` is not a real Date (no query is issued then). */
  async claim(connectionId: string, seen: Date | null | undefined): Promise<Date | null> {
    if (!isRealDate(seen)) return null;
    const lease = new Date(this.now().getTime() + MAILBOX_ALERT_LEASE_MS);
    const { count } = await this.prisma.mailboxConnection.updateMany({
      where: { id: connectionId, alertPendingAt: seen },
      data: { alertPendingAt: lease },
    });
    return count === 1 ? lease : null;
  }

  /** Clear a claimed alert. False — and nothing written — when the row no longer holds `lease`. */
  async clear(connectionId: string, lease: Date): Promise<boolean> {
    if (!isRealDate(lease)) return false;
    const { count } = await this.prisma.mailboxConnection.updateMany({
      where: { id: connectionId, alertPendingAt: lease },
      data: { alertPendingAt: null },
    });
    return count === 1;
  }

  /** Rows whose alert is due now, across every tenant, oldest first. */
  due(): Promise<Array<{ id: string; alertPendingAt: Date | null }>> {
    return this.prisma.mailboxConnection.findMany({
      where: { alertPendingAt: { not: null, lte: this.now() } },
      select: { id: true, alertPendingAt: true },
      orderBy: { alertPendingAt: "asc" },
      take: MAILBOX_ALERT_SWEEP_BATCH,
    });
  }
}
