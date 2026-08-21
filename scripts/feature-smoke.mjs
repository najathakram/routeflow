#!/usr/bin/env node
/**
 * RouteFlow feature smoke — authenticated WRITE-path smoke for the 2026-08-20 batch.
 *
 * Extends post-deploy-check.mjs (which is read-only) with the write paths that ship
 * has never exercised against a real API: boxed-line proration + the no-wipe item
 * PATCH, the durable stock-count session lifecycle, generic→variant stock assignment,
 * supplier payment allocation + on-account credit, bulk mark-paid, the estimate
 * double-convert guard, the productId order filter + product-sales invariant, the
 * uploads fail-closed contract, and the supplier-statement route registration.
 *
 * SAFETY (non-negotiable, in this order):
 *   1. `assertTestTenant()` at startup — refuses to run against anything but an
 *      approved test tenant (see scripts/lib/test-tenants.cjs).
 *   2. Every row this script creates is named with the `E2E-SMOKE-` prefix; it
 *      NEVER mutates a row it did not create this run. The supplier/customer
 *      fixtures are find-or-create (reused across runs); every product, order,
 *      estimate, invoice, and vendor bill is created fresh and cleaned up.
 *   3. Cleanup runs in `finally` for every section, so a failed assertion still
 *      unwinds what that section created.
 *   4. S4's on-account SupplierCredit is deliberately DRAINED to zero (see the S4
 *      comment below) so a rerun's math can never be poisoned by a leftover credit.
 *
 * Env vars (mirrors post-deploy-check.mjs):
 *   SMOKE_BASE_URL           — API base URL (default: http://localhost:3000)
 *   SMOKE_TENANT_SLUG        — tenant slug for operator login (default: e2e-routeflow)
 *   SMOKE_OPERATOR_USERNAME  — operator username (default: admin)
 *   SMOKE_OPERATOR_PASSWORD  — operator password (default: Admin@123)
 *   SMOKE_TIMEOUT_MS         — per-request timeout in ms (default: 20000)
 */

import { assertTestTenant } from "./lib/test-tenants.cjs";

const BASE = (process.env.SMOKE_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
// Only approved test tenants may be smoke-tested — never a live client tenant.
const TENANT = assertTestTenant(process.env.SMOKE_TENANT_SLUG || "e2e-routeflow", "feature-smoke");
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 20_000);
const OP_USER = process.env.SMOKE_OPERATOR_USERNAME || "admin";
const OP_PASS = process.env.SMOKE_OPERATOR_PASSWORD || "Admin@123";

const PREFIX = "E2E-SMOKE-";

let TOKEN = null;
let failures = 0;

function pass(msg) {
  console.log(`  ✅ ${msg}`);
}
function fail(msg) {
  console.error(`  ❌ ${msg}`);
}
function section(name) {
  console.log(`\n── ${name} ──`);
}

/** Records a pass/fail without throwing — a section keeps going (and still runs
 *  its own cleanup) after one assertion fails. */
function assert(cond, msg) {
  if (cond) {
    pass(msg);
  } else {
    fail(msg);
    failures++;
  }
}

// Mirrors apps/api/src/common/pricing.ts roundMoney — half-away-from-zero at the
// cent. Kept as a tiny local copy so this script has zero project imports beyond
// the test-tenant guard (same posture as post-deploy-check.mjs / smoke.mjs).
function roundMoney(n) {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100;
}

function assertMoney(actual, expected, msg) {
  const a = Number(actual);
  const e = Number(expected);
  const ok = Number.isFinite(a) && Math.abs(a - e) <= 0.01;
  assert(ok, `${msg} — expected ≈ ${e}, got ${actual}`);
}

