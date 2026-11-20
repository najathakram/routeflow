/**
 * READ-ONLY counts for B1371 (SA-1175 R1 M1, A1): what the downgrade seat cut-off did and would still do, before the
 * fix that deletes it merges.
 *
 *   --item 1  Scheduled downgrades (`downgradeEffectiveAt` in the future) whose active team is over the target plan's
 *             `seatsIncluded`, read from the version the cron would apply (the tenant's pin when it lists the plan, else
 *             the published one), and the EARLIEST such date. Merge before it, or the lead tells the owner.
 *   --item 2  Record-only (owner: "Leave them off"): past cut-offs, i.e. applied scheduled PLAN_CHANGED events with a
 *             SEAT_FREED in the same transaction (same `createdAt`), the seats freed, and the OPERATOR/DRIVER users
 *             still INACTIVE whose `updatedAt` falls within 5 minutes after it (SEAT_FREED carries no user ids).
 *   --item 3  Active SEAT_EXTRA add-ons: count, monthly amount, billing mode, and each holder's next renewal
 *             (`periodEnd`). "STRIPE, no item" holders are the ones whose seats may ride in the plan item's quantity
 *             (addon-row.ts: SEAT_EXTRA bills through the plan quantity); the database cannot see Stripe's quantity,
 *             so those are named as a category for the lead to check in Stripe.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION against production. The owner runs each, one per call:
 *
 *   railway run --service postgres node apps/api/scripts/report-b1371-seat-counts.mjs --item 1
 *   railway run --service postgres node apps/api/scripts/report-b1371-seat-counts.mjs --item 2
 *   railway run --service postgres node apps/api/scripts/report-b1371-seat-counts.mjs --item 3
 *   ... add --out <absolute path> to write the per-label rows to a file (keep it in local-assets/.../private/).
 *   node apps/api/scripts/report-b1371-seat-counts.mjs --self-test   (no database)
 *
 * WHAT IT PRINTS: aggregates only, live and approved-test tenants separately. Per-tenant rows carry anonymous labels
 * (tenant A, B, …); no slug, name or id leaves the process, on stdout or in --out.
 *
 * SAFETY: `default_transaction_read_only = on`, a statement timeout, SELECTs only. It writes nothing to the database.
 */
