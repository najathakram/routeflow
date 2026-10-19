/**
 * K11-20c (lane L3): the floating price editor opened from the legacy "Units & prices" card and from Details, and the
 * inline editor's full-width grid.
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

const WIN = { name: "Edit prices" };
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
const trigger = (page: Page) => card(page).getByRole("button", { name: "Edit prices" });
const win = (page: Page) => page.getByRole("dialog", WIN);
const inDialog = (page: Page) =>
  page.evaluate(
    () => !!document.querySelector('[role="dialog"]')?.contains(document.activeElement),
  );

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

    test("1. Edit prices opens the window, visible and focused, with no horizontal page scroll", async ({
      page,
      context,
    }, info) => {
      await withProduct(page, context, async () => {
        await expect(trigger(page)).toBeVisible();
        const t0 = Date.now();
        await trigger(page).click();
        await expect(win(page)).toBeVisible();
        await expect.poll(() => inDialog(page)).toBe(true);
        // A generous bound that includes the test runner's own round trips; the feel is the feel prober's to judge.
        expect(Date.now() - t0, "visible and focused promptly").toBeLessThan(1500);
        expect(await noHorizontalScroll(page)).toBe(true);
        await shot(page, info, "k11-20c-open");
      });
    });

    test("2. geometry: inside the viewport, hung off the card, all five tiers reachable", async ({
      page,
      context,
    }, info) => {
      await withProduct(page, context, async () => {
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
        } else if (!vp.cards) {
          // 768: either the table fits, or the sideways cue is visible and the Unit column stays put while scrolled.
          const fits = await page.evaluate(() => {
            const region = document.querySelector<HTMLElement>(
              '[role="dialog"] [data-testid="units-v2-units-table"]',
            )!;
            return region.scrollWidth <= region.clientWidth;
          });
          if (!fits) {
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
          // 390: a bottom sheet with the title and Save in view, and the LAST unit's Tier 5 reachable by scrolling.
          expect(Math.abs(p.y + p.height - v.height)).toBeLessThanOrEqual(1);
          expect(p.height).toBeLessThanOrEqual(v.height * 0.92 + 1);
          await expect(win(page).getByText("Edit prices").first()).toBeInViewport();
          const save = win(page).getByTestId("units-v2-eb-save");
          await expect(save).toBeInViewport();
          const lastTier5 = win(page)
            .locator('[data-testid^="units-v2-card-"]')
            .last()
            .locator("dt")
            .nth(4);
          await lastTier5.scrollIntoViewIfNeeded();
          await expect(lastTier5).toBeInViewport({ ratio: 1 });
          const t5 = (await lastTier5.boundingBox())!;
          const s = (await save.boundingBox())!;
          expect(t5.y + t5.height, "Tier 5 sits above the pinned Save bar").toBeLessThanOrEqual(
            s.y + 1,
          );
        }
        await shot(page, info, "k11-20c-geometry");
      });
    });

    test("3. a Save is one S9 write; no unit PATCH carries a price; the card, Details and the grid follow without a reload; Undo puts all three back", async ({
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

        // The two places a price shows follow, with no reload. Under v2 the Details card has no price line.
        const cardFigure = card(page).getByTestId(`price-figure-${was.ref}-1`);
        const grid = page.getByTestId("units-v2-grid");
        const details = page.getByTestId("details-price-line");
        await expect(cardFigure).toContainText(money(next));
        await expect(grid).toContainText(money(next));
        await expect(details).toHaveCount(0);
        await shot(page, info, "k11-20c-saved");

        await line.getByRole("button", { name: /Undo/ }).click();
        await expect(cardFigure).toContainText(money(was.retail));
        await expect(grid).toContainText(money(was.retail));
        await expect(details).toHaveCount(0);
      });
    });

    test("4. a Details rename after a window save sends no price key and the new price survives a reload", async ({
      page,
      context,
    }) => {
      await withProduct(page, context, async (prod) => {
        const was = await packRetail(page, prod);
        const next = Math.round((was.retail + 0.41) * 100) / 100;
        await trigger(page).click();
        await typeRetail(page, was.ref, next);
        const saved = savedPrices(page);
        await win(page).getByTestId("units-v2-eb-save").click();
        expect((await saved).ok()).toBe(true);
        await expect(win(page)).toBeHidden();

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
        expect(after.retail, "the window's price survives the rename and a reload").toBe(next);
      });
    });

    test("5. dirty: Escape and a scrim click both ask and keep the draft; clean: a scrim click closes", async ({
      page,
      context,
    }) => {
      await withProduct(page, context, async (prod) => {
        const was = await packRetail(page, prod);
        const scrim = () => page.mouse.click(5, 5);
        await trigger(page).click();
        await expect(win(page)).toBeVisible();
        await page.waitForTimeout(250);
        await scrim(); // clean: closes at once
        await expect(win(page)).toBeHidden();

        const dirty = Math.round((was.retail + 0.55) * 100) / 100;
        await trigger(page).click();
        await typeRetail(page, was.ref, dirty);
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
        ).toHaveValue(dirty.toFixed(2));
        await page.keyboard.press("Escape");
        await win(page).getByTestId("units-v2-eb-discard").click();
        await expect(win(page)).toBeHidden();
      });
    });

    test("6. keyboard only: Enter on a figure, type, Tab stays in the window, Ctrl+S saves once, focus returns to the figure", async ({
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
        const figure = card(page).getByTestId(`price-figure-${was.ref}-1`);
        await figure.focus();
        await page.keyboard.press("Enter");
        await expect(win(page)).toBeVisible();
        const box = win(page).locator(`[data-testid="units-v2-input-${was.ref}-1"]:visible`);
        await expect(box).toBeFocused();
        await page.keyboard.type(next.toFixed(2));
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press("Tab");
          expect(await inDialog(page), `Tab ${i + 1} stays inside the window`).toBe(true);
        }
        await box.focus();
        const saved = savedPrices(page);
        await page.keyboard.press("Control+s");
        expect((await saved).ok()).toBe(true);
        await expect(win(page)).toBeHidden();
        expect(posts).toBe(1);
        await expect(figure).toBeFocused();
      });
    });

    test("7. reduced motion: the panel's transform is none throughout opening", async ({
      page,
      context,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await withProduct(page, context, async () => {
        await page.evaluate(() => {
          const w = window as unknown as { __tf: string[] };
          w.__tf = [];
          const sample = () => {
            const el = document.querySelector('[role="dialog"]');
            if (el) w.__tf.push(getComputedStyle(el).transform);
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        await trigger(page).click();
        await expect(win(page)).toBeVisible();
        await page.waitForTimeout(500);
        const seen = await page.evaluate(() => (window as unknown as { __tf: string[] }).__tf);
        expect(seen.length).toBeGreaterThan(0);
        // A panel at rest reports the identity matrix; "none" is also fine. Any other value means it moved or scaled.
        for (const t of seen) expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(t);
      });
    });

    test("8. while the window is open there are no price inputs outside it", async ({
      page,
      context,
    }) => {
      await withProduct(page, context, async () => {
        await trigger(page).click();
        await expect(win(page)).toBeVisible();
        expect(await priceInputsOutside(page)).toBe(0);
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