async function withTimeout(fn, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

async function req(method, path, body) {
  const headers = { accept: "application/json", "x-tenant-slug": TENANT };
  if (TOKEN) headers["authorization"] = `Bearer ${TOKEN}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await withTimeout((signal) =>
    fetch(`${BASE}${path}`, {
      method,
      signal,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, ok: res.ok, body: json, raw: text };
}

const get = (path) => req("GET", path);
const post = (path, body) => req("POST", path, body ?? {});
const patch = (path, body) => req("PATCH", path, body ?? {});
const put = (path, body) => req("PUT", path, body ?? {});
const del = (path, body) => req("DELETE", path, body);

async function login() {
  const res = await post("/api/v1/auth/login", { username: OP_USER, password: OP_PASS });
  if (!res.ok || !res.body?.accessToken) {
    throw new Error(`Login failed — ${res.status} ${JSON.stringify(res.body ?? res.raw)}`);
  }
  TOKEN = res.body.accessToken;
  pass(`Login as ${OP_USER} — 200, token received`);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

async function findOrCreateSupplier() {
  const list = await get("/api/v1/inventory/suppliers");
  if (!list.ok) throw new Error(`List suppliers failed — ${list.status}`);
  const existing = (list.body ?? []).find((s) => s.name === `${PREFIX}SUPPLIER`);
  if (existing) return existing;
  const created = await post("/api/v1/inventory/suppliers", { name: `${PREFIX}SUPPLIER` });
  if (!created.ok) throw new Error(`Create supplier failed — ${created.status}`);
  return created.body;
}

async function findOrCreateCustomer() {
  const list = await get(
    `/api/v1/customers?search=${encodeURIComponent(PREFIX + "CUSTOMER")}&limit=50`,
  );
  if (!list.ok) throw new Error(`List customers failed — ${list.status}`);
  const existing = (list.body?.data ?? []).find((c) => c.businessName === `${PREFIX}CUSTOMER`);
  if (existing) return existing;
  const created = await post("/api/v1/customers", {
    username: "e2e-smoke-customer",
    businessName: `${PREFIX}CUSTOMER`,
    contactName: "E2E Smoke",
  });
  if (!created.ok) throw new Error(`Create customer failed — ${created.status}`);
  // POST /customers responds { customer, user, tempPassword } — the list path
  // returns bare customer rows, so unwrap to keep both paths the same shape.
  return created.body?.customer ?? created.body;
}

/** Fresh, timestamp-suffixed product — never found-or-created, never reused
 *  across runs, so a stale name/variant collision can never break a rerun. */
async function createProduct({ name, pricePerUnit, unit, unitsPerBox }) {
  const created = await post("/api/v1/products", {
    name,
    pricePerUnit,
    unit,
    ...(unitsPerBox ? { unitsPerBox } : {}),
  });
  if (!created.ok) {
    throw new Error(
      `Create product "${name}" failed — ${created.status} ${JSON.stringify(created.body)}`,
    );
  }
  return created.body;
}

/** Guards against a response-shape change silently handing a section an
 *  `undefined` id — fail loudly at startup instead of five sections later. */
function requireId(row, label) {
  if (!row?.id) {
    throw new Error(`${label} fixture has no id — got ${JSON.stringify(row)}`);
  }
  return row;
}

async function deactivateProduct(id, label) {
  if (!id) return;
  const res = await patch(`/api/v1/products/${id}`, { isActive: false });
  assert(res.ok, `Cleanup — deactivate ${label ?? id}`);
}

// ─── S1 — boxed proration (the pieces question) ────────────────────────────────

async function s1(ctx) {
  section("S1 — boxed proration + no-wipe incremental PATCH");
  let orderId = null;
  try {
    const created = await post("/api/v1/orders", {
      customerId: ctx.customer.id,
      status: "DRAFT",
      mergeChoice: "separate",
      items: [
        { productId: ctx.boxed.id, qty: 2, boxes: 0, pieces: 2 },
        { productId: ctx.boxed.id, qty: 8, boxes: 1, pieces: 2 },
      ],
    });
    assert(created.ok, `Create DRAFT order with 2 boxed lines — ${created.status}`);
    if (!created.ok) return;
    orderId = created.body.id;

    const lines = created.body.lineItems ?? [];
    const piecesOnly = lines.find((l) => l.boxes === 0 && l.pieces === 2);
    const mixed = lines.find((l) => l.boxes === 1 && l.pieces === 2);
    assert(!!piecesOnly, "Pieces-only line {boxes:0, pieces:2} present");
    assert(!!mixed, "Mixed line {boxes:1, pieces:2} present");
    if (piecesOnly) {
      assertMoney(
        piecesOnly.subtotal,
        roundMoney(20 * (0 + 2 / 6)),
        "Pieces-only subtotal = round(20×2/6)",
      );
    }
    if (mixed) {
      assertMoney(
        mixed.subtotal,
        roundMoney(20 * (1 + 2 / 6)),
        "Mixed subtotal = round(20×(1+2/6))",
      );
    }
    const lineSum = roundMoney(Number(piecesOnly?.subtotal ?? 0) + Number(mixed?.subtotal ?? 0));
    assertMoney(created.body.subtotal, lineSum, "Order subtotal = sum of line subtotals");

    // Incremental diff PATCH: replaceAll:false, one id-less added line. The
    // wipe-class regression is exactly this: an operator/mobile edit UI that
    // sends only the NEW line must never delete the two lines above.
    const patched = await patch(`/api/v1/orders/${orderId}/items`, {
      items: [{ productId: ctx.boxed.id, boxes: 0, pieces: 1 }],
      replaceAll: false,
    });
    assert(
      patched.ok,
      `Incremental item PATCH (replaceAll:false, 1 id-less line) — ${patched.status}`,
    );

    const after = await get(`/api/v1/orders/${orderId}`);
    assert(after.ok, `Re-fetch order after PATCH — ${after.status}`);
    const afterLines = after.body?.lineItems ?? [];
    const survivedPiecesOnly = afterLines.some((l) => l.id === piecesOnly?.id);
    const survivedMixed = afterLines.some((l) => l.id === mixed?.id);
    assert(
      survivedPiecesOnly && survivedMixed,
      "Both pre-existing lines survive the incremental PATCH",
    );
    assert(
      afterLines.length >= lines.length + 1,
      "The new id-less line was appended, not merged away",
    );
  } finally {
    if (orderId) {
      const res = await del(`/api/v1/orders/${orderId}`);
      assert(res.ok, `Cleanup — delete DRAFT order ${orderId}`);
    }
  }
}

// ─── S2 — stock-count session lifecycle ────────────────────────────────────────

async function s2(ctx) {
  section("S2 — stock-count session lifecycle (idempotent double-commit)");
  const preRunStock = Number(ctx.boxed.currentStock ?? 0);
  let sessionId = null;
  try {
    const started = await post("/api/v1/inventory/stock-counts", {
      name: `E2E-SMOKE count ${Date.now()}`,
    });
    assert(started.ok, `Start stock-count session — ${started.status}`);
    if (!started.ok) return;
    sessionId = started.body.id;

    const first = await put(`/api/v1/inventory/stock-counts/${sessionId}/lines`, {
      productId: ctx.boxed.id,
      boxes: 1,
      pieces: 3,
      mode: "ADD",
    });
    assert(
      first.ok && Number(first.body?.countedQty) === 9,
      `Line via boxes/pieces (1×6+3) — countedQty=9, got ${first.body?.countedQty}`,
    );

    const second = await put(`/api/v1/inventory/stock-counts/${sessionId}/lines`, {
      productId: ctx.boxed.id,
      countedQty: 1,
      increment: true,
    });
    assert(
      second.ok && Number(second.body?.countedQty) === 10,
      `Increment (+1) — countedQty=10, got ${second.body?.countedQty}`,
    );

    const committed = await post(`/api/v1/inventory/stock-counts/${sessionId}/commit`, {});
    assert(committed.ok, `Commit session — ${committed.status}`);
    assert(Number(committed.body?.applied ?? 0) >= 1, `Commit applied ≥ 1 movement`);
    assert(
      typeof committed.body?.reference === "string" &&
        committed.body.reference.startsWith("STOCK_COUNT-"),
      `Commit reference starts with STOCK_COUNT- — got ${committed.body?.reference}`,
    );

    const recommit = await post(`/api/v1/inventory/stock-counts/${sessionId}/commit`, {});
    assert(
      recommit.ok && recommit.body?.alreadyCommitted === true,
      `Idempotent double-commit reports alreadyCommitted:true`,
    );

    const list = await get("/api/v1/inventory/stock-counts?status=COMMITTED&limit=100");
    assert(list.ok, `List COMMITTED sessions — ${list.status}`);
    const row = (list.body?.data ?? []).find((s) => s.id === sessionId);
    assert(
      !!row && typeof row.netVarianceMoney === "number",
      `Committed session's list row carries a numeric netVarianceMoney`,
    );
  } finally {
    // Compensating cleanup: a second session counts the product back to its
    // pre-run stock and commits, so both sessions remain as history but the
    // tenant's actual stock is net-unchanged.
    try {
      const comp = await post("/api/v1/inventory/stock-counts", {
        name: `E2E-SMOKE compensate ${Date.now()}`,
      });
      if (comp.ok) {
        await put(`/api/v1/inventory/stock-counts/${comp.body.id}/lines`, {
          productId: ctx.boxed.id,
          countedQty: preRunStock,
          mode: "REPLACE",
        });
        const compCommit = await post(`/api/v1/inventory/stock-counts/${comp.body.id}/commit`, {});
        assert(
          compCommit.ok,
          `Cleanup — compensating session recounts stock back to ${preRunStock}`,
        );
      } else {
        assert(false, `Cleanup — could not start compensating session (${comp.status})`);
      }
    } catch (err) {
      assert(false, `Cleanup — compensating session error: ${err?.message ?? err}`);
    }
  }
}

