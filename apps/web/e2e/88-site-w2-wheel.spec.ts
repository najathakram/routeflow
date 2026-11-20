/**
 * Site rebrand, wave 2, lane 2.2 (spec 88), project "site-waves": the home wheel by role.
 *
 *   T17c  copper tiles on the wheel: 1 at rest (Payments), 0 while it is open, 1 at each stop
 *   T18b  the canvas creates no gradient and sets no shadow blur, through every checkpoint
 *   T19   the pixel on each tile is bone (two values) outside, ink (two values) inside, copper in focus;
 *         the gap between the layers, as a share of the wheel's width, is the same at every size
 *   P06   the tile in focus keeps its line icon; there is no 3D object standing on it (393 px)
 *   P07   the inventory card's row reads "Stock value (cost)"
 *
 * Signed out, local stack. The wheel is re-mounted with snap off so a seek stays where it was put, and
 * every wait is on the wheel's own scroll progress settling (no sleeps). A sweep that finds nothing
 * throws. The tile probe is the wheel's own `tiles()` hook: one sample point on each tile's top face
 * (near the icon), in canvas pixels; the colour is the most common one in an 11 px square (getImageData).
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import {
  BEATS,
  SIZES,
  blockAnalytics,
  drawCounts,
  frames,
  nonEmpty,
  openHomeNoSnap,
  scrollWheelTo,
  settle,
  sizeName,
  waitForArrival,
  waitForWheel,
} from "./helpers/site-proof";

test.describe.configure({ mode: "parallel" });

test.beforeEach(async ({ context }) => {
  await blockAnalytics(context);
});

type Rgb = [number, number, number];
type Tile = {
  i: number;
  k: string;
  o: boolean;
  x: number;
  y: number;
  ix: number;
  iy: number;
  ir: number;
};
type Roles = Record<"work" | "work2" | "sell" | "sell2" | "focus" | "workWall" | "sellWall", Rgb>;

/** The palette file's colours (packages/types/brand/palette.json): the icon colours come from here, never typed. */
const PALETTE = (
  JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../packages/types/brand/palette.json"), "utf8"),
  ) as { color: Record<string, string> }
).color;
const rgbKey = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",");
const ICON_KEYS = [rgbKey(PALETTE.white), rgbKey(PALETTE.ink)];

const TOL = 6;
const near = (a: Rgb, b: Rgb, tol = TOL) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= tol;

/** The wheel roles as the page resolves them (read through a canvas, so any colour syntax works). */
async function roles(page: Page): Promise<Roles> {
  const r = await page.evaluate(() => {
    const el = document.querySelector(".rfw") as HTMLElement;
    const cs = getComputedStyle(el);
    const x = document.createElement("canvas").getContext("2d")!;
    const rgb = (name: string): number[] => {
      const v = cs.getPropertyValue(name).trim();
      if (!v) throw new Error(`${name} is empty on the page`);
      x.fillStyle = v;
      const n = x.fillStyle as string;
      return [1, 3, 5].map((i) => parseInt(n.slice(i, i + 2), 16));
    };
    return {
      work: rgb("--rf-wh-work"),
      work2: rgb("--rf-wh-work-2"),
      sell: rgb("--rf-wh-sell"),
      sell2: rgb("--rf-wh-sell-2"),
      focus: rgb("--rf-wh-focus"),
      workWall: rgb("--rf-wh-work-wall"),
      sellWall: rgb("--rf-wh-sell-wall"),
    };
  });
  return r as Roles;
}

