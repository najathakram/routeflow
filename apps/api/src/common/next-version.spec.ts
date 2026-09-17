/**
 * T1 (S4, Next 15 upgrade — apps/web 14.2.35 → 15.5.25 + React 19): version-pin tripwire.
 *
 * Clears the two CRITICAL npm-audit advisories fixed only in Next 15.5.24+ (allowlist expires
 * 2026-09-30 — see `.claude/pipeline/2026-09-10-next-15/spec.md` R1). REG-B352: this test used
 * to pin the exact literals the upgrade landed on, which broke on every routine Next.js patch
 * bump even though the guard only needs to confirm the Next-14 downgrade never returns. A
 * subsequent review found that a plain major-line check (`pinnedToMajorLine`) is too loose here:
 * it would pass on a downgrade to e.g. `15.0.0`, which is still on the major-15 line but predates
 * the fix and would silently lose the CRITICAL-advisory protection. So this now asserts `next`,
 * `eslint-config-next`, and the win32 SWC binary are all at or above the `15.5.25` minimum via
 * `meetsMinimumOnMajorLine` (major-line match AND minor/patch >= the minimum, numerically —
 * `pinnedToMajorLine` itself is unchanged and still used by the REG-B352 block below and any
 * caller that reasonably wants pure major-line matching), reading the manifest with plain
 * `fs.readFileSync`, matching the house convention (see `no-dead-deps.spec.ts`).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { pinnedToMajorLine, meetsMinimumOnMajorLine } from "./next-version";

const NEXT_MIN = { major: 15, minor: 5, patch: 25 };

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

type WebManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function readWebManifest(): WebManifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, "apps/web/package.json"), "utf8"));
}

describe("apps/web is at or above Next 15.5.25 (T1, R1)", () => {
  const manifest = readWebManifest();

  it("dependencies.next meets the 15.5.25 minimum", () => {
    expect(
      meetsMinimumOnMajorLine(
        manifest.dependencies?.next ?? "",
        NEXT_MIN.major,
        NEXT_MIN.minor,
        NEXT_MIN.patch,
      ),
    ).toBe(true);
  });

  it('devDependencies["eslint-config-next"] meets the 15.5.25 minimum', () => {
    expect(
      meetsMinimumOnMajorLine(
        manifest.devDependencies?.["eslint-config-next"] ?? "",
        NEXT_MIN.major,
        NEXT_MIN.minor,
        NEXT_MIN.patch,
      ),
    ).toBe(true);
  });

  it('optionalDependencies["@next/swc-win32-x64-msvc"] meets the 15.5.25 minimum', () => {
    expect(
      meetsMinimumOnMajorLine(
        manifest.optionalDependencies?.["@next/swc-win32-x64-msvc"] ?? "",
        NEXT_MIN.major,
        NEXT_MIN.minor,
        NEXT_MIN.patch,
      ),
    ).toBe(true);
  });
});

describe("REG-B352", () => {
  it("accepts a bare version pinned to the given major line", () => {
    expect(pinnedToMajorLine("15.6.0", 15)).toBe(true);
  });

  it("accepts a caret-ranged version pinned to the given major line", () => {
    expect(pinnedToMajorLine("^15.6.0", 15)).toBe(true);
  });

  it("rejects a version pinned to a different major line", () => {
    expect(pinnedToMajorLine("14.2.35", 15)).toBe(false);
  });

  it("meetsMinimumOnMajorLine accepts the exact minimum", () => {
    expect(meetsMinimumOnMajorLine("15.5.25", 15, 5, 25)).toBe(true);
  });

  it("meetsMinimumOnMajorLine accepts something higher than the minimum", () => {
    expect(meetsMinimumOnMajorLine("^15.6.0", 15, 5, 25)).toBe(true);
  });

  it("meetsMinimumOnMajorLine rejects the same major but a lower patch", () => {
    expect(meetsMinimumOnMajorLine("15.5.24", 15, 5, 25)).toBe(false);
  });

  it("meetsMinimumOnMajorLine rejects a different major entirely", () => {
    expect(meetsMinimumOnMajorLine("14.2.35", 15, 5, 25)).toBe(false);
  });
});
