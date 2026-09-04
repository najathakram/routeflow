/**
 * F13 — recurring invoices + standing orders: template edit, item edit, and
 * the rendered run outcome (B09 / B92 / B106 web leg).
 *
 * REG-B09 — the Edit Standing Order modal on the customer page silently
 * dropped item adds/qty changes: the PATCH it sent never carried `items`, so
 * the server accepted a 200 and changed nothing. `order-templates.service.ts`
 * `update()` now takes `items` and replaces them in a `tenantTransaction`.
 *
 * REG-B92 — `PATCH /recurring-invoices/:id` had no DTO, so the endpoint
 * silently accepted (and ignored, under the global `whitelist` pipe) any
 * body shape; there was also no page to reach it from. `update()` is now
 * validated by `UpdateRecurringInvoiceDto`, and `/invoices/recurring/[id]/edit`
 * is a real page every list card's "Edit" button links to.
 *
 * REG-B106 (web leg) — a MONTHLY recurring invoice now records whether its
 * last cycle succeeded or failed (`recurring-invoices.service.ts`
 * `generateInvoiceFromTemplate`); this proves the SUCCESS half renders on the
 * list card as the "Succeeded" pill after Run Now. The FAILED half and the
 * claim/rollback mechanics are jest-proven in `apps/api` — a web spec has no
 * way to force a create failure against the deployed API.
 *
 * T2, proven-pending-deploy (test-plan.md): these run against the DEPLOYED
 * site only, are NOT part of F13's jest red gate (there is no web unit
 * runner behind a rendered page/toast), and are expected red against a
 * pre-F13 build — a missing Edit control, a 404'd edit route, a PATCH that
 * drops items, or an unrendered pill are exactly the regressions this file
 * exists to catch, with no self-skip on any of them.
 *
 * ⚠️ Per test-plan.md, NEVER run `npx playwright test` for this file in any
 * form — not even `--list`. It clobbers `.campaign/runs/web-e2e.json`. The
 * spec is typechecked by `apps/web`'s `tsc --noEmit` and executed only by
 * the deploy-signal pipeline.
 *
 * Role: OPERATOR (reads its token out of the pre-authenticated session, same
 * as 21-destructive-guards / 22-payment-truth / 24-order-edit-pricing /
 * 27-cancelled-edit-banner). Tenant: the approved e2e-routeflow regression
 * seed — never a live client (enforced by helpers/constants.ts's
 * assertTestTenant at import time).
 *
 * Fixtures: throwaway `E2E B09 …` (customer + 2 products + standing-order
 * template) and `E2E B92 …` (customer + recurring template) rows on the seed
 * tenant, each named with a `Date.now()` suffix so parallel runs never
 * collide. The B09 test API-deletes its template in a `finally`. The B92
 * template is created with `nextRunAt` far in 2099 so a leaked row can never
 * fire the midnight cron; the B92/B106 pair below shares that one template
 * (edited by the first test, run by the second — this file runs its tests
 * serially in one worker per `playwright.config.ts`'s `fullyParallel: false`)
 * and the SECOND test's `finally` voids the Run Now invoice and deletes the
 * template, covering both. Net tenant state on a green run: an unused
 * customer + products left behind, the same residue tolerance specs
 * 21/22/24/27 already take.
 */

import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

/** A generated invoice's URL, matched on the UUID id shape (`Invoice.id` is `@default(uuid())`).
 * A looser `/invoices/<anything>` pattern is satisfied by the `/invoices/recurring` list page the
 * Run Now test already stands on, so it would resolve before the `router.push` and capture the
 * literal "recurring" as the id. */
const INVOICE_URL_RE =
  /\/invoices\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Bearer + tenant headers for a direct API call, or null when unauthenticated. */
