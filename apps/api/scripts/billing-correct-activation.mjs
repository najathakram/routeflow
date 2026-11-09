#!/usr/bin/env node
// SA-733r11 + r12 (row 385), SA-1122 (i) / D14 - correct a manual activation that recorded a payment that never
// happened, and/or set the operator's billing start, BEFORE the tenant's catch-up is planned. APPEND-ONLY on the
// server: up to three kinds of AuditLog marker rows, never an edit or a delete (the original activation marker and
// trail row stay as written):
//
//   --void-coverage <markerId>     that activation's window is NOT paid coverage
//   --restore-coverage <markerId>  undo a void (the latest of the two wins)
//   --billing-start 2026-10-01     the catch-up floor: an anchor 1st (12:00Z) not before go-live
//
// This script is an HTTP CLIENT of the platform-admin catch-up correction routes (the same shape as
// billing-catchup.mjs): it has no database client and writes no row. The SERVER (CatchupCorrectionService) is the one
// writer, prices every number with the catch-up's own planner, and holds the Tenant row lock for the write. It changes
// what the NEXT catch-up computes. Nothing is charged, Stripe is never called, no invoice is touched.
//
// DRY-RUN IS THE DEFAULT. It reads, prints, and writes nothing: the tenant id (never a name), the activation markers
// and their windows, and floor / paid-through / the catch-up line BEFORE vs AFTER, printed from the server's preview.
//
//   API_URL=https://<api>/api/v1 SUPER_ADMIN_USERNAME=... SUPER_ADMIN_PASSWORD=... \
//     node apps/api/scripts/billing-correct-activation.mjs --tenant <slug> --void-coverage <markerId> --billing-start 2026-10-01
//   node apps/api/scripts/billing-correct-activation.mjs --local --tenant <slug> ...    # refuses a non-local API_URL
//   node apps/api/scripts/billing-correct-activation.mjs --self-test
//
// --apply sends the change with the BEFORE amount the preview printed (a different server amount is 409
// CATCHUP_PREVIEW_STALE, nothing written). It keeps this tool's own gates (lib/billing-correct-activation-core.cjs):
// no held catch-up claim, --backup-taken, --owner-approved (the approval time is recorded on every row), a real
// terminal, the tenant slug typed back, and for a non-test tenant --live-tenant-override plus the protected-tenant guard.
// Exit: 0 printed / applied . 1 refused (nothing written) . 2 environment / connection error.
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findTenantBySlug, loginAsSuperAdmin, resolveApiBase } from "./lib/platform-admin-http.mjs";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const core = require("./lib/billing-correct-activation-core.cjs");

const TAG = "billing-correct-activation";
const DEFAULT_REASON = "operator correction (billing-correct-activation)";
const refuse = (msg) => Object.assign(new Error(msg), { refuse: true });

function askLine(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) =>
    rl.question(q, (a) => {
      rl.close();
      r(a);
    }),
  );
}

async function api(base, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = json?.message?.message ?? json?.message ?? text ?? res.statusText;
    const err = new Error(
      `${method} ${path} -> ${res.status}: ${Array.isArray(message) ? message.join("; ") : message}`,
    );
    err.status = res.status;
    err.code = json?.code ?? json?.message?.code ?? null;
    throw err;
  }
  return json;
}

/** `--local`: the API must be on this machine. */
function assertLocalBase(base) {
  const host = new URL(base).hostname;
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
    throw refuse(`--local refuses a non-local API (${host})`);
  }
}

/** The change the flags ask for, as the routes take it. */
const changeBody = (args) => ({
  ...(args.voidCoverage.length ? { voidCoverage: args.voidCoverage } : {}),
  ...(args.restoreCoverage.length ? { restoreCoverage: args.restoreCoverage } : {}),
  ...(args.billingStart ? { billingStart: args.billingStart } : {}),
});

/** The server's summary -> the shape `core.formatDryRun` prints (s / a: the catch-up line's span). */
const asState = (s) =>
  s
    ? {
        floor: s.floor,
        paidThrough: s.paidThrough,
        s: s.from,
        a: s.to,
        stubCents: s.stubCents,
        voidInvoiceIds: s.voidInvoiceIds,
      }
    : null;

/** The dry-run report: the server's preview plus the plan's facts the protected-tenant guard reads. */
function toReport(preview, plan) {
  core.assertMarkersVersion({ CATCHUP_MARKERS_VERSION: preview.markersVersion });
  return {
    tenantId: preview.tenantId,
    tenantClass: plan.tenantClass,
    tenantStatus: plan.tenantStatus,
    planKey: plan.planKey,
    stripeSubId: plan.hasStripeSubscription ? "present" : null,
    claimState: preview.claimState ?? null,
    markers: preview.markers.map((m) => ({
      id: m.id,
      action: m.action,
      periodStart: m.periodStart,
      periodEnd: m.periodEnd,
      voided: m.state === "voided",
      restoredAfter: m.stateBefore === "voided" && m.state !== "voided",
    })),
    before: asState(preview.before),
    after: asState(preview.after),
    notes: preview.notes ?? [],
  };
}

