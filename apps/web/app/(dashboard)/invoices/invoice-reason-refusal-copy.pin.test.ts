import { readFileSync } from "fs";
import { join } from "path";

/** H3b (SA): the invoice create and edit save errors show the fixed safe-text copy before anything else. */
const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");

describe("web invoice save errors use the fixed safe-text copy", () => {
  it("new invoice: unitRefusal returns the safe-text copy first", () => {
    const src = read("new/page.tsx");
    expect(src).toMatch(
      /const textCopy = safeTextErrorCopy\(err\);\s+if \(textCopy\) return textCopy;/,
    );
  });
  it("edit invoice: the save-error toast prefers the safe-text copy", () => {
    expect(read("[id]/edit/page.tsx")).toMatch(/description:\s+safeTextErrorCopy\(err\) \?\?/);
  });
});