import { createRequire } from "module";
import { realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const NAME = "report-b1371-seat-counts";
const TEAM_ROLES = "('TENANT_ADMIN', 'OPERATOR', 'DRIVER')";
const FREED_WINDOW_MINUTES = 5;

/** Anonymous labels in first-seen order: tenant A … Z, A1 …; the ids stay in the map. */
export function labeller() {
  const label = new Map();
  return (tenantId) => {
    if (!label.has(tenantId)) {
      const n = label.size;
      label.set(
        tenantId,
        `tenant ${String.fromCharCode(65 + (n % 26))}${n >= 26 ? Math.floor(n / 26) : ""}`,
      );
    }
    return label.get(tenantId);
  };
}

/** addon-inclusion.ts addonBillingModeOf, plus whether the add-on carries its own Stripe item. */
export function seatExtraMode(row) {
  if (row.stripeSubId && !row.couponFull)
    return row.stripeItemId ? "STRIPE_ITEM" : "STRIPE_NO_ITEM";
  if (row.stripeSubId && row.couponFull) return "UNBILLED";
  if (row.externalPayment)
    return Number(row.priceSnapshot ?? 0) > 0 ? "MANUAL_PRICED" : "MANUAL_ZERO";
  return "UNBILLED";
}

const iso = (d) => (d ? new Date(d).toISOString() : null);
const money = (n) => Math.round(Number(n ?? 0) * 100) / 100;
const minIso = (xs) => xs.filter(Boolean).sort()[0] ?? null;

export function summarizeItem1(rows) {
  const lab = labeller();
  const over = rows.filter((r) => r.cap != null && r.team > r.cap);
  const detail = over.map((r) => ({
    tenant: lab(r.tenantId),
    effectiveAt: iso(r.effectiveAt),
    team: r.team,
    seatsIncluded: r.cap,
    over: r.team - r.cap,
    wouldDeactivate: r.nonAdminNotRetained,
  }));
  return {
    scheduled: rows.length,
    overSeats: detail.length,
    wouldDeactivate: detail.reduce((n, d) => n + d.wouldDeactivate, 0),
    earliestEffectiveAt: minIso(detail.map((d) => d.effectiveAt)),
    detail,
  };
}

export function summarizeItem2(rows) {
  const lab = labeller();
  const byTenant = new Map();
  for (const r of rows) {
    const t = byTenant.get(r.tenantId) ?? {
      cutoffs: 0,
      seatsFreed: 0,
      stillInactive: 0,
      last: null,
    };
    t.cutoffs += 1;
    t.seatsFreed += r.seatsFreed;
    t.stillInactive += r.stillInactive;
    t.last = [t.last, iso(r.at)].filter(Boolean).sort().pop();
    byTenant.set(r.tenantId, t);
  }
  const detail = [...byTenant].map(([id, t]) => ({ tenant: lab(id), ...t }));
  return {
    tenants: detail.length,
    cutoffs: detail.reduce((n, d) => n + d.cutoffs, 0),
    seatsFreed: detail.reduce((n, d) => n + d.seatsFreed, 0),
    stillInactive: detail.reduce((n, d) => n + d.stillInactive, 0),
    detail,
  };
}

export function summarizeItem3(rows) {
  const lab = labeller();
  const detail = rows.map((r) => ({
    tenant: lab(r.tenantId),
    mode: seatExtraMode(r),
    quantity: r.quantity,
    monthly: money(Number(r.priceSnapshot ?? 0) * (r.quantity ?? 1)),
    isComp: !!r.isComp,
    nextRenewal: iso(r.periodEnd),
  }));
  const byMode = {};
  for (const d of detail) byMode[d.mode] = (byMode[d.mode] ?? 0) + 1;
  return {
    holders: detail.length,
    monthly: money(detail.reduce((n, d) => n + d.monthly, 0)),
    byMode,
    maySeatsRideInPlanQuantity: byMode.STRIPE_NO_ITEM ?? 0,
    earliestRenewal: minIso(detail.filter((d) => d.monthly > 0).map((d) => d.nextRenewal)),
    detail,
  };
}

const SUMMARIZE = { 1: summarizeItem1, 2: summarizeItem2, 3: summarizeItem3 };

export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const s1 = summarizeItem1([
    {
      tenantId: "t-1",
      effectiveAt: "2026-12-01T00:00:00Z",
      team: 5,
      cap: 3,
      nonAdminNotRetained: 4,
    },
    {
      tenantId: "t-2",
      effectiveAt: "2026-11-25T00:00:00Z",
      team: 2,
      cap: 3,
      nonAdminNotRetained: 1,
    },
    {
      tenantId: "t-3",
      effectiveAt: "2026-11-22T00:00:00Z",
      team: 9,
      cap: null,
      nonAdminNotRetained: 8,
    },
  ]);
  eq([s1.scheduled, s1.overSeats, s1.wouldDeactivate], [3, 1, 4], "item 1 counts");
  eq(
    s1.earliestEffectiveAt,
    "2026-12-01T00:00:00.000Z",
    "item 1 earliest counts only the over-seat rows",
  );
  const s2 = summarizeItem2([
    { tenantId: "t-1", at: "2026-10-01T02:00:00Z", seatsFreed: 3, stillInactive: 2 },
    { tenantId: "t-1", at: "2026-11-01T02:00:00Z", seatsFreed: 1, stillInactive: 1 },
  ]);
  eq([s2.tenants, s2.cutoffs, s2.seatsFreed, s2.stillInactive], [1, 2, 4, 3], "item 2 counts");
  const s3 = summarizeItem3([
    {
      tenantId: "t-1",
      stripeSubId: "sub",
      stripeItemId: "si",
      priceSnapshot: 10,
      quantity: 2,
      periodEnd: "2026-12-05T00:00:00Z",
    },
    {
      tenantId: "t-2",
      stripeSubId: "sub",
      stripeItemId: null,
      priceSnapshot: 10,
      quantity: 1,
      periodEnd: "2026-11-28T00:00:00Z",
    },
    { tenantId: "t-3", externalPayment: true, priceSnapshot: 15, quantity: 1, periodEnd: null },
    {
      tenantId: "t-4",
      stripeSubId: "sub",
      couponFull: true,
      priceSnapshot: 0,
      quantity: 1,
      periodEnd: "2026-11-21T00:00:00Z",
    },
  ]);
  eq(
    s3.byMode,
    { STRIPE_ITEM: 1, STRIPE_NO_ITEM: 1, MANUAL_PRICED: 1, UNBILLED: 1 },
    "item 3 modes",
  );
  eq([s3.holders, s3.monthly, s3.maySeatsRideInPlanQuantity], [4, 45, 1], "item 3 totals");
  eq(s3.earliestRenewal, "2026-11-28T00:00:00.000Z", "item 3 earliest priced renewal");
  for (const s of [s1, s2, s3])
    if (/t-\d/.test(JSON.stringify(s))) throw new Error("a summary leaked a tenant id");
  return "self-test ok";
}

