/**
 * #2338: logs in the two parity buyers (the local `test` seed's fixtures,
 * scripts/native-parity/fixtures.cjs) and saves one storage state per capture state:
 * loaded = PARITY_BUYER, empty = PARITY_BUYER_EMPTY. The config already refused a non-local base
 * URL; a buyer that cannot log in means the `test` seed has not run (npm run local:seed).
 */
import fs from "fs";
import path from "path";
import { test as setup, type Page } from "@playwright/test";
import { parityStateFile } from "./parity-auth";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  PARITY_BUYER,
  PARITY_BUYER_EMPTY,
} = require("../../../../scripts/native-parity/fixtures.cjs");

async function loginBuyer(page: Page, email: string, password: string, file: string) {
  await page.goto("/buyer/login");
  await page.getByPlaceholder("Enter your email").fill(email);
  await page.getByPlaceholder("Enter your password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
  const failed = page.getByText(/invalid email or password|login failed/i).first();
  const outcome = await Promise.race([
    page.waitForURL("**/buyer/portal", { timeout: 30_000 }).then(() => "portal" as const),
    failed.waitFor({ timeout: 30_000 }).then(() => "error" as const),
  ]);
  if (outcome === "error") {
    throw new Error(`parity buyer ${email} could not log in: run \`npm run local:seed\` first`);
  }
  await page.locator('button[data-testid="seller-card"]').first().click();
  await page.waitForURL("**/buyer/portal/*/orders", { timeout: 60_000 });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.context().storageState({ path: file });
}

setup("log in the loaded parity buyer", async ({ page }) => {
  await loginBuyer(page, PARITY_BUYER.email, PARITY_BUYER.password, parityStateFile("loaded"));
});

setup("log in the empty parity buyer", async ({ page }) => {
  await loginBuyer(
    page,
    PARITY_BUYER_EMPTY.email,
    PARITY_BUYER_EMPTY.password,
    parityStateFile("empty"),
  );
});