/** The sample point and pixel of each of the 15 tiles, after two frames so the canvas holds the settled pose. */
async function tilePixels(page: Page): Promise<Array<Tile & { px: Rgb }>> {
  await frames(page, 2);
  const out = await page.evaluate((iconKeys) => {
    const el = document.querySelector(".rfw") as HTMLElement & {
      _rfw?: { tiles?: () => unknown[] };
    };
    if (!el._rfw?.tiles) throw new Error("the wheel has no tiles() probe");
    const cv = document.querySelector<HTMLCanvasElement>("canvas.rfw-cv")!;
    const ctx = cv.getContext("2d")!;
    return (el._rfw.tiles() as Array<Record<string, unknown>>).map((t) => {
      const x = Math.round(t.ix as number);
      const y = Math.round(t.iy as number);
      const inside = x >= 0 && y >= 0 && x < cv.width && y < cv.height;
      if (!inside) return { ...t, px: [-999, -999, -999] };
      // the most common colour in an 11 px square: a thin icon stroke or an edge cannot outvote the tile's own fill
      const d = ctx.getImageData(Math.max(0, x - 5), Math.max(0, y - 5), 11, 11).data;
      const seen = new Map<string, number>();
      for (let i = 0; i < d.length; i += 4) {
        const k = d[i] + "," + d[i + 1] + "," + d[i + 2];
        // the icon is drawn in white or in ink: leave those two out so the tile fill is what is counted
        if (iconKeys.includes(k)) continue;
        seen.set(k, (seen.get(k) ?? 0) + 1);
      }
      const best = [...seen.entries()].sort((m, n) => n[1] - m[1])[0];
      const top = best ? best[0].split(",").map(Number) : [-1, -1, -1];
      return { ...t, px: top };
    });
  }, ICON_KEYS);
  nonEmpty(out, "wheel tiles");
  expect(out, "the wheel has 15 tiles").toHaveLength(15);
  return out as Array<Tile & { px: Rgb }>;
}

/** The checkpoint shares of the three stops, read from the live timeline. */
async function stopShares(page: Page): Promise<Array<{ k: string; share: number }>> {
  return page.evaluate(() => {
    const el = document.querySelector(".rfw") as HTMLElement & {
      _rfw: { beats: Array<[number, string]>; T: { duration(): number } };
    };
    const end = el._rfw.T.duration();
    return el._rfw.beats
      .filter(([, k]) => !["rest", "apart", "one"].includes(k))
      .map(([t, k]) => ({ k, share: t / end }));
  });
}

const copperIn = (tiles: Array<Tile & { px: Rgb }>, focus: Rgb) =>
  tiles.filter((t) => near(t.px, focus));

// ─── T17c ────────────────────────────────────────────────────────────────────

test.describe("T17c copper tiles on the wheel", () => {
  for (const size of [SIZES[0], SIZES[8]]) {
    test(`T17c one copper tile at rest (Payments), none while open, one at each stop @${sizeName(size)}`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await openHomeNoSnap(page, size);
      const r = await roles(page);
      const problems: string[] = [];

      await scrollWheelTo(page, 0);
      let c = copperIn(await tilePixels(page), r.focus);
      if (c.length !== 1 || c[0].k !== "payments")
        problems.push(
          `share 0: copper tiles ${JSON.stringify(c.map((t) => t.k))} (need payments only)`,
        );

      for (const share of [0.36, 0.4, 0.45]) {
        await scrollWheelTo(page, share);
        c = copperIn(await tilePixels(page), r.focus);
        if (c.length !== 0)
          problems.push(
            `share ${share}: copper tiles ${JSON.stringify(c.map((t) => t.k))} (need none)`,
          );
      }

      const stops = nonEmpty(await stopShares(page), "wheel stops");
      for (const s of stops) {
        await scrollWheelTo(page, s.share);
        c = copperIn(await tilePixels(page), r.focus);
        if (c.length !== 1 || c[0].k !== s.k)
          problems.push(
            `stop ${s.k}: copper tiles ${JSON.stringify(c.map((t) => t.k))} (need ${s.k} only)`,
          );
      }
      expect(problems, "T17c").toEqual([]);
    });
  }
});

// ─── T18b ────────────────────────────────────────────────────────────────────

