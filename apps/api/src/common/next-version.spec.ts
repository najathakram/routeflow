/**
 * T1 (S4, Next 15 upgrade — apps/web 14.2.35 → 15.5.25 + React 19): major-line version-pin
 * tripwire.
 *
 * Clears the two CRITICAL npm-audit advisories fixed only in Next 15.5.24+ (allowlist expires
 * 2026-09-30 — see `.claude/pipeline/2026-09-10-next-15/spec.md` R1). REG-B352: this test used
 * to pin the exact literals the upgrade landed on, which broke on every routine Next.js patch
 * bump even though the guard only needs to confirm the Next-14 downgrade never returns. It now
 * asserts `next`, `eslint-config-next`, and the win32 SWC binary are all still pinned to the
 * major-15 line via `pinnedToMajorLine` (see PR #745 for the same fix on the sibling React-pin
 * guard), reading the manifest with plain `fs.readFileSync`, matching the house convention (see
 * `no-dead-deps.spec.ts`).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { pinnedToMajorLine } from "./next-version";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

type WebManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function readWebManifest(): WebManifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, "apps/web/package.json"), "utf8"));
}

describe("apps/web is pinned to Next 15.5.25 (T1, R1)", () => {
  const manifest = readWebManifest();

  it("dependencies.next is pinned to the 15.x major line", () => {
    expect(pinnedToMajorLine(manifest.dependencies?.next ?? "", 15)).toBe(true);
  });

  it('devDependencies["eslint-config-next"] is pinned to the 15.x major line', () => {
    expect(pinnedToMajorLine(manifest.devDependencies?.["eslint-config-next"] ?? "", 15)).toBe(
      true,
    );
  });

  it('optionalDependencies["@next/swc-win32-x64-msvc"] is pinned to the 15.x major line', () => {
    expect(
      pinnedToMajorLine(manifest.optionalDependencies?.["@next/swc-win32-x64-msvc"] ?? "", 15),
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
});
