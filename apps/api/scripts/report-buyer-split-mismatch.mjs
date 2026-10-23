/**
 * READ-ONLY census for row 531 (the buyer-cart "2 each = 1 box" P0): how many buyer-channel order
 * lines could have been stored at the wrong quantity, per tenant. An UPPER BOUND, never a victim list.
 *
 * WHY IT CAN ONLY BOUND. The buggy client sent {qty: 2, boxes: 1, pieces: 0}; the server read the
 * split, so the stored line is {qty: 12, boxes: 1, pieces: 0}: exactly the shape of a buyer who
 * deliberately ordered one Case. The two cannot be told apart from the stored row, so:
 *
 *   lines        every buyer-authored, non-cancelled, non-unit line on a boxed product (unitsPerBox > 1)
 *                stored as boxes >= 1, pieces = 0, created since --since (default 2026-04-12, the commit
 *                that introduced updateQty's `{ ...i, qty }` spread, 7c0218dd1; the split-carrying Add
 *                that made it bite arrived 2026-04-13, 1e9f6aa48). The CEILING.
 *   likelier     the subset of those that the order's own history contradicts within --window days
 *                (default 14) of the line's creation, by ANY of:
 *                  staffReduction  a staff OrderRevision whose snapshot holds the same product at a
 *                                  smaller qty
 *                  changeRequest   a ChangeRequest on the order for that line or product
 *                  returned        a Return (standard, or inline sourced from this order) of that product
 *                  shortPick       delivered qty above 0 and below the line's qty, settled in the window
 *                A line a buyer wanted at one Case and never touched again is in `lines` only.
 *   amount       what the line bills, recomputed with @routeflow/pricing's computeLineSubtotal and
 *                roundMoney from the stored unitPrice / qty / boxes / pieces / unitsPerBox / free units
 *                (no SQL arithmetic, no stored subtotal). It is the billed amount, not the over-charge.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner runs it:
 *
 *   npm run build -w packages/pricing     # once; the script imports @routeflow/pricing's dist
 *   railway run --service postgres node apps/api/scripts/report-buyer-split-mismatch.mjs
 *   ... add --json for the machine-readable report, --tenant <tenantId> to scope it,
 *       --since <YYYY-MM-DD> to move the start, --window <days> to move the 14-day follow-up window.
 *   node apps/api/scripts/report-buyer-split-mismatch.mjs --self-test   (no database)
 *
 * WHICH DATABASE: the shared report resolver (scripts/lib/report-db-url.mjs, B768); the target is
 * printed (password redacted) to stderr before anything is read.
 *
 * WHAT IT PRINTS: per tenant ID (never a slug, name, order, line or product id), the counts and
 * amounts above. Approved test tenants (scripts/lib/test-tenants.cjs) are folded into one `test`
 * line and never listed.
 *
 * SAFETY: the connection pool runs with `default_transaction_read_only = on`, the work happens in a
 * `BEGIN TRANSACTION READ ONLY` that is rolled back, statement and lock timeouts cap every query,
 * and only SELECT appears below. There is no write branch and no --apply flag. A spec
 * (src/common/report-buyer-split-mismatch-script.spec.ts) fails the build if a write verb is added.
 */
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const require = createRequire(import.meta.url);
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");
// computeLineSubtotal + roundMoney: the house money helpers; this file does no money arithmetic of its own.
const { computeLineSubtotal, roundMoney } = require("@routeflow/pricing");

const NAME = "report-buyer-split-mismatch";
export const SINCE_DEFAULT = "2026-04-12";
export const WINDOW_DEFAULT_DAYS = 14;
const PAGE = 2000;

/**
 * One page of candidate lines, keyset-paged on the line id. Parameters: $1 since (timestamp),
 * $2 tenant id or null, $3 window days, $4 last line id seen ('' for the first page), $5 page size.
 * The "followed by" signals are EXISTS subqueries so the page stays one row per line.
 */
