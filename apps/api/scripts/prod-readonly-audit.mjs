/**
 * READ-ONLY production audit — answers the questions blocking the migration
 * baseline and the RLS decision.
 *
 *   railway run --service postgres node apps/api/scripts/prod-readonly-audit.mjs
 *
 * SAFETY (this script must never be able to modify a client database):
 *   • `default_transaction_read_only = on` is set on the session, so the server
 *     itself rejects any INSERT/UPDATE/DELETE/DDL that might slip in.
 *   • `statement_timeout` caps every query, so a large table cannot pin the DB.
 *   • Row counts run one table at a time and failures are caught per-table, so a
 *     single slow table degrades to "unknown" instead of aborting the run.
 *   • No transaction is left open; the connection is closed in `finally`.
 */
import pg from "pg";

/**
 * Resolve a connection string. Railway's `postgres` service publishes only its
 * credentials plus a TCP proxy; its DATABASE_URL (postgres.railway.internal) is
 * reachable only from inside Railway's network, so when running locally we build
 * the external proxy URL from the injected variables instead. Credentials are
 * never printed — only host/database.
 */
function resolveUrl() {
  const direct = process.env.DATABASE_URL;
  if (direct && !direct.includes(".railway.internal")) return direct;
  const {
    POSTGRES_USER,
    POSTGRES_PASSWORD,
    POSTGRES_DB,
    RAILWAY_TCP_PROXY_DOMAIN,
    RAILWAY_TCP_PROXY_PORT,
  } = process.env;
  if (RAILWAY_TCP_PROXY_DOMAIN && POSTGRES_USER && POSTGRES_PASSWORD) {
    const db = POSTGRES_DB || "railway";
    const port = RAILWAY_TCP_PROXY_PORT || "5432";
    return `postgresql://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(POSTGRES_PASSWORD)}@${RAILWAY_TCP_PROXY_DOMAIN}:${port}/${db}`;
  }
  return direct || null;
}

const url = resolveUrl();
if (!url) {
  console.error("No usable connection string — run via `railway run --service postgres ...`");
  process.exit(1);
}

const host = (() => {
  try {
    const u = new URL(url);
    return `${u.host}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "unparseable";
  }
})();

const client = new pg.Client({ connectionString: url });
const q = async (sql, params) => (await client.query(sql, params)).rows;

async function main() {
  await client.connect();

  // Hard read-only guarantee + query cap, before anything else runs.
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '45s'");

  console.log(`\n=== READ-ONLY AUDIT — ${host} ===`);
  console.log(`    session is READ ONLY; no writes are possible\n`);

  // ── 1. Does RLS actually bind to this role? ───────────────────────────────
  const role = await q(`SELECT current_user AS role, rolsuper, rolbypassrls
                        FROM pg_roles WHERE rolname = current_user`);
  console.log("1. CONNECTING ROLE");
  console.table(role);
  const bypasses = role[0]?.rolsuper || role[0]?.rolbypassrls;
  console.log(
    bypasses
      ? "   → superuser/BYPASSRLS: RLS policies do NOT constrain this role.\n"
      : "   → RLS policies DO constrain this role.\n",
  );

  // ── 2. Is RLS already enabled in this database? ───────────────────────────
  const rls = await q(`
    SELECT count(*) FILTER (WHERE c.relrowsecurity)      AS rls_enabled_tables,
           count(*) FILTER (WHERE c.relforcerowsecurity) AS rls_forced_tables,
           (SELECT count(*) FROM pg_policies
             WHERE schemaname='public' AND policyname='tenant_isolation') AS tenant_policies
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'`);
  console.log("2. CURRENT RLS STATE");
  console.table(rls);

  // ── 3. Migration history ──────────────────────────────────────────────────
  console.log("3. MIGRATION HISTORY");
  const present = (await q(`SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS p`))[0]
    .p;
  if (!present) {
    console.log("   no _prisma_migrations table — this DB was built with `db push`.\n");
  } else {
    console.table(
      await q(`SELECT count(*) AS total,
                      count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS unfinished,
                      count(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS rolled_back
               FROM "_prisma_migrations"`),
    );
    const failed = await q(`SELECT migration_name, started_at, finished_at, rolled_back_at
                            FROM "_prisma_migrations"
                            WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
                            ORDER BY started_at DESC LIMIT 10`);
    if (failed.length) {
      console.log("   ⚠ FAILED / UNFINISHED migrations present:");
      console.table(failed);
    }
    const recent = await q(`SELECT migration_name, finished_at FROM "_prisma_migrations"
                            ORDER BY finished_at DESC NULLS FIRST LIMIT 5`);
    console.log("   most recent:");
    console.table(recent);
  }

  // ── 4. NULL-tenant rows — the RLS blast radius ────────────────────────────
  const tenantTables = await q(`
    SELECT c.relname AS t, COALESCE(s.n_live_tup, 0)::bigint AS est_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE n.nspname='public' AND c.relkind='r'
      AND EXISTS (SELECT 1 FROM information_schema.columns col
                  WHERE col.table_schema='public' AND col.table_name=c.relname
                    AND col.column_name='tenantId')
    ORDER BY 1`);

  const affected = [];
  let unknown = 0;
  for (const { t, est_rows } of tenantTables) {
    try {
      const r = await q(`SELECT count(*)::bigint AS c FROM public."${t}" WHERE "tenantId" IS NULL`);
      const c = Number(r[0].c);
      if (c > 0) affected.push({ table: t, null_tenant_rows: c, est_total_rows: Number(est_rows) });
    } catch (e) {
      unknown++;
      affected.push({
        table: t,
        null_tenant_rows: `ERROR: ${e.message.slice(0, 40)}`,
        est_total_rows: Number(est_rows),
      });
    }
  }
  console.log(
    `4. NULL-tenantId ROWS  (${affected.length} of ${tenantTables.length} tables affected${unknown ? `, ${unknown} unreadable` : ""})`,
  );
  console.table(affected.length ? affected : [{ table: "(none)", null_tenant_rows: 0 }]);
  console.log(
    affected.length
      ? "   → invisible to the app IF RLS is enabled AND the role does not bypass it.\n"
      : "   → none; RLS is safe from this angle.\n",
  );

  // ── 5. Table inventory ────────────────────────────────────────────────────
  const tables = await q(`SELECT count(*) AS public_tables FROM information_schema.tables
                          WHERE table_schema='public' AND table_type='BASE TABLE'`);
  console.log("5. TABLE COUNT (prisma/schema/*.prisma defines 106 models)");
  console.table(tables);
  const names = (
    await q(`SELECT table_name FROM information_schema.tables
                          WHERE table_schema='public' AND table_type='BASE TABLE'
                          ORDER BY table_name`)
  ).map((r) => r.table_name);
  console.log("   table list (for offline diff vs prisma/schema/*.prisma):");
  console.log("   " + names.join(", ") + "\n");

  console.log("=== END — session was read-only; nothing was modified ===\n");
}

main()
  .catch((e) => {
    console.error("audit failed:", e.message);
    process.exit(1);
  })
  .finally(() => client.end());
