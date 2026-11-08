// SA-1091 piece 1 (row 631): READ-ONLY census of the OLD rows, ported to the order-wide bound's own terms.
// Counts, with no id, name or amount: (1) orders already over the bound (`loadOrderRefundRooms` room below zero), whose later
// credits are now refused while everything already given back stays as it is; (2) invoices whose STORED inline gross passes
// what the invoice charged for those lines (the A-1 reopen test: only if that count is not small).
// The logic is `censusOrderBound` in src/returns/order-bound-census.ts; this runner only connects. Needs the api built first:
// `npm run build -w apps/api`.
//
// NEVER RUN FROM AN IMPLEMENTATION SESSION. Against the compose DB (no flags) it is a local check. Against production the
// owner runs it in two steps (the live-target guard): once to see the host it resolves to, then naming that host.
//
//   railway run --service postgres node apps/api/scripts/report-sa1091-order-bound-census.mjs
//   railway run --service postgres node apps/api/scripts/report-sa1091-order-bound-census.mjs --target-host=<the host it printed>
//
//   optional: --max-minutes=<1-240, default 45>  --workers=<1-4, default 2>
//   node apps/api/scripts/report-sa1091-order-bound-census.mjs --self-test   (no database)
//
// SAFETY
//   - A loopback target (127.0.0.1, localhost, [::1]) needs no flag. Any other host is refused BEFORE connecting unless
//     `--target-host=<host>` equals the resolved host (exit 64 when missing, 65 on a mismatch). No credentials are printed.
//   - Every session of the pool is read-only (a startup option), and the run exits 2 unless SHOW transaction_read_only is `on`
//     on the session and again inside EVERY transaction that reads. Each of those ends with ROLLBACK. No write flag exists.
//   - BOUNDED ON THE PRODUCTION CONNECTION (the first run held one transaction for 120 s and timed out): no transaction is
//     long (a read is closed after about 15 s of work and a new one opened; a backstop of 90 s), no statement runs past 30 s
//     (`statement_timeout`), at most `--workers` connections are open, and no new read starts after `--max-minutes` (exit 3,
//     no counts). Progress (phase and counts, never a row) goes to stderr.
//   - Counts and buckets only: no tenant, customer, order, invoice or amount is printed or selected.
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const require = createRequire(import.meta.url);
const NAME = "report-sa1091-order-bound-census";
const COMPOSE_URL = "postgresql://user:pass@127.0.0.1:5432/routeflow_dev";
export const SHOW_READ_ONLY = "SHOW transaction_read_only";
export const DEFAULT_MAX_MINUTES = 45;
export const DEFAULT_WORKERS = 2;
/** a single statement is cancelled by the database after this long */
export const STATEMENT_TIMEOUT_MS = 30_000;
/** backstop for one read transaction: a ~15 s slice plus one statement at its cap, with room */
export const TX_BACKSTOP_MS = 90_000;

const intFlag = (argv, name, lo, hi, dflt) => {
  const hits = argv.filter((a) => a.startsWith(`${name}=`));
  if (hits.length > 1) return { error: `${name} given more than once` };
  if (!hits.length) return { value: dflt };
  const raw = hits[0].slice(name.length + 1);
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < lo || n > hi)
    return { error: `${name} must be a whole number from ${lo} to ${hi}` };
  return { value: n };
};

