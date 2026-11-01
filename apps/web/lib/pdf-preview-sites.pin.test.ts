import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * W-1064 P8 (SA-1074): a PDF in an iframe doesn't scroll on iOS, so every preview goes through `PdfPreview`, which keeps the
 * iframe for desktop only. A new `<iframe` belongs there, or needs its own answer on a phone.
 */
const WEB = resolve(__dirname, "..");
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("P8: every PDF iframe is inside PdfPreview", () => {
  it("nothing else in app or components draws an iframe", () => {
    const hits = ["app", "components"]
      .flatMap((d) => sources(join(WEB, d)))
      .filter((f) => /<iframe\s/.test(readFileSync(f, "utf8")))
      .map((f) => relative(WEB, f).split("\\").join("/"));
    expect(hits).toEqual(["components/PdfPreview.tsx"]);
  });
});
