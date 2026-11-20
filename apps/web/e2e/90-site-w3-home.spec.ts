/**
 * Wave 3, lane 2.3-home (the home page), project "site-waves": T20 (home's 14 bands hold the white, bone or ink role at
 * 1440x900 and 390x844), T15 (every opaque background covering a quarter of the window is white, bone or ink), T47 (the
 * problem section's invoice box sits inside its frame at 1440x900, P05). Signed out, desktop Chrome, against a running
 * stack (baseURL as in the other site specs). The three colours are read from the page's own token style
 * (--brand-white, --brand-bone, --brand-ink), never typed. Each test gathers every problem and asserts once; a sweep
 * that finds nothing throws (L-202); nothing sleeps.
 */
import { test, expect, type Page } from "@playwright/test";
import { blockAnalytics, frames, nonEmpty } from "./helpers/site-proof";

test.beforeEach(async ({ context }) => {
  await blockAnalytics(context);
});

const SCREENS = [
  { w: 1440, h: 900 },
  { w: 390, h: 844 },
] as const;

type Role = "white" | "bone" | "ink";
type Colours = Record<Role, string>;

/** The band table of ux-spec section 5, Home: selector -> the role its background holds. 14 rows. */
const BANDS: ReadonlyArray<readonly [string, Role]> = [
  ["#top", "white"],
  ["#one-system", "white"],
  ["#problem", "ink"],
  ["#journey", "bone"],
  ["#shot", "white"],
  ["#sell", "bone"],
  ["#stores", "white"],
  ["#counter", "bone"],
  ["#use-cases", "white"],
  ["#founder", "white"],
  ["#pricing", "bone"],
  ["#faq", "white"],
  ["#start", "ink"],
  ["footer.site-footer", "bone"],
];

/** App-picture frames: a phone's body is the device, not a band (listed, so an exemption is never silent). */
const FRAME_EXEMPT = [".pb-phone", ".st-phone", ".dv"] as const;

async function open(page: Page, w: number, h: number): Promise<void> {
  await page.setViewportSize({ width: w, height: h });
  await page.goto("/", { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
}

/** The three roles as the page's token style defines them, as the rgb() strings the browser computes. */
async function roles(page: Page): Promise<Colours> {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const rgb = (key: string): string => {
      const v = cs.getPropertyValue(`--brand-${key}`).trim();
      const m = /^#([0-9a-f]{6})$/i.exec(v);
      if (!m)
        throw new Error(`--brand-${key} is not a hex colour in the page's token style: "${v}"`);
      const n = parseInt(m[1] as string, 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    return { white: rgb("white"), bone: rgb("bone"), ink: rgb("ink") };
  });
}

// ─── T20 ────────────────────────────────────────────────────────────────────

for (const { w, h } of SCREENS) {
  test(`T20 home's 14 bands hold their role @${w}x${h}`, async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, w, h);
    const want = await roles(page);
    const seen = await page.evaluate(
      (rows) => {
        return rows.map(([sel, role]) => {
          const el = document.querySelector(sel);
          if (!el) return { sel, role, found: false, shown: false, bg: "" };
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            sel,
            role,
            found: true,
            shown: cs.display !== "none" && r.height > 0,
            bg: cs.backgroundColor,
          };
        });
      },
      BANDS as unknown as Array<[string, Role]>,
    );

    const problems: string[] = [];
    for (const row of seen) {
      if (!row.found) problems.push(`${row.sel}: not on the page`);
      // the app window picture is not shown on a phone (home.css: #shot is display:none under 900px)
      else if (!row.shown && !(row.sel === "#shot" && w < 900))
        problems.push(`${row.sel}: not shown`);
      else if (row.shown && row.bg !== want[row.role as Role])
        problems.push(`${row.sel}: want ${row.role} ${want[row.role as Role]}, got ${row.bg}`);
    }
    expect(
      nonEmpty(
        seen.filter((r) => r.shown),
        "home bands",
      ).length,
    ).toBeGreaterThanOrEqual(13);
    expect(seen).toHaveLength(14);
    expect(problems).toEqual([]);
  });
}

// ─── T15 ────────────────────────────────────────────────────────────────────