test.describe("T18b no gradient and no shadow blur on the canvas", () => {
  test("T18b no createRadialGradient, createLinearGradient or shadowBlur above 0 through every checkpoint @1440x900", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openHomeNoSnap(page, SIZES[0], { spy: true });
    for (const share of nonEmpty(BEATS, "wheel checkpoints")) {
      await scrollWheelTo(page, share);
      await frames(page, 2);
    }
    const n = await drawCounts(page);
    expect(n.gradient, "gradients created on the canvas").toBe(0);
    expect(n.shadow, "shadowBlur set above 0").toBe(0);
  });
});

// ─── T19 ─────────────────────────────────────────────────────────────────────

test.describe("T19 the tile colours", () => {
  for (const size of [SIZES[0], SIZES[8]]) {
    test(`T19 bone outside (two values), ink inside (two values), copper in focus @${sizeName(size)}`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await openHomeNoSnap(page, size);
      const r = await roles(page);
      const problems: string[] = [];
      const want = (t: Tile) => {
        const alt = (t.o ? t.i : t.i - 10) % 2;
        return t.o ? (alt ? r.work2 : r.work) : alt ? r.sell2 : r.sell;
      };

      // open: every tile is its ring's colour
      await scrollWheelTo(page, 0.4);
      for (const t of await tilePixels(page)) {
        if (!near(t.px, want(t))) problems.push(`open ${t.k}: pixel ${t.px} (need ${want(t)})`);
      }
      // at rest every tile but Payments is its ring's colour
      await scrollWheelTo(page, 0);
      for (const t of await tilePixels(page)) {
        const expected = t.k === "payments" ? r.focus : want(t);
        if (!near(t.px, expected)) problems.push(`rest ${t.k}: pixel ${t.px} (need ${expected})`);
      }
      // a tile in keyboard focus is copper, and it is the only one
      await scrollWheelTo(page, 0.4);
      await page.locator('.rfw-b[data-i="0"]').focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-i") === "2");
      const tiles = await tilePixels(page);
      const c = copperIn(tiles, r.focus);
      if (c.length !== 1 || c[0].i !== 2)
        problems.push(
          `focus on tile 2: copper tiles ${JSON.stringify(c.map((t) => t.i))} (need 2 only)`,
        );
      for (const t of tiles) {
        if (t.i !== 2 && !near(t.px, want(t)))
          problems.push(`focus: another tile, ${t.k}, is dimmed or recoloured: ${t.px}`);
      }
      expect(problems, `T19 ${sizeName(size)}`).toEqual([]);
    });
  }

  test("T19 the gap between the layers is the same share of the wheel's width at every size", async ({
    page,
  }) => {
    test.setTimeout(600_000);
    const shares: string[] = [];
    const values: number[] = [];
    for (const size of nonEmpty(SIZES, "window sizes")) {
      await openHomeNoSnap(page, size);
      const r = await roles(page);
      await scrollWheelTo(page, 0.4);
      await frames(page, 2);
      const v = await shareOf(page, r);
      values.push(v);
      shares.push(`${sizeName(size)}: ${v.toFixed(4)}`);
    }
    // T19b reads "equal (±2%)": relative, every size within 2% of the mean share (the values are logged on a pass too)
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const worst = Math.max(...values.map((v) => Math.abs(v - mean) / mean));
    console.log(
      `T19 gap share (mean ${mean.toFixed(4)}, worst ${(worst * 100).toFixed(2)}% off): ${shares.join("; ")}`,
    );
    expect(worst, shares.join("; ")).toBeLessThanOrEqual(0.02);
  });
});

