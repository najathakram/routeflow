// SA-1097: READ-ONLY census of stored box-split lines that carry NO unitsPerBox snapshot. Counts only: no tenant, customer,
// order, product, id or amount is selected into the output. It answers (1) how many such lines exist, by order status, and how
// many an order edit on master would have re-priced at today's product pack (exposed: the pack the line was sold in differs
// from the live pack the old code read), how many were sold with no pack at all, how many are 0-box lines (step 3 of the
// rule), and how many the new rule would refuse; (2) from the order edit history (OrderRevision snapshots), how many lines
// were already re-stamped at a pack other than their own between two consecutive revisions (a line already hit cannot be seen
// from its own row: the invoice followed and the snapshot now looks normal).
// The pack rule is `resolveStoredLinePack` in @routeflow/pricing (the code is the truth; nothing is restated here). Needs the
// pricing package built: `npm run build -w packages/pricing`.
//
// NEVER RUN FROM AN IMPLEMENTATION SESSION. Against the compose database (no flags) it is a local check. Against production
// the owner runs it in two steps (the live-target guard): once to see the host it resolves to, then naming that host.
//
//   railway run --service postgres node apps/api/scripts/report-sa1097-stored-line-pack-census.mjs
//   railway run --service postgres node apps/api/scripts/report-sa1097-stored-line-pack-census.mjs --target-host=<the host it printed>
//
//   optional: --max-minutes=<1-120, default 30>  --skip-history
//   node apps/api/scripts/report-sa1097-stored-line-pack-census.mjs --self-test   (no database)
//
// SAFETY
//   - A loopback target (127.0.0.1, localhost, [::1]) needs no flag. Any other host is refused BEFORE connecting unless
//     `--target-host=<host>` equals the resolved host (exit 64 when missing, 65 on a mismatch). No credentials are printed.
//   - The session is read-only from its first byte (a startup option), exit 2 unless SHOW transaction_read_only is `on` on the
//     session and again inside EVERY read transaction; every read ends with ROLLBACK. No write flag exists.
//   - Bounded: keyset pages, one short READ ONLY transaction per page, `statement_timeout` 30 s, no new page after
//     `--max-minutes` (exit 3, no counts). Progress (phase and counts, never a row) goes to stderr.
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const require = createRequire(import.meta.url);
const NAME = "report-sa1097-stored-line-pack-census";
const COMPOSE_URL = "postgresql://user:pass@127.0.0.1:5432/routeflow_dev";
export const SHOW_READ_ONLY = "SHOW transaction_read_only";
export const DEFAULT_MAX_MINUTES = 30;
export const STATEMENT_TIMEOUT_MS = 30_000;
const PAGE = 2000;
const REVISION_PAGE = 500;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Arguments: `--target-host=<host>`, `--max-minutes=<n>`, `--skip-history`, `--self-test`. Anything else (a write flag too) is refused. */
export function checkArgs(argv) {
  const out = {
    ok: true,
    targetHost: null,
    maxMinutes: DEFAULT_MAX_MINUTES,
    skipHistory: false,
    selfTest: false,
  };
  const seen = new Set();
  for (const a of argv) {
    const [flag, val] = a.includes("=")
      ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]
      : [a, null];
    if (seen.has(flag)) return { ok: false, message: `${flag} given more than once` };
    seen.add(flag);
    if (flag === "--target-host" && val) out.targetHost = val;
    else if (flag === "--max-minutes" && val !== null) {
      const n = Number(val);
      if (!/^\d+$/.test(val) || n < 1 || n > 120)
        return { ok: false, message: "--max-minutes must be a whole number from 1 to 120" };
      out.maxMinutes = n;
    } else if (flag === "--skip-history" && val === null) out.skipHistory = true;
    else if (flag === "--self-test" && val === null) out.selfTest = true;
    else return { ok: false, message: `unknown argument ${flag}` };
  }
  return out;
}

