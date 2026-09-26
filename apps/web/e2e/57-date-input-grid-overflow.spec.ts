/**
 * #2080 follow-up (PR #2086 review): the date/time-input fix in `app/globals.css` is global,
 * so it is pinned where date inputs sit in narrow, unconditional `grid-cols-2/3` tracks
 * (`minmax(0,1fr)`, ~80-140px wide at phone widths). An earlier draft of the fix set
 * `min-width: 140px` there and pushed these inputs 10-57px past their cells; the shipped
 * rule sets `min-width: 0`.
 *
 * Every test applies `applyIosDateInputAdjustment` (helpers/ios-date-input.ts: WebKit's
 * post-cascade RenderThemeIOS step, see that file and spec 56), then measures each date
 * input inside the form under test: its right edge against its own grid cell's and against
 * the viewport. Both must be <= 0. The measurement is scoped to the form (the modal, or the
 * page card) on purpose: these pages carry older, separately-visible overflow elsewhere at
 * 320px (the vendor-bills header filters, the estimates list table behind the modal) that
 * is not this rule's and would make a whole-page walk red on master and fix alike.
 *
 * invoices/[id]/edit only renders its form for a DRAFT invoice. The seeded test tenant has
 * none, so the test looks one up through the API and skips, with that reason, when there
 * is none; the compiled-CSS harness on PR #2086 covers that page's class strings.
 */
import { test, expect, type Page } from "@playwright/test";
import { applyIosDateInputAdjustment, DATE_TIME_INPUT_SELECTOR } from "./helpers/ios-date-input";
import { apiBase, operatorAccessToken } from "./helpers/api";

const VIEWPORTS = [
  { width: 320, height: 690 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
] as const;

interface DateInputFit {
  pastOwnCell: number;
  pastViewport: number;
  width: number;
}

async function measureDateInputs(page: Page, scopeSelector: string): Promise<DateInputFit[]> {
  return page.evaluate(
    ({ scope, selector }) => {
      const root = document.querySelector(scope);
      if (!root) return [];
      const round = (n: number) => Math.round(n * 100) / 100;
      return Array.from(root.querySelectorAll<HTMLInputElement>(selector))
        .filter((input) => input.getBoundingClientRect().width > 0)
        .map((input) => {
          // The grid cell is the ancestor whose parent is the grid container.
          let cell: HTMLElement = input.parentElement ?? input;
          let node: HTMLElement | null = input;
          while (node && node.parentElement && node.parentElement !== root) {
            if (getComputedStyle(node.parentElement).display === "grid") {
              cell = node;
              break;
            }
            node = node.parentElement;
          }
          const r = input.getBoundingClientRect();
          return {
            pastOwnCell: round(r.right - cell.getBoundingClientRect().right),
            pastViewport: round(r.right - window.innerWidth),
            width: round(r.width),
          };
        });
    },
    { scope: scopeSelector, selector: DATE_TIME_INPUT_SELECTOR },
  );
}

async function assertDateInputsFit(page: Page, scopeSelector: string, label: string) {
  const { visited } = await applyIosDateInputAdjustment(page);
  const fits = await measureDateInputs(page, scopeSelector);
  expect(fits.length, `${label}: no visible date input inside ${scopeSelector}`).toBeGreaterThan(0);
  expect(
    visited,
    `${label}: the iOS adjustment did not reach the form's date inputs`,
  ).toBeGreaterThanOrEqual(fits.length);
  const worstCell = Math.max(...fits.map((f) => f.pastOwnCell));
  const worstViewport = Math.max(...fits.map((f) => f.pastViewport));
  expect(
    worstCell,
    `${label}: a date input runs ${worstCell}px past its grid cell — ${JSON.stringify(fits)}`,
  ).toBeLessThanOrEqual(0);
  expect(
    worstViewport,
    `${label}: a date input runs ${worstViewport}px past the viewport — ${JSON.stringify(fits)}`,
  ).toBeLessThanOrEqual(0);
}

for (const vp of VIEWPORTS) {
  test.describe(`date inputs in narrow grid tracks — ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`vendor-bills New Purchase modal (${vp.width}px)`, async ({ page }) => {
      await page.goto("/vendor-bills");
      await page.getByRole("button", { name: "New Purchase" }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10_000 });
      await assertDateInputsFit(page, '[role="dialog"]', `vendor-bills modal @${vp.width}`);
    });

    test(`estimates New Estimate modal (${vp.width}px)`, async ({ page }) => {
      await page.goto("/estimates");
      await page.getByRole("button", { name: "New Estimate" }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10_000 });
      await assertDateInputsFit(page, '[role="dialog"]', `estimates modal @${vp.width}`);
    });

    test(`invoices/new dates grid (${vp.width}px)`, async ({ page }) => {
      await page.goto("/invoices/new");
      // /invoices/new opens on a "What is this invoice for?" chooser; the dates grid is in the form.
      await page.getByRole("button", { name: /^New sale/ }).click({ timeout: 15_000 });
      await expect(page.getByRole("heading", { name: "Invoice Details" })).toBeVisible({
        timeout: 15_000,
      });
      await assertDateInputsFit(page, "#main-content", `invoices/new @${vp.width}`);
    });

    test(`invoices/[id]/edit dates grid (${vp.width}px)`, async ({ page, request }) => {
      await page.goto("/invoices");
      const token = await operatorAccessToken(page);
      expect(token, "no operator access token in storage").not.toBe("");
      const res = await request.get(`${apiBase(page.url())}/api/v1/invoices`, {
        params: { status: "DRAFT", limit: "1" },
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.ok(), `GET /invoices?status=DRAFT returned ${res.status()}`).toBe(true);
      const body = (await res.json()) as { data?: Array<{ id: string }> } | Array<{ id: string }>;
      const rows = Array.isArray(body) ? body : (body.data ?? []);
      test.skip(
        rows.length === 0,
        "no DRAFT invoice on the test tenant; the PR #2086 compiled-CSS harness covers this page",
      );
      await page.goto(`/invoices/${rows[0].id}/edit`);
      await expect(page.getByRole("heading", { name: "Invoice Dates" })).toBeVisible({
        timeout: 15_000,
      });
      await assertDateInputsFit(page, "#main-content", `invoices/[id]/edit @${vp.width}`);
    });
  });
}
