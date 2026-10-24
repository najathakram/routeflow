#!/usr/bin/env node
// SA-733r11 + r12 (row 385) - correct a manual activation that recorded a payment that never happened, and/or set the
// operator's billing start, BEFORE the tenant's catch-up is planned. APPEND-ONLY: it writes up to three kinds of
// AuditLog marker rows and never edits or deletes one (the original activation marker and trail row stay as written):
//
//   --void-coverage <markerId>     TENANT_MANUAL_ACTIVATION_COVERAGE_VOID    that activation's window is NOT paid
//   --restore-coverage <markerId>  TENANT_MANUAL_ACTIVATION_COVERAGE_RESTORE undo a void (the latest of the two wins)
//   --billing-start 2026-10-01     TENANT_BILLING_START_OVERRIDE             the catch-up floor: an anchor 1st (12:00Z)
//                                                                            not before go-live
//
// It changes what the NEXT catch-up computes. Nothing is charged, Stripe is never called, no invoice is touched.
//
// DRY-RUN IS THE DEFAULT. It reads, prints, and writes nothing: the tenant id (never a name), the activation markers
// and their windows, and floor / paid-through / S / A / the catch-up line BEFORE vs AFTER, plus the OPEN RfInvoices the
// eventual settle would void. The preview runs the SAME planner the catch-up uses (the compiled apps/api/dist: build
// the API first). Add-ons are not part of this preview; the catch-up's own dry-run is the authority on amounts.
//
//   railway run --service postgres node apps/api/scripts/billing-correct-activation.mjs \
//       --tenant <slug> --void-coverage <markerId> --billing-start 2026-10-01
//   <local db url in the ambient env> node apps/api/scripts/billing-correct-activation.mjs --local --tenant <slug> ...
//   node apps/api/scripts/billing-correct-activation.mjs --self-test
//
// --apply writes the rows in ONE transaction under the Tenant row lock. It needs ALL of (see
// lib/billing-correct-activation-core.cjs): no held catch-up claim, --backup-taken, --owner-approved (the owner's yes
// for THIS tenant, recorded as ownerApprovedAt on every row), a real terminal, the tenant name typed back, and for a
// non-test tenant --live-tenant-override plus the protected-tenant guard.
// Exit: 0 printed / applied . 1 refused (nothing written) . 2 environment / connection error.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { isLocalDbTarget } from "./lib/local-db-target.cjs";
import { requireLocalPgConfig } from "./lib/local-pg-config.mjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";
import guard from "./lib/live-target-guard.cjs";
import protectedSlugsLib from "./lib/protected-slugs.cjs";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const core = require("./lib/billing-correct-activation-core.cjs");
const { assertWritableTenant, ProtectedTenantError } = guard;
const { loadProtectedSlugs } = protectedSlugsLib;

const TAG = "billing-correct-activation";
const ALL_ACTIONS = [
  "TENANT_MANUAL_ACTIVATION_MARKER",
  "TENANT_SUBSCRIPTION_ACTIVATED",
  core.ACTIONS.void,
  core.ACTIONS.restore,
  core.ACTIONS.billingStart,
];
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

/** The compiled catch-up planner + marker reader (the same code the catch-up service runs). */
function loadPlanner() {
  const dist = resolve(HERE, "../dist/billing");
  try {
    const loaded = {
      plan: require(resolve(dist, "catchup-plan.js")),
      markers: require(resolve(dist, "catchup-markers.js")),
    };
    core.assertMarkersVersion(loaded.markers); // a stale dist fails loudly (N4)
    return loaded;
  } catch (e) {
    if (/marker reader has version/.test(String(e && e.message))) throw e;
    throw new Error(
      `the compiled planner is missing (${e.code ?? e.message}): run "npm run build -w apps/api" first`,
    );
  }
}

async function resolveTarget(local) {
  const url = resolveDatabaseUrl(process.env, { requireProxy: !local });
  if (local && !isLocalDbTarget(url)) {
    throw new Error(`--local refuses a non-local host (${redactUrl(url)})`);
  }
  return url;
}