async function run(args) {
  const base = resolveApiBase();
  if (args.local) assertLocalBase(base);
  const token = await loginAsSuperAdmin(base);
  const tenant = await findTenantBySlug(base, token, args.tenant);
  const path = `/platform-admin/tenants/${tenant.id}/billing`;
  const plan = await api(base, "GET", `${path}/catchup-plan`, { token });
  const preview = await api(base, "POST", `${path}/catchup-corrections/preview`, {
    token,
    body: changeBody(args),
  });
  const report = toReport(preview, plan);
  console.log(`${TAG}: ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log(args.json ? JSON.stringify(report, null, 2) : core.formatDryRun(report).join("\n"));
  for (const n of report.notes) console.log(`  note          ${n}`);
  if (!args.apply) return 0;

  const gate = await core.applyGate({
    args,
    report,
    stdin: process.stdin,
    stdout: process.stdout,
    ask: askLine,
    guard: core.loadProtectedGuard(resolve(HERE, "lib")),
    env: process.env,
    argv: process.argv.slice(2),
  });
  if (!gate.ok) throw refuse(gate.why);

  const out = await api(base, "POST", `${path}/catchup-corrections`, {
    token,
    body: {
      ...changeBody(args),
      reason: args.reason ?? DEFAULT_REASON,
      expectedBefore: preview.before ? preview.before.stubCents : null,
      confirmTenantName: tenant.name,
    },
  });
  console.log(`${TAG}: appended ${out.appended.length} marker row(s): ${out.appended.join(", ")}`);
  console.log("Nothing was charged and Stripe was not called. Run the catch-up dry-run next.");
  return 0;
}

/** --self-test: the pure core, no database, no network. */
function selfTest() {
  let failed = 0;
  let n = 0;
  const ok = (name, cond) => {
    n += 1;
    if (!cond) failed += 1;
    console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
  };
  const bs = (v) => core.validateBillingStart(v);
  ok(
    "2026-10-01 is the go-live 1st at 12:00Z",
    bs("2026-10-01").billingStart?.toISOString() === "2026-10-01T12:00:00.000Z",
  );
  ok("a mid-month day is refused", bs("2026-10-15").ok === false);
  ok("before go-live is refused", bs("2026-09-01").ok === false);
  ok("the 00:00Z spelling is refused, never snapped", bs("2026-10-01T00:00:00Z").ok === false);
  ok("not a date is refused", bs("soon").ok === false);
  const p = core.parseArgs([
    "--tenant",
    "qa-acme",
    "--void-coverage",
    "m1",
    "--billing-start",
    "2026-10-01",
  ]);
  ok(
    "a dry-run parses (apply false)",
    p.ok && p.args.apply === false && p.args.voidCoverage[0] === "m1",
  );
  ok("no action is refused", core.parseArgs(["--tenant", "qa-acme"]).ok === false);
  ok(
    "void + restore of one marker is refused",
    core.parseArgs(["--tenant", "t", "--void-coverage", "m", "--restore-coverage", "m"]).ok ===
      false,
  );
  ok(
    "the change body carries only what was asked",
    JSON.stringify(changeBody(p.args)) ===
      JSON.stringify({ voidCoverage: ["m1"], billingStart: p.args.billingStart }),
  );
  const text = core
    .formatDryRun({
      tenantId: "11111111-1111-4111-8111-111111111111",
      claimState: null,
      markers: [],
      before: null,
      after: null,
    })
    .join("\n");
  ok(
    "the dry-run prints the tenant id and says nothing is written",
    /11111111/.test(text) && /nothing is written/i.test(text),
  );
  console.log(failed ? `${TAG} self-test: ${failed} FAILED` : `${TAG} self-test: all ${n} passed`);
  return failed ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = core.parseArgs(argv);
  if (!parsed.ok) {
    console.error(`${TAG}: ${parsed.error}`);
    return 1;
  }
  const { args } = parsed;
  if (args.selfTest) return selfTest();
  if (args.help) {
    console.log("see the header of apps/api/scripts/billing-correct-activation.mjs");
    return 0;
  }
  try {
    return await run(args);
  } catch (e) {
    if (e && e.refuse) {
      console.error(`${TAG}: refused: ${e.message}`);
      return 1;
    }
    // a server refusal (4xx) wrote nothing: exit 1; an environment, login or server error: exit 2
    if (e && e.status && e.status < 500) {
      console.error(`${TAG}: the server refused: ${e.message}${e.code ? ` [${e.code}]` : ""}`);
      return 1;
    }
    console.error(`${TAG}: ${e && e.message ? e.message : e}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
