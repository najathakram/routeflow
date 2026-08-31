/**
 * roundUnitCost (web + mobile only — the api mirror has no 4dp cost rounder):
 * the same EPSILON-no-op defect class as REG-B122's roundMoney, at the 4th
 * decimal. EPSILON is <= half a ULP for any scaled value above ~2e-4, so the
 * old nudge never did anything and FP-victim inputs (x*10000 landing at
 * .4999…) rounded DOWN against the documented half-away-from-zero intent.
 * Victims verified numerically: 0.00145*10000 = 14.499999999999998, etc.
 * Untokened deliberately: B122's register proof is roundMoney's pins; these
 * are the close-out hardening for the sibling copy, kept in parity across the
 * two files that carry it.
 */
import { roundUnitCost as mobileRound } from "../lib/pricing";
import { roundUnitCost as webRound } from "../../web/lib/pricing";

const VICTIMS: Array<[number, number]> = [
  // [input, expected] — scaled value lands at .4999…, old body rounded down.
  [0.00145, 0.0015],
  [0.00465, 0.0047],
  [0.00565, 0.0057],
];

describe.each([
  ["mobile", mobileRound],
  ["web", webRound],
])("roundUnitCost (%s mirror)", (_name, fn) => {
  it.each(VICTIMS)("rounds the FP-victim %f half-up to %f", (input, expected) => {
    expect(fn(input)).toBe(expected);
  });

  it("keeps ordinary values exact", () => {
    expect(fn(0.4167)).toBe(0.4167);
    expect(fn(10 / 24)).toBe(0.4167); // $10 case / 24 pieces
    expect(fn(-0.00145)).toBe(-0.0015); // sign preserved, away from zero
    expect(fn(NaN)).toBe(0);
  });
});
