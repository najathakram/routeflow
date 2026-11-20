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
import {
  overlapFaults,
  overlapRatios,
  parseRgb,
  scrubOff,
  scrubSettled,
  type TriggerLike,
} from "./helpers/site-overlap";

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
 * What T47 measures at one beat: each problem-picture heading against its own box (the phone's sender line and the
 * invoice's "Invoice" heading), and the opacities and overlap of the big line against each heading, as data. The pass
 * or fail of the overlap is decided in node by overlapFaults (SA-1190 K1), not here.
 */
type BeatSample = { name: string; bigOpacity: number; artOpacity: number; overlap: boolean };

async function problemBeat(page: Page): Promise<{ faults: string[]; samples: BeatSample[] }> {
  return page.evaluate(() => {
    const q = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error("the problem picture is missing " + sel);
      return el;
    };
    const big = q(".pb-big");
    const bb = big.getBoundingClientRect();
    const bigOpacity = Number(getComputedStyle(big).opacity);
    const artOpacity = Number(getComputedStyle(q(".pb-art")).opacity);
    const out: string[] = [];
    const samples: Array<{
      name: string;
      bigOpacity: number;
      artOpacity: number;
      overlap: boolean;
    }> = [];
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
      samples.push({ name, bigOpacity, artOpacity, overlap: hit });
    }
    return { faults: out, samples };
  });
}

/** Every fault at one beat: the structural ones, and K1 for the invoice heading (3:1 at 1440, 4.5:1 at 393). */
async function beatFaults(page: Page, w: number, k: string, floor: number): Promise<string[]> {
  const colours = await roles(page);
  const ink = parseRgb(colours.ink);
  const white = parseRgb(colours.white);
  const beat = await problemBeat(page);
  const out = beat.faults.map((f) => `beat ${k}: ${f}`);
  for (const sm of beat.samples) {
    let note = "";
    if (sm.name === "invoice" && sm.overlap) {
      const r = overlapRatios(sm.artOpacity, sm.bigOpacity, ink, white);
      note = `, INVOICE ratio ${r.invoice.toFixed(2)}, line ratio ${r.line.toFixed(2)}`;
      for (const f of overlapFaults(sm.artOpacity, sm.bigOpacity, floor, ink, white))
        out.push(`beat ${k}: ${f}`);
    }
    console.log(
      `T47 beat ${w} ${k} ${sm.name}: big opacity ${sm.bigOpacity}, picture opacity ${sm.artOpacity}, overlap ${sm.overlap}${note}`,
    );
  }
  return out;
}

/** Wait until every scrubbed trigger has caught up; on timeout, say which ones are off. */
async function settle(page: Page, sectionSel: string): Promise<void> {
  const arg = { src: String(scrubOff), sel: sectionSel };
  try {
    await page.waitForFunction(
      (a) => {
        const st = (window as unknown as { ScrollTrigger?: { getAll(): unknown[] } }).ScrollTrigger;
        const scope = document.querySelector(a.sel);
        if (!st || !scope) return false;
        const fn = new Function("return " + a.src)() as (
          t: unknown[],
          tol: number,
          sc: Element,
        ) => unknown[];
        return fn(st.getAll(), 0.005, scope).length === 0;
      },
      arg,
      { timeout: 20_000 },
    );
  } catch (e) {
    const off = await page.evaluate((a) => {
      const st = (window as unknown as { ScrollTrigger?: { getAll(): unknown[] } }).ScrollTrigger;
      const scope = document.querySelector(a.sel);
      if (!st || !scope) return null;
      const fn = new Function("return " + a.src)() as (
        t: unknown[],
        tol: number,
        sc: Element,
      ) => unknown[];
      return fn(st.getAll(), 0.005, scope);
    }, arg);
    throw new Error(
      "the scrubbed triggers did not catch up in 20 s: " +
        (off ? JSON.stringify(off) : "window.ScrollTrigger is missing") +
        " (" +
        String(e) +
        ")",
    );
  }
}

