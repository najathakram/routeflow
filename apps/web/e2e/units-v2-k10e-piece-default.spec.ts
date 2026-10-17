/**
 * Units v2 (units-v2-k10e-piece-default): K10e, proven in a real browser at 1440 / 768 / 390.
 *  - F07: a product with no 1-piece unit gets one from the grid's "Add a Piece unit" pointer. The pointer opens
 *    Add a unit already set up as that Piece (Contains 1, name locked to the base name), and Add creates it.
 *  - F18: changing the Default order unit says so inline with an Undo; arrow keys only move focus; the message has
 *    no timer; Undo puts the old default back.
 *
 * LOCAL LANE ONLY (project `units-v2`). Role: OPERATOR on the approved test tenant. Fixture product E2E-FIX-CASEDEFAULT
 * (apps/api/scripts/e2e-seed.js ensureUnitsFixture): a Box of 24 whose Case is the default, with the Piece implicit
 * (no 1-piece unit). Both cases write and both put the fixture back in a `finally` (the throwaway Piece is deleted,
 * the Case is made the default again), logging instead of asserting.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { VIEWPORTS, productBySku, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const SKU = "E2E-FIX-CASEDEFAULT";
const ID = {
  grid: "units-v2-grid",
  pointer: "units-v2-add-unit-pointer",
  addPanel: "units-v2-add-panel",
  addName: "units-v2-add-name",
  addN: "units-v2-add-n",
  addSubmit: "units-v2-add-submit",
  note: "units-default-note",
};

async function openProduct(page: Page, context: Parameters<typeof setTenantCookie>[0]) {
  await setTenantCookie(context, BASE);
  const ctx = await requireUnitsV2Flag(page);
  const product = await productBySku(page, ctx, SKU);
  await page.goto(`/products/${product.id}`);
  await expect(page.getByTestId(ID.grid)).toBeVisible({ timeout: 20_000 });
  return { ...ctx, productId: product.id };
}

/** The table and the phone cards both render the pointer; only one is visible at a width. */
const visible = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]:visible`);

for (const vp of VIEWPORTS) {
  test.describe(`Units v2 K10e (Piece pointer, default Undo) @ ${vp.name}`, () => {
    test.describe.configure({ mode: "serial" });
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("F07: a missing Piece is added from the grid pointer (Contains 1, name locked to Piece)", async ({
      page,
      context,
    }, info) => {
      const ctx = await openProduct(page, context);
      try {
        const pointer = visible(page, ID.pointer);
        await expect(
          pointer,
          `${SKU} must have no 1-piece unit - run \`node apps/api/scripts/e2e-seed.js\` on a fresh DB`,
        ).toHaveCount(1);
        await pointer.click();

        await expect(page.getByTestId(ID.addPanel)).toBeVisible();
        await expect(page.getByTestId(ID.addN)).toHaveValue("1");
        await expect(page.getByTestId(ID.addName)).toHaveValue("Piece");
        await expect(page.getByTestId(ID.addName)).toHaveAttribute("readonly", "");
        await expect(page.getByTestId("units-v2-add-name-hint")).toContainText(
          'A 1-piece unit is always named "Piece".',
        );
        await shot(page, info, "k10e-piece-prefilled");

        const created = page.waitForResponse(
          (r) =>
            r.url().includes(`/products/${ctx.productId}/units`) && r.request().method() === "POST",
        );
        await page.getByTestId(ID.addSubmit).click();
        const res = await created;
        expect(res.status(), "the create call was accepted").toBeLessThan(300);
        expect(res.request().postDataJSON()).toEqual({ label: "Piece", factorToBase: 1 });

        await expect(page.getByTestId(ID.addPanel)).toHaveCount(0);
        // the Piece now exists: the grid has no "Add a Piece unit" pointer left
        await expect(visible(page, ID.pointer)).toHaveCount(0);
      } finally {
        try {
          const list = await page.request.get(`${ctx.api}/products/${ctx.productId}/units`, {
            headers: ctx.headers,
          });
          const units: Array<{ id: string; factorToBase: number }> = list.ok()
            ? await list.json()
            : [];
          for (const u of units.filter((x) => x.factorToBase === 1)) {
            await page.request.delete(`${ctx.api}/products/${ctx.productId}/units/${u.id}`, {
              headers: ctx.headers,
            });
          }
        } catch (e) {
          console.log("cleanup (delete throwaway Piece) failed:", e);
        }
      }
    });

    test("F18: the default order unit change shows an inline Undo with no timer; arrows move focus without saving", async ({
      page,
      context,
    }, info) => {
      const ctx = await openProduct(page, context);
      const radios = page.getByRole("radio", { name: "Default order unit" });
      const note = page.getByTestId(ID.note);
      try {
        await expect(radios).toHaveCount(2); // the Box (pack) row, then the Case
        await expect(radios.nth(1)).toBeChecked();
        await expect(note).toHaveAttribute("role", "status");
        await expect(note).toHaveText("");

        // an arrow key moves focus to the other radio and saves nothing
        const writes: string[] = [];
        page.on("request", (r) => {
          if (/\/products\/[^/]+\/units/.test(r.url()) && r.method() !== "GET")
            writes.push(r.method());
        });
        await radios.nth(1).focus();
        await page.keyboard.press("ArrowUp");
        await expect(radios.nth(0)).toBeFocused();
        await expect(radios.nth(1)).toBeChecked();
        await expect(note).toHaveText("");
        expect(writes, "an arrow key must not write").toEqual([]);

        // Space commits: the pack (Box) becomes the default, and the message says so with an Undo
        await page.keyboard.press("Space");
        await expect(note).toHaveText("Box is now the default order unit.");
        await expect(radios.nth(0)).toBeChecked();
        const undo = page.getByRole("button", { name: "Undo", exact: true });
        await expect(undo).toBeVisible();
        await expect(page.getByRole("button", { name: /dismiss/i })).toBeVisible();
        await shot(page, info, "k10e-default-undo");

        // no timer: still there well past 10 seconds
        await page.waitForTimeout(11_000);
        await expect(note).toHaveText("Box is now the default order unit.");
        await expect(undo).toBeVisible();

        // Undo puts the Case back with one write, and announces it
        writes.length = 0;
        await undo.click();
        await expect(note).toHaveText("Case is the default order unit again.");
        await expect(radios.nth(1)).toBeChecked();
        await expect(undo).toHaveCount(0);
        expect(writes, "Undo is one write").toEqual(["PATCH"]);

        // Dismiss clears the message
        await page.getByRole("button", { name: /dismiss/i }).click();
        await expect(note).toHaveText("");
      } finally {
        try {
          const list = await page.request.get(`${ctx.api}/products/${ctx.productId}/units`, {
            headers: ctx.headers,
          });
          const units: Array<{ id: string; label: string; isDefaultSelling: boolean }> = list.ok()
            ? await list.json()
            : [];
          const kase = units.find((u) => u.label === "Case");
          if (kase && !kase.isDefaultSelling) {
            await page.request.patch(`${ctx.api}/products/${ctx.productId}/units/${kase.id}`, {
              headers: ctx.headers,
              data: { isDefaultSelling: true },
            });
          }
        } catch (e) {
          console.log("cleanup (restore Case default) failed:", e);
        }
      }
    });
  });
}
