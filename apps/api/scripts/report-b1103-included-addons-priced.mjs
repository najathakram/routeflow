/**
 * READ-ONLY report for B1103 / SA-1104 (Q4): how many businesses hold an add-on their plan INCLUDES, still priced?
 *
 * SA-786/787: moving UP to a plan that includes an add-on stops billing it (price 0, Stripe item gone, row stays
 * active). Until the subscribe fix, `subscribe()` wrote the catalog price back over that 0 for an add-on the
 * workspace re-listed, so such a row can sit priced, and may still carry a Stripe item. This reads the rows and says
 * how many, what the rows say is owed, and since when. It is the daily invariant I3 (`addon-invariant.job.ts`), run
 * once over every PRODUCTION, not-deleted tenant: it LOADS the I3 predicate, `inclusionOf` and the plan-key helpers
 * from the compiled `apps/api/dist` (so the report and the alert never disagree) and refuses to run without it (exit 2,
 * row D-10). Build first: `npm run build -w apps/api`.
 *
 * Two kinds of finding, because they are not the same harm:
 *   - STRIPE_ITEM    the row holds a Stripe item: Stripe may be charging it (the item's own price is NOT read here;
 *                    this script touches the database only);
 *   - PRICED_NO_ITEM the row is priced but has no Stripe item: not charged at Stripe; manual-invoice and MRR exposure
 *                    only.
 * A row whose SKU's inclusion cannot be judged (`CATALOG_INVALID`, B1102) or whose tenant has no resolvable catalog
 * or plan is counted APART as "unjudged": it is not proven clean and not a finding.
 *
 * EVERY SUM IS AN UPPER BOUND: what the row says is owed (`priceSnapshot` times whole months since the row's last
 * price change, else its creation), not what was invoiced or charged.
 *
 * OWNER-ONLY for a LIVE run. Never run from an implementation session or by a lead: the owner runs it with a
 * per-call approval, one exact command:
 *
 *   railway run --service postgres node apps/api/scripts/report-b1103-included-addons-priced.mjs [--tenant <id>] [--json]
 *
 * `--self-test` runs the pure checks with no database and no dist, and exits. Any repair goes through
 * `plan.stop_billing` (`stopBillingIncludedAddonsTx`) in its own PR after an owner ruling; this script never writes.
 *
 * Output: tenant ids, row ids, SKU codes, counts and amounts. No slug, no name, no Stripe id. LIVE and TEST tenants
 * (scripts/lib/test-tenants.cjs) are reported apart.
 *
 * Exit: 0 when LIVE is clean, 3 on any LIVE finding of either kind, 2 usage error (bad flag, no database url, no
 * dist), 1 any other failure. TEST findings and "unjudged" rows are printed but never change the exit. The report ends
 * with a `LIVE FINDINGS: n` line (and `--json` carries `liveFindings`): read that line.
 *
 * SAFETY: `default_transaction_read_only = on` before any other query; `statement_timeout` and `lock_timeout` cap
 * every query; only SELECT appears below; the connection is closed in `finally`.
 */
import { createRequire } from "module";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const {
  UPPER_BOUND_NOTE,
  NO_ITEM_NOTE,
  judge,
  buildReport,
  formatReport,
  exitCodeFor,
  selfTest,
} = require("./lib/b1103-included-addons-core.cjs");

const SCRIPT = "report-b1103-included-addons-priced";
const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = join(HERE, "..", "dist");

/**
 * The compiled app code the report judges with. Throws a sentence naming the build command when `apps/api/dist` is
 * missing: the caller maps that to exit 2 (a report that silently judged with a hand copy could disagree with the alert).
 */
export function loadDist(root = DIST_ROOT) {
  const need = ["billing/addon-invariant.job.js", "billing/addon-inclusion.js"];
  const missing = need.filter((f) => !existsSync(join(root, f)));
  if (missing.length) {
    throw new DistMissingError(
      `${SCRIPT}: cannot find apps/api/dist (${missing.join(", ")} missing). ` +
        "Run `npm run build -w apps/api` first: this report loads the I3 predicate and `inclusionOf` from the compiled app.",
    );
  }
  const job = require(join(root, "billing/addon-invariant.job.js"));
  const inclusion = require(join(root, "billing/addon-inclusion.js"));
  const constants = require(join(root, "billing/plan-catalog.constants.js"));
  const i3 = job.ADDON_INVARIANTS.find((c) => c.id === "I3");
  if (!i3) throw new Error(`${SCRIPT}: ADDON_INVARIANTS has no I3 in ${root}`);
  return {
    i3,
    inclusionOf: inclusion.inclusionOf,
    normalizePlanKey: constants.normalizePlanKey,
    planKeyFromEnum: constants.planKeyFromEnum,
    addonSkuCode: constants.addonSkuCode,
    stateChangedType: constants.BILLING_EVENTS.ADDON_STATE_CHANGED,
  };
}