// ─── S3 — variant assign ───────────────────────────────────────────────────────

async function s3(ctx) {
  section("S3 — variant assign (INSUFFICIENT_UNASSIGNED guard + real assign)");
  let variantId = null;
  // Tracked so the `finally` below undoes exactly what happened, even if the
  // section returns early after the bump but before (or instead of) a
  // successful assign — never a fixed "-6" that assumes the happy path.
  let parentBumped = false;
  let parentAssignedAway = 0;
  try {
    const bump = await post("/api/v1/inventory/movements/adjustment", {
      productId: ctx.parent.id,
      quantity: 10,
      notes: "E2E-SMOKE parent stock bump",
    });
    assert(bump.ok, `Raise parent stock +10 — ${bump.status}`);
    parentBumped = bump.ok;
    if (!bump.ok) return;

    const overAssign = await post("/api/v1/inventory/variant-assign", {
      parentProductId: ctx.parent.id,
      assignments: [{ newVariant: { name: "E2E-SMOKE-OVERFLOW" }, qty: 9999 }],
    });
    assert(
      overAssign.status === 400,
      `Over-assign (9999) rejected — 400, got ${overAssign.status}`,
    );
    assert(
      overAssign.body?.code === "INSUFFICIENT_UNASSIGNED",
      `Rejection code is INSUFFICIENT_UNASSIGNED — got ${overAssign.body?.code}`,
    );
    const afterOverAssign = await get(`/api/v1/products/${ctx.parent.id}`);
    assertMoney(
      afterOverAssign.body?.currentStock,
      10,
      "Parent stock unchanged after the rejected over-assign",
    );

    const assign = await post("/api/v1/inventory/variant-assign", {
      parentProductId: ctx.parent.id,
      assignments: [{ newVariant: { name: "E2E-SMOKE-VAR" }, qty: 4 }],
    });
    assert(assign.ok, `Assign 4 to a new variant — ${assign.status}`);
    if (!assign.ok) return;
    assert(
      typeof assign.body?.reference === "string" &&
        assign.body.reference.startsWith("VARIANT_ASSIGN-"),
      `Assign reference starts with VARIANT_ASSIGN- — got ${assign.body?.reference}`,
    );
    assertMoney(assign.body?.parentRemaining, 6, "Parent remaining = 10 − 4 = 6");
    const created = (assign.body?.assignments ?? [])[0];
    assert(!!created?.created && Number(created?.qty) === 4, "New variant created with stock 4");
    variantId = created?.productId ?? null;
    parentAssignedAway = 4;

    if (variantId) {
      const parentMoves = await get(
        `/api/v1/inventory/movements?productId=${ctx.parent.id}&limit=50`,
      );
      const variantMoves = await get(`/api/v1/inventory/movements?productId=${variantId}&limit=50`);
      const parentRow = (parentMoves.body?.data ?? []).find(
        (m) => m.reference === assign.body.reference,
      );
      const variantRow = (variantMoves.body?.data ?? []).find(
        (m) => m.reference === assign.body.reference,
      );
      assert(
        !!parentRow && Number(parentRow.quantity) === -4,
        `One negative parent movement (-4) under the assign reference`,
      );
      assert(
        !!variantRow && Number(variantRow.quantity) === 4,
        `One positive variant movement (+4) under the assign reference`,
      );
    }
  } finally {
    // Return both products to zero net stock, then deactivate the created rows.
    if (variantId) {
      const variantAdj = await post("/api/v1/inventory/movements/adjustment", {
        productId: variantId,
        quantity: -4,
        notes: "E2E-SMOKE cleanup",
      });
      assert(variantAdj.ok, `Cleanup — adjustment -4 on the variant`);
    }
    // Undo exactly the +10 bump minus whatever a real assign actually moved
    // away (0 if the assign never happened or failed) — never a fixed "-6"
    // that would assume the happy path and leak stock on a failure.
    const parentAdjustQty = -(10 - parentAssignedAway);
    if (parentBumped && parentAdjustQty !== 0) {
      const parentAdj = await post("/api/v1/inventory/movements/adjustment", {
        productId: ctx.parent.id,
        quantity: parentAdjustQty,
        notes: "E2E-SMOKE cleanup",
      });
      assert(parentAdj.ok, `Cleanup — adjustment ${parentAdjustQty} on the parent`);
    }
    await deactivateProduct(variantId, "created variant");
    await deactivateProduct(ctx.parent.id, "parent product");
  }
}

