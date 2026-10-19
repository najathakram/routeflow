/**
 * K11-17 (lane L2, price editing): a Raise preview that shows a lower price says why on that row.
 * NOT RUN in the authoring session (no browser there): the Jest proof is
 * units-v2/change-prices/AgainstReason.real.test.tsx (+ against-reason.test.ts, and explainMove in pricing.spec.ts).
 * Run on the local compose lane, project `units-v2`, at 1440 / 768 / 390.
 *
 * Role OPERATOR on the approved test tenant; fixture product E2E-FIX-UNITS (apps/api/scripts/e2e-seed.js): the product
 * itself is a REAL 1-piece unit (unit "Piece", no pack) with a real Case x12 unit row above it. E2E-FIX-CASEDEFAULT cannot
 * be used: its Piece is implicit, and since K11-11 the grid dashes a missing Piece and refuses to price it. The K9 shape
 * is made in the DRAFT only (a Set Tier 2 on the Piece, so the Case's Auto Tier 2 falls when
 * the Piece's Retail rises; the Piece anchors this ladder, so a Case Raise can never lower a Piece price); nothing is saved and the draft is discarded, so the fixture is untouched. The unit refs are
 * server ids the spec does not know, so the Piece is the last visible row (rows are largest unit
 * first, in the table and in the phone cards alike).
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { VIEWPORTS, productBySku, requireUnitsV2Flag } from "./helpers/units-v2-support";
import { UNITS_V2_IDS as ID } from "./helpers/units-v2-ids";

/** The base URL comes from the environment and is never defaulted: an unset one must stop the run, not hit a real site. */
function baseUrl(): string {
  const url = process.env.PLAYWRIGHT_BASE_URL;
  if (!url) throw new Error("PLAYWRIGHT_BASE_URL is not set; point it at the local stack.");
  return url;
}

const SKU = "E2E-FIX-UNITS";
const tierInputs = (page: Page, tier: number) =>
  page.locator(`[data-testid^="units-v2-input-"][data-testid$="-${tier}"]:visible`);
const visible = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]:visible`);

for (const vp of VIEWPORTS) {
  test.describe(`K11-17 a lower price in a Raise preview says why @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("the reason sits under the row, never beside it", async ({ page, context }) => {
      await setTenantCookie(context, baseUrl());
      const ctx = await requireUnitsV2Flag(page);
      const product = await productBySku(page, ctx, SKU);
      await page.goto(`/products/${product.id}`);
      await expect(page.getByTestId(ID.grid)).toBeVisible({ timeout: 20_000 });

      await visible(page, ID.btnEdit).click();
      // Piece Tier 2 is Set, so the Case's Auto Tier 2 keeps the Piece's tier ratio (Case Retail x Piece Tier 2 / Piece Retail);
      // raising the Piece's Retail then lowers that ratio and the Case's Auto Tier 2 falls. (A Case Raise cannot do it here:
      // the Piece anchors the ladder, so the Piece's Auto Tier 2 never follows the Case.) Proof: AgainstReason.e2e-fixture.test.ts.
      await tierInputs(page, 2).last().fill("1.5");

      await visible(page, ID.btnChange).click();
      // Scoped to the Change prices panel: "Unit" also matches the grid's own labelled controls (14 hits page-wide).
      const panel = page.locator("#change-panel");
      await panel.getByLabel("Unit", { exact: true }).selectOption({ label: "Piece" });
      await panel.getByLabel("Amount").fill("5");

      const preview = page.getByTestId(ID.changePreview);
      const against = preview.locator('tbody[data-against="true"]');
      await expect(against.first(), "the Case's Auto Tier 2 goes down on this Raise").toBeVisible();
      for (const group of await against.all()) {
        const rows = group.locator("tr");
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(1)).toContainText(/Follows .+, which you set\.|not moving\./);
        const [first, reason] = await Promise.all([
          rows.nth(0).boundingBox(),
          rows.nth(1).boundingBox(),
        ]);
        expect(reason!.y, "the reason starts below the row's figures").toBeGreaterThanOrEqual(
          first!.y + first!.height - 1,
        );
      }

      // leave the fixture alone
      await panel.locator("#ch-cancel").click();
      await page.getByTestId("units-v2-eb-cancel").click();
      await page.getByTestId("units-v2-eb-discard").click();
    });
  });
}
