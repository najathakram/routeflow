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
  "CounterNewItem.tsx": {
    count: 1,
    why: "SA-1066 F10: the regulated-item question box takes focus (preventScroll) when it opens, so the keyboard lands on the question box, not on Cancel or any answer button, and the page does not jump; it is a dialog's own box, never the scan field",
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
  "useNewCustomerDoor.tsx": {
    count: 1,
    why: "F21: focus returns to the opener, or the find box when the opener is gone, after the add window is dismissed",
  },
};

/** Files whose AUTOFOCUS is allowed: the scan field on mount and the line note's own field. */
const AUTOFOCUS_ALLOWED: Record<string, number> = {
  "CounterSaleScreen.tsx": 1,
  "CounterLineRow.tsx": 1,
  "CounterDayClose.tsx": 1, // R7b 2.3: the Keep button of the "Keep your count for later?" confirm is the default
};

/** The counter's files, plus the one shared hook that moves focus for the counter (named, never a wider pattern). */
const counterFiles = () =>
  fs
    .readdirSync(DIR)
    .filter(
      (f) =>
        /^(Counter|useCounter|counter-).*\.(ts|tsx)$/.test(f) || f === "useNewCustomerDoor.tsx",
    )
    .filter((f) => !/\.test\.tsx?$/.test(f));

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("counter scan focus has one owner (SA-762r)", () => {
  it("the counter files are found", () => {
    expect(counterFiles()).toEqual(
      expect.arrayContaining([
        "CounterSaleScreen.tsx",
        "CounterLineRow.tsx",
        "useNewCustomerDoor.tsx",
      ]),
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
    for (const m of src.matchAll(/focusPaymentControl\(([\s\S]*?)\);/g)) {
      expect(m[1]).not.toMatch(/scanRef/);
    }
  });
});

/** Every non-test source under apps/web/{app,components,lib} (the doors are only ever called from screens and modals). */
const webSources = (): string[] => {
  const root = path.resolve(DIR, "../../../..");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  for (const d of ["app", "components", "lib"]) {
    if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
  }
  return out;
};

/** The top-level arguments of each `useNewCustomerDoor(...)` / `useNewCustomerDoor<T>(...)` call in a source. */
const doorCalls = (src: string): string[][] => {
  const calls: string[][] = [];
  for (const m of src.matchAll(/\buseNewCustomerDoor\s*(<[^(]*>)?\s*\(/g)) {
    let depth = 1;
    let cur = "";
    const args: string[] = [];
    for (let i = m.index! + m[0].length; i < src.length && depth > 0; i++) {
      const c = src[i];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      if (depth === 0) break;
      if (c === "," && depth === 1) {
        args.push(cur.trim());
        cur = "";
      } else cur += c;
    }
    if (cur.trim()) args.push(cur.trim());
    calls.push(args);
  }
  return calls;
};

describe("the new-customer door's focus return is the counter's alone (SA-1066 F21)", () => {
  const callers = () =>
    webSources()
      .filter((f) => path.basename(f) !== "useNewCustomerDoor.tsx")
      .map((f) => ({
        file: path.basename(f),
        calls: doorCalls(stripComments(fs.readFileSync(f, "utf8"))),
      }))
      .filter((c) => c.calls.length > 0);

  it("the counter and the order builder are both found", () => {
    expect(callers().map((c) => c.file)).toEqual(
      expect.arrayContaining(["CounterSaleScreen.tsx", "CreateOrderModal.tsx"]),
    );
  });

  it("the counter passes the Find a customer box as the third argument", () => {
    const counter = callers().find((c) => c.file === "CounterSaleScreen.tsx")!;
    expect(counter.calls).toHaveLength(1);
    expect(counter.calls[0]).toHaveLength(3);
    expect(counter.calls[0][2].replace(/\s+/g, "")).toBe("()=>customerFindRef.current");
  });

  it("every other caller (the order builder included) passes none, so its focus is left to its own dialog", () => {
    const others = callers().filter((c) => c.file !== "CounterSaleScreen.tsx");
    expect(others.length).toBeGreaterThan(0);
    for (const o of others) for (const args of o.calls) expect(args.length).toBeLessThan(3);
  });
});
