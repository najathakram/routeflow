#!/usr/bin/env node
/**
 * RouteFlow post-deploy check — authenticated API smoke with financial math validation.
 *
 * Extends smoke.mjs: logs in as operator, hits protected endpoints, and verifies
 * that no money fields in the response carry floating-point artifacts (>2 dp).
 * Use after every Railway deploy to catch regressions early.
 *
 * Env vars:
 *   SMOKE_BASE_URL           — API base URL (default: http://localhost:3000)
 *   SMOKE_TENANT_SLUG        — tenant slug for operator login (default: e2e-routeflow)
 *   SMOKE_OPERATOR_USERNAME  — operator username (default: admin)
 *   SMOKE_OPERATOR_PASSWORD  — operator password (default: Admin@123)
 *   SMOKE_TIMEOUT_MS         — per-request timeout in ms (default: 20000)
 *   SMOKE_WAIT_RETRIES       — how many times to retry the health check (default: 30)
 */

import { assertTestTenant } from "./lib/test-tenants.cjs";

const BASE = (process.env.SMOKE_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
// Only approved test tenants may be smoke-tested — never a live client tenant.
const TENANT = assertTestTenant(
  process.env.SMOKE_TENANT_SLUG || "e2e-routeflow",
  "post-deploy-check",
);
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 20_000);
const WAIT_RETRIES = Number(process.env.SMOKE_WAIT_RETRIES || 0); // 0 = no wait loop
const OP_USER = process.env.SMOKE_OPERATOR_USERNAME || "admin";
const OP_PASS = process.env.SMOKE_OPERATOR_PASSWORD || "Admin@123";

// Money field names whose values must have ≤2 decimal places.
// Matches keys like subtotal, total, tax, taxAmount, unitPrice, balance, amount.
const MONEY_KEY_RE = /subtotal|total|tax|amount|price|balance/i;

