/**
 * Wave 3, lane 2.3-pricing, project "site-waves": T46b (three key presses to the first plan), T20 (the pricing band
 * table, ux-spec §5) and T15 (every big opaque background is white, bone or ink).
 * Signed out, desktop Chrome, against a running stack (baseURL as in the other site specs). Colours are read from the
 * page's own token style, never typed here. Each test gathers every problem and asserts once; a sweep that finds
 * nothing throws (L-202).
 */
import { test, expect, type Page } from "@playwright/test";
import { blockAnalytics, nonEmpty } from "./helpers/site-proof";

test.beforeEach(async ({ context }) => {
  await blockAnalytics(context);
});

const SCREENS = [
  { w: 1440, h: 900 },
  { w: 393, h: 844 },
] as const;

async function open(page: Page, w: number, h: number): Promise<void> {
  await page.setViewportSize({ width: w, height: h });
  await page.goto("/pricing", { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
}

/** A token's colour as the browser computes it, so a band is compared with the page's own white, bone and ink. */
async function tokenColours(page: Page): Promise<Record<"white" | "bone" | "ink", string>> {
  return page.evaluate(() => {
    const probe = document.createElement("i");
    document.body.appendChild(probe);
    const read = (token: string) => {
      probe.style.backgroundColor = `var(${token})`;
      return getComputedStyle(probe).backgroundColor;
    };
    const out = { white: read("--rf-white"), bone: read("--rf-bone"), ink: read("--rf-ink") };
    probe.remove();
    return out;
  });
}

// ─── T46b ───────────────────────────────────────────────────────────────────

/** The plan start control a visitor can reach: the plan cards' button, or the phone's list button when the cards are hidden. */
const PLAN_START = "#plans";

test.describe("T46b three key presses to the first plan (F04)", () => {
  for (const { w, h } of SCREENS) {
    test(`T46b Tab and Enter only reach the first plan's button in 3 presses: @${w}x${h}`, async ({
      page,
    }) => {
      await open(page, w, h);
      // The skip links a visitor sees (display:none ones are not in the tab order). They take the last one: it is the
      // most specific, and it comes after "Skip to content".
      const skips = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLAnchorElement>("a.skip"))
          .filter((a) => a.getClientRects().length > 0)
          .map((a) => a.textContent?.trim() ?? ""),
      );
      nonEmpty(skips, "skip links");
      let presses = 0;
      for (let i = 0; i < skips.length; i++) {
        await page.keyboard.press("Tab");
        presses++;
      }
      const onTarget = await page.evaluate(
        (label) => (document.activeElement?.textContent ?? "").trim() === label,
        skips[skips.length - 1],
      );
      expect(onTarget, `focus is on the skip link "${skips[skips.length - 1]}"`).toBe(true);
      await page.keyboard.press("Enter");
      presses++;
      const isPlanStart = () =>
        page.evaluate((sel) => {
          const first = Array.from(document.querySelectorAll<HTMLElement>(sel)).find(
            (el) => el.getClientRects().length > 0,
          );
          if (!first) throw new Error(`no rendered ${sel}`);
          return document.activeElement === first;
        }, PLAN_START);
      const trail: string[] = [];
      while (!(await isPlanStart()) && presses < 12) {
        await page.keyboard.press("Tab");
        presses++;
        trail.push(
          await page.evaluate(
            () =>
              `${document.activeElement?.tagName.toLowerCase()} "${(document.activeElement?.textContent ?? "").trim().slice(0, 40)}"`,
          ),
        );
      }
      expect(
        presses,
        `key presses from a fresh load to the first plan's button (skip links ${skips.join(" | ")}; then ${trail.join(" > ")})`,
      ).toBeLessThanOrEqual(3);
      expect(await isPlanStart(), "focus ends on the first plan's button").toBe(true);
    });
  }

  test("T46b the link says Skip to plans and goes to a real target on the wide page only", async ({
    page,
  }) => {
    await open(page, 1440, 900);
    const link = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll<HTMLAnchorElement>("a.skip")).find(
        (x) => x.getAttribute("href") === "#plans",
      );
      if (!a) return null;
      const target = document.getElementById("plans");
      return {
        text: a.textContent?.trim(),
        target: !!target && target === document.querySelector(".pg-cta .btn"),
      };
    });
    expect(link, "the wide page has a skip link to #plans").not.toBeNull();
    expect(link?.text).toBe("Skip to plans");
    expect(link?.target, "#plans is the start-trial button").toBe(true);
    // C9: the button must also be drawn at this width (a later rule hiding .pg-cta must turn this red)
    const drawn = await page.evaluate(() => {
      const el = document.getElementById("plans");
      return {
        rects: el ? el.getClientRects().length : 0,
        display: el ? getComputedStyle(el).display : "none",
      };
    });
    expect(drawn.rects, "#plans is drawn on the wide page").toBeGreaterThan(0);
    expect(drawn.display, "#plans is not display:none on the wide page").not.toBe("none");
    await open(page, 393, 844);
    const shown = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll<HTMLAnchorElement>("a.skip")).filter(
          (a) => a.getClientRects().length > 0,
        ).length,
    );
    expect(shown, "on a phone only Skip to content is in the tab order").toBe(1);
  });
});