export class DistMissingError extends Error {}

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
  let onlyTenant = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") continue;
    if (argv[i] === "--tenant") {
      onlyTenant = argv[++i];
      if (!onlyTenant) usage("--tenant needs a tenant id");
      continue;
    }
    usage(`unknown argument ${argv[i]} (use --tenant <id>, --json, --self-test)`);
  }
  let d;
  try {
    d = loadDist();
  } catch (e) {
    if (e instanceof DistMissingError) usage(e.message.replace(`${SCRIPT}: `, ""));
    throw e;
  }
  const databaseUrl = resolveReportDbUrl(SCRIPT);
  if (!databaseUrl) process.exit(2);
  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");
    await client.query("SET lock_timeout = '5s'");
    // The same population as the daily job: PRODUCTION, not deleted.
    const { rows: trows } = await client.query(
      `SELECT t.id, t.slug, t.plan::text AS plan, t."planVersionId",
              s."planKey" AS "subPlanKey", s."planVersionId" AS "subPlanVersionId"
         FROM "Tenant" t
         LEFT JOIN "TenantSubscription" s ON s."tenantId" = t.id
        WHERE t.class = 'PRODUCTION' AND t."deletedAt" IS NULL
          AND ($1::text IS NULL OR t.id = $1)
        ORDER BY t.id`,
      [onlyTenant],
    );
    const tenants = trows.map((t) => ({
      id: t.id,
      slug: t.slug,
      plan: t.plan,
      planVersionId: t.planVersionId,
      // I3 reads only the plan key and the pin (no billing mode), so nothing else of the subscription is read.
      sub:
        t.subPlanKey === null && t.subPlanVersionId === null
          ? null
          : { planKey: t.subPlanKey, planVersionId: t.subPlanVersionId },
    }));
    const ids = tenants.map((t) => t.id);
    const { rows: addonRows } = await client.query(
      `SELECT id, "tenantId", "addonKey", sku, active, "isComp", quantity, "priceSnapshot",
              "stripeItemId", "createdAt", "updatedAt"
         FROM "TenantAddon" WHERE "tenantId" = ANY($1::text[])`,
      [ids],
    );
    const rowsByTenant = new Map();
    for (const r of addonRows) {
      const list = rowsByTenant.get(r.tenantId) ?? [];
      list.push(r);
      rowsByTenant.set(r.tenantId, list);
    }
    const { rows: versions } = await client.query(
      `SELECT id, status::text AS status, version FROM "PlanVersion" ORDER BY version DESC`,
    );
    const knownVersions = new Set(versions.map((v) => v.id));
    const publishedId = versions.find((v) => v.status === "PUBLISHED")?.id ?? null;
    const { rows: skuRows } = await client.query(
      `SELECT "planVersionId", sku, name, "monthlyPrice", unit::text AS unit, "includedAtPlan",
              "meteredKey"::text AS "meteredKey", "capacityPerUnit", stackable, "grantsFlags", "sortOrder"
         FROM "AddonSku"`,
    );
    const skusByVersion = new Map();
    for (const s of skuRows) {
      const list = skusByVersion.get(s.planVersionId) ?? [];
      list.push(s);
      skusByVersion.set(s.planVersionId, list);
    }
    // When each priced row last changed price (its `addon.state_changed` record), else its creation date is used.
    const { rows: changes } = await client.query(
      `SELECT payload->>'rowId' AS "rowId", MAX("createdAt") AS at
         FROM "BillingEvent"
        WHERE type = $1 AND "tenantId" = ANY($2::text[]) AND payload->'changes' ? 'priceSnapshot'
        GROUP BY 1`,
      [d.stateChangedType, ids],
    );
    const since = new Map(changes.map((c) => [c.rowId, c.at]));

    const judged = judge({
      d,
      tenants,
      rowsByTenant,
      skusByVersion,
      knownVersions,
      publishedId,
      since,
      now: new Date(),
    });
    const report = buildReport({ tenants, judged });
    if (json) {
      console.log(
        JSON.stringify(
          {
            note: UPPER_BOUND_NOTE,
            pricedNoItemNote: NO_ITEM_NOTE,
            liveFindings: report.live.findings,
            ...report,
          },
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
