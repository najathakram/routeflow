/**
 * Pure helpers of `report-billing-pause-blast-radius.mjs` (no connection, no side effects, importable by a test).
 *
 * `TenantSubscription.pastDueSince` is TIMESTAMP(3) WITHOUT a time zone. node-postgres parses such a value as LOCAL
 * time, so on any machine that is not on UTC the instant (and therefore the notice key built from it, and the hours
 * overdue) shifts by the zone offset: every tenant then showed "no reminders sent". The app writes these columns
 * from JS Dates, i.e. as UTC, so the report reads them back as UTC through its client's `types` map.
 */

/** Parse a zoneless Postgres `timestamp` ("2026-11-01 00:00:00.123") as UTC. */
export function parseUtcTimestamp(text) {
  if (text == null) return null;
  const iso = String(text).trim().replace(" ", "T");
  return new Date(/[zZ]|[+-]\d{2}(:?\d{2})?$/.test(iso) ? iso : `${iso}Z`);
}

/**
 * A node-postgres `types` object for `new Client({ types })`: reads `timestamp` (OID 1114) as UTC and leaves every
 * other type to the stock parsers. Per client - it does not touch the process-wide parsers.
 */
export function utcTimestampTypes(pgTypes) {
  return {
    getTypeParser: (oid, format) =>
      oid === 1114 ? parseUtcTimestamp : pgTypes.getTypeParser(oid, format),
  };
}

/** The notice key of one dunning episode, exactly as the service writes it: `<invoiceId>:<pastDueSince ISO>`. */
export function episodeKey(invoiceId, since) {
  return `${invoiceId}:${new Date(since).toISOString()}`;
}
