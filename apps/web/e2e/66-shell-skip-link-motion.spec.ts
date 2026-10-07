/**
 * PKG-6 (apple-ux F18 + reduced motion) — the dashboard shell, in a real browser.
 *
 *  - Skip to content: Tab -> Enter writes NO hash/history entry (one Back leaves the page), focus
 *    lands on <main id="main-content"> (1440 + 390).
 *  - Reduced motion: under prefers-reduced-motion the rail aside's computed transition-duration is
 *    0s (the committed motion pin, 1440 only — the rail is `hidden` below lg); without it the
 *    width transition is a real, non-zero duration (control).
 *  - No-regress pins for the shell's features: operator nav (labels, Dispatch group gated on the
 *    tenant's routes/delivery addons), the collapse toggle + its persisted state, the mobile drawer,
 *    and the g-prefix shortcuts.
 *
 * Role: OPERATOR (pre-authenticated). Tenant: the approved e2e seed. READ-ONLY.
 * Coverage limit: driver/customer role nav and a distinct TENANT_ADMIN login are not pinned (no
 * such storage state; this change does not touch those navs).
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

test.beforeEach(async ({ context }) => {
  await setTenantCookie(context, BASE);
});

async function ready(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("#main-content")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
}

async function skipFromTab(page: Page) {
  // A fresh navigation leaves focus on the document, so the first Tab stop is the skip link.
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
}

for (const vp of [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
]) {
  test.describe(`skip link @${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("Tab -> Enter focuses main, writes no hash, one Back leaves the page", async ({
      page,
    }) => {
      await ready(page, "/dashboard");
      await ready(page, "/customers");
      const urlBefore = page.url();

      await skipFromTab(page);

      await expect(page.locator("#main-content")).toBeFocused();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("main-content");
      expect(page.url()).toBe(urlBefore);
      expect(new URL(page.url()).hash).toBe("");

      await page.goBack();
      await expect(page).toHaveURL(/\/dashboard$/);
    });
  });
}

test.describe("reduced motion @1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const aside = (page: Page) => page.getByTestId("sidebar-aside");
  const duration = (page: Page) =>
    aside(page).evaluate((el) => getComputedStyle(el).transitionDuration);
  const toggle = (page: Page) => page.getByRole("button", { name: /^(Collapse|Expand) sidebar$/ });

  test("prefers-reduced-motion: the rail aside has a 0s transition-duration", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await ready(page, "/orders");
    await expect(aside(page)).toBeVisible();
    expect(await duration(page)).toBe("0s");
    await toggle(page).click();
    await toggle(page).click();
    expect(await duration(page)).toBe("0s");
  });

  test("control: without reduced motion the width transition is non-zero", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await ready(page, "/orders");
    expect(await duration(page)).toBe("0.2s");
  });
});

test.describe("shell no-regress @1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("operator nav labels, Dispatch group follows the tenant's addons, collapse persists", async ({
    page,
  }) => {
    await ready(page, "/dashboard");
    const token = await operatorAccessToken(page);
    test.skip(!token, "no operator token — auth setup did not run");
    const res = await page.request.get(`${apiBase(page.url())}/api/v1/tenants/me/addons`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { addons = [] } = (await res.json()) as { addons?: string[] };
    const dispatch = addons.includes("recurring_routes") || addons.includes("order_delivery");

    const nav = page.getByTestId("sidebar-aside").getByRole("navigation");
    for (const label of [
      "Dashboard",
      "Orders",
      "Customers",
      "Warehouse",
      "Finance",
      "Analytics",
      "Settings",
    ]) {
      await expect(nav.getByText(label, { exact: true }).first()).toBeVisible();
    }
    await expect(nav.getByText("Dispatch", { exact: true })).toHaveCount(dispatch ? 1 : 0);

    // Collapse toggle + persisted state across a reload.
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    expect(await page.evaluate(() => localStorage.getItem("rf-sidebar-collapsed"))).toBe("true");
    await page.reload();
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    expect(await page.evaluate(() => localStorage.getItem("rf-sidebar-collapsed"))).toBe("false");
  });

  test("g-prefix shortcuts: g then o -> /orders; a lone d does nothing; ignored in inputs", async ({
    page,
  }) => {
    await ready(page, "/dashboard");
    await page.keyboard.press("d");
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/\/dashboard$/);

    // The keydown listener attaches on hydration; retry the chord until it is live.
    await expect(async () => {
      await page.keyboard.press("g");
      await page.keyboard.press("o");
      await expect(page).toHaveURL(/\/orders$/, { timeout: 1_500 });
    }).toPass({ timeout: 15_000 });

    // Inside a text input the sequence is ignored.
    await ready(page, "/dashboard");
    await page.evaluate(() => {
      const i = document.createElement("input");
      i.id = "pkg6-probe";
      document.body.appendChild(i);
      i.focus();
    });
    await page.keyboard.type("go");
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});

test.describe("mobile drawer @390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("opens with the operator nav labels and closes", async ({ page }) => {
    await ready(page, "/dashboard");
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    const drawer = page.getByTestId("sidebar-drawer-aside");
    await expect(drawer).toBeVisible();
    for (const label of ["Dashboard", "Orders", "Customers", "Finance", "Settings"]) {
      await expect(drawer.getByText(label, { exact: true }).first()).toBeVisible();
    }
    await page.getByRole("button", { name: "Close navigation menu" }).click();
    await expect(drawer).toHaveCount(0);
  });
});
