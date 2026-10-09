// apps/api/scripts/backfill-coupon-state.mjs
//
// SA-736r: reads each Stripe-linked, card-billed subscription's coupon state from Stripe (the SAME two reads
// the webhook sync makes: retrieve with discounts expanded, then the upcoming-invoice preview) and sets
// `TenantSubscription.couponFull / couponId / couponEndsAt` for the rows that differ.
//
//   node apps/api/scripts/backfill-coupon-state.mjs                       # DRY RUN (default): counts + internal ids
//   node apps/api/scripts/backfill-coupon-state.mjs --apply --confirm-count <n>
//
// ONE WRITER: `--apply` calls `applyCouponState` from the compiled API (`dist/billing/coupon-state.js`) - there
// is no second SQL writer of those columns, so the ledger crossing (-MRR on entry, +MRR on exit, from the in-tx
// before/after) is booked by the same code path the webhooks use. Run `npm run build -w apps/api` first.
// Dry run first; the owner says yes before any --apply; --confirm-count must equal the dry run's change count.
//
// Report-only extras: subscriptions whose next invoice previews at $0 but that are NOT `couponFull` (a credit
// or balance, not a discount) are listed beside the count; they are never changed.
//
// Output carries tenant ids only - never a slug, a name or a Stripe customer.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { resolveDatabaseUrl, redactUrl, scrubSecrets } from "./lib/railway-db-url.mjs";

const SCRIPT = "backfill-coupon-state";
let databaseUrl;

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

/**
 * Pure: which rows differ from what Stripe says. `readings`: Map<tenantId, reading> where reading is
 * { kind: "state", state: { full, couponId, endsAt }, previewTotalZero } | { kind: "skipped", why }.
 */
export function planChanges(rows, readings) {
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
      changes.push({
        tenantId: row.tenantId,
        stripeSubId: row.stripeSubId,
        from: row.couponFull,
        to: reading.state.full,
        state: reading.state,
      });
    }
  }
  return { changes, skipped, zeroButNotFull };
}

/** Loads the compiled single writer and the Stripe wrapper (this .mjs cannot import the TypeScript). */
function loadDist() {
  const here = dirname(fileURLToPath(import.meta.url));
  const require = createRequire(import.meta.url);
  try {
    return {
      state: require(join(here, "..", "dist", "billing", "coupon-state.js")),
      stripeMod: require(join(here, "..", "dist", "billing", "stripe.service.js")),
      eventsMod: require(join(here, "..", "dist", "billing", "billing-event.service.js")),
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
  let confirmCount;
  try {
    confirmCount = parseConfirmCount(argv);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (apply && confirmCount === undefined) {
    console.error(`${SCRIPT}: --apply requires --confirm-count <n> (the dry run's change count).`);
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
      select: { tenantId: true, stripeSubId: true, couponFull: true, couponId: true },
    });
    const t0 = new Date();
    const readings = new Map();
    for (const row of rows) {
      readings.set(row.tenantId, await state.readCouponStateFromStripe(stripe, row.stripeSubId));
    }
    const plan = planChanges(rows, readings);
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
      console.log(`  tenant ${c.tenantId}: couponFull ${c.from} -> ${c.to}`);
    }
    for (const id of plan.zeroButNotFull)
      console.log(`  report-only: tenant ${id} previews $0, couponFull stays false`);

    if (!apply) {
      console.log(
        "\nDRY RUN - nothing written. Re-run with --apply --confirm-count " + plan.changes.length,
      );
      return;
    }
    if (confirmCount !== plan.changes.length) {
      console.error(
        `${SCRIPT}: --confirm-count ${confirmCount} does not match the current change count ${plan.changes.length} - refusing to write.`,
      );
      process.exitCode = 1;
      return;
    }
    const events = new eventsMod.BillingEventService(prisma);
    let applied = 0;
    let stale = 0;
    for (const c of plan.changes) {
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
