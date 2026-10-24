/**
 * POS-7 (73): the counter's "register look" and the per-device "Open the counter on this device" preference.
 *   /orders -> Counter (nav) -> slim header (Exit counter first, clerk, store) + the 64 px rail (lg+) -> peek -> Exit.
 *   Exit with an empty cart goes back; with lines it asks "Discard this sale?" (Keep selling focused, Escape keeps, Discard leaves).
 *   Preference on -> landing at /dashboard opens the counter once, with a "Counter opened" toast.
 * At 390 / 768 / 1024 / 1440 px. The rail exists from lg (1024) up; below that the nav is the drawer and is asserted instead.
 *
 * LOCAL LANE ONLY, same guards as 71: the tenant is put on the in_store_shipping_retailer profile (counter on) via
 * helpers/local-fulfilment-profile.ts and restored row-for-row in afterAll. Nothing is sold and no row is created: a product is
 * only put on the cart and discarded. Products are DISCOVERED over the API. Needs `npm run local:sa`.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";
import {
  applyBusinessProfile,
  localTarget,
  readApiCapability,
  restoreFulfilmentConfig,
  snapshotFulfilmentConfig,
  type FulfilmentSnapshot,
  waitForApiCapability,
} from "./helpers/local-fulfilment-profile";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const COUNTER = "/orders/counter-sale";
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1024", width: 1024, height: 768 },
  { name: "1440", width: 1440, height: 900 },
] as const;
const FOCUSABLE =
  'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])';

let before: FulfilmentSnapshot | null = null;
let capabilityBefore: unknown = null;
const target = () => localTarget(apiBase(BASE));

test.beforeAll(async () => {
  before = await snapshotFulfilmentConfig(target());
  capabilityBefore = await readApiCapability(target());
  await applyBusinessProfile(target(), before, "in_store_shipping_retailer");
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  if (!before) return;
  const restored = await restoreFulfilmentConfig(target(), before);
  expect(restored, "the tenant's fulfilment config is back exactly as it was").toBe(true);
  await waitForApiCapability(target(), capabilityBefore, 60_000);
});

async function discoverSku(page: Page): Promise<string> {
  const token = await operatorAccessToken(page);
  const api = `${apiBase(page.url())}/api/v1`;
  const headers = { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
  const res = await page.request.get(`${api}/products`, { headers, params: { limit: "50" } });
  const products: any[] = ((await res.json()) as any)?.data ?? [];
  const p = products.find(
    (x) => x?.isActive !== false && /^[0-9A-Za-z-]{4,}$/.test(String(x?.sku ?? "")),
  );
  expect(p, "the tenant needs an active product with a SKU").toBeTruthy();
  return String(p.sku);
}

/** Reach the Counter link whichever nav is showing: the rail (lg+) or the drawer. */
async function enterCounterFromNav(page: Page, width: number) {
  if (width < 1024) {
    await page.getByRole("button", { name: "Open navigation menu" }).first().click();
    await page.getByTestId("sidebar-drawer-aside").getByRole("link", { name: "Counter" }).click();
  } else {
    await page.getByTestId("sidebar-aside").getByRole("link", { name: "Counter" }).click();
  }
  await expect(page).toHaveURL(new RegExp(`${COUNTER}$`));
  await expect(page.getByTestId("register-header")).toBeVisible({ timeout: 15_000 });
}

const savedSidebar = (page: Page) =>
  page.evaluate(() => localStorage.getItem("rf-sidebar-collapsed"));
