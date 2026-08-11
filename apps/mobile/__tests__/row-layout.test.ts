/**
 * Guards the react-native-web row-collapse fix.
 *
 * The defect: an unbounded TextInput inside a `flexShrink: 0` stepper pill takes
 * the UA `size=20` intrinsic width (~177px) on web, starving the sibling name
 * column until <Text> renders one character per line. `minWidth` cannot fix it
 * — only a definite width can — so these assertions are written to fail if
 * anyone reverts a call site to a floor-only style: the widths would no longer
 * be registered in `row-layout.ts` and the arithmetic below would break.
 *
 * Mobile Jest is pure-logic (testEnvironment: node, no renderer), so this
 * asserts over the exported constants and geometry rather than rendering.
 */
import {
  BAND_EDIT_CHIP_WIDTH,
  BAND_GAP,
  bandInnerWidth,
  COMMON_VIEWPORT,
  MAX_ROW_CONTROL_WIDTH,
  MIN_SUPPORTED_VIEWPORT,
  MIN_TEXT_COLUMN,
  MIN_TEXT_COLUMN_NARROW,
  MONEY_INPUT_MAX_WIDTH,
  QTY_INPUT_WIDTH,
  stepperPillWidth,
  textColumnWidth,
} from "../lib/row-layout";

describe("qty input widths", () => {
  it("registers a definite, bounded width for every stepper variant", () => {
    const entries = Object.entries(QTY_INPUT_WIDTH);
    expect(entries.length).toBeGreaterThanOrEqual(4);
    for (const [name, width] of entries) {
      expect(`${name}:${Number.isFinite(width)}`).toBe(`${name}:true`);
      // Wide enough for 5 digits (maxLength) + padding, narrow enough that the
      // pill can't eat the row. A revert to the UA intrinsic ~177px fails here.
      expect(width).toBeGreaterThanOrEqual(40);
      expect(width).toBeLessThanOrEqual(64);
    }
  });

  it("caps the money input without capping realistic native content", () => {
    // "99999.99" at 15px semibold + 8px padding each side is ~84px.
    expect(MONEY_INPUT_MAX_WIDTH).toBeGreaterThanOrEqual(84);
    expect(MONEY_INPUT_MAX_WIDTH).toBeLessThan(120);
  });
});

describe("stepperPillWidth", () => {
  it("keeps every pill under the row-control budget", () => {
    const pills = {
      md: stepperPillWidth({ btn: 30, inputWidth: QTY_INPUT_WIDTH.md, padding: 3 }),
      mini: stepperPillWidth({ btn: 26, inputWidth: QTY_INPUT_WIDTH.mini, padding: 2 }),
      cart: stepperPillWidth({ btn: 30, inputWidth: QTY_INPUT_WIDTH.cart, padding: 3 }),
      edit: stepperPillWidth({ btn: 30, inputWidth: QTY_INPUT_WIDTH.edit, padding: 3 }),
    };
    for (const [name, width] of Object.entries(pills)) {
      expect(`${name}:${width <= MAX_ROW_CONTROL_WIDTH}`).toBe(`${name}:true`);
    }
  });

  it("computes the pre-fix pill width that caused the defect", () => {
    // The UA intrinsic width the input carried before it was bounded.
    const broken = stepperPillWidth({ btn: 30, inputWidth: 177, padding: 3 });
    expect(broken).toBeGreaterThan(MAX_ROW_CONTROL_WIDTH);
  });
});

