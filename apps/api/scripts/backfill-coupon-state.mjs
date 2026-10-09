// apps/api/scripts/backfill-coupon-state.mjs
//
// SA-736r: reads each Stripe-linked, card-billed subscription's coupon state from Stripe (the SAME two reads
// the webhook sync makes: retrieve with discounts expanded, then the upcoming-invoice preview) and sets
// `TenantSubscription.couponFull / couponId / couponEndsAt` for the rows that differ.
//
//   node apps/api/scripts/backfill-coupon-state.mjs                       # DRY RUN (default): counts, ids, +/-X
//   node apps/api/scripts/backfill-coupon-state.mjs --apply --tenants <id,id> --confirm-count <n>
//       [--live-tenant-override]   # REQUIRED when any listed tenant is not an approved test tenant (qa-*, e2e-*, ...)
//
// ONE WRITER: `--apply` calls `applyCouponState` from the compiled API (`dist/billing/coupon-state.js`) - there
// is no second SQL writer of those columns, so the ledger crossing (-MRR on entry, +MRR on exit, from the in-tx
// before/after) is booked by the same code path the webhooks use. Run `npm run build -w apps/api` first.
//
// GUARD (fail closed, in order): there is NO all-tenants apply - `--apply` needs an explicit `--tenants <ids>`
// allow-list, and every id must be in the dry run's change set. Every card-billed tenant is a Stripe-linked,
// protected row, so any tenant that is not an approved test tenant needs `--live-tenant-override` AND a TTY
// type-back of `APPLY <n> LIVE` (no TTY, no apply). `--confirm-count` must equal the number of allow-listed
// changes. The dry run shows each tenant's expected ledger move (+X/-X) before anything is written.
//
// Report-only extras: subscriptions whose next invoice previews at $0 but that are NOT `couponFull` (a credit
// or balance, not a discount) are listed beside the count; they are never changed.
//
// Output carries tenant ids only - never a slug, a name or a Stripe customer.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { resolveDatabaseUrl, redactUrl, scrubSecrets } from "./lib/railway-db-url.mjs";

const SCRIPT = "backfill-coupon-state";
let databaseUrl;
const requireCjs = createRequire(import.meta.url);

/** `--confirm-count <n>`: given at most once, a non-negative integer. */
export function parseConfirmCount(argv) {
  const idx = argv.indexOf("--confirm-count");
  if (idx === -1) return undefined;
  if (argv.indexOf("--confirm-count", idx + 1) !== -1) {
    throw new Error("--confirm-count may be given only once");
  }
  const raw = argv[idx + 1];
  if (raw === undefined || raw.startsWith("--") || !/^\d+$/.test(raw)) {
    throw new Error("--confirm-count requires a non-negative integer value");
  }
  return Number(raw);
}

