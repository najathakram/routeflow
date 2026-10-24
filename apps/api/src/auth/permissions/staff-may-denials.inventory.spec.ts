import * as fs from "fs";
import * as path from "path";

/**
 * W-870 (L-305 inventory): every `staffMay(...)` call in the API passes the caller's denied permission groups as its
 * third argument. With two arguments `deniedGroups` defaults to `[]`, so an OPERATOR whose admin switched a group off is
 * judged on the role alone and gets through. A request-path caller reads them with `operatorDeniedGroups` (till
 * guard); a caller with no principal passes `[]` explicitly, so the choice is visible. A new two-argument call fails here.
 */
const SRC = path.resolve(__dirname, "../..");

/** Source with comments blanked out (strings and template literals kept), so a doc comment naming the call is ignored. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The top-level argument count of each `staffMay(` call (the declaration excluded). */
export function staffMayArgCounts(src: string): number[] {
  const code = stripComments(src);
  const counts: number[] = [];
  const re = /(?<![\w.])staffMay\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (/function\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
    let depth = 0;
    let args = 1;
    let empty = true;
    for (let i = m.index + m[0].length; i < code.length; i++) {
      const c = code[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) args++;
      if (!/\s/.test(c)) empty = false;
    }
    counts.push(empty ? 0 : args);
  }
  return counts;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.ts$/.test(e.name) && !/\.spec\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("staffMay call inventory: every call passes deniedGroups (W-870)", () => {
  it("the pin bites: a two-argument call counts 2, a three-argument call 3, comments are ignored", () => {
    expect(staffMayArgCounts(`if (!staffMay(user.role, "VOID_SALE")) throw x;`)).toEqual([2]);
    expect(
      staffMayArgCounts(
        `staffMay(user.role, "VOID_SALE", await operatorDeniedGroups(p, { a, b }))`,
      ),
    ).toEqual([3]);
    expect(staffMayArgCounts(`// staffMay(role, "X")\n/** staffMay(role, "Y") */`)).toEqual([]);
    expect(staffMayArgCounts(`export function staffMay(role, action, denied = []) {}`)).toEqual([]);
  });

  it("no call in apps/api/src passes only two arguments", () => {
    const offenders = walk(SRC).flatMap((file) =>
      staffMayArgCounts(fs.readFileSync(file, "utf8"))
        .filter((n) => n < 3)
        .map((n) => `${path.relative(SRC, file).split(path.sep).join("/")} (${n} args)`),
    );
    expect(offenders).toEqual([]);
  });
});
