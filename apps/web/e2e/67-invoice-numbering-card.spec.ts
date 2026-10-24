/**
 * B1188: Settings > Invoicing > Invoice Numbering. The prefix saves to the numbering sequence behind
 * a server PREVIEW + CONFIRM; the confirm reads "Next invoice: X (currently Y). Existing invoices
 * keep their numbers." Cancel sends nothing.
 *
 * Role: TENANT_ADMIN (pre-authenticated; the numbering card is admin-only). Tenant: the approved e2e-routeflow seed. READ-ONLY by design:
 * the spec never clicks Confirm, so no sequence is written; it asserts that no write request
 * (PUT /import/numbering/*, PATCH /settings*) leaves the page. Runs at 1440 / 768 / 390.
 */
import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

for (const width of [1440, 768, 390]) {
  test.describe(`Invoice numbering card @${width}`, () => {
    test.beforeEach(async ({ context, page }) => {
      await setTenantCookie(context, BASE);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    });

    test("renders every control; preview shows next + current format; Cancel writes nothing", async ({
      page,
    }) => {
      const writes: string[] = [];
      page.on("request", (r) => {
        if (["PUT", "PATCH", "POST", "DELETE"].includes(r.method())) {
          writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
        }
      });

      await page.goto("/settings?tab=invoicing");
      await expect(page.getByText("Invoice Numbering")).toBeVisible({ timeout: 20_000 });

      // Inventory: every control of the card and its terms neighbour.
      const prefix = page.getByLabel("Invoice Number Prefix");
      await expect(prefix).toBeVisible();
      await expect(page.getByLabel("Payment Due Days")).toBeVisible();
      await expect(page.getByLabel("Payment Terms")).toBeVisible();
      const save = page.getByRole("button", { name: "Save Numbering" });
      await expect(save).toBeVisible();

      const proofDir = process.env.PROOF_DIR;
      if (proofDir) await page.screenshot({ path: `${proofDir}/numbering-card-${width}.png` });

      // Preview: a clean prefix the sequence has never used.
      await prefix.fill("ZZB1188-");
      await save.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      await expect(
        dialog.getByText(/^Next invoice: ZZB1188-\d+ \(currently .+\)\. /),
      ).toBeVisible();
      await expect(dialog.getByText(/Existing invoices keep their numbers\./)).toBeVisible();
      if (proofDir) await page.screenshot({ path: `${proofDir}/numbering-confirm-${width}.png` });

      // Cancel: dialog closes, nothing was written.
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
      expect(writes, `unexpected write requests: ${writes.join(", ")}`).toEqual([]);
    });
  });
}
