import { DUNNING_MILESTONES } from "./dunning-config";
import type { DunningDeps } from "./dunning-core";

/**
 * SA-733r7 r-note 2 (2): EVERY invoice gets one full notice runway. `pastDueSince` is the STAMP time whenever no d0
 * has gone out for that `invoiceId` - a discovery stamp of an old never-attempted invoice, or a clock moved onto a
 * sibling - so the 7-day grace starts at the first notice, and an `enforced` flip cannot mass-pause the old backlog.
 * The original time is kept ONLY when that same invoice's d0 already went out (its `DUNNING_D0` log row's `sentAt`
 * is when it was first clocked), so moving back and forth never restarts it.
 */
export async function clockStartFor(
  deps: Pick<DunningDeps, "prisma">,
  tenantId: string,
  invoiceId: string,
  stampAt: Date,
): Promise<Date> {
  const d0 = await deps.prisma.billingNotificationLog.findFirst({
    where: { tenantId, milestone: DUNNING_MILESTONES.D0, key: invoiceId },
    select: { sentAt: true },
  });
  return d0?.sentAt ?? stampAt;
}

/** One structured line per clock start, for the blast-radius report: when it was stamped vs finalized / first failed. */
export function logClockStarted(
  deps: Pick<DunningDeps, "logger">,
  f: {
    tenantId: string;
    invoiceId: string;
    via: "payment_failed" | "discovery" | "moved";
    stampAt: Date;
    since: Date;
    finalizedAt?: Date | null;
    firstFailureAt?: Date | null;
  },
): void {
  deps.logger.warn(
    `billing.dunning.clock_started tenant=${f.tenantId} invoice=${f.invoiceId} via=${f.via} ` +
      `stampAt=${f.stampAt.toISOString()} since=${f.since.toISOString()} ` +
      `finalizedAt=${f.finalizedAt ? f.finalizedAt.toISOString() : "none"} ` +
      `firstFailureAt=${f.firstFailureAt ? f.firstFailureAt.toISOString() : "none"}`,
  );
}
