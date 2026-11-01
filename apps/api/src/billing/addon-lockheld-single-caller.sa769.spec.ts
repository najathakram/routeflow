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
 *     `comp: true`. Whoever passes `lockHeld` holds the lock, so EVERY non-spec call of `applyResolvedLocked` must sit
 *     inside a `withConfirmLock(` callback (the two back-office confirm routes and the tenant's first question today).
 *     The method is public, so this is a check on its callers, not a comment;
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

/** Body of `applyResolvedLocked` in the apply service source (comments kept out): from its signature to its own closing brace. */
function applyLockedBody(code: string): { start: number; end: number } {
  const start = code.indexOf("async applyResolvedLocked(");
  if (start < 0) throw new Error("applyResolvedLocked not found in the apply service");
  // a class member closes at its own two-space indent; the next such brace after the signature is this method's end
  const close = code.indexOf("\n  }\n", start);
  if (close < 0) throw new Error("the end of applyResolvedLocked was not found");
  return { start, end: close + "\n  }".length };
}

/**
 * Offsets of every `.applyResolvedLocked(` CALL in `code` that is not inside a `withConfirmLock(...)` argument list.
 * It looks back to the nearest `withConfirmLock(` and follows the parentheses from there: if they close before the call,
 * the call is outside the callback.
 */
export function callsOutsideConfirmLock(code: string): number[] {
  const outside: number[] = [];
  for (const m of code.matchAll(/\.applyResolvedLocked\(/g)) {
    const at = m.index as number;
    const lock = code.lastIndexOf("withConfirmLock(", at);
    let inside = false;
    if (lock >= 0) {
      let depth = 1;
      let i = lock + "withConfirmLock(".length;
      for (; i < at && depth > 0; i++) {
        if (code[i] === "(") depth++;
        else if (code[i] === ")") depth--;
      }
      inside = depth > 0;
    }
    if (!inside) outside.push(at);
  }
  return outside;
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

  it("the call detector trips on a call outside withConfirmLock and passes one inside (a check matching nothing would report green)", () => {
    const inside =
      "return this.profiles.withConfirmLock(id, async () => {\n  await this.apply.applyResolvedLocked(a, b);\n});";
    const after =
      "await this.profiles.withConfirmLock(id, async () => { await x(); });\nawait this.apply.applyResolvedLocked(a, b);";
    const bare = "async other() { return this.apply.applyResolvedLocked(a, b); }";
    expect(callsOutsideConfirmLock(inside)).toEqual([]);
    expect(callsOutsideConfirmLock(after)).toHaveLength(1);
    expect(callsOutsideConfirmLock(bare)).toHaveLength(1);
  });

  it("every non-spec call of applyResolvedLocked sits inside a withConfirmLock callback, and there is at least one", () => {
    const callers = files.filter((f) =>
      /\.applyResolvedLocked\(/.test(codeOnly(fs.readFileSync(f, "utf8"))),
    );
    expect(callers.map((f) => path.relative(API_ROOT, f).split(path.sep).join("/")).sort()).toEqual(
      [
        "src/platform-admin/platform-admin.controller.ts",
        "src/settings-fulfilment/first-run.service.ts",
      ],
    );
    for (const f of callers) {
      const code = codeOnly(fs.readFileSync(f, "utf8"));
      expect({ file: path.relative(API_ROOT, f), outside: callsOutsideConfirmLock(code) }).toEqual({
        file: path.relative(API_ROOT, f),
        outside: [],
      });
    }
  });

  it("the service honours lockHeld for a comp enable only", () => {
    const code = codeOnly(fs.readFileSync(SERVICE_FILE, "utf8"));
    const uses = [...code.matchAll(/opts\?\.lockHeld/g)];
    expect(uses).toHaveLength(1);
    expect(code).toMatch(/comp\s*&&\s*opts\?\.lockHeld\s*===\s*true/);
  });
});
