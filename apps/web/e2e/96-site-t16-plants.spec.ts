/**
 * T16 walk plants (SA-1203 A11), project "site-proof", opt-in: the tests below exist only when
 * T16_PLANTS=1 is set, so the normal run and the post-deploy job never see them.
 *
 * Each plant injects ONE defect through page.addStyleTag / page.evaluate / page.addInitScript (never by
 * editing a site file), runs the same walk as spec 85, and asserts the outcome SA-1203 A11 states for it:
 * red (the walk reports the problem) or green and counted. The plant run therefore passes when every plant
 * behaves as A11 says. A plant that does not behave fails with the problems the walk did report.
 *
 *   W1  the only sign-up hidden at 390                   red:   not rendered and no equivalent measured
 *   W2  the hero sign-up hidden, the header one stays    green: the skip is counted as accepted
 *   W3  a menu item mid-transition at walk start         green: settles, measured
 *   W4  an infinite animation on one focusable           red:   unsettled
 *   W5  an ink ring on a new dark band, no setter        red:   ring below 3:1 and no on-panel token (T16);
 *                                                              the static half is in site-colour-walk.static.test.ts
 *   W6  low-contrast text in the open menu               red:   text contrast (the menu pass runs every check)
 *   W7  a :root --rf-focus override                      red:   ring below 3:1
 *   W8  an entry added to T16_SIZE_ONLY                  a static Jest case (site-colour-walk.static.test.ts)
 */
import { test, expect, type Page } from "@playwright/test";
import { blockAnalytics, sizeName } from "./helpers/site-proof";
import {
  judgeColours,
  openForWalk,
  readWalk,
  type OpenHooks,
  type Walk,
} from "./helpers/site-colour-walk";

const PHONE = { w: 390, h: 844 };
const DESKTOP = { w: 1440, h: 900 };
const SIGN_UP = 'a[href*="signup"], a[href*="register"]';

async function walkWith(
  page: Page,
  route: string,
  size: { w: number; h: number },
  hooks: OpenHooks,
) {
  await openForWalk(page, route, size, hooks);
  const walk: Walk = await readWalk(page, route, size);
  const result = judgeColours(walk, `${route} ${sizeName(size)}`);
  return { walk, ...result };
}

const has = (problems: string[], re: RegExp) => problems.some((p) => re.test(p));
const shown = (problems: string[]) => problems.slice(0, 12).join("\n");

