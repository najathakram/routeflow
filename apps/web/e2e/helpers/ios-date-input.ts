import type { Page } from "@playwright/test";

/**
 * #2080: a Chromium model of iOS Safari's date/time-input sizing quirk, for specs that must
 * go red on the bug without an iPhone.
 *
 * The real quirk is NOT a UA-stylesheet rule. It is WebKit's RenderThemeIOS.mm
 * `adjustInputElementButtonStyle`, called from `adjustMenuListButtonStyle` (so only while
 * the input's appearance is not `none`). It runs AFTER the cascade and overrides author CSS,
 * Tailwind's preflight `box-sizing: border-box` and `px-*` included:
 *   - "Always Enforce padding: 0 0.5em";
 *   - then, unless the width is a fixed positive length, it sets min-width to the estimated
 *     widest date text and `box-sizing: content-box`.
 * So a `w-full` date input renders 100% of its CONTENT box plus padding and border. A CSS
 * rule injected at UA strength (zero specificity, first in the document) cannot model it:
 * preflight and `px-3` beat such a rule on master too, so master would never go red.
 *
 * This adjuster reproduces the post-cascade step with inline styles (which, like the real
 * adjustment, beat every non-`!important` author rule). It visits EVERY date/time input and
 * applies WebKit's own conditions per input; it never checks for the #2080 fix itself. The
 * only input-level skip is the one WebKit makes: computed `appearance` or
 * `-webkit-appearance` is `none`. Callers assert on `visited` (the adjuster ran over the
 * inputs), never on `adjusted` (that count is what the fix changes).
 */
export interface IosDateInputAdjustment {
  visited: number;
  adjusted: number;
}

export const DATE_TIME_INPUT_SELECTOR = [
  'input[type="date"]',
  'input[type="time"]',
  'input[type="datetime-local"]',
  'input[type="month"]',
  'input[type="week"]',
].join(",");

export async function applyIosDateInputAdjustment(page: Page): Promise<IosDateInputAdjustment> {
  return page.evaluate((selector) => {
    // The widest text iOS shows per type, for WebKit's `estimatedMaximumWidthForDateType`.
    const SAMPLE_TEXT: Record<string, string> = {
      date: "Sep 28, 2026",
      time: "12:59 PM",
      "datetime-local": "Sep 28, 2026 at 12:59 PM",
      month: "September 2026",
    };
    // Fixed widths WebKit leaves alone: an inline px/rem width, or an unprefixed Tailwind
    // fixed-width utility (`w-32`, `w-px`, `w-[120px]`). `w-full`, `w-1/2`, `w-auto` are
    // not fixed, so WebKit adjusts them. Responsive `sm:`/`md:` widths do not apply at the
    // phone widths these specs run.
    const FIXED_WIDTH_CLASS = /^w-(\d+(\.\d+)?|px|\[\d+(\.\d+)?(px|rem|em)\])$/;
    const ctx = document.createElement("canvas").getContext("2d");
    let visited = 0;
    let adjusted = 0;
    document.querySelectorAll<HTMLInputElement>(selector).forEach((input) => {
      visited++;
      const cs = getComputedStyle(input);
      const webkitAppearance = cs.getPropertyValue("-webkit-appearance");
      if (cs.appearance === "none" || webkitAppearance === "none") return;
      adjusted++;
      // "Always Enforce padding: 0 0.5em" (before WebKit's fixed-width early return).
      input.style.setProperty("padding-left", "0.5em");
      input.style.setProperty("padding-right", "0.5em");
      const inlineFixed = /(px|rem|em)$/.test(input.style.width);
      const classFixed = Array.from(input.classList).some((c) => FIXED_WIDTH_CLASS.test(c));
      if (inlineFixed || classFixed) return;
      const sample = SAMPLE_TEXT[input.type];
      if (!sample) return; // WebKit returns early for week (no picker on iOS).
      let textWidth = 0;
      if (ctx) {
        ctx.font = cs.font;
        textWidth = Math.ceil(ctx.measureText(sample).width);
      }
      if (textWidth > 0) {
        input.style.setProperty("min-width", `${textWidth}px`);
        input.style.setProperty("box-sizing", "content-box");
      }
    });
    return { visited, adjusted };
  }, DATE_TIME_INPUT_SELECTOR);
}