/** `--tenants a,b`: given at most once; a non-empty comma list of ids. undefined when absent. */
export function parseTenantList(argv) {
  const idx = argv.indexOf("--tenants");
  if (idx === -1) return undefined;
  if (argv.indexOf("--tenants", idx + 1) !== -1)
    throw new Error("--tenants may be given only once");
  const raw = argv[idx + 1];
  if (raw === undefined || raw.startsWith("--"))
    throw new Error("--tenants requires a comma list of tenant ids");
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error("--tenants requires at least one tenant id");
  return [...new Set(ids)];
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Pure: the ledger move a change will book, from the same inputs the writer prices (base + billable add-ons
 * - discount, for an ACTIVE PRODUCTION row with a planKey): -X entering couponFull, +X leaving, else 0.
 */
export function expectedDelta(change, pricing) {
  if (!pricing || pricing.status !== "ACTIVE" || pricing.class !== "PRODUCTION" || !pricing.planKey)
    return 0;
  const contribution = round2(
    Number(pricing.basePriceSnapshot ?? 0) +
      Number(pricing.addonSum ?? 0) -
      Number(pricing.discount ?? 0),
  );
  if (change.from === change.to) return 0;
  return change.to ? -contribution : contribution;
}

/**
 * Pure: which rows differ from what Stripe says. `readings`: Map<tenantId, reading> where reading is
 * { kind: "state", state: { full, couponId, endsAt }, previewTotalZero } | { kind: "skipped", why }.
 * `pricingById` (optional): Map<tenantId, { status, class, planKey, basePriceSnapshot, discount, addonSum, live }>.
 */
export function planChanges(rows, readings, pricingById = new Map()) {
  const changes = [];
  const skipped = [];
  const zeroButNotFull = [];
  for (const row of rows) {
    const reading = readings.get(row.tenantId);
    if (!reading || reading.kind === "skipped") {
      skipped.push({ tenantId: row.tenantId, why: reading?.why ?? "unread" });
      continue;
    }
    if (reading.previewTotalZero && !reading.state.full) zeroButNotFull.push(row.tenantId);
    const differs =
      reading.state.full !== row.couponFull ||
      (reading.state.couponId ?? null) !== (row.couponId ?? null);
    if (differs) {
      const change = {
        tenantId: row.tenantId,
        stripeSubId: row.stripeSubId,
        from: row.couponFull,
        to: reading.state.full,
        state: reading.state,
      };
      const pricing = pricingById.get(row.tenantId);
      // Unknown pricing/test-ness fails CLOSED: a tenant we cannot classify is treated as live.
      change.live = pricing ? pricing.live !== false : true;
      change.delta = expectedDelta(change, pricing);
      changes.push(change);
    }
  }
  return { changes, skipped, zeroButNotFull };
}

/**
 * Pure: may this apply proceed? Returns { ok: true, selected, liveCount, phrase } or { ok: false, reason }.
 * No all-tenants apply; every id must be in the change set; live tenants need the override (and the caller then
 * needs the TTY type-back of `phrase`); the confirm count must equal the selected changes.
 */
export function checkApplyGuard({ changes, tenants, confirmCount, liveOverride }) {
  if (!tenants || tenants.length === 0) {
    return {
      ok: false,
      reason:
        "--apply requires an explicit --tenants <id,id> allow-list (there is no all-tenants apply)",
    };
  }
  const byId = new Map(changes.map((c) => [c.tenantId, c]));
  const missing = tenants.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `not in the dry run's change set (nothing to do, or unreadable): ${missing.join(", ")}`,
    };
  }
  const selected = tenants.map((id) => byId.get(id));
  if (confirmCount !== selected.length) {
    return {
      ok: false,
      reason: `--confirm-count ${confirmCount} does not match the ${selected.length} allow-listed change(s)`,
    };
  }
  const liveCount = selected.filter((c) => c.live).length;
  if (liveCount > 0 && !liveOverride) {
    return {
      ok: false,
      reason: `${liveCount} allow-listed tenant(s) are Stripe-linked and not approved test tenants: pass --live-tenant-override (and type the confirmation on a TTY)`,
    };
  }
  return {
    ok: true,
    selected,
    liveCount,
    phrase: liveCount > 0 ? `APPLY ${selected.length} LIVE` : null,
  };
}

/** Pure-ish: the TTY type-back. No TTY -> false (fail closed). `ask` is injectable for tests. */
export async function typeBack(phrase, { isTTY = process.stdin.isTTY, ask = askOnTty } = {}) {
  if (!phrase) return true;
  if (!isTTY) return false;
  return (await ask(`Type exactly "${phrase}" to continue: `)).trim() === phrase;
}

function askOnTty(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(prompt, (a) => {
      rl.close();
      resolve(a);
    }),
  );
}

