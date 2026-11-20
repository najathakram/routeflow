/**
 * Wave 2, lane FT (first touch), project "site-waves": FT9. The first visit's source survives a click-through.
 * Land on /pricing with two tags, click to /, click "Start free trial": sessionStorage.rf_first_touch still holds
 * utm_source "test" and landingPath "/pricing", byte for byte, after every extra view. Signed out, desktop Chrome.
 */
import { test, expect } from "@playwright/test";
import { blockAnalytics } from "./helpers/site-proof";

test.beforeEach(async ({ context }) => {
  await blockAnalytics(context);
});

test("FT9 the first visit's source is kept through later views", async ({ page }) => {
  const read = () => page.evaluate(() => window.sessionStorage.getItem("rf_first_touch"));

  await page.goto("/pricing?utm_source=test&utm_medium=email", { waitUntil: "load" });
  const first = await read();
  expect(first, "the first view writes the record").not.toBeNull();
  const rec = JSON.parse(first as string) as Record<string, string>;
  expect(rec.utm_source).toBe("test");
  expect(rec.utm_medium).toBe("email");
  expect(rec.landingPath).toBe("/pricing");
  expect(new Date(rec.firstSeenAt).toISOString()).toBe(rec.firstSeenAt);

  // Click through to the home page (same site, no tags): nothing changes.
  await page.locator('a[href="/"]').first().click();
  await page.waitForURL((u) => u.pathname === "/");
  expect(await read()).toBe(first);

  // Then the sign-up link.
  await page.getByRole("link", { name: "Start free trial" }).first().click();
  await page.waitForURL((u) => u.pathname === "/signup");
  expect(await read()).toBe(first);

  // A view with other tags in the same tab does not overwrite it either.
  await page.goto("/pricing?utm_source=other&gclid=abc", { waitUntil: "load" });
  expect(await read()).toBe(first);
});
