import type { InvoiceFacts } from "./catchup-claim";
import {
  DUNNING_D3_HOURS,
  DUNNING_D6_HOURS,
  DUNNING_MILESTONES,
  dunningEmailsFor,
  HOUR_MS,
} from "./dunning-config";
import { episodeKey } from "./dunning-clock";
import { autoLockAllowed } from "./auto-lock-gate";
import { type DunningDeps, remainingCents } from "./dunning-core";
import { hoursSince } from "./dunning-time";
import {
  finalReissueKey,
  finalReissuePrefix,
  latestCountingFinal,
  staleFinalBoundary,
} from "./dunning-final";

/**
 * SA-733r7 PR-B3 (brief item 2 / SA-733r M4): the d0 / d3 / d6 reminders, keyed in `BillingNotificationLog` by
 * (tenant, milestone, episode key = `<invoiceId>:<pastDueSince ISO>`) so an hourly sweep or a redelivered webhook sends each once per invoice.
 *
 *   - They send ONLY in `enforced` (SA r-note 5 A1: dark is silent to tenants; `dunningEmailsFor` is the one switch).
 *     In `off` / `dark` the sweep stamps and logs, and master's failed-payment email is the only tenant email.
 *   - The d6 notice IS the final notice ("read-only tomorrow") and also records `dunning_final` in the log. The
 *     pause waits for a `dunning_final` that is >= 24 h old, so flipping to `enforced` pauses nobody in hour one.
 *   - Every send re-reads the invoice first (the caller passes the fresh facts): paid / void / processing = no email.
 *
 *   - A tenant that is already PAUSED (SA G8) gets none of d0/d3/d6/final - there is nothing left to warn about. The
 *     suppression is logged once per episode, and ONE `paused_still_owed` notice per episode says the workspace is
 *     still read-only, which invoice is open and how to pay it. The tenant stays paused.
 *
 *   - Row 412: for a tenant the rollout pause protects, a final sent BEFORE the switch's last unpause does not count
 *     (see dunning-final.ts): it is re-issued under a key per unpause, with a new 24 h lead.
 *
 * Returns the instant of the `dunning_final` that COUNTS (this run or earlier), or null when none does.
 */
