/**
 * B465 fix round 2 (Opus BLOCK item 2, client half) — a SPECIAL-tier line's
 * documented reason is REQUIRED before the order editor lets an operator save
 * an override, matching the server's own refusal ("A reason is required to
 * change a special-price line") and closing the mobile hunt's R2/R9 hole on
 * the web reference too.
 *
 * #815 proof-run finding (this test never actually ran until that proof —
 * see the "NOT part of the local red gate" note below): the reason-input
 * block rendered only on `overridden` (unitPrice vs `basePrice`, the LIST
 * price for a SPECIAL line), while `reasonRequired` compares against
 * `originalUnitPrice` (this session's own starting price) instead. Repricing
 * a SPECIAL line to EXACTLY the list price (test below: tier $8 -> list $20)
 * makes `overridden` false — hiding the reason field the server still 400s
 * without — even though `reasonRequired` stays true. This test's core
 * assertion (`reasonInput` visible after typing the list price) is the
 * regression pin for that render-gate fix (`overridden || reasonRequired`).
 *
 * Proof requested by the review: Playwright screenshots at 1440/768/390 of
 * the required-reason state (the reason input styled as required, Save
 * blocked with a toast naming the line).
 *
 * NOT part of the local red gate: like 24-order-edit-pricing.spec.ts (same
 * file, same rationale — apps/web has no unit runner for this page's
 * client-side logic), this runs against a live app instance only. Written
 * and self-contained in this fix round; execution (and the screenshots
 * themselves) happens on the deploy-triggered Playwright run or a
 * `npm run local:e2e` pass, per this suite's own established T15 precedent —
 * see that spec's header for the exact same "proven-pending-deploy" posture.
 *
 * Role: OPERATOR (pre-authenticated storageState, same as 24). Tenant: the
 * approved e2e-routeflow regression seed. Fixtures are fully self-provisioned
 * via the API — a throwaway customer (pricingTier 3) and a throwaway tiered
 * product, plus a DRAFT order carrying one line of it — addressed only by the
 * ids the API hands back (never "the first row" — the #556 lesson).
 */

import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
] as const;

