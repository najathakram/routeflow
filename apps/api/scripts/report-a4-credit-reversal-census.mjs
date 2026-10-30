// SA-1042 A-4 G5, SA-1054 r2: READ-ONLY census of old typed credit rows, scoped to lines the ledger can reverse (live, not dead, SALE).
// The logic is `censusOldTypedCredits` in src/regulated/credit-reversal-census.ts, so the dead-SALE rule is the room loader's own
// (`deadSaleIdsOf`), not a copy; this runner only connects. Needs the api built first: `npm run build -w apps/api`.
//
// NEVER RUN FROM AN IMPLEMENTATION SESSION. Against the compose DB (no flags) it is a local check. Against production the
// owner runs it in two steps (the live-target guard): once to see the host it resolves to, then naming that host.
//
//   railway run --service postgres node apps/api/scripts/report-a4-credit-reversal-census.mjs
//   railway run --service postgres node apps/api/scripts/report-a4-credit-reversal-census.mjs --target-host=<the host it printed>
//
//   node apps/api/scripts/report-a4-credit-reversal-census.mjs --self-test   (no database)
//
// SAFETY
//   - A loopback target (127.0.0.1, localhost, [::1]) needs no flag. Any other host is refused BEFORE connecting unless
//     `--target-host=<host>` equals the resolved host (exit 64 when missing, 65 on a mismatch). No credentials are printed.
//   - Every session of the pool is read-only, and the run exits 2 unless SHOW transaction_read_only is `on` both on the
//     session and inside the transaction that does the reads. That transaction ends with ROLLBACK. No write flag exists.
//   - Counts and a short sample of credit note ids only: no tenant, customer or name is printed or selected.
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const require = createRequire(import.meta.url);
const NAME = "report-a4-credit-reversal-census";
const COMPOSE_URL = "postgresql://user:pass@127.0.0.1:5432/routeflow_dev";
export const SHOW_READ_ONLY = "SHOW transaction_read_only";

/** Arguments: `--target-host=<host>`, `--self-test`. Anything else (a write flag too) is refused. */
export function checkArgs(argv) {
  const hosts = argv.filter((a) => a.startsWith("--target-host="));
  if (hosts.length > 1) return { ok: false, message: "--target-host given more than once" };
  for (const a of argv) {
    if (a.startsWith("--target-host=") || a === "--self-test") continue;
    return {
      ok: false,
      message: `unexpected argument ${a} (this report is read-only and has no write mode)`,
    };
  }
  return {
    ok: true,
    selfTest: argv.includes("--self-test"),
    targetHost: hosts.length ? hosts[0].slice("--target-host=".length) : null,
  };
}

/** Host and database name of a postgres URL, for the type-back guard. Never the credentials. */
export function targetOf(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "(default)",
  };
}

export const isLoopback = (host) => /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/.test(host);

/** A loopback target passes; any other host exits 64 without `--target-host`, 65 when it does not equal the host. */
export function guardTarget(targetHost, target) {
  if (isLoopback(target.host)) return { ok: true };
  if (!targetHost)
    return {
      ok: false,
      code: 64,
      message: "refusing: --target-host=<host> is required (run once without it to see the host)",
    };
  if (targetHost !== target.host)
    return {
      ok: false,
      code: 65,
      message: `refusing: --target-host=${targetHost} does not match the resolved host ${target.host}`,
    };
  return { ok: true };
}

const ROLLBACK = Symbol("census-rollback");
const readOnlyFlag = (rows) => rows?.[0]?.transaction_read_only;

function notReadOnly(where, flag) {
  const e = new Error(`aborting: transaction_read_only is "${flag}" ${where}, expected "on"`);
  e.exitCode = 2;
  return e;
}

/**
 * Prove the session is read-only, then run `census(tx)` inside one transaction that proves it again and always ends
 * in ROLLBACK (the result is carried out through the rollback sentinel). `pool` runs the session check, `db` the rest.
 */
