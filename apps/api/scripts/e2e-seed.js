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
 *   Local:                  node apps/api/scripts/e2e-seed.js
 *   Railway (explicit URL): DATABASE_URL="postgresql://..." node apps/api/scripts/e2e-seed.js
 *   Railway (via runner):   railway run --service postgres node apps/api/scripts/e2e-seed.js
 *     (that service exposes only POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB/
 *     RAILWAY_TCP_PROXY_DOMAIN/RAILWAY_TCP_PROXY_PORT, no DATABASE_URL — the target is
 *     resolved from those via scripts/lib/railway-db-url.mjs, same helper prod-migrate.mjs
 *     and schema-drift.mjs use. The resolved host is always logged before connecting,
 *     the password never is; a run with neither DATABASE_URL nor the POSTGRES_* vars
 *     loudly falls back to the local default instead of silently targeting it.)
 *   Dry check (no connection): railway run --service postgres node apps/api/scripts/e2e-seed.js --print-target
 *     (prints the resolved target host/fallback line, then exits 0 before opening any
 *     Pool/PrismaClient connection — run this first to confirm where a real reseed would land.)
 */

const { PrismaClient } = require("../../../node_modules/@prisma/client");
const { PrismaPg } = require("../../../node_modules/@prisma/adapter-pg");
const { Pool } = require("../../../node_modules/pg");
const bcrypt = require("../../../node_modules/bcrypt");
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const LOCAL_DEFAULT_DB_URL = "postgresql://user:pass@localhost:5432/routeflow_dev";

// Resolves the seed's DB target the same way prod-migrate.mjs/schema-drift.mjs do (Railway
// proxy vars win over DATABASE_URL, since under `railway run` DATABASE_URL is the unreachable
// *.railway.internal host) — imported dynamically because the shared helper is an ESM module
// (`.mjs`) and CI still runs this script under Node 20, which cannot `require()` ESM.
async function resolveTargetDbUrl() {
  const { resolveDatabaseUrl } = await import("./lib/railway-db-url.mjs");
  try {
    return resolveDatabaseUrl(process.env, { requireProxy: false });
  } catch {
    console.log("e2e-seed: DATABASE_URL not set and no POSTGRES_* vars — using the local default");
    return LOCAL_DEFAULT_DB_URL;
  }
}

let dbUrl;
let pool;
let adapter;
let prisma;

// Resolves the DB target and logs it — host/port/db only, never the password — before
// opening any connection, then wires up the Prisma client used by the rest of the script.
async function bootstrap() {
  dbUrl = await resolveTargetDbUrl();
  const target = new URL(dbUrl);
  console.log(
    `e2e-seed: target host = ${target.hostname}:${target.port || "5432"}${target.pathname}`,
  );
  // --print-target: a dry check that only resolves and prints where a real reseed would
  // land — exit before opening any connection (no Pool, no PrismaClient). Lets a human/CI
  // confirm the target host against a live DB without ever touching it.
  if (process.argv.includes("--print-target")) {
    process.exit(0);
  }
  pool = new Pool({ connectionString: dbUrl });
  adapter = new PrismaPg(pool);
  prisma = new PrismaClient({ adapter });
}

const TENANT_SLUG = assertTestTenant("e2e-routeflow", "e2e-seed");
// B449 fix-round finding 3: a real, standing LITE-plan tenant for
// 48-lite-locked-route-ux.spec.ts (and any future LITE-plan spec) — same
// operator credentials as e2e-routeflow (usernames are per-tenant, disambiguated
// by the x-tenant-slug header/cookie the login flow already sets), so the SAME
// loginAsOperator() helper works unmodified against either tenant.
const LITE_TENANT_SLUG = assertTestTenant("qa-lite", "e2e-seed");
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
// REG-B91 (34-calendar-dates.spec.ts) needs one active TrackedCategory with
// requiresLicense: true to build its customer-authorization fixture; without one the
// spec self-skips ("No tracked category requires a license on this tenant") rather than
// failing on an unrelated seed gap. Every other field is left at its schema default.
const LICENSED_TRACKED_CATEGORY_NAME = "E2E Regulated License Category";

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

// Idempotent upsert of the one tracked category REG-B91 needs (TrackedCategory has a
// @@unique([tenantId, name]) constraint). `update: { requiresLicense: true, active: true }`
// (not `{}`) for the same determinism reason ensureAddon's update clause gives.
async function ensureLicensedTrackedCategory(tenantId) {
  await prisma.trackedCategory.upsert({
    where: { tenantId_name: { tenantId, name: LICENSED_TRACKED_CATEGORY_NAME } },
    create: {
      tenantId,
      name: LICENSED_TRACKED_CATEGORY_NAME,
      requiresLicense: true,
      active: true,
    },
    update: { requiresLicense: true, active: true },
  });
}

