import { existsSync, readFileSync } from "fs";
import { join } from "path";

/**
 * B1019 class pin: every create entry in the command palette pushes `<base>?action=new`
 * (via `createHref("<base>")` or a literal `?action=` target). A page that never reads the
 * `action` search param silently ignores it and just lists records, so each base's page file
 * must read it. Add the page-side handling (see products/page.tsx) when adding a new base.
 */
const paletteSrc = readFileSync(join(__dirname, "CommandPalette.tsx"), "utf8");

function bases(): string[] {
  const found = new Set<string>();
  for (const m of paletteSrc.matchAll(/createHref\(\s*"(\/[^"]*)"\s*\)/g)) found.add(m[1]);
  for (const m of paletteSrc.matchAll(/["'`](\/[A-Za-z0-9/_-]*)\?action=/g)) found.add(m[1]);
  return [...found].sort();
}

const pageFile = (base: string) => join(__dirname, "..", "app", "(dashboard)", base, "page.tsx");

describe("CommandPalette create targets (B1019)", () => {
  it("finds the create bases it is meant to pin", () => {
    expect(bases()).toEqual(expect.arrayContaining(["/customers", "/orders", "/products"]));
  });

  it.each(bases())("the page for %s reads the `action` search param", (base) => {
    const file = pageFile(base);
    expect(existsSync(file)).toBe(true);
    const src = readFileSync(file, "utf8");
    const reads = /get\(\s*["']action["']\s*\)/.test(src);
    if (!reads) {
      throw new Error(
        `CommandPalette pushes ${base}?action=new but ${base}/page.tsx never reads the "action" ` +
          `search param, so the palette's create entry only lists records and never opens the create UI.`,
      );
    }
  });
});