test("T47 settle check: scrub-only, and it names the trigger that lags (no browser)", () => {
  const once = {
    vars: { scrub: undefined },
    progress: 0.3,
    animation: { progress: () => 1 },
    trigger: { id: "once" },
  };
  const caught = {
    vars: { scrub: 0.8 },
    progress: 0.5,
    animation: { progress: () => 0.5 },
    trigger: { className: "pb-pin" },
  };
  const lag = { ...caught, animation: { progress: () => 0.2 } };
  // the former check: every trigger. A play-once trigger never tracks the scroll, so it never succeeded.
  const former = (ts: TriggerLike[]) =>
    ts.every((t) => !t.animation || Math.abs(t.animation.progress() - t.progress) < 0.005);
  expect(former([once, caught])).toBe(false);
  expect(scrubSettled([once, caught])).toBe(true);
  expect(scrubSettled([once, lag])).toBe(false);
  expect(scrubOff([once, lag])).toEqual([{ trigger: ".pb-pin", progress: 0.5, animation: 0.2 }]);

  // the scope is the section under test: another section's scrubbed scene that lags is not this section's business
  const inside = { id: "in" };
  const outside = { id: "out" };
  const scope = { contains: (n: unknown) => n === inside };
  const pin = { ...caught, trigger: inside };
  const pinLag = { ...pin, animation: { progress: () => 0.2 } };
  const elsewhere = {
    vars: { scrub: 0.8 },
    progress: 0,
    animation: { progress: () => 0.5156 },
    trigger: outside,
  };
  // the unscoped scrub-only check waits forever on the lagging scene elsewhere (the timeout seen on the slot)
  expect(scrubSettled([pin, elsewhere])).toBe(false);
  expect(scrubSettled([pin, elsewhere], 0.005, scope)).toBe(true);
  expect(scrubSettled([pinLag, elsewhere], 0.005, scope)).toBe(false);
});

test("T47 overlap rule K1 over the composited opacities (no browser)", () => {
  const ink = parseRgb("#0E1726");
  const white = parseRgb("#FFFFFF");
  // the reviewer's window at a phone: 4.39 is under 4.5
  expect(overlapFaults(0.72, 0.3, 4.5, ink, white)).not.toEqual([]);
  expect(overlapFaults(0.72, 0.3, 3, ink, white)).toEqual([]);
  expect(overlapFaults(0.72, 0.15, 4.5, ink, white)).toEqual([]);
  // both layers shown at once
  expect(overlapFaults(0.5, 0.5, 3, ink, white)).not.toEqual([]);
  // the line has taken over; both below 0.5 is a transition beat
  expect(overlapFaults(0.3, 0.7, 4.5, ink, white)).toEqual([]);
  expect(overlapFaults(0.4, 0.4, 4.5, ink, white)).toEqual([]);
});

test("T47 when home-up.js fails to load, the big line paints over neither heading @1440x900", async ({
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
  expect(await beatFaults(page, 1440, "no-script", 3)).toEqual([]);
});

for (const { w, h, floor } of [
  { w: 1440, h: 900, floor: 3 },
  { w: 393, h: 844, floor: 4.5 },
]) {
  test(`T47 from first paint to settle, at every beat of the problem section @${w}x${h}`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await open(page, w, h);
    // the pin runs 170% of the window on a desktop; a phone has no pin, so the section's own height is the run
    const { top, run } = await page.evaluate(
      ([vh, desk]) => {
        const s = document.querySelector("#problem") as HTMLElement | null;
        if (!s) throw new Error("no #problem section");
        return {
          top: s.getBoundingClientRect().top + window.scrollY,
          run: desk ? 1.7 * vh : s.offsetHeight,
        };
      },
      [h, w >= 900] as [number, boolean],
    );
    const beats: string[] = [];
    const faults: string[] = [];
    // before the section, eleven even steps through it, and past its end
    const steps = [
      -0.5 * h,
      ...Array.from({ length: 11 }, (_, i) => (i * run) / 10),
      run + 0.3 * h,
    ];
    for (const dy of steps) {
      const y = Math.max(0, Math.round(top + dy));
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForFunction((yy) => Math.abs(window.scrollY - yy) <= 1, y);
      // the pin scrubs (0.8 s), so wait until every scrubbed trigger's animation has caught up with its scroll progress
      await settle(page, "#problem");
      // one frame, so the layout has taken the settled state
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      const k = (dy / h).toFixed(2);
      beats.push(k);
      faults.push(...(await beatFaults(page, w, k, floor)));
    }
    expect(beats.length).toBeGreaterThanOrEqual(12);
    expect(faults).toEqual([]);
  });
}