// B566 — the commerce rows the web e2e specs read off a FRESH database. Before this the tenant
// had users and addons but no customers or products, so on a clean `local:reset` + seed the
// customer picker, the product table and the boxed-line discovery were all empty and six specs
// (06 CP-09, 08 ESC-01/ESC-02, 13 BOXED-01, 21 REG-B130/REG-B154) failed — passing only later
// as a side effect of earlier specs creating rows. Idempotent (find-or-create on a stable key;
// nothing is overwritten), fixture-prefixed so it never collides with a spec's own throwaways.
// Business names contain an "e": 08/13 open the builder and type "e" into the customer picker.
const FIXTURE_CUSTOMERS = [
  { username: "e2e_fixture_cust_1", businessName: "E2E Fixture Cafe One" },
  { username: "e2e_fixture_cust_2", businessName: "E2E Fixture Market Two" },
  { username: "e2e_fixture_cust_3", businessName: "E2E Fixture Deli Three" },
];
// One boxed product (13 BOXED-01 discovers it by probing the product search — its name carries
// "case" — and reads box price / pack size off the row) plus two plain ones, so the products
// table has >= 3 selectable rows (21 REG-B154 selects up to 3, then 2) and CP-09 has price cells.
// Money as integer cents -> "d.cc" strings: the product prices AND the invoice/order figures are
// all derived from these, never re-typed as independent literals that could drift apart.
const cents = (n) => (n / 100).toFixed(2);
const BOX_PRICE_CENTS = 2400;
const WIDGET_A_CENTS = 450;
const WIDGET_B_CENTS = 725;
const ORDER_QTY = 2;

const FIXTURE_PRODUCTS = [
  {
    sku: "E2E-FIX-001",
    name: "E2E Fixture Widget A",
    unit: "each",
    pricePerUnit: cents(WIDGET_A_CENTS),
  },
  {
    sku: "E2E-FIX-002",
    name: "E2E Fixture Widget B",
    unit: "each",
    pricePerUnit: cents(WIDGET_B_CENTS),
  },
  {
    sku: "E2E-FIX-BOX",
    name: "E2E Fixture Boxed Case",
    unit: "box",
    pricePerUnit: cents(BOX_PRICE_CENTS),
    unitsPerBox: 12,
  },
];

const FIXTURE_INVOICE_NUMBER = "E2E-FIX-INV-001";
// One PENDING order with one line on the first plain fixture product: 06 CP-02/CP-06 read real
// order rows off a fresh DB, and 21 REG-B24 needs an ACTIVE order item against a catalog product
// to prove the bulk-delete skip-guard. Found by a stable idempotencyKey — NOT by number: the app
// generates the next order number as (lexicographically-highest "ORD-…") + 1
// (orders.service.ts), so a fixed high literal like ORD-900001 would skew that tenant's sequence
// forever. The fixture takes the NEXT number in sequence exactly as a real order would, and
// "ORD-<digits>" is also the shape 06 CP-06 finds the row by.
const FIXTURE_ORDER_KEY = "e2e-fixture-order";

// The API's customer soft-delete (customers.service.ts, REG-B159) RELEASES the User's identity:
// username -> "<username>~removed~<id8>", email -> "removed+<id>@placeholder.local", deletedAt set.
// So a fixture user that was soft-deleted no longer matches its exact username — match the
// tombstone prefix too, and put the identity back.
const TOMBSTONE = "~removed~";

async function ensureFixtureUser(tenantId, c) {
  const email = `${c.username}@e2e-routeflow.test`;
  let user = await prisma.user.findFirst({ where: { tenantId, username: c.username } });
  if (!user) {
    const tomb = await prisma.user.findFirst({
      where: { tenantId, username: { startsWith: `${c.username}${TOMBSTONE}` } },
      orderBy: { createdAt: "asc" },
    });
    if (tomb) {
      user = await prisma.user.update({
        where: { id: tomb.id },
        data: { username: c.username, email, deletedAt: null },
      });
    }
  }
  if (!user) {
    // Composite-unique upsert (not find-then-create): the DB lane runs specs in parallel.
    user = await prisma.user.upsert({
      where: { tenantId_username: { tenantId, username: c.username } },
      create: {
        email,
        username: c.username,
        // Never a login identity — a random hash nobody holds.
        password: await bcrypt.hash(require("crypto").randomBytes(16).toString("hex"), 10),
        role: "CUSTOMER",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
      },
      update: {},
    });
  } else if (user.deletedAt) {
    user = await prisma.user.update({ where: { id: user.id }, data: { deletedAt: null } });
  }
  return user;
}

