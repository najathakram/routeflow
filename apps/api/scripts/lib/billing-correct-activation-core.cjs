// SA-733r11 + r12 (row 385) - the PURE core of apps/api/scripts/billing-correct-activation.mjs: argument parsing, the
// billing-start validation, the printed (anonymised) before/after, the marker rows to append, and the --apply gate. No
// network, no database, no process.exit. Pinned by apps/api/src/billing/billing-correct-activation-tool.spec.ts.
//
// The tool APPENDS up to three kinds of AuditLog rows (never edits or deletes one):
//   TENANT_MANUAL_ACTIVATION_COVERAGE_VOID     { voidsMarkerId, reason, actor, ownerApprovedAt }
//   TENANT_MANUAL_ACTIVATION_COVERAGE_RESTORE  { restoresMarkerId, reason, actor, ownerApprovedAt }
//   TENANT_BILLING_START_OVERRIDE              { billingStart, reason, actor, ownerApprovedAt }
// They change what the NEXT catch-up computes; nothing is charged and Stripe is never called.
//
// --apply needs ALL of (any one missing = refused, exit 1, nothing written):
//   1. exactly one tenant, named with --tenant <slug>
//   2. no held catch-up claim (claimRefusal: SESSION_OPEN / AWAITING_FIRST_PAYMENT / RELEASING)
//   3. --backup-taken
//   4. --owner-approved (the owner's yes for THIS tenant; the approval time is recorded on every row)
//   5. a real terminal on stdin AND stdout
//   6. the tenant name typed back at that terminal
//   7. a non-test tenant additionally needs --live-tenant-override AND the protected-tenant guard
//      (scripts/lib/live-target-guard.cjs); a protected (paying / Stripe-linked / listed) tenant also needs the
//      guard's own override token (--allow-protected <tenantId>, typed phrase).

"use strict";

const { isTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");
const { loadProtectedGuard } = require("./billing-catchup-core.cjs");

/** Go-live: billing starts Oct 1 12:00Z (mirrors CATCHUP_GO_LIVE in catchup-plan.ts). */
const GO_LIVE_MS = Date.UTC(2026, 9, 1, 12);

const ACTIONS = {
  void: "TENANT_MANUAL_ACTIVATION_COVERAGE_VOID",
  restore: "TENANT_MANUAL_ACTIVATION_COVERAGE_RESTORE",
  billingStart: "TENANT_BILLING_START_OVERRIDE",
};

const VALUE_FLAGS = new Set([
  "--tenant",
  "--void-coverage",
  "--restore-coverage",
  "--billing-start",
  "--reason",
  "--allow-protected",
]);
const BOOL_FLAGS = new Set([
  "--apply",
  "--backup-taken",
  "--live-tenant-override",
  "--owner-approved",
  "--local",
  "--json",
  "--help",
  "--self-test",
]);

/**
 * A billing start is an ANCHOR 1st at exactly 12:00Z and not before go-live. "YYYY-MM-DD" means that day at 12:00Z;
 * a full timestamp must already be exactly 12:00:00.000Z (the legacy 00:00Z spelling is refused, never snapped).
 * @returns {{ ok: true, billingStart: Date } | { ok: false, error: string }}
 */
function validateBillingStart(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, error: "billing start is empty" };
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00.000Z`) : new Date(raw);
  if (Number.isNaN(d.getTime())) return { ok: false, error: `billing start is not a date: ${raw}` };
  if (
    d.getUTCDate() !== 1 ||
    d.getUTCHours() !== 12 ||
    d.getUTCMinutes() !== 0 ||
    d.getUTCSeconds() !== 0 ||
    d.getUTCMilliseconds() !== 0
  ) {
    return { ok: false, error: `billing start must be the 1st of a month at 12:00Z (got ${raw})` };
  }
  if (d.getTime() < GO_LIVE_MS) {
    return { ok: false, error: "billing start is before go-live (2026-10-01T12:00:00Z)" };
  }
  return { ok: true, billingStart: d };
}

/** @returns {{ ok: true, args: object } | { ok: false, error: string }} */
function parseArgs(argv) {
  const args = {
    apply: false,
    backupTaken: false,
    liveOverride: false,
    ownerApproved: false,
    local: false,
    json: false,
    help: false,
    selfTest: false,
    tenant: null,
    voidCoverage: [],
    restoreCoverage: [],
    billingStart: null,
    reason: null,
    allowProtected: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_FLAGS.has(a)) {
      if (a === "--apply") args.apply = true;
      if (a === "--backup-taken") args.backupTaken = true;
      if (a === "--live-tenant-override") args.liveOverride = true;
      if (a === "--owner-approved") args.ownerApproved = true;
      if (a === "--local") args.local = true;
      if (a === "--json") args.json = true;
      if (a === "--help") args.help = true;
      if (a === "--self-test") args.selfTest = true;
    } else if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { ok: false, error: `${a} needs a value` };
      if (a === "--tenant") args.tenant = v;
      if (a === "--void-coverage") args.voidCoverage.push(v);
      if (a === "--restore-coverage") args.restoreCoverage.push(v);
      if (a === "--reason") args.reason = v;
      if (a === "--allow-protected") args.allowProtected = v;
      if (a === "--billing-start") {
        const b = validateBillingStart(v);
        if (!b.ok) return { ok: false, error: b.error };
        args.billingStart = b.billingStart.toISOString();
      }
    } else {
      return { ok: false, error: `unknown argument: ${a}` };
    }
  }
  if (args.help || args.selfTest) return { ok: true, args };
  if (!args.tenant) return { ok: false, error: "name the tenant with --tenant <slug>" };
  if (args.voidCoverage.length + args.restoreCoverage.length === 0 && !args.billingStart) {
    return {
      ok: false,
      error: "name at least one action: --void-coverage, --restore-coverage or --billing-start",
    };
  }
  const both = args.voidCoverage.filter((m) => args.restoreCoverage.includes(m));
  if (both.length > 0) {
    return { ok: false, error: `marker ${both[0]} is both voided and restored in one run` };
  }
  return { ok: true, args };
}

/** 6776 -> "$67.76". Integer maths only. */
function money(cents) {
  if (cents == null) return "n/a";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
const day = (iso) => (iso ? String(iso).slice(0, 10) : "n/a");

function markerState(m) {
  if (m.restoredAfter) return "RESTORED (counts as paid coverage again)";
  if (m.voided) return "VOIDED (not paid coverage)";
  return "counts as paid coverage";
}

function formatState(label, s) {
  const lines = [`  ${label}`];
  if (!s) return [...lines, "    n/a (the catch-up cannot be planned)"];
  lines.push(
    `    floor ${day(s.floor)} · paid through ${day(s.paidThrough)} · S ${day(s.s)} · A ${day(s.a)}`,
  );
  lines.push(`    catch-up line ${money(s.stubCents)}`);
  const ids = s.voidInvoiceIds ?? [];
  lines.push(
    `    OPEN RfInvoices the settle would void: ${ids.length}${ids.length ? ` (${ids.join(", ")})` : ""}`,
  );
  return lines;
}

/**
 * The marker semantics version this tool expects from the COMPILED apps/api/dist/billing/catchup-markers.js
 * (CATCHUP_MARKERS_VERSION in catchup-markers.ts; a spec pins that the two numbers agree). A stale dist fails loudly.
 */
const EXPECTED_MARKERS_VERSION = 1;

function assertMarkersVersion(mod) {
  const got = mod && mod.CATCHUP_MARKERS_VERSION;
  if (got !== EXPECTED_MARKERS_VERSION) {
    throw new Error(
      `the compiled marker reader has version ${got === undefined ? "(missing)" : got}, this tool expects version ${EXPECTED_MARKERS_VERSION}: rebuild the API ("npm run build -w apps/api")`,
    );
  }
}

/** The dry-run block of one tenant. Ids and numbers only: never a name. */
function formatDryRun(r) {
  const lines = [];
  lines.push(`tenant ${r.tenantId}`);
  lines.push("  DRY-RUN: nothing is written (no change without --apply and every gate).");
  lines.push("  activation markers (the originals are never edited)");
  if (!r.markers || r.markers.length === 0) lines.push("    none");
  for (const m of r.markers ?? []) {
    lines.push(
      `    ${m.id}  ${m.action}  window ${day(m.periodStart)} -> ${day(m.periodEnd)}  ${markerState(m)}`,
    );
  }
  lines.push(
    r.pricing
      ? `  price ${money(r.pricing.cents)} (${r.pricing.source}), add-ons excluded - preview only; the catch-up dry-run is the authority`
      : "  price n/a (no override or snapshot on the subscription row), add-ons excluded - preview only; the catch-up dry-run is the authority",
  );
  lines.push(...formatState("BEFORE this change", r.before));
  lines.push(...formatState("AFTER this change", r.after));
  lines.push(
    `  claim         ${r.claimState ?? "none"}${r.claimState ? " (refused: a catch-up is in flight)" : ""}`,
  );
  lines.push(
    "  Nothing is charged by this tool; the next catch-up has its own dry-run and owner yes.",
  );
  return lines;
}

/** The AuditLog rows --apply appends (no row is edited or deleted). */
function buildMarkerRows({ args, actor, ownerApprovedAt }) {
  const reason = args.reason ?? "operator correction (billing-correct-activation)";
  const common = { reason, actor, ownerApprovedAt };
  return [
    ...args.voidCoverage.map((id) => ({
      action: ACTIONS.void,
      meta: { voidsMarkerId: id, ...common },
    })),
    ...args.restoreCoverage.map((id) => ({
      action: ACTIONS.restore,
      meta: { restoresMarkerId: id, ...common },
    })),
    ...(args.billingStart
      ? [{ action: ACTIONS.billingStart, meta: { billingStart: args.billingStart, ...common } }]
      : []),
  ];
}

/** Protected-tenant guard: returns the override token (null for an unprotected tenant); throws to refuse. */
async function checkProtectedTenant({ guard, report, slug, env, argv, stdin, stdout, ask }) {
  const tenant = {
    id: report.tenantId,
    slug,
    status: report.tenantStatus,
    class: report.tenantClass,
    deletedAt: null,
  };
  const sub = {
    planKey: report.planKey ?? null,
    stripeSubId: report.stripeSubId ?? null,
    couponFull: false,
  };
  const slugs = guard.slugs.loadProtectedSlugs(env, null);
  try {
    guard.live.assertWritableTenant(tenant, sub, slugs, {});
    return null;
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
  guard.live.assertWritableTenant(tenant, sub, slugs, { allowProtected: token });
  return token;
}

const HELD = new Set(["SESSION_OPEN", "AWAITING_FIRST_PAYMENT", "RELEASING"]);

/**
 * Every --apply precondition. Returns { ok: true, ownerApprovedAt, token } or { ok: false, why } - the first failure
 * wins and NOTHING has been written at that point.
 */
async function applyGate(p) {
  const { args, report, stdin, stdout, ask, guard, env, argv } = p;
  const refuse = (why) => ({ ok: false, why });
  if (!args.apply) return refuse("not an --apply run");
  if (!args.tenant) return refuse("--apply is per tenant: name one with --tenant <slug>");
  if (!report || !report.tenantId) return refuse("no dry-run report for the tenant");
  if (report.claimState || HELD.has(report.claimState)) {
    return refuse(
      `a catch-up claim is held (${report.claimState}): no correction while a catch-up is in flight`,
    );
  }
  if (!args.backupTaken) return refuse("--backup-taken is required (take a fresh backup first)");
  if (!args.ownerApproved) {
    return refuse("the owner's yes for this tenant is required (--owner-approved)");
  }
  if (!(stdin && stdin.isTTY && stdout && stdout.isTTY)) {
    return refuse("the confirmation needs a real terminal on stdin and stdout");
  }
  const typed = await ask("Type the tenant name to confirm the correction: ");
  if (String(typed).trim() !== args.tenant) return refuse("the typed name did not match");

  let token = null;
  if (!isTestTenant(args.tenant)) {
    if (!args.liveOverride) return refuse("a non-test tenant needs --live-tenant-override");
    if (!guard) {
      return refuse(
        "the protected-tenant guard is not present: live tenants are refused until it is",
      );
    }
    try {
      token = await checkProtectedTenant({
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
  return { ok: true, ownerApprovedAt: new Date().toISOString(), token };
}

module.exports = {
  ACTIONS,
  EXPECTED_MARKERS_VERSION,
  assertMarkersVersion,
  parseArgs,
  validateBillingStart,
  formatDryRun,
  buildMarkerRows,
  loadProtectedGuard,
  checkProtectedTenant,
  applyGate,
  money,
};