// ─── T20 ────────────────────────────────────────────────────────────────────

// ux-spec §5, "the other pages": alternate white and bone; ink panels holding white cards on a line; no gradient band.
const BANDS = [
  { sel: "main > section#pricing", role: "white" },
  { sel: "main > section#every-plan", role: "bone" },
  { sel: "main > section[aria-labelledby='faq-h']", role: "white" },
  { sel: "main > section[aria-labelledby='cta-h']", role: "bone" },
] as const;

for (const { w, h } of SCREENS) {
  test(`T20 the pricing bands alternate white and bone, flat, with ink only on panels: @${w}x${h}`, async ({
    page,
  }) => {
    await open(page, w, h);
    const colours = await tokenColours(page);
    const seen = await page.evaluate((bands) => {
      const bg = (el: Element) => {
        const s = getComputedStyle(el);
        return { colour: s.backgroundColor, image: s.backgroundImage };
      };
      const rows = bands.map((b) => {
        const el = document.querySelector(b.sel);
        return { sel: b.sel, found: !!el, ...(el ? bg(el) : { colour: "", image: "" }) };
      });
      const top = document.querySelector("main > section#pricing");
      const line = !!top && top.classList.contains("band-line");
      const sections = document.querySelectorAll("main > section").length;
      const panels = Array.from(document.querySelectorAll(".cta-band")).map((el) => ({
        cls: el.className,
        ...bg(el),
      }));
      return { rows, line, sections, panels };
    }, BANDS);
    const problems: string[] = [];
    nonEmpty(seen.rows, "pricing bands");
    if (seen.sections !== BANDS.length)
      problems.push(`${seen.sections} sections in main, the table has ${BANDS.length}`);
    BANDS.forEach((b, i) => {
      const r = seen.rows[i];
      if (!r.found) problems.push(`${b.sel}: not found`);
      else if (r.colour !== colours[b.role])
        problems.push(`${b.sel}: ${r.colour}, wanted ${b.role} ${colours[b.role]}`);
      if (r.image !== "none") problems.push(`${b.sel}: background-image ${r.image} (flat only)`);
    });
    // The drawn one-pixel line is the header lane's rule, measured in its spec 93; here only the class is checked.
    if (!seen.line) problems.push(`the top band lacks the band-line class`);
    nonEmpty(seen.panels, "ink panels");
    for (const p of seen.panels) {
      if (p.colour !== colours.ink)
        problems.push(`.${p.cls}: ${p.colour}, wanted ink ${colours.ink}`);
      if (p.image !== "none") problems.push(`.${p.cls}: background-image ${p.image}`);
    }
    expect(problems, `/pricing @${w}x${h}: ${problems.join("; ")}`).toEqual([]);
  });
}

// ─── T15 ────────────────────────────────────────────────────────────────────

for (const { w, h } of SCREENS) {
  test(`T15 every opaque background over a quarter of the window is white, bone or ink: @${w}x${h}`, async ({
    page,
  }) => {
    await open(page, w, h);
    const colours = await tokenColours(page);
    const allowed = new Set(Object.values(colours));
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    const found: { name: string; colour: string }[] = [];
    const bad: string[] = [];
    for (let y = 0; y < total; y += Math.max(1, h - 100)) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      const big = await page.evaluate(() => {
        const out: { name: string; colour: string }[] = [];
        const win = innerWidth * innerHeight;
        for (const el of Array.from(document.body.querySelectorAll("*"))) {
          const s = getComputedStyle(el);
          if (s.display === "none" || s.visibility === "hidden") continue;
          const m = s.backgroundColor.match(/[\d.]+/g);
          if (!m || m.length < 3 || (m.length > 3 && Number(m[3]) < 0.95)) continue;
          const r = el.getBoundingClientRect();
          const vw = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
          const vh = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
          if ((vw * vh) / win >= 0.25)
            out.push({
              name: `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ")[0] : ""}`,
              colour: s.backgroundColor,
            });
        }
        return out;
      });
      for (const b of big) {
        found.push(b);
        if (!allowed.has(b.colour)) bad.push(`${b.name} ${b.colour}`);
      }
    }
    nonEmpty(found, "backgrounds over a quarter of the window");
    expect(bad, `/pricing @${w}x${h}: ${[...new Set(bad)].join("; ")}`).toEqual([]);
  });
}
