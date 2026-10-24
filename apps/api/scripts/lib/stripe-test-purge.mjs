/**
 * #2437 — pure planning for purge-test-stripe-ids.mjs (no DB, no network; pinned by
 * src/common/purge-test-stripe-ids-script.spec.ts).
 *
 * Before the Stripe live-mode cutover, every Stripe id the platform stored was minted by the TEST
 * account. After STRIPE_SECRET_KEY flips to sk_live those ids are dangling, and worse,
 * BillingService.ensureStripeCustomer() returns a stored stripeCustomerId as-is, so a tenant would
 * check out in live mode against a test customer and fail. Stripe ids do not encode their mode
 * (`cus_…` looks the same in both), so an id is only cleared when the TEST account itself returns
 * it with `livemode: false`. That is why the purge must run with the current sk_test key, BEFORE
 * the flip.
 *
 * Free-pilot rule: clearing a test `stripeSubId` moves a tenant into the "no Stripe subscription"
 * shape. The overdue sweep (billing.service.ts, `stripeSubId: { not: null }`) keeps its filter
 * untouched; this module never changes it, and a test subscription never charged anyone.
 */

/** "test" | "live" | "none" for a Stripe secret/restricted key. */
export function classifyKey(key) {
  const k = String(key ?? "").trim();
  if (/^(sk|rk)_test_/.test(k)) return "test";
  if (/^(sk|rk)_live_/.test(k)) return "live";
  return "none";
}

/** The ids a row set carries, keyed by kind, for the Stripe verification pass. */
export function idsToVerify({ subscriptions, addons }) {
  const ids = { customer: new Set(), subscription: new Set(), price: new Set(), item: new Set() };
  for (const s of subscriptions) {
    if (s.stripeCustomerId) ids.customer.add(s.stripeCustomerId);
    if (s.stripeSubId) ids.subscription.add(s.stripeSubId);
  }
  for (const a of addons) {
    if (a.stripePriceId) ids.price.add(a.stripePriceId);
    if (a.stripeItemId) ids.item.add(a.stripeItemId);
  }
  return ids;
}

/**
 * Build the change plan.
 * @param rows {subscriptions, addons, connects} as read from the DB
 * @param verdict Map<id, "test" | "live" | "missing" | "error"> from the Stripe pass
 *   ("missing": the test account does not know it, so it is NOT proven test and is never cleared)
 * @returns {{ changes: Array, skipped: Array, liveIds: string[] }}
 *   Each change: { model, id, tenantId, clear: {field: oldValue}, set?: {...} }.
 */
export function buildPlan({ subscriptions, addons, connects }, verdict) {
  const changes = [];
  const skipped = [];
  const liveIds = [];
  const judge = (id) => verdict.get(id) ?? "missing";

  const collect = (model, row, fields) => {
    const clear = {};
    for (const f of fields) {
      const id = row[f];
      if (!id) continue;
      const v = judge(id);
      if (v === "test") clear[f] = id;
      else {
        if (v === "live") liveIds.push(id);
        skipped.push({
          model,
          id: row.id,
          tenantId: row.tenantId,
          field: f,
          value: id,
          verdict: v,
        });
      }
    }
    if (Object.keys(clear).length)
      changes.push({ model, id: row.id, tenantId: row.tenantId, clear });
  };

  for (const s of subscriptions)
    collect("TenantSubscription", s, ["stripeCustomerId", "stripeSubId"]);
  for (const a of addons) collect("TenantAddon", a, ["stripePriceId", "stripeItemId"]);

  // TenantStripeConnect carries its own mode: a test-mode (livemode=false) connection that is
  // still active gets disconnectedAt + chargesEnabled=false (stripeAccountId kept for the audit
  // trail), so the tenant reconnects through live OAuth. Unlike StripeConnectService.disconnect()
  // it does NOT deauthorize the account at Stripe and does not touch pendingJti: a test-mode
  // authorization has no effect on the live platform.
  for (const c of connects) {
    if (c.livemode === false && c.stripeAccountId && !c.disconnectedAt) {
      changes.push({
        model: "TenantStripeConnect",
        id: c.id,
        tenantId: c.tenantId,
        clear: {},
        set: { disconnectedAt: "now", chargesEnabled: false },
        stripeAccountId: c.stripeAccountId,
      });
    }
  }
  return { changes, skipped, liveIds };
}

