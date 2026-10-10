import type { InvoiceFacts } from "./catchup-claim";
import {
  DUNNING_D3_HOURS,
  DUNNING_D6_HOURS,
  DUNNING_MILESTONES,
  DUNNING_PAUSE_HOURS,
  HOUR_MS,
} from "./dunning-config";
import { episodeKey } from "./dunning-clock";
import { type DunningDeps, remainingCents } from "./dunning-core";
import { hoursSince } from "./dunning-time";

/**
 * SA-733r7 PR-B3 (brief item 2 / SA-733r M4): the d0 / d3 / d6 reminders, keyed in `BillingNotificationLog` by
 * (tenant, milestone, episode key = `<invoiceId>:<pastDueSince ISO>`) so an hourly sweep or a redelivered webhook sends each once per invoice.
 *
 *   - They send in `dark` too; `off` sends nothing. The copy is truthful for the mode: `dark`'s d6 names no date.
 *   - In `enforced` the d6 notice IS the final notice ("read-only tomorrow") and also records `dunning_final` in
 *     the log. If d6 already went out in `dark`, the flip sends a separate final notice instead - so flipping to
 *     `enforced` pauses nobody in hour one: the pause waits for a `dunning_final` that is >= 24 h old.
 *   - Every send re-reads the invoice first (the caller passes the fresh facts): paid / void / processing = no email.
 *
 *   - A tenant that is already PAUSED (SA G8) gets none of d0/d3/d6/final - there is nothing left to warn about. The
 *     suppression is logged once per episode, and ONE `paused_still_owed` notice per episode says the workspace is
 *     still read-only, which invoice is open and how to pay it. The tenant stays paused.
 *
 * Returns the instant `dunning_final` was sent (this run or earlier), or null when it never was.
 */
export async function runMilestones(
  deps: DunningDeps,
  row: { tenantId: string; pastDueInvoiceId: string; pastDueSince: Date },
  facts: InvoiceFacts,
  now: Date,
  opts: { paused?: boolean } = {},
): Promise<Date | null> {
  const mode = deps.mode();
  if (mode === "off") return null;
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

  const send = (
    milestone: string,
    kind: "d0" | "d3" | "d6" | "final",
    dates: { readOnlyOn?: string; byDate?: string } = {},
  ) => deps.notifications.notifyDunning(tenantId, milestone, key, kind, { payUrl, ...dates });
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

  let finalSentAt = sent.get(M.FINAL) ?? null;
  if (top === M.D0) {
    warnUndeliverable(await send(M.D0, "d0"));
  } else if (top === M.D3) {
    warnUndeliverable(await send(M.D3, "d3"));
  } else if (top === M.D6) {
    if (mode === "dark") {
      // dark: nothing will happen, so the copy names no read-only date - only when to update the card by, never
      // in the past: at least a day from now
      const byDate = await deps.notifications.localDateLabel(
        tenantId,
        new Date(
          Math.max(
            row.pastDueSince.getTime() + DUNNING_PAUSE_HOURS * HOUR_MS,
            now.getTime() + 24 * HOUR_MS,
          ),
        ),
      );
      warnUndeliverable(await send(M.D6, "d6", { byDate }));
    } else {
      // enforced, first time: this d6 email is the final notice - record both.
      const res = warnUndeliverable(await send(M.D6, "final", { readOnlyOn: await readOnlyOn() }));
      if (res.status === "sent" && !finalSentAt) {
        await deps.notifications.recordDunningMilestone(tenantId, M.FINAL, key);
        finalSentAt = now;
      }
    }
  } else if (mode === "enforced" && elapsed >= DUNNING_D6_HOURS && !finalSentAt) {
    // enforced after a dark d6: a separate final notice, then the 24 h lead starts.
    const res = warnUndeliverable(await send(M.FINAL, "final", { readOnlyOn: await readOnlyOn() }));
    if (res.status === "sent") finalSentAt = now;
  }
  return finalSentAt;
}