if (process.env.T16_PLANTS === "1") {
  test.describe.configure({ mode: "parallel" });

  test.beforeEach(async ({ context }) => {
    await blockAnalytics(context);
  });

  test("T16 plant W1 the only sign-up hidden at 390 is red", async ({ page }) => {
    test.setTimeout(240_000);
    const { problems } = await walkWith(page, "/", PHONE, {
      afterLoad: async (p) => {
        const n = await p.locator(SIGN_UP).count();
        expect(n, "W1 setup: sign-up links on the page").toBeGreaterThan(0);
        await p.addStyleTag({ content: `${SIGN_UP}{display:none !important}` });
      },
    });
    expect(
      has(problems, /not rendered and no equivalent measured/),
      `W1 must be red with "not rendered and no equivalent measured"; got:\n${shown(problems)}`,
    ).toBe(true);
  });

  test("T16 plant W2 a hidden hero sign-up with the header one measured is green and counted", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const { problems, accepted } = await walkWith(page, "/", PHONE, {
      afterLoad: async (p) => {
        const marked = await p.evaluate((sel) => {
          const hero = [...document.querySelectorAll<HTMLElement>(sel)].find(
            (a) => !a.closest(".site-header, #mobile-menu"),
          );
          hero?.setAttribute("data-w2", "1");
          return Boolean(hero);
        }, SIGN_UP);
        expect(marked, "W2 setup: a sign-up link outside the header and the menu").toBe(true);
        await p.addStyleTag({ content: "[data-w2]{display:none !important}" });
      },
    });
    expect(
      problems.filter((p) => /not rendered and no equivalent measured/.test(p)),
      "W2 must not be red for the hidden hero sign-up",
    ).toEqual([]);
    expect(accepted, "W2: the not-rendered skip is counted as accepted").toBeGreaterThanOrEqual(1);
  });

  test("T16 plant W3 a menu item mid-transition settles and is measured", async ({ page }) => {
    test.setTimeout(240_000);
    const { problems, walk } = await walkWith(page, "/", PHONE, {
      beforeGoto: async (p) => {
        await p.addInitScript(() => {
          document.addEventListener("DOMContentLoaded", () => {
            const s = document.createElement("style");
            s.textContent =
              "@keyframes t16w3{from{opacity:.2;transform:translateX(24px)}to{opacity:1;transform:none}}" +
              "#mobile-menu.open a{animation:t16w3 .9s ease-out both}";
            document.head.appendChild(s);
          });
        });
      },
    });
    expect(
      has(problems, /unsettled/),
      `W3 must settle, not be "unsettled"; got:\n${shown(problems)}`,
    ).toBe(false);
    expect(walk.rings.length, "W3: the menu items were measured").toBeGreaterThan(0);
    const animated = await page.evaluate(() => {
      const a = document.querySelector("#mobile-menu a");
      return a ? getComputedStyle(a).animationName : "";
    });
    expect(animated, "W3 setup: the plant's animation is on a menu link").toContain("t16w3");
  });

  test("T16 plant W4 an infinite animation on one focusable is red as unsettled", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const { problems } = await walkWith(page, "/", DESKTOP, {
      afterLoad: async (p) => {
        const ok = await p.evaluate(() => {
          const a = document.querySelector<HTMLElement>("main a.btn, a.btn");
          a?.setAttribute("data-w4", "1");
          return Boolean(a);
        });
        expect(ok, "W4 setup: a button link on the page").toBe(true);
        await p.addStyleTag({
          content:
            "@keyframes t16w4{from{transform:translateX(0)}to{transform:translateX(14px)}}" +
            "[data-w4]{animation:t16w4 .4s linear infinite alternate !important}",
        });
      },
    });
    expect(
      has(problems, /not measured: unsettled/),
      `W4 must be red as unsettled; got:\n${shown(problems)}`,
    ).toBe(true);
  });

  test("T16 plant W5 an ink ring on a new dark band with no setter is red", async ({ page }) => {
    test.setTimeout(240_000);
    const { problems } = await walkWith(page, "/pricing", DESKTOP, {
      afterLoad: async (p) => {
        await p.addStyleTag({
          content: ".t16-w5{background:var(--rf-panel);color:var(--rf-on-panel);padding:48px}",
        });
        await p.evaluate(() => {
          const s = document.createElement("section");
          s.className = "t16-w5";
          s.innerHTML = '<a href="/pricing">A link on a new dark band</a>';
          document.body.appendChild(s);
        });
      },
    });
    expect(
      has(problems, /^ring .* < 3 /),
      `W5 must be red on the ring contrast; got:\n${shown(problems)}`,
    ).toBe(true);
    expect(
      has(problems, /does not set --rf-focus to the on-panel token/),
      `W5 must be red on the missing on-panel token; got:\n${shown(problems)}`,
    ).toBe(true);
  });

  test("T16 plant W6 low-contrast text in the open menu is red", async ({ page }) => {
    test.setTimeout(240_000);
    const { problems } = await walkWith(page, "/", PHONE, {
      afterLoad: async (p) => {
        await p.addStyleTag({
          content:
            "#mobile-menu{background:#fff !important}#mobile-menu a{color:#cfcfcf !important}",
        });
      },
    });
    expect(
      problems.some((x) => x.startsWith("text ") && x.includes("rgb(207, 207, 207)")),
      `W6 must be red on the menu text contrast; got:\n${shown(problems)}`,
    ).toBe(true);
  });

  test("T16 plant W7 a :root --rf-focus override out of scope is red", async ({ page }) => {
    test.setTimeout(240_000);
    const { problems } = await walkWith(page, "/pricing", DESKTOP, {
      afterLoad: async (p) => {
        await p.addStyleTag({ content: ":root{--rf-focus:#ffffff !important}" });
      },
    });
    expect(
      has(problems, /^ring .* < 3 /),
      `W7 must be red on the ring contrast; got:\n${shown(problems)}`,
    ).toBe(true);
  });
}
