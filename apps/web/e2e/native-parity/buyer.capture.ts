/**
 * #2338: WEB captures of every buyer screen in scripts/native-parity/screens.json, one PNG per
 * (screen, state) at 390x844, written beside the simulator captures:
 *   local-assets/proofs/<PARITY_DATE>/native-parity/buyer/<screen>-<state>-web.png
 * Run by scripts/native-parity/run.mjs; never part of the e2e suite (own config).
 */
import fs from "fs";
import path from "path";
import { test, expect } from "@playwright/test";
import { parityStateFile } from "./parity-auth";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const manifest = require("../../../../scripts/native-parity/screens.json");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { captureFile } = require("../../../../scripts/native-parity/paths.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PARITY_TENANT_SLUG } = require("../../../../scripts/native-parity/fixtures.cjs");

type Screen = { id: string; web: string; native: string; states: Array<"loaded" | "empty"> };

for (const screen of manifest.buyer as Screen[]) {
  for (const state of screen.states) {
    test.describe(`${screen.id} (${state})`, () => {
      test.use({ storageState: parityStateFile(state) });

      test(`capture ${screen.id}-${state}-web`, async ({ page }) => {
        const url = screen.web.replace("{seller}", PARITY_TENANT_SLUG);
        const response = await page.goto(url);
        expect(response?.status() ?? 200, `GET ${url}`).toBeLessThan(400);
        // Let data requests settle, then drop any loading indicator before the shot.
        await page.waitForLoadState("networkidle");
        await page
          .locator('[aria-busy="true"], [data-loading="true"]')
          .first()
          .waitFor({ state: "detached", timeout: 10_000 })
          .catch(() => undefined);
        const file = captureFile("buyer", screen.id, state, "web");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await page.screenshot({ path: file, fullPage: false });
      });
    });
  }
}
