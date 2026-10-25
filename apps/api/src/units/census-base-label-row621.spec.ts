import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { sqlKeyOf } from "./unit-name-sql";

/** Row 621 census (SA-971): its SQL key is the units SQL key, and the script can only read. */
const script = join(__dirname, "../../scripts/census-base-label-row621.mjs");
const loaded = JSON.parse(
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(script)}).then(m => console.log(JSON.stringify({ k: m.keyOf("X"), c: m.COUNTS_SQL, p: m.PRODUCTS_SQL })))`,
    ],
    { encoding: "utf8" },
  ),
) as { k: string; c: string; p: string };

describe("census-base-label-row621 (SA-971)", () => {
  it("builds the same key expression as sqlKeyOf", () => {
    expect(loaded.k).toBe(sqlKeyOf(Prisma.raw("X")).sql);
  });

  it("runs only SELECTs", () => {
    for (const sql of [loaded.c, loaded.p]) {
      expect(sql.trim().toUpperCase().startsWith("SELECT")).toBe(true);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
    }
  });
});
