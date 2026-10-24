/**
 * READ-ONLY count for the A3 flip (SA ruling 10-11, N6): how many READ_ONLY sellers have live buyer links?
 * The buyer-side READ_ONLY refusal (`SELLER_READ_ONLY_BUYER_GATE`) ships dark; the owner flips it to `enforced` only
 * after reading this count plus a week of `seller_read_only.would_deny` log counts.
 *
 *   railway run --service postgres node apps/api/scripts/report-read-only-sellers-with-buyers.mjs [--json]
 *   node apps/api/scripts/report-read-only-sellers-with-buyers.mjs --self-test      (no database)
 *
 * WHAT IT COUNTS (PRODUCTION tenants, not deleted, status READ_ONLY), per `readOnlyReason` bucket and in total:
 *   - sellers      READ_ONLY tenants;
 *   - withBuyers   ...of which have at least one LIVE buyer link: the link is ACTIVE, its customer is not removed and
 *                  the buyer's own account is ACTIVE and not deleted (the `liveBuyerLinkWhere` shape the guard uses);
 *   - links        the live buyer links at those sellers;
 *   - buyers       the distinct buyer accounts behind them.
 * The buckets: payment_overdue (the dunning pause), trial (trial_expired / trial_cancelled - a lapsed trial is READ_ONLY
 * too, which is why the gate is separate from BILLING_PAUSE_MODE), subscription_cancelled, other.
 *
 * OUTPUT is COUNTS ONLY: no tenant id, slug or name, no buyer or customer data of any kind.
 *
 * SAFETY: `default_transaction_read_only = on` before any other query; `statement_timeout` and `lock_timeout` cap every
 * query; the target is the one `resolveReportDbUrl` resolves (the redacted target goes to stderr; nothing usable = exit
 * 2 without connecting); only SELECT statements appear below; the connection is closed in `finally`.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);

const NAME = "report-read-only-sellers-with-buyers";

export const BUCKETS = ["payment_overdue", "trial", "subscription_cancelled", "other"];

/** Map a Tenant.readOnlyReason to its report bucket. */
export function bucketOf(reason) {
  if (reason === "payment_overdue") return "payment_overdue";
  if (reason === "trial_expired" || reason === "trial_cancelled") return "trial";
  if (reason === "subscription_cancelled") return "subscription_cancelled";
  return "other";
}

/** One row per READ_ONLY seller: its reason and its live buyer-link counts (links / distinct buyer accounts). */
export const SELLERS_SQL = `SELECT t."readOnlyReason" AS reason,
       COUNT(l.id)::int AS links,
       COUNT(DISTINCT l."buyerAccountId")::int AS buyers
  FROM "Tenant" t
  LEFT JOIN "CustomerLink" l
         ON l."tenantId" = t.id AND l.status = 'ACTIVE'
        AND EXISTS (SELECT 1 FROM "Customer" c WHERE c.id = l."customerId" AND c."deletedAt" IS NULL)
        AND EXISTS (SELECT 1 FROM "BuyerAccount" b
                     WHERE b.id = l."buyerAccountId" AND b.status = 'ACTIVE' AND b."deletedAt" IS NULL)
 WHERE t.status = 'READ_ONLY' AND t."deletedAt" IS NULL AND t.class = 'PRODUCTION'
 GROUP BY t.id, t."readOnlyReason"`;

/** Pure: fold the per-seller rows into the counts. Never reads or keeps an id. */
export function summarize(rows) {
  const zero = () => ({ sellers: 0, withBuyers: 0, links: 0, buyerAccountSlots: 0 });
  const out = { total: zero(), byReason: Object.fromEntries(BUCKETS.map((b) => [b, zero()])) };
  for (const r of rows) {
    for (const block of [out.total, out.byReason[bucketOf(r.reason)]]) {
      block.sellers += 1;
      if (r.links > 0) block.withBuyers += 1;
      block.links += r.links;
      // distinct per seller; a buyer linked to two sellers is counted at each (this is a per-seller exposure count)
      block.buyerAccountSlots += r.buyers;
    }
  }
  return out;
}

/** No-DB checks of the pure parts (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  eq(
    BUCKETS.map((b) => bucketOf({ payment_overdue: "payment_overdue", trial: "trial_expired" }[b])),
    ["payment_overdue", "trial", "other", "other"],
    "bucketOf",
  );
  eq(bucketOf("trial_cancelled"), "trial", "trial_cancelled is a trial");
  eq(bucketOf("subscription_cancelled"), "subscription_cancelled", "cancelled");
  eq(bucketOf(null), "other", "no reason");
  const s = summarize([
    { reason: "payment_overdue", links: 3, buyers: 2 },
    { reason: "payment_overdue", links: 0, buyers: 0 },
    { reason: "trial_expired", links: 1, buyers: 1 },
    { reason: null, links: 0, buyers: 0 },
  ]);
  eq(
    [s.total.sellers, s.total.withBuyers, s.total.links, s.total.buyerAccountSlots],
    [4, 2, 4, 3],
    "totals",
  );
  eq(
    [s.byReason.payment_overdue.sellers, s.byReason.payment_overdue.withBuyers],
    [2, 1],
    "payment_overdue bucket",
  );
  eq([s.byReason.trial.sellers, s.byReason.trial.links], [1, 1], "trial bucket");
  eq([s.byReason.other.sellers, s.byReason.other.withBuyers], [1, 0], "other bucket");
  if (/\bslug\b|"name"|email|businessName|t\.id\s*AS/i.test(SELLERS_SQL.replace(/GROUP BY.*/s, "")))
    throw new Error("the SELECT list must not carry an id, slug, name or email");
  if (/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|COPY)\b/i.test(SELLERS_SQL))
    throw new Error("the report SQL must be read-only");
  return "self-test ok";
}

function printBlock(name, b) {
  console.log(
    `${name}: ${b.sellers} READ_ONLY seller(s), ${b.withBuyers} with live buyer links ` +
      `(${b.links} link(s), ${b.buyerAccountSlots} buyer account(s) summed per seller)`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const json = argv.includes("--json");
  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);
  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");
    await client.query("SET lock_timeout = '5s'");
    const { rows } = await client.query(SELLERS_SQL);
    const report = summarize(rows);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log("\n=== READ_ONLY SELLERS WITH LIVE BUYER LINKS (counts only) ===");
      printBlock("all", report.total);
      for (const b of BUCKETS) printBlock(`  ${b}`, report.byReason[b]);
      console.log(
        "\nRead this with a week of `seller_read_only.would_deny` log counts before setting SELLER_READ_ONLY_BUYER_GATE=enforced.",
      );
    }
  } finally {
    await client.end().catch(() => {});
  }
}

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
  if (norm(entry) === norm(self)) return true;
  if (basename(entry).toLowerCase() === basename(self).toLowerCase()) {
    console.error(
      `${NAME}: warning: entry path ${entry} did not match ${self} exactly; running anyway.`,
    );
    return true;
  }
  return false;
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`${NAME}: ${e.message}`);
    process.exit(1);
  });
}