// ─── S4 — supplier payment allocation + on-account credit ─────────────────────

async function s4(ctx) {
  section("S4 — supplier payment allocation, overpayment credit, credit drain");
  let bill1 = null;
  let bill2 = null;
  let bill3 = null;
  try {
    const b1 = await post("/api/v1/vendor-bills", {
      supplierId: ctx.supplier.id,
      items: [{ description: "E2E-SMOKE bill A", qty: 1, unitCost: 50 }],
    });
    assert(b1.ok, `Create bill A (50) — ${b1.status}`);
    bill1 = b1.body;

    const b2 = await post("/api/v1/vendor-bills", {
      supplierId: ctx.supplier.id,
      items: [{ description: "E2E-SMOKE bill B", qty: 1, unitCost: 30 }],
    });
    assert(b2.ok, `Create bill B (30) — ${b2.status}`);
    bill2 = b2.body;
    if (!bill1?.id || !bill2?.id) return;

    const paid = await post("/api/v1/vendor-bills/payments/record", {
      supplierId: ctx.supplier.id,
      totalAmount: 90,
      method: "CASH",
      allocations: [
        { vendorBillId: bill1.id, amount: 50 },
        { vendorBillId: bill2.id, amount: 30 },
      ],
    });
    assert(paid.ok, `Record 90 across the two bills — ${paid.status}`);
    const groupIds = new Set((paid.body?.payments ?? []).map((p) => p.paymentGroupId));
    assert(groupIds.size === 1, `Every created BillPayment shares ONE paymentGroupId`);
    assertMoney(paid.body?.excess, 10, "Overpayment surplus = 90 − 80 = 10");

    const afterPay1 = await get(`/api/v1/vendor-bills/${bill1.id}`);
    const afterPay2 = await get(`/api/v1/vendor-bills/${bill2.id}`);
    assert(afterPay1.body?.status === "PAID", `Bill A is PAID — got ${afterPay1.body?.status}`);
    assert(afterPay2.body?.status === "PAID", `Bill B is PAID — got ${afterPay2.body?.status}`);

    const statementAfter90 = await get(
      `/api/v1/vendor-bills/suppliers/${ctx.supplier.id}/statement`,
    );
    assertMoney(
      statementAfter90.body?.creditBalance,
      10,
      "SupplierCredit balance = 10 after the overpayment",
    );

    // This third bill IS the credit drain: without it the $10 leftover credit
    // would sit on the supplier and auto-apply to the NEXT run's first bill,
    // corrupting that run's allocation math.
    const b3 = await post("/api/v1/vendor-bills", {
      supplierId: ctx.supplier.id,
      items: [{ description: "E2E-SMOKE bill C (credit drain)", qty: 1, unitCost: 10 }],
    });
    assert(b3.ok, `Create bill C (10) — ${b3.status}`);
    bill3 = b3.body;
    assert(
      bill3?.status === "PAID" || Number(bill3?.totalPaid) === 10,
      `Bill C auto-paid from account credit — status=${bill3?.status} totalPaid=${bill3?.totalPaid}`,
    );

    const statementAfterDrain = await get(
      `/api/v1/vendor-bills/suppliers/${ctx.supplier.id}/statement`,
    );
    assertMoney(
      statementAfterDrain.body?.creditBalance,
      0,
      "SupplierCredit balance = 0 after the drain bill",
    );
  } finally {
    // Bills A/B drew no credit, so voiding them is a clean no-op refund; once
    // VOID they're eligible for the normal bulk-delete endpoint.
    for (const bill of [bill1, bill2]) {
      if (!bill?.id) continue;
      const voided = await post(`/api/v1/vendor-bills/${bill.id}/void`, {});
      assert(voided.ok, `Cleanup — void bill ${bill.id}`);
    }
    const toDelete = [bill1, bill2].filter((b) => b?.id).map((b) => b.id);
    if (toDelete.length > 0) {
      const bulk = await del("/api/v1/vendor-bills", { ids: toDelete });
      assert(
        bulk.ok && Number(bulk.body?.deleted ?? 0) === toDelete.length,
        `Cleanup — bulk-delete bills A/B (${toDelete.length})`,
      );
    }
    // Bill C is deliberately LEFT ALONE — DRAFT, totalPaid=10, history on the
    // test tenant. Voiding OR deleting it calls refundDrawnSupplierCredits,
    // which would hand the $10 draw back to the SupplierCredit row (balance
    // 10 again) and undo the drain above. Leaving it is what keeps the
    // supplier's credit permanently at 0 across reruns.
    if (bill3?.id) {
      pass(
        `Cleanup — bill C (${bill3.id}) intentionally kept as DRAFT history to hold the credit drain at 0`,
      );
    }
  }
}

