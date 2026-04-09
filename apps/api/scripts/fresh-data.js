/**
 * Fresh data population script.
 * Wipes all existing user/operational data then re-creates ≥10 of every entity
 * using the live API, alternating between operator / customer / driver roles.
 *
 * Prerequisites: API must be running on http://localhost:3000
 * Run from repo root: node apps/api/scripts/fresh-data.js
 *
 * Options:
 *   --tenant <slug>   Use a specific tenant slug (default: "legacy")
 *   --manifest        Write created IDs to a timestamped manifest file
 *
 * Safety: Refuses to run when NODE_ENV=production.
 */

// ─── Production guard ─────────────────────────────────────────────────────────
if (process.env.NODE_ENV === "production") {
  console.error("\n❌ FATAL: fresh-data.js must NOT run against production.");
  console.error("   Set NODE_ENV to 'development' or 'staging' to proceed.\n");
  process.exit(1);
}

const { PrismaClient } = require("../../../node_modules/@prisma/client");
const { PrismaPg } = require("../../../node_modules/@prisma/adapter-pg");
const { Pool } = require("../../../node_modules/pg");
const path = require("path");
const fs = require("fs");

const BASE = "http://localhost:3000/api/v1";

// ─── CLI arguments ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const tenantSlugIndex = args.indexOf("--tenant");
const TENANT_SLUG = tenantSlugIndex >= 0 ? args[tenantSlugIndex + 1] : "legacy";
const WRITE_MANIFEST = args.includes("--manifest");

// ─── QA Manifest tracker ───────────────────────────────────────────────────
/** Tracks all entity IDs created during this run for targeted cleanup. */
const manifest = {
  createdAt: new Date().toISOString(),
  tenantSlug: TENANT_SLUG,
  suppliers: [],
  products: [],
  customers: [],
  drivers: [],
  users: [],
  orders: [],
  routes: [],
  routeRuns: [],
  invoices: [],
  creditNotes: [],
  returns: [],
  orderTemplates: [],
};

// Load DATABASE_URL from the API's .env file so TRUNCATE runs against the
// same database the API server is connected to.
function loadEnvDatabaseUrl() {
  const envPath = path.join(__dirname, "../.env");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf8");
    const match = content.match(/^DATABASE_URL\s*=\s*["']?([^"'\r\n]+)["']?/m);
    if (match) return match[1];
  }
  return process.env.DATABASE_URL || "postgresql://user:pass@localhost:5432/routeflow_dev";
}

