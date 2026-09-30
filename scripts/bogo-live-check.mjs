/**
 * Live BUY_N_GET_M proof on the DEPLOYED prod API, test tenant `e2e-routeflow`.
 * Promotions are CUSTOMER-only by design, so the operator sets up the product +
 * promo and mints a throwaway customer, and that CUSTOMER places the order.
 * Everything is cleaned up in the finally.
 */
const BASE = (
  process.env.SMOKE_BASE_URL || "https://routeflowapi-production.up.railway.app"
).replace(/\/+$/, "");
const TENANT = "e2e-routeflow";
if (TENANT !== "e2e-routeflow") throw new Error("test tenants only");

const mk = (tok) => async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Tenant-Slug": TENANT,
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
};
const anon = mk(null);
const login = async (u, p) => {
  const r = await anon("POST", "/api/v1/auth/login", { username: u, password: p });
  if (r.status !== 200)
    throw new Error(`login ${u} -> ${r.status}: ${JSON.stringify(r.body).slice(0, 250)}`);
  return mk(r.body.accessToken || r.body.access_token);
};

const results = [];
const check = (n, ok, d) => {
  results.push({ n, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
};

const stamp = Date.now();
let op = null,
  promoId = null,
  productId = null,
  orderId = null,
  customerId = null;
try {
  op = await login(
    process.env.SMOKE_OPERATOR_USERNAME || "admin",
    process.env.SMOKE_OPERATOR_PASSWORD || "Admin@123",
  );

  const prod = await op("POST", "/api/v1/products", {
    name: `E2E-BOGO Widget ${stamp}`,
    unit: "Box",
    pricePerUnit: "35",
    unitsPerBox: 24,
    isActive: true,
  });
  productId = prod.body?.id ?? prod.body?.product?.id;
  check("product @ $35/box", !!productId, `status ${prod.status}`);
  if (!productId) throw new Error(JSON.stringify(prod.body).slice(0, 300));

  // Stock it: a customer order is refused with 409 on insufficient stock.
  // 12 boxes x 24/box = 288 pieces; buy 400 to leave headroom.
  const stock = await op("POST", "/api/v1/inventory/movements/purchase", {
    productId,
    quantity: 400,
    unitCost: 1,
    reference: `E2E-BOGO ${stamp}`,
  });
  check(
    "stock the product (400 pieces)",
    stock.status >= 200 && stock.status < 300,
    `status ${stock.status}`,
  );

  const promo = await op("POST", "/api/v1/promotions", {
    name: `E2E-BOGO buy5get1 ${stamp}`,
    bannerText: "BUY 5 GET 1 FREE",
    type: "BUY_N_GET_M",
    value: 1,
    minQty: 5,
    scope: "PRODUCTS",
    productIds: [productId],
    startsAt: new Date(Date.now() - 3600_000).toISOString(),
    endsAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    isActive: true,
  });
  promoId = promo.body?.id ?? promo.body?.promotion?.id;
  check("BUY_N_GET_M promo N=5 M=1", !!promoId, `status ${promo.status}`);
  if (!promoId) throw new Error(JSON.stringify(promo.body).slice(0, 400));

  const bad = await op("POST", "/api/v1/promotions", {
    name: `E2E-BOGO invalid ${stamp}`,
    type: "BUY_N_GET_M",
    value: 0,
    minQty: 5,
    scope: "ALL",
    startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 86400_000).toISOString(),
  });
  check("M=0 rejected by the DTO", bad.status >= 400 && bad.status < 500, `status ${bad.status}`);

  const created = await op("POST", "/api/v1/customers", {
    businessName: `E2E-BOGO Cafe ${stamp}`,
    contactName: "E2E BOGO",
    phone: "5550100",
    username: `e2ebogo${stamp}`.slice(0, 64),
  });
  const cbody = created.body?.customer ?? created.body;
  customerId = cbody?.id;
  const cUser = created.body?.user?.username;
  const cPass = created.body?.tempPassword;
  check(
    "mint throwaway customer + login",
    !!(customerId && cUser && cPass),
    `status ${created.status}`,
  );
  if (!(customerId && cUser && cPass)) throw new Error(JSON.stringify(created.body).slice(0, 400));

  // A freshly-minted customer is forced through a password change before any
  // other endpoint will answer (403 "Password change required").
  let cust = await login(cUser, cPass);
  const NEWPASS = "E2eBogo!2026x";
  const chg = await cust("POST", "/api/v1/auth/change-password", {
    currentPassword: cPass,
    newPassword: NEWPASS,
  });
  check(
    "customer clears the forced password change",
    chg.status >= 200 && chg.status < 300,
    `status ${chg.status}`,
  );
  cust = await login(cUser, NEWPASS);

  const order = await cust("POST", "/api/v1/orders", {
    items: [{ productId, qty: 12, boxes: 12, pieces: 0 }],
  });
  orderId = order.body?.id ?? order.body?.order?.id;
  check("CUSTOMER places a 12-box order", !!orderId, `status ${order.status}`);
  if (!orderId) throw new Error(JSON.stringify(order.body).slice(0, 400));

  const got = await op("GET", `/api/v1/orders/${orderId}`);
  const l = (got.body?.lineItems ?? [])[0];
  const free = Number(l?.promoFreeUnits ?? 0),
    sub = Number(l?.subtotal ?? 0),
    unit = Number(l?.unitPrice ?? 0);
  console.log(
    `\n  LINE  boxes=${l?.boxes} unitPrice=$${unit} freeUnits=${free} subtotal=$${sub} priceType=${l?.priceType}\n`,
  );

  check("12 boxes → exactly 2 free (floor(12/6))", free === 2, `got ${free}`);
  check("unitPrice stays the honest $35", unit === 35, `got ${unit}`);
  check("subtotal EXACTLY $350.00 (10 paid boxes)", sub === 350, `got ${sub}`);
  check("priceType is PROMO", l?.priceType === "PROMO", `got ${l?.priceType}`);
  check("saving is exactly 2 x $35 = $70", 12 * 35 - sub === 70, `got ${12 * 35 - sub}`);
} catch (err) {
  check("run completed", false, String(err?.message ?? err));
} finally {
  console.log("\n── cleanup ──");
  try {
    if (orderId) console.log("  order:", (await op("DELETE", `/api/v1/orders/${orderId}`)).status);
    if (promoId)
      console.log("  promo:", (await op("DELETE", `/api/v1/promotions/${promoId}`)).status);
    if (customerId)
      console.log("  customer:", (await op("DELETE", `/api/v1/customers/${customerId}`)).status);
    if (productId)
      console.log(
        "  product:",
        (await op("PATCH", `/api/v1/products/${productId}`, { isActive: false })).status,
      );
  } catch (e) {
    console.log("  cleanup issue:", String(e?.message ?? e));
  }
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failed.length} FAILED`} (${results.length} total)`,
  );
}
