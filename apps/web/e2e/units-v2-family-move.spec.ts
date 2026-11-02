/**
 * SA-1082 A-1, VM-E: a family save asks, moves only the variants it names, and a variant says where its price comes from.
 *
 * LOCAL LANE ONLY (project `units-v2`), on the approved test tenant. Each run makes its own throwaway family
 * (E2E-MOVE-*) over the API and removes it afterwards.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { k11BaseUrl } from "./helpers/k11-l2-a-base";
import { VIEWPORTS, productBySku, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const visible = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]:visible`);

for (const vp of VIEWPORTS) {
  test.describe(`SA-1082 family move @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("the question, the one moved variant, the words, and Use family prices", async ({
      page,
      context,
    }, info) => {
      test.setTimeout(180_000);
      await setTenantCookie(context, k11BaseUrl());
      const ctx = await requireUnitsV2Flag(page);
      const stamp = `${vp.name}-${Date.now()}`;
      const familyName = `E2E Move Family ${stamp}`;
      const skuAt = `E2E-MOVE-AT-${stamp}`;
      const skuOff = `E2E-MOVE-OFF-${stamp}`;

      const made = await page.request.post(`${ctx.api}/products/families`, {
        headers: ctx.headers,
        data: {
          family: { name: familyName, pricePerUnit: "24.00" },
          variants: [
            { name: "At the family price", sku: skuAt, pricePerUnit: "24.00" },
            { name: "Its own price", sku: skuOff, pricePerUnit: "24.00" },
          ],
        },
      });
      expect(made.ok(), `POST /products/families returned ${made.status()}`).toBe(true);
      const at = await productBySku(page, ctx, skuAt);
      const off = await productBySku(page, ctx, skuOff);
      const familyId = (at as unknown as { parentProductId: string }).parentProductId;

      const patch = async (id: string, data: Record<string, unknown>) => {
        const res = await page.request.patch(`${ctx.api}/products/${id}`, {
          headers: ctx.headers,
          data,
        });
        expect(res.status(), `PATCH ${JSON.stringify(data)}`).toBeLessThan(300);
      };
      const read = async (id: string) => {
        const res = await page.request.get(`${ctx.api}/products/${id}`, { headers: ctx.headers });
        const p = (await res.json()) as { pricePerUnit: unknown; priceTier2: unknown };
        return { retail: Number(p.pricePerUnit), tier2: Number(p.priceTier2) };
      };
      const saveFamily = async () => {
        await page
          .locator("button:visible", { hasText: /^Save$/ })
          .first()
          .click();
      };
      const openFamilyEdit = async (retail: string) => {
        await page.goto(`/products/${familyId}`);
        await page.getByTitle("Edit product").click();
        return page.locator(`input[value="${retail}"]:visible`).first();
      };

      try {
        // A variant's own price saves in either mode (VM-6).
        await patch(off.id, { pricePerUnit: "30.00" });
        await patch(at.id, { priceTier2: "22.00" });
        await patch(familyId, { priceTier2: "22.00" });

        // The question names the one variant at the family's price.
        const retail = await openFamilyEdit("24.00");
        await retail.fill("26");
        await saveFamily();
        await expect(page.getByTestId("family-move-list")).toBeVisible({ timeout: 20_000 });
        await expect(page.getByRole("dialog")).toContainText(
          "Move the variant at $24.00 to $26.00?",
        );
        await expect(page.getByRole("dialog")).toContainText("At the family price");
        await expect(page.getByRole("dialog")).not.toContainText("Its own price");
        await shot(page, info, "sa-1082-move-question");

        const patched = page.waitForResponse(
          (r) => r.url().endsWith(`/products/${familyId}`) && r.request().method() === "PATCH",
        );
        await page.getByTestId("family-move-confirm").click();
        expect((await patched).status(), "the family save was accepted").toBeLessThan(300);
        await expect(page.getByText("1 variant moved.").first()).toBeVisible();
        await expect.poll(async () => (await read(at.id)).retail).toBe(26);
        expect((await read(off.id)).retail, "a variant with its own price stays").toBe(30);
        await shot(page, info, "sa-1082-move-saved");

        // The words: the moved variant reads Family, the other Set.
        const rowOf = () => visible(page, vp.cards ? "units-v2-card-pack" : "units-v2-row-pack");
        await page.goto(`/products/${at.id}`);
        await expect(page.getByTestId("units-v2-grid")).toBeVisible({ timeout: 20_000 });
        await expect(rowOf()).toContainText("Family");
        await expect(page.getByTestId("units-v2-use-family-prices")).toHaveCount(0);
        await rowOf().scrollIntoViewIfNeeded();
        await shot(page, info, "sa-1082-move-word-family");

        await page.goto(`/products/${off.id}`);
        await expect(page.getByTestId("units-v2-grid")).toBeVisible({ timeout: 20_000 });
        await expect(rowOf()).toContainText("Set");
        await expect(rowOf()).not.toContainText("Family");
        await rowOf().scrollIntoViewIfNeeded();
        await shot(page, info, "sa-1082-move-word-set");

        // Use family prices takes all five, in the draft first.
        await page.getByTestId("units-v2-use-family-prices").click();
        await expect(rowOf()).toContainText("Family");
        await rowOf().scrollIntoViewIfNeeded();
        await shot(page, info, "sa-1082-move-use-family-draft");
        const saved = page.waitForResponse(
          (r) => r.url().endsWith(`/products/${off.id}/prices`) && r.request().method() === "POST",
        );
        await page.getByTestId("units-v2-eb-save").click();
        expect((await saved).status(), "Use family prices saved").toBeLessThan(300);
        await expect(rowOf()).toContainText("Family");
        expect(await read(off.id)).toEqual({ retail: 26, tier2: 22 });

        // The products list asks too. Its table only fits the wide layout.
        if (!vp.cards) {
          await page.goto(`/products?search=${encodeURIComponent(familyName)}`);
          await page.getByRole("button", { name: "Quick Edit", exact: true }).click();
          const row = page.getByRole("row", { name: new RegExp(familyName) });
          await page.waitForLoadState("networkidle");
          await row.getByText("22.00").first().click();
          expect(page.url(), "clicking the cell stays on the list").toContain("/products?");
          const box = row.locator('input[value="22.00"]');
          await box.fill("21");
          await page.keyboard.press("Enter");
          await expect(page.getByRole("dialog")).toContainText(
            "Move the 2 variants at the family's prices?",
          );
          await shot(page, info, "sa-1082-move-list-question");
          await page.getByTestId("family-move-confirm").click();
          await expect.poll(async () => (await read(at.id)).tier2).toBe(21);
          expect((await read(off.id)).tier2).toBe(21);

          // Undo asks the same question, and Move takes the variants back with the family (A-5, VM-15).
          await page.getByTitle("Undo last change").click();
          await expect(page.getByRole("dialog")).toContainText(
            "Move the 2 variants at the family's prices?",
          );
          await shot(page, info, "sa-1082-move-list-undo");
          await page.getByTestId("family-move-confirm").click();
          await expect(page.getByText("2 variants moved.").first()).toBeVisible();
          await expect.poll(async () => (await read(familyId)).tier2).toBe(22);
          expect((await read(at.id)).tier2, "Undo took the moved variant back").toBe(22);
          expect((await read(off.id)).tier2, "Undo took the moved variant back").toBe(22);
        }

        // Closing the question saves nothing, and the form stays open.
        const again = await openFamilyEdit("26.00");
        await again.fill("27");
        await saveFamily();
        await expect(page.getByTestId("family-move-list")).toBeVisible({ timeout: 20_000 });
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("family-move-list")).toHaveCount(0);
        expect((await read(familyId)).retail, "closing saved nothing").toBe(26);
        await expect(page.locator("button:visible", { hasText: /^Save$/ }).first()).toBeVisible();

        // Keep their prices saves the family alone.
        await saveFamily();
        await expect(page.getByTestId("family-move-list")).toBeVisible({ timeout: 20_000 });
        await page.getByTestId("family-move-keep").click();
        await expect.poll(async () => (await read(familyId)).retail).toBe(27);
        expect((await read(at.id)).retail, "Keep left the variant").toBe(26);
        expect((await read(off.id)).retail, "Keep left the variant").toBe(26);
      } finally {
        for (const id of [at.id, off.id, familyId]) {
          await page.request
            .delete(`${ctx.api}/products/${id}`, { headers: ctx.headers })
            .catch(() => undefined);
        }
      }
    });

    test("VM-15: a null price reads as unchanged, at the endpoint and in an Undo", async ({
      page,
      context,
    }) => {
      test.skip(vp.cards, "the list's table only fits the wide layout");
      test.setTimeout(120_000);
      await setTenantCookie(context, k11BaseUrl());
      const ctx = await requireUnitsV2Flag(page);
      const stamp = `${vp.name}-${Date.now()}`;
      const familyName = `E2E Null Family ${stamp}`;
      const sku = `E2E-NULL-${stamp}`;
      const made = await page.request.post(`${ctx.api}/products/families`, {
        headers: ctx.headers,
        data: {
          family: { name: familyName, pricePerUnit: "24.00" },
          variants: [{ name: "At the family price", sku, pricePerUnit: "24.00" }],
        },
      });
      expect(made.ok(), `POST /products/families returned ${made.status()}`).toBe(true);
      const at = await productBySku(page, ctx, sku);
      const familyId = (at as unknown as { parentProductId: string }).parentProductId;
      const read = async (id: string) => {
        const res = await page.request.get(`${ctx.api}/products/${id}`, { headers: ctx.headers });
        const p = (await res.json()) as { priceTier2: unknown; priceTier3: unknown };
        return { tier2: Number(p.priceTier2), tier3: Number(p.priceTier3) };
      };
      const previewSent = () =>
        page.waitForResponse(
          (r) => r.url().endsWith("/family-moves/preview") && r.request().method() === "POST",
        );
      const row = page.getByRole("row", { name: new RegExp(familyName) });
      const openList = async () => {
        await page.goto(`/products?search=${encodeURIComponent(familyName)}`);
        await page.getByRole("button", { name: "Quick Edit", exact: true }).click();
        await page.waitForLoadState("networkidle");
      };
      const editTier2 = async (to: string) => {
        await row.getByText("22.00").first().click();
        await row.locator('input[value="22.00"]').fill(to);
        await page.keyboard.press("Enter");
      };

      try {
        for (const id of [familyId, at.id]) {
          const res = await page.request.patch(`${ctx.api}/products/${id}`, {
            headers: ctx.headers,
            data: { priceTier2: "22.00" },
          });
          expect(res.status(), "seed Tier 2").toBeLessThan(300);
        }

        // The endpoint itself, over HTTP through the running API's pipe.
        const direct = await page.request.post(
          `${ctx.api}/products/${familyId}/family-moves/preview`,
          { headers: ctx.headers, data: { priceTier3: null } },
        );
        expect(direct.status(), "a null tier is not refused").toBe(201);
        expect(((await direct.json()) as { count: number }).count).toBe(0);
        expect(await read(familyId), "the read wrote nothing").toEqual({ tier2: 22, tier3: 0 });

        // An Undo holding a null (page.tsx: productAsRecord[k] ?? null). A stored tier is never null, so the list's row
        // is served without Tier 3 to reach that branch; the API it talks to is the real one.
        await page.route(
          (url) => url.pathname.endsWith("/api/v1/products"),
          async (route) => {
            const res = await route.fetch();
            const body = await res.json();
            for (const p of (body.data ?? body.items ?? body) as Record<string, unknown>[]) {
              delete p.priceTier3;
            }
            await route.fulfill({ response: res, json: body });
          },
        );
        await openList();
        await editTier2("21");
        await page.getByTestId("family-move-confirm").click();
        await expect.poll(async () => (await read(at.id)).tier2).toBe(21);
        expect((await read(familyId)).tier3, "Tier 3 followed").toBe(21);

        const undoRead = previewSent();
        await page.getByTitle("Undo last change").click();
        const sent = await undoRead;
        expect(sent.request().postDataJSON().priceTier3, "the Undo sends the null").toBeNull();
        expect(sent.status(), "and it is not refused").toBe(201);
        await page.getByTestId("family-move-confirm").click();
        await expect
          .poll(async () => (await read(familyId)).tier2, "Undo took Tier 2 back")
          .toBe(22);
        expect((await read(at.id)).tier2, "Undo took the variant back").toBe(22);
        expect((await read(familyId)).tier3, "the null left Tier 3 as it was").toBe(21);
      } finally {
        for (const id of [at.id, familyId]) {
          await page.request
            .delete(`${ctx.api}/products/${id}`, { headers: ctx.headers })
            .catch(() => undefined);
        }
      }
    });
  });
}