export function targetOf(url) {
  const u = new URL(url);
  return { host: u.hostname, database: u.pathname.replace(/^\//, "") };
}

/** A loopback target passes; any other host exits 64 without `--target-host`, 65 when it does not equal the host. */
export function guardTarget(targetHost, target) {
  if (LOOPBACK.has(target.host)) return { ok: true };
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

const num = (v) => (v == null ? null : Number(v));
const emptyBucket = () => ({
  storedSplitNoSnapshot: 0,
  exposed: 0,
  ownPackDiffersLive: 0,
  soldWithNoPack: 0,
  zeroBox: 0,
  wouldRefuse: 0,
});

/** One line's classification, through the shipped rule. `resolve` is `resolveStoredLinePack`. */
export function classifyLine(resolve, row) {
  const livePack = num(row.livePack) ?? 0;
  const r = resolve({
    qty: num(row.qty),
    boxes: num(row.boxes),
    pieces: num(row.pieces),
    unitsPerBox: num(row.unitsPerBox),
    unitPrice: num(row.unitPrice),
    subtotal: num(row.subtotal),
    freeUnits: num(row.promoFreeUnits) ?? 0,
    livePack,
  });
  const oldPack = livePack > 1 ? livePack : 0; // what master's edit read
  const flags = {
    zeroBox: !(num(row.boxes) > 0),
    wouldRefuse: !r.ok,
    soldWithNoPack: false,
    exposed: false,
    ownPackDiffersLive: false,
  };
  if (r.ok) {
    flags.soldWithNoPack = r.pack === null;
    flags.exposed = (r.pack ?? 0) !== oldPack;
    flags.ownPackDiffersLive = r.pack !== null && r.pack !== oldPack;
  }
  return flags;
}

export function addToBucket(bucket, flags) {
  bucket.storedSplitNoSnapshot += 1;
  for (const k of ["exposed", "ownPackDiffersLive", "soldWithNoPack", "zeroBox", "wouldRefuse"])
    if (flags[k]) bucket[k] += 1;
}

/**
 * Edit history: for one order's two CONSECUTIVE revision snapshots, the lines (matched by product, only where the product has
 * exactly one line in each) that had a split and no snapshot before and carry a pack after that is not the pack their own
 * split/money said. Returns { examined, restampedAtOtherPack, moneyMoved }.
 */
export function compareRevisions(resolve, prev, next) {
  const only = (lines) => {
    const m = new Map();
    for (const l of lines ?? []) {
      if (!l || l.status === "CANCELLED" || !l.productId) continue;
      m.set(l.productId, m.has(l.productId) ? null : l);
    }
    return m;
  };
  const a = only(prev?.lineItems);
  const b = only(next?.lineItems);
  const out = { examined: 0, restampedAtOtherPack: 0, moneyMoved: 0 };
  for (const [pid, before] of a) {
    const after = b.get(pid);
    if (!before || !after) continue;
    if (num(before.boxes) == null || num(before.unitsPerBox) > 1) continue;
    out.examined += 1;
    if (!(num(after.unitsPerBox) > 1)) continue;
    const own = resolve({
      qty: num(before.qty),
      boxes: num(before.boxes),
      pieces: num(before.pieces),
      unitsPerBox: null,
      unitPrice: num(before.unitPrice),
      subtotal: num(before.subtotal),
      livePack: num(after.unitsPerBox), // the only candidate there is; the stored money has to vouch for it
    });
    if (!(own.ok && own.pack === num(after.unitsPerBox))) {
      out.restampedAtOtherPack += 1;
      if (Math.abs(num(after.subtotal) - num(before.subtotal)) > 0.01) out.moneyMoved += 1;
    }
  }
  return out;
}

export async function selfTest() {
  const { resolveStoredLinePack } = require("@routeflow/pricing");
  const eq = (a, b, m) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`self-test: ${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  };
  const row = (o) => ({
    qty: 120,
    boxes: 10,
    pieces: 0,
    unitsPerBox: null,
    unitPrice: 10,
    subtotal: 100,
    promoFreeUnits: 0,
    livePack: 24,
    ...o,
  });
  eq(
    classifyLine(resolveStoredLinePack, row({})),
    {
      zeroBox: false,
      wouldRefuse: false,
      soldWithNoPack: false,
      exposed: true,
      ownPackDiffersLive: true,
    },
    "12-pack line, live 24",
  );
  eq(
    classifyLine(resolveStoredLinePack, row({ qty: 10 })),
    {
      zeroBox: false,
      wouldRefuse: false,
      soldWithNoPack: true,
      exposed: true,
      ownPackDiffersLive: false,
    },
    "no pack at sale, live 24",
  );
  eq(classifyLine(resolveStoredLinePack, row({ qty: 240 })).exposed, false, "own pack equals live");
  eq(
    classifyLine(resolveStoredLinePack, row({ qty: 6, boxes: 0, pieces: 6, subtotal: 7 }))
      .wouldRefuse,
    true,
    "unreadable",
  );
  eq(
    classifyLine(resolveStoredLinePack, row({ qty: 6, boxes: 0, pieces: 6, subtotal: 2.5 }))
      .zeroBox,
    true,
    "0-box",
  );
  const l = (o) => ({
    productId: "p",
    status: "PENDING",
    qty: 120,
    boxes: 10,
    pieces: 0,
    unitsPerBox: null,
    unitPrice: 10,
    subtotal: 100,
    ...o,
  });
  eq(
    compareRevisions(
      resolveStoredLinePack,
      { lineItems: [l({})] },
      { lineItems: [l({ qty: 120, boxes: 5, unitsPerBox: 24, subtotal: 50 })] },
    ),
    { examined: 1, restampedAtOtherPack: 1, moneyMoved: 1 },
    "re-stamped at 24",
  );
  eq(
    compareRevisions(
      resolveStoredLinePack,
      { lineItems: [l({})] },
      { lineItems: [l({ unitsPerBox: 12 })] },
    ),
    { examined: 1, restampedAtOtherPack: 0, moneyMoved: 0 },
    "stamped at its own pack",
  );
  eq(
    compareRevisions(
      resolveStoredLinePack,
      { lineItems: [l({}), l({})] },
      { lineItems: [l({ unitsPerBox: 24 })] },
    ).examined,
    0,
    "two lines of one product are not matched",
  );
  eq(checkArgs(["--target-host=a", "--target-host=b"]).ok, false, "two hosts");
  eq(checkArgs(["--write"]).ok, false, "unknown flag");
  eq(guardTarget(null, { host: "db.example.test" }).code, 64, "remote without host");
  eq(guardTarget("x", { host: "db.example.test" }).code, 65, "remote mismatch");
  eq(guardTarget(null, { host: "127.0.0.1" }).ok, true, "loopback");
  return "self-test ok";
}

const LINES_SQL = `
  SELECT oi.id, oi.qty, oi.boxes, oi.pieces, oi."unitsPerBox", oi."unitPrice", oi.subtotal, oi."promoFreeUnits",
         o.status AS "orderStatus", p."unitsPerBox" AS "livePack"
  FROM "OrderItem" oi
  JOIN "Order" o ON o.id = oi."orderId"
  LEFT JOIN "Product" p ON p.id = oi."productId"
  WHERE oi.id > $1 AND oi.boxes IS NOT NULL AND (oi."unitsPerBox" IS NULL OR oi."unitsPerBox" <= 1)
    AND oi."productId" IS NOT NULL AND oi.status <> 'CANCELLED' AND ($3::text IS NULL OR oi."tenantId" = $3)
  ORDER BY oi.id LIMIT $2`;

const REVISIONS_SQL = `
  SELECT r."orderId", r."revisionNumber", r.snapshot, o.status AS "orderStatus"
  FROM "OrderRevision" r
  JOIN "Order" o ON o.id = r."orderId"
  WHERE (r."orderId", r."revisionNumber") > ($1, $2) AND ($4::text IS NULL OR r."tenantId" = $4)
  ORDER BY r."orderId", r."revisionNumber" LIMIT $3`;

async function readTx(client, sql, params) {
  await client.query("BEGIN TRANSACTION READ ONLY");
  try {
    const ro = (await client.query(SHOW_READ_ONLY)).rows[0]?.transaction_read_only;
    if (ro !== "on")
      throw Object.assign(new Error("refusing: the session is not read-only"), { exitCode: 2 });
    return (await client.query(sql, params)).rows;
  } finally {
    await client.query("ROLLBACK").catch(() => {});
  }
}

/** The whole census over an open pg client. `tenantId` narrows to one tenant (specs only: the CLI never passes it). */
export async function runCensus(
  client,
  resolve,
  { deadline, skipHistory = false, tenantId = null, onProgress = () => {} } = {},
) {
  const late = () => {
    if (deadline && Date.now() > deadline)
      throw Object.assign(new Error("out of time (--max-minutes): no counts"), { exitCode: 3 });
  };
  const byStatus = {};
  const total = emptyBucket();
  let lastId = "";
  let seen = 0;
  for (;;) {
    late();
    const rows = await readTx(client, LINES_SQL, [lastId, PAGE, tenantId]);
    if (!rows.length) break;
    for (const r of rows) {
      const flags = classifyLine(resolve, r);
      addToBucket((byStatus[r.orderStatus] ??= emptyBucket()), flags);
      addToBucket(total, flags);
    }
    lastId = rows[rows.length - 1].id;
    seen += rows.length;
    onProgress("lines", seen);
  }
  const result = { lines: { total, byOrderStatus: byStatus } };
  if (!skipHistory) {
    const hist = {
      revisionPairsExamined: 0,
      linesExamined: 0,
      restampedAtOtherPack: 0,
      moneyMoved: 0,
      byOrderStatus: {},
    };
    let cursor = ["", 0];
    let prev = null;
    let revs = 0;
    for (;;) {
      late();
      const rows = await readTx(client, REVISIONS_SQL, [
        cursor[0],
        cursor[1],
        REVISION_PAGE,
        tenantId,
      ]);
      if (!rows.length) break;
      for (const r of rows) {
        const snap = typeof r.snapshot === "string" ? JSON.parse(r.snapshot) : r.snapshot;
        if (prev && prev.orderId === r.orderId) {
          const c = compareRevisions(resolve, prev.snap, snap);
          hist.revisionPairsExamined += 1;
          hist.linesExamined += c.examined;
          hist.restampedAtOtherPack += c.restampedAtOtherPack;
          hist.moneyMoved += c.moneyMoved;
          if (c.restampedAtOtherPack) {
            const b = (hist.byOrderStatus[r.orderStatus] ??= {
              restampedAtOtherPack: 0,
              moneyMoved: 0,
            });
            b.restampedAtOtherPack += c.restampedAtOtherPack;
            b.moneyMoved += c.moneyMoved;
          }
        }
        prev = { orderId: r.orderId, snap };
        cursor = [r.orderId, r.revisionNumber];
      }
      revs += rows.length;
      onProgress("revisions", revs);
    }
    result.editHistory = hist;
  }
  return result;
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
  const { resolveStoredLinePack } = require("@routeflow/pricing");
  const pg = require("pg");
  const client = new pg.Client({
    connectionString: url,
    options: `-c default_transaction_read_only=on -c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
  });
  await client.connect();
  try {
    const ro = (await client.query(SHOW_READ_ONLY)).rows[0]?.transaction_read_only;
    if (ro !== "on") {
      console.error(`${NAME}: refusing: the session is not read-only`);
      process.exit(2);
    }
    const started = Date.now();
    let last = 0;
    const result = await runCensus(client, resolveStoredLinePack, {
      deadline: started + args.maxMinutes * 60_000,
      skipHistory: args.skipHistory,
      onProgress: (phase, n) => {
        if (Date.now() - last > 10_000) {
          last = Date.now();
          console.error(`${NAME}: ${phase} ${n} · ${Math.round((last - started) / 1000)} s`);
        }
      },
    });
    console.error(`${NAME}: done in ${Math.round((Date.now() - started) / 1000)} s`);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`${NAME}: ${e.message}`);
    process.exitCode = e.exitCode ?? 1;
  } finally {
    await client.end().catch(() => {});
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
