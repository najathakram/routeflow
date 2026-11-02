/**
 * READ-ONLY report (SA-1088; SA-790 §1, SA-968 §3): the corrected-units sheet. For ONE tenant it lists every
 * regulated-ledger line on the box axis with the "Unit Basis Qty" the ledger carries now, the corrected figure per
 * the B681 classifier, and the difference, per period, beside the period's FILED snapshot. Reference only: the
 * ledger and the filed forms are unchanged. Nothing is written to the database, ever.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION against a live tenant. The owner approves the exact command, then runs it:
 *
 * Two steps (the live-target guard): run once to see the host it resolves to, then name that host.
 *
 *   railway run --service postgres node apps/api/scripts/report-corrected-units-sheet.mjs --tenant <slug>
 *   railway run --service postgres node apps/api/scripts/report-corrected-units-sheet.mjs --tenant <slug> \
 *     --target-host=<the host it printed> --live-tenant-override [--out local-assets/handoff/qd-sheet.csv]
 *
 *   node apps/api/scripts/report-corrected-units-sheet.mjs --self-test   (no database)
 *
 * Needs `npm run build -w @routeflow/pricing` first (it imports the classifier from the package).
 *
 * SAFETY
 *   - Live-target guard: it prints the DB host and database name and refuses BEFORE connecting unless
 *     `--target-host=<host>` equals the resolved host (exit 64 when missing, 65 on a mismatch). No credentials.
 *   - One tenant per run (`--tenant <slug>`). An approved test slug runs as is; any other slug needs
 *     `--live-tenant-override` (exit 2 without it).
 *   - The first statement is the session `default_transaction_read_only = on`, then timeouts, then BEGIN
 *     TRANSACTION READ ONLY; the sheet aborts unless SHOW transaction_read_only is `on`. The transaction ends
 *     with ROLLBACK.
 *   - It refuses --apply, --fix and --repair (exit 2): there is no write mode.
 *   - Output: product code and document number only, no customer or product names. The CSV goes under
 *     `local-assets/handoff/` (never committed); the console prints the summary and the per-period footers.
 *   - Exit codes: 0 sheet written; 1 a period no longer matches its filed snapshot (LEDGER MOVED SINCE FILING) or
 *     a covering filing holds no snapshot row; 2 refused arguments; 64 / 65 the host guard.
 * Pure logic + SQL: ./lib/report-corrected-units-sheet.mjs.
 */
import { createRequire } from "node:module";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
import * as lib from "./lib/report-corrected-units-sheet.mjs";
import { selfTest } from "./lib/report-corrected-units-sheet.self-test.mjs";

// belt and braces with the AT TIME ZONE 'UTC' in the SQL: this report is judged on UTC instants
process.env.TZ = "UTC";

const require = createRequire(import.meta.url);
const { refuseRetiredFlags } = require("./lib/live-target-guard.cjs");

const NAME = lib.NAME;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const OUT_DIR = resolve(REPO_ROOT, "local-assets", "handoff");

/** The CSV path: `--out` when given (it must sit under local-assets/handoff/), else a dated default there. */
export function outPathFor(out, stamp) {
  const target = resolve(out ?? resolve(OUT_DIR, `qd-corrected-units-sheet-${stamp}.csv`));
  const rel = relative(OUT_DIR, target);
  if (rel === "" || rel.split(sep)[0] === ".." || isAbsolute(rel)) {
    return { ok: false, message: `--out must be a file under local-assets/handoff/ (got ${out})` };
  }
  return { ok: true, path: target };
}

async function main() {
  const argv = process.argv.slice(2);
  try {
    refuseRetiredFlags(argv);
  } catch (e) {
    console.error(`${NAME}: ${e.message}`);
    process.exit(2);
  }
  const args = lib.checkArgs(argv);
  if (!args.ok) {
    console.error(`${NAME}: ${args.message}`);
    process.exit(2);
  }
  if (args.selfTest) {
    console.log(await selfTest());
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = outPathFor(args.out, stamp);
  if (!outPath.ok) {
    console.error(`${NAME}: ${outPath.message}`);
    process.exit(2);
  }
  const tenantGuard = lib.guardTenant(args.tenant, args.liveOverride);
  if (!tenantGuard.ok) {
    console.error(`${NAME}: ${tenantGuard.message}`);
    process.exit(2);
  }

  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);
  const target = lib.targetOf(databaseUrl);
  console.error(`${NAME}: DB host ${target.host} · database ${target.database}`);
  const guard = lib.guardTarget(args.targetHost, target);
  if (!guard.ok) {
    console.error(`${NAME}: ${guard.message}`);
    process.exit(guard.code);
  }

  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl });
  let exitCode = 0;
  try {
    await client.connect();
    const sheet = await lib.withReadOnlyTx(client, async () => {
      const tenant = (await client.query(lib.TENANT_BY_SLUG_SQL, [args.tenant])).rows[0];
      if (!tenant)
        throw Object.assign(new Error("no tenant has that slug on this database"), {
          refuse: true,
        });
      return lib.readSheet(client, tenant.id);
    });
    const meta = { generatedAt: new Date().toISOString() };
    mkdirSync(dirname(outPath.path), { recursive: true });
    writeFileSync(outPath.path, lib.formatCsv(sheet, meta), "utf8");
    console.log(lib.formatConsole(sheet, meta));
    console.log(`\nCSV: ${relative(REPO_ROOT, outPath.path)}`);
    exitCode = sheet.summary.exitCode;
  } finally {
    await client.end().catch(() => {});
  }
  process.exit(exitCode);
}

export function isInvokedDirectly(entry = process.argv[1], self = fileURLToPath(import.meta.url)) {
  if (!entry) return false;
  const norm = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return norm(entry) === norm(self) || basename(entry) === basename(self);
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`${NAME}: ${e.message}`);
    process.exit(e.refuse ? 2 : 1);
  });
}