/** The gap between the lowest bone pixel and the lowest ink pixel on the wheel's centre column, over the wheel's width. */
async function shareOf(page: Page, r: Roles): Promise<number> {
  const m = await page.evaluate(
    ([work, work2, wall, sell, sell2, sellWall, tol]) => {
      const el = document.querySelector(".rfw") as HTMLElement & {
        _rfw: { tiles(): Array<{ x: number; o: boolean }> };
      };
      const cv = document.querySelector<HTMLCanvasElement>("canvas.rfw-cv")!;
      const ctx = cv.getContext("2d")!;
      const w = cv.width;
      const h = cv.height;
      const d = ctx.getImageData(0, 0, w, h).data;
      const outer = el._rfw.tiles().filter((t) => t.o);
      const cx = Math.round(outer.reduce((a, t) => a + t.x, 0) / outer.length);
      const band = Math.round(w * 0.1);
      const is = (i: number, list: number[][]) =>
        list.some(
          (c) =>
            Math.abs(d[i] - c[0]) + Math.abs(d[i + 1] - c[1]) + Math.abs(d[i + 2] - c[2]) <=
            (tol as number),
        );
      const bone = [work, work2, wall] as number[][];
      const ink = [sell, sell2, sellWall] as number[][];
      let boneLow = -1;
      let inkLow = -1;
      let left = w;
      let right = -1;
      for (let y = 0; y < h; y++) {
        // a band about the centre column (the column itself can fall in the gap between two front tiles)
        for (let x = Math.max(0, cx - band); x <= Math.min(w - 1, cx + band); x += 2) {
          if (is((y * w + x) * 4, bone)) boneLow = y;
          if (is((y * w + x) * 4, ink)) inkLow = y;
        }
        for (let x = 0; x < w; x += 2) {
          const i = (y * w + x) * 4;
          if (is(i, bone) || is(i, ink)) {
            if (x < left) left = x;
            if (x > right) right = x;
          }
        }
      }
      return { boneLow, inkLow, width: right - left };
    },
    [r.work, r.work2, r.workWall, r.sell, r.sell2, r.sellWall, TOL] as const,
  );
  if (m.boneLow < 0 || m.inkLow < 0 || m.width < 50)
    throw new Error(`gap scan found nothing: ${JSON.stringify(m)}`);
  return (m.boneLow - m.inkLow) / m.width;
}

// ─── P06 and P07 ─────────────────────────────────────────────────────────────

test.describe("P06 P07 the tile in focus keeps its icon; the card row's label", () => {
  const PHONE = { w: 393, h: 844 };

  test("P06 the tile in focus keeps its line icon and nothing stands on it @393x844", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openHomeNoSnap(page, PHONE);
    const problems: string[] = [];
    const stops = nonEmpty(await stopShares(page), "wheel stops");
    for (const s of stops) {
      await scrollWheelTo(page, s.share);
      const tiles = await tilePixels(page);
      const t = tiles.find((x) => x.k === s.k)!;
      // the icon is drawn: pixels around the tile's icon centre that differ from the tile's own colour
      const drawn = await page.evaluate(
        ([ix, iy, ir, base]) => {
          const cv = document.querySelector<HTMLCanvasElement>("canvas.rfw-cv")!;
          const ctx = cv.getContext("2d")!;
          const r = Math.max(4, Math.round(ir as number));
          const x0 = Math.max(0, Math.round(ix as number) - r);
          const y0 = Math.max(0, Math.round(iy as number) - r);
          const d = ctx.getImageData(
            x0,
            y0,
            Math.min(cv.width - x0, 2 * r),
            Math.min(cv.height - y0, 2 * r),
          ).data;
          const b = base as number[];
          let n = 0;
          for (let i = 0; i < d.length; i += 4)
            if (Math.abs(d[i] - b[0]) + Math.abs(d[i + 1] - b[1]) + Math.abs(d[i + 2] - b[2]) > 120)
              n++;
          return n;
        },
        [t.ix, t.iy, t.ir, t.px] as const,
      );
      if (drawn < 12)
        problems.push(`${s.k}: ${drawn} icon pixels on the tile in focus (need a drawn line icon)`);
      const objects = await page.locator(".rfw-tok").count();
      if (objects !== 0)
        problems.push(`${s.k}: ${objects} 3D object element(s) on the stage (need none)`);
    }
    expect(problems, "P06").toEqual([]);
  });

  test("P07 the inventory card reads Stock value (cost) @393x844", async ({ page }) => {
    await openHomeNoSnap(page, PHONE);
    const labels = await page.locator(".rfw-card .rfw-row .n").allTextContents();
    nonEmpty(labels, "card row labels");
    expect(labels).toContain("Stock value (cost)");
    expect(labels).not.toContain("Stock Value (cost)");
  });
});

