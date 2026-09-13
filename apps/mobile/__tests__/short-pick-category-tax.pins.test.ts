/**
 * REG-B305 round 4 — SOURCE PIN. `deliveredCategoryTax` is still exported
 * from `lib/run-money.ts` (other tests exercise it directly) and the
 * `run-money.test.ts` unit tests never import the screen, so nothing there
 * would fail if `payment.tsx` regressed back to calling
 * `deliveredCategoryTax(o.lineItems ?? [], deliveredQtyById)` — the exact
 * raw-lines composition that leaked a cancelled/already-delivered regulated
 * line's full category tax into the door quote (the bug `df635fdb` fixed).
 * The correct composition lives only in this screen, which the unit tests
 * cannot import (React Native / expo-router deps), so it is pinned here as
 * source text instead.
 */
import { readFileSync } from "fs";
import { join } from "path";

describe("pin (REG-B305 round 4): payment.tsx's door quote feeds shortPickLines into the category-tax call", () => {
  const screenSrc = readFileSync(
    join(__dirname, "..", "app", "(driver)", "route", "stop", "[stopId]", "payment.tsx"),
    "utf8",
  );

  it("calls shortPickCategoryTax( — not the raw-lines deliveredCategoryTax( call the seam bug used", () => {
    expect(screenSrc).toMatch(/shortPickCategoryTax\(/);
    // A call, not just the (unrelated) object-key form `deliveredCategoryTax:` —
    // that colon form is what forwards a value TO shortPickCategoryTax and is
    // fine; an open paren is the raw function call this pin forbids.
    expect(screenSrc).not.toMatch(/deliveredCategoryTax\(/);
  });

  it("passes shortPickLines (not the raw o.lineItems) as the delivered-line-set argument", () => {
    // Mirrors the actual call site (payment.tsx ~155-159):
    //   shortPickCategoryTax(
    //     o.lineItems ?? [],
    //     shortPickLines,
    //     deliveredQtyById,
    //   )
    // Bound the gap so this can't accidentally match some unrelated, distant
    // `shortPickLines` reference elsewhere in the file.
    expect(screenSrc).toMatch(/shortPickCategoryTax\([\s\S]{0,160}?shortPickLines/);
  });
});
