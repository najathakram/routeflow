/**
 * SA-1199 P1-P3: one reading of the phone header's trial pill and of the in-page trial buttons, used by T48a and T48e.
 * Nothing about the header is typed: both are judged against the live `.site-header .nav` rect.
 *  - in-page button in view (ONE geometry rule, the same one chrome.js's IntersectionObserver ships): a real box
 *    (width and height above 0), its own computed display not "none" and no display:none ancestor, below the nav
 *    (r.bottom > nav.bottom) and above the fold (r.top < innerHeight). Opacity and visibility are NOT part of it: a
 *    fade-in is a transition, not a state, and the observer is geometry only. Counting opacity made the test and the
 *    code disagree during motion (the hero button fades in from opacity 0). A button stuck at opacity 0 for good is a
 *    reveal defect that the motion suites own.
 *  - pill shown (A4-1's own predicate): display not none, visibility not hidden, effective opacity above 0, a real
 *    box, and the whole box inside the nav box (r.top >= nav.top and r.bottom <= nav.bottom). The pill lives inside
 *    the header, so it is never judged by "below the header".
 * The reading is only trusted after motion settles (settleMotion), then polled until the observer's async callback
 * agrees (readPillSettled).
 */
import { expect, type Page } from "@playwright/test";

export const HEADER_PILL = '.site-header .nav a[href^="/signup"].btn';
const WATCHED = 'a.btn[href^="/signup"]';
/** Hard cap on the settle wait; on timeout it throws, never passes silently. */
export const SETTLE_CAP_MS = 5000;
/**
 * Floor before the first look at the page, above the home hero's gsap.delayedCall(0.06) plus a frame: a tween that has
 * not been created yet is invisible to the busy test (SA-1200 A1 M2).
 */
export const SETTLE_FLOOR_MS = 150;
/** Consecutive animation frames with nothing animating before the page counts as settled (SA-1200 A1 M2). */
export const SETTLE_QUIET_FRAMES = 10;
/** How long the pill state may take to agree with the in-view count after settle. */
export const AGREE_POLL_MS = 2000;

export interface PillReading {
  /** In-page trial buttons in view (the wheel's own counts once the wheel is clickable and on screen). */
  others: number;
  /** The pill is shown inside the header box. */
  pillShown: boolean;
  /** The boxes read, for the failure message. */
  pillBox: { top: number; bottom: number } | null;
  navBox: { top: number; bottom: number };
}

export async function readPill(page: Page): Promise<PillReading> {
  return page.evaluate(
    ([pillSelector, watchedSelector]) => {
      const nav = document.querySelector(".site-header .nav");
      if (!nav) throw new Error("no .site-header .nav");
      const n = nav.getBoundingClientRect();
      const pillShownBox = (el: Element) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        let opacity = 1;
        for (let e: Element | null = el; e; e = e.parentElement) {
          const s = getComputedStyle(e);
          if (s.display === "none" || s.visibility === "hidden") return false;
          opacity *= Number(s.opacity);
        }
        return opacity > 0;
      };
      // Geometry only (SA-1199 P1/P2): no opacity, no visibility.
      const inView = (el: Element) => {
        const r = el.getBoundingClientRect();
        if (!(r.bottom > n.bottom && r.top < innerHeight && r.width > 0 && r.height > 0)) {
          return false;
        }
        for (let e: Element | null = el; e; e = e.parentElement) {
          if (getComputedStyle(e).display === "none") return false;
        }
        return true;
      };
      const wheelLive = !!document.querySelector(".rfw.rfw-go-on.rfw-go-in");
      const others = Array.from(document.querySelectorAll(watchedSelector as string)).filter(
        (b) =>
          !b.closest(".site-header, #mobile-menu") &&
          (wheelLive || !b.closest(".rfw")) &&
          inView(b),
      );
      const pill = document.querySelector(pillSelector as string);
      const p = pill ? pill.getBoundingClientRect() : null;
      return {
        others: others.length,
        pillShown: !!pill && !!p && pillShownBox(pill) && p.top >= n.top && p.bottom <= n.bottom,
        pillBox: p ? { top: p.top, bottom: p.bottom } : null,
        navBox: { top: n.top, bottom: n.bottom },
      };
    },
    [HEADER_PILL, WATCHED],
  );
}

