/**
 * SA-1105 K-0 (Q1): `TenantContextService.isSuperAdmin()` changed meaning (`getOrNull() === null` became
 * `kind() === "SUPER_ADMIN"`, so an anonymous or context-less caller is no longer a super admin). It has NO non-spec
 * caller today, so nothing moved. This pins that census: a new caller must be read against the new meaning, and then
 * listed here with its file.
 */
import * as fs from "fs";
import * as path from "path";

const SRC = path.join(__dirname, "..");
const walk = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? walk(path.join(dir, e.name))
        : e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")
          ? [path.join(dir, e.name)]
          : [],
    );

/** Non-comment lines calling `isSuperAdmin(` (the declaration `isSuperAdmin(): boolean` is not a call). */
export function isSuperAdminCallers(files: Array<{ file: string; text: string }>): string[] {
  const out: string[] = [];
  for (const { file, text } of files) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const line of code.split("\n")) {
      if (/\bisSuperAdmin\(/.test(line) && !/^\s*isSuperAdmin\(\)\s*:\s*boolean/.test(line))
        out.push(file);
    }
  }
  return out;
}

describe("K-0 isSuperAdmin() caller census", () => {
  it("no non-spec file calls it", () => {
    const files = walk(SRC).map((f) => ({
      file: path.relative(SRC, f).split(path.sep).join("/"),
      text: fs.readFileSync(f, "utf8"),
    }));
    expect(isSuperAdminCallers(files)).toEqual([]);
  });

  it("the scan sees a planted call and ignores the declaration and comments (non-vacuous)", () => {
    const planted = [
      { file: "a.ts", text: "if (this.ctx.isSuperAdmin()) return;" },
      {
        file: "b.ts",
        text: "  isSuperAdmin(): boolean {\n    return true;\n  }\n// isSuperAdmin() in a comment",
      },
    ];
    expect(isSuperAdminCallers(planted)).toEqual(["a.ts"]);
  });
});
