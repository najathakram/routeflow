/**
 * Customers list UX (PKG-1: F16/F17/F24/F26). RTL cannot measure layout, so this is the real
 * proof: real bounding boxes at 390px and 1440px on the approved `test` tenant.
 *
 * The seeded `test` tenant has no phone/tags/receivables on its customers, so the list response
 * is PATCHED in flight (route.fetch + edit) to give the first rows a phone, tags and a balance.
 * Layout, links and clipping are all real; only the field values are decorated. No writes.
 * Window scroll only (never scrollIntoView, which false-greens clipping checks).
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { documentLevelOverflowPx, waitForDataLoaded } from "./helpers/overflow";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3001";
const LIST = /\/api\/v1\/customers\?/;

async function decorateList(page: Page) {
  await page.route(LIST, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const rows: any[] = body.data ?? [];
    rows.forEach((r, i) => {
      if (i === 0) {
        r.phone = "555-0142";
        r.receivables = 1234.5;
        r.unusedCredits = 0;
        r.tagAssignments = [
          { tag: { id: "t1", name: "VIP", color: "#2d5be3" } },
          { tag: { id: "t2", name: "Cash", color: "#1a7f5a" } },
        ];
      } else if (i === 1) {
        r.receivables = 0;
        r.unusedCredits = 0;
      }
    });
    await route.fulfill({ response: res, json: body });
  });
}

async function openList(page: Page) {
  await decorateList(page);
  await page.goto("/customers");
  await expect(page.getByRole("heading", { name: /^customers$/i }).first()).toBeVisible({
    timeout: 15_000,
  });
  await waitForDataLoaded(page);
  await expect(page.getByTestId("receivables-cell").first()).toBeVisible();
}

test.describe("customers list — 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test.beforeEach(async ({ context }) => setTenantCookie(context, BASE_URL));

  test("C6 Receivables is on screen, no document overflow, hidden columns hidden", async ({
    page,
  }) => {
    await openList(page);
    const header = page.getByRole("columnheader", { name: /receivables/i });
    const box = (await header.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await expect(page.getByTestId("receivables-cell").first()).toBeInViewport();
    expect(await documentLevelOverflowPx(page)).toBeLessThanOrEqual(0);
    for (const n of [/^email$/i, /^phone$/i, /^credits$/i, /^tags$/i]) {
      await expect(page.getByRole("columnheader", { name: n })).toBeHidden();
    }
  });

  test("F16 zero receivables reads $0.00", async ({ page }) => {
    await openList(page);
    const cells = page.getByTestId("receivables-cell");
    await expect(cells.nth(0)).toHaveText("$1,234.50");
    await expect(cells.nth(1)).toHaveText("$0.00");
  });

  test("relocation: phone + tags stay reachable in the Name cell at 390", async ({ page }) => {
    await openList(page);
    const line = page.getByTestId("name-secondary-line").first();
    await expect(line).toBeVisible();
    await expect(page.getByTestId("name-secondary-phone").first()).toHaveAttribute(
      "href",
      "tel:5550142",
    );
    await expect(page.getByTestId("name-secondary-phone").first()).toBeInViewport();
    await expect(page.getByTestId("name-secondary-tag").first()).toHaveText("VIP");
  });

  test("a LONG tag and select mode (checkbox column) still keep Receivables on screen", async ({
    page,
  }) => {
    await page.route(LIST, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      const r = (body.data ?? [])[0];
      if (r) {
        r.phone = "555-0142";
        r.receivables = 99.5;
        r.tagAssignments = [
          {
            tag: {
              id: "tl",
              name: "An extremely long tag name for a wholesale buyer",
              color: "#2d5be3",
            },
          },
          { tag: { id: "t2", name: "Another very long tag label here", color: "#1a7f5a" } },
        ];
      }
      await route.fulfill({ response: res, json: body });
    });
    await page.goto("/customers");
    await expect(page.getByRole("heading", { name: /^customers$/i }).first()).toBeVisible({
      timeout: 15_000,
    });
    await waitForDataLoaded(page);
    await page.getByRole("button", { name: /^select$/i }).click();
    await expect(page.getByRole("checkbox").first()).toBeVisible();
    const header = page.getByRole("columnheader", { name: /receivables/i });
    const box = (await header.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    // Truly visible: inside the table's own scroll container too, not just the viewport.
    const scrollerRight = await header.evaluate((el) => {
      let n: HTMLElement | null = el as HTMLElement;
      while (n && !/auto|scroll/.test(getComputedStyle(n).overflowX)) n = n.parentElement;
      return n ? n.getBoundingClientRect().right : window.innerWidth;
    });
    expect(box.x + box.width).toBeLessThanOrEqual(scrollerRight + 1);
    await expect(page.getByTestId("receivables-cell").first()).toBeInViewport();
    const chip = page.getByTestId("name-secondary-tag").first();
    const cb = (await chip.boundingBox())!;
    expect(cb.x + cb.width).toBeLessThanOrEqual(390);
    expect(await documentLevelOverflowPx(page)).toBeLessThanOrEqual(0);
  });

  test("C8 empty state fits the viewport and Clear search works", async ({ page }) => {
    await openList(page);
    const search = page.getByPlaceholder(/name, business or phone/i);
    await search.fill("zzzzqqq");
    const text = page.getByText(/no customers match your current search and filters/i);
    await expect(text).toBeVisible({ timeout: 15_000 });
    const tb = (await text.boundingBox())!;
    expect(tb.x).toBeGreaterThanOrEqual(0);
    expect(tb.x + tb.width).toBeLessThanOrEqual(390);
    const clearSearch = page.getByRole("button", { name: /^clear search$/i });
    await expect(clearSearch).toBeInViewport();
    await expect(page.getByRole("button", { name: /^clear filters$/i })).toBeInViewport();
    await clearSearch.click();
    await expect(search).toHaveValue("");
  });
});

test.describe("customers list — 1440px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeEach(async ({ context }) => setTenantCookie(context, BASE_URL));

  test("C3 name is a keyboard link to the detail page; all columns show; secondary line hidden", async ({
    page,
  }) => {
    await openList(page);
    for (const n of [/^email$/i, /^phone$/i, /^credits$/i, /^tags$/i]) {
      await expect(page.getByRole("columnheader", { name: n })).toBeVisible();
    }
    await expect(page.getByTestId("name-secondary-line").first()).toBeHidden();
    const link = page.locator("tbody a[href^='/customers/']").first();
    const name = (await link.textContent())!.trim();
    await page.getByPlaceholder(/name, business or phone/i).focus();
    // Tab until the first name link takes focus (bounded; filter chips/headers sit between).
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      if (await link.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/customers\/[^/]+$/);
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 15_000 });
  });

  test("zero receivables and credits read $0.00 at 1440 too", async ({ page }) => {
    await openList(page);
    await expect(page.getByTestId("receivables-cell").nth(1)).toHaveText("$0.00");
    await expect(page.getByTestId("credits-cell").nth(1)).toHaveText("$0.00");
  });
});

test.describe("customers list — 768px", () => {
  test.use({ viewport: { width: 768, height: 1024 } });
  test.beforeEach(async ({ context }) => setTenantCookie(context, BASE_URL));

  test("all columns show at sm+, Receivables is on screen, no document overflow, secondary line hidden", async ({
    page,
  }) => {
    await openList(page);
    for (const n of [/^email$/i, /^phone$/i, /^credits$/i, /^tags$/i]) {
      await expect(page.getByRole("columnheader", { name: n })).toBeVisible();
    }
    await expect(page.getByTestId("name-secondary-line").first()).toBeHidden();
    await expect(page.getByTestId("receivables-cell").first()).toBeVisible();
    expect(await documentLevelOverflowPx(page)).toBeLessThanOrEqual(0);
    await expect(page.getByTestId("receivables-cell").nth(1)).toHaveText("$0.00");
    await expect(page.getByTestId("credits-cell").nth(1)).toHaveText("$0.00");
  });
});
