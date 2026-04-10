#!/usr/bin/env node
// Phase 2 Buyer Portal Smoke Test
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
  const slug = "bsmoke-" + Date.now();
  const tt = await req(
    "POST",
    "/platform-admin/tenants",
    { businessName: "BuyerSmoke", slug, adminEmail: "bsm@test.io", adminUsername: "bsmowner", adminPassword: "Owner@123" },
    { Authorization: "Bearer " + saToken },
  );
  const tenantId = tt.body.id;
  const ol = await req("POST", "/auth/login", { username: "bsmowner", password: "Owner@123" }, { "X-Tenant-Slug": slug });
  const opToken = ol.body.accessToken;
  const cc = await req(
    "POST",
    "/customers",
    { businessName: "Smoke Cafe", email: "smoke@cafe.io", username: "smokecafe" + Date.now(), contactName: "Smoke Manager" },
    { Authorization: "Bearer " + opToken },
  );
  const custId = cc.body.customer ? cc.body.customer.id : cc.body.id;

  const ts = Date.now();
  const buyerEmail = "bsmoke-" + ts + "@test.io";

  console.log("=== Phase 2 Buyer Portal Smoke Tests ===");
  console.log("Setup: slug=" + slug + "  custId=" + custId + "  buyer=" + buyerEmail);

  // T1: Register buyer
  const br = await req("POST", "/buyer/auth/register", { email: buyerEmail, password: "Buyer@123!", name: "Buyer Test" });
  br.status === 201 && br.body.accessToken ? ok(1, "Buyer register → 201 + accessToken") : ng(1, "Buyer register: " + br.status + " " + JSON.stringify(br.body).slice(0, 80));
  const buyerToken = br.body.accessToken;
  const buyerRefToken = br.body.refreshToken;

  // T2: Buyer login
  const bl = await req("POST", "/buyer/auth/login", { email: buyerEmail, password: "Buyer@123!" });
  bl.status === 200 && bl.body.accessToken ? ok(2, "Buyer login → 200 + token") : ng(2, "Buyer login: " + bl.status);

  // T3: Buyer refresh
  const rf = await req("POST", "/buyer/auth/refresh", { refreshToken: buyerRefToken });
  rf.status === 200 && rf.body.accessToken ? ok(3, "Buyer refresh → 200 + new token") : ng(3, "Buyer refresh: " + rf.status + " " + JSON.stringify(rf.body).slice(0, 80));
  const activeToken = rf.body.accessToken || buyerToken;

  // T4: Buyer token rejected on tenant endpoint
  const guard = await req("GET", "/customers", null, { Authorization: "Bearer " + activeToken });
  guard.status === 401 ? ok(4, "Buyer token on /customers → 401 (correctly rejected)") : ng(4, "Buyer token NOT rejected: " + guard.status);

  // T5: Public invite details endpoint (no auth)
  const pub = await req("GET", "/buyer/invites/badtoken/details");
  pub.status === 404 ? ok(5, "Public invite details (bad token) → 404 not 401") : ng(5, "Public invite details: " + pub.status + " (expected 404)");

  // T6: Sellers list (empty before link)
  const sell0 = await req("GET", "/buyer/sellers", null, { Authorization: "Bearer " + activeToken });
  sell0.status === 200 && Array.isArray(sell0.body) && sell0.body.length === 0
    ? ok(6, "Buyer sellers (none) → 200 []")
    : ng(6, "Sellers: " + sell0.status + " " + JSON.stringify(sell0.body).slice(0, 80));

  // T7: Operator sends portal invite
  const inv = await req("POST", "/customers/" + custId + "/portal-invite", { method: "EMAIL" }, { Authorization: "Bearer " + opToken });
  (inv.status === 201 || inv.status === 200) && inv.body.inviteUrl
    ? ok(7, "Send invite → " + inv.status + " | inviteUrl present")
    : ng(7, "Send invite: " + inv.status + " " + JSON.stringify(inv.body).slice(0, 120));

  // T8: Portal status → INVITED
  const ps1 = await req("GET", "/customers/" + custId + "/portal-status", null, { Authorization: "Bearer " + opToken });
  ps1.status === 200 && ps1.body.status === "INVITED"
    ? ok(8, "Portal status → INVITED")
    : ng(8, "Portal status: " + ps1.status + " " + JSON.stringify(ps1.body).slice(0, 100));

  // T9: Resend invite
  const rs = await req("POST", "/customers/" + custId + "/portal-resend", null, { Authorization: "Bearer " + opToken });
  rs.status === 201 || rs.status === 200 ? ok(9, "Resend invite → " + rs.status) : ng(9, "Resend invite: " + rs.status + " " + JSON.stringify(rs.body).slice(0, 80));

  // T10: Disconnect portal (operator)
  const disc = await req("POST", "/customers/" + custId + "/portal-disconnect", null, { Authorization: "Bearer " + opToken });
  (disc.status === 200 || disc.status === 201) && disc.body.message ? ok(10, "Disconnect portal: " + disc.body.message) : ng(10, "Disconnect: " + disc.status + " " + JSON.stringify(disc.body).slice(0, 80));

  // T11: Portal status after disconnect → DISCONNECTED
  const ps2 = await req("GET", "/customers/" + custId + "/portal-status", null, { Authorization: "Bearer " + opToken });
  ps2.body.status === "DISCONNECTED" ? ok(11, "Status after disconnect → DISCONNECTED") : ng(11, "After disconnect: " + JSON.stringify(ps2.body).slice(0, 80));

  // T12: Buyer-initiated flow — request seller (needs clean CustomerLink)
  // Re-invite then disconnect to reset, then buyer requests
  await req("POST", "/customers/" + custId + "/portal-invite", { method: "EMAIL" }, { Authorization: "Bearer " + opToken });
  await req("POST", "/customers/" + custId + "/portal-disconnect", null, { Authorization: "Bearer " + opToken });
  const reqSell = await req("POST", "/buyer/sellers/request", { sellerSlug: slug, emailAtSeller: "smoke@cafe.io" }, { Authorization: "Bearer " + activeToken });
  reqSell.status === 200 ? ok(12, "Buyer requestSeller → 200 | " + reqSell.body.message) : ng(12, "requestSeller: " + reqSell.status + " " + JSON.stringify(reqSell.body).slice(0, 120));

  // T13: Portal status → PENDING_SELLER_APPROVAL
  const ps3 = await req("GET", "/customers/" + custId + "/portal-status", null, { Authorization: "Bearer " + opToken });
  ps3.body.status === "PENDING_SELLER_APPROVAL" ? ok(13, "Status → PENDING_SELLER_APPROVAL") : ng(13, "After request: " + JSON.stringify(ps3.body).slice(0, 100));

  // T14: Operator approves buyer request
  const appr = await req("POST", "/customers/" + custId + "/portal-approve", null, { Authorization: "Bearer " + opToken });
  (appr.status === 200 || appr.status === 201) && appr.body.message ? ok(14, "Approve buyer request → " + appr.body.message) : ng(14, "Approve: " + appr.status + " " + JSON.stringify(appr.body).slice(0, 80));

  // T15: Portal status → ACTIVE with buyerAccount email
  const ps4 = await req("GET", "/customers/" + custId + "/portal-status", null, { Authorization: "Bearer " + opToken });
  ps4.body.status === "ACTIVE" && ps4.body.buyerAccount && ps4.body.buyerAccount.email === buyerEmail
    ? ok(15, "Status → ACTIVE, buyerAccount.email = " + ps4.body.buyerAccount.email)
    : ng(15, "After approve: " + JSON.stringify(ps4.body).slice(0, 150));

  // T16: Buyer sellers list shows this seller
  const sell1 = await req("GET", "/buyer/sellers", null, { Authorization: "Bearer " + activeToken });
  sell1.status === 200 && sell1.body.length > 0
    ? ok(16, "Buyer sellers → [" + sell1.body[0].tenant.slug + "] linkStatus=" + sell1.body[0].linkStatus)
    : ng(16, "Sellers after approval: " + sell1.status + " " + JSON.stringify(sell1.body).slice(0, 100));

  // T17: Seller-scoped buyer profile
  const prof = await req("GET", "/buyer/profile", null, { Authorization: "Bearer " + activeToken, "X-Tenant-Slug": slug });
  prof.status === 200 ? ok(17, "Buyer profile (seller-scoped) → 200") : ng(17, "Buyer profile: " + prof.status + " " + JSON.stringify(prof.body).slice(0, 100));

  // T18: Buyer self-disconnect
  const selfDisc = await req("DELETE", "/buyer/sellers/" + slug, null, { Authorization: "Bearer " + activeToken });
  selfDisc.status === 200 ? ok(18, "Buyer self-disconnect → " + selfDisc.body.message) : ng(18, "Self-disconnect: " + selfDisc.status);

  // T19: Status → DISCONNECTED by BUYER
  const ps5 = await req("GET", "/customers/" + custId + "/portal-status", null, { Authorization: "Bearer " + opToken });
  ps5.body.status === "DISCONNECTED" && ps5.body.disconnectedBy === "BUYER"
    ? ok(19, "Final status → DISCONNECTED by BUYER")
    : ng(19, "Final status: " + JSON.stringify(ps5.body).slice(0, 100));

  // T20: Seller-scoped endpoint blocked after disconnect
  const blocked = await req("GET", "/buyer/profile", null, { Authorization: "Bearer " + activeToken, "X-Tenant-Slug": slug });
  blocked.status === 403 ? ok(20, "Buyer profile after disconnect → 403 (correctly blocked)") : ng(20, "Profile not blocked: " + blocked.status);

  // ─── Cleanup ─────────────────────────────────────────────────────────────
  await req("DELETE", "/platform-admin/tenants/" + tenantId, null, { Authorization: "Bearer " + saToken });

  console.log("\n" + (fail === 0 ? G + "All " + pass + " tests passed!" : R + fail + " FAILED, " + pass + " passed") + X);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
