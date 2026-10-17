/**
 * K11-22 (P05): the Details header's actions fold into one "More actions" menu below sm, at 1440 / 768 / 390.
 *   390: Edit and the three dots share one row (header <= 64 px); every action is reachable in <= 2 taps;
 *        Delete opens the confirm (never confirmed here).
 *   768 / 1440: the buttons are where they were; no More trigger.
 *
 * LOCAL LANE ONLY (project `k11-l3`). READ-ONLY: the delete confirm is cancelled. Role: OPERATOR on the approved
 * test tenant; fixture E2E-FIX-UNITS (a standalone product, so Make variant of... is offered).
 */
import { test, expect } from "@playwright/test";
import { VIEWPORTS, openFixtureProduct, shot } from "./k11-l3-support";

for (const vp of VIEWPORTS) {
  test.describe(`K11-22 header More menu @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("k11-l3 header actions: one row and a menu on phones, buttons from sm up", async ({
      page,
      context,
    }, info) => {
      await openFixtureProduct(page, context);
      const header = page
        .getByRole("heading", { name: "Details", exact: true })
        .locator("xpath=ancestor::div[contains(@class,'border-b')][1]");
      await expect(header).toBeVisible();
      const more = page.getByRole("button", { name: "More actions" });
      const edit = page.getByRole("button", { name: "Edit", exact: true });

      if (vp.width >= 640) {
        await expect(more).toBeHidden();
        for (const name of ["Make variant of…", "Deactivate", "Delete"]) {
          await expect(page.getByRole("button", { name })).toBeVisible();
        }
        await shot(page, info, "k11-22-header-wide");
        return;
      }

      // 390: one row. Edit first, the three dots last, both on the same line.
      await expect(more).toBeVisible();
      for (const name of ["Make variant of…", "Deactivate", "Delete"]) {
        await expect(page.getByRole("button", { name })).toBeHidden();
      }
      const h = (await header.boundingBox())!;
      const e = (await edit.boundingBox())!;
      const m = (await more.boundingBox())!;
      expect(h.height, "header is one row").toBeLessThanOrEqual(64);
      expect(Math.abs(e.y - m.y), "Edit and More share a top").toBeLessThanOrEqual(2);
      expect(e.x, "Edit comes first").toBeLessThan(m.x);
      expect(m.width, "44 px hit area").toBeGreaterThanOrEqual(44);
      expect(m.height).toBeGreaterThanOrEqual(44);
      await shot(page, info, "k11-22-header-phone");

      // Every action is reachable in two taps: open the menu, pick the item.
      await more.click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      const items = (await menu.getByRole("menuitem").allTextContents()).map((t) => t.trim());
      expect(items).toEqual(expect.arrayContaining(["Make variant of…", "Deactivate", "Delete"]));
      expect(items[items.length - 1], "Delete is last").toBe("Delete");
      await shot(page, info, "k11-22-menu-open");

      // Delete opens the confirm; Cancel returns focus to the three dots.
      await menu.getByRole("menuitem", { name: "Delete" }).click();
      const confirm = page.getByRole("dialog");
      await expect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: /cancel/i }).click();
      await expect(confirm).toBeHidden();
      await expect(more).toBeFocused();
    });
  });
}
