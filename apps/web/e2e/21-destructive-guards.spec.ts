/**
 * F02b — destructive-write guards on the web surfaces (P4).
 *
 * REG-B24  — products bulk delete confirms, reports a skipped guarded product
 *            by name, and the product-detail page's Delete action (previously
 *            declared but never wired to any control) works.
 * REG-B130 — customers bulk delete confirms (naming the selection) and, for a
 *            record-holding customer, soft-deletes instead of 409-ing into the
 *            failed[] breakdown (the server now passes force=true internally).
 * REG-B154 — the products list selection Set resets when the page/search/
 *            category/section filter changes, and AssignToSectionModal
 *            receives the FULL selection rather than its intersection with
 *            whatever page happens to be loaded.
 *
 * These specs are authored against the server contracts R1 (products
 * bulkDelete → {deleted, softDeleted, skipped[]}) and R5 (customers
 * batchDelete passes force=true) landed elsewhere in this same batch. They are
 * `proven-pending-deploy`: not run in this session, discharged by the
 * deploy-triggered Playwright run per the F02b test plan.
 *
 * Role: OPERATOR. Tenant: the approved e2e-routeflow regression seed (never a
 * live client — enforced by helpers/constants.ts's assertTestTenant at
 * import time). Fixtures created here (a throwaway product, a throwaway
 * customer + order) are named `E2E B2x …` so they read as disposable in any
 * admin view; the product one is hard-deleted again at the end of its test
 * (it is reference-free once created, so DELETE /products/bulk removes it
 * cleanly) — the customer fixture is left soft-deleted, which is the whole
 * point of the assertion and is itself harmless residue on a seed tenant.
 */

