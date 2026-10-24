/**
 * B1186 guard (the no-bare-cron.spec.ts precedent): a FORBIDDEN-PATTERN scan, not a behaviour test.
 * With the pg driver adapter `meta.target` is unset on a P2002 - a reader that looks only there never
 * fires (SA-717). Every unique-violation reader goes through `common/prisma-unique.ts`.
 */
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..");
const ALLOWED = new Set([path.join(SRC, "common", "prisma-unique.ts")]);
const PATTERN = /\bmeta\s*(?:\?\.|\.)\s*target\b|\bmeta\s*\?*\.?\s*\[\s*["']target["']\s*\]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist") walk(p, out);
    } else if (/\.ts$/.test(e.name) && !/\.spec\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

describe("no direct meta.target read outside common/prisma-unique.ts (B1186)", () => {
  it("the scanner itself sees the forbidden forms", () => {
    expect(PATTERN.test("const t = err?.meta?.target;")).toBe(true);
    expect(PATTERN.test("err.meta.target.join(',')")).toBe(true);
    expect(PATTERN.test("meta.target")).toBe(true);
    expect(PATTERN.test("const target = (meta ?? {}).target")).toBe(false); // documented limit: the destructure idiom
  });

  it("finds none in non-spec sources", () => {
    expect(walk(SRC).length).toBeGreaterThan(100); // the scan really walks the tree (no-bare-cron precedent)
    const offenders = walk(SRC)
      .filter((f) => !ALLOWED.has(f))
      .flatMap((f) =>
        fs
          .readFileSync(f, "utf8")
          .split("\n")
          .map((l, i) => ({ f, i: i + 1, l }))
          .filter(({ l }) => !/^\s*(\/\/|\*|\/\*)/.test(l) && PATTERN.test(l))
          .map(({ f: file, i }) => `${path.relative(SRC, file)}:${i}`),
      );
    expect(offenders).toEqual([]);
  });
});
