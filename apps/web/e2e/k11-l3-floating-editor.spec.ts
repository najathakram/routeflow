/**
 * K11-20c (lane L3): the floating price editor opened from the legacy "Units & prices" card and from Details.
 *
 * NOT RUN: written without a browser (Jest proves the behaviour in `ProductUnitsCard.k11-20c.test.tsx`,
 * `PriceWindowHost.test.tsx` and `page.k11-20c.test.tsx`). This spec carries the pixel and network claims and must be run
 * on the local compose stack (`npm run local:up` + `local:seed`, then `npm run local:e2e`), flag `flag.units_prices_v2`
 * ON, as the operator of an approved test tenant.
 *
 * It SAVES the Case (pack) Retail price on the seeded fixture product E2E-FIX-UNITS and puts it back (Undo, or the API in
 * a `finally`), so it leaves the product as it found it. The card shows the Case price at Retail only (K11-20 section 4
 * row 9), so Retail is the price changed here: it is the one price the card, the inline grid and Details all show.
 * A tenant not served the flag FAILS the spec (never a skip). Screenshots go under local-assets/proofs/units-v2.
 */
import { test, expect, type Page } from "@playwright/test";
import { UNITS_SKU, VIEWPORTS, openFixtureProduct, shot, type Ctx } from "./k11-l3-support";

const WIN = { name: "Edit prices" };
const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

type Row = { ref: string; label: string; kind: string; cells: { tier: number; value: number }[] };
async function packRetail(page: Page, ctx: Ctx, id: string) {
  const res = await page.request.get(`${ctx.api}/products/${id}/price-grid`, {
    headers: ctx.headers,
  });
  expect(res.ok(), `GET price-grid returned ${res.status()}`).toBe(true);
  const grid = (await res.json()) as { rows: Row[] };
  const pack = grid.rows.find((r) => r.kind === "pack")!;
  return { ref: pack.ref, label: pack.label, retail: pack.cells.find((c) => c.tier === 1)!.value };
}

/** Puts the product back to what it was, however the test ended (the product's own Retail column is the pack price). */
async function restore(page: Page, ctx: Ctx, id: string, name: string | null, retail: number) {
  const res = await page.request.patch(`${ctx.api}/products/${id}`, {
    headers: ctx.headers,
    data: { ...(name ? { name } : {}), pricePerUnit: retail.toFixed(2) },
  });
  if (!res.ok()) console.warn(`restore the product: ${res.status()}`);
}

const card = (page: Page) => page.locator("[data-units-card]");
const trigger = (page: Page) => card(page).getByRole("button", { name: "Edit prices" });
const win = (page: Page) => page.getByRole("dialog", WIN);

/** How many price boxes (the editor's inputs and the legacy card's inputs) are outside the window. */
const priceInputsOutside = (page: Page) =>
  page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const all = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid^="units-v2-input-"], input[aria-label$=" price"]',
      ),
    ];
    return all.filter((el) => !dlg?.contains(el)).length;
  });

const noHorizontalScroll = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  );

/** Types into the window's Case Retail box (the dialog's first Retail input for the pack row). */
async function typeRetail(page: Page, ref: string, value: number) {
  const box = win(page).locator(`[data-testid="units-v2-input-${ref}-1"]:visible`);
  await box.fill(value.toFixed(2));
  return box;
}

const savedPrices = (page: Page) =>
  page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      /\/products\/[^/]+\/prices$/.test(new URL(r.url()).pathname),
  );

