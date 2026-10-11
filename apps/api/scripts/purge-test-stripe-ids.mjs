#!/usr/bin/env node
/**
 * purge-test-stripe-ids.mjs (#2437): before the Stripe LIVE-mode cutover, clear the TEST-mode
 * Stripe ids the platform stored, so BillingService.ensureStripeCustomer() cannot hand a live
 * checkout a test customer.
 *
 * DRY RUN by default. It lists every stored id and verifies each against the Stripe TEST account
 * (retrieve → livemode:false). Nothing is written.
 *
 *   TenantSubscription.stripeCustomerId / stripeSubId    cleared when the test account returns them
 *   TenantAddon.stripePriceId / stripeItemId             cleared when the test account returns them
 *   TenantStripeConnect (livemode = false, still active) disconnectedAt + chargesEnabled=false
 *                                                        (no Stripe deauthorize, pendingJti untouched)
 *
 * An id the test account does NOT know is NOT proven test-mode and is never cleared (listed as
 * skipped). A live key is refused: after the flip, test ids cannot be verified. Free-pilot rule:
 * the overdue sweep's `stripeSubId: { not: null }` filter is untouched (see lib/stripe-test-purge.mjs).
 *
 * EXCLUSIONS: --exclude-tenant <slug,...> drops every row of those tenants before planning. The
 * owner supplies the slugs at run time; never write one into git, a doc or a ticket. An unknown
 * slug aborts the run. The dry run prints each touched tenant's slug beside its UUID so the owner
 * can say yes per tenant.
 *
 * APPLY (owner only, with a fresh backup):
 *   --apply --backup-taken --confirm <N>   (N = the change count the dry run printed)
 * One transaction; every update is compare-and-set on the value the dry run saw, and every change
 * writes an AuditLog row (action billing.stripe_test_id_purged).
 *
 * Target (#2419/B768 conventions):
 *   production:  STRIPE_SECRET_KEY=sk_test_… railway run --service postgres node apps/api/scripts/purge-test-stripe-ids.mjs
 *                (the Railway proxy only; never a stray DATABASE_URL)
 *   local:       … node apps/api/scripts/purge-test-stripe-ids.mjs --local   (provably-local target only)
 * Runbook: docs/runbooks/stripe-live-cutover.md.
 */
import { createRequire } from "node:module";
import pg from "pg";
import { isLocalDbTarget } from "./lib/local-db-target.cjs";
import { requireLocalPgConfig } from "./lib/local-pg-config.mjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";
import protectedSlugsLib from "./lib/protected-slugs.cjs";
import payingTenant from "./lib/paying-tenant.cjs";
import liveTargetGuard from "./lib/live-target-guard.cjs";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";

const { loadProtectedSlugs } = protectedSlugsLib;
const { protectedArm } = payingTenant;
const { assertWritableTenant, confirmProtectedOverride, refuseRetiredFlags, ProtectedTenantError } =
  liveTargetGuard;
import {
  applyRefusal,
  buildPlan,
  classifyKey,
  confirmationCount,
  idsToVerify,
  parseArgs,
  resolveExclusions,
  withoutExcluded,
} from "./lib/stripe-test-purge.mjs";

const TAG = "purge-test-stripe-ids";
const USAGE = `Usage: node apps/api/scripts/purge-test-stripe-ids.mjs [--local] [--exclude-tenant <slug,...>] [--allow-protected <tenantId>]... [--apply --backup-taken --confirm <N>]
  Dry run by default. Needs STRIPE_SECRET_KEY = the CURRENT sk_test key (run BEFORE the live cutover).
  Production: STRIPE_SECRET_KEY=sk_test_… railway run --service postgres node apps/api/scripts/purge-test-stripe-ids.mjs`;

function fail(msg, code = 1) {
  console.error(`${TAG}: ${msg}`);
  process.exit(code);
}

