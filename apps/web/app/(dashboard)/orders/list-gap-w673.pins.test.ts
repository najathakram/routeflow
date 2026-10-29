import { readFileSync } from "fs";
import { join } from "path";

/**
 * W-673 (order-flow recheck Q03): at phone width the gap under the search/Filters row was 0 px or ~160 px depending on state.
 *  - 0 px: the list wrapper was `display: contents`, so the page's `space-y-5` margin landed on a box-less element and the
 *    first card sat flush against the search row (every width).
 *  - 160 px: a B823 top spacer (`h-40`) rendered whenever a draft was parked. The DraftDock is pinned to the BOTTOM of the
 *    screen (`absolute bottom-24`) and collapses to a pill on narrow screens since B668, so the top spacer cleared nothing;
 *    the BOTTOM spacer (the last card clears the dock) stays.
 * Now: one fixed gap, the page's own `space-y-5` rhythm, whatever the draft state. The pixels are measured at 1440/768/390.
 */
const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("W-673: one fixed gap under the orders search/Filters row", () => {
  it("the list wrapper is a real box (not display: contents), so the page rhythm applies", () => {
    expect(src).toMatch(/<div id="orders-list"(?![^>]*className="contents")/);
    expect(src).not.toMatch(/id="orders-list" className="contents"/);
  });

  it("no top-of-list spacer for the draft dock; the bottom clearance stays (one)", () => {
    expect(
      src.match(/\{hasDrafts && <div className="h-40 md:hidden" aria-hidden \/>\}/g)?.length ?? 0,
    ).toBe(1);
    const listStart = src.indexOf('id="orders-list"');
    const ulStart = src.indexOf('<ul className="space-y-3 md:hidden">', listStart);
    expect(src.slice(listStart, ulStart)).not.toMatch(/h-40/);
  });
});