// ─── S5 — bulk mark-paid ────────────────────────────────────────────────────────

async function s5(ctx) {
  section("S5 — bulk mark-paid (pays through the ledger, skips on rerun)");
  let bill4 = null;
  let bill5 = null;
  let bill6 = null; // created then immediately voided — the cheap VOID-edge probe
  try {
    const b4 = await post("/api/v1/vendor-bills", {
      supplierId: ctx.supplier.id,
      items: [{ description: "E2E-SMOKE bill D", qty: 1, unitCost: 20 }],
    });
    assert(b4.ok, `Create bill D (20) — ${b4.status}`);
    bill4 = b4.body;

    const b5 = await post("/api/v1/vendor-bills", {
      supplierId: ctx.supplier.id,
      items: [{ description: "E2E-SMOKE bill E", qty: 1, unitCost: 15 }],
    });
    assert(b5.ok, `Create bill E (15) — ${b5.status}`);
    bill5 = b5.body;

    const b6 = await post("/api/v1/vendor-bills", {
      supplierId: ctx.supplier.id,
      items: [{ description: "E2E-SMOKE bill F (void edge)", qty: 1, unitCost: 5 }],
    });
    assert(b6.ok, `Create bill F (5, to be voided) — ${b6.status}`);
    bill6 = b6.body;
    if (bill6?.id) {
      const voided = await post(`/api/v1/vendor-bills/${bill6.id}/void`, {});
      assert(voided.ok, `Void bill F before the bulk call — ${voided.status}`);
    }

    if (!bill4?.id || !bill5?.id || !bill6?.id) return;
    const ids = [bill4.id, bill5.id, bill6.id];

    const first = await post("/api/v1/bookkeeping/bills/bulk-mark-paid", { ids, method: "CASH" });
    assert(first.ok, `Bulk mark-paid [D, E, VOID F] — ${first.status}`);
    assert(first.body?.paid === 2, `paid = 2 (D, E) — got ${first.body?.paid}`);
    assertMoney(first.body?.totalAmount, 35, "totalAmount = 20 + 15 = 35");
    const firstSkipped = first.body?.skipped ?? [];
    assert(
      firstSkipped.length === 1 &&
        firstSkipped[0]?.id === bill6.id &&
        typeof firstSkipped[0]?.reason === "string",
      `Void bill F is skipped with a reason — got ${JSON.stringify(firstSkipped)}`,
    );

    const second = await post("/api/v1/bookkeeping/bills/bulk-mark-paid", {
      ids: [bill4.id, bill5.id],
      method: "CASH",
    });
    assert(second.ok, `Bulk mark-paid rerun on the same ids — ${second.status}`);
    assert(second.body?.paid === 0, `Rerun paid = 0 — got ${second.body?.paid}`);
    const secondSkipped = second.body?.skipped ?? [];
    assert(
      secondSkipped.length === 2 &&
        secondSkipped.every((s) => typeof s.reason === "string" && s.reason.length > 0),
      `Rerun skips both bills, each with a nothing-owed reason — got ${JSON.stringify(secondSkipped)}`,
    );
  } finally {
    for (const bill of [bill4, bill5]) {
      if (!bill?.id) continue;
      const voided = await post(`/api/v1/vendor-bills/${bill.id}/void`, {});
      assert(voided.ok, `Cleanup — void bill ${bill.id}`);
    }
    const toDelete = [bill4, bill5, bill6].filter((b) => b?.id).map((b) => b.id);
    if (toDelete.length > 0) {
      const bulk = await del("/api/v1/vendor-bills", { ids: toDelete });
      assert(
        bulk.ok && Number(bulk.body?.deleted ?? 0) === toDelete.length,
        `Cleanup — bulk-delete bills D/E/F (${toDelete.length})`,
      );
    }
  }
}