async function readTenant(client, slug) {
  const t = (
    await client.query(
      `SELECT id, slug, status::text AS status, class::text AS class FROM "Tenant" WHERE slug = $1 AND "deletedAt" IS NULL`,
      [slug],
    )
  ).rows[0];
  if (!t) throw new Error("no such tenant");
  const sub = (
    await client.query(
      `SELECT "planKey", "stripeSubId", "externalPayment", "catchupState", "couponFull",
              "priceOverrideMonthly", "basePriceSnapshot"
         FROM "TenantSubscription" WHERE "tenantId" = $1`,
      [t.id],
    )
  ).rows[0];
  if (!sub) throw new Error("the tenant has no subscription row");
  const markerRows = (
    await client.query(
      `SELECT id, action, "createdAt", meta FROM "AuditLog"
        WHERE "tenantId" = $1 AND "entityType" = 'tenant' AND action = ANY($2::text[])
        ORDER BY "createdAt" ASC, id ASC`,
      [t.id, ALL_ACTIONS],
    )
  ).rows;
  const invoices = (
    await client.query(
      `SELECT id, status::text AS status, "periodStart", "periodEnd" FROM "RfInvoice"
        WHERE "tenantId" = $1 AND status::text IN ('OPEN', 'PAID')`,
      [t.id],
    )
  ).rows;
  return { tenant: t, sub, markerRows, invoices };
}

/** floor / paid-through / S / A / line / void list for a set of marker rows, through the compiled planner. */
function planState(planner, data, markerRows, now) {
  const m = planner.markers.readCatchupMarkers(
    markerRows.map((r) => ({ ...r, createdAt: new Date(r.createdAt), meta: r.meta ?? null })),
  );
  const priceDollars = Number(data.sub.priceOverrideMonthly ?? data.sub.basePriceSnapshot ?? NaN);
  const plan = planner.plan.planCatchup({
    now,
    monthly: Number.isFinite(priceDollars) ? priceDollars : null,
    addons: [],
    invoices: data.invoices.map((i) => ({
      id: i.id,
      status: i.status,
      periodStart: i.periodStart ? new Date(i.periodStart) : null,
      periodEnd: i.periodEnd ? new Date(i.periodEnd) : null,
    })),
    billingStart: m.billingStartOverride?.ok ? m.billingStartOverride.billingStart : null,
    manual: { activations: m.activations },
  });
  if (m.billingStartOverride && !m.billingStartOverride.ok) {
    return {
      state: null,
      note: `invalid billing-start override (${m.billingStartOverride.error})`,
    };
  }
  if (!plan.ok) return { state: null, note: `cannot plan: ${plan.reason}` };
  return {
    state: {
      floor: plan.floor.toISOString(),
      paidThrough: plan.paidThrough.toISOString(),
      s: plan.stub.from.toISOString(),
      a: plan.stub.to.toISOString(),
      stubCents: plan.stub.totalCents,
      voidInvoiceIds: plan.voidInvoiceIds,
    },
    note: null,
  };
}

/** The report of one run: before / after the requested change. */
function buildReport(planner, data, args, now) {
  const existingMarkers = data.markerRows.filter(
    (r) => r.action === "TENANT_MANUAL_ACTIVATION_MARKER",
  );
  const known = new Set(existingMarkers.map((r) => r.id));
  for (const id of [...args.voidCoverage, ...args.restoreCoverage]) {
    if (!known.has(id)) throw refuse(`${id} is not an activation marker of this tenant`);
  }
  // hypothetical rows: strictly later than everything that exists, so they win the "latest" rule
  const t0 =
    Math.max(now.getTime(), ...data.markerRows.map((r) => new Date(r.createdAt).getTime())) + 1000;
  const fake = core
    .buildMarkerRows({ args, actor: "preview", ownerApprovedAt: now.toISOString() })
    .map((r, i) => ({
      id: `~preview-${i}`,
      action: r.action,
      createdAt: new Date(t0 + i),
      meta: r.meta,
    }));
  const afterRows = [...data.markerRows, ...fake];
  const voidedBefore = planner.markers.voidedMarkerIds(
    data.markerRows.map((r) => ({ ...r, createdAt: new Date(r.createdAt) })),
  );
  const voidedAfter = planner.markers.voidedMarkerIds(
    afterRows.map((r) => ({ ...r, createdAt: new Date(r.createdAt) })),
  );
  const before = planState(planner, data, data.markerRows, now);
  const after = planState(planner, data, afterRows, now);
  return {
    tenantId: data.tenant.id,
    tenantClass: data.tenant.class,
    tenantStatus: data.tenant.status,
    planKey: data.sub.planKey,
    stripeSubId: data.sub.stripeSubId,
    claimState: data.sub.catchupState ?? null,
    // how the line was priced (N3): the override first, else the stored snapshot, else nothing to price with
    pricing:
      data.sub.priceOverrideMonthly != null
        ? { cents: Math.round(Number(data.sub.priceOverrideMonthly) * 100), source: "override" }
        : data.sub.basePriceSnapshot != null
          ? { cents: Math.round(Number(data.sub.basePriceSnapshot) * 100), source: "snapshot" }
          : null,
    markers: existingMarkers.map((r) => ({
      id: r.id,
      action: r.action,
      periodStart: r.meta?.periodStart ?? null,
      periodEnd: r.meta?.periodEnd ?? null,
      voided: voidedAfter.has(r.id),
      restoredAfter: voidedBefore.has(r.id) && !voidedAfter.has(r.id),
    })),
    before: before.state,
    after: after.state,
    notes: [before.note && `before: ${before.note}`, after.note && `after: ${after.note}`].filter(
      Boolean,
    ),
  };
}