/** Arguments: `--target-host=<host>`, `--max-minutes=<n>`, `--workers=<n>`, `--self-test`. Anything else (a write flag too) is refused. */
export function checkArgs(argv) {
  const hosts = argv.filter((a) => a.startsWith("--target-host="));
  if (hosts.length > 1) return { ok: false, message: "--target-host given more than once" };
  for (const a of argv) {
    if (
      a.startsWith("--target-host=") ||
      a.startsWith("--max-minutes=") ||
      a.startsWith("--workers=") ||
      a === "--self-test"
    )
      continue;
    return {
      ok: false,
      message: `unexpected argument ${a} (this report is read-only and has no write mode)`,
    };
  }
  const minutes = intFlag(argv, "--max-minutes", 1, 240, DEFAULT_MAX_MINUTES);
  if (minutes.error) return { ok: false, message: minutes.error };
  const workers = intFlag(argv, "--workers", 1, 4, DEFAULT_WORKERS);
  if (workers.error) return { ok: false, message: workers.error };
  return {
    ok: true,
    selfTest: argv.includes("--self-test"),
    targetHost: hosts.length ? hosts[0].slice("--target-host=".length) : null,
    maxMinutes: minutes.value,
    workers: workers.value,
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

/** The session must be read-only before anything is read (the pool's startup option); exits 2 otherwise. */
export async function proveSession(pool) {
  const session = readOnlyFlag((await pool.query(SHOW_READ_ONLY)).rows);
  if (session !== "on") throw notReadOnly("on the session", session);
}

/**
 * One short read-only unit per call: a transaction that proves `transaction_read_only` is `on` before `fn` touches anything,
 * runs `fn(tx)`, and always ends in ROLLBACK (the result is carried out through the rollback sentinel). A writable
 * transaction runs nothing and exits 2. The census calls this once per page or slice, never once for the whole run.
 */
export function makeReader(db) {
  return async function read(fn) {
    let result;
    try {
      await db.$transaction(
        async (tx) => {
          const flag = readOnlyFlag(await tx.$queryRawUnsafe(SHOW_READ_ONLY));
          if (flag !== "on") throw notReadOnly("in the transaction", flag);
          result = await fn(tx);
          throw ROLLBACK;
        },
        { timeout: TX_BACKSTOP_MS, maxWait: 30_000 },
      );
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    return result;
  };
}

export async function selfTest() {
  const eq = (got, want, what) => {
    if (JSON.stringify(got) !== JSON.stringify(want))
      throw new Error(`self-test: ${what}: got ${JSON.stringify(got)}`);
  };
  eq(checkArgs([]).ok, true, "no args");
  eq(checkArgs([]).maxMinutes, DEFAULT_MAX_MINUTES, "default budget");
  eq(checkArgs([]).workers, DEFAULT_WORKERS, "default workers");
  eq(checkArgs(["--max-minutes=10", "--workers=4"]).workers, 4, "workers flag");
  eq(checkArgs(["--workers=9"]).ok, false, "too many workers");
  eq(checkArgs(["--max-minutes=0"]).ok, false, "zero minutes");
  eq(checkArgs(["--max-minutes=x"]).ok, false, "non-numeric minutes");
  eq(checkArgs(["--target-host=a", "--target-host=b"]).ok, false, "two hosts");
  eq(checkArgs(["--write"]).ok, false, "a write flag is refused");
  eq(guardTarget(null, { host: "localhost" }).ok, true, "loopback needs no flag");
  eq(guardTarget(null, { host: "db.example.test" }).code, 64, "remote without a flag");
  eq(guardTarget("x", { host: "db.example.test" }).code, 65, "remote with the wrong host");
  eq(guardTarget("db.example.test", { host: "db.example.test" }).ok, true, "remote named");
  eq(targetOf("postgresql://u:s@h.test:5432/d").database, "d", "database name");
  const on = { rows: [{ transaction_read_only: "on" }] };
  const off = { rows: [{ transaction_read_only: "off" }] };
  const mk = (inTx) => {
    const calls = [];
    return {
      calls,
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
  await proveSession({ query: async () => on });
  await proveSession({ query: async () => off }).then(
    () => {
      throw new Error("self-test: a writable session passed");
    },
    (e) => eq(e.exitCode, 2, "writable session exits 2"),
  );
  let m = mk(on);
  const read = makeReader(m.db);
  eq(await read(async () => 7), 7, "result carried out");
  eq(await read(async () => 8), 8, "a second read is its own transaction");
  eq(m.calls, ["begin", "rollback", "begin", "rollback"], "every read begins and rolls back");
  m = mk(off);
  let ran = false;
  await makeReader(m.db)(async () => (ran = true)).then(
    () => {
      throw new Error("self-test: a writable transaction ran");
    },
    (e) => eq(e.exitCode, 2, "writable transaction exits 2"),
  );
  eq(ran, false, "the census never ran in a writable transaction");
  return "self-test ok";
}

/** Progress to stderr at most every few seconds: the phase and its counts, never a row. */
export function makeProgress(write = (s) => console.error(s), now = Date.now, everyMs = 5000) {
  const t0 = now();
  let last = 0;
  let lastPhase = "";
  return ({ phase, done, total }) => {
    const t = now();
    if (phase === lastPhase && t - last < everyMs && (total === null || done < total)) return;
    last = t;
    lastPhase = phase;
    write(
      `${NAME}: ${phase} ${done}${total === null ? "" : `/${total}`} · ${Math.round((t - t0) / 1000)} s`,
    );
  };
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
  const built = fileURLToPath(new URL("../dist/returns/order-bound-census.js", import.meta.url));
  if (!existsSync(built))
    throw new Error("census: build the api first (npm run build -w apps/api)");
  const { censusOrderBound } = require(built);
  const { Pool } = require("pg");
  const { PrismaClient } = require("@prisma/client");
  const { PrismaPg } = require("@prisma/adapter-pg");
  // The session is read-only from its first byte (a startup option), and no statement may run past the cap. Nothing is sent
  // on a fresh connection from an event handler: a query fired there overlaps the first query Prisma sends and the pg client
  // warns "client.query() called while the client is already executing a query". A pooler that drops the startup option is
  // caught by the SHOW proof below, which fails closed.
  const pool = new Pool({
    connectionString: url,
    max: args.workers + 1,
    options: `-c default_transaction_read_only=on -c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
  });
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    await proveSession(pool);
    const started = Date.now();
    const result = await censusOrderBound(makeReader(db), {
      workers: args.workers,
      deadline: started + args.maxMinutes * 60_000,
      onProgress: makeProgress(),
    });
    console.error(`${NAME}: done in ${Math.round((Date.now() - started) / 1000)} s`);
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
