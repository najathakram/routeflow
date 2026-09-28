import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * #2476 / SA-472 — the insert and the exclusive claim both Stripe webhook ledgers (StripeBillingEvent,
 * StripeConnectEvent) use. Every delivery either inserts the event's row or, on a redelivery, claims it.
 *
 * State lives in the columns the ledgers already have — no migration, no parsed string:
 *   outcome NULL      = claimed / in flight (the inserting or claiming delivery holds it)
 *   outcome "error:…" = failed, retryable at once
 *   any other outcome = done (a true duplicate)
 *   processedAt       = the claim time: the lease clock AND the holder's fencing token
 *
 * processedAt is always written by the DATABASE clock (CURRENT_TIMESTAMP, stored as UTC like every
 * Prisma-written timestamp), and the lease is measured against the same clock — replica clock skew can
 * never shorten or stretch a lease.
 *
 * ONE standalone UPDATE takes the row: an "error:" row immediately, or a NULL row whose claim is older
 * than WEBHOOK_CLAIM_LEASE_MS (its worker crashed or hung). A row back ⇒ this delivery runs the handler
 * and holds the returned processedAt as its token. No row ⇒ re-read: completed ⇒ a duplicate (200);
 * otherwise another worker is running it ⇒ in flight (the caller answers 503 — a 2xx would acknowledge
 * an event that worker may still fail). The holder writes its outcome only while processedAt still
 * equals its token (see the controllers), so a worker whose lease was taken over cannot overwrite the
 * new holder's result.
 */

/**
 * The lease must outlast one delivery's whole handler, or a slow-but-alive worker is re-claimed and the
 * event runs twice. The slowest handler path is onPaymentFailed's admin email: its billing-portal call is
 * capped at 10 s with no network retries (billing.service.ts PAYMENT_FAILED_PORTAL_REQUEST; stripe-node's
 * defaults would allow minutes), then at most ~35 s of SMTP timeouts (email.service.ts: connection 10 s +
 * greeting 10 s + socket 15 s), plus a few DB round trips — well under a minute in all.
 * Stripe abandons an unanswered delivery long before five minutes, so an expired lease only ever
 * belongs to a worker that crashed or hung — never to one Stripe is still waiting on.
 */
export const WEBHOOK_CLAIM_LEASE_MS = 5 * 60 * 1000;

export type WebhookLedgerTable = "StripeBillingEvent" | "StripeConnectEvent";

export type WebhookClaim =
  { kind: "claimed"; token: Date } | { kind: "duplicate" } | { kind: "in_flight" };

type RawDb = Pick<PrismaClient, "$queryRaw">;

/** Whitelisted identifiers only — never a caller-supplied string in the SQL. */
const TABLE_SQL: Record<WebhookLedgerTable, Prisma.Sql> = {
  StripeBillingEvent: Prisma.raw('"StripeBillingEvent"'),
  StripeConnectEvent: Prisma.raw('"StripeConnectEvent"'),
};

/**
 * The database clock as a UTC wall time — the convention Prisma reads TIMESTAMP(3) columns with.
 * SA-472b: the ONE spelling of "now" for the insert value, the claim SET and the lease compare. A bare
 * now() is timestamptz; assigned to a TIMESTAMP(3) column it is cast by the SESSION time zone, so on a
 * non-UTC session the stored claim would drift from the UTC convention and the lease/fence with it.
 */
export const DB_NOW_UTC = Prisma.sql`(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`;

/** A ledger row is done once it holds a non-null, non-"error:" outcome (NULL is never done). */
export function isCompletedOutcome(outcome: string | null | undefined): boolean {
  return !!outcome && !outcome.startsWith("error:");
}

/**
 * Insert-first: ledger the event before any handler write, claimed by this delivery (outcome NULL,
 * processedAt = the DB clock). Returns the claim token, or null when the id is already ledgered (a
 * redelivery — the caller then calls claimRedelivery).
 */
export async function insertLedgerRow(
  db: RawDb,
  table: WebhookLedgerTable,
  row: { id: string; type: string; createdAt: Date; accountRef?: string },
): Promise<Date | null> {
  const createdAt = Prisma.sql`(${row.createdAt.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  const insert =
    table === "StripeConnectEvent"
      ? Prisma.sql`INSERT INTO ${TABLE_SQL[table]} ("id", "accountRef", "type", "createdAt", "processedAt", "outcome")
          VALUES (${row.id}, ${row.accountRef ?? ""}, ${row.type}, ${createdAt}, ${DB_NOW_UTC}, NULL)`
      : Prisma.sql`INSERT INTO ${TABLE_SQL[table]} ("id", "type", "createdAt", "processedAt", "outcome")
          VALUES (${row.id}, ${row.type}, ${createdAt}, ${DB_NOW_UTC}, NULL)`;
  const rows = await db.$queryRaw<{ processedAt: Date }[]>(
    Prisma.sql`${insert} ON CONFLICT ("id") DO NOTHING RETURNING "processedAt"`,
  );
  return rows[0]?.processedAt ?? null;
}

export async function claimRedelivery(
  db: RawDb,
  table: WebhookLedgerTable,
  eventId: string,
): Promise<WebhookClaim> {
  const lease = `${WEBHOOK_CLAIM_LEASE_MS} milliseconds`;
  const claimed = await db.$queryRaw<{ processedAt: Date }[]>(
    Prisma.sql`UPDATE ${TABLE_SQL[table]}
      SET "processedAt" = ${DB_NOW_UTC}, "outcome" = NULL
      WHERE "id" = ${eventId}
        AND ("outcome" LIKE 'error:%'
          OR ("outcome" IS NULL AND "processedAt" < ${DB_NOW_UTC} - ${lease}::interval))
      RETURNING "processedAt"`,
  );
  if (claimed[0]) return { kind: "claimed", token: claimed[0].processedAt };
  const current = await db.$queryRaw<{ outcome: string | null }[]>(
    Prisma.sql`SELECT "outcome" FROM ${TABLE_SQL[table]} WHERE "id" = ${eventId}`,
  );
  return isCompletedOutcome(current[0]?.outcome) ? { kind: "duplicate" } : { kind: "in_flight" };
}