/**
 * SA-1199 P3: wait until the watched buttons and the pill (and their ancestors up to body) run no animation: every
 * `getAnimations()` is empty or finished, and gsap has no active tween on them (the hero tween targets the `.hx-cta`
 * wrapper, so ancestors count). First a floor of SETTLE_FLOOR_MS (a tween created by a delayed call is not there yet),
 * then SETTLE_QUIET_FRAMES consecutive animation frames with nothing animating; any animation seen resets the count.
 * Hard cap SETTLE_CAP_MS, counted from the start: on timeout it throws and names the element still animating.
 * The two selectors default to the pill and the watched buttons; a fixture page may pass its own.
 */
export async function settleMotion(
  page: Page,
  selectors: { pill?: string; watched?: string } = {},
): Promise<void> {
  const stuck = await page.evaluate(
    ([pillSelector, watchedSelector, cap, floor, quiet]) => {
      const describe = (el: Element) =>
        el.tagName.toLowerCase() +
        (el.id ? "#" + el.id : "") +
        (typeof el.className === "string" && el.className
          ? "." + el.className.trim().split(/\s+/).join(".")
          : "") +
        ' "' +
        (el.textContent || "").trim().slice(0, 40) +
        '"';
      const targets = (): Element[] => {
        const roots = Array.from(
          document.querySelectorAll(`${watchedSelector as string}, ${pillSelector as string}`),
        );
        const all = new Set<Element>();
        for (const r of roots) {
          for (
            let e: Element | null = r;
            e && e !== document.documentElement;
            e = e.parentElement
          ) {
            all.add(e);
          }
        }
        return [...all];
      };
      const busy = (): { el: Element; why: string } | null => {
        const g = (window as unknown as { gsap?: { getTweensOf: (t: Element) => any[] } }).gsap;
        for (const el of targets()) {
          const running = el.getAnimations().filter((a) => a.playState !== "finished");
          if (running.length) return { el, why: "css animation " + running[0]!.playState };
          if (g && g.getTweensOf(el).some((t) => t.isActive())) return { el, why: "gsap tween" };
        }
        return null;
      };
      const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
      return (async () => {
        const t0 = performance.now();
        await new Promise<void>((r) => setTimeout(r, floor as number));
        let calm = 0;
        let b: { el: Element; why: string } | null = null;
        while (calm < (quiet as number)) {
          await frame();
          b = busy();
          if (b) calm = 0;
          else calm += 1;
          if (performance.now() - t0 >= (cap as number)) break;
        }
        if (calm < (quiet as number)) {
          return b ? describe(b.el) + " (" + b.why + ")" : "no calm run of frames before the cap";
        }
        return null;
      })();
    },
    [
      selectors.pill ?? HEADER_PILL,
      selectors.watched ?? WATCHED,
      SETTLE_CAP_MS,
      SETTLE_FLOOR_MS,
      SETTLE_QUIET_FRAMES,
    ] as const,
  );
  if (stuck) throw new Error(`motion did not settle within ${SETTLE_CAP_MS}ms: ${stuck}`);
}

/**
 * Settle, then read, polling about AGREE_POLL_MS for the pill to agree with the in-view count (the observer callback is
 * async). Returns the last reading; a disagreement that outlives the poll is returned for the caller to report.
 */
export async function readPillSettled(page: Page): Promise<PillReading> {
  await settleMotion(page);
  let last = await readPill(page);
  try {
    await expect
      .poll(
        async () => {
          last = await readPill(page);
          return last.pillShown === (last.others === 0);
        },
        { timeout: AGREE_POLL_MS },
      )
      .toBe(true);
  } catch {
    // Still disagreeing after the poll: hand the last reading back so the row reports it.
  }
  return last;
}