// ─── K1: the hub's mark is the page's own image ──────────────────────────────

/** Pixels in a 40 px box at the hub's centre (the mean of the outer ring's icon points) that differ from the box's most common colour. */
async function hubMarkPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector(".rfw") as HTMLElement & {
      _rfw: { tiles(): Array<{ o: boolean; ix: number; iy: number }> };
    };
    const outer = el._rfw.tiles().filter((t) => t.o);
    if (outer.length === 0) throw new Error("no outer tiles to find the hub from");
    const cx = Math.round(outer.reduce((a, t) => a + t.ix, 0) / outer.length);
    const cy = Math.round(outer.reduce((a, t) => a + t.iy, 0) / outer.length);
    const cv = document.querySelector<HTMLCanvasElement>("canvas.rfw-cv")!;
    const ctx = cv.getContext("2d")!;
    const r = 20;
    const d = ctx.getImageData(cx - r, cy - r, 2 * r, 2 * r).data;
    const seen = new Map<string, number>();
    for (let i = 0; i < d.length; i += 4) {
      const k = d[i] + "," + d[i + 1] + "," + d[i + 2];
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    const disc = [...seen.entries()]
      .sort((a, b) => b[1] - a[1])[0][0]
      .split(",")
      .map(Number);
    let n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (
        Math.abs(d[i] - disc[0]) + Math.abs(d[i + 1] - disc[1]) + Math.abs(d[i + 2] - disc[2]) >
        60
      )
        n++;
    return n;
  });
}

test.describe("K1 the hub is drawn from #brand-symbol, and not at all without it", () => {
  for (const size of [
    { w: 1440, h: 900 },
    { w: 393, h: 844 },
  ]) {
    test(`K1 the hub mark is drawn at rest, and with the template removed nothing is drawn and nothing throws @${size.w}x${size.h}`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await openHomeNoSnap(page, size);
      await scrollWheelTo(page, 0);
      await frames(page, 3);
      const withMark = await hubMarkPixels(page);
      console.log(`K1 hub mark pixels with the template: ${withMark}`);
      expect(withMark, "pixels that are not the hub disc, at its centre").toBeGreaterThanOrEqual(
        30,
      );

      // no template: the wheel re-mounts with no image to draw
      await page.evaluate(() => {
        const el = document.querySelector(".rfw") as HTMLElement & { _rfw: { destroy(): void } };
        const api = (window as unknown as { RFWheel: { mount(e: Element, o: object): unknown } })
          .RFWheel;
        el._rfw.destroy();
        // destroy() puts the page's own markup back, template included; take it out
        const tp = el.querySelector("#brand-symbol");
        if (!tp) throw new Error("the page has no #brand-symbol template to remove");
        tp.remove();
        api.mount(el, { refreshPriority: 0, scrub: 0.7, snap: false, top: null, copy: ".hx-copy" });
      });
      await waitForWheel(page);
      await waitForArrival(page);
      await settle(page);
      await scrollWheelTo(page, 0);
      await frames(page, 3);
      const without = await hubMarkPixels(page);
      console.log(`K1 hub mark pixels without the template: ${without}`);
      expect(without, "no mark is drawn without the template").toBe(0);
      expect(errors, "no page error").toEqual([]);
    });
  }
});
