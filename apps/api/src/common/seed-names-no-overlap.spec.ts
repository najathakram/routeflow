import { readFileSync } from "fs";
import { join } from "path";

/**
 * SA-603b: a product NAME is unique among ACTIVE products of a tenant. `prisma/seed.ts` and `scripts/seed-test-catalog.js`
 * both seed the `test` tenant (local:seed runs both), so a name in BOTH loses the second row (or, now, fails the script).
 * This pins that their product names never overlap.
 */
const API = join(__dirname, "..", "..");
const names = (file: string): Set<string> =>
  new Set(
    [...readFileSync(join(API, file), "utf8").matchAll(/\bname:\s*"([^"]+)"/g)].map((m) =>
      m[1].trim().toLowerCase(),
    ),
  );

describe("seed product names never overlap on the shared `test` tenant", () => {
  it("prisma/seed.ts and scripts/seed-test-catalog.js share no product name", () => {
    const a = names("prisma/seed.ts");
    const b = names("scripts/seed-test-catalog.js");
    expect(a.size).toBeGreaterThan(10); // the scan is not vacuous
    expect(b.size).toBeGreaterThan(10);
    expect([...a].filter((n) => b.has(n))).toEqual([]);
  });
});
