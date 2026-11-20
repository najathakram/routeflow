/**
 * SA-1196 A4-1: one reading of the phone header's trial pill and of the in-page trial buttons, used by T48a and T48e.
 * Both are judged against the live `.site-header .nav` rect, so no header height is typed anywhere.
 *  - pill shown: display not none, visibility not hidden, effective opacity above 0, a real box, and the whole box
 *    inside the nav box (r.top >= nav.top and r.bottom <= nav.bottom). The pill lives inside the header, so it is
 *    never judged by "below the header".
 *  - in-page button in view: a real box that is shown, below the nav (r.bottom > nav.bottom) and above the fold
 *    (r.top < innerHeight).
 * A button with visibility:hidden is dropped here although chrome.js's IntersectionObserver still counts it: the test
 * keeps the rule a visitor can see.
 */
import type { Page } from "@playwright/test";

export const HEADER_PILL = '.site-header .nav a[href^="/signup"].btn';

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
  return page.evaluate((pillSelector) => {
    const nav = document.querySelector(".site-header .nav");
    if (!nav) throw new Error("no .site-header .nav");
    const n = nav.getBoundingClientRect();
    const shown = (el: Element) => {
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
    const inView = (el: Element) => {
      const r = el.getBoundingClientRect();
      return shown(el) && r.bottom > n.bottom && r.top < innerHeight;
    };
    const wheelLive = !!document.querySelector(".rfw.rfw-go-on.rfw-go-in");
    const others = Array.from(document.querySelectorAll('a.btn[href^="/signup"]')).filter(
      (b) =>
        !b.closest(".site-header, #mobile-menu") && (wheelLive || !b.closest(".rfw")) && inView(b),
    );
    const pill = document.querySelector(pillSelector);
    const p = pill ? pill.getBoundingClientRect() : null;
    return {
      others: others.length,
      pillShown: !!pill && !!p && shown(pill) && p.top >= n.top && p.bottom <= n.bottom,
      pillBox: p ? { top: p.top, bottom: p.bottom } : null,
      navBox: { top: n.top, bottom: n.bottom },
    };
  }, HEADER_PILL);
}