describe("textColumnWidth", () => {
  // ProductRow: 16px list padding, 10px row padding, 48px thumb, two 12px gaps.
  const productRow = (viewport: number, controlWidth: number) =>
    textColumnWidth({
      viewport,
      listPadding: 16,
      rowPadding: 10,
      leading: 48,
      gaps: 24,
      controlWidth,
    });

  const mdPill = stepperPillWidth({ btn: 30, inputWidth: QTY_INPUT_WIDTH.md, padding: 3 });
  // What the input measured before it was bounded: the UA `size=20` intrinsic.
  const brokenPill = stepperPillWidth({ btn: 30, inputWidth: 177, padding: 3 });

  it("leaves a readable name column on a common phone", () => {
    expect(productRow(COMMON_VIEWPORT, mdPill)).toBeGreaterThanOrEqual(MIN_TEXT_COLUMN);
  });

  it("still leaves a legible name column on the narrowest phone", () => {
    expect(productRow(MIN_SUPPORTED_VIEWPORT, mdPill)).toBeGreaterThanOrEqual(
      MIN_TEXT_COLUMN_NARROW,
    );
  });

  it("collapses the name column when the input is unbounded (the reported bug)", () => {
    // ~21px on a 390px phone and negative at 320px — a couple of characters
    // wide at most. That is the regime where RNW's `word-wrap: break-word`
    // renders the SKU one character per line, which is what was reported.
    const COLLAPSED = 40;
    expect(productRow(COMMON_VIEWPORT, brokenPill)).toBeLessThan(COLLAPSED);
    expect(productRow(MIN_SUPPORTED_VIEWPORT, brokenPill)).toBeLessThan(COLLAPSED);
  });

  it("leaves a readable label column in the cart stepper row", () => {
    // CartStepperRow: 16px sheet padding, 14px row padding, no leading, one 12px gap.
    const pill = stepperPillWidth({ btn: 30, inputWidth: QTY_INPUT_WIDTH.cart, padding: 3 });
    const column = textColumnWidth({
      viewport: MIN_SUPPORTED_VIEWPORT,
      listPadding: 16,
      rowPadding: 14,
      leading: 0,
      gaps: 12,
      controlWidth: pill,
    });
    expect(column).toBeGreaterThanOrEqual(MIN_TEXT_COLUMN);
  });

  describe("boxed qty band — two mini steppers + wrapped summary line", () => {
    const miniPill = stepperPillWidth({ btn: 26, inputWidth: QTY_INPUT_WIDTH.mini, padding: 2 });

    it("mini pill is exactly the documented 104px", () => {
      expect(miniPill).toBe(104);
    });

    it("Cases + Loose steppers fit band line 1 at every supported viewport", () => {
      for (const viewport of [320, 375, 390]) {
        const line1 = miniPill * 2 + BAND_GAP;
        expect(`${viewport}:${line1 <= bandInnerWidth(viewport)}`).toBe(`${viewport}:true`);
      }
    });

    it("the summary CANNOT share line 1 — it would starve below the readable floor", () => {
      // This is why BoxedQtyBand's summaryRow carries flexBasis "100%": with
      // two pills, three gaps and the Edit chip on one line, ~32px remain at
      // 375 — under even the narrow-viewport floor.
      const leftover = bandInnerWidth(375) - (miniPill * 2 + BAND_GAP * 3 + BAND_EDIT_CHIP_WIDTH);
      expect(leftover).toBeLessThan(MIN_TEXT_COLUMN_NARROW);
    });

    it("line 2 leaves a readable summary column beside the Edit chip", () => {
      for (const viewport of [320, 375, 390]) {
        const column = bandInnerWidth(viewport) - BAND_GAP - BAND_EDIT_CHIP_WIDTH;
        expect(`${viewport}:${column >= MIN_TEXT_COLUMN}`).toBe(`${viewport}:true`);
      }
    });
  });

  it("leaves a readable summary column in a scan-tray row", () => {
    // ScanTray rowBottom: 16px padding, 12px row padding, two 12px gaps, 32px remove button.
    const pill = stepperPillWidth({ btn: 26, inputWidth: QTY_INPUT_WIDTH.mini, padding: 2 });
    const column = textColumnWidth({
      viewport: MIN_SUPPORTED_VIEWPORT,
      listPadding: 16,
      rowPadding: 12,
      leading: 0,
      gaps: 24,
      controlWidth: pill + 32,
    });
    expect(column).toBeGreaterThanOrEqual(MIN_TEXT_COLUMN);
  });
});
