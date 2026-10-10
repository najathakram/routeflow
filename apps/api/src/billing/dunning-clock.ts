import type { DunningDeps } from "./dunning-core";

/**
 * SA-733r7 r-note 3 (supersedes r-note 2's keep-original clause): `pastDueSince` is the time of the STAMP, always -
 * the webhook stamp, a discovery stamp and a clock moved onto a sibling alike. Every invoice therefore gets one full
 * 7-day runway from its first notice, and an `enforced` flip cannot mass-pause the old backlog.
 *
 * A dunning EPISODE runs from one stamp to the next exit (resume, admin activation, `extendTrial`, a discovery clear).
 * Each episode notifies afresh: every `BillingNotificationLog.key` of a dunning milestone (d0 / d3 / d6 / final /
 * paused) is {@link episodeKey} = `<invoiceId>:<pastDueSince ISO>`. `key` is a free string under
 * `@@unique(tenantId, milestone, key)`, so no migration; the pause condition (final notice >= 24 h old) reads the
 * CURRENT episode's final only. Old episodes' rows are never deleted (audit).
 *
 * RUNBOOK: to forgive an invoice before activating a tenant, void it or mark it uncollectible. Leaving it open
 * restarts dunning with a full week and fresh notices.
 */
export function episodeKey(invoiceId: string, pastDueSince: Date): string {
  return `${invoiceId}:${pastDueSince.toISOString()}`;
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
    /** Stripe's attempt_count for the invoice, when known. */
    attempts?: number;
    /** The failure event time - only a `payment_failed` stamp knows it. */
    firstFailureAt?: Date | null;
  },
): void {
  // "none" was ambiguous: say whether Stripe never tried (0 attempts) or tried at a time this stamp cannot see
  const failure = f.firstFailureAt
    ? f.firstFailureAt.toISOString()
    : f.attempts === 0
      ? "never_attempted"
      : "unknown";
  deps.logger.warn(
    `billing.dunning.clock_started tenant=${f.tenantId} invoice=${f.invoiceId} via=${f.via} ` +
      `stampAt=${f.stampAt.toISOString()} since=${f.since.toISOString()} ` +
      `finalizedAt=${f.finalizedAt ? f.finalizedAt.toISOString() : "none"} ` +
      `attempts=${f.attempts ?? "unknown"} firstFailureAt=${failure}`,
  );
}
