import {
  AMBIGUOUS_LINE_REASONS,
  AmbiguousLineError,
  buildLine,
  computeLineSubtotalStrict,
  lineAmbiguity,
} from "./index";

/**
 * SA-982 PR-2: `AmbiguousLineError` carries a `reason` code, set at each throw in build-line.ts and in
 * computeLineSubtotalStrict, so the warn phase's census counts exactly what the later flip will refuse. Additive: the
 * message and `code` are unchanged.
 */
const pack = (axis: Record<string, unknown>) =>
  buildLine({ axis: { kind: "pack", unitsPerBox: 12, ...axis } as never, unitPrice: 24 });
const reasonOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AmbiguousLineError);
    expect((e as AmbiguousLineError).code).toBe("AMBIGUOUS_LINE");
    return (e as AmbiguousLineError).reason;
  }
  throw new Error("expected an AmbiguousLineError");
};

describe("AMBIGUOUS_LINE_REASONS", () => {
  it("is exactly the six codes SA-982 names", () => {
    expect([...AMBIGUOUS_LINE_REASONS]).toEqual([
      "BOXED_NO_SPLIT",
      "NON_INTEGER",
      "QTY_DISAGREES",
      "ZERO",
      "SPLIT_NO_PACK",
      "BAD_QTY",
    ]);
  });
});

describe("buildLine sets a reason at every throw", () => {
  it("BOXED_NO_SPLIT: a boxed product with qty only (the B644 shape)", () => {
    expect(reasonOf(() => pack({ qty: 6 }))).toBe("BOXED_NO_SPLIT");
  });
  it("NON_INTEGER: a fractional box or piece count", () => {
    expect(reasonOf(() => pack({ boxes: 1.5, pieces: 0 }))).toBe("NON_INTEGER");
    expect(reasonOf(() => pack({ boxes: 1, pieces: 2.5 }))).toBe("NON_INTEGER");
  });
  it("QTY_DISAGREES: a qty that contradicts its split", () => {
    expect(reasonOf(() => pack({ boxes: 1, pieces: 0, qty: 5 }))).toBe("QTY_DISAGREES");
  });
  it("ZERO: a zero split", () => {
    expect(reasonOf(() => pack({ boxes: 0, pieces: 0 }))).toBe("ZERO");
  });
  it("SPLIT_NO_PACK: a split on a product with no pack", () => {
    expect(reasonOf(() => pack({ unitsPerBox: 1, boxes: 2, pieces: 0 }))).toBe("SPLIT_NO_PACK");
  });
  it("BAD_QTY: a non-boxed line whose qty is not positive and finite", () => {
    expect(reasonOf(() => pack({ unitsPerBox: 1, qty: 0 }))).toBe("BAD_QTY");
    expect(reasonOf(() => pack({ unitsPerBox: 1, qty: Number.NaN }))).toBe("BAD_QTY");
  });
  it("the unit axis maps into the same six: blank label / bad factor = BAD_QTY, fractional count = NON_INTEGER, count 0 = ZERO", () => {
    const unit = (a: Record<string, unknown>) =>
      buildLine({
        axis: { kind: "unit", label: "Case", count: 2, factorToBase: 12, ...a } as never,
        unitPrice: 24,
      });
    expect(reasonOf(() => unit({ label: " " }))).toBe("BAD_QTY");
    expect(reasonOf(() => unit({ factorToBase: 0 }))).toBe("BAD_QTY");
    expect(reasonOf(() => unit({ count: 1.5 }))).toBe("NON_INTEGER");
    expect(reasonOf(() => unit({ count: 0 }))).toBe("ZERO");
  });
  it("a valid line does not throw, and an unrolled split rolls over instead of refusing", () => {
    expect(() => pack({ boxes: 2, pieces: 3 })).not.toThrow();
    expect(() => pack({ boxes: 1, pieces: 14 })).not.toThrow();
  });
});

describe("computeLineSubtotalStrict (a direct caller) sets a reason too", () => {
  const strict = (i: Record<string, unknown>) =>
    computeLineSubtotalStrict({ unitPrice: 24, qty: 6, unitsPerBox: 12, ...i } as never);
  it("maps each lineAmbiguity message to a code, and the message is unchanged", () => {
    expect(reasonOf(() => strict({}))).toBe("BOXED_NO_SPLIT");
    expect(reasonOf(() => strict({ boxes: 1.5, pieces: 0, qty: 18 }))).toBe("NON_INTEGER");
    expect(reasonOf(() => strict({ boxes: 1, pieces: 0, qty: 5 }))).toBe("QTY_DISAGREES");
    expect(reasonOf(() => strict({ boxes: 0, pieces: 0, qty: 0 }))).toBe("ZERO");
    expect(reasonOf(() => strict({ unitsPerBox: 1, boxes: 2, pieces: 0, qty: 2 }))).toBe(
      "SPLIT_NO_PACK",
    );
    expect(() => strict({})).toThrow(/^computeLineSubtotalStrict: unitsPerBox > 1 with neither/);
    expect(lineAmbiguity({ qty: 6, unitsPerBox: 12 })).toMatch(/^unitsPerBox > 1 with neither/);
  });
});
