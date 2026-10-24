/**
 * SA-580b (mobile): the units_v1 "Add 1 <label>?" confirm belongs to today's piece case only - a
 * UNIT scan on a BOXED product. A shared code that now resolves to the default UNIT on an
 * upb<=1 product is today's plain +1 line and must NOT prompt.
 */
import { resolveScanSellLevel } from "@routeflow/scanning";
import { needsUnitLabelConfirm } from "../lib/scan-unit-confirm";

describe("needsUnitLabelConfirm", () => {
  it("prompts for a UNIT hit on a boxed product with a unit label (today's piece case)", () => {
    expect(needsUnitLabelConfirm("UNIT", { unitsPerBox: 6 }, "Piece")).toBe(true);
  });

  it("does NOT prompt for a shared code on an upb<=1 product (default UNIT, today's plain line)", () => {
    for (const upb of [1, 0, null, undefined]) {
      const level = resolveScanSellLevel({ unitsPerBox: upb }, ["BOX", "UNIT"]);
      expect(level).toBe("UNIT");
      expect(needsUnitLabelConfirm(level, { unitsPerBox: upb }, "Piece")).toBe(false);
    }
  });

  it("does NOT prompt for a shared code on upb 6 (resolves to BOX), a BOX hit, or a line with no label", () => {
    expect(
      needsUnitLabelConfirm(
        resolveScanSellLevel({ unitsPerBox: 6 }, ["BOX", "UNIT"]),
        { unitsPerBox: 6 },
        "Piece",
      ),
    ).toBe(false);
    expect(needsUnitLabelConfirm("BOX", { unitsPerBox: 6 }, "Piece")).toBe(false);
    expect(needsUnitLabelConfirm("UNIT", { unitsPerBox: 6 }, undefined)).toBe(false);
  });
});
