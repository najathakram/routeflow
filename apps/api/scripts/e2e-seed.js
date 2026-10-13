/**
 * e2e-seed.js
 *
 * Idempotent seed for Playwright E2E tests.
 * Creates the `e2e-routeflow` tenant with:
 *   • Operator:            admin / Admin@123
 *   • Customer:            harbor_cafe / Customer1!
 *   • Tenant admin:        e2e_admin / TenantAdmin1!
 *   • Sessions operator:   e2e_sessions_op / Sessions1! (dedicated — spec 32, L-050)
 *   • Approved buyer:      e2e_buyer@e2e-routeflow.test / BuyerPortal1! — ACTIVE-linked to its own
 *                          dedicated customer (e2e_buyer_cust); no address, no selling rule
 *
 * Safe to run multiple times — skips creation if data already exists. On an
 * existing tenant it also sweeps stale parked SaleDrafts the web e2e suite
 * left in the operator's dock (see 08-create-order-escape.spec.ts).
 *
 * Usage (from repo root):
 *   Local (compose stack): node scripts/local-env.mjs --db -- "node apps/api/scripts/e2e-seed.js"
 *     (`npm run local:seed` runs prisma/seed.ts, NOT this script, so it never seeds the fixtures here)
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

// #2146: these four are loaded LAZILY in bootstrap(), after the --print-target early exit —
// requiring them here cost ~2.3s of pure module loading per `--print-target` child (three
// spawns in e2e-seed-script.spec.ts) that never opens a connection or hashes anything.
let PrismaClient;
let PrismaPg;
let Pool;
let bcrypt;
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");
const { isLocalDbTarget, localConnectionConfig } = require("./lib/local-db-target.cjs");
const { ensureDriverUser } = require("./lib/driver-fixture.cjs");

const LOCAL_DEFAULT_DB_URL = "postgresql://user:pass@localhost:5432/routeflow_dev";

// Resolves the seed's DB target the same way prod-migrate.mjs/schema-drift.mjs do (Railway
// proxy vars win over DATABASE_URL, since under `railway run` DATABASE_URL is the unreachable
// *.railway.internal host) — imported dynamically because the shared helper is an ESM module
// (`.mjs`) and this script was written when CI ran Node 20, which cannot `require()` ESM (CI is Node 24 since B570, so the workaround is now optional).
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
  console.log(`e2e-seed: units_v1 fixture = ${unitsFixturePlan(dbUrl)}`);
  if (process.argv.includes("--print-target")) {
    process.exit(0);
  }
  ({ PrismaClient } = require("../../../node_modules/@prisma/client"));
  ({ PrismaPg } = require("../../../node_modules/@prisma/adapter-pg"));
  ({ Pool } = require("../../../node_modules/pg"));
  bcrypt = require("../../../node_modules/bcrypt");
  // A provably-local target dials the vetted explicit fields (a `?host=` on the raw string could redirect it).
  pool = new Pool(localConnectionConfig(dbUrl) ?? { connectionString: dbUrl });
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
// PHASE 1a (web driver mode) precondition, item 7 — a throwaway DRIVER-role
// fixture so the driver-mode Playwright proof can sign in as a real driver.
// The localhost-seed exception: agents never create accounts, but seeding a
// fixture user on the approved e2e-routeflow tenant is the standing carve-out
// (assertTestTenant guards it below, same as every other user this script
// creates). Linked to its own Driver row (userId) — routes.service.ts's
// findMyRuns resolves the authenticated driver by that link, not by role alone.
const DRIVER_USERNAME = "e2e_driver";
// Never hardcoded (this repo goes public for CI and the seed can target the prod e2e tenant):
// read from E2E_DRIVER_PASSWORD. Unset -> the driver fixture is skipped, the rest still seeds.
const DRIVER_PASSWORD = process.env.E2E_DRIVER_PASSWORD || "";
const DRIVER_SKIP_NOTE =
  "  ! E2E_DRIVER_PASSWORD is not set - skipping the e2e_driver fixture (set it to seed the driver)";
// Approved-buyer fixture (buyer-facing compliance proofs need a BUYER that can reach the order
// call, and a fresh self-registered buyer has no seller link). Linked to a DEDICATED customer:
// CustomerLink.customerId is @unique, so one customer holds one buyer - never harbor_cafe or the
// picker fixtures, which other specs/setup steps depend on. Deliberately NO billing address and
// NO selling-restriction rule: proofs set and undo those per-run, so the resting state stays true.
const BUYER_EMAIL = "e2e_buyer@e2e-routeflow.test";
const BUYER_PASSWORD = "BuyerPortal1!";
const BUYER_CUSTOMER = { username: "e2e_buyer_cust", businessName: "E2E Buyer Portal Cafe" };
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

// #2195: units_v1 fixture. The ladder is pack + ProductUnit rows + an implicit Piece, and
// ProductUnitsService refuses a row that repeats the pack's factor. So the product itself is the
// Piece (no pack, factor 1) and Case x12 is a real ProductUnit row: an order line in "Case"
// resolves through the ProductUnit ladder, the path units_v1 adds, not the legacy boxed pack
// (E2E-FIX-BOX already covers that). The name avoids "case"/"box" so 13-boxed-order-entry's
// product search never matches it.
const UNITS_FEATURE_KEY = "flag.units_v1";
const UNITS_GRANT_REASON = "e2e-seed: units_v1 fixture on the approved test tenant (#2195)";
const UNITS_PRODUCT = {
  sku: "E2E-FIX-UNITS",
  name: "E2E Fixture Units Widget",
  unit: "Piece",
  pricePerUnit: cents(200),
};
const UNITS_CASE = { label: "Case", factorToBase: 12, price: cents(2100) };
// VU-4 (B1218): a boxed product whose Case is the DEFAULT selling unit, shared by the invoice-picker lane
// (web) and the mobile Expo-web proof. Box of 24 @ 48.00; Case = 12 pcs @ 24.00; Piece is implicit.
const CASE_DEFAULT_PRODUCT = {
  sku: "E2E-FIX-CASEDEFAULT",
  name: "E2E Fixture Case Default",
  unit: "Box",
  unitsPerBox: 24,
  pricePerUnit: cents(4800),
};
const CASE_DEFAULT_LEVEL = {
  label: "Case",
  factorToBase: 12,
  price: cents(2400),
  isDefaultSelling: true,
};

const FIXTURE_INVOICE_NUMBER = "E2E-FIX-INV-001";
// One PENDING order with one line on the first plain fixture product: 06 CP-02/CP-06 read real
// order rows off a fresh DB, and 21 REG-B24 needs an ACTIVE order item against a catalog product
// to prove the bulk-delete skip-guard. Found by a stable idempotencyKey — NOT by number: the app
// generates the next order number as (numeric max over conforming "ORD-<digits>") + 1
// (orders.service.ts / order-number.ts, B587), so a fixed high literal like ORD-900001 would skew that tenant's sequence
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

// B917: the e2e customer LOGIN (harbor_cafe) must be linked to a Customer row, or GET /orders answers it
// 403 CUSTOMER_NOT_LINKED and the customer dashboard cannot load. userId is @unique -> a safe upsert;
// `update` un-deletes a soft-deleted row so a re-seed repairs it. Never overwrites the business name.
async function ensureCustomerRecordFor(tenantId, userId) {
  return prisma.customer.upsert({
    where: { userId },
    create: {
      userId,
      businessName: "E2E Harbor Cafe",
      contactName: "E2E Customer",
      tenantId,
    },
    update: { deletedAt: null },
  });
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
      // B562 (SA-136 §1): the opening stock is a PURCHASE movement, so the ledger explains the counter
      // (stock-ledger-gap.mjs reports a product whose counter its movements don't add up to).
      create: {
        tenantId,
        currentStock: 500,
        isActive: true,
        ...p,
        stockMovements: {
          create: [
            {
              tenantId,
              type: "PURCHASE",
              quantity: 500,
              stockAfter: 500,
              notes: "Opening stock (e2e seed)",
            },
          ],
        },
      },
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
  // B587: NUMERIC max over conforming `ORD-<1..9 digits>` numbers only (ORD-SEED-1 and friends
  // sort above every numeric number as text) — the same rule as apps/api/src/orders/order-number.ts.
  const existingOrderNumbers = await prisma.order.findMany({
    where: { tenantId, orderNumber: { startsWith: "ORD-" } },
    select: { orderNumber: true },
  });
  const maxSeq = existingOrderNumbers.reduce((max, o) => {
    const m = /^ORD-([0-9]{1,9})$/.exec(o.orderNumber ?? "");
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  const orderNumber = `ORD-${String(maxSeq + 1).padStart(5, "0")}`;
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

// The buyer is a GLOBAL account (not tenant-scoped) with a committed throwaway password, and this
// script is also run against production (`railway run ... e2e-seed.js`). So the fixture is created
// ONLY when the resolved target is provably local (allowlist in lib/local-db-target.cjs) — never on
// Railway or any host we cannot classify — and no flag overrides that.
// #2195: grant flag.units_v1 through the same TenantFeatureOverride row the Backoffice writes
// (FeatureOverrideService.grant), then seed the Piece/Case x12 product. Idempotent: an active
// GRANT is left alone; an expired or DENY row (a spec's leftover) is revoked first, because the
// partial unique index allows one un-revoked row per (tenant, key). Only ever called with the
// e2e-routeflow tenant id, which TENANT_SLUG's assertTestTenant already approved.
// Owner rule: agents never flip a production flag; the owner grants flag.units_v1 on a real
// environment. So the grant AND the fixture product run only against a provably-local DB — the
// same isLocalDbTarget gate the buyer fixture uses. `--print-target` prints this same plan, which
// is how e2e-seed-script.spec.ts proves a non-local target skips it without touching a database.
function unitsFixturePlan(url) {
  return isLocalDbTarget(url) ? "run (local target)" : "skipped (non-local target)";
}

async function ensureUnitsFixtureIfLocal(tenantId) {
  if (!isLocalDbTarget(dbUrl)) {
    console.log(`  - units_v1 fixture ${unitsFixturePlan(dbUrl)}`);
    return;
  }
  await ensureUnitsFixture(tenantId);
  console.log(`  ✓ flag.units_v1 granted; ${UNITS_PRODUCT.sku} has Piece + Case x12`);
}

async function ensureUnitsFixture(tenantId) {
  const now = new Date();
  await prisma.tenantFeatureOverride.updateMany({
    where: { tenantId, featureKey: UNITS_FEATURE_KEY, revokedAt: null, expiresAt: { lte: now } },
    data: { revokedAt: now },
  });
  const active = await prisma.tenantFeatureOverride.findFirst({
    where: { tenantId, featureKey: UNITS_FEATURE_KEY, revokedAt: null },
  });
  if (active && active.effect !== "GRANT") {
    await prisma.tenantFeatureOverride.update({
      where: { id: active.id },
      data: { revokedAt: now },
    });
  }
  if (!active || active.effect !== "GRANT") {
    await prisma.tenantFeatureOverride.create({
      data: {
        tenantId,
        featureKey: UNITS_FEATURE_KEY,
        effect: "GRANT",
        kind: "SUPPORT",
        reason: UNITS_GRANT_REASON,
      },
    });
  }

  const product = await prisma.product.upsert({
    where: { tenantId_sku: { tenantId, sku: UNITS_PRODUCT.sku } },
    create: { tenantId, currentStock: 500, isActive: true, ...UNITS_PRODUCT },
    update: { isActive: true },
  });
  await prisma.productUnit.upsert({
    where: { productId_label: { productId: product.id, label: UNITS_CASE.label } },
    create: { tenantId, productId: product.id, ...UNITS_CASE },
    update: {},
  });
  const caseDefault = await prisma.product.upsert({
    where: { tenantId_sku: { tenantId, sku: CASE_DEFAULT_PRODUCT.sku } },
    create: { tenantId, currentStock: 500, isActive: true, ...CASE_DEFAULT_PRODUCT },
    update: { isActive: true },
  });
  await prisma.productUnit.upsert({
    where: { productId_label: { productId: caseDefault.id, label: CASE_DEFAULT_LEVEL.label } },
    create: { tenantId, productId: caseDefault.id, ...CASE_DEFAULT_LEVEL },
    update: { isDefaultSelling: true },
  });
}

async function ensureBuyerFixtureIfLocal(tenantId) {
  if (!isLocalDbTarget(dbUrl)) {
    console.log("  - buyer fixture skipped (non-local target)");
    return;
  }
  await ensureBuyerFixture(tenantId);
}

// A BuyerAccount whose CustomerLink to a dedicated customer on this tenant is ACTIVE (the
// "approved" state - the enum default is INVITED). Idempotent: each piece is found first and
// reported "exists", or created/repaired (re-approving a link a spec disconnected, un-deleting or
// unlocking the account, restoring a changed password).
async function ensureBuyerFixture(tenantId) {
  const user = await ensureFixtureUser(tenantId, BUYER_CUSTOMER);
  const customer = await prisma.customer.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      businessName: BUYER_CUSTOMER.businessName,
      contactName: "E2E Buyer",
      tenantId,
    },
    update: { deletedAt: null },
  });

  let account = await prisma.buyerAccount.findUnique({ where: { email: BUYER_EMAIL } });
  if (!account) {
    account = await prisma.buyerAccount.create({
      data: {
        email: BUYER_EMAIL,
        passwordHash: await bcrypt.hash(BUYER_PASSWORD, 10),
        name: "E2E Buyer",
        emailVerified: true,
      },
    });
    console.log(`  ✓ Created buyer: ${BUYER_EMAIL} (password: see e2e/helpers/constants.ts)`);
  } else {
    const passwordOk = await bcrypt.compare(BUYER_PASSWORD, account.passwordHash);
    const healthy =
      passwordOk &&
      account.status === "ACTIVE" &&
      !account.deletedAt &&
      !account.lockedUntil &&
      account.failedLoginAttempts === 0;
    if (!healthy) {
      account = await prisma.buyerAccount.update({
        where: { id: account.id },
        data: {
          status: "ACTIVE",
          deletedAt: null,
          lockedUntil: null,
          failedLoginAttempts: 0,
          ...(passwordOk ? {} : { passwordHash: await bcrypt.hash(BUYER_PASSWORD, 10) }),
        },
      });
      console.log(`  ✓ Repaired buyer: ${BUYER_EMAIL}`);
    } else {
      console.log(`  ✓ Buyer "${BUYER_EMAIL}" exists`);
    }
  }

  const link = await prisma.customerLink.findUnique({ where: { customerId: customer.id } });
  if (!link || link.buyerAccountId !== account.id || link.status !== "ACTIVE") {
    await prisma.customerLink.upsert({
      where: { customerId: customer.id },
      create: {
        buyerAccountId: account.id,
        customerId: customer.id,
        tenantId,
        status: "ACTIVE",
        linkedAt: new Date(),
      },
      update: {
        buyerAccountId: account.id,
        status: "ACTIVE",
        linkedAt: new Date(),
        disconnectedAt: null,
        disconnectedBy: null,
        inviteToken: null,
        inviteExpiresAt: null,
      },
    });
    console.log(`  ✓ Buyer approved-linked to "${BUYER_CUSTOMER.businessName}"`);
  } else {
    console.log(`  ✓ Buyer link to "${BUYER_CUSTOMER.businessName}" exists (ACTIVE)`);
  }
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
    // B917: link the customer login to a Customer record (idempotent).
    {
      const loginUser = await prisma.user.findFirst({
        where: { tenantId: existing.id, username: CUSTOMER_USERNAME },
      });
      if (loginUser) await ensureCustomerRecordFor(existing.id, loginUser.id);
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

    // ── DRIVER fixture (PHASE 1a Playwright proof precondition) ────────────────
    if (!DRIVER_PASSWORD) {
      console.log(DRIVER_SKIP_NOTE);
    } else {
      const { user: dr, created } = await ensureDriverUser({
        prisma,
        hash: (pw) => bcrypt.hash(pw, 10),
        tenantId: existing.id,
        username: DRIVER_USERNAME,
        email: "e2e_driver@e2e-routeflow.test",
        password: DRIVER_PASSWORD,
      });
      console.log(
        created
          ? `  ✓ Created missing driver: ${DRIVER_USERNAME}`
          : `  ✓ Driver "${DRIVER_USERNAME}" exists (password re-synced from E2E_DRIVER_PASSWORD)`,
      );
      const drRecord = await prisma.driver.findFirst({ where: { userId: dr.id } });
      if (!drRecord) {
        await prisma.driver.create({
          data: {
            tenantId: existing.id,
            userId: dr.id,
            contactName: "E2E Driver",
            phone: "(512) 555-0199",
            status: "ACTIVE",
          },
        });
        console.log("  ✓ Created missing Driver record for e2e_driver");
      } else {
        console.log("  ✓ Driver record for e2e_driver exists");
      }
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
    await ensureBuyerFixtureIfLocal(existing.id);

    // ── units_v1 grant + Piece/Case fixture (#2195) ──────────────────────────────
    await ensureUnitsFixtureIfLocal(existing.id);

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
  const customerLogin = await prisma.user.create({
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
  // B917: link the customer login to a Customer record (idempotent).
  await ensureCustomerRecordFor(tenant.id, customerLogin.id);
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

  // ── DRIVER fixture (PHASE 1a Playwright proof precondition) ─────────────────
  if (!DRIVER_PASSWORD) {
    console.log(DRIVER_SKIP_NOTE);
  } else {
    const driverUser = await prisma.user.create({
      data: {
        email: "e2e_driver@e2e-routeflow.test",
        username: DRIVER_USERNAME,
        password: await bcrypt.hash(DRIVER_PASSWORD, 10),
        role: "DRIVER",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId: tenant.id,
      },
    });
    await prisma.driver.create({
      data: {
        tenantId: tenant.id,
        userId: driverUser.id,
        contactName: "E2E Driver",
        phone: "(512) 555-0199",
        status: "ACTIVE",
      },
    });
    console.log(`  ✓ Driver created: ${DRIVER_USERNAME}`);
  }

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
  await ensureBuyerFixtureIfLocal(tenant.id);

  // ── units_v1 grant + Piece/Case fixture (#2195) ────────────────────────────────
  await ensureUnitsFixtureIfLocal(tenant.id);

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
