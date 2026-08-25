/**
 * demo-seed.js
 *
 * Builds (and refreshes) `routeflow-demo` — the standing RouteFlow sales-demo
 * tenant. A fictional wholesale distributor in Austin, TX with five dummy retail
 * customers, a real-looking catalog, opening stock, ~45 orders across the last
 * 60 days, and the invoices/payments those orders produced.
 *
 * WHY A SEPARATE TENANT: demos must never run on a live client. `routeflow-demo`
 * is on the approved test-tenant allowlist (scripts/lib/test-tenants.cjs), so QA
 * and refresh scripts may target it freely.
 *
 * CATALOG SOURCE. The catalog is COPIED from an existing tenant named by
 * `DEMO_SOURCE_TENANT` (never hardcoded — see CLAUDE.md "Test tenants &
 * real-client data"). That tenant is opened READ-ONLY: every write this script
 * issues carries the demo tenant's id, asserted row by row. Copied are the
 * product definitions and their regulated-category classification; NOT copied
 * are the source tenant's own licence numbers, customers, orders or documents.
 * Which products get copied is driven by the image manifest (see below), so the
 * demo catalog is exactly the set that has a vetted product photo.
 *
 * STAGED ASSETS. `DEMO_ASSETS_DIR` (default `<repo>/.personal/img`) must hold:
 *   manifest.json      — { entries: { <sourceProductId>: { uploaded, file, … } } }
 *   descriptions.json  — { <sourceProductId>: { description, … } }
 * Only entries with `uploaded: true` (a human-reviewed photo) are copied.
 * This script does NOT upload images — run demo-seed-images.js afterwards.
 *
 * DETERMINISTIC. Every generated id is derived from a stable hash, and all
 * randomness comes from a fixed-seed PRNG, so re-running produces the same
 * tenant. Foundation rows (tenant, users, customers, suppliers, products,
 * routes) are upserted in place; transactional rows (orders, invoices,
 * payments, stock movements, the regulated ledger) are deleted and rebuilt, so
 * a demo that got dirtied is restored by one re-run — and because product ids
 * are stable, already-uploaded images survive it.
 *
 * TAX: the demo tenant charges 8.25% sales tax and mirrors the production
 * formulas exactly — order.tax is REGULAR tax only, per-line regulated tax is
 * folded into the order total, and an invoice's taxAmount is regular +
 * category tax (see invoices.service.ts createSplitInvoices).
 *
 * SAFE + IDEMPOTENT:
 *   • assertTestTenant("routeflow-demo") before anything.
 *   • Dry-run by default — prints the full plan. `--live` to write.
 *   • Every create/update/delete is scoped to the demo tenant id.
 *
 * Usage (from repo root):
 *   Dry run:  DEMO_SOURCE_TENANT=<slug> node apps/api/scripts/demo-seed.js
 *   Local:    DEMO_SOURCE_TENANT=<slug> node apps/api/scripts/demo-seed.js --live
 *   Prod:     DEMO_SOURCE_TENANT=<slug> railway run --service postgres \
 *               node apps/api/scripts/demo-seed.js --live
 */

const path = require("path");
const fs = require("fs");

// Bare specifiers (rather than the ../../../node_modules/… form the older
// scripts use) so this also runs from a git worktree, where the repo root is not
// the directory holding node_modules.
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");
const { DEMO_SLUG: DEMO_SLUG_RAW, stableId } = require("./lib/demo-ids");

// The money helpers are the single source of truth for line math (CLAUDE.md
// "Money discipline"). They live in TypeScript, so register a transpile-only
// ts-node hook rather than re-implementing — a private copy would drift.
require("ts-node").register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: { module: "commonjs", moduleResolution: "node", target: "ES2022" },
});
const {
  roundMoney,
  normalizeBoxesPieces,
  computeLineSubtotal,
  computeCategoryTax,
} = require("../src/common/pricing.ts");
const { getTierPrice } = require("../src/utils/pricing.ts");
const { IRS_SYSTEM_CATEGORIES } = require("../src/bookkeeping/irs-categories.constant.ts");
const { periodBucketOf } = require("../src/regulated/period.ts");

// ─── Configuration ────────────────────────────────────────────────────────────

const DEMO_SLUG = assertTestTenant(DEMO_SLUG_RAW, "demo-seed");
const DEMO_NAME = "RouteFlow Demo Wholesale";
const DEMO_PASSWORD = "routeflow_demo";
const OPERATOR_USERNAME = "routeflow_demo";
const DRIVER_USERNAME = "demo_driver";
/** Reachable inbox so the buyer portal's email-match connect can be demoed live. */
const OWNER_EMAIL = "najathakram1@gmail.com";
const TAX_RATE = 0.0825;
const PAYMENT_TERMS_DAYS = 15;
const HISTORY_DAYS = 60;

const LIVE = process.argv.includes("--live");
const SOURCE_SLUG = (process.env.DEMO_SOURCE_TENANT ?? "").trim().toLowerCase();
const ASSETS_DIR = process.env.DEMO_ASSETS_DIR
  ? path.resolve(process.env.DEMO_ASSETS_DIR)
  : path.resolve(__dirname, "../../../.personal/img");

function resolveDbUrl() {
  const e = process.env;
  if (
    e.RAILWAY_TCP_PROXY_DOMAIN &&
    e.RAILWAY_TCP_PROXY_PORT &&
    e.POSTGRES_USER &&
    e.POSTGRES_PASSWORD &&
    e.POSTGRES_DB
  ) {
    return (
      `postgresql://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` +
      `@${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`
    );
  }
  return e.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/routeflow_dev";
}

const dbUrl = resolveDbUrl();
const pool = new Pool({ connectionString: dbUrl });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// ─── Determinism ──────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260820);
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;

/** Midnight-UTC business date N days before the run — keeps period buckets stable. */
const RUN_AT = new Date();
function daysAgo(n) {
  const d = new Date(
    Date.UTC(RUN_AT.getUTCFullYear(), RUN_AT.getUTCMonth(), RUN_AT.getUTCDate(), 15, 0, 0),
  );
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}
const addDays = (date, n) => {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
};

// ─── Demo cast ────────────────────────────────────────────────────────────────

const CUSTOMERS = [
  {
    key: "sunrise-corner-mart",
    username: "sunrise_mart",
    businessName: "Sunrise Corner Mart",
    contactName: "Dana Whitfield",
    email: "orders@sunrisecornermart.example.com",
    phone: "(512) 555-0142",
    mobile: "(512) 555-0143",
    pricingTier: 1,
    creditLimit: 6000,
    fulfillPath: "ROUTE",
    weight: 0.2,
    address: { line1: "1908 E Riverside Dr", city: "Austin", state: "TX", zip: "78741" },
  },
  {
    key: "lakeside-smoke-and-vape",
    username: "lakeside_vape",
    businessName: "Lakeside Smoke & Vape",
    contactName: "Marcus Ellery",
    email: "buying@lakesidesmoke.example.com",
    phone: "(512) 555-0168",
    mobile: "(512) 555-0169",
    pricingTier: 2,
    creditLimit: 12000,
    fulfillPath: "ROUTE",
    weight: 0.22,
    address: { line1: "5400 Burnet Rd Ste B", city: "Austin", state: "TX", zip: "78756" },
  },
  {
    key: "metro-gas-and-go",
    username: "metro_gas",
    businessName: "Metro Gas & Go",
    contactName: "Priya Raman",
    email: "priya@metrogasgo.example.com",
    phone: "(512) 555-0191",
    mobile: null,
    pricingTier: 1,
    creditLimit: 4500,
    fulfillPath: "ROUTE",
    weight: 0.16,
    address: { line1: "7301 N Lamar Blvd", city: "Austin", state: "TX", zip: "78752" },
  },
  {
    key: "hilltop-convenience",
    username: "hilltop_conv",
    businessName: "Hilltop Convenience",
    contactName: "Owen Brady",
    email: "owen@hilltopconvenience.example.com",
    phone: "(512) 555-0117",
    mobile: "(512) 555-0118",
    pricingTier: 3,
    creditLimit: 9000,
    // The one ship-to account, so shipping fees and the SHIP fulfil path both
    // appear in the demo data.
    fulfillPath: "SHIP",
    weight: 0.17,
    address: { line1: "12100 Ranch Rd 620 N", city: "Austin", state: "TX", zip: "78750" },
  },
  {
    key: "najath-trading-co",
    username: "najath_trading",
    businessName: "Najath's Trading Co.",
    contactName: "Najath Akram",
    // A real inbox on purpose: signing into the buyer portal with this address
    // auto-connects to this customer through the email-proof gate in
    // buyer.service.ts requestSeller().
    email: OWNER_EMAIL,
    phone: "(512) 555-0100",
    mobile: "(512) 555-0101",
    pricingTier: 2,
    creditLimit: 15000,
    fulfillPath: "ROUTE",
    weight: 0.25,
    address: { line1: "2400 E Cesar Chavez St", city: "Austin", state: "TX", zip: "78702" },
  },
];

