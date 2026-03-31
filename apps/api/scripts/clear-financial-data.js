#!/usr/bin/env node
/**
 * Clear Financial Data Script
 * Deletes all invoices, credit notes, payments received, and vendor bills/purchases
 * from the RouteFlow API.
 *
 * Usage:
 *   node apps/api/scripts/clear-financial-data.js
 *   node apps/api/scripts/clear-financial-data.js https://your-railway-api-url.railway.app/api/v1
 *
 * Credentials can be set via env vars:
 *   ROUTEFLOW_URL=https://your-api.railway.app/api/v1
 *   ROUTEFLOW_USERNAME=admin
 *   ROUTEFLOW_PASSWORD=Admin@123
 */

const BASE_URL = process.argv[2] || process.env.ROUTEFLOW_URL || "http://localhost:3000/api/v1";
const USERNAME = process.env.ROUTEFLOW_USERNAME || "admin";
const PASSWORD = process.env.ROUTEFLOW_PASSWORD || "Admin@123";

async function main() {
  console.log(`\n🗑️  RouteFlow – Clear Financial Data`);
  console.log(`   API: ${BASE_URL}`);
  console.log(`   User: ${USERNAME}\n`);

  // 1. Login
  console.log("🔐 Logging in...");
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });

  if (!loginRes.ok) {
    const err = await loginRes.text();
    console.error(`❌ Login failed (${loginRes.status}): ${err}`);
    process.exit(1);
  }

  const { accessToken } = await loginRes.json();
  console.log("✅ Logged in successfully\n");

  // 2. Confirm
  console.log("⚠️  WARNING: This will permanently delete:");
  console.log("   • All invoices and invoice payments");
  console.log("   • All credit notes");
  console.log("   • All vendor bills and bill payments");
  console.log("   • All purchase orders");
  console.log("   • All payment records\n");

  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  await new Promise((resolve) => {
    rl.question("Type YES to confirm: ", (answer) => {
      rl.close();
      if (answer !== "YES") {
        console.log("\n❌ Aborted.");
        process.exit(0);
      }
      resolve();
    });
  });

  // 3. Call endpoint
  console.log("\n🗑️  Clearing financial data...");
  const clearRes = await fetch(`${BASE_URL}/settings/financial-data`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!clearRes.ok) {
    const err = await clearRes.text();
    console.error(`❌ Failed (${clearRes.status}): ${err}`);
    process.exit(1);
  }

  const result = await clearRes.json();
  console.log(`✅ ${result.message}`);
  console.log("\n✨ Done! The database is now clean of all financial records.\n");
}

main().catch((err) => {
  console.error("❌ Unexpected error:", err.message);
  process.exit(1);
});
