/**
 * READ-ONLY report for B1281 / SA-1103 (c): did the duplicate-paid-checkout bug strand a business with two live
 * Stripe subscriptions?
 *
 * Between the park-or-cancel guard (B1158, #3347, 10-08) and its fix (#4150, 11-02), `getSubscriptionPaymentState`
 * asked Stripe for a 5-level expand and Stripe refused it. A second paid checkout over a stored live subscription
 * therefore threw in `cancelSupersededUnlessProcessing`: the old subscription was never cancelled, the new one was
 * never applied, and the webhook failed until Stripe stopped redelivering (~3 days). This finds the tenants it may
 * have left behind. For every tenant with a stripeCustomerId it reads, from Stripe:
 *   - the customer's subscriptions: more than one LIVE (active, trialing, past_due, unpaid) is a finding;
 *   - the customer's completed subscription checkouts since --since (default 2026-10-08) whose subscription is NOT
 *     the stored one: each distinct such subscription is an "orphan"; one that is still live is "orphanStillLive".
 * A non-live orphan is usually a replaced subscription, but it is still a finding (it is listed and counts toward
 * the exit): the owner reads it, the dangerous shapes are multiLive / orphanStillLive. A capped read (more than
 * MAX_PER_CUSTOMER rows) cannot prove clean and is a finding too. SA-1103 A-1 adds two classes, each its own line:
 *   - "Deleted business, still billing": a soft-deleted tenant (the read no longer skips them; every row carries
 *     `deleted yes|no`) with ANY live subscription, even one;
 *   - "Revivable, superseded": a superseded subscription that is neither live nor terminal (paused, incomplete)
 *     with a completed checkout in the window: it does not bill yet, and the owner should cancel it.
 * Which status means what is the app's (`stripe-period.ts`): LIVE = active, trialing, past_due, unpaid; terminal =
 * canceled, incomplete_expired; the script's two lists are pinned equal to it by a spec.
 *
 * OWNER-ONLY for a LIVE run. Never run from an implementation session or by a lead: the owner runs it with a
 * per-call approval, a READ-ONLY (restricted, list-only) Stripe key and `railway run`:
 *
 *   STRIPE_SECRET_KEY=rk_live_... railway run --service postgres node apps/api/scripts/report-b1281-superseded-checkouts.mjs [--since YYYY-MM-DD] [--json]
 *
 * A TEST-mode run (sk_test_ / rk_test_) is for local verification only. `--self-test` runs the pure checks with no
 * database and no Stripe, and exits.
 *
 * Output: tenant ids, counts, and the LAST FOUR characters of Stripe subscription ids. No slug, no name, no customer
 * id, no amount. LIVE and TEST tenants (scripts/lib/test-tenants.cjs) are reported apart.
 *
 * Exit: 0 when LIVE is clean, 3 on any LIVE finding, 2 usage error (no/invalid Stripe key, no database url, bad
 * flag), 1 any other failure (a Stripe error other than "customer not found" stops the run: a silent partial read
 * would read as "none found"). TEST findings are printed but never change the exit. The report ends with a
 * `LIVE FINDINGS: n` line (and `--json` carries `liveFindings`): read that line.
 * An error rethrown from Stripe is scrubbed of the key and cut to the last 4 of every Stripe id it names.
 *
 * SAFETY: `default_transaction_read_only = on` before any other query; `statement_timeout` and `lock_timeout` cap
 * every query; only SELECT appears below; Stripe is reached through `list` calls and nothing else (a spec pins that
 * every `stripe.<resource>.<verb>(` call is a read verb); the connection is closed in `finally`.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const SCRIPT = "report-b1281-superseded-checkouts";
/** The API version the app pins (`STRIPE_API_VERSION` in src/billing/stripe-period.ts; a spec keeps them equal). */
const STRIPE_API_VERSION = "2026-08-26.dahlia";
/** #3347 shipped the guard on 10-08: no checkout before it could have hit the refused read. */
const DEFAULT_SINCE = "2026-10-08";
/** The app's live statuses (`LIVE_SUBSCRIPTION_STATUSES` in src/billing/stripe-period.ts; a spec keeps them equal). */
export const LIVE_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);
/**
 * The app's terminal statuses (`isTerminalStripeSubscriptionStatus` in the same file; a spec keeps them equal).
 * Neither live nor terminal (`paused`, `incomplete`) is REVIVABLE: it does not bill now, but it can come back.
 */