for (const { w, h } of SCREENS) {
  test(`T15 every opaque background of a quarter of the window is white, bone or ink @${w}x${h}`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await open(page, w, h);
    const want = await roles(page);
    const allowed = Object.values(want);
    const bad = new Set<string>();
    let big = 0;
    for (let y = 0, guard = 0; guard < 80; guard++) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await frames(page, 2);
      const found = await page.evaluate(
        ({ ok, exempt }) => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const out: { count: number; bad: string[]; max: number } = { count: 0, bad: [], max: 0 };
          for (const el of Array.from(document.querySelectorAll("body *"))) {
            const cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden") continue;
            const r = el.getBoundingClientRect();
            const share =
              (Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) *
                Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))) /
              (vw * vh);
            if (share < 0.25) continue;
            const m = /^rgba?\(([^)]+)\)$/.exec(cs.backgroundColor);
            const parts = m ? (m[1] as string).split(",").map((v) => parseFloat(v)) : [];
            const alpha = parts.length === 4 ? (parts[3] as number) : 1;
            const gradient = /gradient/.test(cs.backgroundImage);
            const opaque = (m !== null && alpha > 0.95) || gradient;
            if (!opaque) continue;
            if (exempt.some((s) => el.closest(s))) continue;
            out.count++;
            out.max = Math.max(out.max, share);
            const rgb = m ? `rgb(${parts.slice(0, 3).join(", ")})` : cs.backgroundColor;
            if (gradient || !ok.includes(rgb)) {
              const id = el.id ? `#${el.id}` : "";
              out.bad.push(
                `${el.tagName.toLowerCase()}${id}.${String(el.className).split(" ")[0]} ${gradient ? "gradient" : rgb}`,
              );
            }
          }
          return out;
        },
        { ok: allowed, exempt: [...FRAME_EXEMPT] },
      );
      big += found.count;
      for (const b of found.bad) bad.add(`y=${y}: ${b}`);
      const total = await page.evaluate(() => document.documentElement.scrollHeight);
      if (y + h >= total) break;
      y += Math.round(h * 0.8);
    }
    expect(big, "no opaque background of a quarter of the window was found").toBeGreaterThan(0);
    expect([...bad]).toEqual([]);
  });
}

// ─── T47 (P05) ──────────────────────────────────────────────────────────────

test("T47 the invoice box of the problem picture sits inside its frame @1440x900", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await open(page, 1440, 900);
  // Bring the pinned section to the beat where all three objects are in: past two lines of the three, before the fade.
  const top = await page.evaluate(() => {
    const s = document.querySelector("#problem") as HTMLElement | null;
    if (!s) throw new Error("no #problem section");
    return s.getBoundingClientRect().top + window.scrollY;
  });
  await page.evaluate(({ top: t, vh }) => window.scrollTo(0, t + vh * 1.7 * 0.6), { top, vh: 900 });
  // the scrub settles on the paper and the picture being fully drawn, never on a timer
  await page.waitForFunction(() => {
    const paper = document.querySelector(".pb-paper");
    const art = document.querySelector(".pb-art");
    return (
      !!paper &&
      !!art &&
      Number(getComputedStyle(paper).opacity) >= 0.99 &&
      Number(getComputedStyle(art).opacity) >= 0.99
    );
  });
  const m = await page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { l: r.left, t: r.top, r: r.right, b: r.bottom };
    };
    const paper = document.querySelector(".pb-paper") as HTMLElement | null;
    const head = document.querySelector(".pb-paper .pp-h") as HTMLElement | null;
    const art = document.querySelector(".pb-art") as HTMLElement | null;
    const big = document.querySelector(".pb-big") as HTMLElement | null;
    if (!paper || !head || !art || !big) throw new Error("the problem picture is missing a part");
    const bb = big.getBoundingClientRect();
    const pr = paper.getBoundingClientRect();
    const bigOverPaper =
      bb.left < pr.right && bb.right > pr.left && bb.top < pr.bottom && bb.bottom > pr.top;
    const bigOpacity = Number(getComputedStyle(big).opacity);
    const hr = head.getBoundingClientRect();
    const covered = [hr.left + 4, hr.left + hr.width / 2, hr.right - 4]
      .map((x) => document.elementFromPoint(x, hr.top + hr.height / 2))
      .filter((e) => !e || !e.closest(".pb-paper")).length;
    return {
      paper: box(paper),
      head: box(head),
      art: box(art),
      vw: window.innerWidth,
      vh: window.innerHeight,
      headClipped: head.scrollWidth > head.clientWidth + 1,
      covered,
      bigOverPaper,
      bigOpacity,
      text: (head.textContent ?? "").trim(),
    };
  });
  const within = (a: { l: number; t: number; r: number; b: number }, o: typeof a, pad: number) =>
    a.l >= o.l - pad && a.t >= o.t - pad && a.r <= o.r + pad && a.b <= o.b + pad;
  const problems: string[] = [];
  if (!/^invoice/i.test(m.text)) problems.push(`the heading reads "${m.text}"`);
  if (!within(m.head, m.paper, 2)) problems.push("the heading leaves the invoice box");
  if (!within(m.paper, m.art, 10)) problems.push("the invoice box leaves its frame");
  if (!within(m.paper, { l: 0, t: 0, r: m.vw, b: m.vh }, 0))
    problems.push("the invoice box leaves the window");
  if (m.headClipped) problems.push("the heading is wider than its line");
  if (m.covered > 0) problems.push(`something else covers the heading at ${m.covered} of 3 points`);
  if (m.bigOverPaper && m.bigOpacity > 0.05)
    problems.push(`the big line paints over the invoice box (opacity ${m.bigOpacity})`);
  expect(problems).toEqual([]);
});