const SUPPLIERS = [
  {
    key: "acme-distribution",
    name: "Acme Distribution Co.",
    contactName: "Rita Alvarez",
    email: "sales@acmedistribution.example.com",
    phone: "(214) 555-0110",
    city: "Dallas",
    state: "TX",
    zip: "75207",
    line1: "1120 Industrial Blvd",
    leadTimeDays: 4,
  },
  {
    key: "summit-wholesale",
    name: "Summit Wholesale Supply",
    contactName: "Trevor Nash",
    email: "orders@summitwholesale.example.com",
    phone: "(713) 555-0177",
    city: "Houston",
    state: "TX",
    zip: "77029",
    line1: "8802 Market St",
    leadTimeDays: 7,
  },
  {
    key: "gulf-coast-imports",
    name: "Gulf Coast Imports",
    contactName: "Leah Duarte",
    email: "hello@gulfcoastimports.example.com",
    phone: "(361) 555-0134",
    city: "Corpus Christi",
    state: "TX",
    zip: "78401",
    line1: "415 N Chaparral St",
    leadTimeDays: 10,
  },
];

const ROUTES = [
  {
    key: "north-austin",
    name: "North Austin Route",
    customers: ["metro-gas-and-go", "hilltop-convenience", "lakeside-smoke-and-vape"],
  },
  {
    key: "central-east",
    name: "Central & East Route",
    customers: ["najath-trading-co", "sunrise-corner-mart"],
  },
];

// ─── Guards ───────────────────────────────────────────────────────────────────

let DEMO_TENANT_ID = null;
let SOURCE_TENANT_ID = null;

/**
 * Every row this script writes must belong to the demo tenant. Called on each
 * builder so a copy/paste slip can never address the source tenant.
 */
function scoped(data) {
  if (!DEMO_TENANT_ID) throw new Error("demo tenant id not resolved yet");
  if (data.tenantId && data.tenantId !== DEMO_TENANT_ID) {
    throw new Error(`refusing to write a row scoped to ${data.tenantId} (not the demo tenant)`);
  }
  return { ...data, tenantId: DEMO_TENANT_ID };
}

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

// ─── Staged assets ────────────────────────────────────────────────────────────

