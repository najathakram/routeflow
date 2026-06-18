/**
 * UX Audit Seed Script
 * --------------------
 * Creates a fully-isolated test tenant + accounts on Railway production so
 * every authenticated screen can be walked during a UI/UX audit, then
 * deleted cleanly without touching any pre-existing data.
 *
 * Prerequisites:
 *   1. Local API server running: node apps/api/dist/main.js
 *      (must be connected to the Railway DB — set DATABASE_URL in apps/api/.env)
 *   2. The Railway DATABASE_URL must be accessible from this machine.
 *
 * Run from repo root:
 *   node apps/api/scripts/ux-audit-seed.js
 *
 * Cleanup:
 *   node apps/api/scripts/ux-audit-cleanup.js apps/api/scripts/ux-audit-manifest-<ts>.json
 *
 * Safety:
 *   - Does NOT call productionGuard (intentional Railway run, additive only)
 *   - Requires interactive confirmation before touching the DB
 *   - Writes every created ID to a timestamped manifest for surgical cleanup
 *   - Tenant slug includes timestamp — can't collide with legacy or prior runs
 *   - Never truncates, never drops, never touches pre-existing rows
 */

"use strict";
const { Client } = require("pg");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const readline = require("readline");

// ── Config ────────────────────────────────────────────────────────────────────

const API = "http://localhost:3000/api/v1";

// Railway production DB — same URL used by qa-multi-seller.js
const DB_URL = "postgresql://routeflow:routeflow_prod_2026@gondola.proxy.rlwy.net:41006/routeflow";

const ts = Date.now();
const SLUG = `ux-audit-${ts}`;
const PASS = {
  admin: "UxAdmin@123!",
  owner: "UxOwner@123!",
  driver: "UxDriver@123!",
  buyer: "UxBuyer@123!",
  customer: "UxCustomer@123!",
};

// ── Manifest ──────────────────────────────────────────────────────────────────

const manifest = {
  createdAt: new Date().toISOString(),
  tenantSlug: SLUG,
  saUserId: null,
  tenantId: null,
  adminUserId: null,
  ownerUserId: null,
  drivers: [], // [{ driverId, userId, username }]
  suppliers: [], // [supplierId]
  products: [], // [productId]
  customers: [], // [{ customerId, userId, username }]
  buyerUsers: [], // [{ buyerUserId, email }]
  routes: [], // [routeId]
  routeRuns: [], // [runId]
  orders: [], // [orderId]
  invoices: [], // [invoiceId]
  returns: [], // [returnId]
  templates: [], // [templateId]
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function authH(token) {
  return { Authorization: `Bearer ${token}` };
}
function tenH(slug) {
  return { "X-Tenant-Slug": slug };
}

async function api(method, urlPath, body, token, extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    "X-Tenant-Slug": SLUG, // default; callers can override via extraHeaders
    ...(token ? authH(token) : {}),
    ...extraHeaders,
  };
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${urlPath} → HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return json;
}

async function login(username, password, tenantSlug) {
  const data = await api("POST", "/auth/login", { username, password }, null, {
    "X-Tenant-Slug": tenantSlug ?? SLUG,
  });
  return data.accessToken;
}