export const TERMINAL_STATUSES = new Set(["canceled", "incomplete_expired"]);
/** Rows read per customer and per resource; more than this cannot be proven clean. */
const MAX_PER_CUSTOMER = 500;

export const last4 = (id) => (typeof id === "string" && id.length >= 4 ? id.slice(-4) : "????");

/**
 * One tenant's verdict from its Stripe reads. Pure. `subs` are the customer's subscriptions (any status),
 * `sessions` its completed checkout sessions since the cutoff.
 */
export function classifyTenant({ storedSubId, subs, sessions, capped = false, deleted = false }) {
  const statusById = new Map(subs.map((s) => [s.id, s.status]));
  const liveIds = subs.filter((s) => LIVE_STATUSES.has(s.status)).map((s) => s.id);
  const orphanIds = [
    ...new Set(
      sessions
        .filter((s) => s.mode === "subscription" && typeof s.subscription === "string")
        .map((s) => s.subscription)
        .filter((id) => id !== storedSubId),
    ),
  ];
  const orphanLiveIds = orphanIds.filter((id) => LIVE_STATUSES.has(statusById.get(id)));
  // A superseded subscription the failed handler would have cancelled: not live, not terminal, with a completed
  // checkout in the window. It is not billing yet, and the owner should cancel it (SA-1103 A-1 note 5).
  const revivableIds = orphanIds.filter((id) => {
    const status = statusById.get(id);
    return (
      typeof status === "string" && !LIVE_STATUSES.has(status) && !TERMINAL_STATUSES.has(status)
    );
  });
  const multiLive = liveIds.length > 1;
  const noStoredSub = !storedSubId;
  // A deleted business with ANY live subscription is still being billed for a service it no longer has (note 3).
  const deletedStillBilling = deleted && liveIds.length > 0;
  return {
    liveSubs: liveIds.length,
    multiLive,
    orphanSessions: orphanIds.length,
    orphanStillLive: orphanLiveIds.length,
    revivableSuperseded: revivableIds.length,
    noStoredSub,
    capped,
    deleted,
    deletedStillBilling,
    finding: multiLive || orphanIds.length > 0 || capped || deletedStillBilling,
    liveSub4: liveIds.map(last4),
    orphanSub4: orphanIds.map(last4),
    revivableSub4: revivableIds.map(last4),
  };
}

const emptyBlock = () => ({
  tenants: 0,
  clean: 0,
  findings: 0,
  customerNotFound: 0,
  byKind: {
    multiLive: 0,
    orphanSessions: 0,
    orphanStillLive: 0,
    revivableSuperseded: 0,
    deletedStillBilling: 0,
    noStoredSub: 0,
    capped: 0,
  },
  items: [],
});

/**
 * Counts per block (LIVE tenants, TEST tenants). `rows` are `{ tenantId, slug, result }` where `result` is a
 * classifyTenant verdict or `{ customerNotFound: true }`. The slug is used only to pick the block; it, the
 * customer id and any amount never leave this function.
 */
export function buildReport(rows) {
  const report = { live: emptyBlock(), test: emptyBlock() };
  for (const r of rows) {
    const block = isTestTenant(r.slug) ? report.test : report.live;
    block.tenants += 1;
    if (r.result.customerNotFound) {
      block.customerNotFound += 1;
      continue;
    }
    const v = r.result;
    if (!v.finding) {
      block.clean += 1;
      continue;
    }
    block.findings += 1;
    if (v.multiLive) block.byKind.multiLive += 1;
    if (v.orphanSessions > 0) block.byKind.orphanSessions += 1;
    if (v.orphanStillLive > 0) block.byKind.orphanStillLive += 1;
    if (v.revivableSuperseded > 0) block.byKind.revivableSuperseded += 1;
    if (v.deletedStillBilling) block.byKind.deletedStillBilling += 1;
    if (v.noStoredSub) block.byKind.noStoredSub += 1;
    if (v.capped) block.byKind.capped += 1;
    block.items.push({
      tenantId: r.tenantId,
      liveSubs: v.liveSubs,
      orphanSessions: v.orphanSessions,
      orphanStillLive: v.orphanStillLive,
      revivableSuperseded: v.revivableSuperseded,
      deleted: v.deleted,
      deletedStillBilling: v.deletedStillBilling,
      noStoredSub: v.noStoredSub,
      capped: v.capped,
      liveSub4: v.liveSub4,
      orphanSub4: v.orphanSub4,
      revivableSub4: v.revivableSub4,
    });
  }
  return report;
}