function loadAssets() {
  const manifestPath = path.join(ASSETS_DIR, "manifest.json");
  const descriptionsPath = path.join(ASSETS_DIR, "descriptions.json");
  if (!fs.existsSync(manifestPath)) {
    fail(
      `No manifest at ${manifestPath}.\n   Set DEMO_ASSETS_DIR to the directory holding manifest.json + descriptions.json.`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const descriptions = fs.existsSync(descriptionsPath)
    ? JSON.parse(fs.readFileSync(descriptionsPath, "utf8"))
    : {};
  // `uploaded: true` marks an image a human accepted; everything else is either
  // failed sourcing or quarantined as a possible wrong-variant match.
  const productIds = Object.entries(manifest.entries ?? {})
    .filter(([, e]) => e && e.uploaded === true && e.file)
    .map(([id]) => id);
  return { manifest, descriptions, productIds };
}

// ─── Foundation ───────────────────────────────────────────────────────────────

async function resolveTenants() {
  if (!SOURCE_SLUG) {
    fail(
      "DEMO_SOURCE_TENANT is required — the slug of the tenant whose catalog is copied.\n" +
        "   It is opened READ-ONLY; every write goes to routeflow-demo.",
    );
  }
  const source = await prisma.tenant.findUnique({
    where: { slug: SOURCE_SLUG },
    select: { id: true, slug: true, name: true },
  });
  if (!source) fail(`Source tenant "${SOURCE_SLUG}" not found in this database.`);
  SOURCE_TENANT_ID = source.id;

  const existing = await prisma.tenant.findUnique({ where: { slug: DEMO_SLUG } });
  DEMO_TENANT_ID = existing ? existing.id : stableId("tenant", DEMO_SLUG);
  if (DEMO_TENANT_ID === SOURCE_TENANT_ID) fail("Source and demo tenant resolved to the same id.");
  return { source, existing };
}

async function ensureTenant(existing) {
  if (existing) {
    await prisma.tenant.update({
      where: { id: DEMO_TENANT_ID },
      data: { name: DEMO_NAME, status: "ACTIVE", plan: "PROFESSIONAL", deletedAt: null },
    });
  } else {
    await prisma.tenant.create({
      data: {
        id: DEMO_TENANT_ID,
        slug: DEMO_SLUG,
        name: DEMO_NAME,
        status: "ACTIVE",
        plan: "PROFESSIONAL",
      },
    });
  }

  await prisma.tenantConfig.upsert({
    where: { tenantId: DEMO_TENANT_ID },
    create: scoped({
      businessName: DEMO_NAME,
      timezone: "America/Chicago",
      currency: "USD",
      taxRate: TAX_RATE,
      addressLine1: "4200 S Congress Ave",
      addressLine2: "Building C",
      city: "Austin",
      state: "TX",
      zip: "78745",
      country: "USA",
      phone: "(512) 555-0180",
      website: "https://www.routeflow.info",
      ownerName: "RouteFlow Demo",
      customerEmail: "demo@routeflow.example.com",
      invoiceTerms: `Net ${PAYMENT_TERMS_DAYS}`,
      invoiceNotes: "Thank you for your business.",
    }),
    update: { businessName: DEMO_NAME, taxRate: TAX_RATE },
  });

  // Dispatch/driver/route UI is hidden for every tenant WITHOUT the
  // developer_mode addon (#380). The demo's driver walkthrough depends on it,
  // so a from-scratch reseed must re-create the row or the demo silently loses
  // its driver screens. Row shape matches AddonService.hasAddon (see
  // apps/api/scripts/e2e-seed.js ensureDeveloperMode).
  await prisma.tenantAddon.upsert({
    where: { tenantId_addonKey: { tenantId: DEMO_TENANT_ID, addonKey: "developer_mode" } },
    create: {
      tenantId: DEMO_TENANT_ID,
      addonKey: "developer_mode",
      stripePriceId: null,
      stripeItemId: null,
      active: true,
    },
    update: { active: true },
  });
  console.log("   ✓ Developer mode addon active (driver/dispatch demo screens)");

  // At-door payment collection is per-tenant opt-in (driver_payments addon,
  // 2026-08-24). The demo walkthrough shows the driver collecting cash at the
  // door, so the demo tenant needs the addon or payment.tsx degrades to the
  // on-account completion path.
  await prisma.tenantAddon.upsert({
    where: { tenantId_addonKey: { tenantId: DEMO_TENANT_ID, addonKey: "driver_payments" } },
    create: {
      tenantId: DEMO_TENANT_ID,
      addonKey: "driver_payments",
      stripePriceId: null,
      stripeItemId: null,
      active: true,
    },
    update: { active: true },
  });
  console.log("   ✓ Driver payments addon active (at-door collection demo)");

  for (const cat of IRS_SYSTEM_CATEGORIES) {
    await prisma.expenseCategory.upsert({
      where: { tenantId_code: { tenantId: DEMO_TENANT_ID, code: cat.code } },
      create: scoped({ name: cat.name, code: cat.code, isCustom: false }),
      update: { name: cat.name },
    });
  }
}

async function ensureStaff() {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const operatorId = stableId("user", OPERATOR_USERNAME);
  await prisma.user.upsert({
    where: { id: operatorId },
    create: scoped({
      id: operatorId,
      email: "owner@routeflow-demo.example.com",
      username: OPERATOR_USERNAME,
      password: hash,
      role: "TENANT_ADMIN",
      status: "ACTIVE",
      isAdmin: true,
      canActAsDriver: true,
      forcePasswordChange: false,
    }),
    update: { password: hash, status: "ACTIVE", role: "TENANT_ADMIN", deletedAt: null },
  });

  const driverUserId = stableId("user", DRIVER_USERNAME);
  await prisma.user.upsert({
    where: { id: driverUserId },
    create: scoped({
      id: driverUserId,
      email: "driver@routeflow-demo.example.com",
      username: DRIVER_USERNAME,
      password: hash,
      role: "DRIVER",
      status: "ACTIVE",
      canActAsDriver: true,
      forcePasswordChange: false,
    }),
    update: { password: hash, status: "ACTIVE", deletedAt: null },
  });

  // Both staff users get a Driver row, mirroring what platform-admin tenant
  // creation does, so either can run a route in the mobile app.
  const drivers = [
    { userId: operatorId, key: "operator", contactName: "Sam Okafor", phone: "(512) 555-0181" },
    { userId: driverUserId, key: "driver", contactName: "Luis Moreno", phone: "(512) 555-0182" },
  ];
  const driverIds = {};
  for (const d of drivers) {
    const id = stableId("driver", d.key);
    await prisma.driver.upsert({
      where: { id },
      create: scoped({
        id,
        userId: d.userId,
        contactName: d.contactName,
        phone: d.phone,
        status: "ACTIVE",
        vehicleMake: d.key === "driver" ? "Ford" : "Ram",
        vehicleModel: d.key === "driver" ? "Transit 250" : "ProMaster 1500",
        vehicleColour: "White",
        vehiclePlate: d.key === "driver" ? "DEMO-142" : "DEMO-118",
      }),
      update: { contactName: d.contactName, status: "ACTIVE" },
    });
    driverIds[d.key] = id;
  }
  return { operatorId, driverUserId, driverIds };
}

async function ensureSuppliers() {
  const ids = {};
  for (const s of SUPPLIERS) {
    const id = stableId("supplier", s.key);
    await prisma.supplier.upsert({
      where: { id },
      create: scoped({
        id,
        name: s.name,
        contactName: s.contactName,
        email: s.email,
        phone: s.phone,
        addressLine1: s.line1,
        city: s.city,
        state: s.state,
        zip: s.zip,
        country: "USA",
        leadTimeDays: s.leadTimeDays,
        isActive: true,
      }),
      update: { name: s.name, isActive: true },
    });
    ids[s.key] = id;
  }
  return ids;
}

// Deterministic Austin-area spread — no randomness, so re-seeding is idempotent.
// Gives every demo customer address a lat/lng so the trip-builder optimizer's
// local NN+2-opt fallback works even with no GOOGLE_MAPS_API_KEY configured.
const DEMO_ORIGIN = { lat: 30.2672, lng: -97.7431 }; // downtown Austin
function demoAddressCoords(index) {
  const row = index % 7;
  const col = Math.floor(index / 7) % 7;
  return {
    lat: DEMO_ORIGIN.lat + (row - 3) * 0.015, // ~1.6 km N-S steps
    lng: DEMO_ORIGIN.lng + (col - 3) * 0.018, // ~1.7 km E-W steps
  };
}

async function ensureCustomers() {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const out = [];
  for (const [index, c] of CUSTOMERS.entries()) {
    const userId = stableId("user", c.username);
    const customerId = stableId("customer", c.key);
    const addressId = stableId("address", c.key);
    const coords = demoAddressCoords(index);

    await prisma.user.upsert({
      where: { id: userId },
      create: scoped({
        id: userId,
        // A customer's login email is a separate field from the customer record's
        // contact email; both carry the real address for the owner's account so
        // the buyer-portal email match succeeds.
        email: c.email,
        username: c.username,
        password: hash,
        role: "CUSTOMER",
        status: "ACTIVE",
        forcePasswordChange: false,
      }),
      update: { password: hash, email: c.email, status: "ACTIVE", deletedAt: null },
    });

    await prisma.customer.upsert({
      where: { id: customerId },
      create: scoped({
        id: customerId,
        userId,
        businessName: c.businessName,
        contactName: c.contactName,
        email: c.email,
        phone: c.phone,
        mobile: c.mobile,
        customerType: "BUSINESS",
        fulfillPath: c.fulfillPath,
        pricingTier: c.pricingTier,
        creditLimit: c.creditLimit,
        currency: "USD",
        deliveryWindowStart: "08:00",
        deliveryWindowEnd: "16:00",
      }),
      update: {
        businessName: c.businessName,
        contactName: c.contactName,
        email: c.email,
        pricingTier: c.pricingTier,
        creditLimit: c.creditLimit,
        fulfillPath: c.fulfillPath,
        deletedAt: null,
      },
    });

    await prisma.customerAddress.upsert({
      where: { id: addressId },
      create: scoped({
        id: addressId,
        customerId,
        label: "Store",
        line1: c.address.line1,
        city: c.address.city,
        state: c.address.state,
        zip: c.address.zip,
        lat: coords.lat,
        lng: coords.lng,
        isDefault: true,
        addressType: "SHIPPING",
      }),
      update: { line1: c.address.line1, lat: coords.lat, lng: coords.lng, isDefault: true },
    });

    out.push({ ...c, userId, customerId, addressId });
  }
  return out;
}

async function ensureRoutes(customers, driverIds) {
  const byKey = new Map(customers.map((c) => [c.key, c]));
  const built = [];
  for (const r of ROUTES) {
    const routeId = stableId("route", r.key);
    const driverId = r.key === "north-austin" ? driverIds.driver : driverIds.operator;
    await prisma.route.upsert({
      where: { id: routeId },
      create: scoped({
        id: routeId,
        name: r.name,
        driverId,
        isActive: true,
        depotAddress: "4200 S Congress Ave, Austin, TX 78745",
      }),
      update: { name: r.name, isActive: true },
    });

    let stopNumber = 0;
    const stops = [];
    for (const ck of r.customers) {
      const c = byKey.get(ck);
      if (!c) continue;
      stopNumber += 1;
      const rcId = stableId("route-customer", `${r.key}:${ck}`);
      await prisma.routeCustomer.upsert({
        where: { id: rcId },
        create: scoped({ id: rcId, routeId, customerId: c.customerId }),
        update: {},
      });
      const rsId = stableId("route-stop", `${r.key}:${ck}`);
      await prisma.routeStop.upsert({
        where: { id: rsId },
        create: scoped({
          id: rsId,
          routeId,
          customerId: c.customerId,
          customerAddressId: c.addressId,
          stopNumber,
        }),
        update: { stopNumber, customerAddressId: c.addressId },
      });
      stops.push({
        id: rsId,
        customerId: c.customerId,
        customerAddressId: c.addressId,
        stopNumber,
      });
    }
    built.push({ key: r.key, routeId, driverId, stops });
  }
  return built;
}

/**
 * Runs for each route: two already completed, plus one scheduled today and one
 * tomorrow. The dashboard's route panel queries SCHEDULED runs with no date
 * filter, so without these it renders an empty "no runs scheduled" card.
 */
async function writeRouteRuns(routes) {
  let count = 0;
  for (const route of routes) {
    if (route.stops.length === 0) continue;
    const runs = [
      { key: "past-2", date: daysAgo(5), status: "COMPLETED" },
      { key: "past-1", date: daysAgo(2), status: "COMPLETED" },
      { key: "today", date: daysAgo(0), status: "SCHEDULED" },
      { key: "tomorrow", date: addDays(daysAgo(0), 1), status: "SCHEDULED" },
    ];
    for (const run of runs) {
      const runId = stableId("route-run", `${route.key}:${run.key}`);
      const done = run.status === "COMPLETED";
      await prisma.routeRun.create({
        data: scoped({
          id: runId,
          routeId: route.routeId,
          driverId: route.driverId,
          status: run.status,
          scheduledDate: run.date,
          startTime: "08:00",
          depotAddress: "4200 S Congress Ave, Austin, TX 78745",
          startedAt: done ? run.date : null,
          completedAt: done ? addDays(run.date, 0) : null,
          createdAt: run.date,
        }),
      });
      await prisma.routeRunStop.createMany({
        data: route.stops.map((s) =>
          scoped({
            id: stableId("route-run-stop", `${route.key}:${run.key}:${s.stopNumber}`),
            routeRunId: runId,
            routeStopId: s.id,
            customerId: s.customerId,
            customerAddressId: s.customerAddressId,
            stopNumber: s.stopNumber,
            status: done ? "COMPLETED" : "PENDING",
            arrivedAt: done ? run.date : null,
            completedAt: done ? run.date : null,
          }),
        ),
      });
      count += 1;
    }
  }
  return count;
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

/**
 * Copy the source tenant's regulated sections/subsections so the demo catalog
 * keeps its classification (and the regulated reporting screens have data).
 * The source tenant's OWN licence/permit number is deliberately not copied.
 */
async function copyTrackedCategories(sourceProducts) {
  const catIds = [...new Set(sourceProducts.map((p) => p.trackedCategoryId).filter(Boolean))];
  const subIds = [...new Set(sourceProducts.map((p) => p.trackedSubcategoryId).filter(Boolean))];
  if (catIds.length === 0) return { catMap: new Map(), subMap: new Map(), categories: new Map() };

  const sourceCats = await prisma.trackedCategory.findMany({
    where: { id: { in: catIds }, tenantId: SOURCE_TENANT_ID },
  });
  const catMap = new Map();
  const categories = new Map();
  for (const c of sourceCats) {
    const id = stableId("tracked-category", c.name);
    catMap.set(c.id, id);
    await prisma.trackedCategory.upsert({
      where: { id },
      create: scoped({
        id,
        name: c.name,
        taxType: c.taxType,
        rate: c.rate,
        unitBasis: c.unitBasis,
        priceIncludesTax: c.priceIncludesTax,
        invoiceTreatment: c.invoiceTreatment,
        requiresLicense: c.requiresLicense,
        requiresAgeCheck: c.requiresAgeCheck,
        requiresIdCheck: c.requiresIdCheck,
        reportTemplate: c.reportTemplate,
        reportCadence: c.reportCadence,
        txItemType: c.txItemType,
        txUom: c.txUom,
        // Never copied: that is the source tenant's real state permit number.
        wholesalerLicenseNo: null,
        active: true,
      }),
      update: { taxType: c.taxType, rate: c.rate, active: true },
    });
    categories.set(id, {
      id,
      name: c.name,
      taxType: c.taxType,
      rate: Number(c.rate ?? 0),
      priceIncludesTax: c.priceIncludesTax,
      invoiceTreatment: c.invoiceTreatment,
      requiresLicense: c.requiresLicense,
    });
  }

  const subMap = new Map();
  if (subIds.length > 0) {
    const sourceSubs = await prisma.trackedSubcategory.findMany({
      where: { id: { in: subIds }, tenantId: SOURCE_TENANT_ID },
    });
    for (const s of sourceSubs) {
      const parentId = catMap.get(s.trackedCategoryId);
      if (!parentId) continue;
      const id = stableId("tracked-subcategory", `${parentId}:${s.name}`);
      subMap.set(s.id, id);
      await prisma.trackedSubcategory.upsert({
        where: { id },
        create: scoped({ id, trackedCategoryId: parentId, name: s.name, active: true }),
        update: { active: true },
      });
    }
  }
  return { catMap, subMap, categories };
}

async function copyProducts(sourceProducts, descriptions, catMap, subMap) {
  const idFor = (sourceId) => stableId("product", sourceId);
  const copiedSourceIds = new Set(sourceProducts.map((p) => p.id));

  const rows = sourceProducts.map((p, i) => {
    const staged = descriptions[p.id];
    // A parent variant is only carried over when the parent is itself in the
    // copied set — otherwise the row would point at a product that never exists.
    const parentCopied = p.parentProductId && copiedSourceIds.has(p.parentProductId);
    return scoped({
      id: idFor(p.id),
      name: p.name,
      description: staged?.description ?? p.description ?? null,
      sku: p.sku,
      unitSku: p.unitSku,
      unit: p.unit,
      pricePerUnit: p.pricePerUnit,
      priceTier2: p.priceTier2,
      priceTier3: p.priceTier3,
      priceTier4: p.priceTier4,
      priceTier5: p.priceTier5,
      category: p.category,
      barcode: p.barcode,
      unitsPerBox: p.unitsPerBox,
      costingMethod: p.costingMethod,
      standardCost: p.standardCost,
      reorderPoint: p.reorderPoint ?? 12,
      reorderQty: p.reorderQty ?? 24,
      isTobacco: p.isTobacco,
      regItemType: p.regItemType,
      regUomCase: p.regUomCase,
      regUomUnit: p.regUomUnit,
      trackedCategoryId: p.trackedCategoryId ? (catMap.get(p.trackedCategoryId) ?? null) : null,
      trackedSubcategoryId: p.trackedSubcategoryId
        ? (subMap.get(p.trackedSubcategoryId) ?? null)
        : null,
      parentProductId: parentCopied ? idFor(p.parentProductId) : null,
      variantName: parentCopied ? p.variantName : null,
      isActive: true,
      // A deterministic sprinkle so the storefront's Featured / New / Deal rails
      // are not empty.
      isFeatured: i % 37 === 0,
      isNew: i % 23 === 0,
      isDeal: i % 41 === 0,
      currentStock: 0,
      averageCost: p.averageCost,
      detailsIncomplete: false,
    });
  });

  const existing = await prisma.product.findMany({
    where: { tenantId: DEMO_TENANT_ID },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((r) => r.id));

  // Parents must exist before children can point at them.
  const fresh = rows.filter((r) => !existingIds.has(r.id));
  const parents = fresh.filter((r) => r.parentProductId === null);
  const children = fresh.filter((r) => r.parentProductId !== null);
  for (const batch of [parents, children]) {
    for (let i = 0; i < batch.length; i += 200) {
      await prisma.product.createMany({ data: batch.slice(i, i + 200), skipDuplicates: true });
    }
  }
  for (const r of rows.filter((x) => existingIds.has(x.id))) {
    const { id, ...data } = r;
    // currentStock is re-derived from the rebuilt movements below; never clobber
    // it here or a refresh would double-count.
    delete data.currentStock;
    await prisma.product.update({ where: { id }, data });
  }

  // createMany(skipDuplicates) drops rows that collide on a unique constraint, so
  // work from what the database actually holds — an order line pointing at a
  // product that was skipped would fail on its foreign key.
  const landed = await prisma.product.findMany({
    where: { tenantId: DEMO_TENANT_ID },
    select: { id: true },
  });
  const landedIds = new Set(landed.map((r) => r.id));
  const kept = rows.filter((r) => landedIds.has(r.id));
  if (kept.length !== rows.length) {
    console.log(
      `   ⚠ ${rows.length - kept.length} product(s) skipped on a unique-constraint clash`,
    );
  }
  return kept;
}

// ─── Transactional rebuild ────────────────────────────────────────────────────

/**
 * Delete every transactional row belonging to the demo tenant, honouring FK
 * order (ledger → payments → credit notes → invoice lines → invoices → order
 * lines → orders → stock movements). Foundation rows are left alone so product
 * ids — and therefore already-uploaded images — survive.
 *
 * Children are matched on their OWN tenantId **or their parent's**. Filtering on
 * tenantId alone is not safe: a child written through a nested create can land
 * with tenantId NULL (the forTenant extension only stamps the top level — see
 * prisma.service.ts), and such a row then survives the delete and blocks its
 * parent with a foreign-key error. This bit the refresh for real: four OrderItem
 * rows edited through the app outlived the sweep and broke the order delete.
 */
async function clearTransactions() {
  const tenantId = DEMO_TENANT_ID;
  const where = { tenantId };
  /** Own tenantId, or reachable through the named parent relation. */
  const orVia = (relation) => ({ OR: [{ tenantId }, { [relation]: { tenantId } }] });

  const counts = {};
  counts.ledger = (await prisma.regulatedSalesLedger.deleteMany({ where })).count;
  counts.payments = (await prisma.invoicePayment.deleteMany({ where: orVia("invoice") })).count;
  counts.creditNotes = (await prisma.creditNote.deleteMany({ where: orVia("customer") })).count;
  counts.invoiceItems = (await prisma.invoiceItem.deleteMany({ where: orVia("invoice") })).count;
  counts.invoices = (await prisma.invoice.deleteMany({ where: orVia("customer") })).count;
  counts.orderItems = (await prisma.orderItem.deleteMany({ where: orVia("order") })).count;
  counts.orders = (await prisma.order.deleteMany({ where: orVia("customer") })).count;
  counts.routeRunStops = (await prisma.routeRunStop.deleteMany({ where: orVia("routeRun") })).count;
  counts.routeRuns = (await prisma.routeRun.deleteMany({ where: orVia("route") })).count;
  counts.movements = (await prisma.stockMovement.deleteMany({ where: orVia("product") })).count;
  await prisma.paymentCounter.deleteMany({ where: { id: DEMO_TENANT_ID } });
  return counts;
}

/**
 * Where an order of a given age sits in the pipeline. Old orders are done; the
 * last few days hold the live workload. A distributor also delivers same-day off
 * the route, so the newest days carry a mix rather than only unfulfilled orders
 * — that mix is what puts revenue on today's dashboard.
 */
function orderStatusFor(d) {
  if (d >= 12) return chance(0.05) ? "CANCELLED" : "DELIVERED";
  if (d >= 7) return chance(0.3) ? "PARTIALLY_DELIVERED" : "DELIVERED";
  if (d >= 3) return chance(0.4) ? "OUT_FOR_DELIVERY" : "CONFIRMED";
  if (d >= 1) return chance(0.4) ? "DELIVERED" : "PENDING";
  if (chance(0.35)) return "DELIVERED";
  if (chance(0.4)) return "OUT_FOR_DELIVERY";
  return chance(0.6) ? "PENDING" : "DRAFT";
}

/** Build every order in memory first, so opening stock can be sized to cover it. */
function planOrders(customers, products) {
  const sellable = products.filter((p) => Number(p.pricePerUnit) > 0);
  if (sellable.length === 0) fail("No sellable products — every copied product has price 0.");

  // A small set of repeat sellers gives the demand chart a believable shape
  // instead of a flat line of one-off SKUs.
  const heroes = sellable.filter((_, i) => i % 11 === 0).slice(0, 60);

  const weighted = [];
  customers.forEach((c) => {
    for (let i = 0; i < Math.round(c.weight * 100); i++) weighted.push(c);
  });

  const plans = [];
  for (let d = HISTORY_DAYS; d >= 0; d--) {
    const date = daysAgo(d);
    if (date.getUTCDay() === 0) continue; // closed Sundays
    // The last fortnight runs denser so the operations screens (confirmed, out
    // for delivery, pending) open onto a real workload rather than one row.
    const n = d >= 12 ? (chance(0.62) ? 1 : chance(0.35) ? 2 : 0) : chance(0.55) ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const customer = pick(weighted);
      const status = orderStatusFor(d);

      const lineCount = randInt(3, 9);
      const chosen = new Map();
      while (chosen.size < lineCount) {
        const p = chance(0.55) && heroes.length > 0 ? pick(heroes) : pick(sellable);
        if (!chosen.has(p.id)) chosen.set(p.id, p);
      }

      const lines = [...chosen.values()].map((p, index) => {
        const upb = Number(p.unitsPerBox ?? 0);
        const tier = getTierPrice(p, customer.pricingTier);
        const unitPrice = roundMoney(tier);
        const qtyInput =
          upb > 1
            ? {
                boxes: randInt(1, 3),
                pieces: chance(0.25) ? randInt(1, upb - 1) : 0,
                unitsPerBox: upb,
              }
            : { qty: randInt(2, 12) };
        const norm = normalizeBoxesPieces(qtyInput);
        const subtotal = computeLineSubtotal({
          unitPrice,
          qty: norm.qty,
          boxes: norm.boxes,
          pieces: norm.pieces,
          unitsPerBox: upb > 1 ? upb : null,
        });
        return {
          product: p,
          productId: p.id,
          qty: norm.qty,
          boxes: norm.boxes,
          pieces: norm.pieces,
          unitsPerBox: norm.boxes != null && upb > 1 ? upb : null,
          unitPrice,
          subtotal,
          trackedCategoryId: p.trackedCategoryId ?? null,
          trackedSubcategoryId: p.trackedSubcategoryId ?? null,
          position: index,
        };
      });

      plans.push({ daysAgo: d, orderDate: date, customer, status, lines });
    }
  }

  // The dice can leave today with nothing delivered, which shows a demo a $0
  // revenue tile. Guarantee at least one same-day delivery.
  const today = plans.filter((p) => p.daysAgo === 0);
  if (today.length > 0 && !today.some((p) => p.status === "DELIVERED")) {
    today[0].status = "DELIVERED";
  }
  return plans;
}

/** Fold the regulated per-line tax and assemble order money exactly as orders.service does. */
function priceOrder(plan, categories) {
  for (const line of plan.lines) {
    const cat = line.trackedCategoryId ? categories.get(line.trackedCategoryId) : null;
    line.categoryTaxAmount =
      cat && cat.taxType !== "NONE"
        ? computeCategoryTax({
            taxType: cat.taxType,
            rate: cat.rate,
            unitBasisQty: line.qty,
            lineSubtotal: line.subtotal,
            priceIncludesTax: cat.priceIncludesTax,
          })
        : 0;
  }
  const subtotal = roundMoney(plan.lines.reduce((s, l) => s + l.subtotal, 0));
  const tax = roundMoney(subtotal * TAX_RATE);
  const categoryTax = roundMoney(plan.lines.reduce((s, l) => s + l.categoryTaxAmount, 0));
  // Ship-to accounts carry a freight line; route customers never do.
  const shippingFee = plan.customer.fulfillPath === "SHIP" ? roundMoney(12.5 + randInt(0, 15)) : 0;
  const total = roundMoney(subtotal + tax + categoryTax + shippingFee);
  return { ...plan, subtotal, tax, categoryTax, shippingFee, total };
}

async function writeOrders(pricedPlans) {
  const created = [];
  let seq = 0;
  for (const plan of pricedPlans) {
    seq += 1;
    const orderNumber = `ORD-${String(seq).padStart(5, "0")}`;
    const orderId = stableId("order", orderNumber);
    const isDelivered = plan.status === "DELIVERED" || plan.status === "PARTIALLY_DELIVERED";
    const itemStatus =
      plan.status === "CANCELLED"
        ? "CANCELLED"
        : plan.status === "DELIVERED"
          ? "DELIVERED"
          : plan.status === "PARTIALLY_DELIVERED"
            ? "PARTIAL"
            : plan.status === "DRAFT" || plan.status === "PENDING"
              ? "PENDING"
              : "CONFIRMED";

    await prisma.order.create({
      data: scoped({
        id: orderId,
        customerId: plan.customer.customerId,
        orderNumber,
        status: plan.status,
        source: chance(0.35) ? "APP" : chance(0.5) ? "PHONE" : "ROUTE",
        subtotal: plan.subtotal,
        tax: plan.tax,
        total: plan.total,
        discountAmount: 0,
        shippingFee: plan.shippingFee,
        orderDate: plan.orderDate,
        createdAt: plan.orderDate,
        requestedDeliveryDate: addDays(plan.orderDate, 1),
        deliveredAt: isDelivered ? addDays(plan.orderDate, 1) : null,
        hasRegulated: plan.lines.some((l) => l.trackedCategoryId),
      }),
    });

    const itemRows = plan.lines.map((l) => {
      const id = stableId("order-item", `${orderNumber}:${l.productId}`);
      // PARTIALLY_DELIVERED bills only what actually went out; DELIVERED bills
      // the full line. Everything else is not billable yet.
      const deliveredQty =
        plan.status === "DELIVERED"
          ? l.qty
          : plan.status === "PARTIALLY_DELIVERED"
            ? Math.max(1, Math.floor(l.qty * 0.6))
            : 0;
      return {
        id,
        row: scoped({
          id,
          orderId,
          productId: l.productId,
          status: itemStatus,
          qty: l.qty,
          deliveredQty,
          invoicedQty: 0,
          unitPrice: l.unitPrice,
          subtotal: l.subtotal,
          priceType: "STANDARD",
          boxes: l.boxes,
          pieces: l.pieces,
          unitsPerBox: l.unitsPerBox,
          trackedCategoryId: l.trackedCategoryId,
          trackedSubcategoryId: l.trackedSubcategoryId,
          categoryTaxAmount: l.categoryTaxAmount,
          position: l.position,
        }),
        line: l,
        deliveredQty,
      };
    });
    await prisma.orderItem.createMany({ data: itemRows.map((r) => r.row) });

    created.push({ ...plan, orderId, orderNumber, items: itemRows });
  }
  return created;
}

/**
 * Mirror createSplitInvoices: lines whose regulated section is set to
 * SEPARATE_INVOICE become sibling invoices (`INV-…-R1`) sharing an
 * invoiceGroupId; the order's regular tax is allocated across siblings by
 * subtotal with the rounding remainder — and the whole shipping fee — landing
 * on the largest group.
 */
function planInvoiceGroups(order, categories) {
  const billable = order.items.filter((i) => i.deliveredQty > 0);
  if (billable.length === 0) return [];

  const standard = [];
  const byCat = new Map();
  for (const item of billable) {
    const cat = item.line.trackedCategoryId ? categories.get(item.line.trackedCategoryId) : null;
    if (cat && cat.invoiceTreatment === "SEPARATE_INVOICE") {
      const arr = byCat.get(cat.id) ?? [];
      arr.push(item);
      byCat.set(cat.id, arr);
    } else {
      standard.push(item);
    }
  }

  const groups = [];
  if (standard.length > 0) groups.push({ categoryId: null, items: standard });
  [...byCat.entries()]
    .sort((a, b) =>
      String(categories.get(a[0])?.name ?? "").localeCompare(
        String(categories.get(b[0])?.name ?? ""),
      ),
    )
    .forEach(([categoryId, items]) => groups.push({ categoryId, items }));

  const orderSubtotal = order.subtotal || 1;
  for (const g of groups) {
    g.lines = g.items.map((item) => {
      const l = item.line;
      const ratio = item.deliveredQty / l.qty;
      const norm =
        l.unitsPerBox && l.unitsPerBox > 1
          ? normalizeBoxesPieces({ qty: item.deliveredQty, unitsPerBox: l.unitsPerBox })
          : { boxes: null, pieces: null, qty: item.deliveredQty };
      const subtotal =
        ratio === 1
          ? l.subtotal
          : computeLineSubtotal({
              unitPrice: l.unitPrice,
              qty: norm.qty,
              boxes: norm.boxes,
              pieces: norm.pieces,
              unitsPerBox: l.unitsPerBox,
            });
      return {
        orderItemId: item.id,
        productId: l.productId,
        description: l.product.name,
        qty: norm.qty,
        boxes: norm.boxes,
        pieces: norm.pieces,
        unitsPerBox: l.unitsPerBox,
        unitPrice: l.unitPrice,
        subtotal,
        categoryTaxAmount:
          ratio === 1 ? l.categoryTaxAmount : roundMoney(l.categoryTaxAmount * ratio),
        trackedCategoryId: l.trackedCategoryId,
        trackedSubcategoryId: l.trackedSubcategoryId,
      };
    });
    g.subtotal = roundMoney(g.lines.reduce((s, l) => s + l.subtotal, 0));
    g.categoryTax = roundMoney(g.lines.reduce((s, l) => s + l.categoryTaxAmount, 0));
    g.regularTax = roundMoney(order.tax * (g.subtotal / orderSubtotal));
  }

  const totalSubtotal = roundMoney(groups.reduce((s, g) => s + g.subtotal, 0));
  const totalRegularTax = roundMoney(order.tax * (totalSubtotal / orderSubtotal));
  const allocated = groups.reduce((s, g) => roundMoney(s + g.regularTax), 0);
  let largest = 0;
  for (let i = 1; i < groups.length; i++)
    if (groups[i].subtotal > groups[largest].subtotal) largest = i;
  const remainder = roundMoney(totalRegularTax - allocated);
  if (remainder !== 0)
    groups[largest].regularTax = roundMoney(groups[largest].regularTax + remainder);
  if (order.shippingFee > 0) groups[largest].shippingFee = order.shippingFee;

  for (const g of groups) {
    g.shippingFee = g.shippingFee ?? 0;
    g.taxAmount = roundMoney(g.regularTax + g.categoryTax);
    g.total = roundMoney(g.subtotal + g.taxAmount + g.shippingFee);
  }
  return groups;
}

/** Where an invoice sits in its life: older invoices are settled, recent ones are not. */
function invoiceOutcome(order) {
  const d = order.daysAgo;
  // Today's deliveries are paid on the spot, so the dashboard's revenue-today
  // and payments-received tiles are never a flat zero during a demo.
  if (d <= 1) return "PAID";
  if (d >= 35) return chance(0.9) ? "PAID" : "PARTIAL";
  // Past Net-15 but not yet chased: this band is where a real ledger keeps its
  // late payers, and it is the only band that can produce an OVERDUE invoice
  // (younger ones are not due yet, older ones have been collected). Leaving a
  // good share of it untouched is what fills the AR aging report.
  if (d >= PAYMENT_TERMS_DAYS + 1) return chance(0.45) ? "PAID" : chance(0.5) ? "OPEN" : "PARTIAL";
  if (d >= 10) return chance(0.4) ? "PAID" : chance(0.5) ? "PARTIAL" : "OPEN";
  return chance(0.2) ? "PAID" : "OPEN";
}

/**
 * The stored status for an unpaid or part-paid invoice, matching what
 * invoices.service.ts recomputeStatus would land on: past its due date with a
 * balance outstanding is OVERDUE, not SENT. The dashboard's overdue tile filters
 * on the stored status, so getting this right is what makes it show anything.
 */
function storedInvoiceStatus(outcome, dueDate) {
  if (outcome === "PAID") return "PAID";
  // recomputeStatus checks "any payment at all" BEFORE it checks the due date, so
  // a part-paid invoice stays PARTIAL even once it is late. Only an untouched
  // invoice past its due date becomes OVERDUE.
  if (outcome === "PARTIAL") return "PARTIAL";
  return dueDate < RUN_AT ? "OVERDUE" : "SENT";
}

async function writeInvoicesAndPayments(orders, categories) {
  const year = RUN_AT.getUTCFullYear();
  let invoiceSeq = 0;
  let paymentSeq = 0;
  const tenantShort = DEMO_TENANT_ID.slice(0, 6).toUpperCase();
  const stats = { invoices: 0, siblings: 0, payments: 0, ledgerRows: 0, byStatus: {} };

  for (const order of orders) {
    if (order.status !== "DELIVERED" && order.status !== "PARTIALLY_DELIVERED") continue;
    const groups = planInvoiceGroups(order, categories);
    if (groups.length === 0) continue;

    invoiceSeq += 1;
    const baseNumber = `INV-${year}-${String(invoiceSeq).padStart(4, "0")}`;
    const invoiceGroupId = groups.length > 1 ? stableId("invoice-group", baseNumber) : null;
    const issueDate = order.orderDate;
    const dueDate = addDays(issueDate, PAYMENT_TERMS_DAYS);
    const outcome = invoiceOutcome(order);

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const invoiceNumber = i === 0 ? baseNumber : `${baseNumber}-R${i}`;
      const invoiceId = stableId("invoice", invoiceNumber);
      // Siblings share the parent's outcome so a split order is not half paid,
      // half unpaid — which no real payment run would produce.
      const status = storedInvoiceStatus(outcome, dueDate);
      const sentAt = addDays(issueDate, 1);
      // Never date a payment in the future: a same-day delivery is paid today,
      // not on a due date that has not arrived yet.
      const settleWindow = Math.min(randInt(3, PAYMENT_TERMS_DAYS + 4), Math.max(0, order.daysAgo));
      const paidAt = status === "PAID" ? addDays(issueDate, settleWindow) : null;

      const invoice = await prisma.invoice.create({
        data: scoped({
          id: invoiceId,
          invoiceNumber,
          customerId: order.customer.customerId,
          orderId: order.orderId,
          status,
          subtotal: g.subtotal,
          taxAmount: g.taxAmount,
          discount: 0,
          shippingFee: g.shippingFee,
          total: g.total,
          issueDate,
          createdAt: issueDate,
          dueDate,
          sentAt,
          viewedAt: chance(0.6) ? addDays(sentAt, 1) : null,
          paidAt,
          invoiceGroupId,
          terms: `Net ${PAYMENT_TERMS_DAYS}`,
          items: {
            create: g.lines.map((l) =>
              // Nested creates bypass the tenant extension — stamp every child.
              scoped({
                description: l.description,
                productId: l.productId,
                orderItemId: l.orderItemId,
                qty: l.qty,
                unitPrice: l.unitPrice,
                discount: 0,
                priceType: "STANDARD",
                taxRate: 0,
                subtotal: l.subtotal,
                boxes: l.boxes,
                pieces: l.pieces,
                unitsPerBox: l.unitsPerBox,
                trackedCategoryId: l.trackedCategoryId,
                trackedSubcategoryId: l.trackedSubcategoryId,
                categoryTaxAmount: l.categoryTaxAmount,
              }),
            ),
          },
        }),
        include: { items: true },
      });
      stats.invoices += 1;
      if (i > 0) stats.siblings += 1;
      stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1;

      // Regulated ledger — the source of truth behind the filing screens.
      const ledgerRows = invoice.items
        .filter((it) => it.trackedCategoryId)
        .map((it) =>
          scoped({
            trackedCategoryId: it.trackedCategoryId,
            trackedSubcategoryId: it.trackedSubcategoryId,
            entryType: "SALE",
            orderId: order.orderId,
            orderItemId: it.orderItemId,
            invoiceId: invoice.id,
            invoiceItemId: it.id,
            qty: Number(it.qty),
            unitBasisQty: Number(it.qty),
            netSales: roundMoney(Number(it.subtotal)),
            categoryTax: roundMoney(Number(it.categoryTaxAmount ?? 0)),
            soldAt: issueDate,
            periodBucket: periodBucketOf(issueDate),
          }),
        );
      if (ledgerRows.length > 0) {
        await prisma.regulatedSalesLedger.createMany({ data: ledgerRows });
        stats.ledgerRows += ledgerRows.length;
      }

      if (status === "PAID" || status === "PARTIAL") {
        const amount = status === "PAID" ? g.total : roundMoney(g.total * (randInt(30, 70) / 100));
        const when = paidAt ?? addDays(issueDate, randInt(4, 12));
        const method = chance(0.4) ? "CASH" : chance(0.55) ? "CHECK" : "ACH";
        paymentSeq += 1;
        const paymentNumber = `PAY-${tenantShort}-${String(paymentSeq).padStart(4, "0")}`;
        const checkFields =
          method === "CHECK"
            ? {
                checkStatus: "CLEARED",
                depositedAt: addDays(when, 1),
                clearedAt: addDays(when, 3),
                reference: `${randInt(1200, 9800)}`,
              }
            : { reference: method === "ACH" ? `ACH-${randInt(100000, 999999)}` : null };
        // settledAt is when the money actually landed — the date cash-basis
        // reporting uses; it trails paidAt for cheques and ACH.
        const settledAt =
          method === "CHECK" ? addDays(when, 3) : method === "ACH" ? addDays(when, 2) : when;

        await prisma.invoicePayment.create({
          data: scoped({
            id: stableId("payment", paymentNumber),
            invoiceId: invoice.id,
            amount,
            method,
            paidAt: when,
            settledAt,
            createdAt: when,
            status: "PAID",
            paymentNumber,
            ...checkFields,
          }),
        });
        stats.payments += 1;
      }
    }

    // Mark the order lines as billed, mirroring what invoice generation does.
    for (const item of order.items) {
      if (item.deliveredQty > 0) {
        await prisma.orderItem.update({
          where: { id: item.id },
          data: { invoicedQty: item.deliveredQty },
        });
      }
    }
  }

  if (paymentSeq > 0) {
    await prisma.paymentCounter.create({
      data: scoped({ id: DEMO_TENANT_ID, next: paymentSeq + 1 }),
    });
  }
  return stats;
}

/** A couple of open credits so the apply-credit flow has something to demo. */
async function writeCreditNotes(orders) {
  const candidates = orders.filter((o) => o.status === "DELIVERED").slice(-12);
  if (candidates.length < 2) return 0;
  const picks = [candidates[2], candidates[7] ?? candidates[3]];
  let n = 0;
  for (let i = 0; i < picks.length; i++) {
    const order = picks[i];
    if (!order) continue;
    const number = `CN-${String(i + 1).padStart(4, "0")}`;
    await prisma.creditNote.create({
      data: scoped({
        id: stableId("credit-note", number),
        creditNoteNumber: number,
        customerId: order.customer.customerId,
        amount: i === 0 ? 45 : 120,
        amountUsed: 0,
        status: "ISSUED",
        reason: i === 0 ? "Damaged case on delivery" : "Short-shipped two cartons",
        createdAt: addDays(order.orderDate, 2),
        expiresAt: addDays(order.orderDate, 365),
      }),
    });
    n += 1;
  }
  return n;
}

/**
 * Opening stock: one PURCHASE movement per product sized to cover everything the
 * demo orders consume plus headroom, then set the live stock to what is left.
 * Matches how the app behaves — orders decrement Product.currentStock directly
 * and no SALE movement is written.
 */
async function writeOpeningStock(products, orders, supplierIds, operatorId) {
  const consumed = new Map();
  for (const order of orders) {
    if (order.status === "CANCELLED" || order.status === "DRAFT") continue;
    for (const item of order.items) {
      consumed.set(item.line.productId, (consumed.get(item.line.productId) ?? 0) + item.line.qty);
    }
  }

  const supplierList = Object.values(supplierIds);
  const openedAt = daysAgo(HISTORY_DAYS + 5);
  const movements = [];
  const stockUpdates = [];

  products.forEach((p, i) => {
    const used = consumed.get(p.id) ?? 0;
    const upb = Number(p.unitsPerBox ?? 0) > 1 ? Number(p.unitsPerBox) : 1;
    // Headroom in whole boxes, so the counts read like real receiving. A thin
    // slice is deliberately bought to demand and nothing more, which leaves it
    // depleted or nearly so once the demo orders draw it down — that is what
    // gives the low-stock and reorder screens rows to show. Sizing it here
    // rather than docking the stock afterwards keeps currentStock equal to
    // (opening − sold), so the movement history still explains the balance.
    const runsDry = i % 40 === 0;
    const runsLow = i % 40 === 20;
    const headroom = runsDry ? 0 : runsLow ? upb : upb * randInt(8, 26);
    const opening = Math.max(upb, Math.ceil((used + headroom) / upb) * upb);
    const unitCost =
      Number(p.averageCost) > 0
        ? Number(p.averageCost)
        : Math.round(((Number(p.pricePerUnit) || 1) / upb) * 0.65 * 10000) / 10000;

    movements.push(
      scoped({
        id: stableId("movement", p.id),
        productId: p.id,
        type: "PURCHASE",
        quantity: opening,
        unitCost,
        avgCostAfter: unitCost,
        stockAfter: opening,
        supplierId: supplierList[i % supplierList.length],
        reference: "Opening balance",
        notes: "Demo opening stock",
        performedById: operatorId,
        createdAt: openedAt,
      }),
    );
    stockUpdates.push({
      id: p.id,
      currentStock: Math.max(0, opening - used),
      averageCost: unitCost,
    });
  });

  for (let i = 0; i < movements.length; i += 200) {
    await prisma.stockMovement.createMany({ data: movements.slice(i, i + 200) });
  }
  for (const u of stockUpdates) {
    await prisma.product.update({
      where: { id: u.id },
      data: { currentStock: u.currentStock, averageCost: u.averageCost },
    });
  }
  return movements.length;
}

/** Connect the owner's buyer account if one already exists; otherwise sign-in links it. */
async function linkOwnerBuyerAccount(customers) {
  const owner = customers.find((c) => c.email === OWNER_EMAIL);
  if (!owner) return "no owner customer";
  const account = await prisma.buyerAccount.findUnique({ where: { email: OWNER_EMAIL } });
  if (!account) return "no buyer account yet — signing in will auto-connect";
  await prisma.customerLink.upsert({
    where: { customerId: owner.customerId },
    create: {
      customerId: owner.customerId,
      buyerAccountId: account.id,
      tenantId: DEMO_TENANT_ID,
      status: "ACTIVE",
      linkedAt: new Date(),
    },
    update: {
      buyerAccountId: account.id,
      status: "ACTIVE",
      linkedAt: new Date(),
      disconnectedAt: null,
    },
  });
  return `linked to buyer account ${account.id}`;
}

/**
 * Licence the owner's customer for every regulated section that gates on one.
 *
 * A category with `requiresLicense` blocks a real (non-draft) sale to a customer
 * without a VERIFIED, unexpired CustomerAuthorization — see
 * authorizations/authorization-guard.service.ts. Without this the demo cannot
 * put a tobacco line on an order at all, so the owner's account carries the
 * permit and the other four customers deliberately do not: that contrast IS the
 * feature, and it lets the block be demonstrated on demand.
 *
 * `Customer.tobaccoLicenseNo`/`Expiry` are the separate customer-file fields the
 * UI shows; they are set to match so the record reads consistently.
 */
async function licenseOwnerForRegulated(customers, categories) {
  const owner = customers.find((c) => c.email === OWNER_EMAIL);
  if (!owner) return "no owner customer";
  const gated = [...categories.values()].filter((c) => c.requiresLicense);
  if (gated.length === 0) return "no licence-gated categories in this catalog";

  const licenseNumber = "TX-TOB-4471902";
  const expiresAt = addDays(RUN_AT, 300);

  for (const cat of gated) {
    await prisma.customerAuthorization.upsert({
      where: {
        customerId_trackedCategoryId: {
          customerId: owner.customerId,
          trackedCategoryId: cat.id,
        },
      },
      create: {
        tenantId: DEMO_TENANT_ID,
        customerId: owner.customerId,
        trackedCategoryId: cat.id,
        status: "VERIFIED",
        source: "WHOLESALER_ADDED",
        licenseNumber,
        expiresAt,
        verifiedByName: "RouteFlow Demo",
        verifiedAt: RUN_AT,
      },
      update: {
        status: "VERIFIED",
        licenseNumber,
        expiresAt,
        verifiedByName: "RouteFlow Demo",
        verifiedAt: RUN_AT,
      },
    });
  }

  await prisma.customer.update({
    where: { id: owner.customerId },
    data: { tobaccoLicenseNo: licenseNumber, tobaccoLicenseExpiry: expiresAt },
  });

  return `${owner.businessName} licensed for ${gated.map((c) => c.name).join(", ")} (${licenseNumber}, expires ${expiresAt.toISOString().slice(0, 10)})`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const isRailway = dbUrl.includes("railway") || dbUrl.includes("rlwy");
  console.log(`\n🎬 RouteFlow demo seed — ${LIVE ? "LIVE WRITE" : "DRY RUN (no writes)"}`);
  console.log(
    `   DB:      ${dbUrl.replace(/:\/\/[^@]+@/, "://***@")}${isRailway ? "  ⚠ RAILWAY" : ""}`,
  );
  console.log(`   Demo:    ${DEMO_SLUG}`);
  console.log(`   Assets:  ${ASSETS_DIR}`);

  const { descriptions, productIds } = loadAssets();
  const { source, existing } = await resolveTenants();
  console.log(`   Source:  ${source.slug} (read-only)  id=${source.id}`);
  console.log(
    `   Staged:  ${productIds.length} vetted images, ${Object.keys(descriptions).length} descriptions\n`,
  );

  // Read the source catalog. This is the ONLY read of the source tenant, and it
  // is filtered by its tenant id so a stray manifest key cannot reach elsewhere.
  const sourceProducts = await prisma.product.findMany({
    where: { id: { in: productIds }, tenantId: SOURCE_TENANT_ID },
  });
  const missing = productIds.length - sourceProducts.length;
  console.log(
    `📦 Catalog: ${sourceProducts.length} products resolved from source${missing > 0 ? ` (${missing} manifest ids no longer exist)` : ""}`,
  );
  if (sourceProducts.length === 0) fail("No source products resolved — check DEMO_SOURCE_TENANT.");

  const describedCount = sourceProducts.filter((p) => descriptions[p.id]?.description).length;
  const regulatedCount = sourceProducts.filter((p) => p.trackedCategoryId).length;
  console.log(`   ${describedCount} carry a staged description, ${regulatedCount} are regulated`);

  if (!LIVE) {
    // Price the plan without touching the database so the dry run reports real
    // numbers rather than guesses.
    const fakeCustomers = CUSTOMERS.map((c) => ({ ...c, customerId: stableId("customer", c.key) }));
    const preview = sourceProducts.map((p) => ({
      id: stableId("product", p.id),
      pricePerUnit: p.pricePerUnit,
      priceTier2: p.priceTier2,
      priceTier3: p.priceTier3,
      priceTier4: p.priceTier4,
      priceTier5: p.priceTier5,
      unitsPerBox: p.unitsPerBox,
      trackedCategoryId: p.trackedCategoryId,
      trackedSubcategoryId: p.trackedSubcategoryId,
    }));
    const plans = planOrders(fakeCustomers, preview).map((p) => priceOrder(p, new Map()));
    const revenue = roundMoney(
      plans
        .filter((p) => p.status !== "CANCELLED" && p.status !== "DRAFT")
        .reduce((s, p) => s + p.total, 0),
    );
    const byStatus = {};
    plans.forEach((p) => (byStatus[p.status] = (byStatus[p.status] ?? 0) + 1));
    console.log(`\n👥 Customers: ${CUSTOMERS.length} (owner account: ${OWNER_EMAIL})`);
    console.log(`🚚 Suppliers: ${SUPPLIERS.length}   Routes: ${ROUTES.length}`);
    console.log(
      `🧾 Orders:    ${plans.length} over ${HISTORY_DAYS} days — ${JSON.stringify(byStatus)}`,
    );
    console.log(`💰 Order value (excl. draft/cancelled): $${revenue.toLocaleString()}`);
    console.log(
      `\n   Existing demo tenant: ${existing ? `yes (id ${existing.id}) — transactions would be rebuilt` : "no — would be created"}`,
    );
    console.log(`\n✅ Dry run complete. Re-run with --live to write.\n`);
    return;
  }

  console.log("\n🏗  Foundation…");
  await ensureTenant(existing);
  const { operatorId, driverIds } = await ensureStaff();
  const supplierIds = await ensureSuppliers();
  const customers = await ensureCustomers();
  const routes = await ensureRoutes(customers, driverIds);
  console.log(
    `   tenant + config + ${IRS_SYSTEM_CATEGORIES.length} expense categories, 2 staff, ${SUPPLIERS.length} suppliers, ${customers.length} customers, ${ROUTES.length} routes`,
  );

  console.log("🧹 Clearing previous demo transactions…");
  const cleared = await clearTransactions();
  console.log(`   ${JSON.stringify(cleared)}`);

  console.log("🏷  Catalog…");
  const { catMap, subMap, categories } = await copyTrackedCategories(sourceProducts);
  const products = await copyProducts(sourceProducts, descriptions, catMap, subMap);
  console.log(`   ${products.length} products, ${categories.size} regulated sections`);

  console.log("🧾 Orders…");
  const plans = planOrders(customers, products).map((p) => priceOrder(p, categories));
  const orders = await writeOrders(plans);
  console.log(
    `   ${orders.length} orders, ${orders.reduce((s, o) => s + o.items.length, 0)} lines`,
  );

  console.log("📦 Opening stock…");
  const movementCount = await writeOpeningStock(products, orders, supplierIds, operatorId);
  console.log(`   ${movementCount} opening PURCHASE movements`);

  console.log("🚚 Route runs…");
  const runCount = await writeRouteRuns(routes);
  console.log(`   ${runCount} runs across ${routes.length} routes`);

  console.log("💵 Invoices + payments…");
  const stats = await writeInvoicesAndPayments(orders, categories);
  console.log(
    `   ${stats.invoices} invoices (${stats.siblings} regulated siblings) ${JSON.stringify(stats.byStatus)}`,
  );
  console.log(`   ${stats.payments} payments, ${stats.ledgerRows} regulated ledger rows`);

  const credits = await writeCreditNotes(orders);
  const linkNote = await linkOwnerBuyerAccount(customers);
  const licenceNote = await licenseOwnerForRegulated(customers, categories);
  console.log(`   ${credits} open credit notes`);
  console.log(`🔗 Buyer portal: ${linkNote}`);
  console.log(`🪪 Regulated licence: ${licenceNote}`);

  console.log(`\n✅ Demo tenant ready.`);
  console.log(`   Operator login: ${OPERATOR_USERNAME} / ${DEMO_PASSWORD}  (tenant ${DEMO_SLUG})`);
  console.log(
    `   Next: node apps/api/scripts/demo-seed-images.js --live   (uploads the product photos)\n`,
  );
}

main()
  .catch((e) => {
    console.error("\n❌ Demo seed failed:", e?.message ?? e);
    if (e?.stack) console.error(e.stack.split("\n").slice(1, 6).join("\n"));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
