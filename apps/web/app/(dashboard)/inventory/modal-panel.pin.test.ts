/**
 * Hotfix pin: every hand-rolled `fixed inset-0` dialog under inventory/ and purchase-orders/ must
 * use the shared panel (viewport-capped, scrolling body, footer kept in view). A bare overlay with
 * a free-growing panel pushes Save / "Confirm receipt" below the screen on a long purchase order.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOTS = [__dirname, path.join(__dirname, "..", "purchase-orders")];

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [p] : [];
  });
}

describe("hand-rolled overlays use the shared modal panel", () => {
  const overlays: { file: string; line: number; nextLines: string }[] = [];
  for (const file of ROOTS.flatMap(sourceFiles)) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((l, i) => {
      if (l.includes('className="fixed inset-0')) {
        overlays.push({
          file: path.relative(__dirname, file),
          line: i + 1,
          nextLines: lines.slice(i, i + 3).join("\n"),
        });
      }
    });
  }

  it("finds the known overlays", () => {
    expect(overlays.length).toBeGreaterThanOrEqual(8);
  });

  it.each(overlays.map((o) => [`${o.file}:${o.line}`, o.nextLines]))(
    "%s renders MODAL_PANEL",
    (_where, nextLines) => {
      expect(nextLines).toContain("MODAL_PANEL");
    },
  );
});