async function ensureCommerceFixtures(tenantId) {
  const customers = [];
  for (const c of FIXTURE_CUSTOMERS) {
    const user = await ensureFixtureUser(tenantId, c);
    // userId is @unique -> a safe upsert; `update` un-deletes a soft-deleted customer (a spec's
    // bulk delete soft-deletes one that holds records) so a re-seed repairs it.
    const customer = await prisma.customer.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        businessName: c.businessName,
        contactName: "E2E Fixture",
        tenantId,
      },
      update: { deletedAt: null },
    });
    customers.push(customer);
  }

  const products = new Map();
  for (const p of FIXTURE_PRODUCTS) {
    const product = await prisma.product.upsert({
      where: { tenantId_sku: { tenantId, sku: p.sku } },
      create: { tenantId, currentStock: 500, isActive: true, ...p },
      update: { isActive: true },
    });
    products.set(p.sku, product);
  }

  // One SENT invoice so 06 CP-01 scans real amount cells on a fresh DB (its "$" scan otherwise
  // reads the empty-state block as a malformatted amount).
  await prisma.invoice.upsert({
    where: { tenantId_invoiceNumber: { tenantId, invoiceNumber: FIXTURE_INVOICE_NUMBER } },
    create: {
      tenantId,
      customerId: customers[0].id,
      invoiceNumber: FIXTURE_INVOICE_NUMBER,
      status: "SENT",
      sentAt: new Date(),
      subtotal: cents(BOX_PRICE_CENTS),
      total: cents(BOX_PRICE_CENTS),
      items: {
        create: [
          {
            tenantId, // a nested create is not tenant-scoped for us — set it explicitly (B571 class)
            description: "E2E Fixture Boxed Case",
            qty: 1,
            unitPrice: cents(BOX_PRICE_CENTS),
            subtotal: cents(BOX_PRICE_CENTS),
          },
        ],
      },
    },
    update: {},
  });

  // One PENDING order + one line (see FIXTURE_ORDER_KEY). Same numbering rule as the app.
  const widget = products.get("E2E-FIX-001");
  const lastOrder = await prisma.order.findFirst({
    where: { tenantId, orderNumber: { startsWith: "ORD-" } },
    orderBy: { orderNumber: "desc" },
    select: { orderNumber: true },
  });
  const seq = lastOrder?.orderNumber
    ? parseInt(lastOrder.orderNumber.replace("ORD-", ""), 10) + 1
    : 1;
  const orderNumber = `ORD-${String(Number.isFinite(seq) ? seq : 1).padStart(5, "0")}`;
  await prisma.order.upsert({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: FIXTURE_ORDER_KEY } },
    create: {
      tenantId,
      customerId: customers[1].id,
      orderNumber,
      idempotencyKey: FIXTURE_ORDER_KEY,
      // A staff create for this customer must never hit MERGE_CHOICE_REQUIRED (409) because of
      // the fixture order: specs 08/13 create orders for the first picker customer.
      skipAutoMerge: true,
      status: "PENDING",
      subtotal: cents(ORDER_QTY * WIDGET_A_CENTS),
      total: cents(ORDER_QTY * WIDGET_A_CENTS),
      lineItems: {
        create: [
          {
            tenantId,
            productId: widget.id,
            status: "PENDING",
            qty: ORDER_QTY,
            unitPrice: cents(WIDGET_A_CENTS),
            subtotal: cents(ORDER_QTY * WIDGET_A_CENTS),
          },
        ],
      },
    },
    // Self-healing like the customer/product upserts: a spec or operator that cancelled/moved the
    // fixture order would otherwise leave REG-B24 (needs an ACTIVE line) red forever.
    update: {
      status: "PENDING",
      skipAutoMerge: true,
      lineItems: { updateMany: { where: {}, data: { status: "PENDING" } } },
    },
  });

  console.log(
    `  ✓ Commerce fixtures present: ${FIXTURE_CUSTOMERS.length} customers, ${FIXTURE_PRODUCTS.length} products (1 boxed), 1 invoice, 1 order`,
  );
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

    // ── Licensed tracked category (REG-B91 precondition) ───────────────────────
    await ensureLicensedTrackedCategory(existing.id);
    console.log(`  ✓ Licensed tracked category "${LICENSED_TRACKED_CATEGORY_NAME}" active`);

    // ── Commerce fixtures (B566) ─────────────────────────────────────────────────
    await ensureCommerceFixtures(existing.id);

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

  // ── Licensed tracked category (REG-B91 precondition) ──────────────────────────
  await ensureLicensedTrackedCategory(tenant.id);
  console.log(`  ✓ Licensed tracked category "${LICENSED_TRACKED_CATEGORY_NAME}" created`);

  // ── Commerce fixtures (B566) ─────────────────────────────────────────────────
  await ensureCommerceFixtures(tenant.id);

  console.log("\n✅ E2E seed complete.\n");
}

