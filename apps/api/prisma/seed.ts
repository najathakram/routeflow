import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { assertTestTenant } from "../../../scripts/lib/test-tenants.cjs";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const SALT_ROUNDS = 10;
const PASSWORD = "Test@1234";
const today = new Date();
today.setHours(0, 0, 0, 0);

/**
 * Every row below is tenant-scoped: the API reads `tenantId` off the JWT and
 * filters each query by it, so a row written without one is invisible to the
 * app even though the insert succeeds. `test` is an approved test-tenant slug
 * (see CLAUDE.md "Test tenants & real-client data") — assertTestTenant() below
 * is what stops this script ever pointing at a live client.
 */
const TENANT_SLUG = "test";

/**
 * assertTestTenant() vets the SLUG; nothing vetted the DATABASE. Before the
 * multi-tenant fix this script died on its first query, so a stray prod
 * DATABASE_URL was harmless. Now that it runs, the same slip would write a
 * "test" tenant — 7 users, 15 products, 10 orders — straight into a live
 * database. CLAUDE.md already promises seeds are "BLOCKED by production
 * guard"; this is that guard.
 *
 * Local Postgres runs unattended. Anything else (Railway, a staging proxy)
 * needs SEED_ALLOW_REMOTE=1, so reaching a remote database is always a
 * deliberate act rather than a leftover env var.
 */
function assertSafeTarget(): void {
  const url = process.env.DATABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL is missing or unparseable — refusing to seed.");
  }
  const isLocal = ["localhost", "127.0.0.1", "::1", "postgres"].includes(host);
  const override = process.env.SEED_ALLOW_REMOTE === "1";

  console.log(`seed target: ${host} (tenant "${TENANT_SLUG}")`);

  if (process.env.NODE_ENV === "production" && !override) {
    throw new Error(
      `Refusing to seed with NODE_ENV=production (host ${host}). ` +
        `Set SEED_ALLOW_REMOTE=1 only if you truly mean to seed this database.`,
    );
  }
  if (!isLocal && !override) {
    throw new Error(
      `Refusing to seed the non-local database at ${host}. ` +
        `Set SEED_ALLOW_REMOTE=1 only if you truly mean to seed it.`,
    );
  }
}

