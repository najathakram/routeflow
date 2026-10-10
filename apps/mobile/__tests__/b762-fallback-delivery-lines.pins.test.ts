/**
 * SA-115 (B762) — SOURCE PIN. `payment.tsx`'s `closeStop` decides, per
 * order, whether to send its RICH (fetched) short-pick lines or the
 * un-landed-fetch fallback (`fallbackShortPickLines`, lib/short-pick.ts).
 * The decision must be based on whether the order's fetch has LANDED
 * (`ordersById[o.id]` present), never on whether the rich lines came back
 * EMPTY — a landed order with nothing adjustable (all delivered on an
 * earlier visit, or all cancelled) must send its empty rich lines AS-IS
 * (zero entries for this close), not re-claim full delivery through the
 * fallback. Nothing in `lib/short-pick.test.ts` would catch a regression
 * back to the banned `rich.length > 0 ? rich : fallback` form — that
 * composition lives only in this screen, which the pure-logic unit tests
 * cannot import (React Native / expo-router deps) — so it is pinned here
 * as source text instead, in the style of `short-pick-category-tax.pins.test.ts`.
 */
import { readFileSync } from "fs";
import { join } from "path";

const screenSrc = readFileSync(
  join(__dirname, "..", "app", "(driver)", "route", "stop", "[stopId]", "payment.tsx"),
  "utf8",
);

describe("pin (SA-115): closeStop's fallback trigger is landed-ness, never rich.length", () => {
  it("the banned form never appears: rich.length (>|===) 0 deciding between rich lines and the fallback", () => {
    expect(screenSrc).not.toMatch(/rich\.length\s*>\s*0\s*\?\s*rich\s*:\s*fallbackShortPickLines/);
    expect(screenSrc).not.toMatch(
      /rich\.length\s*===\s*0\s*\?\s*fallbackShortPickLines\([\s\S]{0,20}?\)\s*:\s*rich/,
    );
  });

  it("the actual call site keys off ordersById[o.id] (landed-ness), falling back to fallbackShortPickLines(o) only when it's falsy", () => {
    expect(screenSrc).toMatch(
      /ordersById\[o\.id\]\s*\?\s*\(richShortPickLinesByOrder\[o\.id\]\s*\?\?\s*\[\]\)\s*:\s*fallbackShortPickLines\(o\)/,
    );
  });

  it("fallbackShortPickLines is imported from lib/short-pick (pure, unit-tested there), never redefined locally in the screen", () => {
    expect(screenSrc).toMatch(
      /import\s*\{[\s\S]{0,300}?fallbackShortPickLines[\s\S]{0,300}?\}\s*from\s*"[^"]*lib\/short-pick"/,
    );
    expect(screenSrc).not.toMatch(/function fallbackShortPickLines\(/);
  });
});
