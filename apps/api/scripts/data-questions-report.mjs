// DATA QUESTIONS — ONE read-only report that turns the units / regulated-tax findings from "this can
// happen" into "this happened N times to N tenants". Sixteen questions, one per open finding. It writes
// NOTHING to the database: a single READ ONLY transaction, SELECTs only (one statement each, no semicolon, no
// transaction control), ROLLBACK at the end (the same shape as t6-null-rows-report.mjs). It never runs
// alongside prod-migrate.mjs (it takes only ACCESS SHARE locks and gives up after a 2 s lock_timeout, but the
// owner still runs the two one at a time).
//
// OUTPUT. The detail (counts and dollar / stock deltas per TENANT ID and product id) goes to a PRIVATE FILE,
// by default local-assets/data-questions-report-<UTC timestamp>.txt (gitignored), or --out <path>; an existing
// file is never overwritten. Stdout gets only an id-free summary (question, statements, rows, failures).
// Keep the file OFF public issues / PRs / commits. No slug, name or client identifier appears in this code.
//
//   railway run --service postgres node apps/api/scripts/data-questions-report.mjs      # owner-approved, from the PC
//   DATABASE_URL=postgresql://…@localhost:5432/<db> node apps/api/scripts/data-questions-report.mjs --local
//
//   --only 7,15        run just those questions          --list          print the questions and exit
//   --cap N            rows kept per statement (default 100)   --timeout-ms N   per-statement timeout (default 30000)
//   --out <path>       write the detail there instead of the default local-assets/ file
//
// Each question runs in its own SAVEPOINT with a statement timeout and a row cap, so one bad column or one slow
// query is reported ("question N: FAILED <message>" in the file, a failure count in the summary) and the rest
// still run. Exit: 0 report written (even if a question FAILED: read the summary) · 2 env / connection error.
//
// APPROXIMATIONS (each is named in the file under "approx:"): "edited" is inferred from a line being
// re-created after its invoice (there is no edit log); order stock changes write NO StockMovement row
// (order-stock.ts), so stock deltas are exposure computed from quantities, not reconciled to a ledger;
// per-piece dollar deltas are only exact for non-boxed lines; deleted orders leave no rows (Q4 can only
// look for audit traces); deliveredQty cannot tell "refused" from "never recorded" (Q13 splits the buckets).
// A number here is a lead to investigate, not a verdict.
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { requireLocalPgConfig } from "./lib/local-pg-config.mjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

const { QUESTIONS, assertReadOnly, parseOnly, execute } = createRequire(import.meta.url)(
  "./lib/data-questions.cjs",
);
const here = dirname(fileURLToPath(import.meta.url));

function flag(args, name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

async function main(args = process.argv.slice(2)) {
  const local = args.includes("--local");
  let url, only, outPath;
  let localCfg = null; // --local: the vetted explicit fields are the ones dialled
  const cap = Number(flag(args, "--cap", 100));
  const timeoutMs = Number(flag(args, "--timeout-ms", 30000));
  try {
    only = parseOnly(flag(args, "--only", null));
    if (!Number.isInteger(cap) || cap < 1 || !Number.isInteger(timeoutMs) || timeoutMs < 1)
      throw new Error("--cap and --timeout-ms must be positive integers");
    if (args.includes("--list")) {
      for (const q of QUESTIONS) console.log(`${q.n}\t${q.bug}\t${q.title}`);
      return 0;
    }
    url = local ? process.env.DATABASE_URL : resolveDatabaseUrl(process.env);
    if (!url) throw new Error("--local requires DATABASE_URL");
    if (local) {
      localCfg = requireLocalPgConfig(url);
    }
    for (const q of QUESTIONS) q.stmts.forEach((st) => assertReadOnly(st.sql));
    outPath = resolve(
      flag(
        args,
        "--out",
        resolve(
          here,
          `../../../local-assets/data-questions-report-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`,
        ),
      ),
    );
    mkdirSync(dirname(outPath), { recursive: true });
  } catch (e) {
    console.error(`data-questions-report: ${e.message}`);
    return 2;
  }
  let fd;
  try {
    fd = openSync(outPath, "wx"); // never overwrite an earlier report
  } catch (e) {
    console.error(`data-questions-report: cannot create ${outPath}: ${e.message}`);
    return 2;
  }
  const put = (line) => writeSync(fd, `${line}\n`);
  put(
    `data-questions-report: target ${redactUrl(url)} (READ ONLY; contains tenant ids: keep private)`,
  );
  console.log(`data-questions-report: target ${redactUrl(url)} (READ ONLY); detail -> ${outPath}`);
  const client = new pg.Client(localCfg ?? { connectionString: url });
  try {
    const summary = await execute(client, { only, cap, timeoutMs }, put);
    put("\ndata-questions-report: done (nothing was written to the database)");
    for (const q of summary)
      console.log(
        `  Q${q.n} (${q.bug}): ${q.statements} statement(s), ${q.rows} row(s), ${q.failed} failed${q.capped ? `, ${q.capped} capped` : ""}`,
      );
    const failed = summary.reduce((n, q) => n + q.failed, 0);
    console.log(
      `data-questions-report: done, ${failed} failed statement(s); nothing was written to the database`,
    );
    return 0;
  } catch (e) {
    put(`data-questions-report: ABORTED ${e.message}`);
    console.error(`data-questions-report: ${e.message}`);
    return 2;
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
