import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * #2230 / SA-388 census: the owner-run report of unit lines (unitsPerBox > 1) with no box count.
 * It is read-only and prints counts only; pinned here by running its --self-test and by source.
 */
const API_DIR = path.resolve(__dirname, "../..");
const REPORT = path.resolve(API_DIR, "scripts/report-b2230-unit-lines-without-boxes.mjs");
const src = fs.readFileSync(REPORT, "utf8");

describe("report-b2230-unit-lines-without-boxes", () => {
  it("--self-test passes with no database", () => {
    const res = spawnSync(process.execPath, [REPORT, "--self-test"], {
      encoding: "utf8",
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(res.stderr).toBe("");
    expect(res.stdout.trim()).toBe("self-test ok");
    expect(res.status).toBe(0);
  });

  it("is read-only: the session is set read-only first and no write statement appears", () => {
    const readOnly = src.indexOf("SET default_transaction_read_only = on");
    expect(readOnly).toBeGreaterThan(0);
    expect(src.indexOf("censusSql(table)", readOnly)).toBeGreaterThan(readOnly);
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/);
  });

  it("counts the exact violating shape the CHECK will forbid", () => {
    expect(src).toContain(
      'i."unitLabel" IS NOT NULL AND COALESCE(i."unitsPerBox", 1) > 1 AND i.qty > 0 AND COALESCE(i.boxes, 0) < 1 AND COALESCE(i.pieces, 0) < 1',
    );
  });

  it("never prints a tenant id or slug: only the anonymous summary reaches stdout", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const m of code.matchAll(/console\.log\(([^;]*)\);/g)) {
      expect(m[1]).not.toMatch(/\.slug|\.tenantId|onlyTenant/);
    }
  });
});