/** Loads the compiled single writer and the Stripe wrapper (this .mjs cannot import the TypeScript). */
function loadDist() {
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    return {
      state: requireCjs(join(here, "..", "dist", "billing", "coupon-state.js")),
      stripeMod: requireCjs(join(here, "..", "dist", "billing", "stripe.service.js")),
      eventsMod: requireCjs(join(here, "..", "dist", "billing", "billing-event.service.js")),
    };
  } catch (e) {
    throw new Error(
      `${SCRIPT}: cannot load the compiled billing modules from apps/api/dist. Run ` +
        `\`npm run build -w apps/api\` first (${e.message})`,
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const liveOverride = argv.includes("--live-tenant-override");
  let confirmCount;
  let tenants;
  try {
    confirmCount = parseConfirmCount(argv);
    tenants = parseTenantList(argv);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (apply && (confirmCount === undefined || tenants === undefined)) {
    console.error(
      `${SCRIPT}: --apply requires --tenants <id,id> (no all-tenants apply) and --confirm-count <n>.`,
    );
    process.exit(1);
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error(
      `${SCRIPT}: STRIPE_SECRET_KEY is required (this reads Stripe; a dry run writes nothing).`,
    );
    process.exit(1);
  }
  try {
    databaseUrl = resolveDatabaseUrl(process.env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(`Resolved database host: ${redactUrl(databaseUrl)}`);
  const { isTestTenant } = requireCjs("../../../scripts/lib/test-tenants.cjs");
  const { state, stripeMod, eventsMod } = loadDist();
  const stripe = new stripeMod.StripeService({
    get: (key) => (key === "stripe" ? { secretKey: process.env.STRIPE_SECRET_KEY } : undefined),
  });
  stripe.onModuleInit();

  const pool = new Pool({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const rows = await prisma.tenantSubscription.findMany({
      where: {
        stripeSubId: { not: null },
        externalPayment: false,
        planKey: { not: null },
        tenant: { class: "PRODUCTION", deletedAt: null },
      },
      select: {
        tenantId: true,
        stripeSubId: true,
        couponFull: true,
        couponId: true,
        planKey: true,
        basePriceSnapshot: true,
        discount: true,
        tenant: { select: { status: true, class: true, slug: true } },
      },
    });
    const addonRows = await prisma.tenantAddon.findMany({
      where: { tenantId: { in: rows.map((r) => r.tenantId) }, active: true, isComp: false },
      select: { tenantId: true, priceSnapshot: true, quantity: true },
    });
    const addonSum = new Map();
    for (const a of addonRows) {
      addonSum.set(
        a.tenantId,
        (addonSum.get(a.tenantId) ?? 0) + Number(a.priceSnapshot ?? 0) * a.quantity,
      );
    }
    const pricingById = new Map(
      rows.map((r) => [
        r.tenantId,
        {
          status: r.tenant.status,
          class: r.tenant.class,
          planKey: r.planKey,
          basePriceSnapshot: r.basePriceSnapshot,
          discount: r.discount,
          addonSum: addonSum.get(r.tenantId) ?? 0,
          // the slug decides in memory only and is never printed
          live: !isTestTenant(r.tenant.slug),
        },
      ]),
    );
    const t0 = await state.dbClock(prisma);
    const readings = new Map();
    for (const row of rows) {
      readings.set(row.tenantId, await state.readCouponStateFromStripe(stripe, row.stripeSubId));
    }
    const plan = planChanges(rows, readings, pricingById);
    const entering = plan.changes.filter((c) => c.to && !c.from).length;
    const leaving = plan.changes.filter((c) => !c.to && c.from).length;
    console.log(`Card-billed Stripe subscriptions read: ${rows.length}`);
    console.log(
      `Would change: ${plan.changes.length} (entering couponFull: ${entering}, leaving: ${leaving})`,
    );
    console.log(`Skipped (ended / no upcoming invoice): ${plan.skipped.length}`);
    console.log(
      `Report-only - next invoice previews $0 but NOT couponFull: ${plan.zeroButNotFull.length}`,
    );
    for (const c of plan.changes) {
      const sign = c.delta > 0 ? "+" : "";
      console.log(
        `  tenant ${c.tenantId}: couponFull ${c.from} -> ${c.to}, ledger ${sign}${c.delta} (${c.live ? "LIVE" : "test"})`,
      );
    }
    for (const id of plan.zeroButNotFull)
      console.log(`  report-only: tenant ${id} previews $0, couponFull stays false`);

    if (!apply) {
      console.log(
        `\nDRY RUN - nothing written. To apply: --apply --tenants <ids from above> --confirm-count <n>` +
          ` (+ --live-tenant-override and a TTY type-back for LIVE rows).`,
      );
      return;
    }
    const guard = checkApplyGuard({ changes: plan.changes, tenants, confirmCount, liveOverride });
    if (!guard.ok) {
      console.error(`${SCRIPT}: refusing to write - ${guard.reason}`);
      process.exitCode = 1;
      return;
    }
    if (!(await typeBack(guard.phrase))) {
      console.error(
        `${SCRIPT}: refusing to write - the type-back did not match (or there is no TTY).`,
      );
      process.exitCode = 1;
      return;
    }
    const events = new eventsMod.BillingEventService(prisma);
    let applied = 0;
    let stale = 0;
    for (const c of guard.selected) {
      const r = await state.applyCouponState({ prisma, events }, c.tenantId, c.state, {
        reason: "backfill",
        syncedAt: t0,
        onlyStripeSubId: c.stripeSubId,
      });
      if (r.applied) applied++;
      else stale++;
    }
    console.log(
      `Applied ${applied} change(s); ${stale} stale (a webhook sync was newer) - rerun to pick up.`,
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    const msg = err?.message ?? String(err);
    console.error(databaseUrl ? scrubSecrets(msg, databaseUrl) : msg);
    process.exit(1);
  });
}
