/**
 * T16 walk plants (SA-1203 A12, the panel record's case table), project "site-proof", opt-in: the tests below
 * exist only when T16_PLANTS=1 is set, so the normal run and the post-deploy job never see them.
 *
 * Each plant is injected from the test side (addStyleTag, evaluate, addInitScript; never a site file) and keyed
 * by `data-t16-plant="<id>"`. The walk reads the keyed element in its own state, and each assertion reads
 * THAT row's exact field. A planted page runs clean, planted, clean (S12): two clean runs that differ are
 * `nondeterministic` (red, never retried), and the planted run may differ from a clean one on keyed rows only.
 *
 *   W1  ring colour = backdrop, one link                  the keyed ring row is below 3:1
 *   W2  one desktop-nav link hidden, no equivalent        the keyed skip is unreached, red, not listed
 *   W3  ring removed on one 390 menu item                 a menu row, Tab-reached, no ring
 *   W4  infinite animation on one focusable               the keyed row is unsettled; its neighbour is measured
 *   W5  an ink ring on a new dark band, no setter         the keyed row: bandDark, below 3:1, not the on-panel token
 *   W6  low-contrast text in the open menu                the keyed menu text row is below the threshold
 *   W7  --rf-focus set to white out of scope              the keyed ring row is below 3:1 (set on the element)
 *   W8  .site-header.on-dark{--rf-focus:<ink>}            every dark header row is red
 *   W9  contrast drop on one text                         the keyed text row is below the threshold
 *   W10 empty-target button, matching name                the keyed skip is red (not accepted)
 *   W11 600 ms fade, fail to pass; a twin that fails      green, settleFrames > 3; the twin is red
 *   W12 a faked 400 px snap (drift detector only)         drift > 0; the final position or obscured
 *   B1  no plant, header light                            green, no band red
 *   SNAP-real  no plant, the wheel control reached by Tab scrollY, drift and the DOM label recorded
 *   W13 (the length pin on T16_SIZE_ONLY) is a Jest case in site-colour-walk.static.test.ts
 */
import { test, expect, type Page } from "@playwright/test";
import { contrast, sizeName } from "./helpers/site-proof";
import {
  INK,
  judgeColours,
  walkPageSize,
  type OpenHooks,
  type Walk,
} from "./helpers/site-colour-walk";
import {
  PLANTS_TEST_HARD_MS,
  diffSignatures,
  readProblems,
  signatures,
  unreachedVerdict,
  type RingRead,
  type TextRow,
} from "./helpers/site-colour-walk-pure";

const PHONE = { w: 390, h: 844 };
const DESKTOP = { w: 1440, h: 900 };
/** Three walks of at most 60 s each fit in one test's hard timeout, with room to spare. */
const WALK_HARD_MS = 110_000;

type Plant = { route: string; size: { w: number; h: number }; hooks: OpenHooks };

async function threeRuns(p: Plant): Promise<{ clean1: Walk; planted: Walk; clean2: Walk }> {
  const opts = { hardMs: WALK_HARD_MS };
  const clean1 = await walkPageSize(p.route, p.size, opts);
  const planted = await walkPageSize(p.route, p.size, { ...opts, hooks: p.hooks });
  const clean2 = await walkPageSize(p.route, p.size, opts);
  return { clean1, planted, clean2 };
}

/** S12: clean against clean must agree (else nondeterministic); planted against clean may differ on keyed rows only. */
function expectStable(label: string, r: { clean1: Walk; planted: Walk; clean2: Walk }): void {
  expect(
    diffSignatures(signatures(r.clean1), signatures(r.clean2)),
    `${label}: nondeterministic, two clean runs differ on these rows`,
  ).toEqual([]);
  expect(
    diffSignatures(signatures(r.planted), signatures(r.clean1)),
    `${label}: the planted run differs from the clean run on rows that carry no plant`,
  ).toEqual([]);
}

