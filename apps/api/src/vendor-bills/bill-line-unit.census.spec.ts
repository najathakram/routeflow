import { readFileSync } from "fs";
import { join } from "path";

/**
 * SA-1207 S2b spec 4 (L-223, L-364, L-377): the inventory of every reader of a stored bill or PO
 * line's `packSize`. The unit of a line is read ONE way, `billLineUnit` (packages/pricing). A file
 * below may hold only the bare reads pinned here (a write or a pass-through); a new bare read fails
 * this spec, and the fix is to read through `billLineUnit` or, for a true write, raise the pin here
 * with the reason.
 */
const ROOT = join(__dirname, "..", "..", "..", "..");
const BARE = /\.packSize\b/g;

/** file -> bare `.packSize` reads left (writes / DTO pass-through only). */
const PINS: Record<string, number> = {
  "apps/api/src/vendor-bills/vendor-bills.service.ts": 5,
  "apps/api/src/vendor-bills/bill-line-pack.ts": 0,
  "apps/api/src/vendor-bills/pack-size-gate.ts": 1,
  "apps/web/app/(dashboard)/vendor-bills/[id]/page.tsx": 3,
  "apps/mobile/lib/vendor-bill-scan.ts": 7,
};

/** Files that must read the line's unit through `billLineUnit`. */
const MUST_USE = [
  "apps/api/src/vendor-bills/vendor-bills.service.ts",
  "apps/api/src/vendor-bills/bill-line-pack.ts",
  "apps/web/app/(dashboard)/vendor-bills/[id]/page.tsx",
  "apps/mobile/lib/vendor-bill-scan.ts",
  "packages/pricing/src/pricing.ts",
];

describe("bill-line unit census (one reader: billLineUnit)", () => {
  it.each(Object.entries(PINS))("%s holds at most %d bare .packSize reads", (file, max) => {
    const src = readFileSync(join(ROOT, file), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect((code.match(BARE) ?? []).length).toBeLessThanOrEqual(max);
  });

  it.each(MUST_USE)("%s reads through billLineUnit", (file) => {
    expect(readFileSync(join(ROOT, file), "utf8")).toMatch(/billLineUnit\(/);
  });
});
