/**
 * Site rebrand, wave 2, lane 2.2 (spec 88), project "site-waves": the home story ring by role.
 * The canvas wheel this spec once read pixel by pixel (copper tiles, gradients, tile colours, the
 * card row, the hub template) is gone; the ring is inline SVG whose fills come from the palette's
 * custom properties. What still has a subject is kept and pointed at the ring:
 *
 *   T18b  no gradient, filter or shadow blur anywhere in the ring's svg
 *   T19   outside layer and inside layer fills are the palette's roles, never black or the default
 *   K1    the hub carries the logo as one image, drawn from the brand symbol
 *
 * Deleted with the wheel: T17c (copper tiles, one per stop), the T19 gap-share (canvas pixels), P06
 * (the tile in focus keeps its icon), P07 (the inventory card label).
 *
 * Signed out, local stack.
 */
import { test, expect, type Page } from "@playwright/test";
import { blockAnalytics } from "./helpers/site-proof";

test.describe.configure({ mode: "parallel" });

test.beforeEach(async ({ context }) => {
  await blockAnalytics(context);
});

const VIEWS = [
  { w: 1440, h: 900 },
  { w: 393, h: 844 },
] as const;

async function open(page: Page, w: number, h: number): Promise<void> {
  await page.setViewportSize({ width: w, height: h });
  await page.goto("/");
  await page.waitForSelector("#story .ringO", { state: "attached" });
  await page.waitForTimeout(600);
}

for (const v of VIEWS) {
  test(`T18b no gradient, filter or shadow blur in the ring @${v.w}x${v.h}`, async ({ page }) => {
    await open(page, v.w, v.h);
    const found = await page.evaluate(() => {
      const svg = document.querySelector("#story .stx-svg")!;
      const bad: string[] = [];
      for (const e of svg.querySelectorAll("linearGradient, radialGradient, filter"))
        bad.push(e.tagName);
      for (const e of svg.querySelectorAll("*")) {
        const c = getComputedStyle(e);
        if (c.filter && c.filter !== "none")
          bad.push(`${e.tagName}.${e.getAttribute("class")} filter`);
      }
      return { bad, shapes: svg.querySelectorAll("*").length };
    });
    expect(found.shapes, "the ring has shapes").toBeGreaterThan(20);
    expect(found.bad).toEqual([]);
  });

  test(`T19 the ring's layers use the palette's roles @${v.w}x${v.h}`, async ({ page }) => {
    await open(page, v.w, v.h);
    const r = await page.evaluate(() => {
      const role = (name: string) => {
        const d = document.createElement("div");
        d.style.color = `var(${name})`;
        document.body.appendChild(d);
        const c = getComputedStyle(d).color;
        d.remove();
        return c;
      };
      const fill = (sel: string) => getComputedStyle(document.querySelector(sel)!).fill;
      return {
        outerWall: [fill("#story .rg-wall"), role("--rf-wh-work-wall")],
        innerWall: [fill("#story .rg-wall.i"), role("--rf-wh-sell-wall")],
        outerCol: [fill("#story .rg-col"), role("--rf-steel")],
        innerCol: [fill("#story .rg-col.i"), role("--rf-ink")],
        top: [fill("#story .rg-top"), role("--rf-white")],
      };
    });
    for (const [name, [got, want]] of Object.entries(r)) {
      expect(got, name).not.toBe("rgb(0, 0, 0)");
      expect(got, name).toBe(want);
    }
    expect(r.outerWall[0], "the two wall layers differ").not.toBe(r.innerWall[0]);
  });

  test(`K1 the hub carries the logo as one image @${v.w}x${v.h}`, async ({ page }) => {
    await open(page, v.w, v.h);
    const hub = await page.evaluate(() => {
      const imgs = document.querySelectorAll("#story .hub image");
      const img = imgs[0] as SVGImageElement | undefined;
      return { count: imgs.length, href: img?.getAttribute("href") || "" };
    });
    expect(hub.count, "one image on the hub").toBe(1);
    expect(hub.href, "drawn from the brand symbol").not.toBe("");
    const ok = await page.evaluate(
      (href) => fetch(href).then((r) => r.ok),
      new URL(hub.href, page.url()).toString(),
    );
    expect(ok, "the symbol file loads").toBe(true);
  });
}
