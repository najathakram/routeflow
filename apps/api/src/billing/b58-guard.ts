import { planRank } from "./plan-catalog.constants";

/**
 * The B58 guard as ONE pure function (#2189 / SA-389): subscribe() calls it twice — pre-tx as the
 * fast refusal, and again inside the transaction on the rows re-read under the tenant lock, so a
 * concurrent commit between the two reads can never let a stale "allowed" through.
 *
 * An ACTIVE, same-cycle pick belongs anywhere but subscribe() — resetting periodStart/periodEnd
 * would silently re-bucket metering and jump the renewal date (B58). A DIFFERENT rank belongs on
 * upgrade()/downgrade() (instant-prorated vs. scheduled-at-period-end). The SAME rank is the same
 * plan under a renamed key (a v7 BUSINESS re-picked as the v8 SCALE): there is nothing to change,
 * and re-subscribing to "re-pin" the catalog version would pay for that pin with the same period
 * reset — so it is refused too; the re-pin is left to platform-admin / the cron that write it. A
 * subscription with NO periodEnd has no live cycle to protect (and downgrade() could not schedule
 * against it), so it passes: subscribe() is what heals the missing period.
 */
export interface B58GuardInput {
  /** The tenant's status. */
  status: string;
  /** The plan being changed FROM, already resolved + normalized (resolveFromPlanKey). */
  fromKey: string | null;
  /** The tenant's subscription row, or null. */
  sub: { planKey: string | null; cycle: string; periodEnd: Date | null } | null;
  toPlanKey: string;
  toCycle: string;
}

export interface B58Refusal {
  sameRank: boolean;
  message: string;
}

/** The refusal subscribe() must throw (as a 409), or null when the pick may proceed. */
export function b58GuardRefusal(i: B58GuardInput): B58Refusal | null {
  if (
    i.status !== "ACTIVE" ||
    !i.sub ||
    !i.fromKey ||
    i.sub.periodEnd == null ||
    i.sub.cycle !== i.toCycle
  ) {
    return null;
  }
  const sameRank = planRank(i.toPlanKey) === planRank(i.fromKey);
  // The ONE same-rank pick that really is a change: a row with no stored planKey (the
  // manual-activation shape) contributes 0 to the MRR snapshot until it gains one, and upgrade()
  // only moves UP — so subscribe() is what heals it, and refusing it would strand it plan-less.
  if (sameRank && i.sub.planKey == null) return null;
  return {
    sameRank,
    message: sameRank
      ? "You are already on this plan — nothing to change"
      : "Your subscription is active — use upgrade or downgrade to change plan",
  };
}
