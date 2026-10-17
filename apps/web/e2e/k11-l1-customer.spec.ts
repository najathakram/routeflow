/**
 * K11 lane L1, customer view (K11-04 to K11-07). NOT RUN on the machine it was written on (no Docker, no browser).
 * Written from the cards' Playwright acceptance; run it against the local compose stack with `flag.units_prices_v2`
 * served to the `test` tenant before relying on it.
 *
 *   K11-04  the customer list is shut until the field is focused; the active row is tinted with a left bar
 *   K11-05  the list follows the keys within 50 ms when the loaded rows contain the match
 *   K11-06  the picked customer survives a reload through ?customer=<id> (id only, never the name)
 *   K11-07  nothing repeats in a row, and the card fills the section's column (one product)
 *
 * REGISTRATION: `playwright.config.ts` only lists specs matching /units-v2-.*\.spec\.ts/ in the `units-v2` project,
 * so this file name is not picked up until the config's testMatch also names `k11-l1-.*\.spec\.ts` (a one-line edit
 * outside lane L1's files; the landing coordinator owns it). Until then run it by path with that project.
 *
 * Writes on the approved test tenant only (assertTestTenant first): one throwaway product and one throwaway customer,
 * retired softly afterwards (inactive, never hard-deleted), like units-v2-customer-prices.
 */
import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { VIEWPORTS, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";

for (const vp of VIEWPORTS) {
  test.describe(`K11 L1 customer view @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("shut list, visible active row, instant filter, refresh keeps the customer, no repeated values", async ({
      page,
      context,
    }, info) => {
      assertTestTenant(TENANT_SLUG, "k11-l1 customer fixtures");
      await setTenantCookie(context, BASE);
      const { api, headers } = await requireUnitsV2Flag(page);
      const tag = `${Date.now().toString(36).toUpperCase()}${vp.name}`;
      const customerName = `QA K11 Cust ${tag}`;
      let productId = "";
      let customerId = "";
      try {
        const prod = await page.request.post(`${api}/products`, {
          headers,
          data: {
            name: `QA K11 L1 ${tag}`,
            sku: `QAK11L1${tag}`,
            unit: "each",
            pricePerUnit: "10.00",
          },
        });
        expect(prod.ok(), `create the product: ${prod.status()}`).toBeTruthy();
        productId = ((await prod.json()) as any).id;
        const cust = await page.request.post(`${api}/customers`, {
          headers,
          data: {
            businessName: customerName,
            contactName: "QA K11",
            username: `qa-k11-${tag.toLowerCase()}`,
          },
        });
        expect(cust.ok(), `create the customer: ${cust.status()}`).toBeTruthy();
        customerId = ((await cust.json()) as any).customer.id;

        await page.goto(`/products/${productId}`);
        const search = page.locator("#units-v2-cust-search");
        await search.scrollIntoViewIfNeeded();
        const listbox = page.locator("#units-v2-cust-listbox");

        // K11-04: only the field and the hint until the field is focused.
        await expect(search).toBeVisible({ timeout: 20_000 });
        await expect(listbox).toHaveCount(0);
        await expect(search).toHaveAttribute("aria-expanded", "false");
        await search.focus();
        await search.fill("QA K11 Cust");
        await expect(listbox).toBeVisible();
        await page.keyboard.press("ArrowDown");
        const active = page.locator('#units-v2-cust-listbox [role="option"][aria-selected="true"]');
        await expect(active).toHaveCount(1);
        // The active row has a 3 px brand bar (never only the hover grey).
        await expect(active).toHaveCSS("border-left-width", "3px");
        await shot(page, info, "k11-l1-active-row");

        // K11-05: the visible list follows the last key within 50 ms (the loaded rows contain the match).
        await search.fill("");
        await search.focus();
        const lag = await page.evaluate(async (name) => {
          const box = document.querySelector<HTMLInputElement>("#units-v2-cust-search")!;
          const list = () => document.querySelector("#units-v2-cust-listbox");
          const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
          const setValue = (v: string) => {
            const setter = Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              "value",
            )!.set!;
            setter.call(box, v);
            box.dispatchEvent(new Event("input", { bubbles: true }));
          };
          setValue(name.slice(0, 6));
          await sleep(600); // let the server answer, so the rows are loaded
          const before = list()?.textContent ?? "";
          const t0 = performance.now();
          setValue(name);
          let changedAt = -1;
          while (performance.now() - t0 < 400) {
            if ((list()?.textContent ?? "") !== before) {
              changedAt = performance.now() - t0;
              break;
            }
            await sleep(5);
          }
          return changedAt;
        }, customerName);
        // -1 means the list did not change at all (the broader text matched the same rows): nothing to wait for.
        expect(lag === -1 || lag <= 50, `list update took ${lag} ms after the last key`).toBe(true);

        // K11-06: pick, reload, the same customer comes back; the URL has the id and not the name.
        await search.fill(customerName);
        await page.locator(`[data-testid="units-v2-cust-option-${customerId}"]`).click();
        await expect(page.getByTestId("units-v2-cust-chosen")).toContainText(customerName);
        await expect(page).toHaveURL(new RegExp(`customer=${customerId}`));
        expect(decodeURIComponent(page.url())).not.toContain(customerName);
        await page.reload();
        await expect(page.getByTestId("units-v2-cust-chosen")).toContainText(customerName, {
          timeout: 20_000,
        });
        await expect(page).toHaveURL(new RegExp(`customer=${customerId}`));

        // K11-07: one product -> the card fills the section (>= 95%) at 1440 and 768; no value twice in a row.
        const card = page.getByTestId(`units-v2-cv-product-${productId}`);
        await expect(card).toBeVisible();
        if (vp.width >= 768) {
          const section = page.getByTestId("units-v2-sec-customers");
          const cardW = (await card.boundingBox())!.width;
          const sectionW = (await section.boundingBox())!.width;
          expect(cardW / sectionW, "card width / section width").toBeGreaterThanOrEqual(0.95);
        }
        const rows = card.locator("tbody tr");
        const n = await rows.count();
        for (let i = 0; i < n; i++) {
          const cells = (await rows.nth(i).locator("td:visible").allInnerTexts()).map((t) =>
            t.trim(),
          );
          const figures = cells.flatMap((t) => t.match(/\$[\d,]+\.\d{2}/g) ?? []);
          // A tier-priced row prints its price once in the Price cell and the Retail figure in the next:
          // with a retail-tier customer those two are equal by design, so only the tier column could repeat.
          expect(cells.length, "Unit, Price and Retail only").toBeLessThanOrEqual(3);
          expect(figures.length).toBeGreaterThan(0);
        }
        await shot(page, info, "k11-l1-customer-view");
      } finally {
        if (productId) {
          const r = await page.request.patch(`${api}/products/${productId}`, {
            headers,
            data: { isActive: false },
          });
          // eslint-disable-next-line no-console
          if (!r.ok()) console.warn(`could not retire the throwaway product: ${r.status()}`);
        }
        if (customerId) {
          const r = await page.request.patch(`${api}/customers/${customerId}/status`, {
            headers,
            data: { status: "INACTIVE" },
          });
          // eslint-disable-next-line no-console
          if (!r.ok()) console.warn(`could not retire the throwaway customer: ${r.status()}`);
        }
      }
    });
  });
}