/**
 * An error message from Stripe with the key replaced and every Stripe id cut to its last 4 (`cus_…3456`): a
 * permission or lookup error names ids (the customer, the subscription, RouteFlow's own account) in full.
 */
export function scrubStripeError(message, key) {
  const text = key ? String(message).split(key).join("***") : String(message);
  return text.replace(
    /\b(cus|sub|acct|cs|in|pi|pm|seti|si|prod|price|ch|re|evt|txn|src|card|ba|tok)_[A-Za-z0-9_]{6,}/g,
    (id, prefix) => `${prefix}_…${id.slice(-4)}`,
  );
}

/** The report as printed lines (pure): both blocks, then the line the owner reads. */
export function formatReport(report) {
  const lines = [];
  for (const [name, b] of Object.entries(report)) {
    lines.push(
      `${name.toUpperCase()}: ${b.tenants} tenant(s) with a Stripe customer: ${b.clean} clean, ${b.findings} finding(s), ${b.customerNotFound} customer not in this Stripe mode`,
    );
    if (!b.findings) continue;
    const k = b.byKind;
    lines.push(
      `  multiLive ${k.multiLive}, orphan checkouts ${k.orphanSessions} (still live ${k.orphanStillLive}), revivable ${k.revivableSuperseded}, deleted still billing ${k.deletedStillBilling}, no stored subscription ${k.noStoredSub}, capped ${k.capped}`,
    );
    for (const i of b.items)
      lines.push(
        `  tenant ${i.tenantId}: live ${i.liveSubs} [${i.liveSub4.join(",")}], orphans ${i.orphanSessions} [${i.orphanSub4.join(",")}] (live ${i.orphanStillLive}), deleted ${i.deleted ? "yes" : "no"}${i.noStoredSub ? " NO-STORED-SUB" : ""}${i.capped ? " CAPPED" : ""}`,
      );
    const deletedIds = b.items.filter((i) => i.deletedStillBilling).map((i) => i.tenantId);
    if (deletedIds.length)
      lines.push(`  Deleted business, still billing: ${deletedIds.join(", ")}`);
    const revivable = b.items
      .filter((i) => i.revivableSuperseded > 0)
      .map((i) => `${i.tenantId} [${i.revivableSub4.join(",")}]`);
    if (revivable.length) lines.push(`  Revivable, superseded: ${revivable.join(", ")}`);
  }
  lines.push(
    `LIVE FINDINGS: ${report.live.findings} (the exit code is 3 when this is above 0; TEST findings are printed but never change it)`,
  );
  return lines;
}

/** 0 when LIVE is clean, 3 on any LIVE finding. A TEST-only finding is printed but never changes the exit (SA-1103). */
export const exitCodeFor = (report) => (report.live.findings > 0 ? 3 : 0);

/** `YYYY-MM-DD` to epoch seconds (UTC), or null when it is not a real date. */
export function parseSince(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text ?? "")) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== text
    ? null
    : Math.floor(ms / 1000);
}

/** A Stripe secret or restricted key, live or test. Returns the mode, or null. */
export function keyMode(key) {
  const m = /^(?:sk|rk)_(live|test)_[A-Za-z0-9]+$/.exec(key ?? "");
  return m ? m[1] : null;
}

/** Read a Stripe list to the end, up to `cap` rows. */
async function collect(list, cap) {
  const items = [];
  for await (const item of list) {
    items.push(item);
    if (items.length >= cap) return { items, capped: true };
  }
  return { items, capped: false };
}