export const CENSUS_SQL = `
SELECT i.id,
       i."tenantId",
       i."orderId",
       i.qty,
       i.boxes,
       i.pieces,
       i."unitsPerBox",
       i."unitPrice",
       i."promoFreeUnits",
       t.slug,
       EXISTS (
         SELECT 1
           FROM "OrderRevision" r,
                LATERAL jsonb_array_elements(
                  CASE WHEN jsonb_typeof(r.snapshot -> 'lineItems') = 'array'
                       THEN r.snapshot -> 'lineItems' ELSE '[]'::jsonb END
                ) AS l
          WHERE r."orderId" = i."orderId"
            AND r."editedByRole" IN ('OPERATOR', 'TENANT_ADMIN')
            AND r."createdAt" > i."createdAt"
            AND r."createdAt" <= i."createdAt" + make_interval(days => $3::int)
            AND l ->> 'productId' = i."productId"
            AND (l ->> 'qty')::numeric < i.qty
       ) AS "staffReduction",
       EXISTS (
         SELECT 1
           FROM "ChangeRequest" cr
          WHERE cr."orderId" = i."orderId"
            AND (cr."orderItemId" = i.id OR cr."productId" = i."productId")
            AND cr."createdAt" > i."createdAt"
            AND cr."createdAt" <= i."createdAt" + make_interval(days => $3::int)
       ) AS "changeRequest",
       EXISTS (
         SELECT 1
           FROM "Return" rt
           JOIN "ReturnItem" ri ON ri."returnId" = rt.id
          WHERE ri."productId" = i."productId"
            AND (rt."orderId" = i."orderId" OR ri."sourceOrderId" = i."orderId")
            AND rt."createdAt" > i."createdAt"
            AND rt."createdAt" <= i."createdAt" + make_interval(days => $3::int)
       ) AS "returned",
       (i."deliveredQty" > 0
        AND i."deliveredQty" < i.qty
        AND i."updatedAt" <= i."createdAt" + make_interval(days => $3::int)) AS "shortPick"
  FROM "OrderItem" i
  JOIN "Order" o ON o.id = i."orderId"
  LEFT JOIN "Tenant" t ON t.id = i."tenantId"
 WHERE i."productId" IS NOT NULL
   AND i.status <> 'CANCELLED'
   AND i."unitLabel" IS NULL
   AND COALESCE(i."unitsPerBox", 0) > 1
   AND COALESCE(i.boxes, 0) >= 1
   AND COALESCE(i.pieces, 0) = 0
   AND i."createdAt" >= $1::timestamp
   AND (i."authorChannel" = 'BUYER'
        OR (i."authorChannel" IS NULL AND o."sourceRecorded" AND o.source = 'APP'))
   AND ($2::text IS NULL OR i."tenantId" = $2::text)
   AND i.id > $4::text
 ORDER BY i.id
 LIMIT $5::int`;

/** The ways a line's order history contradicts it (the "likelier" signals). */
export const SIGNALS = ["staffReduction", "changeRequest", "returned", "shortPick"];

/** What one stored line bills, by the house helpers (never SQL arithmetic, never the stored subtotal). */
export function lineAmount(row) {
  return roundMoney(
    computeLineSubtotal({
      unitPrice: Number(row.unitPrice),
      qty: Number(row.qty),
      boxes: row.boxes == null ? null : Number(row.boxes),
      pieces: row.pieces == null ? null : Number(row.pieces),
      unitsPerBox: row.unitsPerBox == null ? null : Number(row.unitsPerBox),
      freeUnits: Number(row.promoFreeUnits ?? 0),
    }),
  );
}

const emptyBucket = () => ({
  lines: 0,
  amount: 0,
  likelier: 0,
  likelierAmount: 0,
  staffReduction: 0,
  changeRequest: 0,
  returned: 0,
  shortPick: 0,
});

function add(bucket, row) {
  const amount = lineAmount(row);
  bucket.lines += 1;
  bucket.amount = roundMoney(bucket.amount + amount);
  const hit = SIGNALS.filter((s) => row[s] === true);
  for (const s of hit) bucket[s] += 1;
  if (hit.length > 0) {
    bucket.likelier += 1;
    bucket.likelierAmount = roundMoney(bucket.likelierAmount + amount);
  }
}

/**
 * Group candidate rows per tenant id. Approved test tenants are folded into one `test` bucket and
 * never listed; a row with no tenant lands in `noTenant`. Rows carry `slug` only for that test.
 */
export function summarize(rows) {
  const byTenant = new Map();
  const test = emptyBucket();
  const noTenant = emptyBucket();
  const total = emptyBucket();
  for (const r of rows) {
    if (r.slug && isTestTenant(r.slug)) {
      add(test, r);
      continue;
    }
    add(total, r);
    if (r.tenantId == null) {
      add(noTenant, r);
      continue;
    }
    if (!byTenant.has(r.tenantId))
      byTenant.set(r.tenantId, { tenantId: r.tenantId, ...emptyBucket() });
    add(byTenant.get(r.tenantId), r);
  }
  const detail = [...byTenant.values()].sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  return { tenants: detail.length, total, noTenant, test, detail };
}