const ITEM_SQL = {
  1: `SELECT s."tenantId", t.slug, s."downgradeEffectiveAt" AS "effectiveAt",
             CASE WHEN dp.found THEN dp.seats ELSE dpub.seats END AS cap,
             (SELECT COUNT(*)::int FROM "User" u WHERE u."tenantId" = s."tenantId" AND u.role IN ${TEAM_ROLES}
                 AND u.status = 'ACTIVE' AND u."deletedAt" IS NULL) AS team,
             (SELECT COUNT(*)::int FROM "User" u WHERE u."tenantId" = s."tenantId" AND u.role IN ('OPERATOR', 'DRIVER')
                 AND u.status = 'ACTIVE' AND u."deletedAt" IS NULL
                 AND NOT (u.id = ANY (s."retainedUserIds"))) AS "nonAdminNotRetained"
        FROM "TenantSubscription" s
        JOIN "Tenant" t ON t.id = s."tenantId"
        LEFT JOIN LATERAL (SELECT true AS found, d."seatsIncluded" AS seats FROM "PlanDefinition" d
                            WHERE d."planVersionId" = COALESCE(s."planVersionId", t."planVersionId")
                              AND d."planKey" = s."downgradeToPlanKey" LIMIT 1) dp ON true
        LEFT JOIN LATERAL (SELECT d."seatsIncluded" AS seats FROM "PlanDefinition" d
                             JOIN "PlanVersion" v ON v.id = d."planVersionId"
                            WHERE v.status = 'PUBLISHED' AND d."planKey" = s."downgradeToPlanKey"
                            ORDER BY v.version DESC LIMIT 1) dpub ON true
       WHERE s."downgradeEffectiveAt" > now() AND s."downgradeToPlanKey" IS NOT NULL
         AND t.status = 'ACTIVE' AND t."deletedAt" IS NULL
       ORDER BY s."downgradeEffectiveAt"`,
  2: `SELECT e."tenantId", t.slug, e."createdAt" AS at,
             COALESCE(SUM((f.payload->>'quantity')::int), 0)::int AS "seatsFreed",
             (SELECT COUNT(*)::int FROM "User" u WHERE u."tenantId" = e."tenantId" AND u.role IN ('OPERATOR', 'DRIVER')
                 AND u.status = 'INACTIVE' AND u."deletedAt" IS NULL
                 AND u."updatedAt" >= e."createdAt"
                 AND u."updatedAt" < e."createdAt" + interval '${FREED_WINDOW_MINUTES} minutes') AS "stillInactive"
        FROM "BillingEvent" e
        JOIN "Tenant" t ON t.id = e."tenantId"
        JOIN "BillingEvent" f ON f."tenantId" = e."tenantId" AND f.type = 'seat.freed' AND f."createdAt" = e."createdAt"
       WHERE e.type = 'plan.changed' AND e.payload->>'scheduled' = 'true' AND e.payload->>'applied' = 'true'
       GROUP BY e.id, e."tenantId", t.slug, e."createdAt"
       ORDER BY e."createdAt"`,
  3: `SELECT a."tenantId", t.slug, a.quantity, a."priceSnapshot"::float AS "priceSnapshot", a."stripeItemId", a."isComp",
             s."stripeSubId", s."externalPayment", s."couponFull", s."periodEnd"
        FROM "TenantAddon" a
        JOIN "Tenant" t ON t.id = a."tenantId"
        LEFT JOIN "TenantSubscription" s ON s."tenantId" = a."tenantId"
       WHERE a.active = true AND COALESCE(a.sku, a."addonKey") = 'SEAT_EXTRA'
       ORDER BY s."periodEnd" NULLS LAST`,
};

function printItem(item, report) {
  for (const block of ["live", "test"]) {
    const { detail, ...agg } = report[block];
    console.log(`${block}: ${JSON.stringify(agg)}`);
  }
  console.log(
    `(item ${item}: ${report.live.detail.length + report.test.detail.length} per-label row(s); use --out to write them)`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const valueOf = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const item = Number(valueOf("--item"));
  const out = valueOf("--out");
  for (const [i, a] of argv.entries()) {
    const isValue = argv[i - 1] === "--item" || argv[i - 1] === "--out";
    if (
      (a.startsWith("--") && a !== "--item" && a !== "--out") ||
      (!a.startsWith("--") && !isValue)
    ) {
      console.error(`${NAME}: unexpected argument ${a}`);
      process.exit(2);
    }
  }
  if (![1, 2, 3].includes(item)) {
    console.error(`${NAME}: --item 1|2|3 is required (one item per call)`);
    process.exit(2);
  }
  if (argv.includes("--out") && (!out || !isAbsolute(out))) {
    console.error(`${NAME}: --out needs an absolute path`);
    process.exit(2);
  }
  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);

  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '60s'");
    await client.query("SET lock_timeout = '5s'");
    const { rows } = await client.query(ITEM_SQL[item]);
    const report = {
      at: new Date().toISOString(),
      item,
      live: SUMMARIZE[item](rows.filter((r) => !isTestTenant(r.slug))),
      test: SUMMARIZE[item](rows.filter((r) => isTestTenant(r.slug))),
    };
    printItem(item, report);
    if (out) {
      writeFileSync(out, JSON.stringify(report, null, 2));
      console.log(`per-label rows written to ${out}`);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

export function isInvokedDirectly(entry = process.argv[1], self = fileURLToPath(import.meta.url)) {
  if (!entry) return false;
  const norm = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return norm(entry) === norm(self) || basename(entry) === basename(self);
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`${NAME}: ${e.message}`);
    process.exit(1);
  });
}
