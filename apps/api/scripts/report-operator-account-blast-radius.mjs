/**
 * READ-ONLY report: how many times did users holding the OPERATOR role call the
 * account-administration handlers (the ones being restricted to admins), per tenant, over the last
 * N days (default 90). It answers "who would notice the restriction" before it lands.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner runs this once, before the restriction
 * merges:
 *
 *   railway run --service postgres node apps/api/scripts/report-operator-account-blast-radius.mjs
 *
 * COUNTS ONLY. The output is tenant slug + per-handler counts. It never prints a user name, an
 * e-mail, a user id, an entity id or an audit action string with ids in it; the `action` and
 * `entityId` columns are read only to classify a row and to tell a self-edit from an edit of
 * somebody else, then discarded.
 *
 * WHAT THE COUNTS MEAN (see scripts/lib/operator-account-blast-radius.mjs for the mapping):
 *   - AuditLog is written by a global interceptor for POST / PUT / PATCH / DELETE only, after the
 *     guards pass and before the handler runs. So a count is "an OPERATOR reached this handler",
 *     which includes calls that later failed validation; calls the guards refused are not logged.
 *   - GET handlers leave no row at all, so they cannot be counted. They are listed under
 *     "UNTRACEABLE" so the reader knows what the numbers do not cover.
 *   - "OPERATOR" is the user's role NOW (not at the time of the call); rows written while a
 *     platform admin was impersonating (`impersonatedBy` set) are excluded.
 *   - A second section counts, per tenant, ACTIVE operators carrying the legacy `isAdmin` flag.
 *   - `users.update` counts only PATCH /users/:id where the target is not the caller.
 *   - Rows with a NULL tenant or user are not attributable and are skipped. The app never purges
 *     AuditLog, so the window is bounded by --days, not by retention.
 *
 * SAFETY (this script must never be able to touch a client database):
 *   - `default_transaction_read_only = on` is set on the session before any other query runs, so
 *     the server itself rejects a write even if one slipped past review.
 *   - `statement_timeout` caps every query.
 *   - Only SELECT queries appear below; the connection is closed in `finally`.
 *   - Tenant slugs land in the owner's terminal output only, never hardcoded here.
 *
 * Usage: node report-operator-account-blast-radius.mjs [--days 90] [--json]
 */
import { createRequire } from "module";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
import {
  CLOSED_HANDLERS,
  aggregateByTenant,
  buildActionRegex,
  totalsByHandler,
  traceableHandlers,
  untraceableHandlers,
} from "./lib/operator-account-blast-radius.mjs";
const { Client } = createRequire(import.meta.url)("pg");

function parseArgs(argv) {
  let days = 90;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--days") days = Number(argv[++i]);
    else if (arg.startsWith("--days=")) days = Number(arg.slice("--days=".length));
    else if (arg === "--json") json = true;
  }
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    console.error("report-operator-account-blast-radius: --days must be an integer in 1..3650");
    process.exit(2);
  }
  return { days, json };
}

const { days, json } = parseArgs(process.argv.slice(2));

// Fail closed BEFORE any connection is attempted (B768: the redacted target goes to stderr so
// --json stdout stays clean).
const databaseUrl = resolveReportDbUrl("report-operator-account-blast-radius");
if (!databaseUrl) process.exit(2);