/** No-DB checks of the pure parts (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const line = (over) => ({
    id: "l",
    tenantId: "t-1",
    slug: "acme-live",
    qty: 12,
    boxes: 1,
    pieces: 0,
    unitsPerBox: 12,
    unitPrice: "15.60",
    promoFreeUnits: null,
    staffReduction: false,
    changeRequest: false,
    returned: false,
    shortPick: false,
    ...over,
  });
  // the P0 line: one 12-pack at $15.60 a box bills $15.60, never qty x price
  eq(lineAmount(line({})), 15.6, "one box");
  eq(lineAmount(line({ qty: 24, boxes: 2 })), 31.2, "two boxes");
  eq(lineAmount(line({ promoFreeUnits: 1, qty: 24, boxes: 2 })), 15.6, "a free unit is subtracted");
  const s = summarize([
    line({ id: "a", tenantId: "t-2" }),
    line({ id: "b", tenantId: "t-1", staffReduction: true }),
    line({ id: "c", tenantId: "t-1", changeRequest: true, returned: true, qty: 24, boxes: 2 }),
    line({ id: "d", tenantId: "t-1" }),
    line({ id: "e", tenantId: "t-q", slug: "qa-531-abc12345" }), // an approved test tenant
    line({ id: "f", tenantId: null, slug: null }),
  ]);
  eq([s.tenants, s.total.lines, s.test.lines, s.noTenant.lines], [2, 5, 1, 1], "buckets");
  eq(
    s.detail.map((d) => [
      d.tenantId,
      d.lines,
      d.likelier,
      d.staffReduction,
      d.changeRequest,
      d.returned,
    ]),
    [
      ["t-1", 3, 2, 1, 1, 1],
      ["t-2", 1, 0, 0, 0, 0],
    ],
    "per tenant",
  );
  eq([s.detail[0].amount, s.detail[0].likelierAmount], [62.4, 46.8], "per tenant amounts");
  if (JSON.stringify(s).includes("acme-live") || JSON.stringify(s).includes("qa-531"))
    throw new Error("summary leaked a slug");
  for (const needle of ["OrderItem", "$1::timestamp", "make_interval", "authorChannel"])
    if (!CENSUS_SQL.includes(needle)) throw new Error(`sql lost ${needle}`);
  return "self-test ok";
}

function fail(message) {
  console.error(`${NAME}: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {
    json: false,
    tenant: null,
    since: SINCE_DEFAULT,
    window: WINDOW_DEFAULT_DAYS,
    selfTest: false,
  };
  const known = new Set(["--json", "--tenant", "--since", "--window", "--self-test"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--self-test") out.selfTest = true;
    else if (a === "--tenant" || a === "--since" || a === "--window") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) fail(`${a} needs a value`);
      if (a === "--tenant") out.tenant = v;
      else if (a === "--since") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) fail("--since needs a date like 2026-04-12");
        out.since = v;
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 365)
          fail("--window needs a whole number of days, 1 to 365");
        out.window = n;
      }
    } else if (a.startsWith("--") && !known.has(a)) fail(`unknown argument ${a}`);
    else fail(`unexpected argument ${a}`);
  }
  return out;
}

const money = (n) => `$${n.toFixed(2)}`;

function printBucket(label, b) {
  console.log(
    `  ${label}: ${b.lines} line(s), ${money(b.amount)} billed; likelier ${b.likelier} line(s), ${money(b.likelierAmount)} ` +
      `(staff reduction ${b.staffReduction}, change request ${b.changeRequest}, returned ${b.returned}, short-pick ${b.shortPick})`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    console.log(selfTest());
    return;
  }
  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    options: "-c default_transaction_read_only=on",
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '45s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const rows = [];
    let last = "";
    for (;;) {
      const { rows: page } = await client.query(CENSUS_SQL, [
        args.since,
        args.tenant,
        args.window,
        last,
        PAGE,
      ]);
      rows.push(...page);
      if (page.length < PAGE) break;
      last = page[page.length - 1].id;
    }
    await client.query("ROLLBACK");

    const report = {
      since: args.since,
      windowDays: args.window,
      note:
        "UPPER BOUND: a deliberate one-Case line has the same stored shape as a P0 line. " +
        "`lines` is the ceiling; `likelier` is the subset the order's own history contradicts.",
      ...summarize(rows),
    };
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `${NAME}: buyer-authored whole-Case lines on boxed products since ${args.since}; follow-up window ${args.window} day(s)`,
    );
    console.log(`  ${report.note}`);
    printBucket("all live tenants", report.total);
    for (const d of report.detail) printBucket(`tenant ${d.tenantId}`, d);
    if (report.noTenant.lines > 0) printBucket("no tenant", report.noTenant);
    if (report.test.lines > 0) printBucket("approved test tenants (not listed)", report.test);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end().catch(() => {});
  }
}

/** True when this module is the process entry point (not imported by a spec). */
export function isInvokedDirectly(entry = process.argv[1], self = fileURLToPath(import.meta.url)) {
  if (!entry) return false;
  const norm = (p) => {
    let r = p;
    try {
      r = realpathSync(p);
    } catch {
      // keep the path as given
    }
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return (
    norm(entry) === norm(self) || basename(entry).toLowerCase() === basename(self).toLowerCase()
  );
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`${NAME}: ${e.message}`);
    process.exit(1);
  });
}
