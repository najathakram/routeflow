/**
 * SA-769 - static guard for `EnableAddonOptions.lockHeld`.
 *
 * `lockHeld: true` makes `AddonService.enableAddon` run a COMP enable WITHOUT taking the per-SKU
 * advisory lock (`addon:<tenant>:<sku>`), on the caller's promise that it already holds that key. The only
 * caller that can honestly make that promise is business-profile confirm, which holds every profile module's
 * key on one pinned connection (`BusinessProfileService.withConfirmLock`) and calls the comp enable from
 * `BusinessProfileApplyService.applyResolvedLocked`. Anywhere else the flag would silently remove the
 * serialisation the lock exists for (B342).
 *
 * This spec fails, naming the file, when:
 *   - any source file other than `addon.service.ts` (the definition) and `business-profile-apply.service.ts` mentions
 *     `lockHeld` in code (src, scripts, prisma; comments are ignored);
 *   - a `lockHeld` in the apply service sits outside `applyResolvedLocked`, or in an options object without
 *     `comp: true`. Whoever passes `lockHeld` holds the lock: every caller of `applyResolvedLocked` takes
 *     `withConfirmLock` first (the controller does today);
 *   - the service honours `lockHeld` without also requiring `comp`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const API_ROOT = path.resolve(__dirname, "..", "..");
const ROOTS = ["src", "scripts", "prisma"].map((d) => path.join(API_ROOT, d));
const SERVICE_FILE = path.resolve(__dirname, "addon.service.ts");
const APPLY_FILE = path.resolve(__dirname, "business-profile-apply.service.ts");
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs)$/;

/** Code with line and block comments blanked out (a comment may mention the flag; code may not). */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

function collect(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      collect(full, out);
    } else if (SOURCE_EXT.test(entry.name) && !/\.(spec|test)\.[tj]sx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** True when the CODE of `text` (comments ignored) mentions `lockHeld`. */
export function mentionsLockHeld(text: string): boolean {
  return /\blockHeld\b/.test(codeOnly(text));
}

/** Files (other than the two allowed) whose code mentions `lockHeld`. */
function strayLockHeldFiles(list: string[]): string[] {
  return list
    .filter((f) => f !== SERVICE_FILE && f !== APPLY_FILE)
    .filter((f) => mentionsLockHeld(fs.readFileSync(f, "utf8")));
}

/** Body of `applyResolvedLocked` in the apply service source (comments kept out). */
function applyLockedBody(code: string): { start: number; end: number } {
  const start = code.indexOf("async applyResolvedLocked(");
  if (start < 0) throw new Error("applyResolvedLocked not found in the apply service");
  // the method is the last member of the class, so the end of the file ends it
  return { start, end: code.length };
}

describe("SA-769 - `lockHeld` has exactly one caller", () => {
  const files = ROOTS.flatMap((root) => collect(root));

  it("walks a non-trivial number of source files (an empty scan must not report green)", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("the detector trips on a stray caller and ignores a comment (a check matching nothing would report green)", () => {
    expect(
      mentionsLockHeld("enableAddon(a, b, undefined, undefined, { comp: true, lockHeld: true });"),
    ).toBe(true);
    expect(mentionsLockHeld("// lockHeld is explained here\n/* and lockHeld here */")).toBe(false);
  });

  it("no file other than addon.service.ts and business-profile-apply.service.ts passes or reads lockHeld", () => {
    expect(strayLockHeldFiles(files).map((f) => path.relative(API_ROOT, f))).toEqual([]);
  });

  it("the apply service passes it only inside applyResolvedLocked, always next to comp: true", () => {
    const code = codeOnly(fs.readFileSync(APPLY_FILE, "utf8"));
    const { start, end } = applyLockedBody(code);
    const hits = [...code.matchAll(/\blockHeld\b/g)];
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      const at = hit.index as number;
      expect(at).toBeGreaterThan(start);
      expect(at).toBeLessThan(end);
      // the options object literal that carries it
      const open = code.lastIndexOf("{", at);
      const close = code.indexOf("}", at);
      expect(code.slice(open, close)).toMatch(/\bcomp:\s*true\b/);
    }
  });

  it("the service honours lockHeld for a comp enable only", () => {
    const code = codeOnly(fs.readFileSync(SERVICE_FILE, "utf8"));
    const uses = [...code.matchAll(/opts\?\.lockHeld/g)];
    expect(uses).toHaveLength(1);
    expect(code).toMatch(/comp\s*&&\s*opts\?\.lockHeld\s*===\s*true/);
  });
});
