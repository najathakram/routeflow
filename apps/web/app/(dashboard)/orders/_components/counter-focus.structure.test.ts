import * as fs from "fs";
import * as path from "path";

/**
 * SA-762r (Web-1 #8): the counter has ONE scan-focus owner, lib/refocus-scanner.ts, reached through useCounterScanFocus.
 * A bare `.focus()` anywhere else in a counter file is how a half-typed note got swallowed by the scan lookup and how
 * Clear note dropped focus to <body>. Every direct `.focus()` the counter still has is listed here with the reason; a new
 * one fails this test until it goes through the helper or is argued onto the list. Mount autofocus (the scan field's
 * `autoFocus`) and the note's own `autoFocus` are JSX attributes, not `.focus()` calls, and are the only autofocus allowed.
 */
const DIR = __dirname;

/** file -> the number of direct `.focus()` calls it may have, and why. */
const ALLOWED: Record<string, { count: number; why: string }> = {
  "CounterSaleScreen.tsx": {
    count: 3,
    why: "the receipt heading takes focus when the receipt appears (POS-1); the digit redirect (row 237) focuses the scan box SYNCHRONOUSLY so the very keystroke lands in it (a scheduled refocus would lose it); and focusPaymentControl, the one place the payment area takes focus (Enter in an empty scan box, the tender radiogroup arrows; R7b 1.2)",
  },
  "CounterReturnAction.tsx": {
    count: 1,
    why: "returns focus to its own opener button when its dialog closes",
  },
  "CounterTodaysSales.tsx": {
    count: 2,
    why: "dialog focus: back to the Reprint button and to the Today's sales opener",
  },
  "CounterLinePriceEdit.tsx": { count: 2, why: "the price dialog focuses its own value field" },
};

/** Files whose AUTOFOCUS is allowed: the scan field on mount and the line note's own field. */
const AUTOFOCUS_ALLOWED: Record<string, number> = {
  "CounterSaleScreen.tsx": 1,
  "CounterLineRow.tsx": 1,
};

const counterFiles = () =>
  fs
    .readdirSync(DIR)
    .filter((f) => /^(Counter|useCounter|counter-).*\.(ts|tsx)$/.test(f))
    .filter((f) => !/\.test\.tsx?$/.test(f));

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("counter scan focus has one owner (SA-762r)", () => {
  it("the counter files are found", () => {
    expect(counterFiles()).toEqual(
      expect.arrayContaining(["CounterSaleScreen.tsx", "CounterLineRow.tsx"]),
    );
  });

  it.each(counterFiles())("%s calls .focus() only where listed", (file) => {
    const src = stripComments(fs.readFileSync(path.join(DIR, file), "utf8"));
    const calls = (src.match(/\.focus\(/g) ?? []).length;
    expect(calls).toBe(ALLOWED[file]?.count ?? 0);
  });

  it.each(counterFiles())("%s uses autoFocus only where listed", (file) => {
    const src = stripComments(fs.readFileSync(path.join(DIR, file), "utf8"));
    const uses = (src.match(/\bautoFocus\b/g) ?? []).length;
    expect(uses).toBe(AUTOFOCUS_ALLOWED[file] ?? 0);
  });

  it("the screen re-arms through useCounterScanFocus, not a timer of its own", () => {
    const src = fs.readFileSync(path.join(DIR, "CounterSaleScreen.tsx"), "utf8");
    expect(src).toMatch(/useCounterScanFocus\(/);
    expect(src).not.toMatch(/setTimeout\([^)]*focus/);
    const hook = fs.readFileSync(path.join(DIR, "useCounterScanFocus.ts"), "utf8");
    expect(hook).toMatch(/scheduleScannerRefocus/);
  });

  it("focusPaymentControl is the payment area's helper and is never handed the scan box", () => {
    const src = stripComments(fs.readFileSync(path.join(DIR, "CounterSaleScreen.tsx"), "utf8"));
    expect(src).toMatch(/const focusPaymentControl = /);
    expect(src).not.toMatch(/focusNode\b/);
    for (const m of src.matchAll(/focusPaymentControl\(([^;]*?)\);/gs)) {
      expect(m[1]).not.toMatch(/scanRef/);
    }
  });
});
