import * as fs from "fs";
import * as path from "path";

/**
 * T3: the tenant's invoice display switches are named in ONE file (invoice-layout.ts). Any other non-spec source that
 * spells a key (plain, quoted any way, or in a template literal) fails here, so a new renderer must use the helper.
 */
const SRC_ROOT = path.resolve(__dirname, "..");
const ALLOWED = path.join("invoices", "invoice-layout.ts");

// strip block and line comments, keep strings; then look for the key family in any quote style
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}
export const HIT = /["'`]invoice\.(hide|show)[A-Z]\w*["'`]/;

export function countHits(src: string): number {
  return stripComments(src)
    .split("\n")
    .filter((l) => HIT.test(l)).length;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__mocks__" || e.name === "node_modules") continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.spec\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("invoice layout key sites (T3)", () => {
  it("walker sees .tsx files and template-literal keys; comments are ignored", () => {
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "inv-layout-"));
    try {
      fs.writeFileSync(path.join(dir, "a.tsx"), "export const k = `invoice.hideBarcodes`;\n");
      fs.writeFileSync(
        path.join(dir, "b.ts"),
        '// "invoice.hidePerPiece"\n/* "invoice.hideBarcodes" */\n',
      );
      fs.writeFileSync(path.join(dir, "c.spec.ts"), 'const k = "invoice.hideBarcodes";\n');
      const files = walk(dir).map((f) => path.basename(f));
      expect(files.sort()).toEqual(["a.tsx", "b.ts"]);
      expect(countHits(fs.readFileSync(path.join(dir, "a.tsx"), "utf8"))).toBe(1);
      expect(countHits(fs.readFileSync(path.join(dir, "b.ts"), "utf8"))).toBe(0);
      expect(countHits("x(\"invoice.showFoo\"); y('invoice.hideX')")).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("only invoices/invoice-layout.ts names an invoice.hide*/show* key", () => {
    const offenders: string[] = [];
    let total = 0;
    for (const f of walk(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, f);
      if (rel === ALLOWED) continue;
      const n = countHits(fs.readFileSync(f, "utf8"));
      if (n > 0) {
        offenders.push(`${rel}: ${n}`);
        total += n;
      }
    }
    // eslint-disable-next-line no-console
    if (total > 0) console.log(`invoice-layout sites: ${total} hit lines\n${offenders.join("\n")}`);
    expect(offenders).toEqual([]);
  });
});
