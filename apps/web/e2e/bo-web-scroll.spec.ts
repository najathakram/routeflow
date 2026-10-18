import { test, expect, type Page } from "@playwright/test";

/**
 * BO-01: an admin page ends where its content ends. The console's sr-only spans are absolute; with no
 * positioned ancestor they stretched the DOCUMENT (4698 px of scroll for a 900 px window at 1440).
 * Red on master, green once <main> is `relative`. Runs on the approved `test` tenant only.
 */
const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];

async function testTenantId(page: Page): Promise<string> {
  await page.goto("/admin/tenants");
  const link = page
    .locator('a[href^="/admin/tenants/"]')
    .filter({ hasText: /^test$/ })
    .first();
  const href = await link.getAttribute("href");
  const id = href?.split("/")[3]?.split("?")[0];
  expect(id, "the approved test tenant is listed").toBeTruthy();
  return id!;
}

async function expectEndsAtContent(page: Page, mainScrolls: boolean) {
  await page.waitForLoadState("networkidle");
  const m = await page.evaluate(() => {
    const main = document.querySelector("main") as HTMLElement;
    // generic probe: absolute descendants of <main> whose containing block is the viewport
    const escaped = Array.from(main.querySelectorAll<HTMLElement>("*")).filter(
      (el) => getComputedStyle(el).position === "absolute" && el.offsetParent === document.body,
    ).length;
    return {
      doc: document.documentElement.scrollHeight,
      inner: window.innerHeight,
      mainScroll: main.scrollHeight,
      mainClient: main.clientHeight,
      escaped,
    };
  });
  expect(m.doc, `document scrollHeight ${m.doc} vs innerHeight ${m.inner}`).toBeLessThanOrEqual(
    m.inner + 1,
  );
  expect(m.escaped).toBe(0);
  if (mainScrolls) expect(m.mainScroll).toBeGreaterThan(m.mainClient);
}

for (const size of WIDTHS) {
  test.describe(`BO-01 at ${size.width}`, () => {
    test.use({ viewport: size });

    test("the tenants list ends where its content ends", async ({ page }) => {
      await page.goto("/admin/tenants");
      await expectEndsAtContent(page, false);
    });

    test("tenant Setup, Overview and Billing end where their content ends", async ({ page }) => {
      const id = await testTenantId(page);
      for (const tab of ["setup", "overview", "billing"]) {
        await page.goto(`/admin/tenants/${id}?tab=${tab}`);
        await expectEndsAtContent(page, tab === "setup");
      }
    });
  });
}
