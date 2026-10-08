import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// PR1 SA722-3 - apps/api/scripts/report-rf-invoice-zero-rows.mjs: the owner's read-only "RfInvoice has
// 0 rows" precondition for the additive migration (its Squawk waiver says exactly that). It exits 0
// ONLY on zero rows; any row, any error, any unreadable count is non-zero.

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-rf-invoice-zero-rows.mjs");
const source = fs.readFileSync(SCRIPT, "utf8");

function node(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, args, {
    cwd: API_DIR,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}

function exitCodeFor(count: unknown): number {
  const r = node(
    [
      "--input-type=module",
      "-e",
      `import { exitCodeForCount } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};` +
        `console.log(exitCodeForCount(${JSON.stringify(count)}));`,
    ],
    process.env,
  );
  expect(r.status).toBe(0);
  return Number(r.stdout.trim());
}

describe("report-rf-invoice-zero-rows.mjs", () => {
  it("SA722-3: exits 0 only when the count is exactly 0", () => {
    expect(exitCodeFor(0)).toBe(0);
    for (const bad of [1, 2, 41, -1, null, "0", "abc"]) expect(exitCodeFor(bad)).not.toBe(0);
  });

  it("fails closed with no database url, before connecting (exit 2)", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;
    delete env.DATABASE_PUBLIC_URL;
    expect(node([SCRIPT], env).status).toBe(2);
  });

  it("is read-only: session read-only, capped, and no write-capable SQL", () => {
    expect(source).toContain("SET default_transaction_read_only = on");
    expect(source).toContain("SET statement_timeout");
    const sql = source
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"))
      .join("\n");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b/);
  });

  it("--self-test runs by its real path and prints counts-only output", () => {
    const r = node([SCRIPT, "--self-test"], process.env);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("self-test ok");
  });
});