async function withTimeout(fn, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

async function get(path, token) {
  const headers = { accept: "application/json", "x-tenant-slug": TENANT };
  if (token) headers["authorization"] = `Bearer ${token}`;
  return withTimeout((signal) => fetch(`${BASE}${path}`, { signal, headers }));
}

async function post(path, body) {
  return withTimeout((signal) =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-tenant-slug": TENANT },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * Walk a JSON value and collect every money-keyed number that has >2 decimal places.
 * Only inspects the first 5 items of arrays to keep runtime fast.
 */
function floatArtifacts(value, path = "") {
  if (typeof value === "number") {
    if (MONEY_KEY_RE.test(path)) {
      const dp = (String(value).split(".")[1] ?? "").length;
      if (dp > 2) return [`${path} = ${value}`];
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.slice(0, 5).flatMap((v, i) => floatArtifacts(v, `${path}[${i}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => floatArtifacts(v, path ? `${path}.${k}` : k));
  }
  return [];
}

function pass(msg) {
  console.log(`  ✅ ${msg}`);
}
function fail(msg) {
  console.error(`  ❌ ${msg}`);
}

async function waitForHealth() {
  if (WAIT_RETRIES === 0) return;
  console.log(`\n⏳ Waiting up to ${WAIT_RETRIES * 10}s for API to be healthy…`);
  for (let i = 1; i <= WAIT_RETRIES; i++) {
    try {
      const res = await withTimeout((s) =>
        fetch(`${BASE}/api/v1/health`, { signal: s, headers: { accept: "application/json" } }),
      );
      if (res.ok) {
        pass(`Health check — ${res.status}`);
        return;
      }
    } catch {
      /* keep retrying */
    }
    process.stdout.write(`  retry ${i}/${WAIT_RETRIES}…\r`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error("API did not become healthy within the wait window");
}

async function run() {
  console.log(`\n🔎 RouteFlow post-deploy check — ${BASE} (tenant: ${TENANT})\n`);
  let failures = 0;

  // ── 0. Wait for health (when SMOKE_WAIT_RETRIES > 0, e.g. in CI) ────────────
  try {
    await waitForHealth();
  } catch (err) {
    fail(`Health wait: ${err.message}`);
    process.exit(1);
  }

  // ── 1. Public health ─────────────────────────────────────────────────────────
  try {
    const res = await get("/api/v1/health");
    if (res.ok) pass(`Health — ${res.status}`);
    else {
      fail(`Health — ${res.status}`);
      failures++;
    }
  } catch (err) {
    fail(`Health — ${err?.message ?? err}`);
    failures++;
  }

  // ── 2. Login ─────────────────────────────────────────────────────────────────
  let token = null;
  try {
    const res = await post("/api/v1/auth/login", { username: OP_USER, password: OP_PASS });
    const body = await res.json();
    if (res.ok && body.accessToken) {
      token = body.accessToken;
      pass(`Login as ${OP_USER} — 200, token received`);
    } else {
      fail(`Login — ${res.status} ${body?.message ?? JSON.stringify(body)}`);
      failures++;
    }
  } catch (err) {
    fail(`Login — ${err?.message ?? err}`);
    failures++;
  }

  if (!token) {
    console.error("\n💥 Cannot continue without auth token — aborting\n");
    process.exit(1);
  }

  // ── 3. Protected endpoints + float-artifact scan ─────────────────────────────
  const endpoints = [
    { name: "Orders list", path: "/api/v1/orders?limit=10" },
    { name: "Invoices list", path: "/api/v1/invoices?limit=10" },
    { name: "Customers list", path: "/api/v1/customers?limit=10" },
    { name: "Products list", path: "/api/v1/products?limit=10" },
    { name: "Drivers list", path: "/api/v1/drivers?limit=10" },
  ];

  for (const ep of endpoints) {
    try {
      const res = await get(ep.path, token);
      const text = await res.text();

      if (!res.ok) {
        fail(`${ep.name} — ${res.status}`);
        failures++;
        continue;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        fail(`${ep.name} — response is not valid JSON`);
        failures++;
        continue;
      }

      // Detect float artifacts in money fields
      const artifacts = floatArtifacts(data);
      if (artifacts.length > 0) {
        fail(`${ep.name} — float artifacts in money fields:\n      ${artifacts.join("\n      ")}`);
        failures++;
      } else {
        pass(`${ep.name} — ${res.status}, money fields OK`);
      }
    } catch (err) {
      fail(`${ep.name} — ${err?.name === "AbortError" ? "timeout" : (err?.message ?? err)}`);
      failures++;
    }
  }

  // ── 4. Invoice math spot-check ────────────────────────────────────────────────
  // Fetch the first invoice and verify total = subtotal + tax (within $0.01).
  try {
    const res = await get("/api/v1/invoices?limit=1", token);
    if (res.ok) {
      const body = await res.json();
      const invoices = Array.isArray(body) ? body : (body.items ?? body.data ?? []);
      if (invoices.length > 0) {
        const inv = invoices[0];
        // Fetch the full detail (with items)
        const detailRes = await get(`/api/v1/invoices/${inv.id}`, token);
        if (detailRes.ok) {
          const detail = await detailRes.json();
          // Prisma serializes Decimal money fields as STRINGS — coerce before any
          // arithmetic, else `subtotal + taxAmount` string-concatenates ("25"+"0"
          // → "250") and the spot-check reports a false divergence.
          const subtotal = Number(detail.subtotal ?? 0);
          const taxAmount = Number(detail.taxAmount ?? 0);
          const total = Number(detail.total ?? 0);
          const expected = Math.round((subtotal + taxAmount) * 100) / 100;
          const diff = Math.abs(expected - total);
          if (diff <= 0.01) {
            pass(`Invoice math — subtotal(${subtotal}) + tax(${taxAmount}) ≈ total(${total})`);
          } else {
            fail(
              `Invoice math — subtotal(${subtotal}) + tax(${taxAmount}) = ${expected} ≠ total(${total})`,
            );
            failures++;
          }
        }
      } else {
        pass("Invoice math — no invoices to check (empty)");
      }
    }
  } catch (err) {
    fail(`Invoice math — ${err?.message ?? err}`);
    failures++;
  }

  // ── 5. Order↔Invoice divergence guard ────────────────────────────────────────
  // A fully-invoiced order's total must equal the sum of its non-void invoice
  // totals. This is the standing guard for the box-proration divergence class
  // (an invoice line that billed the per-box price as the whole line total).
  try {
    const res = await get("/api/v1/orders?limit=25", token);
    if (res.ok) {
      const body = await res.json();
      const orders = Array.isArray(body) ? body : (body.items ?? body.data ?? []);
      const delivered = orders
        .filter((o) => o.status === "DELIVERED" || o.status === "CANCELLED")
        .slice(0, 15);
      let checked = 0;
      const diverged = [];
      for (const o of delivered) {
        const detailRes = await get(`/api/v1/orders/${o.id}`, token);
        if (!detailRes.ok) continue;
        const detail = await detailRes.json();
        const lineItems = detail.lineItems ?? [];
        const invoices = (detail.invoices ?? []).filter((i) => i.status !== "VOID");
        if (invoices.length === 0) continue;
        // Only compare when nothing is left to bill (a partial split bills less).
        const noRemaining = !lineItems.some(
          (li) => li.status !== "CANCELLED" && Number(li.qty) - Number(li.invoicedQty ?? 0) > 0.001,
        );
        if (!noRemaining) continue;
        checked++;
        const invoicedTotal =
          Math.round(invoices.reduce((s, i) => s + Number(i.total), 0) * 100) / 100;
        const orderTotal = Number(detail.total);
        if (Math.abs(orderTotal - invoicedTotal) > 0.01) {
          diverged.push(
            `${detail.orderNumber ?? detail.id}: order ${orderTotal} ≠ invoiced ${invoicedTotal}`,
          );
        }
      }
      if (diverged.length > 0) {
        fail(
          `Order↔Invoice divergence — ${diverged.length} fully-invoiced order(s) mismatch:\n      ${diverged.join("\n      ")}`,
        );
        failures++;
      } else {
        pass(`Order↔Invoice divergence — ${checked} fully-invoiced order(s) reconcile`);
      }
    }
  } catch (err) {
    fail(`Order↔Invoice divergence — ${err?.message ?? err}`);
    failures++;
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log("");
  if (failures > 0) {
    console.error(`💥 Post-deploy check FAILED — ${failures} check(s) failed against ${BASE}\n`);
    process.exit(1);
  }
  console.log(`✨ Post-deploy check passed — all checks OK (${BASE})\n`);
}

run().catch((err) => {
  console.error("💥 Post-deploy check crashed:", err);
  process.exit(1);
});
