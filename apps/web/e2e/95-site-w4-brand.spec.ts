/**
 * Wave 4, lane 2.5a, project "site-waves": K4 (the plan buttons line up). On /pricing every plan card's button
 * sits right after its price and its "for" line, so within one grid row all `.pcard .pbtn` tops are equal within
 * 1 px, at 1440x900, 1100x900 (where the "for" lines wrap unevenly) and 393x844 (the table shows, no cards).
 * SA-1200 A4 kept this order over the list-then-button wrapper. Signed out, desktop Chrome, against a running
 * stack. A sweep that finds nothing throws (L-202).
 */
import { test, expect } from "@playwright/test";
import { blockAnalytics } from "./helpers/site-proof";

test.beforeEach(async ({ context }) => {
  await blockAnalytics(context);
});

const SCREENS = [
  { w: 1440, h: 900 },
  { w: 1100, h: 900 },
  { w: 393, h: 844 },
] as const;

for (const { w, h } of SCREENS) {
  test(`K4: plan buttons share one top per grid row at ${w}x${h}`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/pricing", { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);

    const all = await page.evaluate(() =>
      [...document.querySelectorAll(".pgrid--4 .pcard")].map((card) => {
        const btn = card.querySelector(".pbtn");
        const pfor = card.querySelector(".pfor");
        const list = card.querySelector(".checks");
        const box = card.getBoundingClientRect();
        const shown = getComputedStyle(card).display !== "none" && box.width > 0 && box.height > 0;
        const top = (el: Element | null) =>
          el ? Math.round(el.getBoundingClientRect().top * 100) / 100 : null;
        return {
          shown,
          cardTop: top(card),
          btnTop: top(btn),
          forTop: top(pfor),
          listTop: top(list),
        };
      }),
    );
    if (all.length === 0) throw new Error("no plan cards found on /pricing");
    const cards = all.filter((c) => c.shown);

    if (w < 900) {
      // Phones read the plan table instead of the four cards, so there is nothing to measure here.
      expect(cards, "no plan card is shown on a phone").toHaveLength(0);
      await expect(page.locator(".pl-wrap")).toBeVisible();
      return;
    }
    expect(cards.length, "the four plan cards are shown").toBeGreaterThanOrEqual(4);
    const problems: string[] = [];
    const rows = new Map<number, number[]>();
    cards.forEach((c, i) => {
      if (c.btnTop === null || c.forTop === null || c.listTop === null) {
        problems.push(`card ${i}: missing button, price line or list`);
        return;
      }
      // price, then button, then list
      if (!(c.forTop < c.btnTop && c.btnTop < c.listTop)) {
        problems.push(`card ${i}: order is not price, button, list`);
      }
      const row = Math.round((c.cardTop ?? 0) / 4);
      rows.set(row, [...(rows.get(row) ?? []), c.btnTop]);
    });
    for (const [row, tops] of rows) {
      const spread = Math.max(...tops) - Math.min(...tops);
      if (spread > 1)
        problems.push(`row ${row}: button tops differ by ${spread}px (${tops.join(", ")})`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
}
