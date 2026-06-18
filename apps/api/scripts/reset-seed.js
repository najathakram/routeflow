// PRODUCTION GUARD — must be first executable code
const { productionGuard } = require("./lib/production-guard");
productionGuard({ requireFlag: "--i-know-this-deletes-everything" });

/**
 * Reset database (keep operator users) and seed fresh demo data.
 * Run: node apps/api/scripts/reset-seed.js --i-know-this-deletes-everything   (from repo root)
 */

const { PrismaClient } = require("../../../node_modules/@prisma/client");
const { PrismaPg } = require("../../../node_modules/@prisma/adapter-pg");
const { Pool } = require("../../../node_modules/pg");
const bcrypt = require("../../../node_modules/bcrypt");

const pool = new Pool({ connectionString: "postgresql://user:pass@localhost:5432/routeflow_dev" });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("🗑  Clearing existing data (keeping operator users)...");

  // TRUNCATE all data tables with CASCADE
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "Message", "ReturnItem", "Return", "InvoicePayment", "InvoiceItem",
      "BillPayment", "VendorBill", "PurchaseOrderItem", "PurchaseOrder",
      "EstimateItem", "Estimate", "Expense", "ExpenseCategory",
      "StockMovement", "CreditNote", "Payment", "Invoice",
      "OrderTemplateItem", "OrderTemplate", "OrderItem", "Order",
      "Transaction", "TransactionItem", "DeliveryMutation",
      "RouteRunStop", "RouteRun", "RouteCustomer", "RouteStop", "Route",
      "DeviceToken", "RefreshToken",
      "CustomerAddress", "Customer", "Driver",
      "Product", "Supplier"
    CASCADE
  `);
  await prisma.user.deleteMany({ where: { role: { not: "OPERATOR" } } });

  console.log("✅ Data cleared.\n");

  // ─── Suppliers ──────────────────────────────────────────────────────────────
  console.log("📦 Creating 10 suppliers...");
  const suppliers = [];
  for (const d of [
    {
      name: "FreshFarm Co.",
      contactName: "Alice Martin",
      email: "alice@freshfarm.com",
      phone: "555-0101",
    },
    {
      name: "Metro Beverages Ltd.",
      contactName: "Bob Chen",
      email: "bob@metrobev.com",
      phone: "555-0102",
    },
    {
      name: "CleanPro Supply",
      contactName: "Carol White",
      email: "carol@cleanpro.com",
      phone: "555-0103",
    },
    {
      name: "Snack Nation Inc.",
      contactName: "Dave Kim",
      email: "dave@snacknation.com",
      phone: "555-0104",
    },
    {
      name: "Pacific Waters",
      contactName: "Emma Lopez",
      email: "emma@pacwaters.com",
      phone: "555-0105",
    },
    {
      name: "GreenLeaf Organics",
      contactName: "Frank Nguyen",
      email: "frank@greenleaf.com",
      phone: "555-0106",
    },
    {
      name: "TechPack Solutions",
      contactName: "Grace Park",
      email: "grace@techpack.com",
      phone: "555-0107",
    },
    {
      name: "Dairy Direct",
      contactName: "Henry Liu",
      email: "henry@dairydirect.com",
      phone: "555-0108",
    },
    {
      name: "Bakery Wholesale",
      contactName: "Isla Turner",
      email: "isla@bakerywholesale.com",
      phone: "555-0109",
    },
    {
      name: "Continental Goods",
      contactName: "Jack Morris",
      email: "jack@contgoods.com",
      phone: "555-0110",
    },
  ]) {
    suppliers.push(await prisma.supplier.create({ data: d }));
  }
  console.log(`   ✓ ${suppliers.length} suppliers`);

  // ─── Products (with barcodes) ───────────────────────────────────────────────
  console.log("🛒 Creating 12 products...");
  const products = [];
  for (const d of [
    {
      name: "Whole Milk 1gal",
      sku: "MILK-001",
      barcode: "1234567890001",
      unit: "jug",
      pricePerUnit: 4.99,
      currentStock: 120,
      category: "Dairy",
    },
    {
      name: "Orange Juice 2L",
      sku: "OJ-002",
      barcode: "1234567890002",
      unit: "bottle",
      pricePerUnit: 5.49,
      currentStock: 80,
      category: "Beverages",
    },
    {
      name: "Sparkling Water 12pk",
      sku: "WATER-003",
      barcode: "1234567890003",
      unit: "case",
      pricePerUnit: 8.99,
      currentStock: 60,
      category: "Beverages",
    },
    {
      name: "Sourdough Bread Loaf",
      sku: "BREAD-004",
      barcode: "1234567890004",
      unit: "loaf",
      pricePerUnit: 6.5,
      currentStock: 45,
      category: "Bakery",
    },
    {
      name: "Mixed Salad Greens 5oz",
      sku: "SALAD-005",
      barcode: "1234567890005",
      unit: "bag",
      pricePerUnit: 3.99,
      currentStock: 90,
      category: "Produce",
    },
    {
      name: "Cheddar Cheese 16oz",
      sku: "CHSE-006",
      barcode: "1234567890006",
      unit: "block",
      pricePerUnit: 7.99,
      currentStock: 55,
      category: "Dairy",
    },
    {
      name: "Trail Mix 20oz",
      sku: "TRAIL-007",
      barcode: "1234567890007",
      unit: "bag",
      pricePerUnit: 9.49,
      currentStock: 70,
      category: "Snacks",
    },
    {
      name: "All-Purpose Cleaner 32oz",
      sku: "CLEAN-008",
      barcode: "1234567890008",
      unit: "bottle",
      pricePerUnit: 3.49,
      currentStock: 200,
      category: "Cleaning",
    },
    {
      name: "Paper Towels 6-roll",
      sku: "PTOWEL-009",
      barcode: "1234567890009",
      unit: "pack",
      pricePerUnit: 11.99,
      currentStock: 110,
      category: "Cleaning",
    },
    {
      name: "Granola Bars 12pk",
      sku: "GRAN-010",
      barcode: "1234567890010",
      unit: "box",
      pricePerUnit: 8.49,
      currentStock: 85,
      category: "Snacks",
    },
    {
      name: "Greek Yogurt 32oz",
      sku: "YOGURT-011",
      barcode: "1234567890011",
      unit: "tub",
      pricePerUnit: 6.99,
      currentStock: 65,
      category: "Dairy",
    },
    {
      name: "Cold Brew Coffee 32oz",
      sku: "CBREW-012",
      barcode: "1234567890012",
      unit: "bottle",
      pricePerUnit: 6.99,
      currentStock: 4,
      category: "Beverages",
    },
  ]) {
    products.push(await prisma.product.create({ data: { ...d, isActive: true } }));
  }
  console.log(`   ✓ ${products.length} products`);

  // ─── Customers (User + Customer + CustomerAddress) ───────────────────────────
  console.log("👥 Creating 10 customers...");
  const custPassword = await bcrypt.hash("Customer1!", 10);
  const customers = [];
  for (const [i, d] of [
    [
      0,
      {
        username: "bright_cafe",
        email: "bright@cafe.com",
        business: "Bright Star Cafe",
        contact: "Sara Bright",
        phone: "555-1001",
        city: "Denver",
        state: "CO",
        zip: "80202",
        line1: "101 Main St",
      },
    ],
    [
      1,
      {
        username: "metro_deli",
        email: "metro@deli.com",
        business: "Metro Deli",
        contact: "Tom Metro",
        phone: "555-1002",
        city: "Chicago",
        state: "IL",
        zip: "60601",
        line1: "202 Oak Ave",
      },
    ],
    [
      2,
      {
        username: "sunrise_bistro",
        email: "sunrise@bistro.com",
        business: "Sunrise Bistro",
        contact: "Lily Sun",
        phone: "555-1003",
        city: "Austin",
        state: "TX",
        zip: "78701",
        line1: "303 Elm Rd",
      },
    ],
    [
      3,
      {
        username: "harbor_grill",
        email: "harbor@grill.com",
        business: "Harbor Grill",
        contact: "Mark Harbor",
        phone: "555-1004",
        city: "Seattle",
        state: "WA",
        zip: "98101",
        line1: "404 Pine Blvd",
      },
    ],
    [
      4,
      {
        username: "corner_kitchen",
        email: "corner@kitchen.com",
        business: "Corner Kitchen",
        contact: "Nora Corner",
        phone: "555-1005",
        city: "Portland",
        state: "OR",
        zip: "97201",
        line1: "505 Maple Dr",
      },
    ],
    [
      5,
      {
        username: "peak_bakery",
        email: "peak@bakery.com",
        business: "Peak Bakery",
        contact: "Oscar Peak",
        phone: "555-1006",
        city: "Boston",
        state: "MA",
        zip: "02101",
        line1: "606 Cedar Ln",
      },
    ],
    [
      6,
      {
        username: "valley_foods",
        email: "valley@foods.com",
        business: "Valley Fresh Foods",
        contact: "Pat Valley",
        phone: "555-1007",
        city: "Nashville",
        state: "TN",
        zip: "37201",
        line1: "707 Birch Way",
      },
    ],
    [
      7,
      {
        username: "summit_catering",
        email: "summit@catering.com",
        business: "Summit Catering",
        contact: "Quinn Summit",
        phone: "555-1008",
        city: "Miami",
        state: "FL",
        zip: "33101",
        line1: "808 Walnut Ct",
      },
    ],
    [
      8,
      {
        username: "grove_market",
        email: "grove@market.com",
        business: "Grove Market",
        contact: "Rita Grove",
        phone: "555-1009",
        city: "Denver",
        state: "CO",
        zip: "80204",
        line1: "909 Spruce St",
      },
    ],
    [
      9,
      {
        username: "tide_restaurant",
        email: "tide@restaurant.com",
        business: "Tide Restaurant",
        contact: "Sam Tide",
        phone: "555-1010",
        city: "Madison",
        state: "WI",
        zip: "53701",
        line1: "1010 Ash Ave",
      },
    ],
  ]) {
    const user = await prisma.user.create({
      data: {
        email: d.email,
        username: d.username,
        password: custPassword,
        role: "CUSTOMER",
        status: "ACTIVE",
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: d.business,
        contactName: d.contact,
        phone: d.phone,
        addresses: {
          create: [
            {
              label: "default",
              line1: d.line1,
              city: d.city,
              state: d.state,
              zip: d.zip,
              isDefault: true,
            },
          ],
        },
      },
    });
    customers.push(customer);
  }
  console.log(`   ✓ ${customers.length} customers`);

  // ─── Drivers ────────────────────────────────────────────────────────────────
  console.log("🚚 Creating 10 drivers...");
  const drvPassword = await bcrypt.hash("Driver1!", 10);
  const drivers = [];
  for (const d of [
    {
      username: "alex_driver",
      email: "alex.driver@routeflow.com",
      name: "Alex Johnson",
      phone: "555-2001",
    },
    {
      username: "brian_driver",
      email: "brian.driver@routeflow.com",
      name: "Brian Smith",
      phone: "555-2002",
    },
    {
      username: "claire_driver",
      email: "claire.driver@routeflow.com",
      name: "Claire Davis",
      phone: "555-2003",
    },
    {
      username: "derek_driver",
      email: "derek.driver@routeflow.com",
      name: "Derek Wilson",
      phone: "555-2004",
    },
    {
      username: "elena_driver",
      email: "elena.driver@routeflow.com",
      name: "Elena Brown",
      phone: "555-2005",
    },
    {
      username: "frank_driver",
      email: "frank.driver@routeflow.com",
      name: "Frank Miller",
      phone: "555-2006",
    },
    {
      username: "gina_driver",
      email: "gina.driver@routeflow.com",
      name: "Gina Taylor",
      phone: "555-2007",
    },
    {
      username: "hank_driver",
      email: "hank.driver@routeflow.com",
      name: "Hank Anderson",
      phone: "555-2008",
    },
    {
      username: "iris_driver",
      email: "iris.driver@routeflow.com",
      name: "Iris Thomas",
      phone: "555-2009",
    },
    {
      username: "jake_driver",
      email: "jake.driver@routeflow.com",
      name: "Jake Martinez",
      phone: "555-2010",
    },
  ]) {
    const user = await prisma.user.create({
      data: {
        email: d.email,
        username: d.username,
        password: drvPassword,
        role: "DRIVER",
        status: "ACTIVE",
      },
    });
    drivers.push(
      await prisma.driver.create({
        data: { userId: user.id, contactName: d.name, phone: d.phone, status: "ACTIVE" },
      }),
    );
  }
  console.log(`   ✓ ${drivers.length} drivers`);

  // ─── Orders ─────────────────────────────────────────────────────────────────
  console.log("📋 Creating 10 orders...");
  const statuses = [
    "DELIVERED",
    "DELIVERED",
    "DELIVERED",
    "DELIVERED",
    "CONFIRMED",
    "CONFIRMED",
    "OUT_FOR_DELIVERY",
    "PENDING",
    "PENDING",
    "CANCELLED",
  ];
  const orders = [];
  for (let i = 0; i < 10; i++) {
    const cust = customers[i];
    const status = statuses[i];
    const p1 = products[i % products.length];
    const p2 = products[(i + 2) % products.length];
    const q1 = 2 + (i % 4);
    const q2 = 1 + (i % 3);
    const up1 = Number(p1.pricePerUnit);
    const up2 = Number(p2.pricePerUnit);
    const sub = +(q1 * up1 + q2 * up2).toFixed(2);
    const tax = +(sub * 0.1).toFixed(2);
    const itemStatus =
      status === "DELIVERED" ? "DELIVERED" : status === "CANCELLED" ? "CANCELLED" : "PENDING";
    const createdAt = new Date(2026, 2, 15 + i);
    orders.push(
      await prisma.order.create({
        data: {
          customerId: cust.id,
          orderNumber: `ORD-2026-${String(i + 1).padStart(4, "0")}`,
          status,
          subtotal: sub,
          tax,
          total: +(sub + tax).toFixed(2),
          createdAt,
          lineItems: {
            create: [
              {
                productId: p1.id,
                qty: q1,
                unitPrice: up1,
                subtotal: +(q1 * up1).toFixed(2),
                status: itemStatus,
              },
              {
                productId: p2.id,
                qty: q2,
                unitPrice: up2,
                subtotal: +(q2 * up2).toFixed(2),
                status: itemStatus,
              },
            ],
          },
        },
      }),
    );
  }
  console.log(`   ✓ ${orders.length} orders`);

  // ─── Routes + RouteRuns ─────────────────────────────────────────────────────
  console.log("🗺  Creating 10 routes + runs...");
  const runStatuses = [
    "COMPLETED",
    "COMPLETED",
    "COMPLETED",
    "IN_PROGRESS",
    "SCHEDULED",
    "SCHEDULED",
    "SCHEDULED",
    "COMPLETED",
    "SCHEDULED",
    "CANCELLED",
  ];
  const routes = [];
  for (let i = 0; i < 10; i++) {
    const driver = drivers[i];
    const runStatus = runStatuses[i];
    const scheduledDate = new Date(2026, 2, 20 + i);

    // Create the Route template with stops
    const route = await prisma.route.create({
      data: {
        name: `Route ${String.fromCharCode(65 + i)}`,
        driverId: driver.id,
        isActive: true,
        stops: {
          create: [
            { customerId: customers[i].id, stopNumber: 1 },
            { customerId: customers[(i + 1) % 10].id, stopNumber: 2 },
          ],
        },
      },
      include: { stops: true },
    });

    // Create a RouteRun (without nested stops to avoid constraint issues)
    const run = await prisma.routeRun.create({
      data: {
        routeId: route.id,
        driverId: driver.id,
        status: runStatus,
        scheduledDate,
      },
    });

    // Add RouteRunStops separately
    for (const stop of route.stops) {
      await prisma.routeRunStop.create({
        data: {
          routeRunId: run.id,
          routeStopId: stop.id,
          customerId: stop.customerId ?? undefined,
          stopNumber: stop.stopNumber,
          status: runStatus === "COMPLETED" ? "COMPLETED" : "PENDING",
          podPhotoUrls: [],
        },
      });
    }

    routes.push({ route, run });
  }
  console.log(`   ✓ ${routes.length} routes + runs`);

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log("\n🎉 Seed complete!");
  console.log("   10 suppliers");
  console.log("   12 products (barcodes: 1234567890001 – 1234567890012)");
  console.log("   10 customers  → password: Customer1!");
  console.log("   10 drivers    → password: Driver1!");
  console.log(
    "   10 orders     (4 DELIVERED, 2 CONFIRMED, 1 OUT_FOR_DELIVERY, 2 PENDING, 1 CANCELLED)",
  );
  console.log("   10 routes + 10 route runs");
  console.log("\n   First customer: bright@cafe.com / Customer1!");
  console.log("   First driver:   alex.driver@routeflow.com / Driver1!");
}

main()
  .then(async () => {
    await prisma.$disconnect();
    await pool.end();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    await pool.end();
    process.exit(1);
  });
