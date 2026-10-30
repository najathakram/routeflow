import * as fs from "fs";
import * as path from "path";

/**
 * W-870 (L-305 inventory): every `staffMay(...)` call in the API passes the caller's denied permission groups as its
 * third argument. `deniedGroups` is a required parameter, so a two-argument call fails to compile; this pin also catches
 * one that slips through a cast, because an OPERATOR whose admin switched a group off would be judged on the role alone.
 * A request-path caller reads them with `operatorDeniedGroups` (till guard); a caller with no principal passes `[]`
 * explicitly, so the choice is visible.
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

/** The top-level arguments (trimmed source text) of each `name(` call, the declaration excluded. */
export function callArgs(src: string, name: string): string[][] {
  const code = stripComments(src);
  const calls: string[][] = [];
  const re = new RegExp(`(?<![\\w.])${name}\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (/function\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
    const args: string[] = [];
    let depth = 0;
    let start = m.index + m[0].length;
    for (let i = start; i < code.length; i++) {
      const c = code[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) {
          const last = code.slice(start, i).trim();
          if (last !== "") args.push(last);
          break;
        }
        depth--;
      } else if (c === "," && depth === 0) {
        args.push(code.slice(start, i).trim());
        start = i + 1;
      }
    }
    calls.push(args);
  }
  return calls;
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

  it("no staffMay call hands in an empty denials literal: a request path reads the caller's real groups", () => {
    const offenders = Object.entries(sources()).flatMap(([file, src]) =>
      callArgs(src, "staffMay")
        .filter((a) => /^(\[\s*\]|undefined|null)$/.test(a[2] ?? ""))
        .map(() => file),
    );
    expect(offenders).toEqual([]);
  });

  it("the pin bites: a planted empty-denials call has [] as its third argument", () => {
    const third = (src: string) => callArgs(src, "staffMay")[0][2];
    expect(third(`staffMay(role, "VOID_SALE", [])`)).toBe("[]");
    expect(third(`staffMay(role, "VOID_SALE", await operatorDeniedGroups(p, u))`)).toBe(
      "await operatorDeniedGroups(p, u)",
    );
  });

  it("the call-site inventory is exact PER CALL: a second call in a listed file is a reviewed change", () => {
    const files = sources();
    const callsOf = (name: string) =>
      Object.fromEntries(
        Object.keys(files)
          .map((f) => [f, callArgs(files[f], name).length] as const)
          .filter(([, n]) => n > 0)
          .sort(([x], [y]) => x.localeCompare(y)),
      );
    expect({
      staffMay: callsOf("staffMay"),
      mayUseTill: callsOf("mayUseTill"),
      assertStaffMay: callsOf("assertStaffMay"),
      decideStaffWrite: callsOf("decideStaffWrite"),
    }).toEqual({
      staffMay: {
        "invoices/invoice-line-override.ts": 1,
        "orders/counter-sale/counter-sale.service.ts": 1,
        "orders/counter-sale/till-permission.guard.ts": 2,
        "orders/fulfil-path-resolver.ts": 1,
        "orders/price-edit-allowed.ts": 1,
        "selling-restrictions/restriction-warning.ts": 1,
      },
      mayUseTill: {
        "orders/counter-sale/till-permission.guard.ts": 1,
        "orders/order-lifecycle.ts": 1,
      },
      assertStaffMay: {
        "invoices/counter-payment-guard.ts": 1,
        "orders/counter-sale/counter-sale-void.service.ts": 1,
      },
      decideStaffWrite: { "selling-restrictions/selling-restrictions.service.ts": 1 },
    });
  });
});

describe("InvoicesService.voidInvoice takes its principal as a required parameter (W-870)", () => {
  it("the declaration has no optional user: an omitted principal cannot skip the VOID_SALE door", () => {
    const src = fs.readFileSync(path.join(SRC, "invoices/invoices.service.ts"), "utf8");
    expect(src).toMatch(/async voidInvoice\(id: string, user: TillUser\)/);
    expect(src).not.toMatch(/async voidInvoice\([^)]*user\?/);
  });
});

function sources(): Record<string, string> {
  return Object.fromEntries(
    walk(SRC).map((f) => [
      path.relative(SRC, f).split(path.sep).join("/"),
      fs.readFileSync(f, "utf8"),
    ]),
  );
}
