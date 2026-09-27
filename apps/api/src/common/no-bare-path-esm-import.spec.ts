import fs from "node:fs";
import path from "node:path";

// An ESM import of an absolute path must go through a file:// URL: on win32 a bare `C:\…` path is
// ERR_UNSUPPORTED_ESM_URL_SCHEME. CI runs on Linux only, so nothing else catches it — the b2188,
// b2197, db-lane, local-db and script-lane specs all shipped it and blocked every Windows push.
// Flags an ESM import — `import(X)`, or a template-built `import(X)` / `import … from X` that
// stringifies X — whose argument is a bare path constant or a `path.*` call, unless the line wraps
// it (pathToFileURL(...).href, a "file://" prefix, or a *HREF / *URL variable holding a URL).
const BARE =
  /(?:(?:from |import\()\$\{JSON\.stringify\(|\bimport\()\s*(?:(?![A-Z_]*(?:HREF|URL)\b)[A-Z][A-Z_]*\b|path\.)/;

function specFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : specFiles(p);
    return e.name.endsWith(".spec.ts") ? [p] : [];
  });
}

describe("specs import scripts by file:// URL, never a bare path (win32 ESM)", () => {
  it("no spec passes a bare absolute path to an ESM import", () => {
    // Its own header names the shapes, so it scans every OTHER spec.
    const others = specFiles(path.resolve(__dirname, "..")).filter((f) => f !== __filename);
    const offenders = others.flatMap((f) =>
      fs
        .readFileSync(f, "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: `${path.relative(__dirname, f)}:${i + 1}` }))
        .filter(({ line }) => BARE.test(line) && !/pathToFileURL|file:\/\//.test(line))
        .map(({ at, line }) => `${at}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