// ─── S6 — estimate double-convert guard ────────────────────────────────────────

async function s6(ctx) {
  section("S6 — estimate double-convert / re-accept guards");
  let estimateId = null;
  let invoiceId = null;
  try {
    const created = await post("/api/v1/estimates", {
      customerId: ctx.customer.id,
      items: [{ productId: ctx.boxed.id, qty: 1 }],
    });
    assert(created.ok, `Create estimate — ${created.status}`);
    estimateId = created.body?.id;
    if (!estimateId) return;

    const accepted = await post(`/api/v1/estimates/${estimateId}/accept`, {});
    assert(
      accepted.ok && accepted.body?.status === "ACCEPTED",
      `Accept estimate — ${accepted.status}, status=${accepted.body?.status}`,
    );

    const converted = await post(`/api/v1/estimates/${estimateId}/convert-to-invoice`, {});
    assert(converted.ok, `First convert-to-invoice — ${converted.status}`);
    invoiceId = converted.body?.id ?? null;

    const convertAgain = await post(`/api/v1/estimates/${estimateId}/convert-to-invoice`, {});
    assert(
      convertAgain.status === 400,
      `Second convert is rejected — expected 400, got ${convertAgain.status}`,
    );

    const reaccept = await post(`/api/v1/estimates/${estimateId}/accept`, {});
    assert(
      reaccept.status === 400,
      `Re-accepting the now-CONVERTED estimate is rejected — expected 400, got ${reaccept.status}`,
    );
  } finally {
    if (invoiceId) {
      const voided = await post(`/api/v1/invoices/${invoiceId}/void`, {});
      assert(voided.ok, `Cleanup — void the created invoice ${invoiceId}`);
    }
    if (estimateId) {
      pass(
        `Cleanup — estimate ${estimateId} left CONVERTED (history row on the test tenant is acceptable)`,
      );
    }
  }
}

