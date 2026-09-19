import { ConflictException } from "@nestjs/common";
import {
  ORDER_HAS_NO_UNIT_AWARE_LINE,
  UNIT_AWARE_LINE,
  assertNoUnitAwareLines,
  isUnitAwareLine,
} from "./unit-aware-guard";

describe("isUnitAwareLine", () => {
  it.each([
    [{ unitLabel: "Case" }, true],
    [{ unitLabel: "Piece", status: "PENDING" }, true],
    [{ unitLabel: null }, false],
    [{ unitLabel: "" }, false],
    [{}, false],
    [{ unitLabel: "Case", status: "CANCELLED" }, false],
    [null, false],
    [undefined, false],
  ])("%j -> %s", (li, want) => {
    expect(isUnitAwareLine(li as never)).toBe(want);
  });
});

describe("assertNoUnitAwareLines", () => {
  it("passes for pack lines, empty and missing input", () => {
    expect(() => assertNoUnitAwareLines([{ unitLabel: null }, {}])).not.toThrow();
    expect(() => assertNoUnitAwareLines([])).not.toThrow();
    expect(() => assertNoUnitAwareLines(undefined)).not.toThrow();
  });

  it("throws 409 UNIT_AWARE_LINE naming the unit and the action", () => {
    let err: ConflictException | undefined;
    try {
      assertNoUnitAwareLines([{ unitLabel: null }, { unitLabel: "Pallet" }], "duplicated");
    } catch (e) {
      err = e as ConflictException;
    }
    expect(err).toBeInstanceOf(ConflictException);
    const body = err!.getResponse() as { code: string; message: string };
    expect(body.code).toBe(UNIT_AWARE_LINE);
    expect(body.message).toContain("Pallet");
    expect(body.message).toContain("duplicated");
  });
});

describe("ORDER_HAS_NO_UNIT_AWARE_LINE", () => {
  it("is the Prisma filter: no live line with a unitLabel", () => {
    expect(ORDER_HAS_NO_UNIT_AWARE_LINE).toEqual({
      lineItems: { none: { unitLabel: { not: null }, status: { not: "CANCELLED" } } },
    });
  });
});
