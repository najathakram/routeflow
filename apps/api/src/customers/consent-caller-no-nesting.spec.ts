import * as fs from "fs";
import * as path from "path";

// Source pin (lead ruling on SA-305): setCustomerConsent opens its own tenantTransaction, so a
// call from inside another open tenantTransaction callback would silently run on a second
// connection. Every production caller must sit outside any tenantTransaction callback.
const SRC = path.resolve(__dirname, "..");

function productionFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return productionFiles(full);
    return e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts") ? [full] : [];
  });
}

/** True when `index` sits inside the argument list of an unclosed `tenantTransaction(` call. */
function insideTenantTransaction(source: string, index: number): boolean {
  const opener = /tenantTransaction\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(source)) && m.index < index) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
    }
    if (i > index) return true;
  }
  return false;
}

describe("setCustomerConsent is never called inside another tenantTransaction", () => {
  const calls = productionFiles(SRC).flatMap((file) => {
    const source = fs.readFileSync(file, "utf8");
    const found: { file: string; index: number; nested: boolean }[] = [];
    const re = /\.setCustomerConsent\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      found.push({ file, index: m.index, nested: insideTenantTransaction(source, m.index) });
    }
    return found;
  });

  it("finds at least one caller (an empty scan is a broken pin, not a pass)", () => {
    expect(calls.length).toBeGreaterThan(0);
  });

  it("no caller sits inside a tenantTransaction callback", () => {
    expect(calls.filter((c) => c.nested).map((c) => path.relative(SRC, c.file))).toEqual([]);
  });

  it("the nesting detector itself flags a nested call", () => {
    const sample =
      "await this.prisma.tenantTransaction(async (tx) => { await s.setCustomerConsent(id); });";
    expect(insideTenantTransaction(sample, sample.indexOf(".setCustomerConsent"))).toBe(true);
    expect(insideTenantTransaction("await s.setCustomerConsent(id);", 7)).toBe(false);
  });
});
