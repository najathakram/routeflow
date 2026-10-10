// SA-733 D7 — the PURE core of apps/api/scripts/billing-catchup.mjs (the October catch-up tool): argument
// parsing, the printed (anonymised) report, and the --apply gate. No network, no database, no process.exit.
// Pinned by apps/api/src/billing/billing-catchup-tool.spec.ts.
//
// The tool is a thin client of the platform-admin API (GET catchup-plan / catchup-census = the dry-run,
// POST catchup-checkout = apply) so the amounts come from the SAME code the webhook later settles with
// (PlatformPricingService, the billable add-on lines, catchup-plan.ts) - never a second copy in a script.
//
// --apply needs ALL of (any one missing = refused, exit 1, nothing sent):
//   1. exactly one tenant, named with --tenant <slug> (never --all)
//   2. a tenant the dry-run says is eligible
//   3. --backup-taken
//   4. a real terminal on stdin AND stdout
//   5. the slug typed back at that terminal
//   6. a non-test tenant additionally needs --live-tenant-override AND the protected-tenant guard (#3344,
//      scripts/lib/live-target-guard.cjs + protected-slugs.cjs). While that module is absent the tool FAILS
//      CLOSED: every non-test tenant is refused. When present, a protected (paying / Stripe-linked / listed)
//      tenant also needs the guard's own override token (--allow-protected <tenantId>, typed phrase).

"use strict";

const { isTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const VALUE_FLAGS = new Set(["--tenant", "--expected-cents", "--allow-protected", "--api"]);
const BOOL_FLAGS = new Set([
  "--apply",
  "--all",
  "--backup-taken",
  "--live-tenant-override",
  "--json",
  "--help",
]);

/** @returns {{ ok: true, args: object } | { ok: false, error: string }} */
function parseArgs(argv) {
  const args = {
    apply: false,
    all: false,
    backupTaken: false,
    liveOverride: false,
    json: false,
    help: false,
    tenant: null,
    expectedCents: null,
    allowProtected: null,
    api: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_FLAGS.has(a)) {
      if (a === "--apply") args.apply = true;
      if (a === "--all") args.all = true;
      if (a === "--backup-taken") args.backupTaken = true;
      if (a === "--live-tenant-override") args.liveOverride = true;
      if (a === "--json") args.json = true;
      if (a === "--help") args.help = true;
    } else if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { ok: false, error: `${a} needs a value` };
      if (a === "--tenant") args.tenant = v;
      if (a === "--allow-protected") args.allowProtected = v;
      if (a === "--api") args.api = v;
      if (a === "--expected-cents") {
        if (!/^\d+$/.test(v)) return { ok: false, error: "--expected-cents must be whole cents" };
        args.expectedCents = Number(v);
      }
    } else {
      return { ok: false, error: `unknown argument: ${a}` };
    }
  }
  if (args.help) return { ok: true, args };
  if (args.all && args.tenant) return { ok: false, error: "use --tenant OR --all, not both" };
  if (!args.all && !args.tenant) {
    return { ok: false, error: "name a tenant with --tenant <slug>, or run the census with --all" };
  }
  if (args.apply && args.all) {
    return { ok: false, error: "--apply is per tenant: --all is a dry-run only" };
  }
  if (args.expectedCents != null && !args.apply) {
    return { ok: false, error: "--expected-cents only makes sense with --apply" };
  }
  return { ok: true, args };
}