const host = (() => {
  try {
    const u = new URL(databaseUrl);
    return `${u.host}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "unparseable";
  }
})();

const client = new Client({ connectionString: databaseUrl });
const q = async (sql, params) => (await client.query(sql, params)).rows;

async function main() {
  await client.connect();

  // Hard read-only guarantee + query cap, before anything else runs.
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '60s'");

  const closed = CLOSED_HANDLERS;
  const traceable = traceableHandlers(closed);
  const untraceable = untraceableHandlers(closed);

  // One grouped SELECT; the regex (built from the handler list) narrows rows in the database.
  const rows = await q(
    `SELECT t.slug AS slug,
            a.action AS action,
            (a."entityId" IS DISTINCT FROM a."userId") AS "nonSelf",
            COUNT(*)::int AS n
       FROM "AuditLog" a
       JOIN "User" u ON u.id = a."userId"
       JOIN "Tenant" t ON t.id = a."tenantId"
      WHERE u.role = 'OPERATOR'
        AND a."impersonatedBy" IS NULL
        AND a."createdAt" >= now() - make_interval(days => $1::int)
        AND a.action ~ $2
      GROUP BY t.slug, a.action, (a."entityId" IS DISTINCT FROM a."userId")`,
    [days, buildActionRegex(traceable)],
  );

  // Context the audit trail cannot give: active OPERATOR users carrying the legacy `isAdmin` flag
  // (the JWT strategy does not propagate it, so a role-only admin gate treats them as operators).
  // Counts per tenant only.
  const flagged = await q(
    `SELECT t.slug AS slug,
            COUNT(*)::int AS operators,
            (COUNT(*) FILTER (WHERE u."isAdmin"))::int AS "flaggedAdmins"
       FROM "User" u
       JOIN "Tenant" t ON t.id = u."tenantId"
      WHERE u.role = 'OPERATOR' AND u.status = 'ACTIVE' AND u."deletedAt" IS NULL
      GROUP BY t.slug
     HAVING COUNT(*) FILTER (WHERE u."isAdmin") > 0
      ORDER BY t.slug ASC`,
  );

  const tenants = aggregateByTenant(rows);
  const totals = totalsByHandler(tenants);
  const grandTotal = tenants.reduce((sum, t) => sum + t.total, 0);

  if (json) {
    console.log(
      JSON.stringify(
        {
          days,
          closedHandlers: closed.length,
          traceableHandlers: traceable.length,
          untraceable: untraceable.map((x) => ({ id: x.id, route: `${x.httpMethod} ${x.route}` })),
          tenantsAffected: tenants.length,
          operatorCalls: grandTotal,
          totalsByHandler: totals,
          operatorsWithLegacyAdminFlag: flagged,
          tenants,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\n=== OPERATOR ACCOUNT-ADMIN BLAST RADIUS — last ${days} days — ${host} ===`);
  console.log("    session is READ ONLY; counts only, no names / emails / ids\n");
  console.log(
    `${closed.length} closed handlers: ${traceable.length} traceable (mutations), ` +
      `${untraceable.length} untraceable (GET, no audit row)\n`,
  );
  console.log(
    `${tenants.length} tenant(s) had an OPERATOR call a closed handler (${grandTotal} call(s) in all).\n`,
  );

  if (tenants.length > 0) {
    console.log("Per tenant, by area:");
    console.table(tenants.map((t) => ({ slug: t.slug, total: t.total, ...t.byArea })));
    console.log("Per tenant, by handler:");
    console.table(
      tenants.flatMap((t) =>
        Object.entries(t.byHandler)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([handler, n]) => ({ slug: t.slug, handler, calls: n })),
      ),
    );
    console.log("All tenants, by handler:");
    console.table(
      Object.entries(totals)
        .sort((a, b) => b[1] - a[1])
        .map(([handler, n]) => ({ handler, calls: n })),
    );
  }

  console.log(
    `${flagged.length} tenant(s) have active OPERATOR users carrying the legacy isAdmin flag ` +
      "(a role-only admin gate does not honour it):",
  );
  if (flagged.length > 0) console.table(flagged);

  console.log("UNTRACEABLE (GET handlers: no AuditLog row, so NOT counted above):");
  console.table(untraceable.map((x) => ({ handler: x.id, route: `${x.httpMethod} ${x.route}` })));

  console.log("=== END — session was read-only; nothing was modified ===\n");
}

main()
  .catch((e) => {
    console.error("operator-account blast-radius report failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => client.end());
