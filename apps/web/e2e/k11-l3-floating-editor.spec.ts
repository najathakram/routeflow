/**
 * K11-20c (lane L3): the one price editor on the v2 product page (the inline grid's Edit), and its full-width grid.
 * R3 retired the floating window's openers (the legacy card's Edit prices and figures, Details' tiers row): see below.
 *
 * NOT RUN by its author (no browser on the build machine); Jest proves the behaviour in `ProductUnitsCard.k11-20c.test.tsx`,
 * `PriceWindowHost.test.tsx` and `page.k11-20c.test.tsx`. This spec carries the pixel and network claims. Run it on the
 * local compose stack (`npm run local:up` + `local:seed`, then `npm run local:e2e`), flag `flag.units_prices_v2` ON.
 *
 * Every test makes its OWN throwaway product on the approved test tenant (assertTestTenant first): a Case of 12 with a
 * Pallet unit, Retail 24.00. It is retired (inactive) in a `finally`, and a failure to retire is logged, never swallowed
 * silently. Nothing here touches the shared fixture products. The card shows the Case price at Retail only (K11-20
 * section 4 row 9), so Case Retail is the price changed: the one price the card, the inline grid and Details all show.
 * A tenant not served the flag FAILS the spec (never a skip). Screenshots go under local-assets/proofs/units-v2.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { requireUnitsV2Flag } from "./helpers/units-v2-support";
import { BASE, VIEWPORTS, focusedPageTop, seedImages, shot, type Ctx } from "./k11-l3-support";

const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

type Row = { ref: string; label: string; kind: string; cells: { tier: number; value: number }[] };
type Product = { ctx: Ctx; id: string; name: string };

async function packRetail(page: Page, p: Product) {
  const res = await page.request.get(`${p.ctx.api}/products/${p.id}/price-grid`, {
    headers: p.ctx.headers,
  });
  expect(res.ok(), `GET price-grid returned ${res.status()}`).toBe(true);
  const grid = (await res.json()) as { rows: Row[] };
  const pack = grid.rows.find((r) => r.kind === "pack")!;
  return { ref: pack.ref, retail: pack.cells.find((c) => c.tier === 1)!.value };
}

/**
 * Creates a throwaway product, opens its page, runs the test body, and retires the product in a `finally`.
 * `photos` seeds that many one-pixel images (a tall image column).
 */
async function withProduct(
  page: Page,
  context: Parameters<typeof setTenantCookie>[0],
  body: (p: Product) => Promise<void>,
  opts: { photos?: number } = {},
) {
  assertTestTenant(TENANT_SLUG, "k11-l3 floating editor fixtures");
  await setTenantCookie(context, BASE);
  const ctx = await requireUnitsV2Flag(page);
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
  const name = `QA K11 20c ${tag}`;
  const created = await page.request.post(`${ctx.api}/products`, {
    headers: ctx.headers,
    data: { name, sku: `QAK20C${tag}`, unit: "Case", unitsPerBox: 12, pricePerUnit: "24.00" },
  });
  expect(created.ok(), `create the throwaway product: ${created.status()}`).toBeTruthy();
  const id = ((await created.json()) as { id: string }).id;
  try {
    const unit = await page.request.post(`${ctx.api}/products/${id}/units`, {
      headers: ctx.headers,
      data: { label: "Pallet", factorToBase: 240, price: 480 },
    });
    expect(unit.ok(), `create the Pallet unit: ${unit.status()}`).toBeTruthy();
    if (opts.photos) await seedImages(page, ctx, id, opts.photos);
    await page.goto(`/products/${id}`);
    await expect(page.locator("h1#h-product")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("units-v2-grid")).toBeVisible({ timeout: 20_000 });
    await body({ ctx, id, name });
  } finally {
    const retire = await page.request.patch(`${ctx.api}/products/${id}`, {
      headers: ctx.headers,
      data: { isActive: false },
    });
    if (!retire.ok()) console.warn(`could not retire throwaway product ${id}: ${retire.status()}`);
  }
}

const card = (page: Page) => page.locator("[data-units-card]");
const editBtn = (page: Page) => page.getByTestId("units-v2-btn-edit");
const dialogs = (page: Page) => page.locator('[role="dialog"]');
const priceBox = (page: Page, ref: string) =>
  page.locator(`[data-testid="units-v2-input-${ref}-1"]:visible`);