// ─── S7 — find-by-product + sales summary invariant ────────────────────────────

async function s7(ctx) {
  section("S7 — orders?productId filter + product-sales revenue-weighted invariant");
  let orderId = null;
  try {
    const created = await post("/api/v1/orders", {
      customerId: ctx.customer.id,
      status: "DRAFT",
      mergeChoice: "separate",
      items: [{ productId: ctx.boxed.id, qty: 1 }],
    });
    assert(created.ok, `Create a dedicated DRAFT for the productId filter — ${created.status}`);
    orderId = created.body?.id ?? null;

    const filtered = await get(`/api/v1/orders?productId=${ctx.boxed.id}&limit=50`);
    assert(filtered.ok, `GET /orders?productId= — ${filtered.status}`);
    const rows = filtered.body?.data ?? [];
    assert(
      rows.some((o) => o.id === orderId),
      "Filtered list includes the order just created for this product",
    );
    assert(
      rows.every((o) => (o.lineItems ?? []).some((li) => li.productId === ctx.boxed.id)),
      "Every returned order contains a line for the filtered product",
    );
  } finally {
    if (orderId) {
      const res = await del(`/api/v1/orders/${orderId}`);
      assert(res.ok, `Cleanup — delete dedicated draft order ${orderId}`);
    }
  }

  // Revenue-weighted invariant. Best-effort against whatever real invoiced
  // sales already exist on the tenant; falls back to the fresh (sales-less)
  // boxed fixture, which must report the empty-shape contract instead.
  let productIdForSales = ctx.boxed.id;
  const top = await get("/api/v1/analytics/products/top?limit=1");
  if (top.ok && Array.isArray(top.body) && top.body[0]?.id) {
    productIdForSales = top.body[0].id;
  }
  const sales = await get(`/api/v1/analytics/product-sales/${productIdForSales}`);
  assert(sales.ok, `GET /analytics/product-sales/:id — ${sales.status}`);
  const summary = sales.body?.summary;
  if (summary && Number(summary.totalQty) > 0) {
    const expectedAvg = roundMoney(Number(summary.totalRevenue) / Number(summary.totalQty));
    assertMoney(
      summary.avgPrice,
      expectedAvg,
      "avgPrice ≈ totalRevenue / totalQty (revenue-weighted)",
    );
  } else {
    assert(
      !!summary &&
        summary.avgPrice === null &&
        summary.minPrice === null &&
        summary.maxPrice === null,
      "Empty-shape product-sales: avgPrice/minPrice/maxPrice are null when totalQty is 0",
    );
  }
}

