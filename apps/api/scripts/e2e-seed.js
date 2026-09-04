/**
 * e2e-seed.js
 *
 * Idempotent seed for Playwright E2E tests.
 * Creates the `e2e-routeflow` tenant with:
 *   • Operator:            admin / Admin@123
 *   • Customer:            harbor_cafe / Customer1!
 *   • Tenant admin:        e2e_admin / TenantAdmin1!
 *   • Sessions operator:   e2e_sessions_op / Sessions1! (dedicated — spec 32, L-050)
 *
 * Safe to run multiple times — skips creation if data already exists. On an
 * existing tenant it also sweeps stale parked SaleDrafts the web e2e suite
 * left in the operator's dock (see 08-create-order-escape.spec.ts).
 *
 * Usage (from repo root):
 *   Local:   node apps/api/scripts/e2e-seed.js
 *   Railway: DATABASE_URL="postgresql://..." node apps/api/scripts/e2e-seed.js
 */

const { PrismaClient } = require("../../../node_modules/@prisma/client");
const { PrismaPg } = require("../../../node_modules/@prisma/adapter-pg");
const { Pool } = require("../../../node_modules/pg");
const bcrypt = require("../../../node_modules/bcrypt");
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const dbUrl = process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/routeflow_dev";

const pool = new Pool({ connectionString: dbUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const TENANT_SLUG = assertTestTenant("e2e-routeflow", "e2e-seed");
const OPERATOR_USERNAME = "admin";
const OPERATOR_PASSWORD = "Admin@123";
const CUSTOMER_USERNAME = "harbor_cafe";
const CUSTOMER_PASSWORD = "Customer1!";
const TENANT_ADMIN_USERNAME = "e2e_admin";
const TENANT_ADMIN_PASSWORD = "TenantAdmin1!";
// Dedicated identity for the spec that revokes /auth/sessions rows server-side (L-050,
// #598) — never the shared OPERATOR_USERNAME/TENANT_ADMIN_USERNAME above, which every
// storageState: operator.json project also loads.
const SESSIONS_OP_USERNAME = "e2e_sessions_op";
const SESSIONS_OP_PASSWORD = "Sessions1!";
// Feature addons the web e2e suite depends on. developer_mode no longer
// unlocks the GA delivery features in client UI (owner decision 2026-08-28) —
// the web e2e suite exercises /routes and /deliveries, which now need the
// real feature addons (recurring_routes, order_delivery). developer_mode
// itself stays active for the mobile driver-app surface, and the dispatch API
// still accepts it as an any-of key.
const DEVELOPER_MODE_ADDON = "developer_mode";
const RECURRING_ROUTES_ADDON = "recurring_routes";
const ORDER_DELIVERY_ADDON = "order_delivery";

// Idempotent upsert of an ACTIVE TenantAddon row for the given addon key. Row
// shape matches what AddonService.hasAddon/getActiveAddons match on (see
// apps/api/src/billing/addon.service.ts): stripePriceId/stripeItemId stay
// null — these are free, non-Stripe addons. `update: { active: true }` (not
// `{}`) because the e2e canary must be deterministic, unlike the demo tenant.
async function ensureAddon(tenantId, addonKey) {
  await prisma.tenantAddon.upsert({
    where: { tenantId_addonKey: { tenantId, addonKey } },
    create: {
      tenantId,
      addonKey,
      stripePriceId: null,
      stripeItemId: null,
      active: true,
    },
    update: { active: true },
  });
}

async function main() {
  const isRailway = dbUrl.includes("railway") || dbUrl.includes("rlwy");
  console.log(`\n🌱 E2E Seed — ${isRailway ? "⚠  RAILWAY" : "Local dev"}`);
  console.log(`   DB: ${dbUrl.replace(/:\/\/[^@]+@/, "://***@")}\n`);

  // ── Check if tenant already exists ──────────────────────────────────────────
  const existing = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } });
  if (existing) {
    console.log(`✓ Tenant "${TENANT_SLUG}" already exists (id: ${existing.id})`);
    console.log("  Verifying users...");

    const op = await prisma.user.findFirst({
      where: { tenantId: existing.id, username: OPERATOR_USERNAME },
    });
    const cu = await prisma.user.findFirst({
      where: { tenantId: existing.id, username: CUSTOMER_USERNAME },
    });

    if (!op) {
      const hash = await bcrypt.hash(OPERATOR_PASSWORD, 10);
      await prisma.user.create({
        data: {
          email: "admin@e2e-routeflow.test",
          username: OPERATOR_USERNAME,
          password: hash,
          role: "OPERATOR",
          status: "ACTIVE",
          forcePasswordChange: false,
          tenantId: existing.id,
        },
      });
      console.log(`  ✓ Created missing operator: ${OPERATOR_USERNAME}`);
    } else {
      console.log(`  ✓ Operator "${OPERATOR_USERNAME}" exists`);
    }

    if (!cu) {
      const hash = await bcrypt.hash(CUSTOMER_PASSWORD, 10);
      await prisma.user.create({
        data: {
          email: "harbor_cafe@e2e-routeflow.test",
          username: CUSTOMER_USERNAME,
          password: hash,
          role: "CUSTOMER",
          status: "ACTIVE",
          forcePasswordChange: false,
          tenantId: existing.id,
        },
      });
      console.log(`  ✓ Created missing customer: ${CUSTOMER_USERNAME}`);
    } else {
      console.log(`  ✓ Customer "${CUSTOMER_USERNAME}" exists`);
    }

    // ── TENANT_ADMIN (B138 e2e precondition) ────────────────────────────────────
    // platform-admin impersonate() requires an ACTIVE TENANT_ADMIN; without one the
    // e2e tenant cannot be impersonated and spec 31 skips.
    const ta = await prisma.user.findFirst({
      where: { tenantId: existing.id, username: TENANT_ADMIN_USERNAME },
    });
    if (!ta) {
      const hash = await bcrypt.hash(TENANT_ADMIN_PASSWORD, 10);
      await prisma.user.create({
        data: {
          email: "e2e_admin@e2e-routeflow.test",
          username: TENANT_ADMIN_USERNAME,
          password: hash,
          role: "TENANT_ADMIN",
          status: "ACTIVE",
          forcePasswordChange: false,
          tenantId: existing.id,
        },
      });
      console.log(`  ✓ Created missing tenant admin: ${TENANT_ADMIN_USERNAME}`);
    } else {
      console.log(`  ✓ Tenant admin "${TENANT_ADMIN_USERNAME}" exists`);
    }

    // ── SESSIONS_OP (F14 spec 32 precondition, L-050) ───────────────────────────
    // Spec 32 (active-sessions) must never consume the shared admin/operator.json
    // refresh token — it logs in fresh as its own OPERATOR and only ever revokes
    // ITS OWN sessions.
    const so = await prisma.user.findFirst({
      where: { tenantId: existing.id, username: SESSIONS_OP_USERNAME },
    });
    if (!so) {
      const hash = await bcrypt.hash(SESSIONS_OP_PASSWORD, 10);
      await prisma.user.create({
        data: {
          email: "e2e_sessions_op@e2e-routeflow.test",
          username: SESSIONS_OP_USERNAME,
          password: hash,
          role: "OPERATOR",
          status: "ACTIVE",
          forcePasswordChange: false,
          tenantId: existing.id,
        },
      });
      console.log(`  ✓ Created missing sessions-op operator: ${SESSIONS_OP_USERNAME}`);
    } else {
      console.log(`  ✓ Sessions-op operator "${SESSIONS_OP_USERNAME}" exists`);
    }

    // ── Feature addons (developer_mode + recurring_routes + order_delivery) ─────
    await ensureAddon(existing.id, DEVELOPER_MODE_ADDON);
    await ensureAddon(existing.id, RECURRING_ROUTES_ADDON);
    await ensureAddon(existing.id, ORDER_DELIVERY_ADDON);
    console.log(`  ✓ Developer mode, recurring routes, and order delivery addons active`);

    // ── Sweep stale parked drafts left by the web e2e suite ─────────────────────
    // 08-create-order-escape's ESC tests auto-park REAL drafts ("Order, <name>",
    // device "Desktop web") on this tenant; the spec now deletes its own, but runs
    // before that fix accumulated two rows per run. No seed creates SaleDrafts
    // (the draft-resume specs mock the endpoints), so every Desktop-web ORDER
    // draft owned by the e2e operator is residue — safe to delete.
    const operator =
      op ??
      (await prisma.user.findFirst({
        where: { tenantId: existing.id, username: OPERATOR_USERNAME },
      }));
    if (operator) {
      const sweep = await prisma.saleDraft.deleteMany({
        where: {
          tenantId: existing.id,
          userId: operator.id,
          kind: "ORDER",
          device: "Desktop web",
          title: { startsWith: "Order" },
        },
      });
      console.log(
        sweep.count > 0
          ? `  ✓ Swept ${sweep.count} stale parked draft(s) from the operator's dock`
          : "  ✓ No stale parked drafts to sweep",
      );
    }

    console.log("\n✅ E2E tenant ready.\n");
    return;
  }

  // ── Create tenant ────────────────────────────────────────────────────────────
  console.log(`Creating tenant "${TENANT_SLUG}"...`);

  const opHash = await bcrypt.hash(OPERATOR_PASSWORD, 10);
  const cuHash = await bcrypt.hash(CUSTOMER_PASSWORD, 10);

  const tenant = await prisma.tenant.create({
    data: {
      slug: TENANT_SLUG,
      name: "E2E Test RouteFlow",
      status: "ACTIVE",
      plan: "PROFESSIONAL",
    },
  });
  console.log(`  ✓ Tenant created (id: ${tenant.id})`);

  // Tenant config is required by some middleware
  await prisma.tenantConfig.create({
    data: {
      tenantId: tenant.id,
      businessName: "E2E Test RouteFlow",
    },
  });

  // ── Operator user ────────────────────────────────────────────────────────────
  await prisma.user.create({
    data: {
      email: "admin@e2e-routeflow.test",
      username: OPERATOR_USERNAME,
      password: opHash,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId: tenant.id,
    },
  });
  console.log(`  ✓ Operator created: ${OPERATOR_USERNAME} / ${OPERATOR_PASSWORD}`);

  // ── Customer user ────────────────────────────────────────────────────────────
  await prisma.user.create({
    data: {
      email: "harbor_cafe@e2e-routeflow.test",
      username: CUSTOMER_USERNAME,
      password: cuHash,
      role: "CUSTOMER",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId: tenant.id,
    },
  });
  console.log(`  ✓ Customer created: ${CUSTOMER_USERNAME} / ${CUSTOMER_PASSWORD}`);

  // ── Tenant admin user (B138 e2e precondition) ────────────────────────────────
  await prisma.user.create({
    data: {
      email: "e2e_admin@e2e-routeflow.test",
      username: TENANT_ADMIN_USERNAME,
      password: await bcrypt.hash(TENANT_ADMIN_PASSWORD, 10),
      role: "TENANT_ADMIN",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId: tenant.id,
    },
  });
  console.log(`  ✓ Tenant admin created: ${TENANT_ADMIN_USERNAME} / ${TENANT_ADMIN_PASSWORD}`);

  // ── Sessions operator (F14 spec 32 precondition, L-050) ─────────────────────
  await prisma.user.create({
    data: {
      email: "e2e_sessions_op@e2e-routeflow.test",
      username: SESSIONS_OP_USERNAME,
      password: await bcrypt.hash(SESSIONS_OP_PASSWORD, 10),
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId: tenant.id,
    },
  });
  console.log(
    `  ✓ Sessions-op operator created: ${SESSIONS_OP_USERNAME} / ${SESSIONS_OP_PASSWORD}`,
  );

  // ── Feature addons (developer_mode + recurring_routes + order_delivery) ───────
  await ensureAddon(tenant.id, DEVELOPER_MODE_ADDON);
  await ensureAddon(tenant.id, RECURRING_ROUTES_ADDON);
  await ensureAddon(tenant.id, ORDER_DELIVERY_ADDON);
  console.log(`  ✓ Developer mode, recurring routes, and order delivery addons active`);

  console.log("\n✅ E2E seed complete.\n");
}

main()
  .catch((e) => {
    // Print the WHOLE error: Prisma wraps connection failures in an
    // "Invalid invocation" whose .message can be empty, hiding the cause.
    console.error("\n❌ E2E seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