const pool = new Pool({ connectionString: loadEnvDatabaseUrl() });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ─── HTTP helpers ────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, token, retries = 3) {
  const headers = { "Content-Type": "application/json", "X-Tenant-Slug": TENANT_SLUG };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  // Retry on rate-limit errors
  if (res.status === 429 && retries > 0) {
    console.log(`   ⏳ Rate limited — waiting 65s before retry...`);
    await sleep(65_000);
    return api(method, path, body, token, retries - 1);
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function login(username, password) {
  const data = await api("POST", "/auth/login", { username, password });
  return data.accessToken;
}

// ─── Phase 1: Truncate ────────────────────────────────────────────────────────

async function truncateAll() {
  console.log("\n🗑  Phase 1 — Clearing all existing data...");
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
  console.log("   ✓ Data cleared.");
}

// ─── Phase 2: Operator creates entities ──────────────────────────────────────

async function createSuppliers(tok) {
  console.log("\n📦 Phase 2A — Creating 10 suppliers...");
  const defs = [
    { name: "Sunrise Farms",          contactName: "Alice Carter",  email: "alice@sunrisefarms.com",   phone: "555-3001" },
    { name: "Blue Ridge Dairy",       contactName: "Bob Evans",     email: "bob@blueridge.com",        phone: "555-3002" },
    { name: "Urban Harvest",          contactName: "Carol Diaz",    email: "carol@urbanharvest.com",   phone: "555-3003" },
    { name: "Pacific Coast Bev",      contactName: "Dave Kim",      email: "dave@paccoast.com",        phone: "555-3004" },
    { name: "Coastal Clean Supply",   contactName: "Emma Walsh",    email: "emma@coastalclean.com",    phone: "555-3005" },
    { name: "Mountain Snacks Co.",    contactName: "Frank Reyes",   email: "frank@mtsnacks.com",       phone: "555-3006" },
    { name: "Premier Bakery Dist.",   contactName: "Grace Yoon",    email: "grace@premierbakery.com",  phone: "555-3007" },
    { name: "Valley Fresh Produce",   contactName: "Henry Ford",    email: "henry@valleyfresh.com",    phone: "555-3008" },
    { name: "Summit Beverage Co.",    contactName: "Isla Nguyen",   email: "isla@summitbev.com",       phone: "555-3009" },
    { name: "Golden Gate Foods",      contactName: "Jack Morris",   email: "jack@goldengate.com",      phone: "555-3010" },
  ];
  const suppliers = [];
  for (const d of defs) {
    const s = await api("POST", "/inventory/suppliers", d, tok);
    suppliers.push(s);
    console.log(`   ✓ ${s.name}`);
  }
  return suppliers;
}

async function createProducts(tok) {
  console.log("\n🛒 Phase 2B — Creating 12 products...");
  // pricePerUnit must be a decimal string; initialStock set via inventory adjustment after creation
  const defs = [
    { name: "Full Cream Milk 2L",  sku: "MILK-2L",   barcode: "2000000000001", unit: "bottle", pricePerUnit: "3.99",  initStock: 150, category: "Dairy" },
    { name: "Apple Juice 1L",      sku: "AJ-1L",     barcode: "2000000000002", unit: "bottle", pricePerUnit: "4.49",  initStock: 100, category: "Beverages" },
    { name: "Mineral Water 24pk",  sku: "MW-24",     barcode: "2000000000003", unit: "case",   pricePerUnit: "12.99", initStock: 80,  category: "Beverages" },
    { name: "Multigrain Bread",    sku: "MGB-001",   barcode: "2000000000004", unit: "loaf",   pricePerUnit: "5.99",  initStock: 60,  category: "Bakery" },
    { name: "Baby Spinach 4oz",    sku: "BSP-004",   barcode: "2000000000005", unit: "bag",    pricePerUnit: "3.49",  initStock: 110, category: "Produce" },
    { name: "Mozzarella 12oz",     sku: "MOZ-012",   barcode: "2000000000006", unit: "pack",   pricePerUnit: "6.49",  initStock: 70,  category: "Dairy" },
    { name: "Almond Mix 16oz",     sku: "ALM-016",   barcode: "2000000000007", unit: "bag",    pricePerUnit: "8.99",  initStock: 90,  category: "Snacks" },
    { name: "Dish Soap 22oz",      sku: "DSP-022",   barcode: "2000000000008", unit: "bottle", pricePerUnit: "4.99",  initStock: 180, category: "Cleaning" },
    { name: "Toilet Rolls 9pk",    sku: "TR-009",    barcode: "2000000000009", unit: "pack",   pricePerUnit: "9.99",  initStock: 130, category: "Cleaning" },
    { name: "Protein Bars 10pk",   sku: "PB-010",    barcode: "2000000000010", unit: "box",    pricePerUnit: "14.99", initStock: 75,  category: "Snacks" },
    { name: "Butter 500g",         sku: "BTR-500",   barcode: "2000000000011", unit: "block",  pricePerUnit: "5.49",  initStock: 95,  category: "Dairy" },
    { name: "Iced Coffee 4pk",     sku: "ICF-004",   barcode: "2000000000012", unit: "pack",   pricePerUnit: "9.49",  initStock: 5,   category: "Beverages" },
  ];
  const products = [];
  for (const d of defs) {
    const { initStock, ...productData } = d;
    const p = await api("POST", "/products", productData, tok);
    // Set initial stock via inventory adjustment
    await api("POST", "/inventory/movements/adjustment", {
      productId: p.id,
      quantity: initStock,
      notes: "Initial stock",
    }, tok);
    products.push({ ...p, pricePerUnit: parseFloat(d.pricePerUnit) });
    console.log(`   ✓ ${p.name} (barcode: ${p.barcode}, stock: ${initStock})`);
  }
  return products;
}

async function createCustomers(tok) {
  console.log("\n👤 Phase 2C — Creating 10 customers...");
  const defs = [
    { username: "harbor_cafe",     email: "harbor_cafe@example.com",     businessName: "Harbor Café",      contactName: "Tom Blake",   phone: "555-4001",
      address: { label: "Main",    line1: "1 Harbor Blvd",   city: "San Francisco", state: "CA", zip: "94105" } },
    { username: "north_deli",      email: "north_deli@example.com",      businessName: "Northside Deli",   contactName: "Sara Green",  phone: "555-4002",
      address: { label: "Main",    line1: "22 North St",     city: "Oakland",       state: "CA", zip: "94601" } },
    { username: "bayside_bistro",  email: "bayside_bistro@example.com",  businessName: "Bayside Bistro",   contactName: "Mia Chen",    phone: "555-4003",
      address: { label: "Main",    line1: "55 Bay Ave",      city: "San Francisco", state: "CA", zip: "94107" } },
    { username: "westpark_grill",  email: "westpark_grill@example.com",  businessName: "Westpark Grill",   contactName: "Jake Lee",    phone: "555-4004",
      address: { label: "Main",    line1: "10 West Park Rd", city: "Berkeley",      state: "CA", zip: "94710" } },
    { username: "central_kitchen", email: "central_kitchen@example.com", businessName: "Central Kitchen",  contactName: "Amy Ford",    phone: "555-4005",
      address: { label: "Main",    line1: "300 Central Ave", city: "San Francisco", state: "CA", zip: "94103" } },
    { username: "summit_foods",    email: "summit_foods@example.com",    businessName: "Summit Foods",     contactName: "Leo Park",    phone: "555-4006",
      address: { label: "Main",    line1: "8 Summit Dr",     city: "Daly City",     state: "CA", zip: "94014" } },
    { username: "ocean_bakes",     email: "ocean_bakes@example.com",     businessName: "Ocean Bakery",     contactName: "Nina Rose",   phone: "555-4007",
      address: { label: "Main",    line1: "99 Ocean Blvd",   city: "Pacifica",      state: "CA", zip: "94044" } },
    { username: "grove_market",    email: "grove_market@example.com",    businessName: "Grove Market",     contactName: "Sam Wu",      phone: "555-4008",
      address: { label: "Main",    line1: "44 Grove St",     city: "Oakland",       state: "CA", zip: "94607" } },
    { username: "tide_eats",       email: "tide_eats@example.com",       businessName: "Tide Eats",        contactName: "Raj Patel",   phone: "555-4009",
      address: { label: "Main",    line1: "7 Tide Way",      city: "Sausalito",     state: "CA", zip: "94965" } },
    { username: "pine_catering",   email: "pine_catering@example.com",   businessName: "Pine Catering",    contactName: "Eve Morgan",  phone: "555-4010",
      address: { label: "Main",    line1: "15 Pine Ln",      city: "San Rafael",    state: "CA", zip: "94901" } },
  ];
  const customers = [];
  for (const d of defs) {
    const { address, ...rest } = d;
    const res = await api("POST", "/customers", { ...rest, addresses: [address] }, tok);
    // Update password via separate call since create returns tempPassword
    // We need to reset the tempPassword to Customer1! — use the changePassword endpoint as the customer
    const customerTok = await login(d.username, res.tempPassword);
    await api("POST", "/auth/change-password", { currentPassword: res.tempPassword, newPassword: "Customer1!" }, customerTok);
    // Re-fetch to get the customer object with id
    const profile = await api("GET", "/customers/me", null, customerTok);
    customers.push({ ...res.customer, userId: res.user.id, username: d.username });
    console.log(`   ✓ ${d.businessName} (${d.username})`);
  }
  return customers;
}

async function createDrivers(tok) {
  console.log("\n🚗 Phase 2D — Creating 10 drivers...");
  const defs = [
    { username: "driver_tom",   email: "driver_tom@example.com",   contactName: "Tom Driver",   phone: "555-5001", vehicleMake: "Ford",    vehicleModel: "Transit",   vehicleColour: "White",  vehiclePlate: "DF-001" },
    { username: "driver_sara",  email: "driver_sara@example.com",  contactName: "Sara Driver",  phone: "555-5002", vehicleMake: "Toyota",  vehicleModel: "HiAce",     vehicleColour: "Silver", vehiclePlate: "DF-002" },
    { username: "driver_mia",   email: "driver_mia@example.com",   contactName: "Mia Driver",   phone: "555-5003", vehicleMake: "Mercedes",vehicleModel: "Sprinter",  vehicleColour: "White",  vehiclePlate: "DF-003" },
    { username: "driver_jake",  email: "driver_jake@example.com",  contactName: "Jake Driver",  phone: "555-5004", vehicleMake: "Iveco",   vehicleModel: "Daily",     vehicleColour: "Blue",   vehiclePlate: "DF-004" },
    { username: "driver_amy",   email: "driver_amy@example.com",   contactName: "Amy Driver",   phone: "555-5005", vehicleMake: "VW",      vehicleModel: "Crafter",   vehicleColour: "Grey",   vehiclePlate: "DF-005" },
    { username: "driver_leo",   email: "driver_leo@example.com",   contactName: "Leo Driver",   phone: "555-5006", vehicleMake: "Ford",    vehicleModel: "Transit",   vehicleColour: "Black",  vehiclePlate: "DF-006" },
    { username: "driver_nina",  email: "driver_nina@example.com",  contactName: "Nina Driver",  phone: "555-5007", vehicleMake: "Renault", vehicleModel: "Master",    vehicleColour: "White",  vehiclePlate: "DF-007" },
    { username: "driver_sam",   email: "driver_sam@example.com",   contactName: "Sam Driver",   phone: "555-5008", vehicleMake: "Citroen", vehicleModel: "Relay",     vehicleColour: "Yellow", vehiclePlate: "DF-008" },
    { username: "driver_raj",   email: "driver_raj@example.com",   contactName: "Raj Driver",   phone: "555-5009", vehicleMake: "Peugeot", vehicleModel: "Boxer",     vehicleColour: "Red",    vehiclePlate: "DF-009" },
    { username: "driver_eve",   email: "driver_eve@example.com",   contactName: "Eve Driver",   phone: "555-5010", vehicleMake: "Fiat",    vehicleModel: "Ducato",    vehicleColour: "Orange", vehiclePlate: "DF-010" },
  ];
  const drivers = [];
  for (const d of defs) {
    const res = await api("POST", "/drivers", d, tok);
    // Reset temp password
    const driverTok = await login(d.username, res.tempPassword);
    await api("POST", "/auth/change-password", { currentPassword: res.tempPassword, newPassword: "Driver1!" }, driverTok);
    drivers.push({ ...res.driver, username: d.username });
    console.log(`   ✓ ${d.contactName} (${d.username})`);
  }
  return drivers;
}

async function createRoutesAndRuns(tok, drivers, customers) {
  console.log("\n🗺  Phase 2E — Creating 10 routes + stops...");

  // Map customer username → customer object
  const byUsername = {};
  for (const c of customers) byUsername[c.username] = c;

  // Map driver username → driver object
  const driverByUsername = {};
  for (const d of drivers) driverByUsername[d.username] = d;

  const routeDefs = [
    { name: "Route A", driver: "driver_tom",  stops: ["harbor_cafe",    "north_deli"]      },
    { name: "Route B", driver: "driver_sara", stops: ["bayside_bistro", "westpark_grill"]  },
    { name: "Route C", driver: "driver_mia",  stops: ["central_kitchen","summit_foods"]    },
    { name: "Route D", driver: "driver_jake", stops: ["ocean_bakes",    "grove_market"]    },
    { name: "Route E", driver: "driver_amy",  stops: ["tide_eats",      "pine_catering"]   },
    { name: "Route F", driver: "driver_leo",  stops: ["harbor_cafe",    "bayside_bistro"]  },
    { name: "Route G", driver: "driver_nina", stops: ["westpark_grill", "central_kitchen"] },
    { name: "Route H", driver: "driver_sam",  stops: ["summit_foods",   "ocean_bakes"]     },
    { name: "Route I", driver: "driver_raj",  stops: ["grove_market",   "tide_eats"]       },
    { name: "Route J", driver: "driver_eve",  stops: ["pine_catering",  "north_deli"]      },
  ];

  // First, fetch customer addresses so we can link stops to addresses
  const custAddresses = {};
  for (const username of Object.keys(byUsername)) {
    const cTok = await login(username, "Customer1!");
    const profile = await api("GET", "/customers/me", null, cTok);
    custAddresses[username] = profile.addresses?.[0]?.id ?? null;
  }

  const routes = [];
  const runs = [];
  const today = new Date().toISOString().split("T")[0];

  for (const rd of routeDefs) {
    const driver = driverByUsername[rd.driver];
    const route = await api("POST", "/routes", { name: rd.name, driverId: driver.id }, tok);
    console.log(`   ✓ ${route.name} (driver: ${rd.driver})`);

    // Add stops
    const stopIds = [];
    for (let i = 0; i < rd.stops.length; i++) {
      const custUsername = rd.stops[i];
      const cust = byUsername[custUsername];
      const stop = await api("POST", `/routes/${route.id}/stops`, {
        customerId: cust.id,
        customerAddressId: custAddresses[custUsername],
        stopNumber: i + 1,
      }, tok);
      stopIds.push(stop.id);
    }

    // Create route run
    const run = await api("POST", "/route-runs", {
      routeId: route.id,
      scheduledDate: today,
      driverId: driver.id,
    }, tok);
    console.log(`      ↳ Run created (${run.id.slice(0,8)}...)`);

    routes.push({ ...route, stopIds, customerUsernames: rd.stops, driverUsername: rd.driver });
    runs.push({ ...run, routeId: route.id, driverUsername: rd.driver, stopIds });
  }

  return { routes, runs };
}

// ─── Phase 3: Customers place orders ─────────────────────────────────────────

async function placeOrders(customers, products) {
  console.log("\n🛍  Phase 3 — Customers placing 10 orders...");

  const byName = {};
  for (const p of products) byName[p.name] = p;

  const orderDefs = [
    { username: "harbor_cafe",     items: [{ name: "Full Cream Milk 2L", qty: 3 }, { name: "Apple Juice 1L", qty: 2 }] },
    { username: "north_deli",      items: [{ name: "Multigrain Bread",   qty: 5 }, { name: "Butter 500g",    qty: 4 }] },
    { username: "bayside_bistro",  items: [{ name: "Mozzarella 12oz",    qty: 3 }, { name: "Baby Spinach 4oz", qty: 6 }] },
    { username: "westpark_grill",  items: [{ name: "Almond Mix 16oz",    qty: 2 }, { name: "Protein Bars 10pk", qty: 3 }] },
    { username: "central_kitchen", items: [{ name: "Mineral Water 24pk", qty: 4 }, { name: "Iced Coffee 4pk",  qty: 2 }] },
    { username: "summit_foods",    items: [{ name: "Dish Soap 22oz",     qty: 6 }, { name: "Toilet Rolls 9pk", qty: 3 }] },
    { username: "ocean_bakes",     items: [{ name: "Full Cream Milk 2L", qty: 2 }, { name: "Butter 500g",      qty: 5 }] },
    { username: "grove_market",    items: [{ name: "Apple Juice 1L",     qty: 4 }, { name: "Iced Coffee 4pk",  qty: 2 }] },
    { username: "tide_eats",       items: [{ name: "Baby Spinach 4oz",   qty: 3 }, { name: "Mozzarella 12oz",  qty: 2 }] },
    { username: "pine_catering",   items: [{ name: "Protein Bars 10pk",  qty: 4 }, { name: "Almond Mix 16oz",  qty: 3 }] },
  ];

  const orders = [];
  for (const od of orderDefs) {
    const cTok = await login(od.username, "Customer1!");
    const orderItems = od.items.map((i) => ({ productId: byName[i.name].id, qty: i.qty }));
    const order = await api("POST", "/orders", { items: orderItems }, cTok);
    orders.push({ ...order, customerUsername: od.username });
    console.log(`   ✓ Order ${order.orderNumber} — ${od.username} (${od.items.map((i) => `${i.name}×${i.qty}`).join(", ")})`);
  }
  return orders;
}

// ─── Phase 4: Drivers complete deliveries ────────────────────────────────────

async function completeDeliveries(runs, orders, customers, products) {
  console.log("\n🚚 Phase 4 — Drivers completing deliveries...");

  const byName = {};
  for (const p of products) byName[p.name] = p;

  // driver_tom completes Route A (harbor_cafe, north_deli)
  const routeA = runs.find((r) => r.driverUsername === "driver_tom");
  if (routeA) {
    const driverTok = await login("driver_tom", "Driver1!");

    // Start run
    await api("PATCH", `/route-runs/${routeA.id}/status`, { status: "IN_PROGRESS" }, driverTok);
    console.log("   ✓ driver_tom started Route A run");

    // Fetch run stops to get orderItemIds
    const runDetail = await api("GET", `/route-runs/${routeA.id}`, null, driverTok);
    const runStops = runDetail.stops ?? [];

    for (let si = 0; si < Math.min(runStops.length, 2); si++) {
      const stop = runStops[si];

      // Mark stop IN_PROGRESS
      await api("PATCH", `/route-runs/${routeA.id}/stops/${stop.id}`, { status: "IN_PROGRESS" }, driverTok);

      // Build deliveries from order items attached to this stop
      const stopOrders = orders.filter((o) => o.customerId === stop.customerId);
      const deliveries = [];
      for (const ord of stopOrders) {
        const fullOrder = await api("GET", `/orders/${ord.id}`, null, driverTok);
        for (const item of (fullOrder.lineItems ?? fullOrder.orderItems ?? [])) {
          deliveries.push({ orderItemId: item.id, type: "DELIVERED", quantityDelivered: parseInt(item.qty, 10) });
        }
      }

      if (deliveries.length > 0) {
        await api("POST", `/route-runs/${routeA.id}/stops/${stop.id}/complete`, {
          deliveries,
          driverNote: "Delivered to front desk",
        }, driverTok);
        console.log(`   ✓ driver_tom completed stop ${si + 1} (${stop.customerId?.slice(0,8)}...)`);
      } else {
        console.log(`   ⚠  driver_tom stop ${si + 1} — no matching orders, skipping complete`);
        await api("PATCH", `/route-runs/${routeA.id}/stops/${stop.id}`, { status: "SKIPPED" }, driverTok);
      }
    }

    // Complete run
    await api("PATCH", `/route-runs/${routeA.id}/status`, { status: "COMPLETED" }, driverTok);
    console.log("   ✓ driver_tom completed Route A run");

    // Inventory: purchase Full Cream Milk ×50
    await api("POST", "/inventory/movements/purchase", {
      productId: byName["Full Cream Milk 2L"].id,
      quantity: 50,
      unitCost: 2.10,
      supplierId: null,
      notes: "Restocked after morning delivery",
    }, driverTok);
    console.log("   ✓ driver_tom logged purchase: Full Cream Milk 2L ×50");

    // Inventory: adjustment Iced Coffee ×20
    await api("POST", "/inventory/movements/adjustment", {
      productId: byName["Iced Coffee 4pk"].id,
      quantity: 20,
      notes: "Received new stock",
    }, driverTok);
    console.log("   ✓ driver_tom logged adjustment: Iced Coffee 4pk +20");
  }

  // driver_sara completes Route B (bayside_bistro, westpark_grill)
  const routeB = runs.find((r) => r.driverUsername === "driver_sara");
  if (routeB) {
    const driverTok = await login("driver_sara", "Driver1!");

    await api("PATCH", `/route-runs/${routeB.id}/status`, { status: "IN_PROGRESS" }, driverTok);
    const runDetail = await api("GET", `/route-runs/${routeB.id}`, null, driverTok);
    const runStops = runDetail.stops ?? [];

    for (let si = 0; si < Math.min(runStops.length, 2); si++) {
      const stop = runStops[si];
      await api("PATCH", `/route-runs/${routeB.id}/stops/${stop.id}`, { status: "IN_PROGRESS" }, driverTok);

      const stopOrders = orders.filter((o) => o.customerId === stop.customerId);
      const deliveries = [];
      for (const ord of stopOrders) {
        const fullOrder = await api("GET", `/orders/${ord.id}`, null, driverTok);
        for (const item of (fullOrder.lineItems ?? fullOrder.orderItems ?? [])) {
          deliveries.push({ orderItemId: item.id, type: "DELIVERED", quantityDelivered: parseInt(item.qty, 10) });
        }
      }

      if (deliveries.length > 0) {
        await api("POST", `/route-runs/${routeB.id}/stops/${stop.id}/complete`, { deliveries }, driverTok);
        console.log(`   ✓ driver_sara completed stop ${si + 1}`);
      } else {
        await api("PATCH", `/route-runs/${routeB.id}/stops/${stop.id}`, { status: "SKIPPED" }, driverTok);
        console.log(`   ⚠  driver_sara stop ${si + 1} — no matching orders, skipped`);
      }
    }

    await api("PATCH", `/route-runs/${routeB.id}/status`, { status: "COMPLETED" }, driverTok);
    console.log("   ✓ driver_sara completed Route B run");

    // Inventory adjustment
    await api("POST", "/inventory/movements/adjustment", {
      productId: byName["Butter 500g"].id,
      quantity: 30,
      notes: "Stock count correction",
    }, driverTok);
    console.log("   ✓ driver_sara logged adjustment: Butter 500g +30");
  }
}

// ─── Phase 5: Operator invoices + credit notes ────────────────────────────────

async function createInvoicesAndCreditNotes(tok, customers, orders, products) {
  console.log("\n🧾 Phase 5 — Operator creating 10 invoices + 3 credit notes...");

  const byName = {};
  for (const p of products) byName[p.name] = p;

  const orderDefs = [
    { username: "harbor_cafe",     items: [{ name: "Full Cream Milk 2L", qty: 3 }, { name: "Apple Juice 1L", qty: 2 }] },
    { username: "north_deli",      items: [{ name: "Multigrain Bread",   qty: 5 }, { name: "Butter 500g",    qty: 4 }] },
    { username: "bayside_bistro",  items: [{ name: "Mozzarella 12oz",    qty: 3 }, { name: "Baby Spinach 4oz", qty: 6 }] },
    { username: "westpark_grill",  items: [{ name: "Almond Mix 16oz",    qty: 2 }, { name: "Protein Bars 10pk", qty: 3 }] },
    { username: "central_kitchen", items: [{ name: "Mineral Water 24pk", qty: 4 }, { name: "Iced Coffee 4pk",  qty: 2 }] },
    { username: "summit_foods",    items: [{ name: "Dish Soap 22oz",     qty: 6 }, { name: "Toilet Rolls 9pk", qty: 3 }] },
    { username: "ocean_bakes",     items: [{ name: "Full Cream Milk 2L", qty: 2 }, { name: "Butter 500g",      qty: 5 }] },
    { username: "grove_market",    items: [{ name: "Apple Juice 1L",     qty: 4 }, { name: "Iced Coffee 4pk",  qty: 2 }] },
    { username: "tide_eats",       items: [{ name: "Baby Spinach 4oz",   qty: 3 }, { name: "Mozzarella 12oz",  qty: 2 }] },
    { username: "pine_catering",   items: [{ name: "Protein Bars 10pk",  qty: 4 }, { name: "Almond Mix 16oz",  qty: 3 }] },
  ];

  const byUsername = {};
  for (const c of customers) byUsername[c.username] = c;

  const invoices = [];
  for (const od of orderDefs) {
    const cust = byUsername[od.username];
    const invItems = od.items.map((i) => ({
      description: i.name,
      productId: byName[i.name].id,
      qty: i.qty,
      unitPrice: byName[i.name].pricePerUnit,
    }));
    const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const inv = await api("POST", "/invoices", { customerId: cust.id, items: invItems, dueDate }, tok);
    await api("POST", `/invoices/${inv.id}/send`, {}, tok);
    invoices.push(inv);
    console.log(`   ✓ Invoice ${inv.invoiceNumber} → ${od.username} [SENT]`);
  }

  // 3 credit notes
  const cnDefs = [
    { username: "harbor_cafe",    amount: 15.00, reason: "Quality issue with milk delivery" },
    { username: "bayside_bistro", amount: 12.00, reason: "Damaged mozzarella pack" },
    { username: "grove_market",   amount: 8.98,  reason: "Short delivery — 2x apple juice missing" },
  ];
  for (const cn of cnDefs) {
    const cust = byUsername[cn.username];
    const result = await api("POST", "/credit-notes", { customerId: cust.id, amount: cn.amount, reason: cn.reason }, tok);
    console.log(`   ✓ Credit note ${result.creditNoteNumber} → ${cn.username} ($${cn.amount})`);
  }

  return invoices;
}

// ─── Phase 6: Customer returns + standing orders ──────────────────────────────

async function createReturnsAndTemplates(orders, products) {
  console.log("\n↩  Phase 6 — Customers creating returns + standing orders...");

  const byName = {};
  for (const p of products) byName[p.name] = p;

  const orderByUsername = {};
  for (const o of orders) orderByUsername[o.customerUsername] = o;

  // Returns: 5 customers
  const returnDefs = [
    { username: "harbor_cafe",     productName: "Full Cream Milk 2L", qty: 1, reason: "DAMAGED",        restock: false },
    { username: "bayside_bistro",  productName: "Mozzarella 12oz",    qty: 1, reason: "QUALITY_ISSUE",  restock: false },
    { username: "central_kitchen", productName: "Mineral Water 24pk", qty: 2, reason: "EXCESS_ORDER",   restock: true  },
    { username: "ocean_bakes",     productName: "Butter 500g",        qty: 1, reason: "WRONG_ITEM",     restock: true  },
    { username: "tide_eats",       productName: "Mozzarella 12oz",    qty: 1, reason: "DAMAGED",        restock: false },
  ];

  for (const rd of returnDefs) {
    const cTok = await login(rd.username, "Customer1!");
    const order = orderByUsername[rd.username];
    if (!order) { console.log(`   ⚠  No order found for ${rd.username}, skipping return`); continue; }
    const product = byName[rd.productName];
    await api("POST", "/returns", {
      orderId: order.id,
      reason: rd.reason,
      items: [{ productId: product.id, qty: rd.qty, reason: rd.reason, restock: rd.restock }],
    }, cTok);
    console.log(`   ✓ Return — ${rd.username}: ${rd.productName} ×${rd.qty} (${rd.reason})`);
  }

  // Standing orders: 5 customers
  const templateDefs = [
    { username: "north_deli",      name: "Weekly Bread & Butter", daysOfWeek: [1, 3, 5],
      items: [{ productName: "Multigrain Bread", qty: 3 }, { productName: "Butter 500g", qty: 2 }] },
    { username: "westpark_grill",  name: "Tuesday Snacks",         daysOfWeek: [2],
      items: [{ productName: "Almond Mix 16oz", qty: 2 }] },
    { username: "summit_foods",    name: "Friday Supplies",        daysOfWeek: [5],
      items: [{ productName: "Dish Soap 22oz", qty: 4 }, { productName: "Toilet Rolls 9pk", qty: 2 }] },
    { username: "grove_market",    name: "Mon/Thu Juice Order",    daysOfWeek: [1, 4],
      items: [{ productName: "Apple Juice 1L", qty: 6 }] },
    { username: "pine_catering",   name: "Tue/Fri Protein Bars",   daysOfWeek: [2, 5],
      items: [{ productName: "Protein Bars 10pk", qty: 5 }] },
  ];

  for (const td of templateDefs) {
    const cTok = await login(td.username, "Customer1!");
    const items = td.items.map((i) => ({ productId: byName[i.productName].id, qty: i.qty }));
    const tmpl = await api("POST", "/order-templates", { name: td.name, daysOfWeek: td.daysOfWeek, items }, cTok);
    const days = td.daysOfWeek.map((d) => ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d]).join("/");
    console.log(`   ✓ Template "${td.name}" — ${td.username} (${days})`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 RouteFlow Fresh Data Script");
  console.log("================================");
  console.log(`   Tenant: ${TENANT_SLUG}`);
  console.log(`   Manifest: ${WRITE_MANIFEST ? "enabled" : "disabled (use --manifest to enable)"}`);

  // Phase 1 — Truncate
  await truncateAll();

  // Operator login
  const opTok = await login("admin", "Admin@123");
  console.log("\n✅ Operator login successful");

  // Phase 2 — Create entities as operator
  const suppliers = await createSuppliers(opTok);
  const products  = await createProducts(opTok);
  const customers = await createCustomers(opTok);
  const drivers   = await createDrivers(opTok);

  // Track IDs in manifest
  manifest.suppliers = suppliers.map(s => s.id);
  manifest.products = products.map(p => p.id);
  manifest.customers = customers.map(c => ({ customerId: c.customerId, userId: c.userId, username: c.username }));
  manifest.drivers = drivers.map(d => ({ driverId: d.driverId, userId: d.userId, username: d.username }));

  // Phase 3 — Customers place orders BEFORE runs are created so auto-linking works
  const orders = await placeOrders(customers, products);
  manifest.orders = orders.map(o => o.id);

  // Phase 2E — Create routes + runs AFTER orders so createRun auto-links pending orders to stops
  const { routes, runs } = await createRoutesAndRuns(opTok, drivers, customers);
  manifest.routes = routes.map(r => r.id);
  manifest.routeRuns = runs.map(r => r.id);

  // Phase 4 — Drivers complete deliveries
  await completeDeliveries(runs, orders, customers, products);

  // Phase 5 — Invoices + credit notes (operator)
  const opTok2 = await login("admin", "Admin@123"); // re-login after time passes
  await createInvoicesAndCreditNotes(opTok2, customers, orders, products);

  // Phase 6 — Customer returns + standing orders
  await createReturnsAndTemplates(orders, products);

  // ─── Write manifest to disk ────────────────────────────────────────────────
  if (WRITE_MANIFEST) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const manifestPath = path.join(__dirname, `qa-manifest-${ts}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    console.log(`\n📄 Manifest written to: ${manifestPath}`);
  }

  console.log("\n✅ Fresh data population complete!");
  console.log("\n📋 Summary:");
  console.log(`   Suppliers:     ${suppliers.length}`);
  console.log(`   Products:      ${products.length} (barcodes 2000000000001–2000000000012)`);
  console.log(`   Customers:     ${customers.length} (password: Customer1!)`);
  console.log(`   Drivers:       ${drivers.length} (password: Driver1!)`);
  console.log(`   Routes:        ${routes.length}`);
  console.log(`   Route Runs:    ${runs.length}`);
  console.log(`   Orders:        ${orders.length}`);
  console.log("\n🔑 Test credentials:");
  console.log("   Operator:  admin / Admin@123");
  console.log("   Customers: harbor_cafe, north_deli, bayside_bistro, ... / Customer1!");
  console.log("   Drivers:   driver_tom, driver_sara, driver_mia, ... / Driver1!");
}

main()
  .catch((err) => { console.error("\n❌ Script failed:", err.message); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
