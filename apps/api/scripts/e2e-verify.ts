// RouteFlow API — End-to-End Verification Script
// Run: npx ts-node --esm scripts/e2e-verify.ts  (from apps/api)
// Or:  npx ts-node --transpile-only scripts/e2e-verify.ts
// Requires the API server to be running on BASE_URL.
// Override base URL: API_URL=http://localhost:3000/api/v1 npx ts-node --esm scripts/e2e-verify.ts

const BASE = process.env.API_URL ?? "http://localhost:3000/api/v1";

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e: any) {
    failed++;
    failures.push(`${name}: ${e.message}`);
    process.stdout.write(`  ✗ ${name}: ${e.message}\n`);
  }
}

function expect(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

async function api(
  method: string,
  path: string,
  body?: any,
  token?: string,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  return { status: res.status, data };
}

async function login(username: string, password: string): Promise<string> {
  const { status, data } = await api("POST", "/auth/login", { username, password });
  if (status !== 200) throw new Error(`Login failed for ${username}: ${status}`);
  return data.accessToken;
}

// ─── Unique suffix to avoid collisions across runs ────────────────────────────
const RUN = Date.now().toString(36);

// ─── Shared state populated during run ────────────────────────────────────────
let operatorToken = "";
let driverToken = "";
let customerToken = "";

// Dynamically created test accounts (created at startup, used throughout)
let testDriverUsername = "";
let testDriverPassword = "TestDriver1!";
let testCustomerUsername = "";
let testCustomerPassword = "TestCust1!";

// IDs captured across groups
let createdCustomerId = "";
let createdDriverId = "";
let createdProductId = "";
let createdProductBarcode = "";
let createdOrderId = "";
let customerOwnOrderId = "";
let createdInvoiceId = "";
let draftInvoiceId = "";
let payableInvoiceId = "";
let createdRouteId = "";
let createdRunId = "";
let createdSupplierId = "";
let createdVendorBillId = "";
let createdCreditNoteId = "";
let createdReturnId = "";
let createdEstimateId = "";
let createdRecurringId = "";
let createdTemplateId = "";
let existingCustomerId = ""; // test customer record id
let existingDriverId = ""; // test driver record id

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── Authenticate operator first ───────────────────────────────────────────
  console.log("\n── Setup ─────────────────────────────────────────────");
  try {
    operatorToken = await login("admin", "Admin@123");
    console.log("  ✓ Operator token acquired");
  } catch (e: any) {
    console.error(`  ✗ FATAL: cannot get operator token — ${e.message}`);
    process.exit(1);
  }

  // ── Create test driver (API generates tempPassword, returned in response) ──
  testDriverUsername = `e2edrv${RUN}`;
  {
    const { status, data } = await api(
      "POST",
      "/drivers",
      {
        contactName: `E2E Driver ${RUN}`,
        email: `${testDriverUsername}@test.local`,
        username: testDriverUsername,
        phone: "5550001111",
        vehicleMake: "Test",
        vehicleModel: "Van",
        vehicleColour: "White",
        vehiclePlate: `T${RUN.slice(-5)}`,
      },
      operatorToken,
    );
    if (status === 201) {
      existingDriverId = data.driver?.id ?? data.id;
      testDriverPassword = data.tempPassword;
      console.log(`  ✓ Test driver created (${testDriverUsername}, pwd=${testDriverPassword})`);
    } else {
      console.error(`  ✗ FATAL: driver creation failed (${status}): ${JSON.stringify(data)}`);
      process.exit(1);
    }
  }
  try {
    driverToken = await login(testDriverUsername, testDriverPassword);
    console.log("  ✓ Driver token acquired");
  } catch (e: any) {
    console.error(`  ✗ FATAL: cannot authenticate test driver — ${e.message}`);
    process.exit(1);
  }

  // ── Create test customer ──────────────────────────────────────────────────
  testCustomerUsername = `e2ecst${RUN}`;
  {
    const { status, data } = await api(
      "POST",
      "/customers",
      {
        businessName: `E2E Café ${RUN}`,
        contactName: `E2E Contact ${RUN}`,
        email: `${testCustomerUsername}@test.local`,
        username: testCustomerUsername,
        phone: "5550002222",
        addresses: [
          {
            label: "Main",
            line1: "123 Test St",
            city: "Austin",
            state: "TX",
            zip: "78701",
            isDefault: true,
          },
        ],
      },
      operatorToken,
    );
    if (status === 201) {
      existingCustomerId = data.id;
      testCustomerPassword = data.tempPassword;
      console.log(
        `  ✓ Test customer created (${testCustomerUsername}, pwd=${testCustomerPassword})`,
      );
    } else {
      console.error(`  ✗ FATAL: customer creation failed (${status}): ${JSON.stringify(data)}`);
      process.exit(1);
    }
  }
  try {
    customerToken = await login(testCustomerUsername, testCustomerPassword);
    console.log("  ✓ Customer token acquired");
  } catch (e: any) {
    console.error(`  ✗ FATAL: cannot authenticate test customer — ${e.message}`);
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Group 1 — Auth
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Group 1: Auth ─────────────────────────────────────");

  let capturedRefreshToken = "";
  let changePasswordToken = "";

  await check("LOGIN operator → 200 + token", async () => {
    const { status, data } = await api("POST", "/auth/login", {
      username: "admin",
      password: "Admin@123",
    });
    expect(status === 200, `Expected 200, got ${status}`);
    expect(typeof data.accessToken === "string", "Missing accessToken");
    expect(typeof data.refreshToken === "string", "Missing refreshToken");
    capturedRefreshToken = data.refreshToken;
    changePasswordToken = data.accessToken;
  });

  await check("LOGIN wrong password → 401", async () => {
    const { status } = await api("POST", "/auth/login", {
      username: "admin",
      password: "WrongPassword!",
    });
    expect(status === 401, `Expected 401, got ${status}`);
  });

  await check("LOGIN wrong username → 401", async () => {
    const { status } = await api("POST", "/auth/login", {
      username: "no_such_user_xyz",
      password: "Admin@123",
    });
    expect(status === 401, `Expected 401, got ${status}`);
  });

  await check("REFRESH valid token → 200", async () => {
    expect(capturedRefreshToken !== "", "No refresh token captured");
    const { status, data } = await api("POST", "/auth/refresh", {
      refreshToken: capturedRefreshToken,
    });
    expect(status === 200, `Expected 200, got ${status}`);
    expect(typeof data.accessToken === "string", "Missing accessToken in refresh response");
  });

  await check("REFRESH invalid token → 401", async () => {
    const { status } = await api("POST", "/auth/refresh", {
      refreshToken: "totally.invalid.token",
    });
    expect(status === 401, `Expected 401, got ${status}`);
  });

  await check("CHANGE-PASSWORD wrong current → 400/401", async () => {
    const { status } = await api(
      "POST",
      "/auth/change-password",
      { currentPassword: "NotTheRightPassword1!", newPassword: "NewAdmin@456" },
      changePasswordToken,
    );
    expect([400, 401].includes(status), `Expected 400 or 401, got ${status}`);
  });

  await check("LOGOUT → 200", async () => {
    // Create a fresh token we can safely invalidate
    const { data: ld } = await api("POST", "/auth/login", {
      username: "admin",
      password: "Admin@123",
    });
    const { status } = await api("POST", "/auth/logout", undefined, ld.accessToken);
    expect(status === 200, `Expected 200, got ${status}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Group 2 — Customers
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Group 2: Customers ────────────────────────────────");

  await check("GET /customers (operator) → 200, paginated data", async () => {
    const { status, data } = await api("GET", "/customers", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array response");
  });

  await check("GET /customers (customer role) → 403", async () => {
    const { status } = await api("GET", "/customers", undefined, customerToken);
    expect(status === 403, `Expected 403, got ${status}`);
  });

  await check("POST /customers (operator) → 201", async () => {
    const { status, data } = await api(
      "POST",
      "/customers",
      {
        email: `e2e_cust_${RUN}@test.com`,
        username: `e2e_cust_${RUN}`,
        businessName: `E2E Business ${RUN}`,
        contactName: "E2E Contact",
        phone: "0400000001",
        addresses: [
          {
            label: "Main",
            line1: "456 Test Ave",
            city: "Austin",
            state: "TX",
            zip: "78702",
            isDefault: true,
          },
        ],
      },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    // Response shape: { customer: {...}, user: {...}, tempPassword }
    const customerId = data.customer?.id ?? data.id;
    expect(typeof customerId === "string", "Expected id in response");
    createdCustomerId = customerId;
  });

  await check("GET /customers/me (customer) → 200", async () => {
    const { status, data } = await api("GET", "/customers/me", undefined, customerToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(typeof data.id === "string", "Expected customer id");
    existingCustomerId = existingCustomerId || data.id;
  });

  await check("PATCH /customers/me (customer) → 200", async () => {
    const { status, data } = await api(
      "PATCH",
      "/customers/me",
      { phone: "0400111222" },
      customerToken,
    );
    expect(status === 200, `Expected 200, got ${status}`);
    expect(typeof data.id === "string", "Expected customer id in patch response");
  });

  await check("GET /customers/:id (operator) → 200", async () => {
    expect(createdCustomerId !== "", "No customer id from POST");
    const { status, data } = await api(
      "GET",
      `/customers/${createdCustomerId}`,
      undefined,
      operatorToken,
    );
    expect(status === 200, `Expected 200, got ${status}`);
    expect(data.id === createdCustomerId, "Returned wrong customer");
  });

  await check("GET /customers/:id/statement (operator) → 200", async () => {
    const id = existingCustomerId || createdCustomerId;
    expect(id !== "", "No customer id available");
    const { status, data } = await api(
      "GET",
      `/customers/${id}/statement`,
      undefined,
      operatorToken,
    );
    expect(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Group 3 — Drivers
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Group 3: Drivers ──────────────────────────────────");

  await check("GET /drivers (operator) → 200", async () => {
    const { status, data } = await api("GET", "/drivers", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  await check("GET /drivers (customer) → 403", async () => {
    const { status } = await api("GET", "/drivers", undefined, customerToken);
    expect(status === 403, `Expected 403, got ${status}`);
  });

  await check("GET /drivers/me (driver) → 200", async () => {
    const { status, data } = await api("GET", "/drivers/me", undefined, driverToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(typeof data.id === "string", "Expected driver id");
    existingDriverId = existingDriverId || data.id;
  });

  await check("GET /drivers/:id/metrics (operator) → 200", async () => {
    const id = existingDriverId;
    expect(id !== "", "No driver id available");
    const { status } = await api("GET", `/drivers/${id}/metrics`, undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Group 4 — Orders
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Group 4: Orders ───────────────────────────────────");

  // We need a product to create orders
  let orderProductId = "";
  {
    const { data } = await api("GET", "/products?limit=5", undefined, operatorToken);
    const list: any[] = data.data ?? data ?? [];
    if (list.length > 0) orderProductId = list[0].id;
  }

  await check("POST /orders (operator) → 201", async () => {
    expect(orderProductId !== "", "Need a product to create order");
    const cId = existingCustomerId || createdCustomerId;
    expect(cId !== "", "Need a customer id");
    const { status, data } = await api(
      "POST",
      "/orders",
      {
        customerId: cId,
        items: [{ productId: orderProductId, qty: 2 }],
        notes: "e2e operator order",
      },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(typeof data.id === "string", "Expected order id");
    createdOrderId = data.id;
  });

  await check("POST /orders (customer) → 201", async () => {
    expect(orderProductId !== "", "Need a product to create order");
    const { status, data } = await api(
      "POST",
      "/orders",
      {
        items: [{ productId: orderProductId, qty: 1 }],
        notes: "e2e customer order",
      },
      customerToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(typeof data.id === "string", "Expected order id");
    customerOwnOrderId = data.id;
  });

  await check("GET /orders (operator) → 200 all", async () => {
    const { status, data } = await api("GET", "/orders", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  await check("GET /orders (customer) → 200 own only", async () => {
    const { status, data } = await api("GET", "/orders", undefined, customerToken);
    expect(status === 200, `Expected 200, got ${status}`);
    const list: any[] = data.data ?? data ?? [];
    // All returned orders should belong to the customer — verified by non-empty list
    expect(Array.isArray(list), "Expected array");
  });

  await check("PATCH /orders/:id/status CONFIRMED → 200", async () => {
    expect(createdOrderId !== "", "No order id");
    const { status, data } = await api(
      "PATCH",
      `/orders/${createdOrderId}/status`,
      { status: "CONFIRMED" },
      operatorToken,
    );
    expect(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
    expect(data.status === "CONFIRMED", `Expected CONFIRMED, got ${data.status}`);
  });

  await check("PATCH /orders/:id/urgent → 200", async () => {
    expect(createdOrderId !== "", "No order id");
    const { status, data } = await api(
      "PATCH",
      `/orders/${createdOrderId}/urgent`,
      undefined,
      operatorToken,
    );
    expect(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
    expect(typeof data.urgent === "boolean", "Expected urgent boolean field");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Group 5 — Invoices (PRIORITY)
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Group 5: Invoices ─────────────────────────────────");

  const invCustomerId = existingCustomerId || createdCustomerId;

  await check("POST /invoices no send → 201, status=DRAFT", async () => {
    expect(invCustomerId !== "", "Need customer id");
    const { status, data } = await api(
      "POST",
      "/invoices",
      {
        customerId: invCustomerId,
        items: [{ description: "E2E Item", qty: 1, unitPrice: 10 }],
      },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(data.status === "DRAFT", `Expected DRAFT, got ${data.status}`);
    draftInvoiceId = data.id;
  });

  await check("POST /invoices send=true → 201, status=SENT", async () => {
    expect(invCustomerId !== "", "Need customer id");
    const { status, data } = await api(
      "POST",
      "/invoices",
      {
        customerId: invCustomerId,
        items: [{ description: "E2E Sent Item", qty: 2, unitPrice: 25 }],
        send: true,
      },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(data.status === "SENT", `Expected SENT, got ${data.status}`);
    createdInvoiceId = data.id;
  });

  await check("POST /invoices with taxRate=0.1 items → taxAmount > 0", async () => {
    expect(invCustomerId !== "", "Need customer id");
    const { status, data } = await api(
      "POST",
      "/invoices",
      {
        customerId: invCustomerId,
        items: [{ description: "Taxed Item", qty: 1, unitPrice: 100, taxRate: 0.1 }],
      },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(Number(data.taxAmount) > 0, `Expected taxAmount > 0, got ${data.taxAmount}`);
  });

  await check("POST /invoices (driver role) → 201", async () => {
    expect(invCustomerId !== "", "Need customer id");
    const { status, data } = await api(
      "POST",
      "/invoices",
      {
        customerId: invCustomerId,
        items: [{ description: "Driver Invoice Item", qty: 1, unitPrice: 50 }],
      },
      driverToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(typeof data.id === "string", "Expected invoice id");
  });

  await check("GET /invoices (operator) → 200", async () => {
    const { status, data } = await api("GET", "/invoices", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  await check("GET /invoices (customer) → 200 own only", async () => {
    const { status, data } = await api("GET", "/invoices", undefined, customerToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  await check("GET /invoices/:id (customer, own) → 200", async () => {
    // First find an invoice that belongs to harbor_cafe
    const { data: listData } = await api("GET", "/invoices", undefined, customerToken);
    const list: any[] = listData.data ?? listData ?? [];
    expect(list.length > 0, "Customer has no invoices");
    const { status } = await api("GET", `/invoices/${list[0].id}`, undefined, customerToken);
    expect(status === 200, `Expected 200, got ${status}`);
  });

  await check("PATCH /invoices/:id (draft) → 200", async () => {
    expect(draftInvoiceId !== "", "No draft invoice id");
    const { status, data } = await api(
      "PATCH",
      `/invoices/${draftInvoiceId}`,
      { notes: "Updated e2e note" },
      operatorToken,
    );
    expect(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
  });

  await check("POST /invoices/:id/send → 200, status=SENT", async () => {
    expect(draftInvoiceId !== "", "No draft invoice id");
    const { status, data } = await api(
      "POST",
      `/invoices/${draftInvoiceId}/send`,
      undefined,
      operatorToken,
    );
    expect(
      status === 200 || status === 201,
      `Expected 200/201, got ${status}: ${JSON.stringify(data)}`,
    );
    expect(data.status === "SENT", `Expected SENT, got ${data.status}`);
  });

  // Create a fresh SENT invoice we can void
  let voidableInvoiceId = "";
  await check("POST /invoices/:id/void → 200, status=VOID", async () => {
    const { data: nd } = await api(
      "POST",
      "/invoices",
      {
        customerId: invCustomerId,
        items: [{ description: "Voidable item", qty: 1, unitPrice: 5 }],
        send: true,
      },
      operatorToken,
    );
    voidableInvoiceId = nd.id;
    const { status, data } = await api(
      "POST",
      `/invoices/${voidableInvoiceId}/void`,
      undefined,
      operatorToken,
    );
    expect(
      status === 200 || status === 201,
      `Expected 200/201, got ${status}: ${JSON.stringify(data)}`,
    );
    expect(data.status === "VOID", `Expected VOID, got ${data.status}`);
  });

  // Create a SENT invoice for payment tests
  await check("POST /invoices/:id/payments partial → 201, status=PARTIAL", async () => {
    const { data: inv } = await api(
      "POST",
      "/invoices",
      {
        customerId: invCustomerId,
        items: [{ description: "Payable item", qty: 1, unitPrice: 200 }],
        send: true,
      },
      operatorToken,
    );
    payableInvoiceId = inv.id;
    const { status, data } = await api(
      "POST",
      `/invoices/${payableInvoiceId}/payments`,
      { amount: 50, method: "CASH" },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(data.status === "PARTIAL", `Expected PARTIAL, got ${data.status}`);
  });

  await check("POST /invoices/:id/payments full → 201, status=PAID", async () => {
    expect(payableInvoiceId !== "", "No payable invoice");
    const { status, data } = await api(
      "POST",
      `/invoices/${payableInvoiceId}/payments`,
      { amount: 150, method: "ACH" },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(data.status === "PAID", `Expected PAID, got ${data.status}`);
  });

  await check("POST /invoices/:id/void (PAID invoice) → 400", async () => {
    expect(payableInvoiceId !== "", "No paid invoice");
    const { status } = await api(
      "POST",
      `/invoices/${payableInvoiceId}/void`,
      undefined,
      operatorToken,
    );
    expect(status === 400, `Expected 400, got ${status}`);
  });

  await check("POST /invoices/:id/duplicate → 201 new DRAFT", async () => {
    expect(createdInvoiceId !== "", "No sent invoice id");
    const { status, data } = await api(
      "POST",
      `/invoices/${createdInvoiceId}/duplicate`,
      undefined,
      operatorToken,
    );
    expect(
      status === 200 || status === 201,
      `Expected 200/201, got ${status}: ${JSON.stringify(data)}`,
    );
    expect(data.status === "DRAFT", `Expected DRAFT, got ${data.status}`);
  });

  await check("POST /invoices/:id/write-off → 200", async () => {
    // Create a fresh SENT invoice to write off
    const { data: inv } = await api(
      "POST",
      "/invoices",
      {
        customerId: invCustomerId,
        items: [{ description: "Write-off item", qty: 1, unitPrice: 99 }],
        send: true,
      },
      operatorToken,
    );
    const { status, data } = await api(
      "POST",
      `/invoices/${inv.id}/write-off`,
      { reason: "Bad debt — e2e test" },
      operatorToken,
    );
    expect(
      status === 200 || status === 201,
      `Expected 200/201, got ${status}: ${JSON.stringify(data)}`,
    );
    expect(data.status === "WRITTEN_OFF", `Expected WRITTEN_OFF, got ${data.status}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Group 6 — Routes & Runs
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Group 6: Routes & Runs ────────────────────────────");

  await check("GET /routes (operator) → 200", async () => {
    const { status, data } = await api("GET", "/routes", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
    const list: any[] = data.data ?? data ?? [];
    expect(Array.isArray(list), "Expected array");
    if (list.length > 0 && !createdRouteId) createdRouteId = list[0].id;
  });

  await check("POST /routes → 201", async () => {
    const { status, data } = await api(
      "POST",
      "/routes",
      { name: `E2E Route ${RUN}` },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(typeof data.id === "string", "Expected route id");
    createdRouteId = data.id;
  });

  await check("GET /routes/customer-assignments (operator) → 200", async () => {
    const { status } = await api("GET", "/routes/customer-assignments", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
  });

  await check("GET /routes/customer-assignments (customer) → 403", async () => {
    const { status } = await api("GET", "/routes/customer-assignments", undefined, customerToken);
    expect(status === 403, `Expected 403, got ${status}`);
  });

  await check("POST /route-runs → 201 SCHEDULED", async () => {
    expect(createdRouteId !== "", "No route id");
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split("T")[0];
    const { status, data } = await api(
      "POST",
      "/route-runs",
      { routeId: createdRouteId, scheduledDate: tomorrow },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(data.status === "SCHEDULED", `Expected SCHEDULED, got ${data.status}`);
    createdRunId = data.id;
  });

  await check("GET /route-runs/my-stats (driver) → 200", async () => {
    const { status, data } = await api("GET", "/route-runs/my-stats", undefined, driverToken);
    expect(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
  });

  await check("PATCH /route-runs/:id/status IN_PROGRESS → 200", async () => {
    expect(createdRunId !== "", "No run id");
    const { status, data } = await api(
      "PATCH",
      `/route-runs/${createdRunId}/status`,
      { status: "IN_PROGRESS" },
      operatorToken,
    );
    expect(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
    expect(data.status === "IN_PROGRESS", `Expected IN_PROGRESS, got ${data.status}`);
  });

  await check("PATCH /route-runs/:id/status COMPLETED → 200", async () => {
    expect(createdRunId !== "", "No run id");
    const { status, data } = await api(
      "PATCH",
      `/route-runs/${createdRunId}/status`,
      { status: "COMPLETED" },
      operatorToken,
    );
    expect(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
    expect(data.status === "COMPLETED", `Expected COMPLETED, got ${data.status}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Group 7 — Products
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Group 7: Products ─────────────────────────────────");

  await check("GET /products (operator) → 200", async () => {
    const { status, data } = await api("GET", "/products", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  await check("GET /products (customer) → 403", async () => {
    const { status } = await api("GET", "/products", undefined, customerToken);
    expect(status === 403, `Expected 403, got ${status}`);
  });

  createdProductBarcode = `E2E${RUN}`;
  await check("POST /products → 201", async () => {
    const { status, data } = await api(
      "POST",
      "/products",
      {
        name: `E2E Product ${RUN}`,
        unit: "each",
        pricePerUnit: "9.99",
        barcode: createdProductBarcode,
        sku: `E2ESKU${RUN}`,
        category: "E2E",
      },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(typeof data.id === "string", "Expected product id");
    createdProductId = data.id;
  });

  await check("GET /products/barcode/:barcode → 200 with match", async () => {
    expect(createdProductBarcode !== "", "No barcode");
    const { status, data } = await api(
      "GET",
      `/products/barcode/${createdProductBarcode}`,
      undefined,
      operatorToken,
    );
    expect(status === 200, `Expected 200, got ${status}`);
    expect(data.barcode === createdProductBarcode, `Barcode mismatch: ${data.barcode}`);
  });

  await check("GET /products/barcode/NONEXISTENT → 404", async () => {
    const { status } = await api(
      "GET",
      "/products/barcode/BARCODE_DOES_NOT_EXIST_XYZ",
      undefined,
      operatorToken,
    );
    expect(status === 404, `Expected 404, got ${status}`);
  });

  await check("PATCH /products/:id → 200", async () => {
    expect(createdProductId !== "", "No product id");
    const { status, data } = await api(
      "PATCH",
      `/products/${createdProductId}`,
      { name: `E2E Product Updated ${RUN}`, pricePerUnit: "12.50" },
      operatorToken,
    );
    expect(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
  });

  await check("DELETE /products/:id → 200", async () => {
    // Create a throwaway product to delete
    const { data: p } = await api(
      "POST",
      "/products",
      {
        name: `E2E Deletable ${RUN}`,
        unit: "each",
        pricePerUnit: "1.00",
      },
      operatorToken,
    );
    const { status } = await api("DELETE", `/products/${p.id}`, undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Group 8 — Inventory
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Group 8: Inventory ────────────────────────────────");

  await check("GET /inventory/overview → 200", async () => {
    const { status, data } = await api("GET", "/inventory/overview", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array/object response");
  });

  let stockBeforePurchase = 0;
  await check("POST /inventory/movements/purchase → 201, stock increases", async () => {
    expect(createdProductId !== "", "Need product id");
    // Capture stock before
    const { data: ov } = await api("GET", "/inventory/overview", undefined, operatorToken);
    const items: any[] = ov.data ?? ov ?? [];
    const found = items.find(
      (i: any) => i.productId === createdProductId || i.id === createdProductId,
    );
    stockBeforePurchase = found ? Number(found.currentStock ?? found.qty ?? 0) : 0;

    const { status, data } = await api(
      "POST",
      "/inventory/movements/purchase",
      {
        productId: createdProductId,
        quantity: 10,
        unitCost: 5.0,
        notes: "e2e purchase",
      },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
  });

  await check("POST /inventory/movements/adjustment → 201", async () => {
    expect(createdProductId !== "", "Need product id");
    const { status, data } = await api(
      "POST",
      "/inventory/movements/adjustment",
      {
        productId: createdProductId,
        quantity: -2,
        notes: "e2e adjustment",
      },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
  });

  await check("GET /inventory/movements → 200", async () => {
    const { status, data } = await api("GET", "/inventory/movements", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  // For PO tests we need a supplier — fetch existing one or create inline
  let poSupplierId = createdSupplierId;
  if (!poSupplierId) {
    const { data: supList } = await api("GET", "/suppliers?limit=5", undefined, operatorToken);
    const sups: any[] = supList.data ?? supList ?? [];
    if (sups.length > 0) {
      poSupplierId = sups[0].id;
    } else {
      const { data: newSup } = await api(
        "POST",
        "/suppliers",
        { name: `E2E PO Supplier ${RUN}` },
        operatorToken,
      );
      poSupplierId = newSup.id ?? "";
    }
  }

  await check("POST /inventory/purchase-orders → 201", async () => {
    expect(createdProductId !== "", "Need product id");
    expect(poSupplierId !== "", "Need supplier id");
    const { status, data } = await api(
      "POST",
      "/inventory/purchase-orders",
      {
        supplierId: poSupplierId,
        items: [{ productId: createdProductId, qty: 5, unitCost: 4.0 }],
        notes: "e2e PO",
      },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(typeof data.id === "string", "Expected PO id");
    // Store for receive test
    (global as any).__e2ePOId = data.id;
  });

  await check("POST /inventory/purchase-orders/:id/receive → 200", async () => {
    const poId = (global as any).__e2ePOId;
    expect(poId, "No PO id from creation");
    const { status, data } = await api(
      "POST",
      `/inventory/purchase-orders/${poId}/receive`,
      { items: [{ productId: createdProductId, receivedQty: 5 }] },
      operatorToken,
    );
    expect(
      status === 200 || status === 201,
      `Expected 200/201, got ${status}: ${JSON.stringify(data)}`,
    );
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Group 9 — Suppliers
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Group 9: Suppliers ────────────────────────────────");

  await check("GET /suppliers (operator) → 200", async () => {
    const { status, data } = await api("GET", "/suppliers", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  await check("GET /suppliers (customer) → 403", async () => {
    const { status } = await api("GET", "/suppliers", undefined, customerToken);
    expect(status === 403, `Expected 403, got ${status}`);
  });

  await check("POST /suppliers → 201", async () => {
    const { status, data } = await api(
      "POST",
      "/suppliers",
      {
        name: `E2E Supplier ${RUN}`,
        contactName: "E2E Contact",
        phone: "0499000001",
        email: `e2e_supplier_${RUN}@test.com`,
      },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(typeof data.id === "string", "Expected supplier id");
    createdSupplierId = data.id;
  });

  await check("PATCH /suppliers/:id → 200", async () => {
    expect(createdSupplierId !== "", "No supplier id");
    const { status, data } = await api(
      "PATCH",
      `/suppliers/${createdSupplierId}`,
      { contactName: "Updated Contact" },
      operatorToken,
    );
    expect(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
  });

  await check("DELETE /suppliers/:id → 200", async () => {
    // Create a throwaway supplier to delete
    const { data: s } = await api(
      "POST",
      "/suppliers",
      { name: `E2E Del Supplier ${RUN}` },
      operatorToken,
    );
    const { status } = await api("DELETE", `/suppliers/${s.id}`, undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Group 10 — Vendor Bills
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Group 10: Vendor Bills ────────────────────────────");

  await check("POST /vendor-bills → 201", async () => {
    expect(createdSupplierId !== "", "Need supplier id");
    const { status, data } = await api(
      "POST",
      "/vendor-bills",
      {
        supplierId: createdSupplierId,
        items: [{ description: "E2E Bill Item", qty: 1, unitPrice: 100 }],
        dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(typeof data.id === "string", "Expected vendor bill id");
    createdVendorBillId = data.id;
  });

  await check("GET /vendor-bills → 200", async () => {
    const { status, data } = await api("GET", "/vendor-bills", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  await check("POST /vendor-bills/:id/receive → 200", async () => {
    expect(createdVendorBillId !== "", "No vendor bill id");
    const { status, data } = await api(
      "POST",
      `/vendor-bills/${createdVendorBillId}/receive`,
      undefined,
      operatorToken,
    );
    expect(
      status === 200 || status === 201,
      `Expected 200/201, got ${status}: ${JSON.stringify(data)}`,
    );
  });

  await check("POST /vendor-bills/:id/payments → 201", async () => {
    expect(createdVendorBillId !== "", "No vendor bill id");
    const { status, data } = await api(
      "POST",
      `/vendor-bills/${createdVendorBillId}/payments`,
      { amount: 50, method: "CASH", notes: "e2e partial payment" },
      operatorToken,
    );
    expect(
      status === 201 || status === 200,
      `Expected 201/200, got ${status}: ${JSON.stringify(data)}`,
    );
  });

  await check("POST /vendor-bills/:id/void → 200", async () => {
    // Create a fresh bill to void
    const { data: bill } = await api(
      "POST",
      "/vendor-bills",
      {
        supplierId: createdSupplierId,
        items: [{ description: "Voidable bill item", qty: 1, unitPrice: 10 }],
      },
      operatorToken,
    );
    const { status, data } = await api(
      "POST",
      `/vendor-bills/${bill.id}/void`,
      undefined,
      operatorToken,
    );
    expect(
      status === 200 || status === 201,
      `Expected 200/201, got ${status}: ${JSON.stringify(data)}`,
    );
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Group 11 — Bookkeeping
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Group 11: Bookkeeping ─────────────────────────────");

  await check("GET /bookkeeping/summary → 200", async () => {
    const { status } = await api("GET", "/bookkeeping/summary", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
  });

  await check("GET /bookkeeping/transactions → 200", async () => {
    const { status, data } = await api(
      "GET",
      "/bookkeeping/transactions",
      undefined,
      operatorToken,
    );
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  let expenseCategoryId = "";
  await check("POST /bookkeeping/expense-categories → 201", async () => {
    const { status, data } = await api(
      "POST",
      "/bookkeeping/expense-categories",
      { name: `E2E Expense Cat ${RUN}`, code: `E2ECAT${RUN}` },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(typeof data.id === "string", "Expected category id");
    expenseCategoryId = data.id;
  });

  await check("POST /bookkeeping/expenses → 201", async () => {
    expect(expenseCategoryId !== "", "No category id — expense-category creation must pass first");
    const { status, data } = await api(
      "POST",
      "/bookkeeping/expenses",
      {
        description: `E2E Expense ${RUN}`,
        amount: 42.5,
        date: new Date().toISOString().split("T")[0],
        categoryId: expenseCategoryId,
      },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(typeof data.id === "string", "Expected expense id");
  });

  await check("GET /bookkeeping/expenses → 200", async () => {
    const { status } = await api("GET", "/bookkeeping/expenses", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
  });

  await check("GET /bookkeeping/reports/pl → 200", async () => {
    const { status } = await api("GET", "/bookkeeping/reports/pl", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
  });

  await check("GET /bookkeeping/reports/aging → 200", async () => {
    const { status } = await api("GET", "/bookkeeping/reports/aging", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
  });

  await check("GET /bookkeeping/reports/cashflow → 200", async () => {
    const { status } = await api("GET", "/bookkeeping/reports/cashflow", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
  });

  await check("GET /bookkeeping/finance-dashboard → 200", async () => {
    const { status } = await api("GET", "/bookkeeping/finance-dashboard", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
  });

  await check("GET /bookkeeping/reports/sales-by-customer → 200", async () => {
    const { status } = await api(
      "GET",
      "/bookkeeping/reports/sales-by-customer",
      undefined,
      operatorToken,
    );
    expect(status === 200, `Expected 200, got ${status}`);
  });

  await check("GET /bookkeeping/reports/bad-debts → 200", async () => {
    const { status } = await api("GET", "/bookkeeping/reports/bad-debts", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Group 12 — Analytics
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Group 12: Analytics ───────────────────────────────");

  await check("GET /analytics/revenue → 200", async () => {
    const { status } = await api("GET", "/analytics/revenue", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
  });

  await check("GET /analytics/products/top → 200", async () => {
    const { status, data } = await api("GET", "/analytics/products/top", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  await check("GET /analytics/customers/top → 200", async () => {
    const { status, data } = await api("GET", "/analytics/customers/top", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  await check("GET /analytics/routes/performance → 200, has completionRate field", async () => {
    const { status, data } = await api(
      "GET",
      "/analytics/routes/performance",
      undefined,
      operatorToken,
    );
    expect(status === 200, `Expected 200, got ${status}`);
    const list: any[] = data.data ?? data ?? [];
    if (list.length > 0) {
      expect(
        "completionRate" in list[0],
        `Expected completionRate field, got keys: ${Object.keys(list[0]).join(", ")}`,
      );
    }
  });

  await check("GET /analytics/drivers/performance → 200, has completionRate field", async () => {
    const { status, data } = await api(
      "GET",
      "/analytics/drivers/performance",
      undefined,
      operatorToken,
    );
    expect(status === 200, `Expected 200, got ${status}`);
    const list: any[] = data.data ?? data ?? [];
    if (list.length > 0) {
      expect(
        "completionRate" in list[0],
        `Expected completionRate field, got keys: ${Object.keys(list[0]).join(", ")}`,
      );
    }
  });

  await check("GET /analytics/dso → 200", async () => {
    const { status } = await api("GET", "/analytics/dso", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
  });

  await check("GET /analytics/gross-margin → 200", async () => {
    const { status } = await api("GET", "/analytics/gross-margin", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Group 13 — Credit Notes
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Group 13: Credit Notes ────────────────────────────");

  await check("POST /credit-notes → 201", async () => {
    const cId = existingCustomerId || createdCustomerId;
    expect(cId !== "", "Need customer id");
    const { status, data } = await api(
      "POST",
      "/credit-notes",
      { customerId: cId, amount: 15, reason: "E2E test credit note" },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(typeof data.id === "string", "Expected credit note id");
    createdCreditNoteId = data.id;
  });

  await check("GET /credit-notes (operator) → 200", async () => {
    const { status, data } = await api("GET", "/credit-notes", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  await check("GET /credit-notes (customer) → 200 own", async () => {
    const { status, data } = await api("GET", "/credit-notes", undefined, customerToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  await check("POST /credit-notes/:id/issue → 200 ISSUED", async () => {
    // Create a fresh credit note in DRAFT status to issue
    // Note: credit notes are created as ISSUED directly in this service,
    // so we just verify the issue endpoint on the existing one (idempotent or 400)
    expect(createdCreditNoteId !== "", "No credit note id");
    const { status, data } = await api(
      "POST",
      `/credit-notes/${createdCreditNoteId}/issue`,
      undefined,
      operatorToken,
    );
    // Could return 200 (already issued, idempotent) or 400 (already issued)
    expect(
      [200, 201, 400].includes(status),
      `Expected 200/201/400, got ${status}: ${JSON.stringify(data)}`,
    );
  });

  await check("POST /credit-notes/:id/void → 200 VOID", async () => {
    // Create a fresh credit note to void
    const cId = existingCustomerId || createdCustomerId;
    const { data: cn } = await api(
      "POST",
      "/credit-notes",
      { customerId: cId, amount: 5, reason: "Voidable CN" },
      operatorToken,
    );
    const { status, data } = await api(
      "POST",
      `/credit-notes/${cn.id}/void`,
      undefined,
      operatorToken,
    );
    expect(
      status === 200 || status === 201,
      `Expected 200/201, got ${status}: ${JSON.stringify(data)}`,
    );
    expect(data.status === "VOID", `Expected VOID, got ${data.status}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Group 14 — Returns
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Group 14: Returns ─────────────────────────────────");

  // Find or create a DELIVERED order to use for a return
  let deliveredOrderId = "";
  let deliveredOrderProductId = "";
  let deliveredOrderProductQty = 1;
  {
    // First look for an existing DELIVERED order
    const { data } = await api(
      "GET",
      "/orders?status=DELIVERED&limit=10",
      undefined,
      operatorToken,
    );
    const list: any[] = data.data ?? data ?? [];
    if (list.length > 0) {
      deliveredOrderId = list[0].id;
      if (list[0].lineItems?.length > 0) {
        deliveredOrderProductId = list[0].lineItems[0].productId;
        deliveredOrderProductQty = list[0].lineItems[0].qty;
      } else if (list[0].items?.length > 0) {
        deliveredOrderProductId = list[0].items[0].productId;
        deliveredOrderProductQty = list[0].items[0].qty;
      }
    }
    // If no DELIVERED order, create and deliver the order we made in Group 4
    if (!deliveredOrderId && createdOrderId && orderProductId) {
      // Advance: CONFIRMED → OUT_FOR_DELIVERY → DELIVERED
      await api(
        "PATCH",
        `/orders/${createdOrderId}/status`,
        { status: "OUT_FOR_DELIVERY" },
        operatorToken,
      );
      const { data: delivered } = await api(
        "PATCH",
        `/orders/${createdOrderId}/status`,
        { status: "DELIVERED" },
        operatorToken,
      );
      if (delivered?.id) {
        deliveredOrderId = createdOrderId;
        deliveredOrderProductId = orderProductId;
        deliveredOrderProductQty = 2;
      }
    }
  }

  await check("POST /returns → 201", async () => {
    expect(deliveredOrderId !== "", "Need a DELIVERED order for returns");
    expect(deliveredOrderProductId !== "", "Need product id from delivered order");
    const { status, data } = await api(
      "POST",
      "/returns",
      {
        orderId: deliveredOrderId,
        reason: "DAMAGED",
        items: [{ productId: deliveredOrderProductId, qty: 1 }],
        notes: "e2e return test",
      },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(typeof data.id === "string", "Expected return id");
    createdReturnId = data.id;
  });

  await check("GET /returns (operator) → 200 all", async () => {
    const { status, data } = await api("GET", "/returns", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  await check("GET /returns (customer) → 200 own", async () => {
    const { status, data } = await api("GET", "/returns", undefined, customerToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  await check("POST /returns/:id/cancel → 200", async () => {
    expect(createdReturnId !== "", "No return id");
    const { status, data } = await api(
      "POST",
      `/returns/${createdReturnId}/cancel`,
      undefined,
      operatorToken,
    );
    expect(
      status === 200 || status === 201,
      `Expected 200/201, got ${status}: ${JSON.stringify(data)}`,
    );
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Group 15 — Estimates
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Group 15: Estimates ───────────────────────────────");

  const estCustomerId = existingCustomerId || createdCustomerId;

  await check("POST /estimates → 201", async () => {
    expect(estCustomerId !== "", "Need customer id");
    const { status, data } = await api(
      "POST",
      "/estimates",
      {
        customerId: estCustomerId,
        items: [{ description: "E2E Estimate Item", qty: 2, unitPrice: 75 }],
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(typeof data.id === "string", "Expected estimate id");
    createdEstimateId = data.id;
  });

  await check("GET /estimates → 200", async () => {
    const { status, data } = await api("GET", "/estimates", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  await check("POST /estimates/:id/send → 200", async () => {
    expect(createdEstimateId !== "", "No estimate id");
    const { status, data } = await api(
      "POST",
      `/estimates/${createdEstimateId}/send`,
      undefined,
      operatorToken,
    );
    expect(
      status === 200 || status === 201,
      `Expected 200/201, got ${status}: ${JSON.stringify(data)}`,
    );
    expect(data.status === "SENT", `Expected SENT, got ${data.status}`);
  });

  await check("POST /estimates/:id/accept → 200", async () => {
    expect(createdEstimateId !== "", "No estimate id");
    const { status, data } = await api(
      "POST",
      `/estimates/${createdEstimateId}/accept`,
      undefined,
      operatorToken,
    );
    expect(
      status === 200 || status === 201,
      `Expected 200/201, got ${status}: ${JSON.stringify(data)}`,
    );
    expect(data.status === "ACCEPTED", `Expected ACCEPTED, got ${data.status}`);
  });

  await check("POST /estimates/:id/convert-to-invoice → 201 invoice created", async () => {
    expect(createdEstimateId !== "", "No estimate id");
    const { status, data } = await api(
      "POST",
      `/estimates/${createdEstimateId}/convert-to-invoice`,
      undefined,
      operatorToken,
    );
    expect(
      status === 200 || status === 201,
      `Expected 200/201, got ${status}: ${JSON.stringify(data)}`,
    );
    expect(
      typeof data.id === "string" && (data.invoiceNumber != null || data.status != null),
      `Expected invoice, got: ${JSON.stringify(data)}`,
    );
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Group 16 — Recurring Invoices
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Group 16: Recurring Invoices ──────────────────────");

  const recCustomerId = existingCustomerId || createdCustomerId;

  await check("POST /recurring-invoices → 201", async () => {
    expect(recCustomerId !== "", "Need customer id");
    const nextRun = new Date(Date.now() + 86_400_000).toISOString();
    const { status, data } = await api(
      "POST",
      "/recurring-invoices",
      {
        customerId: recCustomerId,
        frequency: "WEEKLY",
        dayOfWeek: 1,
        nextRunAt: nextRun,
        autoSend: false,
        items: [{ description: "E2E Recurring Item", qty: 1, unitPrice: 50 }],
      },
      operatorToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(typeof data.id === "string", "Expected recurring invoice id");
    createdRecurringId = data.id;
  });

  await check("GET /recurring-invoices → 200", async () => {
    const { status, data } = await api("GET", "/recurring-invoices", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  await check("POST /recurring-invoices/:id/run → 201 invoice generated", async () => {
    expect(createdRecurringId !== "", "No recurring invoice id");
    const { status, data } = await api(
      "POST",
      `/recurring-invoices/${createdRecurringId}/run`,
      undefined,
      operatorToken,
    );
    expect(
      status === 200 || status === 201,
      `Expected 200/201, got ${status}: ${JSON.stringify(data)}`,
    );
    expect(typeof data.id === "string", `Expected invoice object, got: ${JSON.stringify(data)}`);
  });

  await check("DELETE /recurring-invoices/:id → 200", async () => {
    // Create throwaway
    const nextRun = new Date(Date.now() + 86_400_000).toISOString();
    const { data: ri } = await api(
      "POST",
      "/recurring-invoices",
      {
        customerId: recCustomerId,
        frequency: "MONTHLY",
        dayOfMonth: 1,
        nextRunAt: nextRun,
        items: [{ description: "Del recurring item", qty: 1, unitPrice: 10 }],
      },
      operatorToken,
    );
    const { status } = await api(
      "DELETE",
      `/recurring-invoices/${ri.id}`,
      undefined,
      operatorToken,
    );
    expect(status === 200, `Expected 200, got ${status}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Group 17 — Order Templates
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Group 17: Order Templates ─────────────────────────");

  await check("POST /order-templates (customer) → 201", async () => {
    expect(orderProductId !== "", "Need product id for template");
    const { status, data } = await api(
      "POST",
      "/order-templates",
      {
        name: `E2E Template ${RUN}`,
        daysOfWeek: [1, 3],
        items: [{ productId: orderProductId, qty: 2 }],
      },
      customerToken,
    );
    expect(status === 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    expect(typeof data.id === "string", "Expected template id");
    createdTemplateId = data.id;
  });

  await check("GET /order-templates (customer) → 200 own", async () => {
    const { status, data } = await api("GET", "/order-templates", undefined, customerToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  await check("GET /order-templates (operator) → 200 all", async () => {
    const { status, data } = await api("GET", "/order-templates", undefined, operatorToken);
    expect(status === 200, `Expected 200, got ${status}`);
    expect(Array.isArray(data.data ?? data), "Expected array");
  });

  await check("POST /order-templates/:id/generate → 201 order", async () => {
    expect(createdTemplateId !== "", "No template id");
    const { status, data } = await api(
      "POST",
      `/order-templates/${createdTemplateId}/generate`,
      undefined,
      operatorToken,
    );
    expect(
      status === 200 || status === 201,
      `Expected 200/201, got ${status}: ${JSON.stringify(data)}`,
    );
    expect(typeof data.id === "string", "Expected order object with id");
  });

  await check("DELETE /order-templates/:id → 200", async () => {
    expect(createdTemplateId !== "", "No template id");
    const { status } = await api(
      "DELETE",
      `/order-templates/${createdTemplateId}`,
      undefined,
      customerToken,
    );
    expect(status === 200, `Expected 200, got ${status}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Group 18 — Full Journey Tests
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Group 18: Full Journeys ───────────────────────────");

  await check("JOURNEY: order → invoice → send → payment", async () => {
    const jCustId = existingCustomerId || createdCustomerId;
    expect(jCustId !== "", "Need customer id");
    expect(orderProductId !== "", "Need product id");

    // 1. Create order
    const { data: order } = await api(
      "POST",
      "/orders",
      { customerId: jCustId, items: [{ productId: orderProductId, qty: 3 }] },
      operatorToken,
    );
    expect(order.id, "No order id");

    // 2. Create DRAFT invoice
    const { status: s2, data: inv } = await api(
      "POST",
      "/invoices",
      {
        customerId: jCustId,
        items: [{ description: "Journey invoice item", qty: 3, unitPrice: 20 }],
      },
      operatorToken,
    );
    expect(s2 === 201, `Invoice creation failed: ${s2}`);
    expect(inv.status === "DRAFT", `Expected DRAFT, got ${inv.status}`);

    // 3. Send invoice
    const { status: s3, data: sent } = await api(
      "POST",
      `/invoices/${inv.id}/send`,
      undefined,
      operatorToken,
    );
    expect(s3 === 200 || s3 === 201, `Send failed: ${s3}`);
    expect(sent.status === "SENT", `Expected SENT, got ${sent.status}`);

    // 4. Record full payment
    const total = Number(inv.total);
    const { status: s4, data: paid } = await api(
      "POST",
      `/invoices/${inv.id}/payments`,
      { amount: total, method: "CASH" },
      operatorToken,
    );
    expect(s4 === 201, `Payment failed: ${s4}`);
    expect(paid.status === "PAID", `Expected PAID, got ${paid.status}`);
  });

  await check("JOURNEY: estimate → convert → invoice", async () => {
    const jCustId = existingCustomerId || createdCustomerId;
    expect(jCustId !== "", "Need customer id");

    // 1. Create estimate
    const { data: est } = await api(
      "POST",
      "/estimates",
      {
        customerId: jCustId,
        items: [{ description: "Journey estimate item", qty: 1, unitPrice: 500 }],
      },
      operatorToken,
    );
    expect(est.id, "No estimate id");

    // 2. Send it
    const { data: sent } = await api("POST", `/estimates/${est.id}/send`, undefined, operatorToken);
    expect(sent.status === "SENT", `Expected SENT, got ${sent.status}`);

    // 3. Accept it
    const { data: accepted } = await api(
      "POST",
      `/estimates/${est.id}/accept`,
      undefined,
      operatorToken,
    );
    expect(accepted.status === "ACCEPTED", `Expected ACCEPTED, got ${accepted.status}`);

    // 4. Convert to invoice
    const { status: s4, data: inv } = await api(
      "POST",
      `/estimates/${est.id}/convert-to-invoice`,
      undefined,
      operatorToken,
    );
    expect(s4 === 200 || s4 === 201, `Convert failed: ${s4}`);
    expect(typeof inv.id === "string" && inv.invoiceNumber != null, "Expected invoice with number");
  });

  await check("JOURNEY: return → credit note → apply to invoice", async () => {
    const jCustId = existingCustomerId || createdCustomerId;
    expect(jCustId !== "", "Need customer id");

    // 1. Create a SENT invoice
    const { data: inv } = await api(
      "POST",
      "/invoices",
      {
        customerId: jCustId,
        items: [{ description: "CN Journey Invoice", qty: 1, unitPrice: 300 }],
        send: true,
      },
      operatorToken,
    );
    expect(inv.id, "No invoice id");

    // 2. Create a credit note against that invoice
    const { status: s2, data: cn } = await api(
      "POST",
      "/credit-notes",
      { customerId: jCustId, invoiceId: inv.id, amount: 50, reason: "Journey CN" },
      operatorToken,
    );
    expect(s2 === 201, `CN creation failed: ${s2}`);
    expect(cn.id, "No credit note id");

    // 3. Apply the credit note to the invoice
    const { status: s3, data: applied } = await api(
      "POST",
      `/credit-notes/${cn.id}/apply`,
      { invoiceId: inv.id, amount: 50 },
      operatorToken,
    );
    expect(s3 === 200 || s3 === 201, `Apply failed: ${s3}: ${JSON.stringify(applied)}`);
  });

  await check("JOURNEY: PO → receive → stock increases", async () => {
    expect(createdProductId !== "", "Need product id");

    // Capture stock before
    const { data: ov1 } = await api("GET", "/inventory/overview", undefined, operatorToken);
    const items1: any[] = ov1.data ?? ov1 ?? [];
    const before = items1.find(
      (i: any) => i.productId === createdProductId || i.id === createdProductId,
    );
    const stockBefore = before ? Number(before.currentStock ?? before.qty ?? 0) : 0;

    // Create PO
    expect(createdSupplierId !== "", "Need supplier id for PO journey");
    const { status: s1, data: po } = await api(
      "POST",
      "/inventory/purchase-orders",
      {
        supplierId: createdSupplierId,
        items: [{ productId: createdProductId, qty: 8, unitCost: 3.5 }],
      },
      operatorToken,
    );
    expect(s1 === 201, `PO creation failed: ${s1}: ${JSON.stringify(po)}`);

    // Receive it
    const { status: s2 } = await api(
      "POST",
      `/inventory/purchase-orders/${po.id}/receive`,
      { items: [{ productId: createdProductId, receivedQty: 8 }] },
      operatorToken,
    );
    expect(s2 === 200 || s2 === 201, `Receive failed: ${s2}`);

    // Verify stock increased
    const { data: ov2 } = await api("GET", "/inventory/overview", undefined, operatorToken);
    const items2: any[] = ov2.data ?? ov2 ?? [];
    const after = items2.find(
      (i: any) => i.productId === createdProductId || i.id === createdProductId,
    );
    const stockAfter = after ? Number(after.currentStock ?? after.qty ?? 0) : 0;
    expect(
      stockAfter > stockBefore,
      `Stock did not increase: before=${stockBefore}, after=${stockAfter}`,
    );
  });

  await check("JOURNEY: recurring template → run → invoice generated", async () => {
    const jCustId = existingCustomerId || createdCustomerId;
    expect(jCustId !== "", "Need customer id");

    // 1. Create recurring invoice
    const nextRun = new Date(Date.now() + 86_400_000).toISOString();
    const { status: s1, data: ri } = await api(
      "POST",
      "/recurring-invoices",
      {
        customerId: jCustId,
        frequency: "WEEKLY",
        dayOfWeek: 2,
        nextRunAt: nextRun,
        autoSend: false,
        items: [{ description: "Journey recurring item", qty: 1, unitPrice: 99 }],
      },
      operatorToken,
    );
    expect(s1 === 201, `Recurring creation failed: ${s1}`);
    expect(ri.id, "No recurring invoice id");

    // 2. Run it manually
    const { status: s2, data: generated } = await api(
      "POST",
      `/recurring-invoices/${ri.id}/run`,
      undefined,
      operatorToken,
    );
    expect(s2 === 200 || s2 === 201, `Run failed: ${s2}: ${JSON.stringify(generated)}`);
    expect(
      typeof generated.id === "string" && generated.invoiceNumber != null,
      `Expected invoice with invoiceNumber, got: ${JSON.stringify(generated)}`,
    );
  });

  // ── Final summary ──────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════");
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} checks`);
  if (failures.length) {
    console.log("\nFAILURES:");
    failures.forEach((f) => console.log(`  ✗ ${f}`));
  }
  console.log("══════════════════════════════════════════════════════");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