async function apiHeaders(
  page: Page,
): Promise<{ authorization: string; "x-tenant-slug": string } | null> {
  const token = await operatorAccessToken(page);
  if (!token) return null;
  return { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
}

/** Hydration entry wait — the same signal every other operator-role spec in this suite uses
 * before touching localStorage or the API. */
async function waitForHydration(page: Page): Promise<void> {
  await page.goto("/orders");
  await expect(page.getByRole("button", { name: "New Order" })).toBeVisible({ timeout: 15_000 });
}

test.describe("Recurring template edit + standing-order item edit (F13)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("REG-B09 the Edit Standing Order modal persists item adds and qty changes through the templates PATCH (R22 / T28)", async ({
    page,
    request,
  }) => {
    await waitForHydration(page);

    const headers = await apiHeaders(page);
    // Hard failure, never a skip: a missing token is a stale operator
    // storageState or a setup project that did not run — an environment fault.
    expect(
      headers,
      "no operator access token in localStorage — operator storageState is stale or the setup project did not run",
    ).toBeTruthy();
    const api = apiBase(page.url());
    const suffix = Date.now();

    // ── Fixture 1: a throwaway customer.
    const customerRes = await request.post(`${api}/api/v1/customers`, {
      headers: headers!,
      data: {
        username: `e2e_b09_${suffix}`,
        businessName: `E2E B09 Rota Co ${suffix}`,
        contactName: "E2E Tester",
      },
    });
    expect(customerRes.ok(), `POST /customers returned ${customerRes.status()}`).toBe(true);
    const customer: { id: string } = (await customerRes.json()).customer;
    expect(customer?.id, "POST /customers response carried no customer.id").toBeTruthy();

    // ── Fixture 2: two throwaway products — Bolt starts on the template, Nut is
    // added through the modal.
    const boltName = `E2E B09 Bolt ${suffix}`;
    const nutName = `E2E B09 Nut ${suffix}`;
    const boltRes = await request.post(`${api}/api/v1/products`, {
      headers: headers!,
      data: { name: boltName, unit: "unit", pricePerUnit: "5.00" },
    });
    expect(boltRes.ok(), `POST /products (Bolt) returned ${boltRes.status()}`).toBe(true);
    const bolt: { id: string } = await boltRes.json();
    expect(bolt?.id, "POST /products (Bolt) response carried no id").toBeTruthy();

    const nutRes = await request.post(`${api}/api/v1/products`, {
      headers: headers!,
      data: { name: nutName, unit: "unit", pricePerUnit: "3.00" },
    });
    expect(nutRes.ok(), `POST /products (Nut) returned ${nutRes.status()}`).toBe(true);
    const nut: { id: string } = await nutRes.json();
    expect(nut?.id, "POST /products (Nut) response carried no id").toBeTruthy();

    // ── Fixture 3: the standing-order template, Bolt x1.
    const templateName = `E2E B09 Weekly ${suffix}`;
    const templateRes = await request.post(`${api}/api/v1/order-templates`, {
      headers: headers!,
      data: {
        customerId: customer.id,
        name: templateName,
        daysOfWeek: [1],
        items: [{ productId: bolt.id, qty: 1 }],
      },
    });
    expect(templateRes.ok(), `POST /order-templates returned ${templateRes.status()}`).toBe(true);
    const template: { id: string } = await templateRes.json();
    expect(template?.id, "POST /order-templates response carried no id").toBeTruthy();

    try {
      await page.goto(`/customers/${customer.id}`);
      await page.getByRole("tab", { name: /Standing Orders/ }).click();

      const row = page.locator("li").filter({ hasText: templateName });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.getByRole("button", { name: "Edit template" }).click();

      const modal = page.getByRole("dialog").filter({ hasText: "Edit Standing Order" });
      await expect(modal).toBeVisible({ timeout: 15_000 });

      // Add Nut through the search dropdown.
      await modal.getByPlaceholder("Search products to add…").fill(nutName);
      await modal.getByRole("button", { name: new RegExp(nutName) }).click();

      // Bump Bolt to qty 2 via its row's "+" button.
      const boltLine = modal.locator("li").filter({ hasText: boltName });
      await expect(boltLine).toBeVisible({ timeout: 15_000 });
      await boltLine.getByRole("button", { name: "+", exact: true }).click();

      await modal.getByRole("button", { name: "Save Changes" }).click();
      await expect(page.getByText("Standing order updated")).toBeVisible({ timeout: 15_000 });

      // ── The API is the oracle for what persisted (order-free match by productId).
      const verifyRes = await request.get(`${api}/api/v1/order-templates/${template.id}`, {
        headers: headers!,
      });
      expect(verifyRes.ok(), `GET /order-templates/:id returned ${verifyRes.status()}`).toBe(true);
      const persisted: { items: { productId: string; qty: number }[] } = await verifyRes.json();
      const boltItem = persisted.items.find((it) => it.productId === bolt.id);
      const nutItem = persisted.items.find((it) => it.productId === nut.id);
      expect(boltItem?.qty, "persisted Bolt qty").toBe(2);
      expect(nutItem?.qty, "persisted Nut qty").toBe(1);
    } finally {
      await request
        .delete(`${api}/api/v1/order-templates/${template.id}`, { headers: headers! })
        .catch(() => undefined);
    }
  });

  // ── T32 / T33 share one throwaway recurring template: T32 edits it, T33 runs
  // it and reads the rendered outcome, then cleans both up. `fullyParallel:
  // false` (playwright.config.ts) keeps this file's tests serial in one
  // worker, so this closure state is safe.
  let sharedTemplateId: string | undefined;
  let sharedCustomerName: string | undefined;

  test("REG-B92 the recurring-template edit page persists a schedule and notes change through the validated PATCH (R26, R27 / T32)", async ({
    page,
    request,
  }) => {
    await waitForHydration(page);

    const headers = await apiHeaders(page);
    expect(
      headers,
      "no operator access token in localStorage — operator storageState is stale or the setup project did not run",
    ).toBeTruthy();
    const api = apiBase(page.url());
    const suffix = Date.now();

    // ── Fixture: a throwaway customer + MONTHLY recurring template, inert
    // (nextRunAt in 2099) so a leaked row can never fire the midnight cron.
    const businessName = `E2E B92 Cadence Co ${suffix}`;
    const customerRes = await request.post(`${api}/api/v1/customers`, {
      headers: headers!,
      data: { username: `e2e_b92_${suffix}`, businessName, contactName: "E2E Tester" },
    });
    expect(customerRes.ok(), `POST /customers returned ${customerRes.status()}`).toBe(true);
    const customer: { id: string } = (await customerRes.json()).customer;
    expect(customer?.id, "POST /customers response carried no customer.id").toBeTruthy();

    const templateRes = await request.post(`${api}/api/v1/recurring-invoices`, {
      headers: headers!,
      data: {
        customerId: customer.id,
        frequency: "MONTHLY",
        dayOfMonth: 15,
        nextRunAt: "2099-01-15T00:00:00.000Z",
        autoSend: false,
        items: [{ description: "E2E B92 line", qty: 1, unitPrice: 10 }],
      },
    });
    expect(templateRes.ok(), `POST /recurring-invoices returned ${templateRes.status()}`).toBe(
      true,
    );
    const template: { id: string } = await templateRes.json();
    expect(template?.id, "POST /recurring-invoices response carried no id").toBeTruthy();
    sharedTemplateId = template.id;
    sharedCustomerName = businessName;

    await page.goto("/invoices/recurring");
    const card = page.locator(".shadow-card").filter({ hasText: businessName });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.getByRole("link", { name: "Edit" }).click();

    await expect(page).toHaveURL(new RegExp(`/invoices/recurring/${template.id}/edit`));
    await expect(page.getByRole("heading", { name: "Edit Recurring Template" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(businessName)).toBeVisible();

    const frequencyField = page
      .locator("div")
      .filter({ has: page.getByText("Frequency", { exact: true }) })
      .locator("select")
      .first();
    await frequencyField.selectOption("WEEKLY");

    const notesField = page
      .locator("div")
      .filter({ has: page.getByText("Notes", { exact: true }) })
      .locator("textarea")
      .first();
    await notesField.fill("E2E B92 edited");

    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText("Recurring template updated")).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/invoices\/recurring$/, { timeout: 15_000 });

    const verifyRes = await request.get(`${api}/api/v1/recurring-invoices/${template.id}`, {
      headers: headers!,
    });
    expect(verifyRes.ok(), `GET /recurring-invoices/:id returned ${verifyRes.status()}`).toBe(true);
    const persisted: { frequency: string; notes: string; items: unknown[] } =
      await verifyRes.json();
    expect(persisted.frequency).toBe("WEEKLY");
    expect(persisted.notes).toBe("E2E B92 edited");
    expect(persisted.items.length).toBe(1);
  });

  test("REG-B106 web leg — after Run Now the recurring-template card shows the recorded Succeeded outcome (R16 / T33)", async ({
    page,
    request,
  }) => {
    // Hard failure, never a skip: T32 must have run first and succeeded in
    // this same worker (fullyParallel: false) — a missing id here is an
    // environment/ordering fault, not "nothing to test".
    expect(
      sharedTemplateId,
      "the REG-B92 test did not leave a shared template id — it must run first and succeed",
    ).toBeTruthy();
    const templateId = sharedTemplateId!;
    const businessName = sharedCustomerName!;

    await waitForHydration(page);

    const headers = await apiHeaders(page);
    expect(
      headers,
      "no operator access token in localStorage — operator storageState is stale or the setup project did not run",
    ).toBeTruthy();
    const api = apiBase(page.url());

    let invoiceId: string | undefined;
    try {
      await page.goto("/invoices/recurring");
      const card = page.locator(".shadow-card").filter({ hasText: businessName });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.getByRole("button", { name: "Run Now" }).click();

      // Waits for the real `router.push(/invoices/<id>)` — staying on the list
      // page (the losing-racer branch, or a regressed Run Now) fails here
      // instead of passing vacuously, so the `finally` always has the id of any
      // invoice this run actually generated.
      await expect(page).toHaveURL(INVOICE_URL_RE, { timeout: 20_000 });
      invoiceId = page.url().match(INVOICE_URL_RE)?.[1];
      expect(invoiceId, "Run Now did not navigate to an invoice URL").toBeTruthy();

      await page.goto("/invoices/recurring");
      const cardAfterRun = page.locator(".shadow-card").filter({ hasText: businessName });
      await expect(cardAfterRun).toBeVisible({ timeout: 15_000 });
      await expect(cardAfterRun.getByText("Succeeded", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      if (invoiceId) {
        await request
          .post(`${api}/api/v1/invoices/${invoiceId}/void`, { headers: headers! })
          .catch(() => undefined);
      }
      await request
        .delete(`${api}/api/v1/recurring-invoices/${templateId}`, { headers: headers! })
        .catch(() => undefined);
    }
  });
});