import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bearer + tenant headers for a direct API call, or null when unauthenticated. */
async function apiHeaders(
  page: Page,
): Promise<{ authorization: string; "x-tenant-slug": string } | null> {
  const token = await operatorAccessToken(page);
  if (!token) return null;
  return { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
}

interface ApiOrderLineItem {
  productId: string | null;
  // OrderItem.status is its OWN lifecycle field (ItemStatus), independent of
  // the parent Order's status — bulkDelete's guard checks THIS, not the
  // order's status, so discovery must too.
  status: string;
}
interface ApiOrder {
  id: string;
  lineItems?: ApiOrderLineItem[];
}
interface ApiProduct {
  id: string;
  name: string;
}

test.describe("Destructive-write guards (F02b / P4)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("REG-B24 Products bulk delete confirms, reports a skipped guarded product by name, and detail Delete works", async ({
    page,
    request,
  }) => {
    await page.goto("/products");
    // Page-ready = the toolbar's Select button, not a table row: the deployed
    // products page loads in CARD view (zero <table> elements — verified live
    // 2026-08-31), so a table-row wait can never succeed before the Table-view
    // toggle is clicked, and that toggle only works once React has hydrated.
    // The Select button is rendered by the same toolbar, so its visibility is
    // the hydration signal every later interaction needs.
    await expect(page.getByRole("button", { name: "Select", exact: true })).toBeVisible({
      timeout: 15_000,
    });

    const headers = await apiHeaders(page);
    test.skip(!headers, "No operator access token available in localStorage");
    const api = apiBase(page.url());

    // ── Part 1: a product with an active (non-DELIVERED/CANCELLED) order item
    // must be SKIPPED by a bulk delete, never destroyed — discovered rather
    // than provisioned, so this exercises whatever real order backlog the
    // seed tenant carries.
    // Send ONLY `limit`: ListOrdersDto declares no sort params and the global
    // ValidationPipe runs `forbidNonWhitelisted`, so a `sortBy`/`sortDir` pair
    // 400s the request. Nothing is lost — findAll already hardcodes
    // `orderBy: { createdAt: "desc" }`, which is the order we wanted anyway.
    const ordersRes = await request.get(`${api}/api/v1/orders`, {
      params: { limit: 100 },
      headers: headers!,
    });
    // Hard failure, never a skip: an unreadable /orders is a broken contract,
    // not a data condition, and skipping on it reports green while the whole
    // test body — including Part 2 below — silently never runs.
    expect(ordersRes.ok(), `GET /orders returned ${ordersRes.status()}`).toBe(true);
    const ordersBody: { data?: ApiOrder[] } = await ordersRes.json();
    const guardedItem = (ordersBody.data ?? [])
      .flatMap((o) => o.lineItems ?? [])
      .find((li) => li.productId && li.status !== "DELIVERED" && li.status !== "CANCELLED");
    const guardedProductId = guardedItem?.productId ?? null;
    test.skip(
      !guardedProductId,
      "No order item with an active (non-DELIVERED/CANCELLED) status against a catalog product found on this tenant — nothing to prove the skip-guard against",
    );

    const productRes = await request.get(`${api}/api/v1/products/${guardedProductId}`, {
      headers: headers!,
    });
    test.skip(!productRes.ok(), "Guarded product no longer resolves");
    const guardedProduct: ApiProduct = await productRes.json();

    // Isolate it via search so the selection is unambiguous regardless of
    // pagination (REG-B154 covers pagination/selection mechanics separately).
    await page.getByPlaceholder(/Name, SKU/i).fill(guardedProduct.name);
    await page.waitForURL(/[?&]search=/, { timeout: 5_000 }).catch(() => {});
    const guardedRow = page.locator("table tbody tr", { hasText: guardedProduct.name }).first();
    // Table view exposes a plain checkbox column, so selection doesn't depend
    // on the grid card's own "cursor-pointer" class (also present on the
    // selection checkbox once select mode is on).
    await page.getByTitle("Table view").click();
    await expect(guardedRow).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Select", exact: true }).click();
    // The row's own onClick is stopPropagation()'d by several cells (price,
    // category, SKU) — the row-select checkbox is the one target guaranteed
    // to toggle regardless of where the row's bounding-box center lands.
    await guardedRow.getByRole("checkbox").click();
    await expect(page.getByText("1 item selected")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /^Delete 1 item$/ }).click();

    const confirmDialog = page.getByRole("dialog");
    await expect(confirmDialog).toBeVisible({ timeout: 10_000 });
    await expect(confirmDialog.getByText(/Delete 1 product\?/i)).toBeVisible();
    await confirmDialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(confirmDialog).toHaveCount(0, { timeout: 10_000 });

    // Result toast reports the skip BY NAME (R1's {skipped: [{id, reason}]}
    // shape, where `reason` is built from the product's own name). Both
    // assertions are scoped to the toast itself: the search box is still
    // filtered to this product and the row was SKIPPED, so it is still on
    // screen — a page-wide name match would be satisfied by that table cell
    // even if the toast carried no description at all. The toast viewport is
    // Radix's `role="region"` labelled "Notifications (F8)"; each toast inside
    // it is a plain <li> (implicit role "listitem" — the installed
    // @radix-ui/react-toast puts role="status" only on its aria-live announcer,
    // which portals to <body>); scoping through the region still excludes that
    // announcer mirror, and "listitem" matches the visible toast itself.
    const resultToast = page
      .getByRole("region", { name: /notifications/i })
      .getByRole("listitem")
      .filter({ hasText: /skipped/i })
      .first();
    await expect(resultToast).toBeVisible({ timeout: 10_000 });
    await expect(resultToast).toContainText(new RegExp(escapeRegExp(guardedProduct.name)));

    // Nothing was destroyed: the product still resolves, unchanged.
    const afterRes = await request.get(`${api}/api/v1/products/${guardedProductId}`, {
      headers: headers!,
    });
    expect(afterRes.ok()).toBe(true);

    // ── Part 2: the product-detail page's Delete action (declared via
    // useDeleteProduct but never wired to any control before this batch).
    // A throwaway, reference-free product so the delete genuinely applies
    // (isActive:false) rather than tripping the same active-order guard.
    const createRes = await request.post(`${api}/api/v1/products`, {
      headers: headers!,
      data: {
        name: `E2E B24 Delete Target ${Date.now()}`,
        unit: "unit",
        pricePerUnit: "1.00",
      },
    });
    // Also a hard failure: this fixture is fully self-provisioned (name/unit/
    // pricePerUnit are CreateProductDto's only required fields), so a failure
    // is a broken fixture, and skipping on it would hide the detail-page
    // Delete proof behind a green run.
    expect(
      createRes.ok(),
      `POST /products returned ${createRes.status()} creating the detail-page Delete target`,
    ).toBe(true);
    const throwaway: ApiProduct = await createRes.json();

    await page.goto(`/products/${throwaway.id}`);
    // The product name renders as a heading in BOTH the sticky banner and the
    // page body — scope to main or strict mode fails on the double match.
    await expect(
      page.locator("#main-content").getByRole("heading", { name: throwaway.name }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    const detailConfirm = page.getByRole("dialog");
    await expect(detailConfirm).toBeVisible({ timeout: 10_000 });
    await detailConfirm.getByRole("button", { name: "Yes, delete", exact: true }).click();

    await page.waitForURL(/\/products(\?|$)/, { timeout: 15_000 });
    await expect(page.getByText("Product deleted").first()).toBeVisible({ timeout: 10_000 });

    // Best-effort cleanup: the throwaway is now isActive:false and reference-
    // free, so a bulk delete hard-removes it rather than leaving dead rows on
    // the shared seed tenant.
    await request
      .delete(`${api}/api/v1/products/bulk`, { headers: headers!, data: { ids: [throwaway.id] } })
      .catch(() => {});
  });

  test("REG-B130 Customers bulk delete confirms, names the selection, and soft-deletes a record-holding customer", async ({
    page,
    request,
  }) => {
    await page.goto("/customers");
    await expect(
      page
        .locator("table tbody tr")
        .first()
        .or(page.getByText(/no customers/i)),
    ).toBeVisible({ timeout: 15_000 });

    const headers = await apiHeaders(page);
    test.skip(!headers, "No operator access token available in localStorage");
    const api = apiBase(page.url());

    // A throwaway, deterministic "record-holding" customer: one PENDING order
    // (an unlisted line — no product needed) gives it `hasFinancialRecords`
    // without any PAID/SENT invoice, so the pre-flight in batchDelete never
    // blocks it — this is exactly the customer R5's force=true is for.
    const suffix = Date.now();
    const businessName = `E2E B130 Delete Target ${suffix}`;
    const customerRes = await request.post(`${api}/api/v1/customers`, {
      headers: headers!,
      data: {
        username: `e2e_b130_${suffix}`,
        businessName,
        contactName: "E2E Tester",
      },
    });
    // Hard failure, never a skip: this fixture is fully self-provisioned
    // (username/businessName/contactName are CreateCustomerDto's only required
    // fields), so a non-ok response is a broken fixture or an environment
    // condition — e.g. a tenant sitting over the customer soft cap — not a data
    // condition. Skipping there would discharge REG-B130, R5's only web-side
    // proof, on a run that executed none of its assertions.
    expect(customerRes.ok(), `POST /customers returned ${customerRes.status()}`).toBe(true);
    // POST /customers nests its result: { customer: {...}, ... } (verified live
    // 2026-08-31) — reading .id off the envelope yields undefined, and the
    // order POST below then 400s with "customerId is required".
    const customer: { id: string } = (await customerRes.json()).customer;
    expect(customer?.id, "POST /customers response carried no customer.id").toBeTruthy();

    const orderRes = await request.post(`${api}/api/v1/orders`, {
      headers: headers!,
      data: {
        customerId: customer.id,
        status: "PENDING",
        items: [{ name: "E2E B130 line", qty: 1, unitPrice: 1 }],
      },
    });
    // Same reasoning: an unlisted line ({name, qty, unitPrice}) is OrderItemDto's
    // own shape, so this order either creates or the contract is broken.
    expect(orderRes.ok(), `POST /orders returned ${orderRes.status()}`).toBe(true);

    await page.getByPlaceholder(/Name, business/i).fill(businessName);
    await page.waitForURL(/[?&]search=/, { timeout: 5_000 }).catch(() => {});
    const row = page.locator("table tbody tr", { hasText: businessName }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Select", exact: true }).click();
    await row.getByRole("checkbox").click();
    await expect(page.getByText("1 customer selected")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /^Delete 1$/ }).click();

    const confirmDialog = page.getByRole("dialog");
    await expect(confirmDialog).toBeVisible({ timeout: 10_000 });
    // ConfirmDialog names the selected customer, not just a bare count.
    await expect(confirmDialog.getByText(new RegExp(escapeRegExp(businessName)))).toBeVisible();
    await confirmDialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(confirmDialog).toHaveCount(0, { timeout: 10_000 });

    // No PAID/SENT invoice on this customer, so force=true takes the
    // soft-delete branch — the breakdown toast has nothing to report.
    await expect(page.getByText("1 customer deleted").first()).toBeVisible({ timeout: 10_000 });

    const afterRes = await request.get(`${api}/api/v1/customers/${customer.id}`, {
      headers: headers!,
    });
    expect(afterRes.ok()).toBe(true);
    const after: { deletedAt: string | null } = await afterRes.json();
    expect(after.deletedAt).not.toBeNull();
  });

  test("REG-B154 Products selection resets on filter change and Assign-to-type gets the full selection", async ({
    page,
    request,
  }) => {
    await page.goto("/products");
    // Same hydration signal as REG-B24: the Table-view toggle is inert until
    // React attaches its handler, and this test's first UI act is that click.
    await expect(page.getByRole("button", { name: "Select", exact: true })).toBeVisible({
      timeout: 15_000,
    });

    const headers = await apiHeaders(page);
    test.skip(!headers, "No operator access token available in localStorage");
    const api = apiBase(page.url());

    // Assign-to-type only renders for a tenant with regulated sections
    // configured — the e2e-routeflow seed carries them (09/19 already lean
    // on this), but skip cleanly rather than false-red on a tenant that doesn't.
    const sectionsRes = await request.get(`${api}/api/v1/tracked-categories`, {
      headers: headers!,
    });
    const sections: Array<{ id: string }> = sectionsRes.ok() ? await sectionsRes.json() : [];
    test.skip(sections.length === 0, "Tenant has no regulated sections configured");

    // ── Part 1: selecting on one filter view, then changing the search
    // filter, resets the selection Set instead of carrying it forward.
    await page.getByTitle("Table view").click();
    const rows = page.locator("table tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Select", exact: true }).click();
    const firstBatch = Math.min(3, await rows.count());
    test.skip(firstBatch === 0, "No products in the catalogue to select");
    for (let i = 0; i < firstBatch; i++) {
      // The checkbox is the one target guaranteed to toggle regardless of
      // where a bare row click would land (several cells stopPropagation()).
      await rows.nth(i).getByRole("checkbox").click();
    }
    await expect(
      page.getByText(`${firstBatch} item${firstBatch !== 1 ? "s" : ""} selected`),
    ).toBeVisible({ timeout: 10_000 });

    await page.getByPlaceholder(/Name, SKU/i).fill("zzz-e2e-nomatch-b154");
    await page.waitForURL(/[?&]search=/, { timeout: 5_000 }).catch(() => {});
    await expect(page.getByText(/items? selected/)).toHaveCount(0);

    // ── Part 2: with a fresh selection, AssignToSectionModal's count must
    // equal the FULL selection — not its intersection with whatever page
    // happened to be loaded (the bug this batch fixes).
    // Fresh navigation, NOT reload(): Part 1 left ?search=zzz-e2e-nomatch-b154
    // in the URL, and a reload restores that no-match filter — the table would
    // be legitimately empty forever. And any navigation restarts hydration, so
    // the inert-toggle wait applies again.
    await page.goto("/products");
    await expect(page.getByRole("button", { name: "Select", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTitle("Table view").click();
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Select", exact: true }).click();
    const secondBatch = Math.min(2, await rows.count());
    test.skip(secondBatch < 2, "Fewer than 2 products in the catalogue to select");
    for (let i = 0; i < secondBatch; i++) {
      await rows.nth(i).getByRole("checkbox").click();
    }
    await expect(
      page.getByText(`${secondBatch} item${secondBatch !== 1 ? "s" : ""} selected`),
    ).toBeVisible({ timeout: 10_000 });

    const assignButton = page.getByRole("button", { name: "Assign to type…" });
    await expect(assignButton).toBeVisible({ timeout: 10_000 });
    await assignButton.click();

    const heading = page.getByRole("heading", { name: "Assign to regulated type" });
    await expect(heading).toBeVisible({ timeout: 10_000 });
    const modal = heading.locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
    await expect(
      modal.getByText(`${secondBatch} product${secondBatch !== 1 ? "s" : ""} selected`),
    ).toBeVisible({ timeout: 10_000 });

    // Cancel — never submit; this spec proves the count, not the assignment.
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(heading).toHaveCount(0);
  });
});