for (const vp of VIEWPORTS) {
  test.describe(`K11-20c floating price editor @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("1. Edit prices opens the window, focused within 200 ms, with no horizontal page scroll", async ({
      page,
      context,
    }, info) => {
      await openFixtureProduct(page, context, UNITS_SKU);
      await expect(trigger(page)).toBeVisible();
      const t0 = Date.now();
      await trigger(page).click();
      await expect(win(page)).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => !!document.querySelector('[role="dialog"]')?.contains(document.activeElement),
          ),
        )
        .toBe(true);
      expect(Date.now() - t0, "visible and focused within 200 ms of the click").toBeLessThan(1200);
      expect(await noHorizontalScroll(page)).toBe(true);
      await shot(page, info, "k11-20c-open");
    });

    test("2. geometry: inside the viewport, hung off the card, all five tiers reachable", async ({
      page,
      context,
    }, info) => {
      await openFixtureProduct(page, context, UNITS_SKU);
      await trigger(page).click();
      await expect(win(page)).toBeVisible();
      await page.waitForTimeout(300); // the open animation
      const p = (await win(page).boundingBox())!;
      const c = (await card(page).boundingBox())!;
      const v = page.viewportSize()!;
      if (vp.width >= 1440) {
        expect(p.x).toBeGreaterThanOrEqual(16);
        expect(p.x + p.width).toBeLessThanOrEqual(v.width - 16);
        expect(Math.abs(p.x + p.width - (c.x + c.width))).toBeLessThanOrEqual(1);
        const m = await page.evaluate(() => {
          const region = document.querySelector<HTMLElement>(
            '[role="dialog"] [data-testid="units-v2-units-table"]',
          )!;
          const edge = region.getBoundingClientRect().right;
          const clipped = [...region.querySelectorAll<HTMLElement>("th[data-tier-head]")].filter(
            (th) => th.getBoundingClientRect().right > edge + 0.5,
          ).length;
          return { fits: region.scrollWidth <= region.clientWidth, clipped };
        });
        expect(m.fits, "the window's table does not scroll sideways at 1440").toBe(true);
        expect(m.clipped, "no tier header is clipped").toBe(0);
      } else if (vp.width >= 768 && !vp.cards) {
        const m = await page.evaluate(() => {
          const region = document.querySelector<HTMLElement>(
            '[role="dialog"] [data-testid="units-v2-units-table"]',
          )!;
          return { fits: region.scrollWidth <= region.clientWidth };
        });
        if (!m.fits) {
          // Either it fits, or the sideways cue is visible and the Unit column stays put while scrolled.
          await expect(win(page).getByTestId("units-v2-scroll-cue")).toBeVisible();
          const unitHead = win(page).locator("tbody th").first();
          const before = (await unitHead.boundingBox())!.x;
          await win(page)
            .getByTestId("units-v2-units-table")
            .evaluate((el) => el.scrollTo({ left: 400 }));
          const after = (await unitHead.boundingBox())!.x;
          expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
        }
      } else {
        // 390: a bottom sheet.
        expect(Math.abs(p.y + p.height - v.height)).toBeLessThanOrEqual(1);
        expect(p.height).toBeLessThanOrEqual(v.height * 0.92 + 1);
        await expect(win(page).getByText("Edit prices").first()).toBeInViewport();
        await expect(win(page).getByTestId("units-v2-eb-save")).toBeInViewport();
        const lastCard = win(page).locator('[data-testid^="units-v2-card-"]').last();
        await lastCard.scrollIntoViewIfNeeded();
        await expect(lastCard.locator('[data-testid$="-5"], dt').last()).toBeVisible();
      }
      await shot(page, info, "k11-20c-geometry");
    });

    test("3. a Save is one S9 write; no unit PATCH carries a price; the card, the grid and Details follow without a reload; Undo puts them back", async ({
      page,
      context,
    }, info) => {
      const { productId, ...ctx } = await openFixtureProduct(page, context, UNITS_SKU);
      const was = await packRetail(page, ctx, productId);
      const next = Math.round((was.retail + 0.37) * 100) / 100;
      const posts: string[] = [];
      const unitPatchesWithPrice: string[] = [];
      page.on("request", (r) => {
        const path = new URL(r.url()).pathname;
        if (r.method() === "POST" && /\/products\/[^/]+\/prices$/.test(path)) posts.push(path);
        if (r.method() === "PATCH" && /\/products\/[^/]+\/units\//.test(path)) {
          const body = r.postData() ?? "";
          if (/"(price|priceTier[2-5])"/.test(body)) unitPatchesWithPrice.push(path);
        }
      });
      try {
        await trigger(page).click();
        await expect(win(page)).toBeVisible();
        await typeRetail(page, was.ref, next);
        const saved = savedPrices(page);
        await win(page).getByTestId("units-v2-eb-save").click();
        expect((await saved).ok()).toBe(true);

        await expect(win(page)).toBeHidden();
        await expect(trigger(page)).toBeFocused();
        // "Saved 1 price. Undo" is on screen under the trigger within 1 s.
        const line = page.locator("#units-msg-window");
        await expect(line).toContainText(/Saved 1 price/, { timeout: 1000 });
        await expect(line).toBeInViewport();
        const tb = (await trigger(page).boundingBox())!;
        const lb = (await line.boundingBox())!;
        expect(lb.y).toBeGreaterThanOrEqual(tb.y + tb.height - 1);

        expect(posts, "exactly one S9 write").toHaveLength(1);
        expect(unitPatchesWithPrice, "no unit PATCH carries a price").toEqual([]);

        // The three places a price shows follow, with no reload.
        const cardFigure = card(page).getByTestId(`price-figure-${was.ref}-1`);
        await expect(cardFigure).toContainText(money(next));
        await expect(
          page
            .locator(
              `[data-testid="units-v2-cell-${was.ref}-1"]:visible, [data-testid="units-v2-card-${was.ref}"]:visible`,
            )
            .first(),
        ).toContainText(money(next));
        await expect(page.getByTestId("details-price-line")).toContainText(money(next));
        await shot(page, info, "k11-20c-saved");

        await line.getByRole("button", { name: /Undo/ }).click();
        await expect(cardFigure).toContainText(money(was.retail));
        await expect(page.getByTestId("details-price-line")).toContainText(money(was.retail));
      } finally {
        await restore(page, ctx, productId, null, was.retail);
      }
    });

    test("4. a Details rename after a window save sends no price key and the new price survives a reload", async ({
      page,
      context,
    }) => {
      const { productId, ...ctx } = await openFixtureProduct(page, context, UNITS_SKU);
      const was = await packRetail(page, ctx, productId);
      const next = Math.round((was.retail + 0.41) * 100) / 100;
      const original = (await (
        await page.request.get(`${ctx.api}/products/${productId}`, { headers: ctx.headers })
      ).json()) as { name: string };
      try {
        await trigger(page).click();
        await typeRetail(page, was.ref, next);
        const saved = savedPrices(page);
        await win(page).getByTestId("units-v2-eb-save").click();
        expect((await saved).ok()).toBe(true);
        await expect(win(page)).toBeHidden();

        await page.getByTitle("Edit product").click();
        const name = page
          .getByTestId("product-details-card")
          .locator(`input[value=${JSON.stringify(original.name)}]`);
        await name.fill(`${original.name} R`);
        const patched = page.waitForRequest(
          (r) =>
            r.method() === "PATCH" && new URL(r.url()).pathname.endsWith(`/products/${productId}`),
        );
        await page.getByRole("button", { name: /^Save/ }).first().click();
        const body = JSON.parse((await patched).postData() ?? "{}") as Record<string, unknown>;
        for (const k of ["pricePerUnit", "priceTier2", "priceTier3", "priceTier4", "priceTier5"]) {
          expect(Object.keys(body), `the Details save must not carry ${k}`).not.toContain(k);
        }
        await page.reload();
        const after = await packRetail(page, ctx, productId);
        expect(after.retail, "the window's price survives the rename and a reload").toBe(next);
      } finally {
        await restore(page, ctx, productId, original.name, was.retail);
      }
    });

    test("5. dirty: Escape and a scrim click both ask and keep the draft; clean: a scrim click closes", async ({
      page,
      context,
    }) => {
      const { productId, ...ctx } = await openFixtureProduct(page, context, UNITS_SKU);
      const was = await packRetail(page, ctx, productId);
      const scrim = () => page.mouse.click(5, 5);
      await trigger(page).click();
      await expect(win(page)).toBeVisible();
      await page.waitForTimeout(250);
      // clean: a scrim click closes at once
      await scrim();
      await expect(win(page)).toBeHidden();

      await trigger(page).click();
      await typeRetail(page, was.ref, was.retail + 0.55);
      await win(page).getByTestId("units-v2-eb-save").focus();
      await page.keyboard.press("Escape");
      await expect(win(page).getByText("Discard your unsaved changes?")).toBeVisible();
      await win(page).getByTestId("units-v2-eb-keep").click();
      await expect(win(page).getByText("Discard your unsaved changes?")).toBeHidden();
      await scrim();
      await expect(win(page).getByText("Discard your unsaved changes?")).toBeVisible();
      await expect(win(page)).toBeVisible();
      await win(page).getByTestId("units-v2-eb-keep").click();
      await expect(
        win(page).locator(`[data-testid="units-v2-input-${was.ref}-1"]:visible`),
      ).toHaveValue(money(was.retail + 0.55).replace(/[$,]/g, ""));
      // leave without saving
      await page.keyboard.press("Escape");
      await win(page).getByTestId("units-v2-eb-discard").click();
      await expect(win(page)).toBeHidden();
    });

    test("6. keyboard only: Enter on a figure, type, Tab stays in the window, Ctrl+S saves once, focus returns to the figure", async ({
      page,
      context,
    }) => {
      const { productId, ...ctx } = await openFixtureProduct(page, context, UNITS_SKU);
      const was = await packRetail(page, ctx, productId);
      const next = Math.round((was.retail + 0.29) * 100) / 100;
      const original = (await (
        await page.request.get(`${ctx.api}/products/${productId}`, { headers: ctx.headers })
      ).json()) as { name: string };
      let posts = 0;
      page.on("request", (r) => {
        if (r.method() === "POST" && /\/products\/[^/]+\/prices$/.test(new URL(r.url()).pathname))
          posts++;
      });
      try {
        const figure = card(page).getByTestId(`price-figure-${was.ref}-1`);
        await figure.focus();
        await page.keyboard.press("Enter");
        await expect(win(page)).toBeVisible();
        const box = win(page).locator(`[data-testid="units-v2-input-${was.ref}-1"]:visible`);
        await expect(box).toBeFocused();
        await page.keyboard.type(next.toFixed(2));
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press("Tab");
          expect(
            await page.evaluate(
              () => !!document.querySelector('[role="dialog"]')?.contains(document.activeElement),
            ),
            `Tab ${i + 1} stays inside the window`,
          ).toBe(true);
        }
        await box.focus();
        const saved = savedPrices(page);
        await page.keyboard.press("Control+s");
        expect((await saved).ok()).toBe(true);
        await expect(win(page)).toBeHidden();
        expect(posts).toBe(1);
        await expect(figure).toBeFocused();
      } finally {
        await restore(page, ctx, productId, original.name, was.retail);
      }
    });

    test("7. reduced motion: the panel's transform is none throughout opening", async ({
      page,
      context,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await openFixtureProduct(page, context, UNITS_SKU);
      await page.evaluate(() => {
        (window as unknown as { __tf: string[] }).__tf = [];
        const sample = () => {
          const el = document.querySelector('[role="dialog"]');
          if (el)
            (window as unknown as { __tf: string[] }).__tf.push(getComputedStyle(el).transform);
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await trigger(page).click();
      await expect(win(page)).toBeVisible();
      await page.waitForTimeout(500);
      const seen = await page.evaluate(() => (window as unknown as { __tf: string[] }).__tf);
      expect(seen.length).toBeGreaterThan(0);
      for (const t of seen) expect(t).toBe("none");
    });

    test("8. while the window is open there are no price inputs outside it", async ({
      page,
      context,
    }) => {
      await openFixtureProduct(page, context, UNITS_SKU);
      await trigger(page).click();
      await expect(win(page)).toBeVisible();
      expect(await priceInputsOutside(page)).toBe(0);
    });
  });
}

test.describe("K11-20c inline edit: the prices grid is full width at 1440 (K11-10 ruling)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Edit makes the section span the page; five tiers fit; the focused box does not move down; Cancel gives the column back", async ({
    page,
    context,
  }, info) => {
    await openFixtureProduct(page, context, UNITS_SKU);
    const region = page.getByTestId("units-v2-region");
    const before = (await region.boundingBox())!;
    await page.getByTestId("units-v2-btn-edit").click();
    await expect(region).toHaveAttribute("data-wide", "true");
    await page.waitForTimeout(350); // the 200 ms width change
    const wide = (await region.boundingBox())!;
    expect(wide.width).toBeGreaterThan(before.width * 1.4);
    expect(Math.abs(wide.y - before.y), "the section does not move vertically").toBeLessThanOrEqual(
      2,
    );
    expect(
      Math.abs(wide.x + wide.width - (before.x + before.width)),
      "its right edge is the same",
    ).toBeLessThanOrEqual(1);
    const focused = page.locator('[data-testid^="units-v2-input-"]:focus');
    await expect(focused).toHaveCount(1);
    const m = await page.evaluate(() => {
      const t = document.querySelector<HTMLElement>('[data-testid="units-v2-units-table"]')!;
      const edge = t.getBoundingClientRect().right;
      return {
        fits: t.scrollWidth <= t.clientWidth,
        tiers: t.querySelectorAll("th[data-tier-head]").length,
        clipped: [...t.querySelectorAll<HTMLElement>("th[data-tier-head]")].filter(
          (th) => th.getBoundingClientRect().right > edge + 0.5,
        ).length,
      };
    });
    expect(m.tiers).toBe(5);
    expect(m.fits, "scrollWidth <= clientWidth with 5 tiers").toBe(true);
    expect(m.clipped).toBe(0);
    expect(await noHorizontalScroll(page)).toBe(true);
    await shot(page, info, "k11-20c-inline-wide");
    await page.getByTestId("units-v2-eb-cancel").click();
    await expect(region).not.toHaveAttribute("data-wide", "true");
  });
});
