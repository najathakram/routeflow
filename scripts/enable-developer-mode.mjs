#!/usr/bin/env node
/**
 * enable-developer-mode.mjs
 *
 * Rollout helper: enables the hidden `developer_mode` TenantAddon for one or
 * more tenant slugs, un-hiding the in-development dispatch/driver/route UI
 * behind `useDeveloperMode()` (web + mobile). See
 * .claude/pipeline/plans/2026-08-20-developer-mode-hide-dispatch.md.
 *
 * Test-tenant policy (CLAUDE.md "Test tenants & real-client data"): only
 * approved test tenants may be targeted by default. A LIVE tenant additionally
 * requires the explicit --live-tenant-override flag on top of the dry-run
 * default and the type-back confirmation — the same gate
 * apps/api/scripts/wipe-tenant-fresh-start.js uses. Enabling the addon for a
 * live tenant is normally done from the platform-admin UI (Tenant → Addons &
 * Features → Developer Mode); prefer that route unless scripting is required.
 *
 * The write is additive and reversible (it flips one TenantAddon row to
 * active; disable it again from the same admin screen).
 *
 * Usage (from repo root):
 *   node scripts/enable-developer-mode.mjs test e2e-routeflow            # dry run
 *   node scripts/enable-developer-mode.mjs test e2e-routeflow --execute
 *   node scripts/enable-developer-mode.mjs <live-slug> --execute --live-tenant-override
 *
 * Against production, run through Railway so DATABASE_URL comes from the
 * environment (never hardcode a connection string):
 *   railway run --service postgres node scripts/enable-developer-mode.mjs <slug> --execute --live-tenant-override
 */

import readline from "node:readline";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { isTestTenant } from "./lib/test-tenants.cjs";

const DEVELOPER_MODE_ADDON = "developer_mode";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const liveTenantOverride = args.includes("--live-tenant-override");
const slugs = args.filter((a) => !a.startsWith("--"));

if (slugs.length === 0) {
  console.error(
    "Missing tenant slug(s).\n" +
      "Usage: node scripts/enable-developer-mode.mjs <slug> [<slug> ...] [--execute] [--live-tenant-override]",
  );
  process.exit(1);
}

const liveSlugs = slugs.filter((s) => !isTestTenant(s));
if (liveSlugs.length > 0 && !liveTenantOverride) {
  console.error(
    `Test-tenant policy: ${liveSlugs.map((s) => `"${s}"`).join(", ")} ` +
      `${liveSlugs.length === 1 ? "is not an approved test tenant" : "are not approved test tenants"}.\n` +
      "Enabling an addon on a LIVE tenant requires the explicit --live-tenant-override flag\n" +
      "(and still needs --execute plus the type-back confirmation).\n" +
      "Prefer the platform-admin UI: Tenant → Addons & Features → Developer Mode.\n" +
      'See CLAUDE.md "Test tenants & real-client data (policy)".',
  );
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error(
    "DATABASE_URL is not set. Run locally with your dev .env loaded, or against\n" +
      "production via: railway run --service postgres node scripts/enable-developer-mode.mjs ...",
  );
  process.exit(1);
}

const pool = new Pool({ connectionString: dbUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Row shape mirrors AddonService (apps/api/src/billing/addon.service.ts):
 * hasAddon/getActiveAddons match on { tenantId, addonKey, active: true }.
 * stripePriceId/stripeItemId stay null — this is a free internal flag, so no
 * Stripe subscription item should ever be created for it.
 */
async function planForSlug(slug) {
  const tenant = await prisma.tenant.findUnique({ where: { slug }, select: { id: true } });
  if (!tenant) return { slug, action: "missing" };

  const existing = await prisma.tenantAddon.findUnique({
    where: { tenantId_addonKey: { tenantId: tenant.id, addonKey: DEVELOPER_MODE_ADDON } },
    select: { active: true },
  });

  if (existing?.active) return { slug, tenantId: tenant.id, action: "already-active" };
  return { slug, tenantId: tenant.id, action: existing ? "reactivate" : "create" };
}

async function applyForSlug(entry) {
  await prisma.tenantAddon.upsert({
    where: { tenantId_addonKey: { tenantId: entry.tenantId, addonKey: DEVELOPER_MODE_ADDON } },
    create: {
      tenantId: entry.tenantId,
      addonKey: DEVELOPER_MODE_ADDON,
      stripePriceId: null,
      stripeItemId: null,
      active: true,
    },
    update: { active: true },
  });
}

async function main() {
  const isRemote = /railway|rlwy/.test(dbUrl);
  console.log(
    `\n🔓 Enable developer_mode addon — ${isRemote ? "⚠  REMOTE/RAILWAY DB" : "local DB"}`,
  );
  console.log(`   DB: ${dbUrl.replace(/:\/\/[^@]+@/, "://***@")}`);
  console.log(`   Tenants: ${slugs.join(", ")}`);
  if (liveSlugs.length > 0) {
    console.log(`   ⚠  LIVE tenant(s) targeted: ${liveSlugs.join(", ")} (--live-tenant-override)`);
  }
  console.log("");

  const entries = [];
  for (const slug of slugs) entries.push(await planForSlug(slug));

  for (const e of entries) {
    const label =
      e.action === "missing"
        ? "tenant not found — will skip"
        : e.action === "already-active"
          ? "already active — no change"
          : e.action === "reactivate"
            ? "addon row exists but inactive — will activate"
            : "no addon row — will create (active)";
    console.log(`  • ${e.slug}: ${label}`);
  }

  const todo = entries.filter((e) => e.action === "create" || e.action === "reactivate");

  if (!execute) {
    console.log(
      `\nDRY RUN — nothing written. ${todo.length} tenant(s) would change.` +
        `\nRe-run with --execute${liveSlugs.length > 0 ? " --live-tenant-override" : ""} to apply.\n`,
    );
    return;
  }

  if (todo.length === 0) {
    console.log("\nNothing to change.\n");
    return;
  }

  const typeBack = todo.map((e) => e.slug).join(",");
  const answer = await confirm(
    `\nType the tenant slug${todo.length > 1 ? "s" : ""} "${typeBack}" exactly to proceed (or anything else to abort): `,
  );
  if (answer !== typeBack) {
    console.log("\nAborted.\n");
    process.exitCode = 3;
    return;
  }

  let failures = 0;
  for (const e of todo) {
    try {
      await applyForSlug(e);
      console.log(`  ✓ ${e.slug} — developer_mode active`);
    } catch (err) {
      console.error(`  ✗ ${e.slug} — ${err?.message ?? err}`);
      failures++;
    }
  }

  console.log("");
  if (failures > 0) {
    console.error(`💥 ${failures} of ${todo.length} tenant(s) failed\n`);
    process.exitCode = 1;
  } else {
    console.log(`✅ developer_mode active for ${todo.length} tenant(s).\n`);
  }
}

main()
  .catch((err) => {
    console.error("\n❌ enable-developer-mode crashed:", err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
