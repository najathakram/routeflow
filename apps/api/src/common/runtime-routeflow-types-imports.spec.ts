import * as fs from "fs";
import * as path from "path";

/**
 * `@routeflow/types` ships TypeScript SOURCE (packages/types/index.ts) and is never compiled for
 * the api image, so the compiled api may only ever `import type` from it — a VALUE import makes
 * `node dist/main.js` load a .ts file and crash at boot (#2406: a `RETURN_KIND_VALUES` import did
 * exactly that; every mocked spec stayed green). Use the Prisma enum / a local const instead.
 */
const SRC = path.resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name) ? [p] : [];
  });
}

describe("apps/api never VALUE-imports @routeflow/types (it is TS source at runtime)", () => {
  it("every import from @routeflow/types in api source is `import type`", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      // Real import STATEMENTS only (line-start `import`, no `;` inside the clause) — never a
      // mention in a comment.
      const re = /^import\s+(type\s+)?[^;]*?from\s+["']@routeflow\/types["']/gm;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (!m[1]) offenders.push(path.relative(SRC, file));
      }
      // A real require() call, not a mention inside a /** … */ or // comment.
      if (/^(?!\s*(\*|\/\/)).*require\(\s*["']@routeflow\/types["']\s*\)/m.test(text))
        offenders.push(path.relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });
});