const args = parseArgs(process.argv.slice(2));
if (args.error) {
  console.error(`${TAG}: ${args.error}\n${USAGE}`);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const key = process.env.STRIPE_SECRET_KEY ?? "";
const keyMode = classifyKey(key);
// Refused before any connection: a live key can never verify a test id.
if (keyMode === "live") {
  fail(
    "STRIPE_SECRET_KEY is a LIVE key. Test ids can only be verified with the current sk_test key, " +
      "so run this purge BEFORE the live cutover (docs/runbooks/stripe-live-cutover.md).",
  );
}
if (args.apply && keyMode !== "test")
  fail("--apply needs STRIPE_SECRET_KEY = the current sk_test key");

function resolveTarget() {
  // B768: the shared resolver only (never a direct env read); --local still refuses a non-local host.
  const url = resolveDatabaseUrl(process.env, { requireProxy: !args.local });
  if (!url) fail("--local requires a local database connection string");
  if (args.local && !isLocalDbTarget(url))
    fail(`--local refuses a non-local host (${redactUrl(url)})`);
  return { url, config: args.local ? requireLocalPgConfig(url) : { connectionString: url } };
}

async function verifyWithStripe(ids) {
  const verdict = new Map();
  if (keyMode !== "test") return verdict; // dry run without a key: everything stays unproven
  const require = createRequire(import.meta.url);
  const Stripe = require("stripe");
  const stripe = new Stripe(key);
  const retrieve = {
    customer: (id) => stripe.customers.retrieve(id),
    subscription: (id) => stripe.subscriptions.retrieve(id),
    price: (id) => stripe.prices.retrieve(id),
    item: (id) => stripe.subscriptionItems.retrieve(id),
  };
  for (const [kind, set] of Object.entries(ids)) {
    for (const id of set) {
      try {
        const obj = await retrieve[kind](id);
        // A deleted customer comes back as { deleted: true } from the SAME account: still a test id.
        verdict.set(id, obj.livemode === true ? "live" : "test");
      } catch (err) {
        verdict.set(id, err?.code === "resource_missing" ? "missing" : "error");
      }
    }
  }
  return verdict;
}

async function main() {
  const { url, config } = resolveTarget();
  const client = new pg.Client(config);
  await client.connect();
  try {
    const subscriptions = (
      await client.query(
        `SELECT id, "tenantId", "stripeCustomerId", "stripeSubId" FROM "TenantSubscription"
         WHERE "stripeCustomerId" IS NOT NULL OR "stripeSubId" IS NOT NULL ORDER BY id`,
      )
    ).rows;
    const addons = (
      await client.query(
        `SELECT id, "tenantId", "stripePriceId", "stripeItemId" FROM "TenantAddon"
         WHERE "stripePriceId" IS NOT NULL OR "stripeItemId" IS NOT NULL ORDER BY id`,
      )
    ).rows;
    const connects = (
      await client.query(
        `SELECT id, "tenantId", "stripeAccountId", livemode, "disconnectedAt" FROM "TenantStripeConnect"
         WHERE livemode = false ORDER BY id`,
      )
    ).rows;

    const tenants = (await client.query(`SELECT id, slug FROM "Tenant"`)).rows;
    const slugOf = new Map(tenants.map((t) => [t.id, t.slug]));
    const who = (tenantId) => `${slugOf.get(tenantId) ?? "?"} (${tenantId})`;
    const exclusion = resolveExclusions(args.excludeTenants, tenants);
    if (exclusion.unknown.length)
      fail(
        `--exclude-tenant names no tenant: ${exclusion.unknown.join(", ")} (nothing verified or written)`,
      );
    const all = { subscriptions, addons, connects };
    const rows = withoutExcluded(all, exclusion.ids);
    const dropped =
      subscriptions.length +
      addons.length +
      connects.length -
      (rows.subscriptions.length + rows.addons.length + rows.connects.length);

    const verdict = await verifyWithStripe(idsToVerify(rows));
    const plan = buildPlan(rows, verdict);

    console.log(
      `${TAG}: target ${redactUrl(url)} · key ${keyMode} · ${args.apply ? "APPLY" : "DRY RUN"}`,
    );
    console.log(
      `  read: ${subscriptions.length} subscription row(s), ${addons.length} add-on row(s), ` +
        `${connects.length} test-mode Connect row(s)`,
    );
    for (const id of exclusion.ids) console.log(`  EXCLUDED (never touched): ${who(id)}`);
    if (exclusion.ids.size) console.log(`  excluded rows dropped before planning: ${dropped}`);
    const byModel = {};
    for (const c of plan.changes) byModel[c.model] = (byModel[c.model] ?? 0) + 1;
    console.log(`  changes: ${plan.changes.length} ${JSON.stringify(byModel)}`);
    for (const c of plan.changes) {
      const what = c.set
        ? `mark disconnected (account ${c.stripeAccountId})`
        : `clear ${Object.entries(c.clear)
            .map(([f, v]) => `${f}=${v}`)
            .join(", ")}`;
      console.log(`    ${c.model} ${c.id} (tenant ${who(c.tenantId)}): ${what}`);
    }
    if (plan.skipped.length) {
      console.log(`  skipped (not proven test-mode, left as-is): ${plan.skipped.length}`);
      for (const s of plan.skipped)
        console.log(
          `    ${s.model} ${s.id} (tenant ${who(s.tenantId)}) ${s.field}=${s.value} → ${s.verdict}`,
        );
    }
    // The owner says yes per tenant (runbook step 4) from this list before any --apply.
    const perTenant = new Map();
    for (const c of plan.changes) perTenant.set(c.tenantId, (perTenant.get(c.tenantId) ?? 0) + 1);
    console.log(`  tenants touched: ${perTenant.size}`);
    for (const [t, n] of perTenant) console.log(`    ${who(t)}: ${n} change(s)`);
    if (keyMode !== "test")
      console.log(
        "  NOTE: no sk_test key, so nothing could be verified and nothing would be cleared.",
      );

    if (!args.apply) {
      console.log(
        `\nDry run only. To apply (owner, after a fresh backup), repeat the SAME --exclude-tenant ` +
          `value and add: --apply --backup-taken --confirm ${confirmationCount(plan)}`,
      );
      return;
    }

    const refusal = applyRefusal({ args, keyMode, plan });
    if (refusal) fail(`refusing --apply: ${refusal}`);

    // Row 195: this script clears Stripe ids on the very tenants the protected arm covers (paying,
    // Stripe-linked), so it is NEVER bulk on them: each protected tenant it would touch needs its own
    // `--allow-protected <tenantId>` AND a typed "ALLOW PROTECTED <tenantId>" at a real terminal.
    // Approved test tenants hold no client data and need neither.
    try {
      refuseRetiredFlags(process.argv.slice(2));
      const protectedSlugs = loadProtectedSlugs(process.env, url);
      const touched = [...new Set(plan.changes.map((c) => c.tenantId))];
      const { rows: guardRows } = await client.query(
        `SELECT t.id, t.slug, t.status, t.class, t."deletedAt", s."planKey", s."stripeSubId"
           FROM "Tenant" t LEFT JOIN "TenantSubscription" s ON s."tenantId" = t.id
          WHERE t.id = ANY($1::text[])`,
        [touched],
      );
      const tokens = new Map();
      for (const t of guardRows) {
        if (isTestTenant(t.slug)) continue;
        if (protectedArm(t, t, protectedSlugs) === null) continue;
        tokens.set(
          t.id,
          await confirmProtectedOverride({ tenantId: t.id, argv: process.argv.slice(2) }),
        );
      }
      for (const t of guardRows) {
        if (isTestTenant(t.slug)) continue;
        assertWritableTenant(t, t, protectedSlugs, { allowProtected: tokens.get(t.id) });
      }
    } catch (err) {
      if (err instanceof ProtectedTenantError || /PROTECTED_TENANT_SLUGS/.test(err.message))
        fail(err.message);
      throw err;
    }

    await client.query("BEGIN");
    let applied = 0;
    for (const c of plan.changes) {
      let res;
      if (c.model === "TenantStripeConnect") {
        res = await client.query(
          `UPDATE "TenantStripeConnect" SET "disconnectedAt" = now(), "chargesEnabled" = false, "updatedAt" = now()
           WHERE id = $1 AND livemode = false AND "disconnectedAt" IS NULL AND "stripeAccountId" = $2`,
          [c.id, c.stripeAccountId],
        );
      } else {
        const fields = Object.keys(c.clear);
        const sets = fields.map((f) => `"${f}" = NULL`).join(", ");
        const guards = fields.map((f, i) => `"${f}" = $${i + 2}`).join(" AND ");
        res = await client.query(
          `UPDATE "${c.model}" SET ${sets}, "updatedAt" = now() WHERE id = $1 AND ${guards}`,
          [c.id, ...fields.map((f) => c.clear[f])],
        );
      }
      if (res.rowCount !== 1) {
        await client.query("ROLLBACK");
        fail(`row ${c.model} ${c.id} changed since the dry run: rolled back, nothing written`);
      }
      await client.query(
        `INSERT INTO "AuditLog" (id, "tenantId", action, "entityType", "entityId", meta, "createdAt")
         VALUES (gen_random_uuid(), $1, 'billing.stripe_test_id_purged', $2, $3, $4::jsonb, now())`,
        [
          c.tenantId,
          c.model,
          c.id,
          JSON.stringify({
            issue: "#2437",
            cleared: c.clear,
            ...(c.set ? { disconnected: true, stripeAccountId: c.stripeAccountId } : {}),
          }),
        ],
      );
      applied++;
    }
    await client.query("COMMIT");
    console.log(
      `\nApplied ${applied} change(s) in one transaction; ${applied} AuditLog row(s) written.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => fail(err?.message ?? String(err)));
