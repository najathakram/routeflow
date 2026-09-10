/**
 * T1 (S4, Next 15 upgrade — apps/web 14.2.35 → 15.5.25 + React 19): static version-pin tripwire.
 *
 * Clears the two CRITICAL npm-audit advisories fixed only in Next 15.5.24+ (allowlist expires
 * 2026-09-30 — see `.claude/pipeline/2026-09-10-next-15/spec.md` R1). This test pins the exact
 * literals the upgrade must land on, per spec R1: `"15.5.25"` for `next` and
 * `eslint-config-next`, `"^15.5.25"` for the win32 SWC binary. No runtime imports — plain
 * `fs.readFileSync` of the manifest, matching the house convention (see `no-dead-deps.spec.ts`).
 */
import { readFileSync } from "fs";
import { join } from "path";

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

  it('dependencies.next is exactly "15.5.25"', () => {
    // Red today: apps/web/package.json pins "14.2.35".
    expect(manifest.dependencies?.next).toBe("15.5.25");
  });

  it('devDependencies["eslint-config-next"] is exactly "15.5.25"', () => {
    // Red today: apps/web/package.json pins "14.2.35".
    expect(manifest.devDependencies?.["eslint-config-next"]).toBe("15.5.25");
  });

  it('optionalDependencies["@next/swc-win32-x64-msvc"] is exactly "^15.5.25"', () => {
    // Red today: apps/web/package.json pins "^14.2.33". Asserts the literal range spec R1
    // requires — a looser major-only check would accept a stale `^15.0.0` pin.
    expect(manifest.optionalDependencies?.["@next/swc-win32-x64-msvc"]).toBe("^15.5.25");
  });
});
