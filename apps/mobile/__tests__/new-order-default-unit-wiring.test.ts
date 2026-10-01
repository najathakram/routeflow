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
    expect(state).toMatch(/startOnDefaultUnit\?: number/);
  });

  it("addOne flags ONLY a new line and only when asked; the row-tap action asks, the scan path does not", () => {
    expect(screen).toMatch(/dflt\?: boolean/);
    expect(screen).toMatch(/if \(isNew && dflt\) line\.startOnDefaultUnit = line\.qty;/);
    expect(screen).toMatch(/add: \(id: string\) => addOne\(id, undefined, "BOX", true\)/);
    // SA-626: a scan flags it ONLY for a shared code (isSharedScanCode, the same rule web uses), never for a
    // box-only / unit-only code: finishAccept forwards `opts?.startOnDefault`, which the ladder sets for shared codes.
    expect(screen).toMatch(/addOne\(product\.id, product, level, opts\?\.startOnDefault\)/);
    expect(screen).toMatch(/scanAcceptOpts\(code, match\)/); // the settled-search auto-add uses the ladder's helper
  });

  it("CartRow passes the line's flag to the picker, which applies defaultStartOption once", () => {
    expect(cartRow).toMatch(/startOnDefaultUnit=\{/); // gated on the pristine-line guard below
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

  it("Opus #2865 B2/r2: CartRow hands the flag on only while the price is the operator's own AND untouched; it never guards on qty (a boxed qty is total pieces)", () => {
    expect(cartRow).toMatch(
      /startOnDefaultUnit=\{[\s\S]{0,260}line\.startOnDefaultUnit[\s\S]{0,260}\}/,
    );
    expect(cartRow).toMatch(/priceSource !== "operator"/);
    expect(cartRow).toMatch(/line\.unitPrice == null/);
    expect(cartRow).not.toMatch(/line\.qty \?\? 0\) <= 1/);
  });

  it("Opus #2865 r2: the flag is the line's creation qty, and CartRow applies the default only while qty still equals it (no handler edits, no qty<=1 guard)", () => {
    expect(state).toMatch(/startOnDefaultUnit\?: number/);
    expect(screen).toMatch(/line\.startOnDefaultUnit = line\.qty/);
    expect(cartRow).toMatch(/line\.startOnDefaultUnit === line\.qty/);
  });
});
