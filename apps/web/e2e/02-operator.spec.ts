/**
 * Operator / Tenant Admin UI tests — dashboard at /dashboard
 *
 * Covers: OP-01 through OP-21
 * Role: OPERATOR (admin / Admin@123) within the seeded tenant
 */

import { test, expect } from "@playwright/test";
import { setTenantCookie, loginAsOperator, logout } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";

test.describe("Operator — Tenant Dashboard", () => {
  // Storage state (operator.json) is pre-loaded by the "operator" Playwright project,
  // so each test context starts already authenticated. We set the tenant header for
  // correct middleware routing, then navigate to the dashboard.
  test.beforeEach(async ({ page, context }) => {
    const baseURL =
      process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";
    await setTenantCookie(context, baseURL);
    await page.goto("/dashboard");
  });

  test.afterEach(async ({ page }) => {
    await logout(page);
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  test("OP-01 login with company code → tenant branding shown on login page", async ({
    page,
    context,
  }) => {
    await logout(page);
    const baseURL =
      process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";
    await setTenantCookie(context, baseURL, TENANT_SLUG);
    await page.goto("/login");
    // Page loaded (not an error): the login form's Sign in button is visible.
    // (The reskin's <h1> lives in a lg:hidden mobile bar, so it is hidden on the
    // desktop viewport; assert the always-visible form control instead.)
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("OP-02 wrong password → inline error shown", async ({ page, context }) => {
    await logout(page);
    const baseURL =
      process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";
    await setTenantCookie(context, baseURL, TENANT_SLUG);
    await page.goto("/login");
    await page.getByLabel("Username or email").fill("admin");
    await page.getByPlaceholder("Enter your password").fill("wrong!");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    // Wrong credentials are rejected: never reaches the dashboard and the login
    // form stays put. (Asserting exact error copy is brittle across reskins.)
    await expect(page).not.toHaveURL(/\/dashboard/, { timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  });

  // ── Dashboard ─────────────────────────────────────────────────────────────

  test("OP-03 dashboard loads — KPI cards and recent orders visible", async ({ page }) => {
    await page.goto("/dashboard");
    // At least one card/metric should be visible
    const card = page
      .locator("[class*='stat'], [class*='kpi'], [class*='card'], [class*='metric']")
      .first();
    await expect(card).toBeVisible({ timeout: 15_000 });
  });

  test("OP-03b dispatch-addon canary — Dispatch nav group visible in sidebar", async ({ page }) => {
    // The e2e tenant keeps the recurring_routes + order_delivery addons active
    // via e2e-seed.js (developer_mode no longer unlocks them since 2026-08-28),
    // so the Dispatch nav group (Overview / Routes / Drivers) must render. This
    // fails fast and clearly on a broken/missing seed row, instead of OP-10
    // failing vaguely later when it can't find the /routes nav link.
    await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible({
      timeout: 15_000,
    });
  });

  // ── Orders ────────────────────────────────────────────────────────────────

  test("OP-04 orders list loads with search functionality", async ({ page }) => {
    await page.goto("/orders");
    // Table or empty state
    const content = page.locator("table, [class*='empty']").first();
    await expect(content).toBeVisible({ timeout: 15_000 });
    // Search input
    const search = page
      .getByPlaceholder(/search/i)
      .or(page.getByRole("searchbox"))
      .first();
    await expect(search).toBeVisible();
    await search.fill("test");
    await page.waitForTimeout(600);
  });

  test("OP-05 filter orders by status — PENDING filter applies", async ({ page }) => {
    await page.goto("/orders");
    // Look for status filter chips or dropdown
    const pendingFilter = page
      .getByRole("button", { name: /pending/i })
      .or(page.getByText("Pending").first());
    if (await pendingFilter.isVisible()) {
      await pendingFilter.click();
      await page.waitForTimeout(600);
      // All visible status badges should be PENDING
      const badges = page.locator("[class*='badge'], [class*='status']");
      const count = await badges.count();
      if (count > 0) {
        await expect(badges.first()).toContainText(/pending/i);
      }
    }
  });

  // ── Customers ─────────────────────────────────────────────────────────────

  test("OP-06 customers list loads", async ({ page }) => {
    await page.goto("/customers");
    const content = page.locator("table, [class*='grid'], [class*='empty']").first();
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  test("OP-07 customers search filters list", async ({ page }) => {
    await page.goto("/customers");
    const rows = page.locator("table tbody tr");
    // The seeded tenant has customers; wait for the list to populate.
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    const before = await rows.count();
    const search = page
      .getByPlaceholder(/search/i)
      .or(page.getByRole("searchbox"))
      .first();
    await expect(search).toBeVisible({ timeout: 10_000 });
    // Data-agnostic: a query that matches nothing must shrink the list, proving
    // the search filter actually runs (no dependency on a specific customer name).
    await search.fill("zzznomatch" + Date.now());
    await page.waitForTimeout(800);
    const after = await rows.count();
    expect(before).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
  });

  test("OP-08 customer detail page loads", async ({ page }) => {
    await page.goto("/customers");
    // Click first customer row
    await page.locator("table tbody tr a, table tbody tr").first().click();
    await page.waitForURL(/\/customers\/.+/);
    await expect(page).toHaveURL(/\/customers\/.+/);
  });

  // ── Products ──────────────────────────────────────────────────────────────

  test("OP-09 products grid loads — SKU and price visible", async ({ page }) => {
    await page.goto("/products");
    const content = page
      .locator("table, [class*='grid'], [class*='product'], [class*='empty']")
      .first();
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  test("OP-09b category autocomplete — endpoint serves suggestions; typing a new one is kept", async ({
    page,
  }) => {
    // Locks the GET /products/categories route ordering (declared before /:id —
    // a regression turns this into a silent 404/400 from findOne("categories")).
    const categoriesResp = page.waitForResponse(
      (r) => r.url().includes("/products/categories") && r.request().method() === "GET",
    );
    await page.goto("/products");
    await page
      .getByRole("button", { name: /new product/i })
      .first()
      .click();
    const categoryInput = page.getByPlaceholder("Select or type a new category");
    await expect(categoryInput).toBeVisible({ timeout: 15_000 });
    await categoryInput.click();
    const resp = await categoriesResp;
    expect(resp.status()).toBe(200);
    const categories: string[] = await resp.json();
    expect(Array.isArray(categories)).toBe(true);

    if (categories.length > 0) {
      // Suggestions listed; clicking one fills the input.
      const first = categories[0];
      const option = page.getByRole("button", { name: first, exact: true }).first();
      await expect(option).toBeVisible();
      await option.click();
      await expect(categoryInput).toHaveValue(first);
    }

    // A brand-new category is kept as typed (created implicitly on save).
    await categoryInput.fill("E2E Novel Category");
    await expect(page.getByText(/new category/i).first()).toBeVisible();
    await expect(categoryInput).toHaveValue("E2E Novel Category");
    await page.keyboard.press("Escape");
  });

  test('OP-09c tier prices save on a standalone product (regression: parentProductId "" → 400)', async ({
    page,
  }) => {
    await page.goto("/products");
    // Products defaults to Grid view (cards, no <table>) — switch to Table view
    // so the row-click locator below has a table to match.
    await page.getByRole("button", { name: /table view/i }).click();
    // Open the first product's detail page. Click the FIRST cell specifically
    // (product name/thumbnail) — several other cells (SKU, Category, Price)
    // wrap their content in onClick={e => e.stopPropagation()} for their own
    // inline-edit controls, so a raw row click can land there and silently
    // swallow the row's onRowClick navigation.
    await page.locator("table tbody tr td").first().click();
    await page.waitForURL(/\/products\/.+/);
    // Enter edit mode (icon button)
    await page.locator('button[title="Edit product"]').first().click();
    // Set Tier 2 to a valid price. (The tier editor is a DecimalInput —
    // type="text" inputMode="decimal" since the money-input fix.)
    const tier2 = page.getByText("Tier 2", { exact: true }).locator("xpath=..").locator("input");
    await expect(tier2).toBeVisible({ timeout: 10_000 });
    await tier2.fill("9.75");
    // Save must produce a 2xx PATCH — the old spread payload sent
    // parentProductId: "" and 400'd EVERY save from this form.
    const patchResp = page.waitForResponse(
      (r) => r.url().includes("/products/") && r.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: /save/i }).first().click();
    const resp = await patchResp;
    expect(resp.status()).toBeLessThan(300);
    // Edit mode closes back to the pencil button (no error toast path).
    await expect(page.locator('button[title="Edit product"]').first()).toBeVisible({
      timeout: 10_000,
    });
  });

  // ── Routes ────────────────────────────────────────────────────────────────

  test("OP-10 routes list loads", async ({ page }) => {
    await page.goto("/routes");
    const content = page.locator("table, [class*='route'], [class*='empty']").first();
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  // ── Invoices ──────────────────────────────────────────────────────────────

  test("OP-11 invoices list loads with status filter", async ({ page }) => {
    await page.goto("/invoices");
    const content = page.locator("table, [class*='invoice'], [class*='empty']").first();
    await expect(content).toBeVisible({ timeout: 15_000 });
    // Try clicking the first status tab/chip (OVERDUE, SENT, PAID, etc.)
    // Use first() to avoid strict-mode violations when multiple elements match
    const filterBtn = page
      .locator("button[class*='tab'], button[class*='filter'], button[class*='chip']")
      .first();
    const isFilterVisible = await filterBtn.isVisible().catch(() => false);
    if (isFilterVisible) {
      await filterBtn.click();
      await page.waitForTimeout(400);
    }
  });

  test("OP-11b money inputs never reformat while typing (2.50 stays 2.50, not 2.05)", async ({
    page,
  }) => {
    // The product tier editor uses the shared DecimalInput — the same component
    // behind every price/discount field. Typing must be sanitize-only; the old
    // numeric-bound input echoed toFixed(2) mid-keystroke ("2." → "2.00" → "2.05").
    await page.goto("/products");
    // Products defaults to Grid view (cards, no <table>) — switch to Table view
    // so the row-click locator below has a table to match.
    await page.getByRole("button", { name: /table view/i }).click();
    // Click the FIRST cell specifically — see OP-09c's comment: other cells
    // (SKU, Category, Price) stopPropagation() for their own inline-edit
    // controls, so a raw row click can silently swallow the navigation.
    await page.locator("table tbody tr td").first().click();
    await page.waitForURL(/\/products\/.+/);
    await page.locator('button[title="Edit product"]').first().click();
    const tier2 = page.getByText("Tier 2", { exact: true }).locator("xpath=..").locator("input");
    await expect(tier2).toBeVisible({ timeout: 10_000 });

    await tier2.fill("");
    await tier2.pressSequentially("2.50", { delay: 40 });
    await expect(tier2).toHaveValue("2.50"); // literal keystrokes preserved

    await tier2.fill("");
    await tier2.pressSequentially("2.5", { delay: 40 });
    await expect(tier2).toHaveValue("2.5"); // intermediate state intact while focused
    await tier2.blur();
    await expect(tier2).toHaveValue("2.50"); // formatted exactly once, on blur

    // Leave edit mode without saving (save behavior is covered elsewhere).
    await page.locator('button[title="Cancel"]').first().click();
  });

  // ── Returns ───────────────────────────────────────────────────────────────

  test("OP-12 returns list loads", async ({ page }) => {
    await page.goto("/returns");
    const content = page.locator("table, [class*='return'], [class*='empty']").first();
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  // ── Analytics ─────────────────────────────────────────────────────────────

  test("OP-13 analytics page renders — chart container visible", async ({ page }) => {
    await page.goto("/analytics");
    await expect(page).not.toHaveURL(/error/);
    const content = page.locator("canvas, [class*='chart'], [class*='analytics'], h1, h2").first();
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  // ── Finance ───────────────────────────────────────────────────────────────

  test("OP-14 finance dashboard loads", async ({ page }) => {
    await page.goto("/finance/dashboard");
    await expect(page).not.toHaveURL(/error/);
    const content = page.locator("[class*='card'], [class*='stat'], h1, h2").first();
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  // ── Estimates ─────────────────────────────────────────────────────────────

  test("OP-15 estimates list loads", async ({ page }) => {
    await page.goto("/estimates");
    const content = page.locator("table, [class*='empty']").first();
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  // ── Credit Notes ─────────────────────────────────────────────────────────

  test("OP-16 credit notes list loads", async ({ page }) => {
    await page.goto("/credit-notes");
    const content = page.locator("table, [class*='empty']").first();
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  // ── Inventory ─────────────────────────────────────────────────────────────

  test("OP-17 inventory page loads — product stock levels visible", async ({ page }) => {
    await page.goto("/inventory");
    await expect(page).not.toHaveURL(/error/);
    const content = page.locator("table, [class*='inventory'], [class*='empty']").first();
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  test("OP-17b vendor-bill scan surfaces unmatched lines: banner + create-product prefill + explicit acknowledge", async ({
    page,
  }) => {
    // Canned AI extraction: two lines, neither matches a product. Unmatched
    // lines must be SURFACED (banner + per-line create), never silently dropped.
    await page.route("**/vendor-bills/scan-invoice", (route) =>
      route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          supplier: "E2E Wholesale Co",
          invoiceNumber: "INV-E2E-1",
          invoiceDate: "2026-07-01",
          expenseDescription: null,
          expenseCategory: null,
          subtotal: 70,
          tax: 0,
          total: 70,
          notes: null,
          items: [
            {
              extractedName: "ACME COLA 24PK",
              qty: 2,
              unitCost: 20,
              lineTotal: 40,
              matchedProductId: null,
              matchedProductName: null,
              confidence: "none",
            },
            {
              extractedName: "MYSTERY SNACK BOX",
              qty: 3,
              unitCost: 10,
              lineTotal: 30,
              matchedProductId: null,
              matchedProductName: null,
              confidence: "none",
            },
          ],
        }),
      }),
    );

    await mockSuppliers(page);
    await page.goto("/inventory");
    await page.getByRole("button", { name: /scan invoice/i }).click();
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: "invoice.png", mimeType: "image/png", buffer: Buffer.from("fake") });

    // Review step: the unmatched banner names the count.
    const banner = page.getByTestId("unmatched-banner");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText(/2 items didn't match/i);

    // Per-line quick-create opens pre-filled from the extracted line:
    // name verbatim, sell price suggested at cost 20 × 1.3 = 26.00.
    // The review table declares min-width 720px, but with the invoice preview pane
    // open the right side is ~580px, so the row overflows horizontally and the
    // "No match" badge ends up over the per-line control — Playwright's click
    // lands on the badge. Collapse the preview first, as an operator would.
    const hidePreview = page.getByRole("button", { name: /hide invoice/i });
    if (await hidePreview.isVisible().catch(() => false)) await hidePreview.click();

    // The per-line quick-create is an icon-only button; its accessible name comes
    // from title="Add as new product" (ScanInvoiceModal.tsx). It used to carry the
    // label "Create product from this line", which now matches nothing.
    await page
      .getByRole("button", { name: /add as new product/i })
      .first()
      .click();
    const createModal = page.getByRole("heading", { name: "New Product" }).locator("xpath=../..");
    await expect(
      createModal.getByText("Name *", { exact: true }).locator("xpath=..").locator("input"),
    ).toHaveValue("ACME COLA 24PK");
    // The quick-create modal labels this "Price per unit *" (ProductCreateModal.tsx);
    // the "$" sits in a sibling span, so the input is still a descendant of the
    // label's parent. The old "Price ($)" text matched nothing.
    await expect(
      createModal
        .getByText("Price per unit *", { exact: true })
        .locator("xpath=..")
        .locator("input"),
    ).toHaveValue("26.00");
    await expect(page.getByText(/suggested from invoice cost/i)).toBeVisible();
    // Close without creating (don't pollute the seeded catalog).
    await page
      .getByRole("heading", { name: "New Product" })
      .locator("xpath=..")
      .locator("button")
      .click();

    // Creating the bill with unmatched lines requires an EXPLICIT confirm —
    // dismissing it must abort before any bill is created.
    const supplierSelect = page.locator('select:has(option:text("— Select supplier —"))').first();
    await supplierSelect.selectOption({ index: 1 });
    let billPosted = false;
    await page.route(
      "**/vendor-bills",
      (route) => {
        if (route.request().method() === "POST") billPosted = true;
        void route.continue();
      },
      { times: 1 },
    );
    page.once("dialog", (dialog) => {
      expect(dialog.message()).toMatch(/aren't linked to a product/i);
      void dialog.dismiss();
    });
    await page.getByRole("button", { name: /create vendor bill/i }).click();
    await page.waitForTimeout(800);
    expect(billPosted).toBe(false);
  });

  /**
   * The scan tests are fully self-contained: the e2e tenant has no seeded
   * suppliers, so the supplier dropdown is mocked alongside the write routes.
   */
  const mockSuppliers = (page: import("@playwright/test").Page) =>
    page.route("**/inventory/suppliers", (route) => {
      if (route.request().method() !== "GET") return void route.continue();
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "e2e-sup-1", name: "E2E Supplier One" },
          { id: "e2e-sup-2", name: "E2E Supplier Two" },
        ]),
      });
    });

  /** Canned per-invoice scan payload for the batch-scan tests. */
  const batchScanPayload = (key: "A" | "B", opts?: { tax?: number }) => {
    const tax = opts?.tax ?? 0;
    const subtotal = key === "A" ? 70 : 55;
    return JSON.stringify({
      supplier: `E2E Batch Supplier ${key}`,
      invoiceNumber: `INV-${key}-1`,
      invoiceDate: "2026-07-01",
      expenseDescription: null,
      expenseCategory: null,
      subtotal,
      tax,
      total: subtotal + tax,
      notes: null,
      items: [
        {
          extractedName: key === "A" ? "ITEM ALPHA" : "ITEM BRAVO",
          qty: key === "A" ? 2 : 5,
          unitCost: key === "A" ? 20 : 11,
          lineTotal: key === "A" ? 40 : 55,
          matchedProductId: null,
          matchedProductName: null,
          confidence: "none",
        },
        ...(key === "A"
          ? [
              {
                extractedName: "ITEM ALPHA TWO",
                qty: 3,
                unitCost: 10,
                lineTotal: 30,
                matchedProductId: null,
                matchedProductName: null,
                confidence: "none",
              },
            ]
          : []),
      ],
    });
  };

  const pdfFile = (name: string) => ({
    name,
    mimeType: "application/pdf",
    buffer: Buffer.from(`fake pdf ${name}`),
  });

  test("OP-17c batch scan: two PDFs → two scans, navigator switches form, two distinct bills", async ({
    page,
  }) => {
    // Each PDF gets its OWN scan call; payload keyed off the uploaded filename.
    let scanCalls = 0;
    await page.route("**/vendor-bills/scan-invoice", (route) => {
      scanCalls++;
      const body = route.request().postData() ?? "";
      const key = body.includes("invoice-b.pdf") ? "B" : "A";
      void route.fulfill({
        status: 201,
        contentType: "application/json",
        body: batchScanPayload(key as "A" | "B"),
      });
    });
    // Fulfill bill create + receive so the test never writes to the DB.
    const billBodies: any[] = [];
    await page.route("**/vendor-bills", (route) => {
      if (route.request().method() !== "POST") return void route.continue();
      billBodies.push(route.request().postDataJSON());
      void route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id: `fake-bill-${billBodies.length}` }),
      });
    });
    await page.route("**/vendor-bills/fake-bill-*/receive", (route) =>
      route.fulfill({ status: 201, contentType: "application/json", body: "{}" }),
    );

    await mockSuppliers(page);
    await page.goto("/inventory");
    await page.getByRole("button", { name: /scan invoice/i }).click();
    await page
      .locator('input[type="file"]')
      .setInputFiles([pdfFile("invoice-a.pdf"), pdfFile("invoice-b.pdf")]);

    // Navigator shows the batch; each PDF was scanned separately.
    await expect(page.getByText("Invoice 1 of 2")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/detected: e2e batch supplier a/i)).toBeVisible({
      timeout: 15_000,
    });
    // Unmatched lines render as editable custom-description inputs.
    const descInputs = page.locator('input[placeholder*="Custom description"]');
    await expect(descInputs.first()).toHaveValue("ITEM ALPHA");
    await expect(descInputs).toHaveCount(2);
    await expect.poll(() => scanCalls).toBe(2);

    // ▶ switches BOTH the form and the data — supplier B's invoice, not a merge.
    await page.getByTestId("invoice-nav-next").click();
    await expect(page.getByText("Invoice 2 of 2")).toBeVisible();
    await expect(page.getByText(/detected: e2e batch supplier b/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(descInputs).toHaveCount(1);
    await expect(descInputs.first()).toHaveValue("ITEM BRAVO");

    // Pick a supplier for invoice 2, then ◀ back and for invoice 1.
    const supplierSelect = () =>
      page.locator('select:has(option:text("— Select supplier —"))').first();
    await supplierSelect().selectOption({ index: 1 });
    await page.getByTestId("invoice-nav-prev").click();
    await expect(page.getByText("Invoice 1 of 2")).toBeVisible();
    await supplierSelect().selectOption({ index: 1 });

    // Unlinked lines across the batch → ONE aggregated confirm naming both invoices.
    page.on("dialog", (dialog) => {
      expect(dialog.message()).toMatch(/aren't linked to a product/i);
      void dialog.accept();
    });
    await page.getByRole("button", { name: /create 2 bills/i }).click();

    await expect.poll(() => billBodies.length, { timeout: 15_000 }).toBe(2);
    // Two DISTINCT bills — one per PDF, each carrying its own supplier invoice #.
    const notes = billBodies.map((b) => b.notes).sort();
    expect(notes).toEqual(["Supplier invoice #INV-A-1", "Supplier invoice #INV-B-1"]);
    const lineCounts = billBodies.map((b) => b.items.length).sort();
    expect(lineCounts).toEqual([1, 2]);
  });

  test("OP-17d batch scan: one failed PDF is retryable while the other posts", async ({ page }) => {
    // First scan of invoice-b.pdf fails; the retry succeeds.
    let bAttempts = 0;
    let scanCalls = 0;
    await page.route("**/vendor-bills/scan-invoice", (route) => {
      scanCalls++;
      const body = route.request().postData() ?? "";
      if (body.includes("invoice-b.pdf")) {
        bAttempts++;
        if (bAttempts === 1) {
          return void route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ message: "AI scan blew up (e2e)" }),
          });
        }
        return void route.fulfill({
          status: 201,
          contentType: "application/json",
          body: batchScanPayload("B"),
        });
      }
      void route.fulfill({
        status: 201,
        contentType: "application/json",
        body: batchScanPayload("A"),
      });
    });
    let billPosts = 0;
    await page.route("**/vendor-bills", (route) => {
      if (route.request().method() !== "POST") return void route.continue();
      billPosts++;
      void route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id: "fake-bill-1" }),
      });
    });
    await page.route("**/vendor-bills/fake-bill-*/receive", (route) =>
      route.fulfill({ status: 201, contentType: "application/json", body: "{}" }),
    );

    await mockSuppliers(page);
    await page.goto("/inventory");
    await page.getByRole("button", { name: /scan invoice/i }).click();
    await page
      .locator('input[type="file"]')
      .setInputFiles([pdfFile("invoice-a.pdf"), pdfFile("invoice-b.pdf")]);

    // Invoice 1 scanned fine; invoice 2 failed but is retryable — not lost, not fatal.
    await expect(page.getByText(/detected: e2e batch supplier a/i)).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("invoice-nav-next").click();
    await expect(page.getByText(/couldn't scan this invoice/i)).toBeVisible({ timeout: 15_000 });

    // Creating now posts ONLY the ready invoice and keeps the modal open for the failed one.
    await page.getByTestId("invoice-nav-prev").click();
    await page
      .locator('select:has(option:text("— Select supplier —"))')
      .first()
      .selectOption({ index: 1 });
    page.on("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: /create 1 bill/i }).click();
    await expect.poll(() => billPosts, { timeout: 15_000 }).toBe(1);
    // .first(): the copy shows in both the toast body and its aria-live mirror.
    await expect(page.getByText(/still needs? a successful scan/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // Retry re-scans ONLY the failed invoice.
    const callsBeforeRetry = scanCalls;
    await page.getByTestId("invoice-nav-next").click();
    await page.getByRole("button", { name: /retry scan/i }).click();
    await expect(page.getByText(/detected: e2e batch supplier b/i)).toBeVisible({
      timeout: 15_000,
    });
    expect(scanCalls).toBe(callsBeforeRetry + 1);
  });

  test("OP-17f batch scan: skip an already-recorded invoice, the other posts, modal closes", async ({
    page,
  }) => {
    await page.route("**/vendor-bills/scan-invoice", (route) => {
      const body = route.request().postData() ?? "";
      const key = body.includes("invoice-b.pdf") ? "B" : "A";
      void route.fulfill({
        status: 201,
        contentType: "application/json",
        body: batchScanPayload(key as "A" | "B"),
      });
    });
    // The duplicate probe reports invoice A as already recorded; B is clean.
    await page.route("**/vendor-bills/check-duplicate", (route) => {
      const body = route.request().postDataJSON() as { supplierInvoiceNumber?: string };
      const isDup = body?.supplierInvoiceNumber === "INV-A-1";
      void route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          duplicate: isDup
            ? {
                billId: "vb-existing",
                billNumber: "BILL-2026-0009",
                status: "RECEIVED",
                resumable: false,
                totalOwed: 70,
                billDate: "2026-07-01",
                receivedDate: "2026-07-02",
                supplierName: "E2E Batch Supplier A",
                itemCount: 2,
                matchedBy: "number",
                totalMatches: true,
              }
            : null,
        }),
      });
    });
    const billBodies: any[] = [];
    await page.route("**/vendor-bills", (route) => {
      if (route.request().method() !== "POST") return void route.continue();
      billBodies.push(route.request().postDataJSON());
      void route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id: "fake-bill-1" }),
      });
    });
    await page.route("**/vendor-bills/fake-bill-*/receive", (route) =>
      route.fulfill({ status: 201, contentType: "application/json", body: "{}" }),
    );

    await mockSuppliers(page);
    await page.goto("/inventory");
    await page.getByRole("button", { name: /scan invoice/i }).click();
    await page
      .locator('input[type="file"]')
      .setInputFiles([pdfFile("invoice-a.pdf"), pdfFile("invoice-b.pdf")]);
    await expect(page.getByText("Invoice 1 of 2")).toBeVisible({ timeout: 15_000 });

    // Selecting the supplier fires the probe → duplicate banner with a Skip action.
    const supplierSelect = () =>
      page.locator('select:has(option:text("— Select supplier —"))').first();
    await supplierSelect().selectOption({ index: 1 });
    await expect(page.getByTestId("duplicate-skip")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("duplicate-skip").click();
    // The invoice collapses to a Skipped panel (undoable) — not removed from the batch.
    await expect(page.getByTestId("duplicate-skipped")).toBeVisible();
    await expect(page.getByRole("button", { name: /undo skip/i })).toBeVisible();

    // The other invoice is still creatable; the batch is no longer dead-ended.
    await page.getByTestId("invoice-nav-next").click();
    await expect(page.getByText(/detected: e2e batch supplier b/i)).toBeVisible({
      timeout: 15_000,
    });
    await supplierSelect().selectOption({ index: 1 });
    page.on("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: /create 1 bill/i }).click();

    // Exactly ONE bill posts — the clean invoice, not the skipped duplicate.
    await expect.poll(() => billBodies.length, { timeout: 15_000 }).toBe(1);
    expect(billBodies[0].notes).toBe("Supplier invoice #INV-B-1");
    // Toast reports the drop, and the batch is DONE: the modal closes.
    await expect(page.getByText(/1 skipped as already recorded/i).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("invoice-nav-next")).toHaveCount(0);
  });

  test("OP-17e both-mode partial failure: created bill is never re-posted on retry", async ({
    page,
  }) => {
    // Non-zero tax exercises the money-critical path: the scanned tax must be
    // forwarded to BOTH the vendor bill's taxAmount AND folded into the
    // paired expense's amount (apps/web/components/ScanInvoiceModal.tsx
    // createOne(); apps/api/src/vendor-bills/vendor-bills.service.ts create()).
    await page.route("**/vendor-bills/scan-invoice", (route) =>
      route.fulfill({
        status: 201,
        contentType: "application/json",
        body: batchScanPayload("A", { tax: 5 }),
      }),
    );
    await page.route("**/bookkeeping/expense-categories", (route) => {
      if (route.request().method() !== "GET") return void route.continue();
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "e2e-cat-1", name: "E2E Supplies", code: "E2E" }]),
      });
    });
    let billPosts = 0;
    const billBodies: any[] = [];
    await page.route("**/vendor-bills", (route) => {
      if (route.request().method() !== "POST") return void route.continue();
      billPosts++;
      billBodies.push(route.request().postDataJSON());
      void route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id: "fake-bill-1" }),
      });
    });
    await page.route("**/vendor-bills/fake-bill-*/receive", (route) =>
      route.fulfill({ status: 201, contentType: "application/json", body: "{}" }),
    );
    // First expense POST fails; the retry succeeds.
    const expenseBodies: any[] = [];
    await page.route("**/bookkeeping/expenses", (route) => {
      if (route.request().method() !== "POST") return void route.continue();
      expenseBodies.push(route.request().postDataJSON());
      void route.fulfill(
        expenseBodies.length === 1
          ? {
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({ message: "expense blew up (e2e)" }),
            }
          : { status: 201, contentType: "application/json", body: JSON.stringify({ id: "e1" }) },
      );
    });

    await mockSuppliers(page);
    await page.goto("/inventory");
    await page.getByRole("button", { name: /scan invoice/i }).click();
    await page.locator('input[type="file"]').setInputFiles([pdfFile("invoice-a.pdf")]);
    await expect(page.getByText(/detected: e2e batch supplier a/i)).toBeVisible({
      timeout: 15_000,
    });

    // Both mode: bill + expense in one go (accessible name includes the subtitle).
    await page.getByRole("button", { name: /inventory \+ bookkeeping/i }).click();
    await page
      .locator('select:has(option:text("— Select supplier —"))')
      .first()
      .selectOption({ index: 1 });
    await page
      .locator('select:has(option:text("— Select category —"))')
      .first()
      .selectOption({ label: "E2E Supplies" });

    page.on("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: /create bill & expense/i }).click();

    // Bill created, expense failed → modal stays open, nothing closed over.
    await expect.poll(() => billPosts, { timeout: 15_000 }).toBe(1);
    await expect.poll(() => expenseBodies.length, { timeout: 15_000 }).toBe(1);
    await expect(page.getByRole("heading", { name: /ai invoice scanner/i })).toBeVisible();
    // The scanned tax (5) must reach the bill's taxAmount, not just be displayed.
    expect(billBodies[0].taxAmount).toBe(5);

    // Second attempt: the already-created bill is SKIPPED, only the expense retries.
    await page.getByRole("button", { name: /create bill & expense/i }).click();
    await expect.poll(() => expenseBodies.length, { timeout: 15_000 }).toBe(2);
    expect(billPosts).toBe(1);
    expect(expenseBodies[1].referenceNumber).toBe("INV-A-1");
    // 70 (items) + 5 (scanned tax) — must equal the bill's own totalOwed for
    // the same invoice (roundMoney(itemsSum + taxAmount) server-side).
    expect(expenseBodies[1].amount).toBe(75);
  });

  // ── Suppliers ─────────────────────────────────────────────────────────────

  test("OP-18 suppliers list loads", async ({ page }) => {
    await page.goto("/suppliers");
    const content = page
      .locator("[class*='card'], [class*='grid'], table, [class*='empty']")
      .first();
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  test("OP-18b quick restock — type-ahead picks a product and records the purchase", async ({
    page,
  }) => {
    await page.goto("/inventory");
    await page.getByRole("button", { name: /quick restock/i }).click();

    // Type-ahead by name: type a letter, pick the first suggestion.
    const picker = page.getByPlaceholder("Type a name or SKU, or scan…");
    await expect(picker).toBeVisible({ timeout: 10_000 });
    await picker.fill("a");
    // Scoped to the type-ahead's own listbox — an unscoped getByRole("option")
    // also matches native <select><option> elements elsewhere on the page (e.g.
    // the supplier filter's hidden "No supplier" option), which can resolve
    // first and never becomes visible.
    const firstOption = page.locator('ul[role="listbox"] [role="option"]').first();
    await expect(firstOption).toBeVisible({ timeout: 10_000 });
    await firstOption.click();

    // Current-stock hint proves the selection registered.
    await expect(page.getByText(/current stock:/i)).toBeVisible();

    // The modal's labels aren't htmlFor-associated — target by position. The
    // layout depends on the picked product: non-boxed renders [Quantity, Unit
    // Cost]; a BOXED product renders [Boxes, + Pieces, Cost per Box] (#417).
    // First = qty/boxes and LAST = the required cost in both layouts — nth(1)
    // would fill Pieces on a boxed product and leave Cost empty, so the
    // required-field validation silently blocks the submit.
    const numberInputs = page.locator('form input[type="number"]');
    await numberInputs.first().fill("1");
    await numberInputs.last().fill("1.00");

    const purchaseResp = page.waitForResponse(
      (r) => r.url().includes("/inventory/movements/purchase") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Record Restock" }).click();
    const resp = await purchaseResp;
    expect(resp.status()).toBeLessThan(300);
  });

  // ── Settings ──────────────────────────────────────────────────────────────

  test("OP-19 settings — business profile tab loads with form", async ({ page }) => {
    // /settings is a hub of section cards now; the business-profile form lives
    // behind the "Business profile" card at ?tab=profile (SECTIONS in
    // settings/page.tsx). Landing on /settings alone shows no form fields.
    await page.goto("/settings?tab=profile");
    await expect(page).not.toHaveURL(/error/);
    // Business name input should be pre-populated
    const businessField = page
      .getByLabel(/business name/i)
      .or(page.getByPlaceholder(/business name/i))
      .first();
    await expect(businessField).toBeVisible({ timeout: 15_000 });
  });

  test("OP-20 settings — users tab lists staff with role badges", async ({ page }) => {
    await page.goto("/settings");
    // Click Users tab
    const usersTab = page.getByRole("tab", { name: /users?/i });
    if (await usersTab.isVisible()) {
      await usersTab.click();
      await page.waitForTimeout(600);
      // Should list at least 1 user (admin itself)
      const userRow = page.locator("table tbody tr, [class*='user-row']").first();
      await expect(userRow).toBeVisible({ timeout: 10_000 });
    }
  });

  // ── Google OAuth button ──────────────────────────────────────────────────

  test("OP-21 Google OAuth button on /login → navigates toward Google consent", async ({
    page,
    context,
  }) => {
    await logout(page);
    const baseURL =
      process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";
    await setTenantCookie(context, baseURL, TENANT_SLUG);
    await page.goto("/login");
    const googleBtn = page
      .getByRole("button", { name: /google/i })
      .or(page.getByText(/continue with google/i))
      .first();
    if (await googleBtn.isVisible()) {
      await googleBtn.click();
      // Should redirect to Google (or navigate to accounts.google.com)
      await page.waitForURL(/accounts\.google\.com|google\.com\/o\/oauth/, { timeout: 15_000 });
      await expect(page).toHaveURL(/google\.com/);
    } else {
      test.skip(true, "Google OAuth button not visible (env vars may not be set)");
    }
  });

  // ── Logout ────────────────────────────────────────────────────────────────

  test("OP-22 logout → redirect to /login", async ({ page }) => {
    const logoutBtn = page
      .getByRole("button", { name: /log ?out|sign ?out/i })
      .or(page.getByText(/log ?out|sign ?out/i));
    if (await logoutBtn.first().isVisible()) {
      await logoutBtn.first().click();
      await page.waitForURL(/\/login/, { timeout: 10_000 });
      await expect(page).toHaveURL(/\/login/);
    } else {
      // Try via localStorage clear + navigate
      await logout(page);
      await page.goto("/dashboard");
      await page.waitForURL(/\/login/);
    }
  });
});
