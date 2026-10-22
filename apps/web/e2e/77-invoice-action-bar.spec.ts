/**
 * Row 492 (SA-837): the invoice form's fixed bottom action bar wraps instead of overflowing, so
 * "Save and Send" is never clipped at phone width. Read-only: nothing is saved or sent. At 1440 / 768 /
 * 390 the bar has no horizontal overflow, every control (Preview, Download, Save as draft, Save and Send,
 * Cancel) is fully inside the viewport and is at least 44 px tall, and a hit-test at each control's
 * centre lands on the control itself (nothing sits over it).
 */
import { test, expect } from "@playwright/test";

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
] as const;

const CONTROLS = ["Preview", "Download", "Save as draft", "Save and Send", "Cancel"] as const;

for (const vp of VIEWPORTS) {
  test.describe(`invoice action bar — ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`no overflow, Save and Send fully visible (${vp.width}px)`, async ({ page }) => {
      await page.goto("/invoices/new");
      await page
        .getByRole("button", { name: /other charge \(a fee or correction with no order\)/i })
        .click({ timeout: 15_000 });
      const bar = page.getByTestId("invoice-action-bar");
      await expect(bar).toBeVisible({ timeout: 15_000 });

      const overflow = await bar.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow, `bar scrolls ${overflow}px horizontally`).toBeLessThanOrEqual(0);

      for (const name of CONTROLS) {
        const control = bar.getByRole("button", { name, exact: name !== "Save and Send" });
        await expect(control, name).toBeVisible();
        const box = await control.boundingBox();
        expect(box, name).not.toBeNull();
        expect(box!.x, `${name} left edge`).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, `${name} right edge`).toBeLessThanOrEqual(vp.width);
        expect(box!.y + box!.height, `${name} bottom edge`).toBeLessThanOrEqual(vp.height);
        expect(box!.height, `${name} target height`).toBeGreaterThanOrEqual(44);
        const hit = await control.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !!top && el.contains(top);
        });
        expect(hit, `${name} is covered by another element`).toBe(true);
      }
    });
  });
}
