import * as fs from "fs";
import * as path from "path";

/** B956: web and mobile show the SAME fixed copy for a refused name (the helper file is identical). */
const strip = (file: string): string =>
  fs
    .readFileSync(path.resolve(__dirname, file), "utf8")
    .replace(/^\s*\*.*$/gm, "") // comment lines name the other file, so they may differ
    .replace(/\/\*\*[\s\S]*?\*\//g, "");

describe("safe-text error copy parity (web = mobile)", () => {
  it("the labels, the copy sentence and the code branch are identical in apps/web and apps/mobile", () => {
    const web = strip("./safe-text-error-copy.ts");
    const mobile = strip("../../mobile/lib/safe-text-error-copy.ts");
    expect(web).toContain("SAFE_TEXT_FIELD_LABELS");
    expect(web.length).toBeGreaterThan(400);
    expect(mobile).toBe(web);
  });

  it("neither reads a server message", () => {
    for (const f of ["./safe-text-error-copy.ts", "../../mobile/lib/safe-text-error-copy.ts"]) {
      const src = fs.readFileSync(path.resolve(__dirname, f), "utf8");
      expect(src).not.toMatch(/data\??\.message/);
    }
  });
});
