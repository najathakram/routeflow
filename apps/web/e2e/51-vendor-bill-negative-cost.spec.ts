/**
 * B469 — web vendor-bill line entry couldn't enter a negative (discount/
 * deposit) cost line: both the "New Purchase" create form and the DRAFT-bill
 * line editor had a `min` attribute (and, on the create form, a client-side
 * `Cost > 0` check) on the Unit Cost input, even though mobile scan-to-bill
 * has sent negative `unitCost` lines since #791 and the server has always
 * accepted them (`VendorBillItemDto.unitCost` carries no `@Min` — only `qty`
 * does). The real guard is server-side: `assertMoneyInvariantsOrThrow` 400s
 * with `code: "MONEY_INVARIANT"` only when the BILL AS A WHOLE nets negative,
 * never for an individual negative line that's offset elsewhere.
 *
 * This spec drives the DRAFT-bill line editor (`/vendor-bills/[id]`, Edit
 * mode) rather than the "New Purchase" create modal — the create modal's
 * Supplier/Product fields are custom comboboxes with async search, while the
 * edit screen lets an unlinked line be typed directly (no picker interaction
 * needed), which is the simpler, more deterministic surface for proving this
 * specific fix.
 *
 * NOT part of the local red gate (apps/web has no unit runner for this page's
 * client-side logic, same rationale as 24/48). UI proof (screenshots) is
 * pending a compose-slot run per this suite's established
 * "proven-pending-deploy" posture — see 24-order-edit-pricing.spec.ts's
 * header for the precedent.
 *
 * Role: OPERATOR (pre-authenticated storageState). Tenant: the approved
 * e2e-routeflow regression seed. Fixtures are fully self-provisioned via the
 * API — a throwaway supplier, a throwaway product, and a DRAFT vendor bill
 * carrying one positive anchor line — addressed only by the ids the API
 * hands back (never "the first row" — the #556 lesson).
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

test.describe("Vendor-bill web line entry allows negative cost (B469)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("REG-B469-WEB: a negative-cost discount line is enterable; a bill that nets negative is refused with a clear message; fixing it to net positive saves", async ({
    page,
    request,
  }) => {
    await page.goto("/vendor-bills");
    await expect(page.getByRole("button", { name: "New Purchase" })).toBeVisible({
      timeout: 15_000,
    });

    const headers = await apiHeaders(page);
    expect(
      headers,
      "no operator access token in localStorage — operator storageState is stale or the setup project did not run",
    ).toBeTruthy();
    const api = apiBase(page.url());
    const suffix = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    // ── Fixtures: a throwaway supplier + product, and a DRAFT bill carrying
    // one positive anchor line (qty 1 @ $100).
    const supplierRes = await request.post(`${api}/api/v1/suppliers`, {
      headers: headers!,
      data: { name: `E2E B469 Supplier ${suffix}` },
    });
    expect(supplierRes.ok(), `POST /suppliers returned ${supplierRes.status()}`).toBe(true);
    const supplier: { id: string } = await supplierRes.json();

    const productRes = await request.post(`${api}/api/v1/products`, {
      headers: headers!,
      data: { name: `E2E B469 Product ${suffix}`, unit: "unit", pricePerUnit: "20.00" },
    });
    expect(productRes.ok(), `POST /products returned ${productRes.status()}`).toBe(true);
    const product: { id: string; name: string } = await productRes.json();

    const anchorCost = 100;
    const billRes = await request.post(`${api}/api/v1/vendor-bills`, {
      headers: headers!,
      data: {
        supplierId: supplier.id,
        billDate: today,
        items: [{ productId: product.id, description: product.name, qty: 1, unitCost: anchorCost }],
      },
    });
    expect(billRes.ok(), `POST /vendor-bills returned ${billRes.status()}`).toBe(true);
    const bill: { id: string } = await billRes.json();
    expect(bill?.id, "POST /vendor-bills response carried no id").toBeTruthy();

    await page.goto(`/vendor-bills/${bill.id}`);
    await page.getByRole("button", { name: "Edit", exact: true }).click();

    // ── Add a second, unlinked line typed directly (no product picker) —
    // this is the discount/deposit line the fix is about.
    await page.getByRole("button", { name: "Add item" }).click();
    const descInput = page.getByPlaceholder("Description");
    await expect(descInput).toBeVisible({ timeout: 10_000 });
    await descInput.fill(`E2E B469 discount ${suffix}`);
    const newRow = descInput.locator("xpath=ancestor::div[contains(@class, 'grid')][1]");
    const numberInputs = newRow.locator('input[type="number"]');
    const qtyInput = numberInputs.nth(0);
    const costInput = numberInputs.nth(2);
    await qtyInput.fill("1");

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // ── A cost that nets the bill negative overall ($100 anchor - $150
      // discount = -$50): the exact B469 case — no `min` blocks entry.
      await costInput.fill("-150");
      await costInput.blur();
      await expect(costInput).toHaveValue("-150");

      // ── Proof screenshot: the negative-cost line entered, pre-save.
      await page.screenshot({
        path: `local-assets/e2e/b469-vendor-bill-negative-cost-${vp.name}.png`,
        fullPage: false,
      });
    }

    await page.getByRole("button", { name: "Save Changes" }).click();
    const invariantToast = page.getByText(
      /These lines net to a negative amount.*record it as a supplier credit/i,
    );
    await expect(invariantToast).toBeVisible({ timeout: 10_000 });

    // ── Fixing the discount so the bill nets positive ($100 - $30 = $70)
    // saves cleanly — the reason this is a MONEY_INVARIANT check on the
    // bill's NET total, never a blanket "no negative lines" rule.
    await costInput.fill("-30");
    await costInput.blur();
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText("Bill updated")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible({
      timeout: 10_000,
    });
  });
});