/**
 * What T47 measures at one beat: the big line against the two headings of the problem picture (the phone's sender line
 * and the invoice's "Invoice" heading), each heading against its own box. Returns one string per fault.
 */
async function problemFaults(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const q = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error("the problem picture is missing " + sel);
      return el;
    };
    const big = q(".pb-big");
    const bb = big.getBoundingClientRect();
    const bigOpacity = Number(getComputedStyle(big).opacity);
    // once the picture itself has faded (the timeline's last beat) the big line takes its place by design
    const artOpacity = Number(getComputedStyle(q(".pb-art")).opacity);
    const out: string[] = [];
    const pairs: Array<[string, string, string]> = [
      ["phone", ".pb-ph", ".pb-ph .pb-from"],
      ["invoice", ".pb-paper", ".pb-paper .pp-h"],
    ];
    for (const [name, boxSel, headSel] of pairs) {
      const box = q(boxSel).getBoundingClientRect();
      const headEl = q(headSel);
      const h = headEl.getBoundingClientRect();
      if (!(
        h.left >= box.left - 2 &&
        h.right <= box.right + 2 &&
        h.top >= box.top - 2 &&
        h.bottom <= box.bottom + 2
      ))
        out.push(name + " heading leaves its box");
      if (headEl.scrollWidth > headEl.clientWidth + 1) out.push(name + " heading is clipped");
      const hit = bb.left < h.right && bb.right > h.left && bb.top < h.bottom && bb.bottom > h.top;
      if (hit && bigOpacity > 0.05 && artOpacity > 0.5)
        out.push(
          name +
            " heading is under the big line (opacity " +
            bigOpacity +
            ", picture " +
            artOpacity +
            ")",
        );
    }
    return out;
  });
}

test("T47 before the page script starts, the big line paints over neither heading @1440x900", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // the head script has set js-motion, the motion script never runs: the state of a reload or a deep link before GSAP
  await page.route("**/home-up.js*", (route) => route.abort());
  await open(page, 1440, 900);
  expect(await page.evaluate(() => document.documentElement.classList.contains("js-motion"))).toBe(
    true,
  );
  await page.evaluate(() => {
    const s = document.querySelector("#problem") as HTMLElement | null;
    if (!s) throw new Error("no #problem section");
    window.scrollTo(0, s.getBoundingClientRect().top + window.scrollY);
  });
  expect(await problemFaults(page)).toEqual([]);
});

test("T47 from first paint to settle, at every beat of the pinned section @1440x900", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await open(page, 1440, 900);
  const top = await page.evaluate(() => {
    const s = document.querySelector("#problem") as HTMLElement | null;
    if (!s) throw new Error("no #problem section");
    return s.getBoundingClientRect().top + window.scrollY;
  });
  const beats: string[] = [];
  const faults: string[] = [];
  // the pin runs 170% of the window; sample before it, every tenth of it, and past its end
  const steps = [-0.5, ...Array.from({ length: 11 }, (_, i) => (i * 1.7) / 10), 1.7 + 0.3];
  for (const k of steps) {
    const y = Math.max(0, Math.round(top + k * 900));
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForFunction((yy) => Math.abs(window.scrollY - yy) <= 1, y);
    // two frames, so the scrub and the layout have taken the new position
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    beats.push(String(k.toFixed(2)));
    for (const f of await problemFaults(page)) faults.push("beat " + k.toFixed(2) + ": " + f);
  }
  expect(beats.length).toBeGreaterThanOrEqual(12);
  expect(faults).toEqual([]);
});