/** How many price boxes the legacy Units & prices card carries (read-only under v2: none). */
const legacyCardPriceInputs = (page: Page) =>
  card(page).locator('input[aria-label$=" price"], [data-testid^="units-v2-input-"]').count();

const noHorizontalScroll = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  );

async function typeRetail(page: Page, ref: string, value: number) {
  const box = priceBox(page, ref);
  await box.fill(value.toFixed(2));
  return box;
}

const savedPrices = (page: Page) =>
  page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      /\/products\/[^/]+\/prices$/.test(new URL(r.url()).pathname),
  );

/*
 * R3 (say-no 1 and 2): the legacy card is read-only where the grid has unit controls and Details has no tiers row, so the
 * floating price window (K11-20) has no opener left on the v2 product page: the inline grid's Edit is the one price editor.
 * The window tests of this file (open, geometry, scrim and keyboard, reduced motion, no inputs outside) were retired with
 * their opener; what they proved about the SAVE (one S9 write, no unit PATCH price, Details sends no price key, Undo,
 * dirty Cancel asks) is re-pinned below against the inline editor.
 */
// T2 (geometry) and T7 (reduced motion): window unreachable on v2 product page; covered in PriceWindowHost.test.tsx
// until the owner's two-price-editors decision.
for (const vp of VIEWPORTS) {
  test.describe(`K11-20c one price editor, the inline grid @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("1. no price-window opener is left: no Edit prices button, no clickable card figures, no Details tiers row", async ({
      page,
      context,
    }) => {
      await withProduct(page, context, async () => {
        await expect(card(page)).toBeVisible();
        await expect(page.getByRole("button", { name: "Edit prices" })).toHaveCount(0);
        await expect(page.locator('[data-testid^="price-figure-"]')).toHaveCount(0);
        await expect(page.getByTestId("details-price-line")).toHaveCount(0);
        expect(await legacyCardPriceInputs(page), "the legacy card has no price boxes").toBe(0);
        await expect(editBtn(page)).toBeVisible();
        await expect(dialogs(page)).toHaveCount(0);
      });
    });

    test("2. Edit opens edit mode in the grid itself: no dialog, the price boxes are the grid's, no horizontal page scroll", async ({
      page,
      context,
    }, info) => {
      await withProduct(page, context, async (prod) => {
        const was = await packRetail(page, prod);
        await editBtn(page).click();
        await expect(page.getByTestId("units-v2-editbar")).toBeVisible();
        await expect(priceBox(page, was.ref)).toBeVisible();
        await expect(dialogs(page)).toHaveCount(0);
        expect(await legacyCardPriceInputs(page)).toBe(0);
        expect(await noHorizontalScroll(page)).toBe(true);
        await shot(page, info, "k11-20c-inline-open");
      });
    });

    test("3. a Save is one S9 write; no unit PATCH carries a price; the card and grid follow without a reload; Details has no price line; Undo puts them back", async ({
      page,
      context,
    }, info) => {
      await withProduct(page, context, async (prod) => {
        const was = await packRetail(page, prod);
        const next = Math.round((was.retail + 0.37) * 100) / 100;
        const posts: string[] = [];
        const unitPatchesWithPrice: string[] = [];
        page.on("request", (r) => {
          const path = new URL(r.url()).pathname;
          if (r.method() === "POST" && /\/products\/[^/]+\/prices$/.test(path)) posts.push(path);
          if (r.method() === "PATCH" && /\/products\/[^/]+\/units\//.test(path)) {
            if (/"(price|priceTier[2-5])"/.test(r.postData() ?? ""))
              unitPatchesWithPrice.push(path);
          }
        });
        await editBtn(page).click();
        await typeRetail(page, was.ref, next);
        const saved = savedPrices(page);
        await page.getByTestId("units-v2-eb-save").click();
        expect((await saved).ok()).toBe(true);

        // "Saved 1 price. Undo" is on screen where the change happened within 1 s.
        const line = page.locator("#units-msg");
        await expect(line).toContainText(/Saved 1 price/, { timeout: 1000 });
        await expect(line).toBeInViewport();

        expect(posts, "exactly one S9 write").toHaveLength(1);
        expect(unitPatchesWithPrice, "no unit PATCH carries a price").toEqual([]);

        // The two places a price shows follow, with no reload. Under v2 the Details card has no price line.
        const grid = page.getByTestId("units-v2-grid");
        const details = page.getByTestId("details-price-line");
        await expect(card(page)).toContainText(money(next));
        await expect(grid).toContainText(money(next));
        await expect(details).toHaveCount(0);
        await shot(page, info, "k11-20c-saved");

        await line.getByRole("button", { name: /Undo/ }).click();
        await expect(card(page)).toContainText(money(was.retail));
        await expect(grid).toContainText(money(was.retail));
        await expect(details).toHaveCount(0);
      });
    });

    test("4. a Details rename after a grid save sends no price key and the new price survives a reload", async ({
      page,
      context,
    }) => {
      await withProduct(page, context, async (prod) => {
        const was = await packRetail(page, prod);
        const next = Math.round((was.retail + 0.41) * 100) / 100;
        await editBtn(page).click();
        await typeRetail(page, was.ref, next);
        const saved = savedPrices(page);
        await page.getByTestId("units-v2-eb-save").click();
        expect((await saved).ok()).toBe(true);
        await expect(page.getByTestId("units-v2-editbar")).toBeHidden();

        await page.getByTitle("Edit product").click();
        await page.getByLabel("Product name").fill(`${prod.name} R`);
        const patched = page.waitForRequest(
          (r) =>
            r.method() === "PATCH" && new URL(r.url()).pathname.endsWith(`/products/${prod.id}`),
        );
        await page.getByRole("button", { name: "Save", exact: true }).first().click();
        const body = JSON.parse((await patched).postData() ?? "{}") as Record<string, unknown>;
        for (const k of ["pricePerUnit", "priceTier2", "priceTier3", "priceTier4", "priceTier5"]) {
          expect(Object.keys(body), `the Details save must not carry ${k}`).not.toContain(k);
        }
        await page.reload();
        const after = await packRetail(page, prod);
        expect(after.retail, "the grid's price survives the rename and a reload").toBe(next);
      });
    });

    test("5. dirty: Cancel asks and Keep editing keeps the draft; Discard drops it; clean: Cancel closes at once", async ({
      page,
      context,
    }) => {
      await withProduct(page, context, async (prod) => {
        const was = await packRetail(page, prod);
        const asking = page.getByText("Discard your unsaved changes?");
        await editBtn(page).click();
        await page.getByTestId("units-v2-eb-cancel").click(); // clean: closes at once
        await expect(page.getByTestId("units-v2-editbar")).toBeHidden();

        const dirty = Math.round((was.retail + 0.55) * 100) / 100;
        await editBtn(page).click();
        await typeRetail(page, was.ref, dirty);
        await page.getByTestId("units-v2-eb-cancel").click();
        await expect(asking).toBeVisible();
        await page.getByTestId("units-v2-eb-keep").click();
        await expect(asking).toBeHidden();
        await expect(priceBox(page, was.ref)).toHaveValue(dirty.toFixed(2));
        await page.getByTestId("units-v2-eb-cancel").click();
        await page.getByTestId("units-v2-eb-discard").click();
        await expect(page.getByTestId("units-v2-editbar")).toBeHidden();
        expect((await packRetail(page, prod)).retail, "a discard writes nothing").toBe(was.retail);
      });
    });

    test("6. keyboard only: Ctrl+S in the grid's price box saves once", async ({
      page,
      context,
    }) => {
      await withProduct(page, context, async (prod) => {
        const was = await packRetail(page, prod);
        const next = Math.round((was.retail + 0.29) * 100) / 100;
        let posts = 0;
        page.on("request", (r) => {
          if (r.method() === "POST" && /\/products\/[^/]+\/prices$/.test(new URL(r.url()).pathname))
            posts++;
        });
        await editBtn(page).focus();
        await page.keyboard.press("Enter");
        const box = priceBox(page, was.ref);
        await box.focus();
        await page.keyboard.type(next.toFixed(2));
        const saved = savedPrices(page);
        await page.keyboard.press("Control+s");
        expect((await saved).ok()).toBe(true);
        await expect(page.getByTestId("units-v2-editbar")).toBeHidden();
        expect(posts).toBe(1);
      });
    });
  });
}

test.describe("K11-20c inline edit: the prices grid is full width at 1440 (K11-10 ruling)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Edit spans the page; five tiers fit; the focused box does not shift; Cancel gives the column back", async ({
    page,
    context,
  }, info) => {
    await withProduct(page, context, async () => {
      const region = page.getByTestId("units-v2-region");
      const before = (await region.boundingBox())!;
      await page.getByTestId("units-v2-btn-edit").click();
      await expect(region).toHaveAttribute("data-wide", "true");
      const focused = page.locator('[data-testid^="units-v2-input-"]:focus');
      await expect(focused).toHaveCount(1);
      // The focused box's page position at once, and after the 200 ms width change has finished: it does not shift.
      const top1 = await focusedPageTop(page);
      await page.waitForTimeout(450);
      const top2 = await focusedPageTop(page);
      expect(top1).not.toBeNull();
      expect(
        Math.abs((top2 ?? 0) - (top1 ?? 0)),
        "the focused input does not move vertically",
      ).toBeLessThanOrEqual(2);
      await expect(focused).toHaveCount(1);

      const wide = (await region.boundingBox())!;
      expect(wide.width).toBeGreaterThan(before.width * 1.4);
      expect(
        Math.abs(wide.x + wide.width - (before.x + before.width)),
        "its right edge is the same",
      ).toBeLessThanOrEqual(1);
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

  test("reduced motion: the width change does not animate", async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await withProduct(page, context, async () => {
      const region = page.getByTestId("units-v2-region");
      await page.getByTestId("units-v2-btn-edit").click();
      await expect(region).toHaveAttribute("data-wide", "true");
      const t = await region.evaluate((el) => {
        const s = getComputedStyle(el);
        return { property: s.transitionProperty, duration: s.transitionDuration };
      });
      // Under reduced motion the build emits no transition rule at all (motion-safe only): every duration is 0 s.
      expect(t.duration.split(",").every((d) => parseFloat(d) === 0)).toBe(true);
    });
  });

  test("a tall image column: the wide grid is opaque, the covered column is inert and out of the Tab order", async ({
    page,
    context,
  }) => {
    await withProduct(
      page,
      context,
      async () => {
        const region = page.getByTestId("units-v2-region");
        const covered = page.locator("[data-region-covers]");
        await expect(covered).not.toHaveAttribute("inert", /.*/);
        await page.getByTestId("units-v2-btn-edit").click();
        await expect(region).toHaveAttribute("data-wide", "true");
        await page.waitForTimeout(450);
        await expect(covered).toHaveAttribute("inert", "");
        // The covered photos are dimmed (not hidden) so it is clear they are still underneath.
        await expect
          .poll(() => covered.evaluate((el) => parseFloat(getComputedStyle(el).opacity)))
          .toBeLessThan(1);
        // Opaque: a real background, and the topmost element over the covered column's area is the grid's own.
        const bg = await region.evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(bg, "an opaque background").not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
        const r = (await region.boundingBox())!;
        const c = (await covered.boundingBox())!;
        const y = Math.max(r.y, c.y) + 20;
        if (y < Math.min(r.y + r.height, c.y + c.height)) {
          const x = Math.max(r.x, c.x) + 20;
          const owned = await page.evaluate(
            ([px, py]) =>
              !!document.elementFromPoint(px, py)?.closest('[data-testid="units-v2-region"]'),
            [x, y],
          );
          expect(owned, "on top where the grid covers the image column is the grid").toBe(true);
        }
        // Tab never lands in the covered (inert) column.
        for (let i = 0; i < 10; i++) {
          await page.keyboard.press("Tab");
          const inCovered = await page.evaluate(
            () => !!document.activeElement?.closest("[data-region-covers]"),
          );
          expect(inCovered, `Tab ${i + 1} stays out of the covered column`).toBe(false);
        }
        await page.getByTestId("units-v2-eb-cancel").click();
        await expect(covered).not.toHaveAttribute("inert", /.*/);
      },
      { photos: 3 },
    );
  });
});