/** The ONLY Stripe reads this script makes: two `list` calls per customer. */
export function readOnlyStripe(stripe, cap = MAX_PER_CUSTOMER) {
  return {
    subscriptions: (customer) =>
      collect(stripe.subscriptions.list({ customer, status: "all", limit: 100 }), cap),
    checkoutSessions: (customer, sinceSec) =>
      collect(
        stripe.checkout.sessions.list({
          customer,
          status: "complete",
          created: { gte: sinceSec },
          limit: 100,
        }),
        cap,
      ),
  };
}

/** No-DB, no-Stripe checks of the pure part (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const sub = (id, status) => ({ id, status });
  const sess = (subscription) => ({ mode: "subscription", subscription });

  const clean = classifyTenant({
    storedSubId: "sub_AAAA1111",
    subs: [sub("sub_AAAA1111", "active")],
    sessions: [sess("sub_AAAA1111")],
  });
  eq(clean.finding, false, "one stored live sub is clean");

  const two = classifyTenant({
    storedSubId: "sub_AAAA1111",
    subs: [sub("sub_AAAA1111", "active"), sub("sub_BBBB2222", "past_due")],
    sessions: [sess("sub_BBBB2222"), sess("sub_BBBB2222")],
  });
  eq([two.multiLive, two.orphanSessions, two.orphanStillLive], [true, 1, 1], "two live subs");

  const replaced = classifyTenant({
    storedSubId: "sub_AAAA1111",
    subs: [sub("sub_AAAA1111", "active"), sub("sub_OLD00009", "canceled")],
    sessions: [sess("sub_OLD00009")],
  });
  eq(
    [replaced.multiLive, replaced.orphanStillLive, replaced.finding],
    [false, 0, true],
    "replaced",
  );

  eq(
    classifyTenant({ storedSubId: "s", subs: [], sessions: [], capped: true }).finding,
    true,
    "cap",
  );
  eq(
    classifyTenant({
      storedSubId: "sub_AAAA1111",
      subs: [],
      sessions: [{ mode: "payment", subscription: null }],
    }).finding,
    false,
    "payment-mode session",
  );

  const rep = buildReport([
    { tenantId: "t-1", slug: "acme", result: two },
    { tenantId: "t-2", slug: "qa-x", result: clean },
    { tenantId: "t-3", slug: "globex", result: { customerNotFound: true } },
  ]);
  eq([rep.live.tenants, rep.live.findings, rep.live.customerNotFound], [2, 1, 1], "live block");
  eq([rep.test.tenants, rep.test.findings, rep.test.clean], [1, 0, 1], "test block");
  eq(
    [exitCodeFor(rep), exitCodeFor({ live: { findings: 0 }, test: { findings: 0 } })],
    [3, 0],
    "exit",
  );
  if (/acme|globex|qa-x|sub_|cus_/.test(JSON.stringify(rep)))
    throw new Error("report leaked an id");

  eq(
    [keyMode("sk_test_abc123"), keyMode("rk_live_abc123"), keyMode("pk_test_abc"), keyMode("")],
    ["test", "live", null, null],
    "keyMode",
  );
  eq(
    [parseSince("2026-10-08"), parseSince("2026-13-40"), parseSince("yesterday")],
    [1791417600, null, null],
    "parseSince",
  );
  eq(
    scrubStripeError("No such customer: 'cus_QwErTy123456' (sk_test_abc12345)", "sk_test_abc12345"),
    "No such customer: 'cus_…3456' (***)",
    "scrubStripeError",
  );
  const tail = formatReport({
    live: { ...rep.live, findings: 0, items: [] },
    test: rep.test,
  }).pop();
  eq(tail.startsWith("LIVE FINDINGS: 0 "), true, "live findings line");

  const deletedBilling = classifyTenant({
    deleted: true,
    storedSubId: "sub_AAAA1111",
    subs: [sub("sub_AAAA1111", "active")],
    sessions: [],
  });
  eq([deletedBilling.deletedStillBilling, deletedBilling.finding], [true, true], "D-1");
  const paused = classifyTenant({
    storedSubId: "sub_AAAA1111",
    subs: [sub("sub_AAAA1111", "active"), sub("sub_PAUS0009", "paused")],
    sessions: [sess("sub_PAUS0009")],
  });
  eq(paused.revivableSub4, ["0009"], "D-2 paused is revivable");
  const expired = classifyTenant({
    storedSubId: "sub_AAAA1111",
    subs: [sub("sub_AAAA1111", "active"), sub("sub_DEAD0005", "incomplete_expired")],
    sessions: [sess("sub_DEAD0005")],
  });
  eq(expired.revivableSuperseded, 0, "D-3 terminal is not revivable");
  eq(
    exitCodeFor({ live: { findings: 0 }, test: { findings: 3 } }),
    0,
    "a TEST-only finding exits 0",
  );
  return "self-test ok";
}

function usage(message) {
  console.error(`${SCRIPT}: ${message}`);
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const json = argv.includes("--json");
  let since = DEFAULT_SINCE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") continue;
    if (argv[i] === "--since") {
      since = argv[++i];
      continue;
    }
    usage(`unknown argument ${argv[i]} (use --since YYYY-MM-DD, --json, --self-test)`);
  }
  const sinceSec = parseSince(since);
  if (sinceSec === null) usage(`--since must be a real date, YYYY-MM-DD (got ${since})`);

  const key = process.env.STRIPE_SECRET_KEY;
  const mode = keyMode(key);
  if (!mode)
    usage("STRIPE_SECRET_KEY must be an sk_/rk_ live or test key (use a read-only restricted key)");
  const databaseUrl = resolveReportDbUrl(SCRIPT);
  if (!databaseUrl) process.exit(2);
  console.error(`${SCRIPT}: stripe mode ${mode}, checkouts since ${since}`);

  const Stripe = require("stripe");
  const stripe = readOnlyStripe(new Stripe(key, { apiVersion: STRIPE_API_VERSION }));

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");
    await client.query("SET lock_timeout = '5s'");
    const { rows: tenants } = await client.query(
      `SELECT s."tenantId", t.slug, s."stripeCustomerId", s."stripeSubId",
              (t."deletedAt" IS NOT NULL) AS deleted
         FROM "TenantSubscription" s
         JOIN "Tenant" t ON t.id = s."tenantId"
        WHERE s."stripeCustomerId" IS NOT NULL
        ORDER BY s."tenantId"`,
    );
    const rows = [];
    for (const t of tenants) {
      try {
        const subs = await stripe.subscriptions(t.stripeCustomerId);
        const sessions = await stripe.checkoutSessions(t.stripeCustomerId, sinceSec);
        rows.push({
          tenantId: t.tenantId,
          slug: t.slug,
          result: classifyTenant({
            storedSubId: t.stripeSubId,
            subs: subs.items,
            sessions: sessions.items,
            capped: subs.capped || sessions.capped,
            deleted: t.deleted === true,
          }),
        });
      } catch (e) {
        // A customer that is not in this Stripe mode (a LIVE tenant read with a test key, or a deleted customer)
        // is counted. Any other Stripe error stops the run: a partial read must never look clean.
        if (e?.code === "resource_missing") {
          rows.push({ tenantId: t.tenantId, slug: t.slug, result: { customerNotFound: true } });
        } else {
          throw new Error(scrubStripeError(e?.message ?? e, key));
        }
      }
    }
    const report = buildReport(rows);
    if (json) {
      console.log(
        JSON.stringify(
          { stripeMode: mode, since, liveFindings: report.live.findings, ...report },
          null,
          2,
        ),
      );
    } else {
      for (const line of formatReport(report)) console.log(line);
    }
    process.exitCode = exitCodeFor(report);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Run only when invoked directly: importing this module (for its pure functions / selfTest) must never start a
 * report. Paths are compared after realpath, case-insensitively on Windows; when only the file NAMES match it warns
 * and runs anyway: a silent exit 0 would read as "none found".
 */
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
      `${SCRIPT}: warning: entry path ${entry} did not match ${self} exactly; running anyway.`,
    );
    return true;
  }
  return false;
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`${SCRIPT}: ${e.message}`);
    process.exit(1);
  });
}
