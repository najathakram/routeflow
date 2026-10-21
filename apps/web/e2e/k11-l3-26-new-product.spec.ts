/**
 * K11-26 (FE1, P17-P20, A5): the New product dialog, finished, at 1440 / 768 / 390.
 *   named "New product" with a "Create product" button; focus lands on Name; Escape closes a pristine dialog
 *   in <= 100 ms and does nothing once something is typed; Barcode has a scan button; the unit code helper is
 *   short; at 390 Category clears the pinned footer.
 *
 * LOCAL LANE ONLY (project `units-v2`). READ-ONLY: "Create product" is never clicked, nothing is saved.
 * Role: OPERATOR on the approved test tenant.
 */
import { test, expect } from "@playwright/test";
import { VIEWPORTS, shot } from "./k11-l3-support";
import { setTenantCookie } from "./helpers/auth";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";

for (const vp of VIEWPORTS) {
  test.describe(`K11-26 New product dialog @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("k11-l3 names, focus, Escape, scan button and footer clearance", async ({
      page,
      context,
    }, info) => {
      await setTenantCookie(context, BASE);
      await page.goto("/products");
      // The /products opener keeps its own name ("New Product"); only the dialog is renamed.
      await page.getByRole("button", { name: "New Product", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "New product" });
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await expect(dialog.getByRole("button", { name: "Create product" })).toBeVisible();

      // Focus lands on Name, not the X.
      await expect(dialog.getByLabel("Name *", { exact: true })).toBeFocused();

      // Barcode has its own scan button, and the unit code helper is the short sentence.
      await expect(dialog.getByRole("button", { name: "Scan barcode" })).toBeVisible();
      await expect(
        dialog.getByText(/^Printed on invoices\. Leave blank if it's the same as the/),
      ).toBeVisible();

      // Dirty: Escape does nothing.
      await dialog.getByLabel("Name *", { exact: true }).fill("QA K11 26");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();

      // 390: Category (the last field) scrolls clear of the pinned footer.
      if (vp.width < 640) {
        const category = dialog.getByText("Category", { exact: true });
        await category.scrollIntoViewIfNeeded();
        const body = dialog.locator(".overflow-y-auto").first();
        await body.evaluate((el) => (el.scrollTop = el.scrollHeight));
        const cat = (await category.boundingBox())!;
        const footer = (await dialog
          .getByRole("button", { name: "Create product" })
          .boundingBox())!;
        expect(cat.y + cat.height, "Category ends above the footer").toBeLessThan(footer.y);
        await shot(page, info, "k11-26-new-product-390-bottom");
      }

      // Erase it: pristine again. Escape starts closing within 100 ms (data-state flips to closed, or the node goes).
      await dialog.getByLabel("Name *", { exact: true }).fill("");
      await page.evaluate(() => {
        (window as any).__escMs = new Promise<number>((resolve) => {
          const start = { t: 0 };
          addEventListener("keydown", (e) => e.key === "Escape" && (start.t = performance.now()), {
            capture: true,
            once: true,
          });
          const mo = new MutationObserver(() => {
            const d = document.querySelector('[role="dialog"]');
            if (!d || d.getAttribute("data-state") === "closed") {
              mo.disconnect();
              resolve(performance.now() - start.t);
            }
          });
          mo.observe(document.body, { subtree: true, childList: true, attributes: true });
        });
      });
      await page.keyboard.press("Escape");
      const ms = await page.evaluate(() => (window as any).__escMs as Promise<number>);
      expect(ms, "Escape starts closing within 100 ms").toBeLessThanOrEqual(100);
      await expect(dialog).toBeHidden({ timeout: 5_000 });
      await shot(page, info, "k11-26-new-product-closed");
    });
  });
}
