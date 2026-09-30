import { readFileSync } from "fs";
import { join } from "path";

/**
 * #2784 PR-2 (mobile picker tap). Jest here is pure-logic only, so the wiring is source-pinned: a NEW line added by the
 * picker tap is flagged `startOnDefaultUnit`; CartRow hands the flag to UnitPickerRow, which applies the flagged default
 * level ONCE through `defaultStartOption`. A scan (code decides the level) and a +1 on an existing line never set it.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");
const screen = read("components", "NewOrderScreen.tsx");
const cartRow = read("components", "CartRow.tsx");
const row = read("components", "UnitPickerRow.tsx");
const state = read("lib", "cart-line-state.ts");

describe("mobile default selling unit wiring (#2784)", () => {
  it("the line state carries the UI-only flag", () => {
    expect(state).toMatch(/startOnDefaultUnit\?: boolean/);
  });

  it("addOne flags ONLY a new line and only when asked; the row-tap action asks, the scan path does not", () => {
    expect(screen).toMatch(/startOnDefault\?: boolean/);
    expect(screen).toMatch(/if \(isNew && startOnDefault\) line\.startOnDefaultUnit = true;/);
    expect(screen).toMatch(/add: \(id: string\) => addOne\(id, undefined, "BOX", true\)/);
    expect(screen).not.toMatch(/finishAccept[\s\S]{0,120}startOnDefault/);
  });

  it("CartRow passes the line's flag to the picker, which applies defaultStartOption once", () => {
    expect(cartRow).toMatch(/startOnDefaultUnit=\{line\.startOnDefaultUnit\}/);
    expect(row).toMatch(/startOnDefaultUnit\?: boolean/);
    expect(row).toMatch(/defaultStartOption\(/);
    expect(row).toMatch(/startedRef/);
  });

  it("Opus #2865 B2: setUnitLabel CONSUMES the flag (any unit choice, incl. the pack), so a cart re-open never re-applies it", () => {
    const fn = screen.slice(
      screen.indexOf("const setUnitLabel"),
      screen.indexOf("const setUnitLabel") + 900,
    );
    expect(fn).toMatch(/startOnDefaultUnit: undefined/);
  });

  it("Opus #2865 B2: CartRow only hands the flag on while the line is pristine (qty 1, no typed/operator price)", () => {
    expect(cartRow).toMatch(
      /startOnDefaultUnit=\{[\s\S]{0,260}line\.startOnDefaultUnit[\s\S]{0,260}\}/,
    );
    expect(cartRow).toMatch(/priceSource !== "operator"/);
    expect(cartRow).toMatch(/\(line\.qty \?\? 0\) <= 1/);
    expect(cartRow).toMatch(/line\.unitPrice == null/);
  });
});