/**
 * Idempotent seed for `qa-lite` — a standing LITE-plan tenant (B449 fix-round
 * finding 3). Writes `TenantSubscription.planKey = "LITE"` pinned to the
 * currently PUBLISHED plan catalog version, the same shape
 * `PlatformAdminService.updatePlan`/`activateManualSubscription` produce for a
 * real invite+activate, so `EntitlementsService.resolve()` sees exactly what a
 * real LITE tenant would — no flags granted, `flag.recurring_invoices` /
 * `flag.estimates` / etc. all 403.
 */
async function seedQaLiteTenant() {
  const version = await prisma.planVersion.findFirst({
    where: { status: "PUBLISHED" },
    orderBy: { version: "desc" },
  });
  if (!version) {
    // Fix-round finding 3: no published catalog is a real, non-fatal state on a
    // fresh/partially-seeded DB (e.g. a compose stack before local:seed's genesis
    // catalog-publish step has run) — e2e-routeflow above already seeded fine
    // without needing one. Skip ONLY this tenant, log why, and let the run
    // otherwise succeed; 48-lite-locked-route-ux.spec.ts fails loudly on its own
    // if qa-lite genuinely doesn't exist when it runs.
    console.log(
      "⚠ qa-lite seed skipped — no PUBLISHED plan catalog version exists yet. Run " +
        "`npm run db:publish:catalog:v12` (or whichever is current) and re-seed to provision it.\n",
    );
    return;
  }

  const existing = await prisma.tenant.findUnique({ where: { slug: LITE_TENANT_SLUG } });
  if (existing) {
    console.log(`✓ Tenant "${LITE_TENANT_SLUG}" already exists (id: ${existing.id})`);
    const op = await prisma.user.findFirst({
      where: { tenantId: existing.id, username: OPERATOR_USERNAME },
    });
    if (!op) {
      await prisma.user.create({
        data: {
          email: "admin@qa-lite.test",
          username: OPERATOR_USERNAME,
          password: await bcrypt.hash(OPERATOR_PASSWORD, 10),
          role: "OPERATOR",
          status: "ACTIVE",
          forcePasswordChange: false,
          tenantId: existing.id,
        },
      });
      console.log(`  ✓ Created missing operator: ${OPERATOR_USERNAME}`);
    }
    await prisma.tenantSubscription.upsert({
      where: { tenantId: existing.id },
      create: {
        tenantId: existing.id,
        currentPlan: "LITE",
        planKey: "LITE",
        planVersionId: version.id,
        cycle: "MONTHLY",
      },
      update: { currentPlan: "LITE", planKey: "LITE", planVersionId: version.id },
    });
    console.log(`  ✓ TenantSubscription pinned to LITE @ catalog v${version.version}`);
    console.log("✅ qa-lite tenant ready.\n");
    return;
  }

  console.log(`Creating tenant "${LITE_TENANT_SLUG}"...`);
  const tenant = await prisma.tenant.create({
    data: {
      slug: LITE_TENANT_SLUG,
      name: "QA Lite Plan",
      status: "ACTIVE",
      plan: "LITE",
    },
  });
  await prisma.tenantConfig.create({
    data: { tenantId: tenant.id, businessName: "QA Lite Plan" },
  });
  await prisma.user.create({
    data: {
      email: "admin@qa-lite.test",
      username: OPERATOR_USERNAME,
      password: await bcrypt.hash(OPERATOR_PASSWORD, 10),
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId: tenant.id,
    },
  });
  await prisma.tenantSubscription.create({
    data: {
      tenantId: tenant.id,
      currentPlan: "LITE",
      planKey: "LITE",
      planVersionId: version.id,
      cycle: "MONTHLY",
    },
  });
  console.log(
    `  ✓ Tenant created (id: ${tenant.id}), pinned to LITE @ catalog v${version.version}`,
  );
  console.log("✅ qa-lite seed complete.\n");
}

bootstrap()
  .then(main)
  .then(seedQaLiteTenant)
  .catch((e) => {
    // Print the WHOLE error: Prisma wraps connection failures in an
    // "Invalid invocation" whose .message can be empty, hiding the cause.
    console.error("\n❌ E2E seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
  });
