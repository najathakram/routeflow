import * as fs from "fs";
import * as path from "path";

/**
 * The register constants have ONE home, packages/pricing/src/counter-register.ts (the API value-imports @routeflow/pricing, never
 * @routeflow/types: L-261). A second declaration anywhere would let two features disagree on what a register key is.
 */
const ROOT = path.resolve(__dirname, "../../../..");
const SCAN = ["apps/api/src", "apps/web", "apps/mobile", "packages"];
const SKIP = new Set(["node_modules", ".next", "dist", ".expo", "coverage"]);
const HOME = path.join("packages", "pricing", "src", "counter-register.ts");

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.[cm]?[tj]sx?$/.test(e.name)) out.push(p);
  }
}

describe("register constants are declared once", () => {
  it("REGISTER_KEY_PATTERN and COUNTER_DEFAULT_REGISTER are declared only in @routeflow/pricing", () => {
    const files: string[] = [];
    for (const r of SCAN) walk(path.join(ROOT, r), files);
    const decl = /\b(?:const|let|var)\s+(REGISTER_KEY_PATTERN|COUNTER_DEFAULT_REGISTER)\b/;
    const hits = files
      .filter((f) => !f.endsWith(".spec.ts") && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
      .filter((f) => decl.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f));
    expect(hits).toEqual([HOME]);
  });
});
