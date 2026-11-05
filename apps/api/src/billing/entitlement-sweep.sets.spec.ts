import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { MULTI_KEY_ADDON_SETS } from "./entitlement-sweep.service";

/**
 * FG-1 WP1: the sweep carries one row per distinct multi-key `@RequireAddon(a, b, ...)` set. The
 * list lives in the sweep service; this pin scans the sources so a new any-of set cannot ship
 * without a sweep row (a mixed set is decided by `decideAddonAccess`, not by a per-key rule).
 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

describe("multi-key @RequireAddon sets", () => {
  it("the sweep lists exactly the distinct multi-key sets used in the source", () => {
    const found = new Set<string>();
    const pattern = /@RequireAddon\(([^)]*)\)/g;
    for (const file of sourceFiles(path.resolve(__dirname, ".."))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(pattern)) {
        const keys = match[1].match(/"([^"]+)"/g)?.map((k) => k.slice(1, -1)) ?? [];
        if (keys.length > 1) found.add(keys.join("|"));
      }
    }
    expect([...found].sort()).toEqual(MULTI_KEY_ADDON_SETS.map((s) => s.join("|")).sort());
  });
});
