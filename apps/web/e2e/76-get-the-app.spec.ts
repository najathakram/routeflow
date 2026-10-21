/**
 * Row 559 (76): the signed-in "Get the app" page, end to end.
 *   super admin sets the three links over PUT /platform-admin/app-links -> operator: avatar menu -> "Get the app"
 *   -> three buttons -> clear the iPhone link -> two buttons -> clear all -> the empty copy and no menu item.
 * At 390 / 768 / 1280 px: no horizontal overflow, one screenshot each (test-results/ only, never committed).
 *
 * LOCAL LANE ONLY, same guards as 71: it writes platform config. The previous three links are read first and put
 * back in afterAll. The links are example.test URLs; nothing is installed or downloaded (the buttons are never clicked).
 * Needs `npm run local:sa` (PLAYWRIGHT_SA_USERNAME / PLAYWRIGHT_SA_PASSWORD) for the super-admin login.
 */
import { test, expect, type Page } from "@playwright/test";
import { assertLocalFulfilmentTarget } from "../lib/local-fulfilment-guard";
import { apiBase } from "./helpers/api";
import { assertNoOverflow, waitForDataLoaded } from "./helpers/overflow";
import { localTarget } from "./helpers/local-fulfilment-profile";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const API = () => `${apiBase(BASE)}/api/v1`;
const LINKS = {
  androidApkUrl: "https://example.test/rf-e2e/app.apk",
  playStoreUrl: "https://example.test/rf-e2e/play",
  iosUrl: "https://example.test/rf-e2e/ios",
};
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1280", width: 1280, height: 800 },
] as const;
const INSTALL_LINK = /download for android|get it on google play|get it for iphone/i;

type Links = { androidApkUrl: string | null; playStoreUrl: string | null; iosUrl: string | null };

let saToken = "";
let previous: Links | null = null;

async function saFetch(method: "GET" | "PUT", body?: unknown): Promise<Links> {
  const res = await fetch(`${API()}/platform-admin/app-links`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${saToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} /platform-admin/app-links -> ${res.status}`);
  return (await res.json()) as Links;
}

/** "" clears a link (the server deletes the row); null from the snapshot clears too. */
const setLinks = (links: Links) => saFetch("PUT", links);

test.beforeAll(async () => {
  assertLocalFulfilmentTarget(localTarget(apiBase(BASE)));
  const username = process.env.PLAYWRIGHT_SA_USERNAME;
  const password = process.env.PLAYWRIGHT_SA_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "PLAYWRIGHT_SA_USERNAME / PLAYWRIGHT_SA_PASSWORD are not set: run `npm run local:sa` once.",
    );
  }
  const login = await fetch(`${API()}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!login.ok) throw new Error(`super-admin login -> ${login.status}`);
  saToken = ((await login.json()) as { accessToken: string }).accessToken;
  previous = await saFetch("GET");
  await setLinks(LINKS);
});

test.afterAll(async () => {
  if (!saToken || !previous) return;
  await setLinks(previous);
});

async function openGetTheApp(page: Page) {
  await page.goto("/dashboard");
  await page.getByLabel("Open user menu").click();
  await page.getByRole("menuitem", { name: "Get the app" }).click();
  await page.waitForURL("**/get-the-app");
  await expect(page.getByRole("heading", { name: "Android" })).toBeVisible();
}

test.describe("Get the app page", () => {
  test("operator: avatar menu -> Get the app -> three buttons", async ({ page }) => {
    await openGetTheApp(page);
    await expect(page.getByRole("link", { name: INSTALL_LINK })).toHaveCount(3);
    await expect(page.getByRole("link", { name: "Download for Android" })).toHaveAttribute(
      "href",
      LINKS.androidApkUrl,
    );
    await expect(page.getByRole("link", { name: "Get it on Google Play" })).toHaveAttribute(
      "target",
      "_blank",
    );
  });

  for (const vp of VIEWPORTS) {
    test(`no horizontal overflow at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/get-the-app");
      await expect(page.getByRole("link", { name: INSTALL_LINK })).toHaveCount(3);
      await waitForDataLoaded(page);
      await assertNoOverflow(page, `get-the-app ${vp.name}`);
      await page.screenshot({ path: `test-results/get-the-app-${vp.name}.png`, fullPage: true });
    });
  }

  test("clearing the iPhone link leaves two buttons; clearing all shows the empty copy and no menu item", async ({
    page,
  }) => {
    await setLinks({ ...LINKS, iosUrl: null });
    await page.goto("/get-the-app");
    await expect(page.getByRole("link", { name: INSTALL_LINK })).toHaveCount(2);
    await expect(page.getByRole("link", { name: "Get it for iPhone" })).toHaveCount(0);

    await setLinks({ androidApkUrl: null, playStoreUrl: null, iosUrl: null });
    await page.goto("/get-the-app");
    await expect(page.getByText("The app isn't available yet. Check back soon.")).toBeVisible();
    await expect(page.getByRole("link", { name: INSTALL_LINK })).toHaveCount(0);

    await page.goto("/dashboard");
    await page.getByLabel("Open user menu").click();
    await expect(page.getByRole("menuitem", { name: /Profile/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Get the app" })).toHaveCount(0);
  });
});