const railWidth = async (page: Page) =>
  Math.round((await page.getByTestId("sidebar-aside").boundingBox())!.width);
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const vp of VIEWPORTS) {
  test.describe(`POS-7 register look @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });
    const hasRail = vp.width >= 1024;

    test("enter, slim header, collapsed rail + peek, Exit with and without a cart", async ({
      page,
      context,
    }) => {
      await setTenantCookie(context, BASE);
      await page.goto("/orders");
      const sku = await discoverSku(page);
      // a known saved state: the rail EXPANDED (the register must not change this)
      await page.evaluate(() => localStorage.setItem("rf-sidebar-collapsed", "false"));
      await page.reload();
      if (hasRail) await expect.poll(() => railWidth(page)).toBe(240);

      await enterCounterFromNav(page, vp.width);

      // slim header: Exit counter is the first focusable; the store name is there, and so is the clerk (the user-menu trigger's
      // username, which is hidden below sm: the check below reads its content, not its visibility)
      const header = page.getByTestId("register-header");
      const firstText = await header.evaluate(
        (el, sel) => (el.querySelector(sel) as HTMLElement | null)?.innerText ?? "",
        FOCUSABLE,
      );
      expect(firstText.trim()).toBe("Exit counter");
      await expect(page.getByTestId("register-clerk")).not.toBeEmpty();
      await expect(page.getByTestId("register-store")).not.toBeEmpty();
      expect(await overflow(page), "no horizontal overflow").toBeLessThanOrEqual(0);

      // the shell's own controls are still here: the user menu (Sign out), the bell and the palette
      await expect(header.getByRole("button", { name: /notifications/i })).toBeVisible();
      await header.getByLabel("Open user menu").click();
      await expect(page.getByRole("menuitem", { name: /Sign out/i })).toBeVisible();
      await page.keyboard.press("Escape");

      if (hasRail) {
        // 64 px collapsed rail; the peek expands it and never writes the saved preference
        await expect.poll(() => railWidth(page)).toBe(64); // the width eases over 200 ms
        expect(await savedSidebar(page)).toBe("false");
        await page.getByRole("button", { name: "Peek navigation" }).click();
        await expect.poll(() => railWidth(page)).toBe(240);
        expect(await savedSidebar(page)).toBe("false");
        await page.getByRole("button", { name: "Hide navigation" }).click();
        await expect.poll(() => railWidth(page)).toBe(64);
        expect(await savedSidebar(page)).toBe("false");
      }

      // Exit with an empty cart: straight back to where we came from, and the saved rail is restored
      await page.getByRole("button", { name: "Exit counter" }).click();
      await expect(page).toHaveURL(/\/orders$/);
      await expect(page.getByTestId("register-header")).toHaveCount(0);
      if (hasRail) await expect.poll(() => railWidth(page)).toBe(240);
      expect(await savedSidebar(page)).toBe("false");

      // Exit with lines: the guard
      await enterCounterFromNav(page, vp.width);
      const scanField = page.getByLabel("Scan or search items");
      await expect(scanField).toBeVisible({ timeout: 15_000 });
      await scanField.fill(sku);
      await scanField.press("Enter");
      // the list shows a "No items yet." placeholder row only while the cart is empty: count only real lines
      const lineRows = page
        .getByRole("list", { name: "Items" })
        .getByRole("listitem")
        .filter({ hasNotText: "No items yet" });
      await expect(lineRows).toHaveCount(1, { timeout: 15_000 });

      await page.getByRole("button", { name: "Exit counter" }).click();
      await expect(page.getByText("Discard this sale?")).toBeVisible();
      // W-710: the dialog eases out on the way in (about 200 ms), never the linear default
      const motion = await page.getByRole("dialog").evaluate((el) => ({
        fn: getComputedStyle(el).animationTimingFunction,
        duration: getComputedStyle(el).animationDuration,
      }));
      expect(motion.fn, "an ease-out curve, not linear").not.toBe("linear");
      expect(motion.fn).toMatch(/ease-out|cubic-bezier\(0, ?0, 0\.2, ?1\)/);
      expect(motion.duration).toBe("0.2s");
      await expect(page.getByRole("button", { name: "Keep selling" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByText("Discard this sale?")).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`${COUNTER}$`));
      await expect(lineRows).toHaveCount(1); // Escape keeps the cart

      await page.getByRole("button", { name: "Exit counter" }).click();
      await page.getByRole("button", { name: "Discard", exact: true }).click();
      await expect(page).toHaveURL(/\/orders$/);
    });

    test("the device preference opens the counter at /dashboard, once", async ({
      page,
      context,
    }) => {
      await setTenantCookie(context, BASE);
      await page.goto("/orders");
      try {
        await page.getByLabel("Open user menu").click();
        const item = page.getByRole("menuitemcheckbox", {
          name: "Open the counter on this device",
        });
        await expect(item).toHaveAttribute("aria-checked", "false");
        await item.click();
        expect(await page.evaluate(() => localStorage.getItem("rf-open-counter"))).toBe("true");

        await page.goto("/dashboard");
        await expect(page).toHaveURL(new RegExp(`${COUNTER}$`), { timeout: 20_000 });
        await expect(page.getByText("Counter opened", { exact: true })).toBeVisible();

        // Exit lands on /dashboard and stays there (the redirect is once per session)
        await page.getByRole("button", { name: "Exit counter" }).click();
        await expect(page).toHaveURL(/\/dashboard$/);
        await page.waitForTimeout(1500);
        await expect(page).toHaveURL(/\/dashboard$/);

        // any other path is never redirected
        await page.goto("/orders");
        await expect(page).toHaveURL(/\/orders$/);
      } finally {
        await page.evaluate(() => localStorage.removeItem("rf-open-counter"));
      }
    });
  });
}

// ── Row 676 / W-717 / F01 / BUILD-BRIEF 1.5: the sale line says what it sells, and its controls share one weight ──────────
// Written for the local lane (not run by the builder): the product is DISCOVERED, so every step reads the line it got
// (a plain product or a boxed one) and the boxed-only steps skip themselves on a plain product.
for (const vp of VIEWPORTS.filter((v) => v.name !== "1024")) {
  test.describe(`counter line says what it sells @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });
    const touch = vp.width < 1024;

    const lineRows = (page: Page) =>
      page.getByRole("list", { name: "Items" }).getByRole("listitem").filter({
        hasNotText: "No items yet",
      });

    async function openCounterWithLine(
      page: Page,
      context: Parameters<typeof setTenantCookie>[0],
      scan: (sku: string) => string,
    ) {
      await setTenantCookie(context, BASE);
      await page.goto("/orders");
      const sku = await discoverSku(page);
      await enterCounterFromNav(page, vp.width);
      const scanField = page.getByLabel("Scan or search items");
      await expect(scanField).toBeVisible({ timeout: 15_000 });
      await scanField.fill(scan(sku));
      await scanField.press("Enter");
      await expect(lineRows(page)).toHaveCount(1, { timeout: 15_000 });
      return { sku, scanField, row: lineRows(page).first() };
    }

    async function discardSale(page: Page) {
      await page.getByRole("button", { name: "Exit counter" }).click();
      await page.getByRole("button", { name: "Discard", exact: true }).click();
      await expect(page).toHaveURL(/\/orders$/);
    }

    test("one stepper with its unit always named, and one weight for the line's controls", async ({
      page,
      context,
    }) => {
      const { row } = await openCounterWithLine(page, context, (sku) => sku);

      // ONE stepper: minus, count, plus (no row of four step buttons), and the unit word is on the line
      const stepper = row.getByRole("group", { name: /^Quantity of / });
      await expect(stepper.getByRole("button")).toHaveCount(2);
      await expect(stepper.getByRole("spinbutton")).toHaveCount(1);
      await expect(row.getByTestId("line-sell-unit")).toHaveText(/^\d+ \S+/);
      expect(await overflow(page), "no horizontal overflow").toBeLessThanOrEqual(0);

      // the stepper is the one bordered control; Add note and remove are quiet (no border), still 44 px on touch widths
      const border = (loc: ReturnType<Page["locator"]>) =>
        loc.evaluate((el) => parseFloat(getComputedStyle(el).borderTopWidth));
      expect(await border(stepper)).toBeGreaterThan(0);
      const addNote = row.getByRole("button", { name: /^Add a note to / });
      const remove = row.getByRole("button", { name: /^Remove (?!a |one )/ });
      for (const quiet of [addNote, remove]) {
        expect(await border(quiet), "a quiet control draws no box").toBe(0);
        if (touch) {
          const box = (await quiet.boundingBox())!;
          expect(box.height, "a 44 px touch target").toBeGreaterThanOrEqual(43.5);
        }
      }
      expect(await remove.locator("svg").count(), "remove is an icon").toBe(1);
      expect((await remove.innerText()).trim()).toBe("");

      // no stray white block on the line: the row, the stepper and its buttons paint no background of their own
      const paints = await row.evaluate((li) => {
        const white = (el: Element) => {
          const c = getComputedStyle(el).backgroundColor;
          return c === "rgb(255, 255, 255)" || c === "rgba(255, 255, 255, 1)";
        };
        return [li, ...li.querySelectorAll('[role="group"], [role="group"] > *')].filter(white)
          .length;
      });
      expect(paints, "no white band behind the line's controls").toBe(0);

      await discardSale(page);
    });

    test("a quantity prefix (2*code, 2x code, 2 x code) puts that many on the line", async ({
      page,
      context,
    }) => {
      const { sku, scanField, row } = await openCounterWithLine(page, context, (s) => `2*${s}`);
      await expect(row.getByTestId("line-sell-unit")).toHaveText(/^2 \S+/);

      // a second prefix form merges into the same line: 2 + 3
      await scanField.fill(`3 x ${sku}`);
      await scanField.press("Enter");
      await expect(row.getByTestId("line-sell-unit")).toHaveText(/^5 \S+/);
      await expect(lineRows(page)).toHaveCount(1);

      await scanField.fill(`1X ${sku}`);
      await scanField.press("Enter");
      await expect(row.getByTestId("line-sell-unit")).toHaveText(/^6 \S+/);

      // a bare number still sets the quantity for the NEXT scan
      await scanField.fill("2");
      await scanField.press("Enter");
      await scanField.fill(sku);
      await scanField.press("Enter");
      await expect(row.getByTestId("line-sell-unit")).toHaveText(/^8 \S+/);

      await discardSale(page);
    });

    test("a boxed product: Box and Each switch what the stepper counts, and the total never moves", async ({
      page,
      context,
    }) => {
      const { row } = await openCounterWithLine(page, context, (sku) => sku);
      const soldBy = row.getByRole("group", { name: /^Sold by, / });
      test.skip((await soldBy.count()) === 0, "the discovered product is not case-packed");

      const total = page.getByTestId("running-total");
      const before = (await total.innerText()).trim();
      const unitLabel = row.getByTestId("line-sell-unit");
      const boxed = (await unitLabel.innerText()).trim();

      await soldBy.getByRole("button", { name: /by the each$/ }).click();
      await expect(unitLabel).toHaveText(/^\d+ each$/);
      await expect(total, "switching the unit never moves the money").toHaveText(before);

      // one piece up: loose pieces now, so Box is unavailable until they are gone, and the total went up by a piece
      await row.getByRole("button", { name: /^Add a piece to / }).click();
      await expect(soldBy.getByRole("button", { name: /^Sell .* by the (?!each)/ })).toBeDisabled();
      await row.getByRole("button", { name: /^Remove a piece from / }).click();
      await expect(total).toHaveText(before);

      // back to whole boxes: the original reading returns
      await soldBy.getByRole("button", { name: /^Sell .* by the (?!each)/ }).click();
      await expect(unitLabel).toHaveText(boxed);

      await discardSale(page);
    });
  });
}