async function saLogin(username, password) {
  // SA login must NOT send X-Tenant-Slug (tenant may not exist yet)
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok)
    throw new Error(`SA login failed HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json.accessToken;
}

async function buyerLogin(email, password) {
  const data = await api("POST", "/buyer/auth/login", { email, password }, null, tenH(SLUG));
  return data.accessToken;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

let pg;
async function dbConnect() {
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
}
async function dbQuery(sql, params = []) {
  return (await pg.query(sql, params)).rows;
}

// ── Interactive confirmation ──────────────────────────────────────────────────

async function confirm(msg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n${msg} (yes/no): `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

// ── Logging ───────────────────────────────────────────────────────────────────

function step(msg) {
  console.log(`\n${"─".repeat(60)}\n  ${msg}`);
}
function ok(msg) {
  console.log(`   ✓ ${msg}`);
}
function warn(msg) {
  console.log(`   ⚠  ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 0 — Super-admin + tenant bootstrap
// ─────────────────────────────────────────────────────────────────────────────

async function phase0_bootstrap() {
  step("PHASE 0 — Bootstrap: SUPER_ADMIN + tenant");

  // 1. Create SUPER_ADMIN via direct DB insert
  const saUsername = `ux_sa_${ts}`;
  const saPassword = `SA_${crypto.randomBytes(8).toString("hex")}!`;
  const saHash = await bcrypt.hash(saPassword, 10);
  const rows = await dbQuery(
    `INSERT INTO "User" (id, username, email, password, role, status, "forcePasswordChange", "tenantId", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, 'SUPER_ADMIN', 'ACTIVE', false, NULL, NOW(), NOW())
     RETURNING id`,
    [saUsername, `${saUsername}@ux-audit.internal`, saHash],
  );
  manifest.saUserId = rows[0].id;
  ok(`SUPER_ADMIN created: ${saUsername} (id: ${manifest.saUserId})`);

  // 2. Login as SA (no tenant slug)
  const saToken = await saLogin(saUsername, saPassword);
  ok("SUPER_ADMIN logged in");

  // 3. Create tenant (send SA token; strip tenant-slug header so SA request is unambiguous)
  const r = await api(
    "POST",
    "/platform-admin/tenants",
    {
      slug: SLUG,
      businessName: "UX Audit Co",
      adminUsername: "ux_admin",
      adminEmail: `ux_admin_${ts}@ux-audit.test`,
      adminPassword: PASS.admin,
      plan: "PROFESSIONAL",
    },
    saToken,
    { "X-Tenant-Slug": "" },
  );
  manifest.tenantId = r.tenant?.id ?? r.id;
  manifest.adminUserId = r.user?.id ?? r.admin?.id;
  ok(`Tenant created: ${SLUG} (id: ${manifest.tenantId})`);

  return saToken;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 — Operator creates core entities
// ─────────────────────────────────────────────────────────────────────────────

async function phase1_coreEntities(adminToken) {
  step("PHASE 1A — Suppliers");
  const supplierDefs = [
    {
      name: "UX Supplier Alpha",
      contactName: "Alex Alpha",
      email: `alpha_${ts}@ux-audit.test`,
      phone: "555-7001",
    },
    {
      name: "UX Supplier Beta",
      contactName: "Beth Beta",
      email: `beta_${ts}@ux-audit.test`,
      phone: "555-7002",
    },
  ];
  const suppliers = [];
  for (const d of supplierDefs) {
    const s = await api("POST", "/inventory/suppliers", d, adminToken);
    manifest.suppliers.push(s.id);
    suppliers.push(s);
    ok(`${s.businessName} (${s.id.slice(0, 8)})`);
  }

  step("PHASE 1B — Products (6 unit-priced + 6 case-priced to test catalog UX)");
  const productDefs = [
    // Unit-priced
    {
      name: "Full Cream Milk 2L",
      sku: "UX-MILK-2L",
      barcode: `UX${ts}01`,
      unit: "bottle",
      pricePerUnit: "3.99",
      category: "Dairy",
    },
    {
      name: "Apple Juice 1L",
      sku: "UX-AJ-1L",
      barcode: `UX${ts}02`,
      unit: "bottle",
      pricePerUnit: "4.49",
      category: "Beverages",
    },
    {
      name: "Butter 500g",
      sku: "UX-BTR-500",
      barcode: `UX${ts}03`,
      unit: "block",
      pricePerUnit: "5.49",
      category: "Dairy",
    },
    {
      name: "Multigrain Bread",
      sku: "UX-MGB-001",
      barcode: `UX${ts}04`,
      unit: "loaf",
      pricePerUnit: "5.99",
      category: "Bakery",
    },
    {
      name: "Baby Spinach 4oz",
      sku: "UX-BSP-004",
      barcode: `UX${ts}05`,
      unit: "bag",
      pricePerUnit: "3.49",
      category: "Produce",
    },
    {
      name: "Dish Soap 22oz",
      sku: "UX-DSP-022",
      barcode: `UX${ts}06`,
      unit: "bottle",
      pricePerUnit: "4.99",
      category: "Cleaning",
    },
    // Case-priced (to exercise the "Order in: case of 12" catalog UX issue)
    {
      name: "Mineral Water 24pk",
      sku: "UX-MW-24",
      barcode: `UX${ts}07`,
      unit: "case",
      pricePerUnit: "12.99",
      category: "Beverages",
    },
    {
      name: "Protein Bars 10pk",
      sku: "UX-PB-010",
      barcode: `UX${ts}08`,
      unit: "box",
      pricePerUnit: "14.99",
      category: "Snacks",
    },
    {
      name: "Toilet Rolls 9pk",
      sku: "UX-TR-009",
      barcode: `UX${ts}09`,
      unit: "pack",
      pricePerUnit: "9.99",
      category: "Cleaning",
    },
    {
      name: "Iced Coffee 4pk",
      sku: "UX-ICF-004",
      barcode: `UX${ts}10`,
      unit: "pack",
      pricePerUnit: "9.49",
      category: "Beverages",
    },
    {
      name: "Almond Mix 16oz",
      sku: "UX-ALM-016",
      barcode: `UX${ts}11`,
      unit: "bag",
      pricePerUnit: "8.99",
      category: "Snacks",
    },
    {
      name: "Mozzarella 12oz",
      sku: "UX-MOZ-012",
      barcode: `UX${ts}12`,
      unit: "pack",
      pricePerUnit: "6.49",
      category: "Dairy",
    },
  ];
  const products = [];
  for (const d of productDefs) {
    const p = await api("POST", "/products", d, adminToken);
    await api(
      "POST",
      "/inventory/movements/adjustment",
      { productId: p.id, quantity: 100, notes: "UX audit initial stock" },
      adminToken,
    );
    manifest.products.push(p.id);
    products.push({ ...p, pricePerUnit: parseFloat(d.pricePerUnit) });
    ok(`${p.name} (${d.unit})`);
  }

  return { suppliers, products };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — Customers + buyer portal accounts
// ─────────────────────────────────────────────────────────────────────────────

async function phase2_customers(adminToken, products) {
  step("PHASE 2A — Customers");

  const custDefs = [
    {
      username: "ux_cust_empty",
      email: `ux_empty_${ts}@ux-audit.test`,
      businessName: "UX Empty Cafe",
      contactName: "Alex Empty",
      phone: "555-8001",
      address: {
        label: "Main",
        line1: "1 Empty St",
        city: "San Francisco",
        state: "CA",
        zip: "94105",
      },
    },
    {
      username: "ux_cust_delivered",
      email: `ux_delivered_${ts}@ux-audit.test`,
      businessName: "UX Delivered Deli",
      contactName: "Beth Deliv",
      phone: "555-8002",
      address: {
        label: "Main",
        line1: "2 Delivery Ave",
        city: "Oakland",
        state: "CA",
        zip: "94601",
      },
    },
    {
      username: "ux_cust_overdue",
      email: `ux_overdue_${ts}@ux-audit.test`,
      businessName: "UX Overdue Bistro",
      contactName: "Charlie Owe",
      phone: "555-8003",
      address: {
        label: "Main",
        line1: "3 Overdue Rd",
        city: "Berkeley",
        state: "CA",
        zip: "94710",
      },
    },
    {
      username: "ux_cust_standing",
      email: `ux_standing_${ts}@ux-audit.test`,
      businessName: "UX Standing Grill",
      contactName: "Dana Stand",
      phone: "555-8004",
      address: {
        label: "Main",
        line1: "4 Standing Blvd",
        city: "Daly City",
        state: "CA",
        zip: "94014",
      },
    },
  ];

  const customers = [];
  for (const d of custDefs) {
    const { address, ...rest } = d;
    const res = await api("POST", "/customers", { ...rest, addresses: [address] }, adminToken);
    const custId = res.customer?.id ?? res.id;
    const userId = res.user?.id;
    const tempPw = res.tempPassword;

    // Reset password
    const cTok = await login(d.username, tempPw);
    await api(
      "POST",
      "/auth/change-password",
      { currentPassword: tempPw, newPassword: PASS.customer },
      cTok,
    );

    // Fetch address ID
    const profile = await api("GET", "/customers/me", null, await login(d.username, PASS.customer));
    const addrId = profile.addresses?.[0]?.id ?? null;

    manifest.customers.push({ customerId: custId, userId, username: d.username });
    customers.push({
      id: custId,
      userId,
      username: d.username,
      addressId: addrId,
      businessName: d.businessName,
    });
    ok(`${d.businessName} (${d.username})`);
  }

  step("PHASE 2B — Buyer portal invites + accounts");
  // Buyer descriptions match the credentials table
  const buyerDefs = [
    { custIndex: 0, email: `ux_buyer1_${ts}@ux-audit.test`, name: "Buyer One (no orders)" },
    { custIndex: 1, email: `ux_buyer2_${ts}@ux-audit.test`, name: "Buyer Two (delivered+paid)" },
    { custIndex: 2, email: `ux_buyer3_${ts}@ux-audit.test`, name: "Buyer Three (overdue)" },
    { custIndex: 3, email: `ux_buyer4_${ts}@ux-audit.test`, name: "Buyer Four (standing order)" },
  ];

  const buyers = []; // [{ email, token }]
  for (const bd of buyerDefs) {
    const cust = customers[bd.custIndex];

    // Re-login as admin to get fresh token (JWT_EXPIRES_IN=15m may expire mid-phase)
    const freshAdminToken = await login("ux_admin", PASS.admin);

    // 1. Operator sends invite
    await api("POST", `/customers/${cust.id}/portal-invite`, { method: "EMAIL" }, freshAdminToken);

    // 2. Fetch invite token from DB
    const rows = await dbQuery(
      `SELECT "inviteToken" FROM "CustomerLink" WHERE "customerId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
      [cust.id],
    );
    const token = rows[0]?.inviteToken;
    if (!token) {
      warn(`No invite token found for ${cust.username} — skipping buyer account`);
      continue;
    }

    // 3. Register buyer account
    await api(
      "POST",
      "/buyer/auth/register",
      { email: bd.email, password: PASS.buyer, name: bd.name },
      null,
      {},
    );

    // 4. Login as buyer
    const buyerTok = await buyerLogin(bd.email, PASS.buyer);

    // 5. Accept invite
    await api("POST", `/buyer/invites/${token}/accept`, {}, buyerTok, {});

    // 6. Track buyer account ID
    const rows2 = await dbQuery(`SELECT id FROM "BuyerAccount" WHERE email = $1`, [bd.email]);
    const buyerUserId = rows2[0]?.id;
    manifest.buyerUsers.push({ buyerUserId, email: bd.email });
    buyers.push({ email: bd.email, token: buyerTok });
    ok(`${bd.name} → ${bd.email}`);
  }

  return { customers, buyers };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Drivers
// ─────────────────────────────────────────────────────────────────────────────

async function phase3_drivers(adminToken) {
  step("PHASE 3 — Drivers");

  const driverDefs = [
    {
      username: "ux_driver_a",
      email: `ux_drvA_${ts}@ux-audit.test`,
      contactName: "UX Driver Alpha",
      phone: "555-9001",
      vehicleMake: "Ford",
      vehicleModel: "Transit",
      vehicleColour: "White",
      vehiclePlate: `UXA${ts}`,
    },
    {
      username: "ux_driver_b",
      email: `ux_drvB_${ts}@ux-audit.test`,
      contactName: "UX Driver Beta",
      phone: "555-9002",
      vehicleMake: "Toyota",
      vehicleModel: "HiAce",
      vehicleColour: "Silver",
      vehiclePlate: `UXB${ts}`,
    },
  ];

  const drivers = [];
  for (const d of driverDefs) {
    const res = await api("POST", "/drivers", d, adminToken);
    const driverId = res.driver?.id ?? res.id;
    const userId = res.user?.id;
    const tempPw = res.tempPassword;

    // Reset password
    const dTok = await login(d.username, tempPw);
    await api(
      "POST",
      "/auth/change-password",
      { currentPassword: tempPw, newPassword: PASS.driver },
      dTok,
    );

    manifest.drivers.push({ driverId, userId, username: d.username });
    drivers.push({ id: driverId, userId, username: d.username });
    ok(`${d.contactName} (${d.username})`);
  }

  return drivers;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — Routes + runs
// ─────────────────────────────────────────────────────────────────────────────

async function phase4_routes(adminToken, drivers, customers) {
  step("PHASE 4 — Routes + route runs");

  const today = new Date().toISOString().split("T")[0];

  // Route A — assigned to driver_a with 3 stops
  const routeA = await api(
    "POST",
    "/routes",
    { name: "UX Route A (assigned)", driverId: drivers[0].id },
    adminToken,
  );
  manifest.routes.push(routeA.id);
  ok(`Route A created (id: ${routeA.id.slice(0, 8)})`);

  for (let i = 0; i < Math.min(customers.length, 3); i++) {
    const c = customers[i];
    await api(
      "POST",
      `/routes/${routeA.id}/stops`,
      {
        customerId: c.id,
        customerAddressId: c.addressId,
        stopNumber: i + 1,
      },
      adminToken,
    );
  }
  ok("Added 3 stops to Route A");

  const runA = await api(
    "POST",
    "/route-runs",
    {
      routeId: routeA.id,
      scheduledDate: today,
      driverId: drivers[0].id,
    },
    adminToken,
  );
  manifest.routeRuns.push(runA.id);
  ok(`Run A created (${runA.id.slice(0, 8)})`);

  // Route B — unassigned (no driver), 1 stop — exercises "unassigned" dispatch UI
  const routeB = await api("POST", "/routes", { name: "UX Route B (unassigned)" }, adminToken);
  manifest.routes.push(routeB.id);
  if (customers[3]) {
    await api(
      "POST",
      `/routes/${routeB.id}/stops`,
      {
        customerId: customers[3].id,
        customerAddressId: customers[3].addressId,
        stopNumber: 1,
      },
      adminToken,
    );
  }
  ok(`Route B created (unassigned) (id: ${routeB.id.slice(0, 8)})`);

  return { routeA, routeB, runA };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5 — Orders across all status states
// ─────────────────────────────────────────────────────────────────────────────

async function phase5_orders(adminToken, customers, products) {
  step("PHASE 5 — Orders (PENDING, CONFIRMED, OUT_FOR_DELIVERY, DELIVERED×2, CANCELLED)");

  const byName = {};
  for (const p of products) byName[p.name] = p;

  const orderDefs = [
    // cust_delivered gets DELIVERED orders so Reorder UX can be tested
    {
      custUsername: "ux_cust_delivered",
      items: [
        { name: "Full Cream Milk 2L", qty: 3 },
        { name: "Apple Juice 1L", qty: 2 },
      ],
      targetStatus: "DELIVERED",
    },
    {
      custUsername: "ux_cust_delivered",
      items: [
        { name: "Butter 500g", qty: 4 },
        { name: "Multigrain Bread", qty: 5 },
      ],
      targetStatus: "DELIVERED",
    },
    // Other order states for operator view
    {
      custUsername: "ux_cust_overdue",
      items: [{ name: "Mozzarella 12oz", qty: 2 }],
      targetStatus: "CONFIRMED",
    },
    {
      custUsername: "ux_cust_standing",
      items: [
        { name: "Protein Bars 10pk", qty: 3 },
        { name: "Almond Mix 16oz", qty: 2 },
      ],
      targetStatus: "OUT_FOR_DELIVERY",
    },
    {
      custUsername: "ux_cust_empty",
      items: [{ name: "Dish Soap 22oz", qty: 6 }],
      targetStatus: "PENDING",
    },
    {
      custUsername: "ux_cust_overdue",
      items: [{ name: "Iced Coffee 4pk", qty: 2 }],
      targetStatus: "CANCELLED",
    },
  ];

  const orders = [];
  const statusTransitions = {
    PENDING: [],
    CONFIRMED: ["CONFIRMED"],
    OUT_FOR_DELIVERY: ["CONFIRMED", "OUT_FOR_DELIVERY"],
    DELIVERED: ["CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED"],
    CANCELLED: ["CANCELLED"],
  };

  for (const od of orderDefs) {
    const cTok = await login(od.custUsername, PASS.customer);
    const items = od.items.map((i) => ({ productId: byName[i.name].id, qty: i.qty }));
    const order = await api("POST", "/orders", { items }, cTok);
    manifest.orders.push(order.id);

    // Walk status transitions as operator
    for (const status of statusTransitions[od.targetStatus]) {
      await api("PATCH", `/orders/${order.id}/status`, { status }, adminToken);
    }

    orders.push({ ...order, custUsername: od.custUsername, targetStatus: od.targetStatus });
    ok(`Order ${order.orderNumber} (${od.custUsername}) → ${od.targetStatus}`);
  }

  return orders;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 6 — Invoices (PAID, SENT/unpaid, OVERDUE, VOID)
// ─────────────────────────────────────────────────────────────────────────────

async function phase6_invoices(adminToken, customers, orders, products) {
  step("PHASE 6 — Invoices");

  const byName = {};
  for (const p of products) byName[p.name] = p;

  const custByUsername = {};
  for (const c of customers) custByUsername[c.username] = c;

  const today = new Date();
  const future = new Date(today.getTime() + 30 * 86400000).toISOString().split("T")[0];
  const yesterday = new Date(today.getTime() - 1 * 86400000).toISOString().split("T")[0];

  // Invoice 1 — SENT/unpaid (for ux_cust_delivered, will stay unpaid for buyer portal)
  const inv1 = await api(
    "POST",
    "/invoices",
    {
      customerId: custByUsername["ux_cust_delivered"].id,
      items: [
        {
          description: "Full Cream Milk 2L",
          productId: byName["Full Cream Milk 2L"].id,
          qty: 3,
          unitPrice: byName["Full Cream Milk 2L"].pricePerUnit,
        },
      ],
      dueDate: future,
    },
    adminToken,
  );
  await api("POST", `/invoices/${inv1.id}/send`, {}, adminToken);
  manifest.invoices.push(inv1.id);
  ok(`Invoice ${inv1.invoiceNumber} — SENT (unpaid)`);

  // Invoice 2 — PAID (mark payment)
  const inv2 = await api(
    "POST",
    "/invoices",
    {
      customerId: custByUsername["ux_cust_delivered"].id,
      items: [
        {
          description: "Apple Juice 1L",
          productId: byName["Apple Juice 1L"].id,
          qty: 2,
          unitPrice: byName["Apple Juice 1L"].pricePerUnit,
        },
      ],
      dueDate: future,
    },
    adminToken,
  );
  await api("POST", `/invoices/${inv2.id}/send`, {}, adminToken);
  // Record full payment
  const totalPaid = byName["Apple Juice 1L"].pricePerUnit * 2;
  await api(
    "POST",
    "/invoices/payments/record",
    { invoiceId: inv2.id, amount: totalPaid, method: "CASH", notes: "UX audit test payment" },
    adminToken,
  ).catch(() => {
    // Some API versions use a different path
    return api(
      "POST",
      `/invoices/${inv2.id}/payments`,
      { amount: totalPaid, method: "CASH" },
      adminToken,
    );
  });
  manifest.invoices.push(inv2.id);
  ok(`Invoice ${inv2.invoiceNumber} — PAID`);

  // Invoice 3 — OVERDUE (due yesterday, still SENT)
  const inv3 = await api(
    "POST",
    "/invoices",
    {
      customerId: custByUsername["ux_cust_overdue"].id,
      items: [
        {
          description: "Mozzarella 12oz",
          productId: byName["Mozzarella 12oz"].id,
          qty: 2,
          unitPrice: byName["Mozzarella 12oz"].pricePerUnit,
        },
      ],
      dueDate: yesterday,
    },
    adminToken,
  );
  await api("POST", `/invoices/${inv3.id}/send`, {}, adminToken);
  manifest.invoices.push(inv3.id);
  ok(`Invoice ${inv3.invoiceNumber} — OVERDUE (due yesterday)`);

  // Invoice 4 — VOID
  const inv4 = await api(
    "POST",
    "/invoices",
    {
      customerId: custByUsername["ux_cust_standing"].id,
      items: [
        {
          description: "Protein Bars 10pk",
          productId: byName["Protein Bars 10pk"].id,
          qty: 1,
          unitPrice: byName["Protein Bars 10pk"].pricePerUnit,
        },
      ],
      dueDate: future,
    },
    adminToken,
  );
  await api("POST", `/invoices/${inv4.id}/void`, {}, adminToken).catch(() =>
    api("PATCH", `/invoices/${inv4.id}/status`, { status: "VOID" }, adminToken),
  );
  manifest.invoices.push(inv4.id);
  ok(`Invoice ${inv4.invoiceNumber} — VOID`);

  return [inv1, inv2, inv3, inv4];
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 7 — Return + standing order template
// ─────────────────────────────────────────────────────────────────────────────

async function phase7_returnAndTemplate(customers, orders, products) {
  step("PHASE 7 — Return + standing order template");

  const byName = {};
  for (const p of products) byName[p.name] = p;

  // Return: from the first DELIVERED order of ux_cust_delivered
  const deliveredOrder = orders.find(
    (o) => o.custUsername === "ux_cust_delivered" && o.targetStatus === "DELIVERED",
  );
  if (deliveredOrder) {
    try {
      const cTok = await login("ux_cust_delivered", PASS.customer);
      const ret = await api(
        "POST",
        "/returns",
        {
          orderId: deliveredOrder.id,
          reason: "DAMAGED",
          items: [
            {
              productId: byName["Full Cream Milk 2L"].id,
              qty: 1,
              reason: "DAMAGED",
              restock: false,
            },
          ],
        },
        cTok,
      );
      manifest.returns.push(ret.id ?? ret.returnId);
      ok(`Return created for order ${deliveredOrder.orderNumber} (DAMAGED milk)`);
    } catch (e) {
      warn(`Return creation failed: ${e.message}`);
    }
  }

  // Standing order template: for ux_cust_standing (weekly, Mon/Wed/Fri)
  try {
    const cTok = await login("ux_cust_standing", PASS.customer);
    const tmpl = await api(
      "POST",
      "/order-templates",
      {
        name: "UX Weekly Protein & Almonds",
        daysOfWeek: [1, 3, 5],
        items: [
          { productId: byName["Protein Bars 10pk"].id, qty: 4 },
          { productId: byName["Almond Mix 16oz"].id, qty: 2 },
        ],
      },
      cTok,
    );
    manifest.templates.push(tmpl.id);
    ok(`Standing order template created (Mon/Wed/Fri) for ux_cust_standing`);
  } catch (e) {
    warn(`Template creation failed: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  RouteFlow UX Audit — Seed Script                       ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  Tenant slug: ${SLUG.padEnd(43)}║`);
  console.log(`║  API target:  ${API.padEnd(43)}║`);
  console.log(`║  DB target:   ${DB_URL.replace(/:([^:@]+)@/, ":***@").slice(0, 43)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝");

  const ok_ = await confirm(
    "⚠  This will create a new tenant and ~30 records in the RAILWAY PRODUCTION database.\n" +
      "   Cleanup is tracked via a manifest and fully reversible.\n" +
      "   Proceed?",
  );
  if (!ok_) {
    console.log("\nAborted.");
    process.exit(0);
  }

  await dbConnect();
  console.log("\n✔ Connected to Railway DB");

  const saToken = await phase0_bootstrap();

  // Helper: fresh token at each phase to avoid 15-min JWT expiry mid-run
  const freshToken = () => login("ux_admin", PASS.admin);

  ok("Tenant admin logged in");
  const { products } = await phase1_coreEntities(await freshToken());
  const { customers, buyers } = await phase2_customers(await freshToken(), products);
  const drivers = await phase3_drivers(await freshToken());
  const { runA } = await phase4_routes(await freshToken(), drivers, customers);
  const orders = await phase5_orders(await freshToken(), customers, products);
  await phase6_invoices(await freshToken(), customers, orders, products);
  await phase7_returnAndTemplate(customers, orders, products);

  // ── Write manifest ─────────────────────────────────────────────────────────

  const manifestPath = path.join(__dirname, `ux-audit-manifest-${ts}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  // ── Print credentials table ────────────────────────────────────────────────

  const b1 = buyers[0]?.email ?? "(failed)";
  const b2 = buyers[1]?.email ?? "(failed)";
  const b3 = buyers[2]?.email ?? "(failed)";
  const b4 = buyers[3]?.email ?? "(failed)";

  console.log("\n");
  console.log("═".repeat(65));
  console.log("  RouteFlow UX Audit — Test Accounts");
  console.log(`  Tenant code:  ${SLUG}`);
  console.log(`  App URL:      https://routeflowmobile-production.up.railway.app`);
  console.log("═".repeat(65));
  console.log(`  OPERATOR    ux_admin       ${PASS.admin}`);
  console.log(`  DRIVER A    ux_driver_a    ${PASS.driver}   (Route A, today)`);
  console.log(`  DRIVER B    ux_driver_b    ${PASS.driver}   (unassigned)`);
  console.log(`  BUYER 1     ${b1.padEnd(30)} ${PASS.buyer}  (no orders)`);
  console.log(`  BUYER 2     ${b2.padEnd(30)} ${PASS.buyer}  (delivered + paid)`);
  console.log(`  BUYER 3     ${b3.padEnd(30)} ${PASS.buyer}  (overdue invoice)`);
  console.log(`  BUYER 4     ${b4.padEnd(30)} ${PASS.buyer}  (standing order)`);
  console.log("═".repeat(65));
  console.log(`  Manifest:   ${manifestPath}`);
  console.log("═".repeat(65));
  console.log("\n  Cleanup when done:");
  console.log(`  node apps/api/scripts/ux-audit-cleanup.js ${manifestPath}\n`);
}

main()
  .catch((err) => {
    console.error("\n❌ Seed failed:", err.message);
    if (manifest.tenantId || manifest.saUserId) {
      const failPath = path.join(__dirname, `ux-audit-manifest-FAILED-${ts}.json`);
      fs.writeFileSync(failPath, JSON.stringify(manifest, null, 2), "utf8");
      console.error(`\n⚠  Partial manifest saved to: ${failPath}`);
      console.error(
        `   Run cleanup to remove what was created:\n   node apps/api/scripts/ux-audit-cleanup.js ${failPath}`,
      );
    }
    process.exit(1);
  })
  .finally(async () => {
    if (pg) await pg.end();
  });
