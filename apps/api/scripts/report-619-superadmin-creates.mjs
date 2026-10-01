// SA-619 PR-2a (flip-day risk N6): READ-ONLY, COUNT-ONLY report of rows that a SUPER_ADMIN / context-less
// create could have written with NO tenant. For every model whose `tenantId` is NULLABLE it prints how
// many rows have `tenantId IS NULL` and how many of those were created in the last 30 days, so the owner
// can see what flipping TENANT_CONTEXT_ENFORCE=true would start refusing before it is flipped.
//
// The model list is DERIVED from the Prisma schema folder (a new nullable-tenant model is covered
// automatically). Output is model names and integers ONLY: never an id, tenant name, slug or value.
// One READ ONLY transaction, always rolled back; the SQL has no parameters (nothing user-supplied reaches it).
//
//   node apps/api/scripts/report-619-superadmin-creates.mjs --self-test
//   node apps/api/scripts/report-619-superadmin-creates.mjs --print-sql     # no connection: paste into psql
//   node apps/api/scripts/report-619-superadmin-creates.mjs                 # local compose DB (B768 resolver)
//   railway run --service postgres node apps/api/scripts/report-619-superadmin-creates.mjs   # owner-run
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TAG = "report-619";
const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(HERE, "../prisma/schema");
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The text of every `*.prisma` file in the schema folder, concatenated. */
export function loadSchemaText(dir = SCHEMA_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".prisma"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

/** Models whose `tenantId` is a NULLABLE String, with whether they carry a `createdAt` DateTime. */
export function nullableTenantModels(schemaText) {
  const out = [];
  for (const m of schemaText.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    if (/^\s*tenantId\s+String\?/m.test(m[2]))
      out.push({ model: m[1], hasCreatedAt: /^\s*createdAt\s+DateTime/m.test(m[2]) });
  }
  return out;
}

/** One model's count query. The identifier is validated first (it is the only thing interpolated). */
export function buildModelSql({ model, hasCreatedAt }) {
  if (!IDENT.test(model))
    throw new Error(`${TAG}: refusing a model name that is not a plain identifier`);
  const recent = hasCreatedAt
    ? `count(*) FILTER (WHERE "tenantId" IS NULL AND "createdAt" > now() - interval '30 days')::int`
    : `NULL::int`;
  return `SELECT '${model}' AS model, count(*) FILTER (WHERE "tenantId" IS NULL)::int AS null_tenant, ${recent} AS null_30d, count(*)::int AS total FROM "${model}"`;
}

/** The whole report as ONE statement (a UNION ALL of the per-model queries): for `--print-sql` / psql. */
export function buildReportSql(models) {
  return models.map(buildModelSql).join("\nUNION ALL\n");
}

/** Refuses anything that is not a single read-only SELECT. */
export function assertReadOnlySql(sql) {
  const body = String(sql).trim().replace(/;\s*$/, "");
  if (body.includes(";")) throw new Error(`${TAG}: refusing multiple statements`);
  if (!/^\s*SELECT\b/i.test(body)) throw new Error(`${TAG}: only a SELECT is allowed`);
  const banned =
    /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CALL|DO)\b/i;
  if (banned.test(body.replace(/'[^']*'/g, "''"))) throw new Error(`${TAG}: write keyword refused`);
  return body;
}

/** Model names and integers only. */
export function formatReport(rows) {
  const shown = rows.filter((r) => r.total > 0).sort((a, b) => b.null_tenant - a.null_tenant);
  const lines = [
    "model".padEnd(34) +
      "null_tenant".padStart(12) +
      "null_30d".padStart(10) +
      "total".padStart(10),
  ];
  for (const r of shown)
    lines.push(
      r.model.padEnd(34) +
        String(r.null_tenant).padStart(12) +
        String(r.null_30d ?? "n/a").padStart(10) +
        String(r.total).padStart(10),
    );
  const nulls = shown.reduce((s, r) => s + r.null_tenant, 0);
  lines.push(
    "",
    `${shown.length} populated nullable-tenant models; ${nulls} rows with tenantId NULL in total`,
    "NOTE: NULL includes deliberate platform rows (an explicit tenantId: null, e.g. global settings, platform",
    "audit rows, SUPER_ADMIN users): the enforce flip does not refuse those. Read it as an upper bound on risk.",
  );

  return lines.join("\n");
}

function selfTest() {
  const models = nullableTenantModels(loadSchemaText());
  if (models.length < 40) throw new Error("self-test: too few nullable-tenant models derived");
  const sql = buildReportSql(models);
  assertReadOnlySql(sql);
  for (const bad of ['DELETE FROM "User"', "SELECT 1; SELECT 2", 'UPDATE "User" SET a = 1']) {
    let refused = false;
    try {
      assertReadOnlySql(bad);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error(`self-test: ${bad} was not refused`);
  }
  console.log(`${TAG} self-test: OK (${models.length} models, read-only SQL)`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest();
  const models = nullableTenantModels(loadSchemaText());
  if (args.includes("--print-sql")) {
    console.log(`${assertReadOnlySql(buildReportSql(models))};`);
    return;
  }
  // B768: owner-run read-only reports reach the database through the ONE shared resolver.
  const { resolveReportDbUrl } = await import("./lib/report-db-url.mjs");
  const url = resolveReportDbUrl(TAG);
  if (!url) {
    console.error(`${TAG}: no usable database URL: refusing to run`);
    process.exit(2);
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL default_transaction_read_only = on");
    // One statement per model, each in its own savepoint with its own timeout: one slow table on a large
    // database reports "skipped" for that model instead of losing the whole report.
    const rows = [];
    for (const entry of models) {
      const one = assertReadOnlySql(buildModelSql(entry));
      await client.query("SAVEPOINT report_model");
      try {
        await client.query("SET LOCAL statement_timeout = '15s'");
        rows.push((await client.query(one)).rows[0]);
      } catch (e) {
        await client.query("ROLLBACK TO SAVEPOINT report_model");
        console.error(`${TAG}: ${entry.model}: skipped (${String(e.message).slice(0, 60)})`);
        continue;
      }
      await client.query("RELEASE SAVEPOINT report_model");
    }
    console.log(formatReport(rows));
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(`${TAG}: ${e.message}`);
    process.exit(1);
  });
}
