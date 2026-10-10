/**
 * #2751 — REQUIRED-ACTIONS shape pin for NewOrderScreen. A merge once silently dropped a key
 * from the screen's actions object; nothing failed until runtime. Source-text spec: every
 * `actionsRef.current.X` / `a.X` (a = actionsRef.current) must be a key `rowActions` defines,
 * and every required Args property of useScanPriceEdit must be passed at its call.
 */
import { readFileSync } from "fs";
import { join } from "path";

export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The text between the braces of the object literal that opens at `src[open]` (a `{`). */
function braceBody(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return "";
}

/** Top-level keys of an object-literal body (shorthand, `k: v`, methods, spreads ignored). */
export function topLevelKeys(body: string): Set<string> {
  const keys = new Set<string>();
  let depth = 0;
  let seg = "";
  const flush = () => {
    const m = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:[:,(]|$)/.exec(seg);
    if (m) keys.add(m[1]);
    seg = "";
  };
  for (const c of body) {
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) flush();
    else seg += c;
  }
  flush();
  return keys;
}

/** Action names read off the actions ref, via `actionsRef.current.X` or a local alias `a.X`. */
export function usedActions(src: string): Set<string> {
  const used = new Set<string>();
  for (const m of src.matchAll(/actionsRef\.current\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
  if (/const a = actionsRef\.current;/.test(src)) {
    for (const m of src.matchAll(/\ba\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
  }
  return used;
}

export function definedActions(src: string): Set<string> {
  const at = src.indexOf("const rowActions = {");
  if (at < 0) return new Set();
  return topLevelKeys(braceBody(src, src.indexOf("{", at)));
}

export function missingActions(src: string): string[] {
  const defined = definedActions(src);
  return [...usedActions(src)].filter((n) => !defined.has(n)).sort();
}

export function requiredArgs(hookSrc: string): string[] {
  const m = /interface Args \{([\s\S]*?)\n\}/.exec(hookSrc);
  if (!m) return [];
  return [...m[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((x) => x[1]);
}

export function missingHookInputs(screenSrc: string, hookSrc: string): string[] {
  const at = screenSrc.indexOf("useScanPriceEdit({");
  if (at < 0) return ["<no useScanPriceEdit call>"];
  const passed = topLevelKeys(braceBody(screenSrc, screenSrc.indexOf("{", at)));
  return requiredArgs(hookSrc).filter((n) => !passed.has(n));
}

const SCREEN = stripComments(
  readFileSync(join(__dirname, "..", "components", "NewOrderScreen.tsx"), "utf8"),
);
const HOOK = stripComments(
  readFileSync(join(__dirname, "..", "lib", "use-scan-price-edit.ts"), "utf8"),
);

describe("#2751 extraction helpers are not vacuous (synthetic sources)", () => {
  const good = `
    const rowActions = {
      add: addOne,
      setQty,
      isUnlisted: (id: string) => list.some((u) => { return u.id === id; }),
    };
    const onA = useCallback((id) => actionsRef.current.add(id), []);
    const onB = useCallback((id) => { const a = actionsRef.current; a.setQty(id, 1); a.isUnlisted(id); }, []);
  `;
  it("finds used and defined names, and passes when used is a subset", () => {
    expect([...usedActions(good)].sort()).toEqual(["add", "isUnlisted", "setQty"]);
    expect([...definedActions(good)].sort()).toEqual(["add", "isUnlisted", "setQty"]);
    expect(missingActions(good)).toEqual([]);
  });
  it("FAILS (names the gap) when a used action is not defined", () => {
    const bad = good.replace("setQty,\n", "");
    expect(missingActions(bad)).toEqual(["setQty"]);
  });
  it("flags a required hook input that the call omits", () => {
    const hook = "interface Args {\n  scanOpen: boolean;\n  setScanOpen: (o: boolean) => void;\n}";
    expect(missingHookInputs("useScanPriceEdit({ scanOpen, setScanOpen })", hook)).toEqual([]);
    expect(missingHookInputs("useScanPriceEdit({ scanOpen })", hook)).toEqual(["setScanOpen"]);
  });
});

describe("#2751 NewOrderScreen actions shape", () => {
  it("parses a non-trivial actions object and a non-trivial used set", () => {
    expect(definedActions(SCREEN).size).toBeGreaterThanOrEqual(10);
    expect(usedActions(SCREEN).size).toBeGreaterThanOrEqual(10);
  });
  it("every actionsRef.current.<name> used is defined in rowActions", () => {
    const missing = missingActions(SCREEN);
    if (missing.length) {
      throw new Error(`rowActions is missing action(s) used by the screen: ${missing.join(", ")}`);
    }
  });
  it("useScanPriceEdit's call passes every property its Args requires", () => {
    expect(requiredArgs(HOOK)).toEqual(
      expect.arrayContaining(["scanOpen", "setScanOpen", "setPriceEditId"]),
    );
    const missing = missingHookInputs(SCREEN, HOOK);
    if (missing.length) {
      throw new Error(`useScanPriceEdit call is missing required input(s): ${missing.join(", ")}`);
    }
  });
});