async function apiHeaders(
  page: Page,
): Promise<{ authorization: string; "x-tenant-slug": string } | null> {
  const token = await operatorAccessToken(page);
  if (!token) return null;
  return { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
}

test.describe("Order-edit SPECIAL-tier reason required (B465 fix round 2)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("REG-B465-WEB / REG-B815-WEB: a SPECIAL-tier line's price override (including repriced to exactly list) requires a reason before Save, at 1440/768/390", async ({
    page,
    request,
  }) => {
    await page.goto("/orders");
    await expect(page.getByRole("button", { name: "New Order" })).toBeVisible({
      timeout: 15_000,
    });

    const headers = await apiHeaders(page);
    expect(
      headers,
      "no operator access token in localStorage — operator storageState is stale or the setup project did not run",
    ).toBeTruthy();
    const api = apiBase(page.url());
    const suffix = Date.now();

    // ── Fixture: a tiered product — priceTier3 distinct from list, so the
    // SPECIAL price ($8) and list ($20) are never confusable.
    const listPrice = 20.0;
    const tier3Price = 8.0;
    const productRes = await request.post(`${api}/api/v1/products`, {
      headers: headers!,
      data: {
        name: `E2E B465 Special ${suffix}`,
        unit: "unit",
        pricePerUnit: listPrice.toFixed(2),
        priceTier3: tier3Price.toFixed(2),
      },
    });
    expect(productRes.ok(), `POST /products returned ${productRes.status()}`).toBe(true);
    const product: { id: string; name: string } = await productRes.json();

    // ── Fixture: a tier-3 (SPECIAL) customer.
    const customerRes = await request.post(`${api}/api/v1/customers`, {
      headers: headers!,
      data: {
        username: `e2e_b465_${suffix}`,
        businessName: `E2E B465 Special-Tier Reason ${suffix}`,
        contactName: "E2E Tester",
        pricingTier: 3,
      },
    });
    expect(customerRes.ok(), `POST /customers returned ${customerRes.status()}`).toBe(true);
    const customer: { id: string } = (await customerRes.json()).customer;
    expect(customer?.id, "POST /customers response carried no customer.id").toBeTruthy();

    // ── Fixture: a DRAFT order carrying the SPECIAL line, priced correctly at
    // the tier ($8) from creation — the same line the operator will now try
    // to reprice with no reason.
    const orderRes = await request.post(`${api}/api/v1/orders`, {
      headers: headers!,
      data: {
        customerId: customer.id,
        status: "DRAFT",
        items: [{ productId: product.id, qty: 1 }],
      },
    });
    expect(orderRes.ok(), `POST /orders returned ${orderRes.status()}`).toBe(true);
    const order: { id: string } = await orderRes.json();
    expect(order?.id, "POST /orders response carried no id").toBeTruthy();

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`/orders/${order.id}`);

      const productName = page.getByText(product.name, { exact: true });
      await expect(productName).toBeVisible({ timeout: 15_000 });
      const lineRow = productName.locator(
        'xpath=ancestor::div[.//*[normalize-space(text())="Unit price"]][1]',
      );
      const unitPriceInput = lineRow
        .getByText("Unit price", { exact: true })
        .locator("xpath=..//input");
      // Sanity: the line really did resolve to the tier price, not list.
      await expect(unitPriceInput).toHaveValue(tier3Price.toFixed(2), { timeout: 10_000 });

      // ── Type a bare override with no reason (list price, the exact B465
      // hole: an operator-typed value with nothing on record explaining it).
      // This value is ALSO exactly `basePrice` for this line (server sets
      // originalPrice = list price for a SPECIAL-tier line) — the #815
      // render-gate finding: `overridden` (unitPrice vs basePrice) goes
      // FALSE the instant the typed price equals list, even though this is
      // still a genuine reprice relative to the session's own starting
      // value and the server still requires a reason.
      await unitPriceInput.fill(listPrice.toFixed(2));
      await unitPriceInput.blur();

      // REG-B815-WEB: the reason input must stay visible even though the
      // price now equals basePrice (list) — proving the render gate is
      // `overridden || reasonRequired`, never `overridden` alone.
      const reasonInput = lineRow.getByPlaceholder(/reason \(required\)/i);
      await expect(reasonInput).toBeVisible({ timeout: 10_000 });

      // ── Proof screenshot: the required-reason state, reason still blank.
      await page.screenshot({
        path: `local-assets/e2e/b465-special-tier-reason-required-${vp.name}.png`,
        fullPage: false,
      });

      // ── Save is refused client-side with no reason typed — never a 400
      // round-trip the operator has to decode. This order is DRAFT, so the
      // editor's own save control reads "Save Draft" (page.tsx's DRAFT
      // branch); a non-DRAFT order's equivalent is "Save Changes".
      const saveButton = page.getByRole("button", { name: "Save Draft", exact: true });
      await saveButton.click();
      const requiredReasonToast = page.getByText(
        new RegExp(`A reason is required to change ${product.name}`, "i"),
      );
      await expect(requiredReasonToast).toBeVisible({ timeout: 10_000 });

      // ── Typing a reason clears the required-reason state and a retried
      // save no longer trips the same client-side refusal.
      await reasonInput.fill("manager approved");
      await saveButton.click();
      await expect(requiredReasonToast).not.toBeVisible({ timeout: 10_000 });
    }
  });

  test("REG-B465-WEB-SUB: substituting into a SPECIAL-tier product needs no reason to save; Undo-ing the substitution sends no UPDATE for that line at all (B465 fix round 5)", async ({
    page,
    request,
  }) => {
    // Round-4 briefly reset originalUnitPrice (Undo's own restore point) to
    // the substitute's price at substitution time — Undo then "restored" the
    // substitute's own price instead of the pre-substitution one, silently
    // repricing the line on save. Round 5 uses a separate reasonBaselinePrice
    // for the reason-required check and leaves originalUnitPrice untouched.
    await page.goto("/orders");
    await expect(page.getByRole("button", { name: "New Order" })).toBeVisible({
      timeout: 15_000,
    });

    const headers = await apiHeaders(page);
    expect(
      headers,
      "no operator access token in localStorage — operator storageState is stale or the setup project did not run",
    ).toBeTruthy();
    const api = apiBase(page.url());
    const suffix = Date.now();

    // ── Fixture: an ordinary (non-special) starting product for the line —
    // substitution replaces this with the SPECIAL product below.
    const plainProductRes = await request.post(`${api}/api/v1/products`, {
      headers: headers!,
      data: { name: `E2E B465 Sub Plain ${suffix}`, unit: "unit", pricePerUnit: "5.00" },
    });
    expect(
      plainProductRes.ok(),
      `POST /products (plain) returned ${plainProductRes.status()}`,
    ).toBe(true);
    const plainProduct: { id: string; name: string } = await plainProductRes.json();

    // ── Fixture: the SPECIAL-tier substitute target.
    const specialListPrice = 20.0;
    const specialTier3Price = 8.0;
    const specialProductRes = await request.post(`${api}/api/v1/products`, {
      headers: headers!,
      data: {
        name: `E2E B465 Sub Special ${suffix}`,
        unit: "unit",
        pricePerUnit: specialListPrice.toFixed(2),
        priceTier3: specialTier3Price.toFixed(2),
      },
    });
    expect(
      specialProductRes.ok(),
      `POST /products (special) returned ${specialProductRes.status()}`,
    ).toBe(true);
    const specialProduct: { id: string; name: string } = await specialProductRes.json();

    const customerRes = await request.post(`${api}/api/v1/customers`, {
      headers: headers!,
      data: {
        username: `e2e_b465_sub_${suffix}`,
        businessName: `E2E B465 Substitute Baseline ${suffix}`,
        contactName: "E2E Tester",
        pricingTier: 3,
      },
    });
    expect(customerRes.ok(), `POST /customers returned ${customerRes.status()}`).toBe(true);
    const customer: { id: string } = (await customerRes.json()).customer;
    expect(customer?.id, "POST /customers response carried no customer.id").toBeTruthy();

    const orderRes = await request.post(`${api}/api/v1/orders`, {
      headers: headers!,
      data: {
        customerId: customer.id,
        status: "DRAFT",
        items: [{ productId: plainProduct.id, qty: 1 }],
      },
    });
    expect(orderRes.ok(), `POST /orders returned ${orderRes.status()}`).toBe(true);
    const order: { id: string } = await orderRes.json();
    expect(order?.id, "POST /orders response carried no id").toBeTruthy();

    await page.goto(`/orders/${order.id}`);
    const lineRow = page
      .getByText(plainProduct.name, { exact: true })
      .locator('xpath=ancestor::div[.//*[normalize-space(text())="Unit price"]][1]');
    await expect(lineRow).toBeVisible({ timeout: 15_000 });

    await lineRow.getByRole("button", { name: "Substitute", exact: true }).click();
    // SubstitutePicker fetches by search term (no default full listing) — type
    // the product's own name before selecting it, same as the add-input flow.
    await page.getByPlaceholder("Search products...").fill(specialProduct.name);
    await page.getByRole("button", { name: specialProduct.name }).click();

    // ── Substituted line now resolves to the SPECIAL tier price with no
    // reason typed — save must succeed with NO required-reason refusal at
    // all (the substitution itself is never a repricing decision). Wait for
    // the actual PATCH response and assert 2xx — a vacuous
    // `not.toBeVisible` on the error toast would pass just as well if the
    // click silently did nothing, proving nothing about a real save.
    const [saveResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(`/orders/${order.id}/items`) && r.request().method() === "PATCH",
      ),
      page.getByRole("button", { name: "Save Draft", exact: true }).click(),
    ]);
    expect(
      saveResponse.status(),
      `PATCH /orders/${order.id}/items returned ${saveResponse.status()}`,
    ).toBeGreaterThanOrEqual(200);
    expect(saveResponse.status()).toBeLessThan(300);

    // Reopen for a fresh edit session and prove Undo-ing a substitution sends
    // NO PATCH at all: a perfect Undo restores every field to its pre-
    // substitution value, so buildItemUpdates() finds nothing changed and
    // handleSaveItems short-circuits before ever calling the mutation.
    await page.goto(`/orders/${order.id}`);
    const specialLineRow = page
      .getByText(specialProduct.name, { exact: true })
      .locator('xpath=ancestor::div[.//*[normalize-space(text())="Unit price"]][1]');
    await expect(specialLineRow).toBeVisible({ timeout: 15_000 });
    await specialLineRow.getByRole("button", { name: "Substitute", exact: true }).click();
    await page.getByPlaceholder("Search products...").fill(plainProduct.name);
    await page.getByRole("button", { name: plainProduct.name }).click();
    await specialLineRow.getByRole("button", { name: "Undo", exact: true }).click();

    let itemsPatchFired = false;
    page.on("request", (r) => {
      if (r.method() === "PATCH" && r.url().includes(`/orders/${order.id}/items`)) {
        itemsPatchFired = true;
      }
    });
    await page.getByRole("button", { name: "Save Draft", exact: true }).click();
    // Give any (unwanted) request a moment to fire before asserting its absence.
    await page.waitForTimeout(1_500);
    expect(itemsPatchFired).toBe(false);
  });
});