export async function runMilestones(
  deps: DunningDeps,
  row: {
    tenantId: string;
    pastDueInvoiceId: string;
    pastDueSince: Date;
    /** The tenant class, for the SA-775 gate that decides whether the final notice may threaten a lock. */
    tenantClass?: string | null;
  },
  facts: InvoiceFacts,
  now: Date,
  opts: { paused?: boolean } = {},
): Promise<Date | null> {
  // SA r-note 5 A1: dark (and off) are SILENT to tenants - the sweep stamps and logs only; the series sends in enforced.
  if (dunningEmailsFor(deps.mode()) !== "milestones") return null;
  const { tenantId, pastDueInvoiceId: invoiceId } = row;
  // the notice key of THIS episode (SA r-note 3): a re-stamp after an exit notifies afresh
  const key = episodeKey(invoiceId, row.pastDueSince);
  const M = DUNNING_MILESTONES;

  const logged = await deps.prisma.billingNotificationLog.findMany({
    where: {
      tenantId,
      key,
      milestone: { in: [M.D0, M.D3, M.D6, M.FINAL, M.PAUSED, M.PAUSED_STILL_OWED] },
    },
    select: { milestone: true, sentAt: true },
  });
  const sent = new Map(logged.map((l) => [l.milestone, l.sentAt]));
  // Row 412: a final sent before the switch's last unpause is stale for a protected tenant (null = nothing is stale).
  const boundary = await staleFinalBoundary(deps.autoLocks, row.tenantClass);
  const reissued = boundary
    ? await deps.prisma.billingNotificationLog.findMany({
        where: { tenantId, milestone: M.FINAL, key: { startsWith: finalReissuePrefix(key) } },
        select: { sentAt: true },
      })
    : [];
  const finalClaims = [
    ...(sent.has(M.FINAL) ? [{ sentAt: sent.get(M.FINAL) as Date }] : []),
    ...reissued,
  ];
  // the claim key of a final sent from here: the episode's own key until one was claimed under it, then one per unpause
  const finalClaimKey = boundary && sent.has(M.FINAL) ? finalReissueKey(key, boundary) : key;
  const elapsed = hoursSince(row.pastDueSince, now);
  const payUrl = facts.hostedInvoiceUrl ?? null;

  // `paused`: the tenant is already read-only, so the message is about the still-owed notice, once per EPISODE
  // (the claim is released on a send nobody accepted, so every sweep retries quietly; the operator hears once).
  const warnUndeliverable = (res: { status: string }, paused = false) => {
    const onceKey = paused ? `no_admin_paused:${key}` : `no_admin:${tenantId}:${invoiceId}`;
    if (res.status === "no_recipients" && deps.once(onceKey)) {
      deps.logger.warn(
        `billing.dunning.no_deliverable_admin tenant=${tenantId} invoice=${invoiceId} - ${
          paused
            ? "the paused-still-owed notice cannot be delivered"
            : "no notice can be delivered, so the pause will never be due"
        }`,
      );
    }
    return res;
  };

  if (opts.paused) {
    // SA G8: nothing to warn about any more. Log what is held back once per episode; tell the admin once.
    if (deps.once(`paused_suppressed:${key}`)) {
      deps.logger.log(
        `billing.dunning.paused_notices_suppressed tenant=${tenantId} invoice=${invoiceId} episode=${key}`,
      );
    }
    // The pause itself already told THIS episode's admin (DUNNING_PAUSED: read-only now, pay the open invoice, with the
    // hosted link), so a still-owed notice an hour later would be a second mail for one event. A clock moved while
    // paused is a new episode with no PAUSED under its key: that one gets its single still-owed notice.
    if (!sent.has(M.PAUSED) && !sent.has(M.PAUSED_STILL_OWED)) {
      warnUndeliverable(
        await deps.notifications.notifyDunning(
          tenantId,
          M.PAUSED_STILL_OWED,
          key,
          "paused_still_owed",
          {
            payUrl,
            invoiceNumber: facts.invoiceNumber ?? null,
            amountCents: remainingCents(facts),
            currency: facts.currency ?? null,
          },
        ),
        true,
      );
    }
    return null;
  }

  // `attempted` keys the d0 copy: an invoice Stripe never tried (a discovery stamp) is "open - pay it here", never
  // "we couldn't process your payment".
  const send = (
    milestone: string,
    kind: "d0" | "d3" | "final",
    dates: { readOnlyOn?: string } = {},
    omitLockWarning?: boolean,
    claimKey: string = key,
  ) =>
    deps.notifications.notifyDunning(tenantId, milestone, claimKey, kind, {
      payUrl,
      attempted: facts.attemptCount > 0,
      amountCents: remainingCents(facts),
      currency: facts.currency ?? null,
      periodLabel: facts.periodLabel ?? null,
      invoiceNumber: facts.invoiceNumber ?? null,
      ...(omitLockWarning === undefined ? {} : { omitLockWarning }),
      ...dates,
    });
  // SA-775 rollout: the final notice says the workspace becomes read-only. While the rollout pause holds that lock (the
  // same gate the pause asks) it must not say so, AND it must not count as the final notice: a tenant that is later
  // unpaused would otherwise be paused 24 h on without ever having been told. Without an injected switch (a bare unit
  // spec) nothing is held and the copy is unchanged.
  const pauseHoldsLock = async (): Promise<boolean> =>
    deps.autoLocks
      ? !(await autoLockAllowed(
          deps.autoLocks,
          { id: tenantId, class: row.tenantClass },
          "payment_overdue",
        ))
      : false;
  const omitFor = (held: boolean) => (deps.autoLocks ? held : undefined);
  const readOnlyOn = () =>
    deps.notifications.localDateLabel(tenantId, new Date(now.getTime() + 24 * HOUR_MS));

  // SAFETY NET (Opus re-review): ONLY the highest milestone that is due goes out in a sweep. A clock that carries an
  // old time (a legacy backlog, a restored clock) must not mail d0 + d3 + d6 in one hour; the earlier ones are
  // RECORDED as skipped so they never send later.
  const dueAll = [
    [M.D0, 0],
    [M.D3, DUNNING_D3_HOURS],
    [M.D6, DUNNING_D6_HOURS],
  ] as const;
  const unsent = dueAll.filter(([m, h]) => elapsed >= h && !sent.has(m)).map(([m]) => m);
  const top = unsent[unsent.length - 1];
  for (const skipped of unsent.slice(0, -1)) {
    await deps.notifications.recordDunningMilestone(tenantId, skipped, key);
    sent.set(skipped, now);
  }

  let finalSentAt = latestCountingFinal(finalClaims, boundary);
  if (
    boundary &&
    finalClaims.length > 0 &&
    !finalSentAt &&
    deps.once(`final_stale:${finalClaimKey}`)
  ) {
    deps.logger.log(
      `billing.dunning.final_stale_after_unpause tenant=${tenantId} invoice=${invoiceId} unpausedAt=${boundary.toISOString()}`,
    );
  }
  if (top === M.D0) {
    warnUndeliverable(await send(M.D0, "d0"));
  } else if (top === M.D3) {
    warnUndeliverable(await send(M.D3, "d3"));
  } else if (top === M.D6) {
    const held = await pauseHoldsLock();
    if (held) {
      // The lock is held: the neutral notice goes out under D6 only (its own claim, so once). It is NOT the final
      // notice: no DUNNING_FINAL, no finalSentAt - the real final (with its date) goes out once the lock is allowed.
      warnUndeliverable(await send(M.D6, "final", {}, true));
    } else {
      // enforced, first time: this d6 email IS the final notice - record both.
      const res = warnUndeliverable(
        await send(M.D6, "final", { readOnlyOn: await readOnlyOn() }, omitFor(false)),
      );
      if (res.status === "sent" && !finalSentAt) {
        await deps.notifications.recordDunningMilestone(tenantId, M.FINAL, finalClaimKey);
        finalSentAt = now;
      }
    }
  } else if (elapsed >= DUNNING_D6_HOURS && !finalSentAt && !(await pauseHoldsLock())) {
    // d6 already logged without a final notice (it went out by another route, or as the neutral held notice): a
    // separate final notice, then the 24 h lead starts. While the lock is held nothing is sent here (no hourly resend).
    const res = warnUndeliverable(
      await send(
        M.FINAL,
        "final",
        { readOnlyOn: await readOnlyOn() },
        omitFor(false),
        finalClaimKey,
      ),
    );
    if (res.status === "sent") finalSentAt = now;
  }
  return finalSentAt;
}