const rowOf = (w: Walk, id: string): RingRead => {
  const r = w.rows.find((x) => x.plant === id);
  if (!r) throw new Error(`plant ${id}: no focus row carries it (it was not reached by Tab)`);
  return r;
};
const textOf = (w: Walk, id: string): TextRow => {
  const t = w.texts.find((x) => x.plant === id);
  if (!t) throw new Error(`plant ${id}: no text row carries it`);
  return t;
};

/** Appends a white wrapper at the end of the body, so every planted element has a known white backdrop. */
async function appendPlants(p: Page, html: string, css: string, wrapStyle = ""): Promise<void> {
  await p.addStyleTag({ content: css });
  await p.evaluate(
    ({ html, wrapStyle }) => {
      const d = document.createElement("div");
      d.id = "t16-plants";
      d.style.cssText = `background:#fff;color:#111;padding:16px;${wrapStyle}`;
      d.innerHTML = html;
      document.body.appendChild(d);
    },
    { html, wrapStyle },
  );
}

if (process.env.T16_PLANTS === "1") {
  test.describe.configure({ mode: "parallel" });

  test("T16 plants W1 W4 W10 W11 share / 1440x900", async () => {
    test.setTimeout(PLANTS_TEST_HARD_MS);
    const label = `/ ${sizeName(DESKTOP)}`;
    const r = await threeRuns({
      route: "/",
      size: DESKTOP,
      hooks: {
        afterLoad: (p) =>
          appendPlants(
            p,
            '<a href="/pricing" data-t16-plant="W1">W1 link</a> ' +
              '<a href="/pricing" data-t16-plant="W4">W4 moving</a> ' +
              '<a href="/pricing" data-t16-plant="W4-neighbour">W4 neighbour</a> ' +
              '<button type="button" data-t16-plant="W10-visible">Send</button> ' +
              '<button type="button" data-t16-plant="W10" style="display:none">Send</button> ' +
              '<a href="/pricing" data-t16-plant="W11">W11 fade</a> ' +
              '<a href="/pricing" data-t16-plant="W11-twin">W11 twin</a>',
            '[data-t16-plant="W1"]:focus-visible{outline-color:#ffffff !important}' +
              "@keyframes t16w4{from{transform:translateX(0)}to{transform:translateX(14px)}}" +
              '[data-t16-plant="W4"]{display:inline-block;animation:t16w4 .4s linear infinite alternate}' +
              '[data-t16-plant^="W11"]{transition:outline-color 600ms linear}' +
              '[data-t16-plant^="W11"]:not(:focus-visible){outline:3px solid #ffffff}' +
              '[data-t16-plant="W11-twin"]:focus-visible{outline-color:#ececec !important}',
          ),
      },
    });
    expectStable(label, r);
    const w = r.planted;
    // SA-1203 A12 W1: the ring is the backdrop colour, so the keyed row's ring is below 3:1.
    const w1 = rowOf(w, "W1");
    expect.soft(w1.ring.color, "W1: the ring colour is the backdrop colour").toBe(w1.backdrop);
    expect.soft(w1.ringContrast ?? 99, "W1: ring contrast").toBeLessThan(3);
    // SA-1203 A12 W4: the animated focusable is unsettled at the cap; the named neighbour is measured.
    expect.soft(rowOf(w, "W4").state, "W4: the animated focusable").toBe("unsettled");
    expect.soft(rowOf(w, "W4-neighbour").state, "W4: the neighbour").toBe("measured");
    // SA-1203 A12 W10: two empty targets with the same name are not an equivalent (S11).
    const w10 = w.unreached.find((s) => s.plant === "W10");
    expect.soft(w10?.reason, "W10: the hidden button is unreached").toBe("unreached");
    expect
      .soft(
        w10
          ? unreachedVerdict(
              w10,
              w.rows.map((x) => x.info),
            )
          : "missing",
        "W10: verdict",
      )
      .toBe("red");
    // SA-1203 A12 W11: the fade ends passing and the read waited for it; the twin ends failing.
    const w11 = rowOf(w, "W11");
    expect.soft(w11.state, "W11: state").toBe("measured");
    expect.soft(w11.ringContrast ?? 0, "W11: settled ring contrast").toBeGreaterThanOrEqual(3);
    // The record says > 2; the least a settle can take is 3 frames, so > 3 is what shows it waited out the fade.
    expect.soft(w11.settleFrames, "W11: settleFrames").toBeGreaterThan(3);
    const twin = rowOf(w, "W11-twin");
    expect.soft(twin.state, "W11 twin: state").toBe("measured");
    expect.soft(twin.ringContrast ?? 99, "W11 twin: settled ring contrast").toBeLessThan(3);
  });

  test("T16 plant W2 a desktop-nav link with no equivalent is unreached and red", async () => {
    test.setTimeout(PLANTS_TEST_HARD_MS);
    const r = await threeRuns({
      route: "/",
      size: DESKTOP,
      hooks: {
        afterLoad: async (p) => {
          const ok = await p.evaluate(() => {
            const a = document.querySelector<HTMLAnchorElement>(".nav-links a");
            if (!a) return false;
            a.setAttribute("data-t16-plant", "W2");
            a.setAttribute("href", "/t16-w2-only");
            a.style.display = "none";
            return true;
          });
          expect(ok, "W2 setup: a desktop-nav link").toBe(true);
        },
      },
    });
    expectStable(`/ ${sizeName(DESKTOP)}`, r);
    const s = r.planted.unreached.find((x) => x.plant === "W2");
    // SA-1203 A12 W2: unreached, no C1 equivalent, no C2 entry.
    expect.soft(s?.reason, "W2: reason").toBe("unreached");
    expect.soft(s?.sizeOnly, "W2: not listed in T16_SIZE_ONLY").toBe(false);
    expect
      .soft(
        s
          ? unreachedVerdict(
              s,
              r.planted.rows.map((x) => x.info),
            )
          : "missing",
        "W2: verdict",
      )
      .toBe("red");
  });

  test("T16 plant W3 no ring on one 390 menu item is red", async () => {
    test.setTimeout(PLANTS_TEST_HARD_MS);
    const r = await threeRuns({
      route: "/",
      size: PHONE,
      hooks: {
        afterLoad: async (p) => {
          const ok = await p.evaluate(() => {
            const a = document.querySelector("#mobile-menu nav a:not(.btn)");
            a?.setAttribute("data-t16-plant", "W3");
            return Boolean(a);
          });
          expect(ok, "W3 setup: a menu link").toBe(true);
          await p.addStyleTag({
            content: '[data-t16-plant="W3"]:focus-visible{outline:none !important}',
          });
        },
      },
    });
    expectStable(`/ ${sizeName(PHONE)}`, r);
    const w3 = rowOf(r.planted, "W3");
    // SA-1203 A12 W3: a menu row, reached by Tab, with no ring.
    expect.soft(w3.part, "W3: part").toBe("menu");
    expect.soft(w3.tab, "W3: reached by Tab").not.toBeNull();
    expect.soft(w3.ring.style, "W3: ring style").toBe("none");
    expect.soft(w3.ringContrast ?? 99, "W3: ring contrast").toBeLessThan(3);
  });

  test("T16 plant W5 an ink ring on a new dark band with no setter is red", async () => {
    test.setTimeout(PLANTS_TEST_HARD_MS);
    const r = await threeRuns({
      route: "/pricing",
      size: DESKTOP,
      hooks: {
        afterLoad: (p) =>
          appendPlants(
            p,
            '<section class="t16-w5"><a href="/pricing" data-t16-plant="W5">A link on a new dark band</a></section>',
            ".t16-w5{background:var(--rf-panel);color:var(--rf-on-panel);padding:48px}",
          ),
      },
    });
    expectStable(`/pricing ${sizeName(DESKTOP)}`, r);
    const w5 = rowOf(r.planted, "W5");
    // SA-1203 A12 W5 (A11 verdict): on a dark band, the ring is ink on ink and the ring token is not the on-panel one.
    expect.soft(w5.bandDark, "W5: the backdrop is a panel").toBe(true);
    expect.soft(w5.ringContrast ?? 99, "W5: ring contrast").toBeLessThan(3);
    expect.soft(w5.focusTok, "W5: --rf-focus is not the on-panel token").not.toBe(w5.onPanel);
  });

  test("T16 plant W6 low-contrast text in the open menu is red", async () => {
    test.setTimeout(PLANTS_TEST_HARD_MS);
    const r = await threeRuns({
      route: "/",
      size: PHONE,
      hooks: {
        afterLoad: async (p) => {
          const ok = await p.evaluate(() => {
            const a = document.querySelector("#mobile-menu nav a:not(.btn)");
            a?.setAttribute("data-t16-plant", "W6");
            return Boolean(a);
          });
          expect(ok, "W6 setup: a menu link").toBe(true);
          await p.addStyleTag({
            content:
              '[data-t16-plant="W6"]{color:#cfcfcf !important;background:#ffffff !important}',
          });
        },
      },
    });
    expectStable(`/ ${sizeName(PHONE)}`, r);
    const t = textOf(r.planted, "W6");
    // SA-1203 A12 W6 (C4): the menu pass runs every check, so the menu text is read and is below 3:1.
    expect.soft(t.part, "W6: part").toBe("menu");
    expect.soft(contrast(t.fg, t.bg ?? "rgb(255, 255, 255)"), "W6: text contrast").toBeLessThan(3);
  });

  test("T16 plant W7 a white --rf-focus out of scope is red", async () => {
    test.setTimeout(PLANTS_TEST_HARD_MS);
    const r = await threeRuns({
      route: "/pricing",
      size: DESKTOP,
      hooks: {
        afterLoad: (p) =>
          appendPlants(
            p,
            '<a href="/pricing" data-t16-plant="W7">W7 link</a>',
            // Set on the keyed element, not on :root, so only the keyed row differs (S12); the walk reads the live ring either way.
            '[data-t16-plant="W7"]{--rf-focus:#ffffff !important}',
          ),
      },
    });
    expectStable(`/pricing ${sizeName(DESKTOP)}`, r);
    const w7 = rowOf(r.planted, "W7");
    // SA-1203 A12 W7 (A11 verdict): the live token is white on a white backdrop, so the ring is below 3:1.
    expect.soft(w7.focusTok, "W7: the live --rf-focus").toBe("rgb(255, 255, 255)");
    expect.soft(w7.ringContrast ?? 99, "W7: ring contrast").toBeLessThan(3);
  });

  test("T16 plant W8 an ink ring on the dark header is red", async () => {
    test.setTimeout(PLANTS_TEST_HARD_MS);
    const r = await threeRuns({
      route: "/",
      size: DESKTOP,
      hooks: {
        afterLoad: async (p) => {
          await p.evaluate(() =>
            document.querySelector(".site-header")?.setAttribute("data-t16-plant", "W8"),
          );
          await p.addStyleTag({ content: `.site-header.on-dark{--rf-focus:${INK} !important}` });
        },
      },
    });
    expectStable(`/ ${sizeName(DESKTOP)}`, r);
    const dark = r.planted.rows.filter((x) => x.part === "header" && x.headerState === "dark");
    // SA-1203 A12 W8: every header row read in the dark state is red.
    expect.soft(dark.length, "W8: header rows read in the dark state").toBeGreaterThan(0);
    for (const row of dark)
      expect.soft(readProblems(row), `W8: ${row.sel} in the dark header`).not.toEqual([]);
  });

  test("T16 plant W9 a contrast drop on one text is red", async () => {
    test.setTimeout(PLANTS_TEST_HARD_MS);
    const r = await threeRuns({
      route: "/pricing",
      size: DESKTOP,
      hooks: {
        afterLoad: async (p) => {
          const ok = await p.evaluate(() => {
            const el = [...document.querySelectorAll<HTMLElement>("main p")].find(
              (e) =>
                e.getClientRects().length > 0 &&
                (e.textContent ?? "").trim().length > 20 &&
                !e.closest(".site-header, #mobile-menu"),
            );
            if (!el) return false;
            el.setAttribute("data-t16-plant", "W9");
            el.style.setProperty("color", "#cfcfcf", "important");
            el.style.setProperty("background-color", "#ffffff", "important");
            return true;
          });
          expect(ok, "W9 setup: a paragraph on the page").toBe(true);
        },
      },
    });
    expectStable(`/pricing ${sizeName(DESKTOP)}`, r);
    const t = textOf(r.planted, "W9");
    // SA-1203 A12 W9: the keyed text row is below the threshold.
    expect.soft(contrast(t.fg, t.bg ?? "rgb(255, 255, 255)"), "W9: text contrast").toBeLessThan(3);
  });

  test("T16 plant W12 a faked 400 px snap shows as drift", async () => {
    test.setTimeout(PLANTS_TEST_HARD_MS);
    const r = await threeRuns({
      route: "/pricing",
      size: DESKTOP,
      hooks: {
        beforeGoto: async (p) => {
          await p.addInitScript(() => {
            document.addEventListener(
              "focusin",
              (e) => {
                const t = e.target;
                if (!(t instanceof Element) || t.getAttribute("data-t16-plant") !== "W12") return;
                const y0 = window.scrollY;
                const t0 = performance.now();
                const step = (now: number) => {
                  const k = Math.min(1, (now - t0) / 400);
                  window.scrollTo({ top: y0 + 400 * k, behavior: "instant" as ScrollBehavior });
                  if (k < 1) requestAnimationFrame(step);
                };
                requestAnimationFrame(step);
              },
              true,
            );
          });
        },
        afterLoad: (p) =>
          appendPlants(
            p,
            '<a href="/pricing" data-t16-plant="W12">W12 link</a>',
            "",
            "padding-bottom:1600px;",
          ),
      },
    });
    expectStable(`/pricing ${sizeName(DESKTOP)}`, r);
    const w12 = rowOf(r.planted, "W12");
    // SA-1203 A12 W12: the detector sees the drift, and the row ends in view or obscured; it is never lost.
    expect.soft(w12.scrollY1 - w12.scrollY0, "W12: drift").toBeGreaterThan(0);
    expect.soft(w12.state === "obscured" || w12.inView, "W12: obscured or in view").toBe(true);
  });

  test("T16 B1 a clean page with the header light has no band red", async () => {
    test.setTimeout(PLANTS_TEST_HARD_MS);
    const w = await walkPageSize("/pricing", DESKTOP, { hardMs: WALK_HARD_MS });
    const light = w.rows.filter((x) => x.part === "header" && x.headerState === "light");
    // SA-1203 A12 B1: header light rows exist and are green, and no band is red.
    expect.soft(light.length, "B1: header rows read in the light state").toBeGreaterThan(0);
    for (const row of light) expect.soft(readProblems(row), `B1: ${row.sel}`).toEqual([]);
    expect
      .soft(
        judgeColours(w).problems.filter((p) => p.includes("kind=band-token")),
        "B1: band problems",
      )
      .toEqual([]);
  });

  test("T16 SNAP-real the wheel control reached by Tab records its scroll and label", async () => {
    test.setTimeout(PLANTS_TEST_HARD_MS);
    const w = await walkPageSize("/", DESKTOP, { hardMs: WALK_HARD_MS });
    const row = w.rows.find((x) => x.sel.startsWith("button.rfw-b"));
    expect(row, "SNAP-real: a wheel control was reached by Tab").toBeDefined();
    if (!row) return;
    // SA-1203 A12 SNAP-real: the browser's own Tab scroll and the site's own snap, both read after settle.
    test.info().annotations.push({
      type: "snap-real",
      description: `scrollY ${row.scrollY0} -> ${row.scrollY1}, drift ${row.scrollY1 - row.scrollY0}, label "${row.info.name}", state ${row.state}`,
    });
    expect(row.state, "SNAP-real: red only if the control is obscured").not.toBe("obscured");
  });
}