async function main() {
  assertSafeTarget();

  // ─── Hash passwords ───────────────────────────────────────────────────────────
  const [adminHash, devHash] = await Promise.all([
    bcrypt.hash("Admin@123", SALT_ROUNDS),
    bcrypt.hash(PASSWORD, SALT_ROUNDS),
  ]);

  // ─── Tenant ───────────────────────────────────────────────────────────────────
  assertTestTenant(TENANT_SLUG);
  const tenant = await prisma.tenant.upsert({
    where: { slug: TENANT_SLUG },
    update: {},
    create: {
      slug: TENANT_SLUG,
      name: "RouteFlow Test Co.",
      status: "ACTIVE",
      plan: "PROFESSIONAL",
    },
  });
  const tenantId = tenant.id;

  // ─── Operator ─────────────────────────────────────────────────────────────────
  const adminUser = await prisma.user.upsert({
    where: { tenantId_username: { tenantId, username: "admin" } },
    update: { password: adminHash },
    create: {
      tenantId,
      email: "maria.garza@routeflow.dev",
      username: "admin",
      password: adminHash,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
    },
  });

  // ─── Add-ons ────────────────────────────────────────────────────────────────
  // This tenant seeds drivers, routes and delivery orders below, so it must carry
  // the matching entitlements — otherwise the AddonGuard 403s the very features we
  // seed (e.g. GET /drivers requires "order_delivery" | "recurring_routes"). Mirrors
  // the standing demo tenant (apps/api/scripts/demo-seed.js). `update: {}` preserves
  // any admin toggle on reseed.
  await Promise.all(
    ["order_delivery", "recurring_routes"].map((addonKey) =>
      prisma.tenantAddon.upsert({
        where: { tenantId_addonKey: { tenantId, addonKey } },
        create: { tenantId, addonKey, active: true },
        update: {},
      }),
    ),
  );

  // ─── Drivers ──────────────────────────────────────────────────────────────────
  const [carlosUser, jamesUser] = await Promise.all([
    prisma.user.upsert({
      where: { tenantId_username: { tenantId, username: "carlos.r" } },
      update: { password: devHash },
      create: {
        tenantId,
        email: "carlos.reyes@routeflow.dev",
        username: "carlos.r",
        password: devHash,
        role: "DRIVER",
        status: "ACTIVE",
        forcePasswordChange: false,
      },
    }),
    prisma.user.upsert({
      where: { tenantId_username: { tenantId, username: "james.t" } },
      update: { password: devHash },
      create: {
        tenantId,
        email: "james.tran@routeflow.dev",
        username: "james.t",
        password: devHash,
        role: "DRIVER",
        status: "ACTIVE",
        forcePasswordChange: false,
      },
    }),
  ]);

  const [carlos, james] = await Promise.all([
    prisma.driver.upsert({
      where: { userId: carlosUser.id },
      update: { contactName: "Carlos Reyes" },
      create: {
        tenantId,
        userId: carlosUser.id,
        status: "ACTIVE",
        contactName: "Carlos Reyes",
        vehicleMake: "Ford",
        vehicleModel: "Transit",
        vehicleColour: "White",
        vehiclePlate: "TXK-1892",
      },
    }),
    prisma.driver.upsert({
      where: { userId: jamesUser.id },
      update: { contactName: "James Tran" },
      create: {
        tenantId,
        userId: jamesUser.id,
        status: "ACTIVE",
        contactName: "James Tran",
        vehicleMake: "Chevrolet",
        vehicleModel: "Express",
        vehicleColour: "Silver",
        vehiclePlate: "TXM-4467",
      },
    }),
  ]);

  // ─── Customers ────────────────────────────────────────────────────────────────
  const customerDefs = [
    {
      username: "lone.star",
      email: "orders@lonestarcafe.com",
      businessName: "Lone Star Café",
      contactName: "Rosa Espinoza",
      phone: "+1-713-555-0101",
      address: {
        id: "seed-addr-1",
        label: "Main",
        line1: "123 Main St",
        city: "Houston",
        state: "TX",
        zip: "77001",
        lat: 29.7604,
        lng: -95.3698,
        isDefault: true,
      },
    },
    {
      username: "txbbq",
      email: "supply@texasbbqpalace.com",
      businessName: "Texas BBQ Palace",
      contactName: "Dale Hutchinson",
      phone: "+1-713-555-0202",
      address: {
        id: "seed-addr-2",
        label: "Main",
        line1: "456 Westheimer Rd",
        city: "Houston",
        state: "TX",
        zip: "77006",
        lat: 29.7369,
        lng: -95.4043,
        isDefault: true,
      },
    },
    {
      username: "hill.country",
      email: "stock@hillcountrymarket.com",
      businessName: "Hill Country Market",
      contactName: "Sandra Fuentes",
      phone: "+1-512-555-0303",
      address: {
        id: "seed-addr-3",
        label: "Main",
        line1: "789 S Lamar Blvd",
        city: "Austin",
        state: "TX",
        zip: "78704",
        lat: 30.2525,
        lng: -97.7524,
        isDefault: true,
      },
    },
    {
      username: "rio.grande",
      email: "orders@riograndedeli.com",
      businessName: "Rio Grande Deli",
      contactName: "Marco Villarreal",
      phone: "+1-210-555-0404",
      address: {
        id: "seed-addr-4",
        label: "Main",
        line1: "321 Commerce St",
        city: "San Antonio",
        state: "TX",
        zip: "78205",
        lat: 29.4241,
        lng: -98.4936,
        isDefault: true,
      },
    },
    {
      username: "bluebonnet",
      email: "purchasing@bluebonnetgrocery.com",
      businessName: "Bluebonnet Grocery",
      contactName: "Tanya Keller",
      phone: "+1-214-555-0505",
      address: {
        id: "seed-addr-5",
        label: "Main",
        line1: "654 Greenville Ave",
        city: "Dallas",
        state: "TX",
        zip: "75206",
        lat: 32.8206,
        lng: -96.7784,
        isDefault: true,
      },
    },
  ];

  const customerUsers = await Promise.all(
    customerDefs.map((c) =>
      prisma.user.upsert({
        where: { tenantId_username: { tenantId, username: c.username } },
        update: { password: devHash },
        create: {
          tenantId,
          email: c.email,
          username: c.username,
          password: devHash,
          role: "CUSTOMER",
          status: "ACTIVE",
          forcePasswordChange: false,
        },
      }),
    ),
  );

  const customers = await Promise.all(
    customerDefs.map((def, i) =>
      prisma.customer.upsert({
        where: { userId: customerUsers[i].id },
        update: {},
        create: {
          tenantId,
          userId: customerUsers[i].id,
          businessName: def.businessName,
          contactName: def.contactName,
          phone: def.phone,
        },
      }),
    ),
  );

  await Promise.all(
    customerDefs.map((def, i) =>
      prisma.customerAddress.upsert({
        where: { id: def.address.id },
        update: {},
        create: {
          tenantId,
          id: def.address.id,
          customerId: customers[i].id,
          label: def.address.label,
          line1: def.address.line1,
          city: def.address.city,
          state: def.address.state,
          zip: def.address.zip,
          lat: def.address.lat,
          lng: def.address.lng,
          isDefault: def.address.isDefault,
        },
      }),
    ),
  );

  // ─── Products ─────────────────────────────────────────────────────────────────
  const productDefs = [
    // Beverages
    {
      id: "seed-prod-01",
      name: "Purified Water 5gal",
      sku: "BEV-H2O-5G",
      unit: "jug",
      price: "8.99",
      category: "Beverages",
      lowStock: false,
      isActive: true,
    },
    {
      id: "seed-prod-02",
      name: "Orange Juice 1gal",
      sku: "BEV-OJ-1G",
      unit: "jug",
      price: "4.49",
      category: "Beverages",
      lowStock: false,
      isActive: true,
    },
    {
      id: "seed-prod-03",
      name: "Iced Tea 1gal",
      sku: "BEV-IT-1G",
      unit: "jug",
      price: "3.99",
      category: "Beverages",
      lowStock: false,
      isActive: true,
    },
    {
      id: "seed-prod-04",
      name: "Sparkling Water 24-pack",
      sku: "BEV-SW-24",
      unit: "case",
      price: "12.99",
      category: "Beverages",
      lowStock: false,
      isActive: true,
    },
    {
      id: "seed-prod-05",
      name: "Cold Brew Coffee 32oz",
      sku: "BEV-CB-32",
      unit: "bottle",
      price: "6.99",
      category: "Beverages",
      lowStock: true,
      isActive: true,
    },
    // Snacks
    {
      id: "seed-prod-06",
      name: "Kettle Chips 8oz",
      sku: "SNK-KC-8",
      unit: "bag",
      price: "2.49",
      category: "Snacks",
      lowStock: false,
      isActive: true,
    },
    {
      id: "seed-prod-07",
      name: "Mixed Nuts 16oz",
      sku: "SNK-MN-16",
      unit: "bag",
      price: "7.99",
      category: "Snacks",
      lowStock: false,
      isActive: true,
    },
    {
      id: "seed-prod-08",
      name: "Granola Bars 12-pack",
      sku: "SNK-GB-12",
      unit: "box",
      price: "8.49",
      category: "Snacks",
      lowStock: false,
      isActive: true,
    },
    {
      id: "seed-prod-09",
      name: "Beef Jerky 4oz",
      sku: "SNK-BJ-4",
      unit: "bag",
      price: "4.99",
      category: "Snacks",
      lowStock: true,
      isActive: true,
    },
    {
      id: "seed-prod-10",
      name: "Trail Mix 24oz",
      sku: "SNK-TM-24",
      unit: "bag",
      price: "9.99",
      category: "Snacks",
      lowStock: false,
      isActive: true,
    },
    // Cleaning Supplies
    {
      id: "seed-prod-11",
      name: "All-Purpose Cleaner 32oz",
      sku: "CLN-APC-32",
      unit: "bottle",
      price: "3.49",
      category: "Cleaning Supplies",
      lowStock: false,
      isActive: true,
    },
    {
      id: "seed-prod-12",
      name: "Paper Towels 12-roll",
      sku: "CLN-PT-12",
      unit: "case",
      price: "14.99",
      category: "Cleaning Supplies",
      lowStock: false,
      isActive: true,
    },
    {
      id: "seed-prod-13",
      name: "Dish Soap 25oz",
      sku: "CLN-DS-25",
      unit: "bottle",
      price: "3.99",
      category: "Cleaning Supplies",
      lowStock: false,
      isActive: true,
    },
    {
      id: "seed-prod-14",
      name: "Hand Sanitizer 8oz",
      sku: "CLN-HS-8",
      unit: "bottle",
      price: "2.99",
      category: "Cleaning Supplies",
      lowStock: true,
      isActive: true,
    },
    {
      id: "seed-prod-15",
      name: "Trash Bags 30gal 50ct",
      sku: "CLN-TB-50",
      unit: "box",
      price: "9.99",
      category: "Cleaning Supplies",
      lowStock: false,
      isActive: false,
    },
  ];

  await Promise.all(
    productDefs.map((p) =>
      prisma.product.upsert({
        where: { id: p.id },
        update: {},
        create: {
          tenantId,
          id: p.id,
          name: p.name,
          sku: p.sku,
          unit: p.unit,
          pricePerUnit: p.price,
          category: p.category,
          isActive: p.isActive,
        },
      }),
    ),
  );

  // ─── Initial Stock ────────────────────────────────────────────────────────────
  // Seed realistic stock levels via PURCHASE movements (idempotent: only if no movements exist)
  const stockSeeds: { productId: string; qty: number; unitCost: number }[] = [
    { productId: "seed-prod-01", qty: 48, unitCost: 5.5 }, // Purified Water
    { productId: "seed-prod-02", qty: 36, unitCost: 3.0 }, // Orange Juice
    { productId: "seed-prod-03", qty: 24, unitCost: 2.5 }, // Iced Tea
    { productId: "seed-prod-04", qty: 20, unitCost: 9.0 }, // Sparkling Water
    { productId: "seed-prod-05", qty: 5, unitCost: 4.5 }, // Cold Brew Coffee (low stock)
    { productId: "seed-prod-06", qty: 60, unitCost: 1.5 }, // Kettle Chips
    { productId: "seed-prod-07", qty: 30, unitCost: 5.2 }, // Mixed Nuts
    { productId: "seed-prod-08", qty: 18, unitCost: 5.8 }, // Granola Bars
    { productId: "seed-prod-09", qty: 4, unitCost: 3.2 }, // Beef Jerky (low stock)
    { productId: "seed-prod-10", qty: 22, unitCost: 6.5 }, // Trail Mix
    { productId: "seed-prod-11", qty: 40, unitCost: 2.2 }, // All-Purpose Cleaner
    { productId: "seed-prod-12", qty: 15, unitCost: 10.5 }, // Paper Towels
    { productId: "seed-prod-13", qty: 28, unitCost: 2.6 }, // Dish Soap
    { productId: "seed-prod-14", qty: 3, unitCost: 1.8 }, // Hand Sanitizer (low stock)
    // seed-prod-15 (Trash Bags) is inactive — no stock
  ];
  await Promise.all(
    stockSeeds.map(async ({ productId, qty, unitCost }) => {
      const existing = await prisma.stockMovement.findFirst({
        where: { tenantId, productId, type: "PURCHASE" },
      });
      if (!existing) {
        await prisma.stockMovement.create({
          data: {
            tenantId,
            productId,
            type: "PURCHASE",
            quantity: qty,
            unitCost,
            performedById: adminUser.id,
            reference: "SEED-INIT",
          },
        });
        await prisma.product.update({
          where: { id: productId },
          data: { currentStock: qty, averageCost: unitCost },
        });
      }
    }),
  );

  // ─── Routes ───────────────────────────────────────────────────────────────────
  const [route1, route2] = await Promise.all([
    prisma.route.upsert({
      where: { id: "seed-route-1" },
      update: {},
      create: {
        tenantId,
        id: "seed-route-1",
        name: "North Houston Loop",
        driverId: carlos.id,
        isActive: true,
      },
    }),
    prisma.route.upsert({
      where: { id: "seed-route-2" },
      update: {},
      create: {
        tenantId,
        id: "seed-route-2",
        name: "Southwest Loop",
        driverId: james.id,
        isActive: true,
      },
    }),
  ]);

  // Route 1: 3 stops (customers 0, 1, 2)
  const r1Stops = await Promise.all([
    prisma.routeStop.upsert({
      where: { id: "seed-rs-1-1" },
      update: {},
      create: {
        tenantId,
        id: "seed-rs-1-1",
        routeId: route1.id,
        customerId: customers[0].id,
        customerAddressId: customerDefs[0].address.id,
        stopNumber: 1,
      },
    }),
    prisma.routeStop.upsert({
      where: { id: "seed-rs-1-2" },
      update: {},
      create: {
        tenantId,
        id: "seed-rs-1-2",
        routeId: route1.id,
        customerId: customers[1].id,
        customerAddressId: customerDefs[1].address.id,
        stopNumber: 2,
      },
    }),
    prisma.routeStop.upsert({
      where: { id: "seed-rs-1-3" },
      update: {},
      create: {
        tenantId,
        id: "seed-rs-1-3",
        routeId: route1.id,
        customerId: customers[2].id,
        customerAddressId: customerDefs[2].address.id,
        stopNumber: 3,
      },
    }),
  ]);

  // Route 2: 2 stops (customers 3, 4)
  await Promise.all([
    prisma.routeStop.upsert({
      where: { id: "seed-rs-2-1" },
      update: {},
      create: {
        tenantId,
        id: "seed-rs-2-1",
        routeId: route2.id,
        customerId: customers[3].id,
        customerAddressId: customerDefs[3].address.id,
        stopNumber: 1,
      },
    }),
    prisma.routeStop.upsert({
      where: { id: "seed-rs-2-2" },
      update: {},
      create: {
        tenantId,
        id: "seed-rs-2-2",
        routeId: route2.id,
        customerId: customers[4].id,
        customerAddressId: customerDefs[4].address.id,
        stopNumber: 2,
      },
    }),
  ]);

  // RouteCustomer links
  await Promise.all(
    [
      { id: "seed-rc-1-0", routeId: route1.id, customerId: customers[0].id },
      { id: "seed-rc-1-1", routeId: route1.id, customerId: customers[1].id },
      { id: "seed-rc-1-2", routeId: route1.id, customerId: customers[2].id },
      { id: "seed-rc-2-3", routeId: route2.id, customerId: customers[3].id },
      { id: "seed-rc-2-4", routeId: route2.id, customerId: customers[4].id },
    ].map((link) =>
      prisma.routeCustomer.upsert({
        where: { id: link.id },
        update: {},
        create: { ...link, tenantId },
      }),
    ),
  );

  // ─── Active RouteRun (today, Route 1, Carlos) ──────────────────────────────────
  const runStarted = new Date(today);
  runStarted.setHours(7, 30, 0, 0);
  const stop1Completed = new Date(today);
  stop1Completed.setHours(8, 15, 0, 0);
  const stop2Arrived = new Date(today);
  stop2Arrived.setHours(9, 5, 0, 0);

  const activeRun = await prisma.routeRun.upsert({
    where: { id: "seed-run-1" },
    update: {},
    create: {
      tenantId,
      id: "seed-run-1",
      routeId: route1.id,
      driverId: carlos.id,
      status: "IN_PROGRESS",
      scheduledDate: today,
      startedAt: runStarted,
    },
  });

  await Promise.all([
    prisma.routeRunStop.upsert({
      where: { id: "seed-rrs-1-1" },
      update: {},
      create: {
        tenantId,
        id: "seed-rrs-1-1",
        routeRunId: activeRun.id,
        routeStopId: r1Stops[0].id,
        stopNumber: 1,
        arrivedAt: runStarted,
        completedAt: stop1Completed,
      },
    }),
    prisma.routeRunStop.upsert({
      where: { id: "seed-rrs-1-2" },
      update: {},
      create: {
        tenantId,
        id: "seed-rrs-1-2",
        routeRunId: activeRun.id,
        routeStopId: r1Stops[1].id,
        stopNumber: 2,
        arrivedAt: stop2Arrived,
      },
    }),
    prisma.routeRunStop.upsert({
      where: { id: "seed-rrs-1-3" },
      update: {},
      create: {
        tenantId,
        id: "seed-rrs-1-3",
        routeRunId: activeRun.id,
        routeStopId: r1Stops[2].id,
        stopNumber: 3,
      },
    }),
  ]);

  // ─── Orders ───────────────────────────────────────────────────────────────────

  async function seedOrder(
    id: string,
    customerId: string,
    status: "PENDING" | "CONFIRMED" | "OUT_FOR_DELIVERY" | "DELIVERED" | "CANCELLED",
    urgent: boolean,
    routeRunId: string | null,
    items: Array<{ productId: string; qty: number; unitPrice: number }>,
  ) {
    const subtotal = items.reduce((s, i) => s + i.qty * i.unitPrice, 0);
    const tax = +(subtotal * 0.0825).toFixed(2);
    const total = +(subtotal + tax).toFixed(2);
    // Derive a stable order number from the seed ID
    const seedNum = id.replace("seed-order-", "");
    const orderNumber = `ORD-SEED-${seedNum.padStart(3, "0")}`;

    const order = await prisma.order.upsert({
      where: { id },
      update: { orderNumber },
      create: {
        tenantId,
        id,
        orderNumber,
        customerId,
        routeRunId,
        status,
        urgent,
        source: "APP",
        subtotal: subtotal.toFixed(2),
        tax: tax.toFixed(2),
        total: total.toFixed(2),
        deliveredAt: status === "DELIVERED" ? new Date(Date.now() - 86400000) : null,
      },
    });

    await Promise.all(
      items.map((item, idx) =>
        prisma.orderItem.upsert({
          where: { id: `${id}-item-${idx + 1}` },
          update: {},
          create: {
            tenantId,
            id: `${id}-item-${idx + 1}`,
            orderId: order.id,
            productId: item.productId,
            status:
              status === "DELIVERED"
                ? "DELIVERED"
                : status === "CANCELLED"
                  ? "CANCELLED"
                  : "PENDING",
            qty: item.qty.toString(),
            unitPrice: item.unitPrice.toFixed(2),
            subtotal: (item.qty * item.unitPrice).toFixed(2),
          },
        }),
      ),
    );
  }

  // 3 OUT_FOR_DELIVERY linked to today's run (2 urgent)
  await seedOrder("seed-order-01", customers[0].id, "OUT_FOR_DELIVERY", true, activeRun.id, [
    { productId: "seed-prod-01", qty: 4, unitPrice: 8.99 },
    { productId: "seed-prod-06", qty: 12, unitPrice: 2.49 },
    { productId: "seed-prod-11", qty: 6, unitPrice: 3.49 },
  ]);

  await seedOrder("seed-order-02", customers[1].id, "OUT_FOR_DELIVERY", true, activeRun.id, [
    { productId: "seed-prod-02", qty: 8, unitPrice: 4.49 },
    { productId: "seed-prod-08", qty: 4, unitPrice: 8.49 },
  ]);

  await seedOrder("seed-order-03", customers[2].id, "OUT_FOR_DELIVERY", false, activeRun.id, [
    { productId: "seed-prod-03", qty: 6, unitPrice: 3.99 },
    { productId: "seed-prod-07", qty: 3, unitPrice: 7.99 },
    { productId: "seed-prod-14", qty: 10, unitPrice: 2.99 },
  ]);

  // Remaining mix
  await seedOrder("seed-order-04", customers[3].id, "CONFIRMED", false, null, [
    { productId: "seed-prod-04", qty: 5, unitPrice: 12.99 },
    { productId: "seed-prod-10", qty: 6, unitPrice: 9.99 },
  ]);

  await seedOrder("seed-order-05", customers[4].id, "PENDING", false, null, [
    { productId: "seed-prod-05", qty: 3, unitPrice: 6.99 },
    { productId: "seed-prod-09", qty: 8, unitPrice: 4.99 },
  ]);

  await seedOrder("seed-order-06", customers[0].id, "DELIVERED", false, null, [
    { productId: "seed-prod-12", qty: 2, unitPrice: 14.99 },
    { productId: "seed-prod-13", qty: 4, unitPrice: 3.99 },
  ]);

  await seedOrder("seed-order-07", customers[1].id, "DELIVERED", false, null, [
    { productId: "seed-prod-01", qty: 3, unitPrice: 8.99 },
    { productId: "seed-prod-06", qty: 6, unitPrice: 2.49 },
  ]);

  await seedOrder("seed-order-08", customers[2].id, "CANCELLED", false, null, [
    { productId: "seed-prod-08", qty: 2, unitPrice: 8.49 },
  ]);

  await seedOrder("seed-order-09", customers[3].id, "PENDING", false, null, [
    { productId: "seed-prod-11", qty: 4, unitPrice: 3.49 },
    { productId: "seed-prod-12", qty: 1, unitPrice: 14.99 },
  ]);

  await seedOrder("seed-order-10", customers[4].id, "CONFIRMED", false, null, [
    { productId: "seed-prod-02", qty: 5, unitPrice: 4.49 },
    { productId: "seed-prod-07", qty: 2, unitPrice: 7.99 },
    { productId: "seed-prod-15", qty: 3, unitPrice: 9.99 },
  ]);

  // ─── Seed Transactions ───────────────────────────────────────────────────────
  // Create transactions for delivered orders (mimics what orders service does on delivery)
  const deliveredOrderIds = ["seed-order-06", "seed-order-07"];
  for (const orderId of deliveredOrderIds) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) continue;
    const existing = await prisma.transaction.findUnique({ where: { orderId } });
    if (existing) continue;
    await prisma.transaction.create({
      data: {
        tenantId,
        orderId: order.id,
        customerId: order.customerId,
        totalOwed: order.total,
        status: "UNPAID",
        dueDate: new Date(Date.now() + 30 * 86400000), // Net 30
      },
    });
  }

  // Create a PARTIAL and a PAID transaction for variety
  const order06 = await prisma.order.findUnique({ where: { id: "seed-order-06" } });
  const txn06 = order06
    ? await prisma.transaction.findUnique({ where: { orderId: "seed-order-06" } })
    : null;
  if (txn06 && txn06.status === "UNPAID") {
    const partialAmount = +(Number(txn06.totalOwed) / 2).toFixed(2);
    await prisma.payment.create({
      data: {
        tenantId,
        transactionId: txn06.id,
        amount: partialAmount,
        method: "ACH",
        reference: "ACH-SEED-001",
      },
    });
    await prisma.transaction.update({
      where: { id: txn06.id },
      data: { totalPaid: partialAmount, status: "PARTIAL" },
    });
  }

  console.log(
    `Seeded tenant "${TENANT_SLUG}" (${tenantId}): 7 users, ${productDefs.length} products, ` +
      `10 orders, transactions for delivered orders`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
