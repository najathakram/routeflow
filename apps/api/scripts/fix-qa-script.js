const fs = require("fs");
let content = fs.readFileSync("apps/api/scripts/qa-multi-seller.js", "utf8");

// Fix 1.5: Use temp customer instead of CUSTOMERS.alpha.id
const old15 = `  // ── 1.5: Expired invite ─────────────────────────────────────────────────────
  console.log("\\n  SCENARIO 1.5 — Expired invite token");

  // Create a new invite for a secondary customer to test expiry
  let expiredToken = null;
  try {
    // Manufacture a token by sending a fresh invite and expiring it in DB
    await http.post(\`/customers/\${CUSTOMERS.alpha.id}/portal-invite\`,
      { method: "EMAIL" },
      { headers: { ...authHeader(TENANTS.alpha.token), ...tenantHeader(TENANTS.alpha.slug) } }
    );
    const rows = await dbQuery(\`SELECT "inviteToken" FROM "CustomerLink" WHERE "customerId" = $1\`, [CUSTOMERS.alpha.id]);
    expiredToken = rows[0]?.inviteToken;`;

const new15 = `  // ── 1.5: Expired invite ─────────────────────────────────────────────────────
  console.log("\\n  SCENARIO 1.5 — Expired invite token");

  // Use a FRESH temp customer — do NOT reuse ALPHA_CUST (upsert would overwrite Jamie's active link)
  let expiredToken = null;
  try {
    const expTs = Date.now();
    const expCustR = await http.post('/customers', {
      businessName: 'Expiry Test Corp', contactName: 'Expiry Contact',
      email: \`expiry_\${expTs}@test.io\`, username: \`expiry_corp_\${expTs}\`,
    }, { headers: { ...authHeader(TENANTS.alpha.token), ...tenantHeader(TENANTS.alpha.slug) } });
    const expCustId = expCustR.data?.customer?.id ?? expCustR.data?.id;
    await http.post(\`/customers/\${expCustId}/portal-invite\`,
      { method: "EMAIL" },
      { headers: { ...authHeader(TENANTS.alpha.token), ...tenantHeader(TENANTS.alpha.slug) } }
    );
    const rows = await dbQuery(\`SELECT "inviteToken" FROM "CustomerLink" WHERE "customerId" = $1\`, [expCustId]);
    expiredToken = rows[0]?.inviteToken;`;

if (content.includes(old15)) {
  content = content.replace(old15, new15);
  console.log("Fixed 1.5 — using temp customer");
} else {
  console.log("1.5 pattern NOT FOUND");
}

// Remove the restore block (no longer needed since we use temp customer)
const oldRestore = `  // Restore Alpha invite for downstream tests
  if (CUSTOMERS.alpha?.id) {
    await dbQuery(\`UPDATE "CustomerLink" SET "inviteExpiresAt" = NOW() + INTERVAL '7 days', status = 'ACTIVE', "inviteToken" = NULL WHERE "customerId" = $1\`, [CUSTOMERS.alpha.id]);
  }`;
const newRestore = `  // No restore needed — temp customer used for expiry test; Alpha link untouched`;

if (content.includes(oldRestore)) {
  content = content.replace(oldRestore, newRestore);
  console.log("Removed restore block");
} else {
  console.log("Restore block NOT FOUND");
}

fs.writeFileSync("apps/api/scripts/qa-multi-seller.js", content);
console.log("Done");
