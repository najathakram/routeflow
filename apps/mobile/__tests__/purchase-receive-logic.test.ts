import { nextUnitCost } from "../lib/purchase-receive-logic";

describe("nextUnitCost (F4, independent review — PR-3)", () => {
  it("REG-F4: scan A then scan B WITHOUT clearing the cost field — B's prefill replaces A's, never bills B at A's cost", () => {
    // The exact sequence the bug needs: product A picked (empty field ->
    // prefills to A's cost), then product B picked before the operator
    // touches the field. TODAY (pre-fix): the field is non-empty (holds
    // A's cost), so the "only prefill when empty" rule keeps it — B's
    // receipt would record at A's cost.
    const afterA = nextUnitCost("", /* isNewProduct */ true, 4.5);
    expect(afterA).toBe("4.5");

    const afterB = nextUnitCost(afterA, /* isNewProduct */ true, 9.25);
    expect(afterB).toBe("9.25");
    expect(afterB).not.toBe(afterA);
  });

  it("REG-F4: re-picking the SAME product does not clobber a cost the operator already typed", () => {
    // The operator corrected the prefilled cost by hand, then re-scanned
    // the SAME product (e.g. a second unit of the same barcode) — their
    // typed value must survive.
    const typed = nextUnitCost("4.5", /* isNewProduct */ false, 9.99);
    expect(typed).toBe("4.5");
  });

  it("REG-F4: a new product still prefills into an empty field (unchanged baseline)", () => {
    expect(nextUnitCost("", true, 4.5)).toBe("4.5");
  });

  it("REG-F4: no prefill value (non-finite) leaves the field untouched either way", () => {
    expect(nextUnitCost("4.5", true, NaN)).toBe("4.5");
    expect(nextUnitCost("", true, NaN)).toBe("");
  });

  it("REG-F4: a box-scaled prefill still overwrites on a product change", () => {
    // standardCost * unitsPerBox, already computed by the caller — this
    // function only decides WHETHER to write it, not the value's shape.
    expect(nextUnitCost("2.1", true, 25.2)).toBe("25.2");
  });
});