async function open(args) {
  const url = await resolveTarget(args.local);
  const client = new pg.Client(args.local ? requireLocalPgConfig(url) : { connectionString: url });
  await client.connect();
  return { url, client };
}

async function dryRun(args) {
  const planner = loadPlanner();
  const { url, client } = await open(args);
  try {
    console.log(`${TAG}: target ${redactUrl(url)} DRY-RUN`);
    await client.query("BEGIN TRANSACTION READ ONLY");
    const data = await readTenant(client, args.tenant);
    await client.query("ROLLBACK");
    const report = buildReport(planner, data, args, new Date());
    console.log(args.json ? JSON.stringify(report, null, 2) : core.formatDryRun(report).join("\n"));
    for (const n of report.notes) console.log(`  note          ${n}`);
    return 0;
  } finally {
    await client.end();
  }
}

async function apply(args) {
  const planner = loadPlanner();
  const { url, client } = await open(args);
  try {
    console.log(`${TAG}: target ${redactUrl(url)} APPLY`);
    await client.query("BEGIN TRANSACTION READ ONLY");
    const data = await readTenant(client, args.tenant);
    await client.query("ROLLBACK");
    const report = buildReport(planner, data, args, new Date());
    console.log(core.formatDryRun(report).join("\n"));

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

    // The guard again, right before the write (the gate already proved the override token for a protected tenant).
    const slugs = loadProtectedSlugs(process.env, url);
    try {
      assertWritableTenant(
        {
          id: data.tenant.id,
          slug: data.tenant.slug,
          status: data.tenant.status,
          class: data.tenant.class,
          deletedAt: null,
        },
        {
          planKey: data.sub.planKey,
          stripeSubId: data.sub.stripeSubId,
          couponFull: data.sub.planKey == null ? false : data.sub.couponFull,
        },
        slugs,
        gate.token ? { allowProtected: gate.token } : {},
      );
    } catch (e) {
      if (e instanceof ProtectedTenantError) throw refuse(e.message);
      throw e;
    }

    const rows = core.buildMarkerRows({
      args,
      actor: process.env.USERNAME || process.env.USER || "operator-cli",
      ownerApprovedAt: gate.ownerApprovedAt,
    });
    await client.query("BEGIN");
    await client.query('SELECT id FROM "Tenant" WHERE id = $1 FOR UPDATE', [data.tenant.id]);
    // a claim taken since the dry-run read: refuse (claimRefusal), the markers would change a plan in flight
    const held = (
      await client.query('SELECT "catchupState" FROM "TenantSubscription" WHERE "tenantId" = $1', [
        data.tenant.id,
      ])
    ).rows[0]?.catchupState;
    if (held) throw refuse(`a catch-up claim is held (${held}): nothing written`);
    const ids = [];
    for (const r of rows) {
      const id = randomUUID();
      ids.push(id);
      await client.query(
        `INSERT INTO "AuditLog" (id, "tenantId", action, "entityType", "entityId", meta, "createdAt")
         VALUES ($1, $2, $3, 'tenant', $2, $4::jsonb, now())`,
        [id, data.tenant.id, r.action, JSON.stringify({ platformAdmin: true, ...r.meta })],
      );
    }
    await client.query("COMMIT");
    console.log(`${TAG}: appended ${ids.length} marker row(s): ${ids.join(", ")}`);
    console.log("Nothing was charged and Stripe was not called. Run the catch-up dry-run next.");
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
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
  const rows = core.buildMarkerRows({
    args: { ...p.args, restoreCoverage: ["m2"] },
    actor: "a",
    ownerApprovedAt: "2026-10-13T08:00:00.000Z",
  });
  ok(
    "three kinds of rows are appended, each with the owner's approval time",
    rows.map((r) => r.action).join() ===
      [core.ACTIONS.void, core.ACTIONS.restore, core.ACTIONS.billingStart].join() &&
      rows.every((r) => r.meta.ownerApprovedAt === "2026-10-13T08:00:00.000Z"),
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
    return args.apply ? await apply(args) : await dryRun(args);
  } catch (e) {
    if (e && e.refuse) {
      console.error(`${TAG}: refused: ${e.message}`);
      return 1;
    }
    console.error(`${TAG}: ${e && e.message ? e.message : e}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
