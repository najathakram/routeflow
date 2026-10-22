/**
 * Row 711 (P1): a boxed invoice line edits as Boxes + Pieces (row 688). The Pieces input sat UNDER Unit Price at
 * every width (the Qty column held Boxes, Pieces and two labels in ~70 px), so loose pieces could not be reached by
 * mouse even though jsdom tests passed. This pins the layout: at 1440/768/390 the centre of Boxes, Pieces and Unit
 * Price each hit-tests to that input, and the box/piece inputs are 44 px touch targets.
 *
 * Role: OPERATOR (pre-authenticated session). Tenant: the approved e2e-routeflow seed (assertTestTenant in
 * helpers/constants.ts). Creates a throwaway boxed product, customer and DRAFT invoice; never saves the edit form;
 * deletes what it can in a `finally`.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";
const WIDTHS = [1440, 768, 390] as const;

/** The element at the centre of the labelled input, and whether it is that input. */
async function hitsItself(page: Page, label: string) {
  const input = page.getByLabel(label, { exact: true }).first();
  await input.scrollIntoViewIfNeeded();
  const box = await input.boundingBox();
  expect(box, `${label} has no box`).not.toBeNull();
  const hit = await input.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      self: at === el || el.contains(at),
      at: at ? `${at.tagName.toLowerCase()}[aria-label=${at.getAttribute("aria-label")}]` : "null",
    };
  });
  return { box: box!, ...hit };
}

test.describe("Invoice edit: a boxed line's Boxes / Pieces are reachable (row 711)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("Boxes, Pieces and Unit Price each hit-test to themselves at 1440/768/390", async ({
    page,
    request,
  }) => {
    await page.goto("/orders");
    await expect(page.getByRole("button", { name: "New Order" })).toBeVisible({ timeout: 15_000 });
    const token = await operatorAccessToken(page);
    expect(
      token,
      "no operator access token — stale storageState or setup did not run",
    ).toBeTruthy();
    const headers = { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
    const api = apiBase(page.url());
    const suffix = Date.now();
    let productId: string | undefined;
    let customerId: string | undefined;
    let invoiceId: string | undefined;

    try {
      const productRes = await request.post(`${api}/api/v1/products`, {
        headers,
        data: {
          name: `E2E 711 Case ${suffix}`,
          unit: "case",
          pricePerUnit: "21.60",
          unitsPerBox: 24,
        },
      });
      expect(productRes.ok(), `POST /products ${productRes.status()}`).toBe(true);
      productId = ((await productRes.json()) as { id: string }).id;
      const customerRes = await request.post(`${api}/api/v1/customers`, {
        headers,
        data: {
          username: `e2e_711_${suffix}`,
          businessName: `E2E 711 Boxed ${suffix}`,
          contactName: "E2E Tester",
        },
      });
      expect(customerRes.ok(), `POST /customers ${customerRes.status()}`).toBe(true);
      customerId = ((await customerRes.json()) as { customer: { id: string } }).customer.id;
      const invoiceRes = await request.post(`${api}/api/v1/invoices`, {
        headers,
        data: {
          customerId,
          items: [
            {
              description: `E2E 711 Case ${suffix}`,
              productId,
              qty: 48,
              boxes: 2,
              pieces: 0,
              unitPrice: 21.6,
            },
          ],
        },
      });
      expect(invoiceRes.ok(), `POST /invoices ${invoiceRes.status()}`).toBe(true);
      invoiceId = ((await invoiceRes.json()) as { id: string }).id;

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/invoices/${invoiceId}/edit`);
        await expect(page.getByLabel("Boxes", { exact: true })).toHaveValue("2", {
          timeout: 15_000,
        });
        for (const label of ["Boxes", "Pieces", "Unit Price"]) {
          const r = await hitsItself(page, label);
          expect(r.self, `${width}px: the centre of ${label} hits ${r.at}`).toBe(true);
        }
        for (const label of ["Boxes", "Pieces"]) {
          const { box } = await hitsItself(page, label);
          expect(box.height, `${width}px: ${label} is ${box.height}px tall`).toBeGreaterThanOrEqual(
            44,
          );
          expect(box.width, `${width}px: ${label} is ${box.width}px wide`).toBeGreaterThanOrEqual(
            44,
          );
        }
        await expect(page.getByText("box", { exact: true }).first()).toBeVisible();
        await expect(page.getByText("pcs", { exact: true }).first()).toBeVisible();
      }
    } finally {
      if (invoiceId)
        await request
          .delete(`${api}/api/v1/invoices/${invoiceId}`, { headers })
          .catch(() => undefined);
      if (productId)
        await request
          .delete(`${api}/api/v1/products/${productId}`, { headers })
          .catch(() => undefined);
      if (customerId)
        await request
          .delete(`${api}/api/v1/customers/${customerId}`, { headers })
          .catch(() => undefined);
    }
  });
});
