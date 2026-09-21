// DATA QUESTIONS — ONE read-only report that turns the units / regulated-tax findings from "this can
// happen" into "this happened N times to N tenants". Sixteen questions, one per open finding. It writes
// NOTHING: a single READ ONLY transaction, SELECTs only, ROLLBACK at the end (the same shape as
// t6-null-rows-report.mjs). Output = COUNTS and DOLLAR / STOCK DELTAS per tenant id. It contains tenant
// ids: keep it on the operator's terminal and OFF public issues / PRs / commits. No slug, name or client
// identifier appears anywhere in this file.
//
//   railway run --service postgres node apps/api/scripts/data-questions-report.mjs      # owner-approved, from the PC
//   DATABASE_URL=postgresql://…@localhost:5432/<db> node apps/api/scripts/data-questions-report.mjs --local
//
//   --only 7,15        run just those questions          --list          print the questions and exit
//   --cap N            rows kept per statement (default 100)   --timeout-ms N   per-statement timeout (default 30000)
//
// Each question runs in its own SAVEPOINT with a statement timeout and a row cap, so one bad column or one slow
// query is reported ("question N: FAILED <message>") and the rest still run.
// Exit: 0 report printed (even if a question FAILED — read the output) · 2 env / connection error.
//
// APPROXIMATIONS (each is named in the output under "approx:"): "edited" is inferred from a line being
// re-created after its invoice (there is no edit log); order stock changes write NO StockMovement row
// (order-stock.ts), so stock deltas are exposure computed from quantities, not reconciled to a ledger;
// per-piece dollar deltas are only exact for non-boxed lines; deleted orders leave no rows (Q4 can only
// look for audit traces). A number here is a lead to investigate, not a verdict.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

const { QUESTIONS, assertReadOnly, parseOnly, runReport } = createRequire(import.meta.url)(
  "./lib/data-questions.cjs",
);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db"]);

function flag(args, name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

async function main(args = process.argv.slice(2)) {
  const local = args.includes("--local");
  let url, only;
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
      const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
      if (!LOCAL_HOSTS.has(host)) throw new Error(`--local refuses non-local host ${host}`);
    }
    for (const q of QUESTIONS) q.stmts.forEach((st) => assertReadOnly(st.sql));
  } catch (e) {
    console.error(`data-questions-report: ${e.message}`);
    return 2;
  }
  console.log(
    `data-questions-report: target ${redactUrl(url)} (READ ONLY; contains tenant ids: keep off public issues, PRs and commits)`,
  );
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await runReport(client, { only, cap, timeoutMs });
    console.log("\ndata-questions-report: done (nothing was written)");
    return 0;
  } catch (e) {
    console.error(`data-questions-report: ${e.message}`);
    return 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