// ─── S8 — uploads stay fail-closed ─────────────────────────────────────────────

async function s8() {
  section("S8 — uploads stay fail-closed (read-only probes)");
  const zero = "00000000-0000-0000-0000-000000000000";
  const probes = [
    { name: "products/<missing owner row>", path: `/api/v1/uploads/products/${zero}/x.png` },
    { name: "invoice-pdfs/<missing owner row>", path: `/api/v1/uploads/invoice-pdfs/${zero}.pdf` },
    {
      name: "tenants/<other tenant>/logo.png",
      path: `/api/v1/uploads/tenants/some-other-tenant/logo.png`,
    },
  ];
  for (const probe of probes) {
    const res = await get(probe.path);
    assert(res.status === 403, `${probe.name} — expected 403, got ${res.status}`);
  }
}

// ─── S9 — supplier-statement route registration ────────────────────────────────

async function s9() {
  section("S9 — supplier-statement routes registered (no model call)");
  const list = await get("/api/v1/supplier-statements?limit=5");
  assert(list.ok, `GET /supplier-statements — ${list.status}`);
  assert(
    Array.isArray(list.body?.data) || Array.isArray(list.body),
    "List response has a list shape",
  );

  const scan = await post("/api/v1/supplier-statements/scan", {});
  assert(
    scan.status !== 404 && scan.status >= 400 && scan.status < 500,
    `POST /supplier-statements/scan with no files — expected 4xx (not 404), got ${scan.status}`,
  );
}

// ─── Runner ─────────────────────────────────────────────────────────────────────

async function runSection(fn, ctx) {
  try {
    await fn(ctx);
  } catch (err) {
    fail(`Section crashed — ${err?.message ?? err}`);
    failures++;
  }
}

async function run() {
  console.log(`\n🔎 RouteFlow feature smoke — ${BASE} (tenant: ${TENANT})\n`);

  try {
    await login();
  } catch (err) {
    fail(`Login — ${err?.message ?? err}`);
    console.error(`\n💥 Cannot continue without auth token — aborting\n`);
    process.exit(1);
  }

  section("Startup — fixtures");
  let ctx = null;
  try {
    const supplier = requireId(await findOrCreateSupplier(), "Supplier");
    pass(`Supplier fixture ready — ${supplier.id}`);
    const customer = requireId(await findOrCreateCustomer(), "Customer");
    pass(`Customer fixture ready — ${customer.id}`);
    const ts = Date.now();
    const boxed = requireId(
      await createProduct({
        name: `${PREFIX}BOXED ${ts}`,
        pricePerUnit: "20",
        unit: "box",
        unitsPerBox: 6,
      }),
      "Boxed product",
    );
    pass(`Boxed product fixture created — ${boxed.id}`);
    const parent = requireId(
      await createProduct({
        name: `${PREFIX}PARENT ${ts}`,
        pricePerUnit: "10",
        unit: "each",
      }),
      "Parent product",
    );
    pass(`Parent product fixture created — ${parent.id}`);
    ctx = { supplier, customer, boxed, parent };
  } catch (err) {
    fail(`Fixture setup — ${err?.message ?? err}`);
    failures++;
  }

  if (ctx) {
    try {
      await runSection(s1, ctx);
      await runSection(s2, ctx);
      await runSection(s3, ctx);
      await runSection(s4, ctx);
      await runSection(s5, ctx);
      await runSection(s6, ctx);
      await runSection(s7, ctx);
      await runSection(s8, ctx);
      await runSection(s9, ctx);
    } finally {
      // Final fixture cleanup. Deactivating twice (S3 already deactivates the
      // parent) is a harmless no-op — this just guarantees the boxed fixture
      // (owned by no single section) and the parent both end up inactive even
      // if an earlier section crashed before reaching its own cleanup.
      section("Cleanup — fixture products");
      await deactivateProduct(ctx.boxed.id, "boxed product fixture");
      await deactivateProduct(ctx.parent.id, "parent product fixture");
    }
  }

  console.log("");
  if (failures > 0) {
    console.error(
      `💥 Feature smoke FAILED — ${failures} check(s) failed against ${BASE} (tenant: ${TENANT})\n`,
    );
    process.exit(1);
  }
  console.log(`✨ Feature smoke passed — all checks OK (${BASE}, tenant: ${TENANT})\n`);
}

run().catch((err) => {
  console.error("💥 Feature smoke crashed:", err);
  process.exit(1);
});
