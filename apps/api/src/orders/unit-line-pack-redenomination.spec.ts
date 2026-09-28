import { ConflictException } from "@nestjs/common";
import type { LadderUnit } from "@routeflow/pricing";
import { assertNoPackRedenomination } from "./unit-line-edit";
import { resolveLineUnits } from "../products/line-units";

/**
 * SA-474 (#2443): taking a held unit-aware line back to the PACK is refused (409 UNIT_AWARE_LINE).
 * Before, `unitLabel: null` (or the pack's own label) resolved to a label-less pack row and the
 * UPDATE took the pack branch: sized at the HELD Case factor, the Case price kept, the label never
 * cleared. The rows here come from the REAL resolver, so the pins follow its resolution rules.
 */
const product = { unit: "Box", unitsPerBox: 6 };
const units: LadderUnit[] = [
  {
    label: "Case",
    factorToBase: 12,
    price: "18.00",
    priceTier2: null,
    priceTier3: null,
    priceTier4: null,
    priceTier5: null,
  } as LadderUnit,
];
const caseLine = { id: "li-1", productId: "p1", unitLabel: "Case", unitsPerBox: 12 };
const packLine = { id: "li-2", productId: "p1", unitLabel: null, unitsPerBox: 6 };

const check = (li: any, item: any) =>
  assertNoPackRedenomination(li, item, resolveLineUnits(product, units, item, li));
const refusal = (li: any, item: any): any => {
  try {
    check(li, item);
  } catch (e) {
    return e;
  }
  return null;
};

describe("SA-474 (#2443) — a held unit-aware line is never re-denominated to the pack", () => {
  it("held Case + unitLabel null ⇒ 409 UNIT_AWARE_LINE, naming the held unit", () => {
    const e = refusal(caseLine, { id: "li-1", unitLabel: null, qty: 3 });
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({ code: "UNIT_AWARE_LINE" });
    expect(e.getResponse().message).toContain("sold by the Case");
  });

  it("held Case + the pack's own label (a named pack) ⇒ the same 409", () => {
    const e = refusal(caseLine, { id: "li-1", unitLabel: "Box", qty: 3 });
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({ code: "UNIT_AWARE_LINE" });
  });

  it("a label-less pack line + unitLabel null ⇒ unchanged (mobile's `unitLabel ?? null` echo)", () => {
    expect(() => check(packLine, { id: "li-2", unitLabel: null, qty: 3 })).not.toThrow();
  });

  it("held Case keeping its unit (omitted, or re-sent) or naming another ladder unit ⇒ allowed", () => {
    expect(() => check(caseLine, { id: "li-1", qty: 24 })).not.toThrow();
    expect(() => check(caseLine, { id: "li-1", unitLabel: "Case", qty: 24 })).not.toThrow();
    expect(() => check(caseLine, { id: "li-1", unitLabel: "Piece", qty: 5 })).not.toThrow();
  });

  it("a substitute (a new line) and CANCEL/DELETE (no money) are never refused here", () => {
    const row = resolveLineUnits(product, units, { unitLabel: null }, caseLine);
    for (const item of [
      { substituteProductId: "p2", unitLabel: null },
      { action: "CANCEL", unitLabel: null },
      { action: "DELETE", unitLabel: null },
    ]) {
      expect(() => assertNoPackRedenomination(caseLine, item, row)).not.toThrow();
    }
  });

  it("no existing line (an ADD) or no resolved row ⇒ nothing to guard", () => {
    const row = resolveLineUnits(product, units, { unitLabel: null }, null);
    expect(() =>
      assertNoPackRedenomination(undefined, { unitLabel: null } as any, row),
    ).not.toThrow();
    expect(() => assertNoPackRedenomination(caseLine, {}, undefined)).not.toThrow();
  });

  it("updateOrderItems runs the guard right after BOTH resolutions (pre-lock and under the lock)", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src: string = require("fs").readFileSync(require.resolve("./orders.service.ts"), "utf8");
    const calls = src.match(
      /resolveLineUnits\(product, unitCtx\.ladders\.get\(pid!\) \?\? \[\], item, li\),?\s*\)?;?\s*unitEdit\.assertNoPackRedenomination\(li, item, unitRows\.get\(item\)\)/g,
    );
    expect(calls).toHaveLength(2);
  });
});
