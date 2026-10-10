import type { InvoiceFacts } from "./catchup-claim";
import {
  DUNNING_D3_HOURS,
  DUNNING_D6_HOURS,
  DUNNING_MILESTONES,
  DUNNING_PAUSE_HOURS,
  HOUR_MS,
} from "./dunning-config";
import type { DunningDeps } from "./dunning-core";
import { hoursSince } from "./dunning-time";

/**
 * SA-733r7 PR-B3 (brief item 2 / SA-733r M4): the d0 / d3 / d6 reminders, keyed in `BillingNotificationLog` by
 * (tenant, milestone, invoiceId) so an hourly sweep or a redelivered webhook sends each once per invoice.
 *
 *   - They send in `dark` too; `off` sends nothing. The copy is truthful for the mode: `dark`'s d6 names no date.
 *   - In `enforced` the d6 notice IS the final notice ("read-only tomorrow") and also records `dunning_final` in
 *     the log. If d6 already went out in `dark`, the flip sends a separate final notice instead - so flipping to
 *     `enforced` pauses nobody in hour one: the pause waits for a `dunning_final` that is >= 24 h old.
 *   - Every send re-reads the invoice first (the caller passes the fresh facts): paid / void / processing = no email.
 *
 * Returns the instant `dunning_final` was sent (this run or earlier), or null when it never was.
 */
export async function runMilestones(
  deps: DunningDeps,
  row: { tenantId: string; pastDueInvoiceId: string; pastDueSince: Date },
  facts: InvoiceFacts,
  now: Date,
): Promise<Date | null> {
  const mode = deps.mode();
  if (mode === "off") return null;
  const { tenantId, pastDueInvoiceId: invoiceId } = row;
  const M = DUNNING_MILESTONES;

  const logged = await deps.prisma.billingNotificationLog.findMany({
    where: { tenantId, key: invoiceId, milestone: { in: [M.D0, M.D3, M.D6, M.FINAL] } },
    select: { milestone: true, sentAt: true },
  });
  const sent = new Map(logged.map((l) => [l.milestone, l.sentAt]));
  const elapsed = hoursSince(row.pastDueSince, now);
  const payUrl = facts.hostedInvoiceUrl ?? null;

  const send = (
    milestone: string,
    kind: "d0" | "d3" | "d6" | "final",
    dates: { readOnlyOn?: string; byDate?: string } = {},
  ) => deps.notifications.notifyDunning(tenantId, milestone, invoiceId, kind, { payUrl, ...dates });
  const readOnlyOn = () =>
    deps.notifications.localDateLabel(tenantId, new Date(now.getTime() + 24 * HOUR_MS));

  const warnUndeliverable = (res: { status: string }) => {
    if (res.status === "no_recipients" && deps.once(`no_admin:${tenantId}:${invoiceId}`)) {
      deps.logger.warn(
        `billing.dunning.no_deliverable_admin tenant=${tenantId} invoice=${invoiceId} - no notice can be delivered, so the pause will never be due`,
      );
    }
    return res;
  };

  if (!sent.has(M.D0)) warnUndeliverable(await send(M.D0, "d0"));
  if (elapsed >= DUNNING_D3_HOURS && !sent.has(M.D3)) warnUndeliverable(await send(M.D3, "d3"));

  let finalSentAt = sent.get(M.FINAL) ?? null;
  if (elapsed >= DUNNING_D6_HOURS) {
    if (mode === "dark") {
      if (!sent.has(M.D6)) {
        // dark: nothing will happen, so the copy names no read-only date - only when to update the card by
        const byDate = await deps.notifications.localDateLabel(
          tenantId,
          new Date(row.pastDueSince.getTime() + DUNNING_PAUSE_HOURS * HOUR_MS),
        );
        warnUndeliverable(await send(M.D6, "d6", { byDate }));
      }
    } else if (!sent.has(M.D6)) {
      // enforced, first time: this d6 email is the final notice - record both.
      const res = warnUndeliverable(await send(M.D6, "final", { readOnlyOn: await readOnlyOn() }));
      if (res.status === "sent" && !finalSentAt) {
        await deps.notifications.recordDunningMilestone(tenantId, M.FINAL, invoiceId);
        finalSentAt = now;
      }
    } else if (!finalSentAt) {
      // enforced after a dark d6: a separate final notice, then the 24 h lead starts.
      const res = warnUndeliverable(
        await send(M.FINAL, "final", { readOnlyOn: await readOnlyOn() }),
      );
      if (res.status === "sent") finalSentAt = now;
    }
  }
  return finalSentAt;
}