/**
 * Owner exclusions (#2437 review): tenants named at RUN TIME with --exclude-tenant are never
 * touched. Slugs are never written into git; they arrive on argv and resolve against the DB.
 * @param slugs the --exclude-tenant values
 * @param tenants [{id, slug}] from the Tenant table
 * @returns {{ ids: Set<string>, unknown: string[] }} an unknown slug must abort the run
 */
export function resolveExclusions(slugs, tenants) {
  const bySlug = new Map(tenants.map((t) => [t.slug, t.id]));
  const ids = new Set();
  const unknown = [];
  for (const slug of slugs) {
    const id = bySlug.get(slug);
    if (id) ids.add(id);
    else unknown.push(slug);
  }
  return { ids, unknown };
}

/** Drop every row of an excluded tenant before planning, so it can never be written. */
export function withoutExcluded({ subscriptions, addons, connects }, excludedIds) {
  const keep = (r) => !excludedIds.has(r.tenantId);
  return {
    subscriptions: subscriptions.filter(keep),
    addons: addons.filter(keep),
    connects: connects.filter(keep),
  };
}

/** The type-back the operator must pass as --confirm: the exact number of changes. */
export function confirmationCount(plan) {
  return String(plan.changes.length);
}

const ALLOWED_FLAGS = new Set(["--apply", "--local", "--backup-taken", "--help", "-h"]);
const VALUED_FLAGS = new Set(["--confirm", "--exclude-tenant", "--allow-protected"]);

/** Strict argv parsing: an unknown flag is an error, never ignored (cf. #2284). */
export function parseArgs(argv) {
  const out = {
    apply: false,
    local: false,
    backupTaken: false,
    help: false,
    confirm: null,
    excludeTenants: [],
    allowProtected: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUED_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      if (a === "--confirm") out.confirm = v;
      else if (a === "--allow-protected") {
        // Row 195: one tenant id per flag (repeatable); each protected tenant it names still needs its
        // own typed confirmation at a real terminal — never a bulk list.
        if (!out.allowProtected.includes(v)) out.allowProtected.push(v);
      } else {
        // --exclude-tenant a,b and repeated --exclude-tenant a --exclude-tenant b both work.
        const slugs = v.split(",").map((x) => x.trim());
        if (slugs.some((x) => !x)) return { error: `${a} has an empty slug` };
        for (const x of slugs) if (!out.excludeTenants.includes(x)) out.excludeTenants.push(x);
      }
      i++;
      continue;
    }
    if (!ALLOWED_FLAGS.has(a)) return { error: `unknown argument: ${a}` };
    if (a === "--apply") out.apply = true;
    if (a === "--local") out.local = true;
    if (a === "--backup-taken") out.backupTaken = true;
    if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

/** Everything --apply requires BEFORE any database write; returns a refusal reason or null. */
export function applyRefusal({ args, keyMode, plan }) {
  if (keyMode !== "test")
    return keyMode === "live"
      ? "STRIPE_SECRET_KEY is a LIVE key: test ids can no longer be verified. Run the purge BEFORE the cutover, with the current sk_test key"
      : "STRIPE_SECRET_KEY is missing: ids cannot be verified as test-mode";
  if (plan.liveIds.length)
    return `the test account reports ${plan.liveIds.length} id(s) as livemode: refusing`;
  if (!args.backupTaken) return "--apply needs --backup-taken (take a fresh database backup first)";
  if (args.confirm !== confirmationCount(plan))
    return `--apply needs --confirm ${confirmationCount(plan)} (the change count printed by the dry run)`;
  return null;
}
