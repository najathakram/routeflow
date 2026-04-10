#!/usr/bin/env node
// Phase 3 Buyer Portal Smoke Test: seller-scoped delegation + SUPER_ADMIN admin endpoints
const http = require("http");

function req(method, path, body, headers) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { "Content-Type": "application/json", "Content-Length": data ? Buffer.byteLength(data) : 0 };
    if (headers) Object.assign(h, headers);
    const r = http.request(
      { hostname: "localhost", port: 3000, path: "/api/v1" + path, method, headers: h },
      (resp) => {
        let d = "";
        resp.on("data", (c) => (d += c));
        resp.on("end", () => res({ status: resp.statusCode, body: JSON.parse(d || "{}") }));
      },
    );
    r.on("error", rej);
    if (data) r.write(data);
    r.end();
  });
}

const G = "\x1b[32m";
const R = "\x1b[31m";
const X = "\x1b[0m";
let pass = 0, fail = 0;
function ok(n, msg) { console.log(`  ${G}✓${X} [${n}] ${msg}`); pass++; }
function ng(n, msg) { console.log(`  ${R}✗${X} [${n}] ${msg}`); fail++; }

async function main() {
  // ─── Setup ───────────────────────────────────────────────────────────────
  const sa = await req("POST", "/auth/login", { username: "najathakram", password: "Najath123!" });
  const saToken = sa.body.accessToken;
  const ts = Date.now();
  const slug = "bsmoke3-" + ts;
  const buyerEmail = "bphase3-" + ts + "@test.io";

  const tt = await req("POST", "/platform-admin/tenants", {
    businessName: "BuyerPhase3", slug,
    adminEmail: "bp3@test.io", adminUsername: "bp3owner", adminPassword: "Owner@123",
  }, { Authorization: "Bearer " + saToken });
  const tenantId = tt.body.id;

  // Login as TENANT_ADMIN, create OPERATOR user
  const tal = await req("POST", "/auth/login", { username: "bp3owner", password: "Owner@123" }, { "X-Tenant-Slug": slug });
  const taToken = tal.body.accessToken;

  // Create an OPERATOR user (required because TENANT_ADMIN can't create orders)
  const opUser = await req("POST", "/users/operator", {
    email: "bp3op-" + ts + "@test.io", username: "bp3op" + ts,
  }, { Authorization: "Bearer " + taToken });
  const opTempPass = opUser.body.tempPassword || opUser.body.password;

  // Login as operator (must change password first)
  const opLogin = await req("POST", "/auth/login", { username: "bp3op" + ts, password: opTempPass }, { "X-Tenant-Slug": slug });
  const opTempToken = opLogin.body.accessToken;
  await req("POST", "/auth/change-password", { currentPassword: opTempPass, newPassword: "Operator@123!" }, { Authorization: "Bearer " + opTempToken });
  const opFinal = await req("POST", "/auth/login", { username: "bp3op" + ts, password: "Operator@123!" }, { "X-Tenant-Slug": slug });
  const opToken = opFinal.body.accessToken;

  // Create customer + product + order
  const cc = await req("POST", "/customers", {
    businessName: "Phase3 Cafe", email: "p3cafe@test.io",
    username: "p3cafe" + ts, contactName: "Phase3 Manager",
  }, { Authorization: "Bearer " + opToken });
  const custId = cc.body.customer ? cc.body.customer.id : cc.body.id;
  const custUserId = cc.body.customer ? cc.body.customer.userId : cc.body.userId;

  const pc = await req("POST", "/products", {
    name: "Test Bread", sku: "BREAD-" + ts, pricePerUnit: "5.00", unit: "loaf",
  }, { Authorization: "Bearer " + opToken });
  const productId = pc.body.id;

  const oc = await req("POST", "/orders", {
    customerId: custId,
    items: [{ productId, qty: 2, unitPrice: 5.0 }],
  }, { Authorization: "Bearer " + opToken });
  const orderId = oc.body.id || oc.body.order?.id;

  // Register buyer + approve link
  const br = await req("POST", "/buyer/auth/register", {
    email: buyerEmail, password: "Buyer@123!", name: "Phase3 Buyer",
  });
  const buyerToken = br.body.accessToken;
  const buyerId = br.body.buyer?.id;

  // Request and approve link
  await req("POST", "/buyer/sellers/request", { sellerSlug: slug, emailAtSeller: "p3cafe@test.io" },
    { Authorization: "Bearer " + buyerToken });
  await req("POST", "/customers/" + custId + "/portal-approve", null, { Authorization: "Bearer " + opToken });

  console.log("=== Phase 3 Buyer Portal Smoke Tests ===");
  console.log("Setup: tenant=" + slug + " | buyer=" + buyerEmail + " | order=" + orderId);

  // ─── Seller-scoped delegation ─────────────────────────────────────────────

  // T1: Buyer profile (with include)
  const prof = await req("GET", "/buyer/profile", null, {
    Authorization: "Bearer " + buyerToken, "X-Tenant-Slug": slug,
  });
  prof.status === 200 && prof.body.businessName
    ? ok(1, "Buyer profile → 200, businessName=" + prof.body.businessName)
    : ng(1, "Buyer profile: " + prof.status + " " + JSON.stringify(prof.body).slice(0, 100));

  // T2: Buyer orders delegation
  const orders = await req("GET", "/buyer/orders", null, {
    Authorization: "Bearer " + buyerToken, "X-Tenant-Slug": slug,
  });
  orders.status === 200 && orders.body.data
    ? ok(2, "Buyer orders → 200, count=" + orders.body.data.length + " meta=" + JSON.stringify(orders.body.meta))
    : ng(2, "Buyer orders: " + orders.status + " " + JSON.stringify(orders.body).slice(0, 120));

  // T3: Orders are scoped to this customer only (should see the created order)
  if (orders.status === 200 && orders.body.data) {
    const found = orders.body.data.some((o) => o.id === orderId || o.customerId === custId);
    found ? ok(3, "Buyer orders includes the created order (correctly scoped)") : ng(3, "Order not found in buyer orders");
  } else {
    ng(3, "Cannot verify order scoping (orders call failed)");
  }

  // T4: Buyer invoices delegation (no invoices yet, should return empty)
  const invoices = await req("GET", "/buyer/invoices", null, {
    Authorization: "Bearer " + buyerToken, "X-Tenant-Slug": slug,
  });
  invoices.status === 200 && invoices.body.data
    ? ok(4, "Buyer invoices → 200, count=" + invoices.body.data.length)
    : ng(4, "Buyer invoices: " + invoices.status + " " + JSON.stringify(invoices.body).slice(0, 120));

  // T5: Deliver order to create auto-invoice
  const confirmR = await req("PATCH", "/orders/" + orderId + "/status", { status: "CONFIRMED" }, { Authorization: "Bearer " + opToken });
  const deliverR = await req("PATCH", "/orders/" + orderId + "/status", { status: "DELIVERED" }, { Authorization: "Bearer " + opToken });
  // Auto-invoice is created fire-and-forget — wait for it to settle
  await new Promise((r) => setTimeout(r, 800));
  console.log("    [debug] CONFIRM:", confirmR.status, " DELIVER:", deliverR.status, "(waited 800ms for auto-invoice)");

  const invoices2 = await req("GET", "/buyer/invoices", null, {
    Authorization: "Bearer " + buyerToken, "X-Tenant-Slug": slug,
  });
  invoices2.status === 200 && invoices2.body.data && invoices2.body.data.length > 0
    ? ok(5, "Buyer invoices after delivery → " + invoices2.body.data.length + " invoice(s)")
    : ng(5, "Buyer invoices after delivery: " + invoices2.status + " count=" + (invoices2.body.data?.length ?? "?"));

  // T6: Buyer statement
  const stmt = await req("GET", "/buyer/statement", null, {
    Authorization: "Bearer " + buyerToken, "X-Tenant-Slug": slug,
  });
  stmt.status === 200
    ? ok(6, "Buyer statement → 200")
    : ng(6, "Buyer statement: " + stmt.status + " " + JSON.stringify(stmt.body).slice(0, 100));

  // T7: Buyer orders without X-Tenant-Slug → 400
  const noSlug = await req("GET", "/buyer/orders", null, { Authorization: "Bearer " + buyerToken });
  noSlug.status === 400
    ? ok(7, "Buyer orders without X-Tenant-Slug → 400")
    : ng(7, "No header check: " + noSlug.status + " " + JSON.stringify(noSlug.body).slice(0, 80));

  // ─── SUPER_ADMIN buyer admin endpoints ────────────────────────────────────

  // T8: List buyer accounts
  const buyers = await req("GET", "/platform-admin/buyer-accounts", null, {
    Authorization: "Bearer " + saToken,
  });
  buyers.status === 200 && buyers.body.data
    ? ok(8, "SA list buyers → 200, total=" + buyers.body.meta.total)
    : ng(8, "SA list buyers: " + buyers.status + " " + JSON.stringify(buyers.body).slice(0, 80));

  // T9: Get specific buyer
  const buyerGet = await req("GET", "/platform-admin/buyer-accounts/" + buyerId, null, {
    Authorization: "Bearer " + saToken,
  });
  buyerGet.status === 200 && buyerGet.body.email === buyerEmail
    ? ok(9, "SA get buyer → 200, email=" + buyerGet.body.email + " links=" + buyerGet.body.customerLinks?.length)
    : ng(9, "SA get buyer: " + buyerGet.status + " " + JSON.stringify(buyerGet.body).slice(0, 100));

  // T10: Set buyer status to SUSPENDED
  const suspend = await req("PATCH", "/platform-admin/buyer-accounts/" + buyerId + "/status", { status: "SUSPENDED" },
    { Authorization: "Bearer " + saToken });
  suspend.status === 200 && suspend.body.status === "SUSPENDED"
    ? ok(10, "SA suspend buyer → SUSPENDED")
    : ng(10, "SA suspend: " + suspend.status + " " + JSON.stringify(suspend.body).slice(0, 80));

  // T11: Re-activate
  const activate = await req("PATCH", "/platform-admin/buyer-accounts/" + buyerId + "/status", { status: "ACTIVE" },
    { Authorization: "Bearer " + saToken });
  activate.status === 200 && activate.body.status === "ACTIVE"
    ? ok(11, "SA activate buyer → ACTIVE")
    : ng(11, "SA activate: " + activate.status + " " + JSON.stringify(activate.body).slice(0, 80));

  // T12: Impersonate buyer
  const imperso = await req("POST", "/platform-admin/buyer-accounts/" + buyerId + "/impersonate", null,
    { Authorization: "Bearer " + saToken });
  imperso.status === 200 && imperso.body.accessToken
    ? ok(12, "SA impersonate buyer → impersonation token issued")
    : ng(12, "SA impersonate: " + imperso.status + " " + JSON.stringify(imperso.body).slice(0, 80));

  // T13: List customer links
  const links = await req("GET", "/platform-admin/customer-links", null, { Authorization: "Bearer " + saToken });
  links.status === 200 && links.body.data
    ? ok(13, "SA list customer links → total=" + links.body.meta.total)
    : ng(13, "SA links: " + links.status + " " + JSON.stringify(links.body).slice(0, 80));

  // T14: Link stats
  const stats = await req("GET", "/platform-admin/customer-links/stats", null, { Authorization: "Bearer " + saToken });
  stats.status === 200 && stats.body.links && stats.body.buyers
    ? ok(14, "SA link stats → links.total=" + stats.body.links.total + " buyers.total=" + stats.body.buyers.total)
    : ng(14, "SA stats: " + stats.status + " " + JSON.stringify(stats.body).slice(0, 80));

  // T15: Tenant JWT cannot access SUPER_ADMIN buyer endpoints
  const opBlocked = await req("GET", "/platform-admin/buyer-accounts", null, { Authorization: "Bearer " + opToken });
  opBlocked.status === 403
    ? ok(15, "Operator cannot access SA buyer endpoints → 403")
    : ng(15, "Operator not blocked on SA buyers: " + opBlocked.status);

  // ─── Cleanup ─────────────────────────────────────────────────────────────
  await req("DELETE", "/platform-admin/tenants/" + tenantId, null, { Authorization: "Bearer " + saToken });

  console.log("\n" + (fail === 0 ? G + "All " + pass + " Phase 3 tests passed!" : R + fail + " FAILED, " + pass + " passed") + X);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
