import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * B16's web half (SA-1072): `lastPrice` is what the screen shows as "Last:" and what the discount pre-fill starts from. It
 * never decides that a price sticks, and a read that does still compiles, because the field stays on the type. So every
 * use is counted here. A new reader changes a count: if it prices a line, it takes `stickyPrice`, or `customerLinePrice`
 * gets the wrong answer in silence. If it only shows "Last:", add it with its reason.
 */
const WEB = resolve(__dirname, "..");

const READERS: Record<string, { uses: number; why: string }> = {
  "app/(dashboard)/orders/_components/CreateOrderModal.tsx": {
    uses: 3,
    why: "the discount test and the value both pre-fills use, which equals stickyPrice on an upsell",
  },
  "app/(dashboard)/orders/[id]/_components/order-line-edit.tsx": {
    uses: 3,
    why: "the same discount test and pre-fill value, plus the helper's own type",
  },
  "app/(dashboard)/orders/_components/scan/PriceEditor.tsx": {
    uses: 3,
    why: 'the "Last:" text',
  },
  "components/LineItemRow.tsx": { uses: 3, why: 'the "Last:" text' },
};

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("B16: every web use of lastPrice is counted", () => {
  it("nothing else in the web source names it, in any spelling", () => {
    const uses = Object.fromEntries(
      ["app", "components", "lib"]
        .flatMap((d) => sources(join(WEB, d)))
        .map((f) => [
          relative(WEB, f),
          (strip(readFileSync(f, "utf8")).match(/lastPrice/g) ?? []).length,
        ])
        .filter(([, n]) => n > 0),
    );
    const expected = Object.fromEntries(Object.entries(READERS).map(([f, r]) => [f, r.uses]));
    expect(uses).toEqual(expected);
  });
});
