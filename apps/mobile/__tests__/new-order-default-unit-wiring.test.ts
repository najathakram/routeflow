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
const defaultUnitLine = read("lib", "default-unit-line.ts");
const adapter = read("lib", "pending-unit-adapter.ts"); // #2865: the add decision + Confirm gate live here, the screen holds call sites
const state = read("lib", "cart-line-state.ts");

describe("mobile default selling unit wiring (#2784)", () => {
  it("the line state carries the UI-only flag", () => {
    expect(state).toMatch(/startOnDefaultUnit\?: number/);
  });

  it("addOne flags ONLY a new line and only when asked; the row-tap action asks, the scan path does not", () => {
    expect(screen).toMatch(/dflt\?: boolean/);
    expect(adapter).toMatch(
      /if \(keepsDefaultStart\(cur, a\.dflt, a\.role\)\) \{\s*line\.startOnDefaultUnit = line\.qty;/,
    );
    expect(adapter).toMatch(/line\.pendingTaps = 1;/); // #2865 case c
    expect(screen).toMatch(/add: \(id: string\) => addOne\(id, undefined, "BOX", true, true\)/);
    // SA-626: a scan flags it ONLY for a shared code (isSharedScanCode, the same rule web uses), never for a
    // box-only / unit-only code: finishAccept forwards `opts?.startOnDefault`, which the ladder sets for shared codes.
    expect(screen).toMatch(
      /addOne\(product\.id, product, level, opts\?\.startOnDefault, false, opts\?\.code\)/,
    );
    expect(screen).toMatch(/scanAcceptOpts\(code, match\)/); // the settled-search auto-add uses the ladder's helper
  });

  it("CartRow passes the line's flag to the picker, which applies defaultStartOption once", () => {
    expect(cartRow).toMatch(/startOnDefaultUnit=\{/); // gated on the pristine-line guard below
    expect(row).toMatch(/startOnDefaultUnit\?: boolean/);
    expect(row).toMatch(/defaultStartOption\(/);
    expect(row).toMatch(/startedRef/);
  });

  it("Opus #2865 B2: setUnitLabel CONSUMES the flag (any unit choice, incl. the pack), so a cart re-open never re-applies it", () => {
    const fn = defaultUnitLine.slice(
      defaultUnitLine.indexOf("export function applyUnitOption"),
      defaultUnitLine.indexOf("export function isPendingDefaultUnit"),
    );
    expect(fn).toMatch(/startOnDefaultUnit: undefined/);
    expect(screen).toMatch(/applyUnitOption\(m\[id\], option, upbOf\(id\)\)/); // setUnitLabel is that one writer
  });

  it("Opus #2865 B2/r2: CartRow hands the flag on only while the price is the operator's own AND untouched; it never guards on qty (a boxed qty is total pieces)", () => {
    expect(cartRow).toMatch(/startOnDefaultUnit=\{isPendingDefaultUnit\(line\)\}/);
    // #2865 case c: the one shared predicate decides (operator price shapes the line; a history pre-fill does not)
    expect(defaultUnitLine).toMatch(/isUnitPending\(/);
    expect(defaultUnitLine).toMatch(/line\.priceSource !== "history"/);
    expect(defaultUnitLine).not.toMatch(/line\.qty \?\? 0\) <= 1/);
  });

  it("Opus #2865 r2: the flag is the line's creation qty, and CartRow applies the default only while qty still equals it (no handler edits, no qty<=1 guard)", () => {
    expect(state).toMatch(/startOnDefaultUnit\?: number/);
    expect(adapter).toMatch(/line\.startOnDefaultUnit = line\.qty/);
    expect(defaultUnitLine).toMatch(
      /startOnDefaultUnit: line\.startOnDefaultUnit,\s*qty: line\.qty/,
    );
  });
});

describe("SA-626c: the default unit is resolved on the LINE, before Confirm (not only when a sheet mounts)", () => {
  const submit = screen.slice(
    screen.indexOf("const submitOrder"),
    screen.indexOf("createOrder.mutate("),
  );

  it("submitOrder resolves every pending line first, blocks when the ladder is unavailable, and prices from the resolved lines", () => {
    expect(submit).toMatch(/await settleBeforeConfirm\(items, resolveDefaultUnits\)/);
    expect(submit).toMatch(/settled\.kind === "blocked"/);
    expect(submit).toMatch(/Object\.entries\(lines\)/);
    expect(submit).toMatch(/mergeResolvedDefaults\(cur, items, lines\)/); // later tray edits are kept
    expect(submit).not.toMatch(/Object\.entries\(items\)/);
    expect(submit.indexOf('settled.kind === "blocked"')).toBeLessThan(
      submit.indexOf("Object.entries(lines)"),
    );
  });

  it("the screen and the cart row share ONE writer and ONE pending rule (no second copy)", () => {
    expect(screen).toMatch(/applyUnitOption\(m\[id\], option, upbOf\(id\)\)/);
    // SA-626f: the role gate: a DRIVER makes no subscription read and never starts on a default unit
    expect(screen).toMatch(/useDefaultUnitResolver\(\s*items,\s*setItems,\s*isStaff,/);
    expect(cartRow).toMatch(/startOnDefaultUnit=\{isPendingDefaultUnit\(line\)\}/);
    expect(defaultUnitLine).toMatch(/export function applyUnitOption/);
  });
});
