/**
 * Static-scan helpers for the structural pins (`*.pin.spec.ts`): walk `apps/api/src`, blank the comments (a comment
 * may mention a forbidden call; code may not), find a call by regex, read its balanced argument text and name the
 * function that encloses it. Shaped like `addon-lockheld-single-caller.sa769.spec.ts`: every pin that uses this
 * ships a detector self-test and fails on an empty scan, so a broken regex can never report green.
 *
 * Pure `fs` + string work: no jest globals, nothing here runs in production.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const API_SRC_ROOT = path.resolve(__dirname, "..");

const SOURCE_EXT = /\.ts$/;
const SPEC_OR_TEST = /\.(spec|test)\.ts$/;

/** Code with line and block comments blanked out (newlines kept so line numbers stay true). */
export function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every non-spec `.ts` file under `root` (default: the API `src`), absolute paths. */
export function collectSourceFiles(root: string = API_SRC_ROOT, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      collectSourceFiles(full, out);
    } else if (SOURCE_EXT.test(entry.name) && !SPEC_OR_TEST.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** The text between the `(` at `openIdx` and its matching `)` (strings and template literals are skipped). */
export function balancedArgs(code: string, openIdx: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return code.slice(openIdx + 1, i);
    }
  }
  return code.slice(openIdx + 1);
}

/** The text between the `{` at `openIdx` and its matching `}`. */
export function balancedBraces(code: string, openIdx: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return code.slice(openIdx + 1, i);
    }
  }
  return code.slice(openIdx + 1);
}

const METHOD =
  /^ {2}(?:(?:public|private|protected|static|readonly)\s+)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^(\n]*>)?\(/;
const TOP_FN = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const TOP_ARROW = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/;
const NOT_A_FUNCTION = new Set(["if", "for", "while", "switch", "catch", "return", "constructor"]);

/** The index just before the line that declares the function enclosing `idx` (0 when none is found). */
export function enclosingFunctionStart(code: string, idx: number): { name: string; start: number } {
  const before = code.slice(0, idx);
  const lines = before.split("\n");
  let offset = before.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    offset -= line.length + 1;
    const m = METHOD.exec(line) ?? TOP_FN.exec(line) ?? TOP_ARROW.exec(line);
    if (m && !NOT_A_FUNCTION.has(m[1])) return { name: m[1], start: Math.max(0, offset) };
  }
  return { name: "<module>", start: 0 };
}

export interface CallSite {
  /** Path relative to `src`, forward slashes. */
  file: string;
  /** The enclosing function or method name. */
  fn: string;
  /** The delegate method, e.g. `update`. */
  method: string;
  /** The balanced argument text of the call. */
  args: string;
  /** The text of the enclosing function from its declaration up to the call (to resolve a `const x = {...}`). */
  scope: string;
  line: number;
}

/**
 * Every call of `re` (its LAST capture group is the delegate method; the match must end at the opening
 * parenthesis) in `text`, comments ignored. `file` is the label recorded on each hit.
 */
export function findCalls(file: string, text: string, re: RegExp): CallSite[] {
  const code = codeOnly(text);
  const out: CallSite[] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(code))) {
    const open = m.index + m[0].length - 1;
    const { name, start } = enclosingFunctionStart(code, m.index);
    out.push({
      file,
      fn: name,
      method: m[m.length - 1],
      args: balancedArgs(code, open),
      scope: code.slice(start, m.index),
      line: code.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

/** Scan every source file under `src` for `re`. */
export function scanSource(re: RegExp, root: string = API_SRC_ROOT): CallSite[] {
  return collectSourceFiles(root).flatMap((f) =>
    findCalls(path.relative(root, f).replace(/\\/g, "/"), fs.readFileSync(f, "utf8"), re),
  );
}

/**
 * The literal an argument list stands for: the text itself, or - when it is a bare identifier - the
 * `const <id> = { ... }` it names in the enclosing function's scope.
 */
export function resolveLiteral(site: Pick<CallSite, "args" | "scope">): string {
  const bare = /^\s*([A-Za-z_$][\w$]*)\s*,?\s*$/.exec(site.args);
  if (!bare) return site.args;
  return constLiteral(site.scope, bare[1]) ?? site.args;
}

/** The `{ ... }` body of `const <id> = { ... }` in `scope`, or null. */
export function constLiteral(scope: string, id: string): string | null {
  const m = new RegExp(`\\bconst\\s+${id}\\s*(?::[^=]+)?=\\s*\\{`).exec(scope);
  if (!m) return null;
  return balancedBraces(scope, m.index + m[0].length - 1);
}
