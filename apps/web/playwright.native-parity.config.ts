/**
 * #2338 (T0.10): the WEB half of the native-parity proof harness. Deliberately NOT a project in
 * playwright.config.ts: CI and post-deploy run `npx playwright test` over every project there,
 * against production. This config is only ever run by scripts/native-parity/run.mjs, against the
 * local compose stack, and it refuses any non-local base URL before a single request.
 *
 *   PLAYWRIGHT_BASE_URL=http://localhost:3001 npx playwright test -c playwright.native-parity.config.ts
 *
 * Viewport 390x844 at DPR 3: the iPhone-width frame the simulator captures beside it.
 */
import { defineConfig } from "@playwright/test";
import { isLocalUrl } from "./lib/local-url";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL;
if (!BASE_URL || !isLocalUrl(BASE_URL)) {
  throw new Error(
    `native-parity captures run against the LOCAL stack only; PLAYWRIGHT_BASE_URL=${BASE_URL ?? "(unset)"}`,
  );
}

export default defineConfig({
  testDir: "./e2e/native-parity",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    browserName: "chromium",
    headless: !process.env.PLAYWRIGHT_HEADED,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: "parity-setup", testMatch: /parity\.setup\.ts/ },
    { name: "parity-capture", testMatch: /\.capture\.ts/, dependencies: ["parity-setup"] },
  ],
});
