/**
 * #2476 / SA-472 — the exclusive claim both Stripe webhook ledgers (StripeBillingEvent,
 * StripeConnectEvent) use when a delivery's insert collides (P2002) with an already-ledgered event id.
 *
 * State lives in the columns the ledgers already have — no migration, no parsed string:
 *   outcome NULL      = claimed / in flight (the inserting delivery holds it)
 *   outcome "error:…" = failed, retryable at once
 *   any other outcome = done (a true duplicate)
 *   processedAt       = the claim time, and the lease clock
 *
 * ONE updateMany takes the row: an "error:" row immediately, or a NULL row whose claim is older than
 * WEBHOOK_CLAIM_LEASE_MS (its worker crashed or hung). Count 1 ⇒ this delivery runs the handler. Count 0
 * ⇒ re-read: completed ⇒ a duplicate (200); otherwise another worker is running it ⇒ in flight (the
 * caller answers 503 — a 2xx would acknowledge an event that worker may still fail).
 */
export const WEBHOOK_CLAIM_LEASE_MS = 5 * 60 * 1000;

export type WebhookClaim = "claimed" | "duplicate" | "in_flight";

type LedgerDelegate = {
  updateMany(args: {
    where: Record<string, unknown>;
    data: { processedAt: Date; outcome: null };
  }): Promise<{ count: number }>;
  findUnique(args: { where: { id: string } }): Promise<{ outcome: string | null } | null>;
};

/** A ledger row is done once it holds a non-null, non-"error:" outcome (NULL is never done). */
export function isCompletedOutcome(outcome: string | null | undefined): boolean {
  return !!outcome && !outcome.startsWith("error:");
}

export async function claimRedelivery(
  ledger: LedgerDelegate,
  eventId: string,
  now: Date = new Date(),
): Promise<WebhookClaim> {
  const { count } = await ledger.updateMany({
    where: {
      id: eventId,
      OR: [
        { outcome: { startsWith: "error:" } },
        { outcome: null, processedAt: { lt: new Date(now.getTime() - WEBHOOK_CLAIM_LEASE_MS) } },
      ],
    },
    data: { processedAt: now, outcome: null },
  });
  if (count === 1) return "claimed";
  const row = await ledger.findUnique({ where: { id: eventId } });
  return isCompletedOutcome(row?.outcome) ? "duplicate" : "in_flight";
}
