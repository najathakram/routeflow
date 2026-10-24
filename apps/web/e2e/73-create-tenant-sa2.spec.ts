/**
 * SA-2 — Create Tenant: plain profile choice, review sheet, then the tenant's Overview.
 * Real backend, super-admin storage state. Creates ONLY a throwaway `ux-audit-*` tenant (an approved test slug).
 */
import { test, expect } from "@playwright/test";
import { HAS_SUPER_ADMIN_CREDS } from "./helpers/constants";

test.skip(!HAS_SUPER_ADMIN_CREDS, "PLAYWRIGHT_SA_USERNAME / PLAYWRIGHT_SA_PASSWORD not set");

test("SA-2 create ux-audit-pos tenant with the POS profile, review sheet, then Overview", async ({
  page,
}) => {
  const slug = `ux-audit-pos-${Date.now().toString(36)}`;
  await page.goto("/admin/tenants/new");
  await page.getByLabel("Slug").fill(slug);
  await page.getByLabel("Business Name").fill("UX Audit POS");
  await page.getByLabel("Admin Email").fill(`${slug}@example.test`);
  await page.getByLabel("Admin Username").fill("owner");
  await page.getByLabel("Time zone").fill("America/New_York");
  await page.getByRole("radio", { name: /POS only: counter sales/ }).check();
  await expect(page.getByText("Counter in the menu")).toBeVisible();

  // Create opens the review; nothing is created yet
  await page.getByRole("button", { name: "Create Tenant", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Create UX Audit POS?" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Counter sales on")).toBeVisible();
  await sheet.getByRole("button", { name: "Create Tenant" }).click();

  // The result banner takes focus, then the tenant opens on Overview
  const banner = page.getByTestId("create-banner");
  await expect(banner).toBeFocused();
  await expect(banner).toContainText("Tenant created successfully!");
  await banner.getByRole("link", { name: "Open UX Audit POS" }).click();
  await expect(page).toHaveURL(/\/admin\/tenants\/[^/]+\?tab=overview/);
});
