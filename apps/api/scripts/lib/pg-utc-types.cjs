/**
 * W-781: Prisma `DateTime` columns are `timestamp(3)` WITHOUT time zone and hold UTC wall-clock
 * values. node-postgres parses that type (OID 1114) as HOST-LOCAL time, so an owner-run report on
 * a non-UTC machine shifts every such date by the host offset (e.g. 5-6h under America/Chicago).
 * Owner-run reports pass `{ types: utcTimestampTypes }` to their `pg.Pool` so a raw timestamp is
 * read as the UTC instant it is. (timestamptz, OID 1184, is already exact and is left alone.)
 */
const TIMESTAMP_OID = 1114;

/** "2026-03-10 12:00:00.123" (no zone suffix) -> the UTC instant. null passes through. */
function parseUtcTimestamp(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === "infinity") return Infinity;
  if (s === "-infinity") return -Infinity;
  const d = new Date(`${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `types` option for `new pg.Pool({ types })`: default parsers, timestamp read as UTC. */
const utcTimestampTypes = {
  getTypeParser(oid, format) {
    if (oid === TIMESTAMP_OID && format !== "binary") return parseUtcTimestamp;
    return require("pg").types.getTypeParser(oid, format);
  },
};

module.exports = { parseUtcTimestamp, utcTimestampTypes, TIMESTAMP_OID };
