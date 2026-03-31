/**
 * Reports QA Verification Script
 * Seeds test data via live API, runs all report endpoints, and verifies correctness.
 *
 * Prerequisites: API must be running on http://localhost:3000
 * Run from repo root: node apps/api/scripts/reports-qa.js
 */

const BASE = "http://localhost:3000/api/v1";

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function api(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) {
    console.error(`  ❌ ${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    throw new Error(`${method} ${path} → ${res.status}`);
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(username, password) {
  await sleep(1000); // avoid rate limiting
  const data = await api("POST", "/auth/login", { username, password });
  return data.accessToken;
}

// ─── Test state ──────────────────────────────────────────────────────────────

let opToken;
const state = {
  customers: [],
  products: [],
  suppliers: [],
  orders: [],
  invoices: [],
  route: null,
  routeRun: null,
  driver: null,
  driverToken: null,
  expenseCategories: [],
  expenses: [],
};

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`    ✅ ${message}`);
    passed++;
  } else {
    console.log(`    ❌ FAIL: ${message}`);
    failed++;
  }
}

function approxEqual(a, b, tolerance = 0.02) {
  return Math.abs(Number(a) - Number(b)) <= tolerance;
}

// ─── Phase 1: Seed Test Data ────────────────────────────────────────────────

async function seedData() {
  console.log("\n📦 Phase 1 — Seeding QA test data...\n");

  opToken = await login("admin", "Admin@123");

  // 1. Create supplier
  console.log("  Creating supplier...");
  const supplier = await api("POST", "/inventory/suppliers", {
    name: "QA Test Supplier",
    contactName: "QA Contact",
    email: "qa@supplier.test",
    phone: "555-0000",
  }, opToken);
  state.suppliers.push(supplier);

  // 2. Create 3 products (use timestamp suffix to avoid barcode collisions)
  console.log("  Creating 3 products...");
  const ts = Date.now().toString().slice(-8);
  const prodDefs = [
    { name: `QA Product A ${ts}`, barcode: `99A${ts}01`, unit: "EA", pricePerUnit: "10.00" },
    { name: `QA Product B ${ts}`, barcode: `99B${ts}02`, unit: "EA", pricePerUnit: "25.00" },
    { name: `QA Product C ${ts}`, barcode: `99C${ts}03`, unit: "EA", pricePerUnit: "50.00" },
  ];
  for (const p of prodDefs) {
    const prod = await api("POST", "/products", p, opToken);
    // Add initial stock
    await api("POST", "/inventory/movements/adjustment", {
      productId: prod.id,
      quantity: 200,
      notes: "QA initial stock",
    }, opToken);
    state.products.push({ id: prod.id, name: p.name, barcode: p.barcode, price: parseFloat(p.pricePerUnit) });
  }

  // 3. Create 3 customers (operator creates them — use timestamp suffix for uniqueness)
  console.log("  Creating 3 customers...");
  const custDefs = [
    { username: `qa_cust_1_${ts}`, businessName: `QA Customer Alpha ${ts}`, contactName: "Alpha Contact", phone: "555-9901", email: `qa1_${ts}@test.com` },
    { username: `qa_cust_2_${ts}`, businessName: `QA Customer Beta ${ts}`,  contactName: "Beta Contact",  phone: "555-9902", email: `qa2_${ts}@test.com` },
    { username: `qa_cust_3_${ts}`, businessName: `QA Customer Gamma ${ts}`, contactName: "Gamma Contact", phone: "555-9903", email: `qa3_${ts}@test.com` },
  ];
  for (const c of custDefs) {
    const res = await api("POST", "/customers", {
      ...c,
      addresses: [{ label: "Main", line1: "123 QA Street", city: "Test City", state: "CA", zip: "99999" }],
    }, opToken);
    // Set known password
    const custTok = await login(c.username, res.tempPassword);
    await api("POST", "/auth/change-password", { currentPassword: res.tempPassword, newPassword: "QaCust1!" }, custTok);
    state.customers.push({ id: res.customer.id, username: c.username, businessName: c.businessName, token: null });
  }

  // Log in each customer
  for (const c of state.customers) {
    c.token = await login(c.username, "QaCust1!");
  }

  // 4. Create a driver
  console.log("  Creating QA driver...");
  const driverUsername = `qa_driver_${ts}`;
  const driverRes = await api("POST", "/drivers", {
    username: driverUsername,
    email: `qa_driver_${ts}@test.com`,
    contactName: "QA Driver One",
    phone: "555-8888",
    vehicleMake: "Ford",
    vehicleModel: "Transit",
    vehicleColour: "White",
    vehiclePlate: `QA-${ts}`,
  }, opToken);
  const driverTmpTok = await login(driverUsername, driverRes.tempPassword);
  await api("POST", "/auth/change-password", { currentPassword: driverRes.tempPassword, newPassword: "QaDriver1!" }, driverTmpTok);
  state.driver = driverRes.driver;
  state.driverToken = await login(driverUsername, "QaDriver1!");

  // 5. Create 5 orders as customers
  console.log("  Creating 5 orders...");
  const [prodA, prodB, prodC] = state.products;
  const [cust1, cust2, cust3] = state.customers;

  // Order 1: Cust1, A×10 + B×5 → will be DELIVERED, stays SENT
  const order1 = await api("POST", "/orders", {
    items: [
      { productId: prodA.id, qty: 10 },
      { productId: prodB.id, qty: 5 },
    ],
  }, cust1.token);
  state.orders.push({ id: order1.id, orderNumber: order1.orderNumber, customerId: cust1.id, expectedTotal: 10 * 10 + 5 * 25, desc: "Cust1 A×10+B×5" });

  // Order 2: Cust1, C×2 → will be DELIVERED, then PAID
  const order2 = await api("POST", "/orders", {
    items: [
      { productId: prodC.id, qty: 2 },
    ],
  }, cust1.token);
  state.orders.push({ id: order2.id, orderNumber: order2.orderNumber, customerId: cust1.id, expectedTotal: 2 * 50, desc: "Cust1 C×2" });

  // Order 3: Cust2, A×20 + C×3 → will be DELIVERED, then partial payment
  const order3 = await api("POST", "/orders", {
    items: [
      { productId: prodA.id, qty: 20 },
      { productId: prodC.id, qty: 3 },
    ],
  }, cust2.token);
  state.orders.push({ id: order3.id, orderNumber: order3.orderNumber, customerId: cust2.id, expectedTotal: 20 * 10 + 3 * 50, desc: "Cust2 A×20+C×3" });

  // Order 4: Cust2, B×10 → will be DELIVERED, then written off
  const order4 = await api("POST", "/orders", {
    items: [
      { productId: prodB.id, qty: 10 },
    ],
  }, cust2.token);
  state.orders.push({ id: order4.id, orderNumber: order4.orderNumber, customerId: cust2.id, expectedTotal: 10 * 25, desc: "Cust2 B×10" });

  // Order 5: Cust3, A×5 + B×2 → will be DELIVERED, stays SENT (overdue)
  const order5 = await api("POST", "/orders", {
    items: [
      { productId: prodA.id, qty: 5 },
      { productId: prodB.id, qty: 2 },
    ],
  }, cust3.token);
  state.orders.push({ id: order5.id, orderNumber: order5.orderNumber, customerId: cust3.id, expectedTotal: 5 * 10 + 2 * 25, desc: "Cust3 A×5+B×2" });

  // 6. Confirm all orders (operator)
  console.log("  Confirming all 5 orders...");
  for (const o of state.orders) {
    await api("PATCH", `/orders/${o.id}/status`, { status: "CONFIRMED" }, opToken);
  }

  // 7. Create route with stops for all 3 customers
  console.log("  Creating route and delivering via route run...");
  const route = await api("POST", "/routes", {
    name: "QA Test Route",
    driverId: state.driver.id,
  }, opToken);
  state.route = route;

  // Add stops
  for (let i = 0; i < state.customers.length; i++) {
    await api("POST", `/routes/${route.id}/stops`, {
      customerId: state.customers[i].id,
      stopNumber: i + 1,
    }, opToken);
  }

  // Mark orders OUT_FOR_DELIVERY
  for (const o of state.orders) {
    await api("PATCH", `/orders/${o.id}/status`, { status: "OUT_FOR_DELIVERY" }, opToken);
  }

  // Create route run (this auto-assigns orders to stops)
  const today = new Date().toISOString().split("T")[0];
  const run = await api("POST", "/route-runs", {
    routeId: route.id,
    scheduledDate: today,
    driverId: state.driver.id,
  }, opToken);
  state.routeRun = run;

  // Start the run
  await api("PATCH", `/route-runs/${run.id}/status`, { status: "IN_PROGRESS" }, state.driverToken);

  // Fetch run detail to get stops with order assignments
  const runDetail = await api("GET", `/route-runs/${run.id}`, null, state.driverToken);
  const runStops = runDetail.stops ?? [];

  // Complete each stop
  for (const stop of runStops) {
    // Mark stop in progress
    await api("PATCH", `/route-runs/${run.id}/stops/${stop.id}`, { status: "IN_PROGRESS" }, state.driverToken);

    // Find orders for this customer
    const custOrders = state.orders.filter(o => o.customerId === stop.customerId);
    const deliveries = [];
    for (const ord of custOrders) {
      const fullOrder = await api("GET", `/orders/${ord.id}`, null, state.driverToken);
      for (const item of (fullOrder.lineItems ?? [])) {
        deliveries.push({
          orderItemId: item.id,
          type: "DELIVERED",
          quantityDelivered: parseInt(item.qty, 10),
        });
      }
      // Store actual total from the created order
      ord.actualTotal = Number(fullOrder.total);
    }

    if (deliveries.length > 0) {
      await api("POST", `/route-runs/${run.id}/stops/${stop.id}/complete`, {
        deliveries,
        driverNote: "QA delivery test",
      }, state.driverToken);
      console.log(`    ✓ Completed stop for ${stop.customer?.businessName ?? stop.customerId} (${deliveries.length} items)`);
    } else {
      await api("PATCH", `/route-runs/${run.id}/stops/${stop.id}`, { status: "SKIPPED" }, state.driverToken);
      console.log(`    ⚠ Skipped stop (no orders found)`);
    }
  }

  // Complete the run
  await api("PATCH", `/route-runs/${run.id}/status`, { status: "COMPLETED" }, state.driverToken);
  console.log("    ✓ Route run completed");

  // Verify auto-created invoices
  console.log("\n  Verifying auto-created invoices...");
  for (const o of state.orders) {
    const order = await api("GET", `/orders/${o.id}`, null, opToken);
    o.actualTotal = Number(order.total);
    if (order.invoice) {
      state.invoices.push({
        id: order.invoice.id,
        invoiceNumber: order.invoice.invoiceNumber,
        status: order.invoice.status,
        total: Number(order.invoice.total),
        orderId: o.id,
        customerId: o.customerId,
        desc: o.desc,
      });
      console.log(`    ✓ ${order.invoice.invoiceNumber} → ${o.desc} ($${order.invoice.total})`);
    } else {
      console.log(`    ❌ No invoice for order ${o.orderNumber} (${o.desc})`);
    }
  }

  // 8. Record payments on specific invoices
  console.log("\n  Recording payments...");

  // Invoice for Order 2 (Cust1 C×2) → full payment → PAID
  const inv2 = state.invoices.find(i => i.orderId === state.orders[1].id);
  if (inv2) {
    await api("POST", `/invoices/${inv2.id}/payments`, {
      method: "CASH",
      amount: inv2.total,
      reference: "QA-PAY-001",
      notes: "Full payment",
    }, opToken);
    inv2.status = "PAID";
    console.log(`    ✓ Full payment $${inv2.total} on ${inv2.invoiceNumber} → PAID`);
  }

  // Invoice for Order 3 (Cust2 A×20+C×3) → partial payment
  const inv3 = state.invoices.find(i => i.orderId === state.orders[2].id);
  if (inv3) {
    const partialAmount = Math.round(inv3.total * 0.4); // ~40%
    await api("POST", `/invoices/${inv3.id}/payments`, {
      method: "CHECK",
      amount: partialAmount,
      reference: "QA-PAY-002",
      notes: "Partial payment",
    }, opToken);
    inv3.paidAmount = partialAmount;
    inv3.status = "PARTIAL";
    console.log(`    ✓ Partial payment $${partialAmount} on ${inv3.invoiceNumber} → PARTIAL`);
  }

  // Invoice for Order 4 (Cust2 B×10) → write off
  const inv4 = state.invoices.find(i => i.orderId === state.orders[3].id);
  if (inv4) {
    await api("POST", `/invoices/${inv4.id}/write-off`, {
      reason: "Customer bankruptcy — QA test",
    }, opToken);
    inv4.status = "WRITTEN_OFF";
    console.log(`    ✓ Write-off ${inv4.invoiceNumber} → WRITTEN_OFF`);
  }

  // 9. Create expense categories and expenses
  console.log("\n  Creating expenses...");
  const cat1 = await api("POST", "/bookkeeping/expense-categories", { name: `QA Supplies ${ts}`, code: `QS-${ts}` }, opToken);
  const cat2 = await api("POST", "/bookkeeping/expense-categories", { name: `QA Transport ${ts}`, code: `QT-${ts}` }, opToken);
  state.expenseCategories = [cat1, cat2];

  const expDefs = [
    { categoryId: cat1.id, amount: 150, description: "QA Office supplies", paymentMethod: "CASH" },
    { categoryId: cat1.id, amount: 200, description: "QA Cleaning supplies", paymentMethod: "CHECK" },
    { categoryId: cat2.id, amount: 75,  description: "QA Fuel", paymentMethod: "CASH" },
  ];
  for (const e of expDefs) {
    const exp = await api("POST", "/bookkeeping/expenses", {
      categoryId: e.categoryId,
      amount: e.amount,
      description: e.description,
      paymentMethod: e.paymentMethod,
      date: new Date().toISOString(),
    }, opToken);
    state.expenses.push({ id: exp.id, amount: e.amount, categoryId: e.categoryId, description: e.description });
    console.log(`    ✓ Expense: ${e.description} $${e.amount}`);
  }

  console.log("\n  ✅ Seed data complete!");
  console.log(`     Invoices: ${state.invoices.length}`);
  console.log(`     Expenses: ${state.expenses.length}`);
}

// ─── Phase 2: Test Reports ──────────────────────────────────────────────────

async function testReports() {
  console.log("\n\n🔍 Phase 2 — Testing Reports...\n");

  const thisYear = new Date().getFullYear();
  const dateFrom = `${thisYear}-01-01`;
  const dateTo = `${thisYear}-12-31`;

  const inv1 = state.invoices.find(i => i.orderId === state.orders[0].id); // Cust1 SENT
  const inv2 = state.invoices.find(i => i.orderId === state.orders[1].id); // Cust1 PAID
  const inv3 = state.invoices.find(i => i.orderId === state.orders[2].id); // Cust2 PARTIAL
  const inv4 = state.invoices.find(i => i.orderId === state.orders[3].id); // Cust2 WRITTEN_OFF
  const inv5 = state.invoices.find(i => i.orderId === state.orders[4].id); // Cust3 SENT
  const [cust1, cust2, cust3] = state.customers;

  // ─── Test 1: Sales by Customer ──
  console.log("  📊 1. Sales by Customer");
  const salesByCust = await api("GET", `/bookkeeping/reports/sales-by-customer?from=${dateFrom}&to=${dateTo}`, null, opToken);
  assert(salesByCust.data && Array.isArray(salesByCust.data), "Returns data array");
  const c1Sales = salesByCust.data.find(d => d.customerId === cust1.id);
  assert(c1Sales !== undefined, "Cust1 (Alpha) in sales — has PAID invoice");
  if (c1Sales && inv2) {
    assert(approxEqual(c1Sales.salesAmount, inv2.total), `Cust1 sales = $${inv2.total} (got $${c1Sales.salesAmount})`);
    assert(c1Sales.invoiceCount === 1, `Cust1 invoice count = 1 (got ${c1Sales.invoiceCount})`);
  }
  const c2Sales = salesByCust.data.find(d => d.customerId === cust2.id);
  assert(c2Sales === undefined, "Cust2 (Beta) NOT in sales — no PAID invoices");
  const c3Sales = salesByCust.data.find(d => d.customerId === cust3.id);
  assert(c3Sales === undefined, "Cust3 (Gamma) NOT in sales — no PAID invoices");

  // ─── Test 2: Sales by Item ──
  console.log("\n  📊 2. Sales by Item");
  const salesByItem = await api("GET", `/bookkeeping/reports/sales-by-item?from=${dateFrom}&to=${dateTo}`, null, opToken);
  assert(salesByItem.data && Array.isArray(salesByItem.data), "Returns data array");
  const prodCSales = salesByItem.data.find(d => d.productId === state.products[2].id);
  assert(prodCSales !== undefined, "Product C in sales (from Cust1 PAID invoice)");
  if (prodCSales) {
    // Sales by item uses invoiceItem.subtotal (qty × unitPrice), not invoice total (which may include tax)
    const expectedItemSubtotal = 2 * state.products[2].price; // C×2 at $50 = $100
    assert(approxEqual(prodCSales.amount, expectedItemSubtotal), `Product C item sales = $${expectedItemSubtotal} (got $${prodCSales.amount})`);
    assert(prodCSales.qty === 2, `Product C qty = 2 (got ${prodCSales.qty})`);
  }

  // ─── Test 3: AR Aging (Invoices) ──
  console.log("\n  📊 3. AR Aging (Invoices)");
  const arAging = await api("GET", "/bookkeeping/reports/ar-aging-invoices", null, opToken);
  assert(arAging.buckets !== undefined, "Returns buckets object");
  assert(arAging.totals !== undefined, "Returns totals object");
  const allAgingInvs = [
    ...arAging.buckets.current,
    ...arAging.buckets.days1_30,
    ...arAging.buckets.days31_60,
    ...arAging.buckets.days61_90,
    ...arAging.buckets.days90plus,
  ];
  if (inv4) {
    const woInAging = allAgingInvs.find(i => i.id === inv4.id);
    assert(woInAging === undefined, "Written-off invoice NOT in AR Aging");
  }
  if (inv2) {
    const paidInAging = allAgingInvs.find(i => i.id === inv2.id);
    assert(paidInAging === undefined, "PAID invoice NOT in AR Aging");
  }
  // SENT/PARTIAL invoices should be present (inv1, inv3, inv5)
  const qaAgingIds = [inv1?.id, inv3?.id, inv5?.id].filter(Boolean);
  const qaInAging = allAgingInvs.filter(i => qaAgingIds.includes(i.id));
  assert(qaInAging.length === qaAgingIds.length, `${qaAgingIds.length} QA invoices in aging (got ${qaInAging.length})`);
  assert(arAging.totals.total > 0, `Total receivables > 0 (got $${arAging.totals.total})`);

  // ─── Test 4: Invoice Details ──
  console.log("\n  📊 4. Invoice Details");
  const invDetails = await api("GET", `/bookkeeping/reports/invoice-details?from=${dateFrom}&to=${dateTo}`, null, opToken);
  assert(invDetails.data && Array.isArray(invDetails.data), "Returns data array");
  const qaInvIds = state.invoices.map(i => i.id);
  const qaInDetails = invDetails.data.filter(d => qaInvIds.includes(d.id));
  assert(qaInDetails.length === 5, `All 5 QA invoices present (got ${qaInDetails.length})`);

  const paidOnly = await api("GET", `/bookkeeping/reports/invoice-details?from=${dateFrom}&to=${dateTo}&status=PAID`, null, opToken);
  const qaPaidDetails = paidOnly.data.filter(d => qaInvIds.includes(d.id));
  assert(qaPaidDetails.length === 1, `Filter by PAID → 1 QA invoice (got ${qaPaidDetails.length})`);

  // ─── Test 5: Bad Debts ──
  console.log("\n  📊 5. Bad Debts");
  const badDebts = await api("GET", "/bookkeeping/reports/bad-debts", null, opToken);
  assert(badDebts.data && Array.isArray(badDebts.data), "Returns data array");
  if (inv4) {
    const qaWO = badDebts.data.find(d => d.id === inv4.id);
    assert(qaWO !== undefined, "Written-off invoice in Bad Debts");
    if (qaWO) {
      assert(approxEqual(qaWO.total, inv4.total), `Bad debt total = $${inv4.total} (got $${qaWO.total})`);
      assert(qaWO.writeOffReason === "Customer bankruptcy — QA test", "Write-off reason matches");
    }
  }

  // ─── Test 6: Customer Balance ──
  console.log("\n  📊 6. Customer Balance Summary");
  const custBalance = await api("GET", "/bookkeeping/reports/customer-balance", null, opToken);
  assert(custBalance.data && Array.isArray(custBalance.data), "Returns data array");

  // Cust1: 1 SENT (inv1) + PAID invoice not counted in balance
  const c1Bal = custBalance.data.find(d => d.customerId === cust1.id);
  if (inv1) {
    assert(c1Bal !== undefined, "Cust1 in balance summary (has SENT invoice)");
    if (c1Bal) {
      assert(approxEqual(c1Bal.balance, inv1.total), `Cust1 balance = $${inv1.total} (got $${c1Bal.balance})`);
    }
  }

  // Cust2: inv3 PARTIAL (total - paid) + inv4 WRITTEN_OFF (not in balance)
  const c2Bal = custBalance.data.find(d => d.customerId === cust2.id);
  if (inv3) {
    assert(c2Bal !== undefined, "Cust2 in balance summary (has PARTIAL invoice)");
    if (c2Bal) {
      const expectedBalance = inv3.total - (inv3.paidAmount || 0);
      assert(approxEqual(c2Bal.balance, expectedBalance), `Cust2 balance = $${expectedBalance} (got $${c2Bal.balance})`);
    }
  }

  // Cust3: 1 SENT (inv5)
  const c3Bal = custBalance.data.find(d => d.customerId === cust3.id);
  if (inv5) {
    assert(c3Bal !== undefined, "Cust3 in balance summary (has SENT invoice)");
    if (c3Bal) {
      assert(approxEqual(c3Bal.balance, inv5.total), `Cust3 balance = $${inv5.total} (got $${c3Bal.balance})`);
    }
  }

  // ─── Test 7: Payments Received ──
  console.log("\n  📊 7. Payments Received");
  const paymentsRcvd = await api("GET", `/bookkeeping/reports/payments-received?from=${dateFrom}&to=${dateTo}`, null, opToken);
  assert(paymentsRcvd.data && Array.isArray(paymentsRcvd.data), "Returns data array");
  const qaPayments = paymentsRcvd.data.filter(p =>
    p.reference === "QA-PAY-001" || p.reference === "QA-PAY-002"
  );
  assert(qaPayments.length === 2, `2 QA payments (got ${qaPayments.length})`);
  const cashPay = qaPayments.find(p => p.reference === "QA-PAY-001");
  if (cashPay && inv2) {
    assert(approxEqual(cashPay.amount, inv2.total), `Cash payment = $${inv2.total} (got $${cashPay.amount})`);
    assert(cashPay.method === "CASH", `Method = CASH (got ${cashPay.method})`);
  }
  const checkPay = qaPayments.find(p => p.reference === "QA-PAY-002");
  if (checkPay && inv3) {
    assert(approxEqual(checkPay.amount, inv3.paidAmount), `Check payment = $${inv3.paidAmount} (got $${checkPay.amount})`);
    assert(checkPay.method === "CHECK", `Method = CHECK (got ${checkPay.method})`);
  }

  // ─── Test 8: Time to Get Paid ──
  console.log("\n  📊 8. Time to Get Paid");
  const timeToPay = await api("GET", `/bookkeeping/reports/time-to-get-paid?from=${dateFrom}&to=${dateTo}`, null, opToken);
  assert(timeToPay.data && Array.isArray(timeToPay.data), "Returns data array");
  if (inv2) {
    const qaTPP = timeToPay.data.find(d => d.id === inv2.id);
    assert(qaTPP !== undefined, "PAID invoice in time-to-pay");
    if (qaTPP) {
      assert(qaTPP.daysToPayment === 0, `Days to payment = 0 (paid same day, got ${qaTPP.daysToPayment})`);
    }
  }

  // ─── Test 9: Expense Details ──
  console.log("\n  📊 9. Expense Details");
  const expDetails = await api("GET", `/bookkeeping/reports/expense-details?from=${dateFrom}&to=${dateTo}`, null, opToken);
  assert(expDetails.data && Array.isArray(expDetails.data), "Returns data array");
  const qaExpIds = state.expenses.map(e => e.id);
  const qaExps = expDetails.data.filter(d => qaExpIds.includes(d.id));
  assert(qaExps.length === 3, `3 QA expenses (got ${qaExps.length})`);

  // Filter by category
  const suppliesExp = await api("GET", `/bookkeeping/reports/expense-details?from=${dateFrom}&to=${dateTo}&categoryId=${state.expenseCategories[0].id}`, null, opToken);
  const qaSupExp = suppliesExp.data.filter(d => qaExpIds.includes(d.id));
  assert(qaSupExp.length === 2, `Filter by QA Supplies → 2 expenses (got ${qaSupExp.length})`);

  // ─── Test 10: Expenses by Category ──
  console.log("\n  📊 10. Expenses by Category");
  const expByCat = await api("GET", `/bookkeeping/reports/expenses-by-category?from=${dateFrom}&to=${dateTo}`, null, opToken);
  assert(expByCat.data && Array.isArray(expByCat.data), "Returns data array");
  const qaSupCat = expByCat.data.find(d => d.categoryId === state.expenseCategories[0].id);
  assert(qaSupCat !== undefined, "QA Supplies category present");
  if (qaSupCat) {
    assert(approxEqual(qaSupCat.total, 350), `QA Supplies total = $350 (got $${qaSupCat.total})`);
    assert(qaSupCat.count === 2, `QA Supplies count = 2 (got ${qaSupCat.count})`);
  }
  const qaTrnCat = expByCat.data.find(d => d.categoryId === state.expenseCategories[1].id);
  assert(qaTrnCat !== undefined, "QA Transport category present");
  if (qaTrnCat) {
    assert(approxEqual(qaTrnCat.total, 75), `QA Transport total = $75 (got $${qaTrnCat.total})`);
  }

  // ─── Test 11: P&L ──
  console.log("\n  📊 11. Profit & Loss");
  const pl = await api("GET", `/bookkeeping/reports/pl?from=${dateFrom}&to=${dateTo}`, null, opToken);
  assert(pl.revenue !== undefined, "Revenue field present");
  assert(pl.operatingExpenses !== undefined, "Operating expenses present");
  assert(pl.netProfit !== undefined, "Net profit present");
  if (inv2) {
    assert(pl.revenue >= inv2.total, `Revenue >= $${inv2.total} (got $${pl.revenue})`);
  }
  assert(pl.operatingExpenses >= 425, `OpEx >= $425 (got $${pl.operatingExpenses})`);

  // ─── Test 12: Cash Flow ──
  console.log("\n  📊 12. Cash Flow");
  const cashflow = await api("GET", `/bookkeeping/reports/cashflow?from=${dateFrom}&to=${dateTo}`, null, opToken);
  assert(cashflow.totalIn !== undefined, "Total cash in present");
  assert(cashflow.totalOut !== undefined, "Total cash out present");
  assert(cashflow.netCashFlow !== undefined, "Net cash flow present");
  if (inv2 && inv3) {
    const expectedCashIn = inv2.total + (inv3.paidAmount || 0);
    assert(cashflow.totalIn >= expectedCashIn, `Cash in >= $${expectedCashIn} (got $${cashflow.totalIn})`);
  }

  // ─── Test 13: Finance Dashboard ──
  console.log("\n  📊 13. Finance Dashboard");
  const dashboard = await api("GET", "/bookkeeping/finance-dashboard", null, opToken);
  assert(dashboard.arAging !== undefined, "AR aging data present");
  assert(dashboard.monthlySales !== undefined, "Monthly sales data present");
  assert(dashboard.summaryTable !== undefined, "Summary table present");
  assert(dashboard.arAging.total >= 0, `AR aging total >= 0 (got $${dashboard.arAging.total})`);
  const currentMonth = dashboard.monthlySales.data[new Date().getMonth()];
  assert(currentMonth !== undefined, "Current month data present");

  // ─── Test 14: Bookkeeping Summary ──
  console.log("\n  📊 14. Bookkeeping Summary");
  const summary = await api("GET", "/bookkeeping/summary", null, opToken);
  assert(summary.totalRevenue !== undefined, "Total revenue present");
  assert(summary.outstandingReceivables !== undefined, "Outstanding receivables present");
  assert(summary.overdueCount !== undefined, "Overdue count present");

  // ─── Test 15: Edge Cases ──
  console.log("\n  📊 15. Edge Cases");

  // Future date range → empty results
  const futureSales = await api("GET", "/bookkeeping/reports/sales-by-customer?from=2099-01-01&to=2099-12-31", null, opToken);
  assert(Array.isArray(futureSales.data) && futureSales.data.length === 0, "Future date → empty sales");

  const futureExp = await api("GET", "/bookkeeping/reports/expense-details?from=2099-01-01&to=2099-12-31", null, opToken);
  assert(futureExp.data.length === 0, "Future date → empty expenses");

  const futurePL = await api("GET", "/bookkeeping/reports/pl?from=2099-01-01&to=2099-12-31", null, opToken);
  assert(futurePL.revenue === 0, `Future P&L revenue = 0 (got ${futurePL.revenue})`);

  const futureCF = await api("GET", "/bookkeeping/reports/cashflow?from=2099-01-01&to=2099-12-31", null, opToken);
  assert(futureCF.totalIn === 0, `Future cash flow in = 0 (got ${futureCF.totalIn})`);

  // ─── Test 16: Deprecated AR Aging delegates ──
  console.log("\n  📊 16. AR Aging (deprecated) delegates correctly");
  const arOld = await api("GET", "/bookkeeping/reports/aging", null, opToken);
  assert(arOld.buckets !== undefined, "Deprecated aging returns buckets (delegates to invoice version)");
}

// ─── Phase 3: Cleanup ───────────────────────────────────────────────────────

async function cleanup() {
  console.log("\n\n🧹 Phase 3 — Cleaning up QA test data...\n");

  // Delete expenses
  for (const e of state.expenses) {
    try { await api("POST", `/bookkeeping/expenses/${e.id}/delete`, {}, opToken); } catch {}
  }
  console.log(`  ✓ Soft-deleted ${state.expenses.length} expenses`);

  // Delete customers (cascade deletes orders, invoices, etc.)
  for (const c of state.customers) {
    try { await api("DELETE", `/customers/${c.id}`, null, opToken); } catch (e) {
      console.log(`  ⚠ Could not delete customer ${c.businessName}: ${e.message}`);
    }
  }
  console.log(`  ✓ Deleted ${state.customers.length} customers (cascading orders/invoices)`);

  // Delete route
  if (state.route) {
    try { await api("DELETE", `/routes/${state.route.id}`, null, opToken); } catch (e) {
      console.log(`  ⚠ Could not delete route: ${e.message}`);
    }
    console.log("  ✓ Deleted QA route");
  }

  // Delete products
  for (const p of state.products) {
    try { await api("DELETE", `/products/${p.id}`, null, opToken); } catch (e) {
      console.log(`  ⚠ Could not delete product ${p.name}: ${e.message}`);
    }
  }
  console.log(`  ✓ Deleted ${state.products.length} products`);

  // Delete supplier
  for (const s of state.suppliers) {
    try { await api("DELETE", `/suppliers/${s.id}`, null, opToken); } catch (e) {
      console.log(`  ⚠ Could not delete supplier: ${e.message}`);
    }
  }
  console.log("  ✓ Deleted QA supplier");

  console.log("  ✅ Cleanup complete!\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║        RouteFlow Reports QA Verification Script          ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");

  try {
    await seedData();
    await testReports();
  } catch (err) {
    console.error("\n❌ Script error:", err.message);
  }

  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log(`║  Results: ${String(passed).padStart(2)} passed, ${String(failed).padStart(2)} failed${" ".repeat(32)}║`);
  console.log("╚═══════════════════════════════════════════════════════════╝");

  try {
    await cleanup();
  } catch (err) {
    console.error("  ⚠ Cleanup error:", err.message);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