/** 31000 -> "$310.00". Integer maths only. */
function money(cents) {
  if (cents == null) return "n/a";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}$${whole}.${frac}`;
}

const day = (iso) => (iso ? String(iso).slice(0, 10) : "n/a");

/** The printed block of one tenant. Ids and amounts only: never a name or a slug. */
function formatTenantReport(r) {
  const lines = [];
  lines.push(`tenant ${r.tenantId}`);
  lines.push(
    `  price         ${money(r.monthlyCents)}/month (${r.priceSource ?? "unresolved"}), plan ${r.planKey ?? "n/a"}`,
  );
  lines.push(
    `  census        stripe subscription: ${r.hasStripeSubscription ? "YES" : "no"} · manual invoicing: ${r.externalPayment ? "yes" : "NO"} · claim: ${r.claimState ?? "none"}`,
  );
  lines.push(`  RfInvoices    ${r.rfInvoices.open} open · ${r.rfInvoices.paid} paid`);
  if (!r.plan.ok) {
    lines.push(`  catch-up      CANNOT PLAN: ${r.plan.reason} (NEEDS RULING)`);
  } else {
    const p = r.plan;
    lines.push(
      `  paid through  ${day(p.paidThrough)}${p.paidFromInvoices ? "" : " (nothing paid: go-live)"}`,
    );
    lines.push(`  anchor        ${day(p.anchorAt)} 12:00Z · trial end ${day(p.trialEndAt)} 12:00Z`);
    lines.push(`  checkout      ${p.shape}`);
    lines.push(
      `  catch-up line "${p.stub.label}" = ${money(p.stub.totalCents)}  (${day(p.stub.from)} -> ${day(p.stub.to)})`,
    );
    for (const l of p.stub.lines)
      lines.push(`                  ${l.kind === "PLAN" ? "plan" : l.code}  ${money(l.cents)}`);
    lines.push(`  void on paid  ${p.voidInvoiceIds.length} OPEN RfInvoice(s)`);
    for (const n of p.notes) lines.push(`  note          ${n}`);
  }
  lines.push(`  verdict       ${r.eligible ? "ELIGIBLE" : `refused: ${r.ineligible.join(", ")}`}`);
  return lines;
}

/** The census: totals first, then one block per tenant. */
function formatCensus(c) {
  const k = c.counts;
  const lines = [
    `census: ${k.total} active production tenant(s) · ${k.planned} planned · ${k.failed} failed`,
    `  eligible ${k.eligible} · trial+one-time ${k.trialOneTime} · prepaid trial ${k.trial} · anchor-no-line ${k.anchorNoLine} · needs ruling ${k.needsRuling}`,
    `  with a Stripe subscription ${k.withStripeSubscription} · neither manual nor Stripe ${k.neitherManualNorStripe} · claim held ${k.claimHeld}`,
  ];
  if (k.withStripeSubscription > 0) {
    lines.push(
      "  NEEDS RULING: tenants with a stripeSubId are refused by the catch-up (census first).",
    );
  }
  for (const t of c.tenants) lines.push("", ...formatTenantReport(t));
  for (const id of c.failed) lines.push("", `tenant ${id}\n  could not be planned`);
  return lines;
}

/** Load the protected-tenant guard (#3344) if it has landed; null when absent (=> live tenants refused). */
function loadProtectedGuard(dir) {
  try {
    const live = require(`${dir}/live-target-guard.cjs`);
    const slugs = require(`${dir}/protected-slugs.cjs`);
    if (
      typeof live.assertWritableTenant !== "function" ||
      typeof live.confirmProtectedOverride !== "function" ||
      typeof slugs.loadProtectedSlugs !== "function"
    ) {
      return null;
    }
    return { live, slugs };
  } catch (_e) {
    return null;
  }
}

/**
 * The protected-tenant guard (#3344, on master since Train 2): loadProtectedSlugs / assertWritableTenant /
 * confirmProtectedOverride. Throws to refuse. No slug is ever put in a message.
 */
async function checkProtectedTenant({ guard, report, slug, env, argv, stdin, stdout, ask }) {
  const tenant = {
    id: report.tenantId,
    slug,
    status: report.tenantStatus,
    class: report.tenantClass,
    deletedAt: null,
  };
  const sub = {
    planKey: report.planKey,
    stripeSubId: report.hasStripeSubscription ? "present" : null,
    // The guard REQUIRES the flag when a plan is set. The report does not carry it, so assume the conservative
    // side: not coupon-unbilled = paying = protected (a coupon tenant is also protected via its Stripe link).
    couponFull: false,
  };
  const slugs = guard.slugs.loadProtectedSlugs(env, null);
  try {
    guard.live.assertWritableTenant(tenant, sub, slugs, {});
    return { protectedArm: null };
  } catch (err) {
    if (err && err.name !== "ProtectedTenantError") throw err;
  }
  const token = await guard.live.confirmProtectedOverride({
    tenantId: report.tenantId,
    argv,
    stdin,
    stdout,
    ask,
  });
  const arm = guard.live.assertWritableTenant(tenant, sub, slugs, { allowProtected: token });
  return { protectedArm: arm };
}

/**
 * Every --apply precondition. Returns { ok: true } or { ok: false, why } - the first failure wins and NOTHING
 * has been sent to the API at that point.
 * @param {object} p
 * @param {object} p.args parseArgs().args
 * @param {object} p.report the dry-run report of the named tenant (the API's JSON)
 * @param {NodeJS.ReadStream} p.stdin
 * @param {NodeJS.WriteStream} p.stdout
 * @param {(q: string) => Promise<string>} p.ask reads one typed line
 * @param {{live: object, slugs: object} | null} p.guard from loadProtectedGuard
 * @param {Record<string, string|undefined>} p.env
 * @param {string[]} p.argv the raw argv (the guard reads --allow-protected / --backup-taken from it)
 */
async function applyGate(p) {
  const { args, report, stdin, stdout, ask, guard, env, argv } = p;
  const refuse = (why) => ({ ok: false, why });
  if (!args.apply) return refuse("not an --apply run");
  if (args.all || !args.tenant)
    return refuse("--apply is per tenant: name one with --tenant <slug>");
  if (!report || !report.tenantId) return refuse("no dry-run report for the tenant");
  if (!report.eligible) {
    return refuse(
      `the tenant is not eligible (${(report.ineligible || []).join(", ") || "unknown"})`,
    );
  }
  if (!args.backupTaken) return refuse("--backup-taken is required (take a fresh backup first)");
  if (!(stdin && stdin.isTTY && stdout && stdout.isTTY)) {
    return refuse("the confirmation needs a real terminal on stdin and stdout");
  }
  const typed = await ask("Type the tenant slug to confirm the catch-up checkout: ");
  if (String(typed).trim() !== args.tenant) return refuse("the typed slug did not match");

  if (!isTestTenant(args.tenant)) {
    if (!args.liveOverride) {
      return refuse("a non-test tenant needs --live-tenant-override");
    }
    if (!guard) {
      return refuse(
        "the protected-tenant guard (#3344) is not present: live tenants are refused until it lands",
      );
    }
    try {
      await checkProtectedTenant({
        guard,
        report,
        slug: args.tenant,
        env,
        argv,
        stdin,
        stdout,
        ask,
      });
    } catch (e) {
      return refuse(`protected-tenant guard: ${e && e.message ? e.message : "refused"}`);
    }
  }
  return { ok: true };
}

module.exports = {
  parseArgs,
  money,
  formatTenantReport,
  formatCensus,
  loadProtectedGuard,
  checkProtectedTenant,
  applyGate,
};