export async function runReadOnly(pool, db, census) {
  const session = readOnlyFlag((await pool.query(SHOW_READ_ONLY)).rows);
  if (session !== "on") throw notReadOnly("on the session", session);
  let result;
  try {
    await db.$transaction(async (tx) => {
      const flag = readOnlyFlag(await tx.$queryRawUnsafe(SHOW_READ_ONLY));
      if (flag !== "on") throw notReadOnly("in the transaction", flag);
      result = await census(tx);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return result;
}

export async function selfTest() {
  const eq = (got, want, what) => {
    if (JSON.stringify(got) !== JSON.stringify(want))
      throw new Error(`self-test: ${what}: got ${JSON.stringify(got)}`);
  };
  eq(checkArgs([]).ok, true, "no args");
  eq(checkArgs(["--target-host=a", "--target-host=b"]).ok, false, "two hosts");
  eq(checkArgs(["--write"]).ok, false, "a write flag is refused");
  eq(guardTarget(null, { host: "localhost" }).ok, true, "loopback needs no flag");
  eq(guardTarget(null, { host: "db.example.test" }).code, 64, "remote without a flag");
  eq(guardTarget("x", { host: "db.example.test" }).code, 65, "remote with the wrong host");
  eq(guardTarget("db.example.test", { host: "db.example.test" }).ok, true, "remote named");
  eq(targetOf("postgresql://u:s@h.test:5432/d").database, "d", "database name");
  const on = { rows: [{ transaction_read_only: "on" }] };
  const off = { rows: [{ transaction_read_only: "off" }] };
  const mk = (session, inTx) => {
    const calls = [];
    return {
      calls,
      pool: { query: async () => session },
      db: {
        $transaction: async (fn) => {
          calls.push("begin");
          try {
            return await fn({ $queryRawUnsafe: async () => inTx.rows });
          } finally {
            calls.push("rollback");
          }
        },
      },
    };
  };
  let m = mk(on, on);
  eq(await runReadOnly(m.pool, m.db, async () => 7), 7, "result carried out");
  eq(m.calls, ["begin", "rollback"], "the transaction always rolls back");
  m = mk(off, on);
  await runReadOnly(m.pool, m.db, async () => 1).then(
    () => {
      throw new Error("self-test: a writable session ran");
    },
    (e) => eq(e.exitCode, 2, "writable session exits 2"),
  );
  eq(m.calls, [], "no transaction opened on a writable session");
  m = mk(on, off);
  let ran = false;
  await runReadOnly(m.pool, m.db, async () => (ran = true)).then(
    () => {
      throw new Error("self-test: a writable transaction ran");
    },
    (e) => eq(e.exitCode, 2, "writable transaction exits 2"),
  );
  eq(ran, false, "the census never ran in a writable transaction");
  return "self-test ok";
}

async function main() {
  const args = checkArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(`${NAME}: ${args.message}`);
    process.exit(2);
  }
  if (args.selfTest) {
    console.log(await selfTest());
    return;
  }
  // CENSUS_DATABASE_URL (the old override) wins; under `railway run` (any RAILWAY_ variable) the shared report resolution
  // picks the target (B768: this script never names the platform variable itself); with neither it is the compose database.
  const underRailway = Object.keys(process.env).some((k) => k.startsWith("RAILWAY_"));
  const url =
    process.env.CENSUS_DATABASE_URL ?? (underRailway ? resolveReportDbUrl(NAME) : COMPOSE_URL);
  if (!url) process.exit(2);
  const target = targetOf(url);
  console.error(`${NAME}: DB host ${target.host} · database ${target.database}`);
  const guard = guardTarget(args.targetHost, target);
  if (!guard.ok) {
    console.error(`${NAME}: ${guard.message}`);
    process.exit(guard.code);
  }
  const built = fileURLToPath(
    new URL("../dist/regulated/credit-reversal-census.js", import.meta.url),
  );
  if (!existsSync(built))
    throw new Error("census: build the api first (npm run build -w apps/api)");
  const { censusOldTypedCredits } = require(built);
  const { Pool } = require("pg");
  const { PrismaClient } = require("@prisma/client");
  const { PrismaPg } = require("@prisma/adapter-pg");
  const pool = new Pool({ connectionString: url, options: "-c default_transaction_read_only=on" });
  // a pooler can drop the startup option: set it on every new connection too, before any query runs
  pool.on("connect", (c) => {
    c.query("SET default_transaction_read_only = on").catch(() => {});
  });
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const result = await runReadOnly(pool, db, (tx) => censusOldTypedCredits(tx));
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`${NAME}: ${e.message}`);
    process.exitCode = e.exitCode ?? 1;
  } finally {
    await db.$disconnect().catch(() => {});
    await pool.end().catch(() => {});
  }
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
    process.exit(e.exitCode ?? 1);
  });
}
