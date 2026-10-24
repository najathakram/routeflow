import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * SA-740 §1 (row 190), history: the owner-run, READ-ONLY census of walk-in inline returns whose goods were
 * allocated to a sale other than the one carrying the return (apps/api/scripts/report-sa740-walkin-return-source.mjs).
 * Report-only (L-207): there is no repair here, so the owner can size the damage before deciding anything.
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/report-sa740-walkin-return-source.mjs");
const src = readFileSync(SCRIPT, "utf8");

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  for (const k of Object.keys(env))
    if (
      k === "DATABASE_URL" ||
      k.startsWith("RAILWAY_") ||
      k.startsWith("POSTGRES_") ||
      k.startsWith("PG")
    )
      delete env[k];
  Object.assign(env, extraEnv);
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

describe("report-sa740-walkin-return-source.mjs (SA-740 §1)", () => {
  it("--self-test passes with no database", () => {
    const r = run(["--self-test"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/self-test: all \d+ passed/);
  });

  it("reaches the database only through the shared resolver, in a READ ONLY transaction that is always rolled back", () => {
    expect(src).toContain("./lib/report-db-url.mjs");
    expect(src).toContain("BEGIN READ ONLY");
    expect(src).toContain("ROLLBACK");
    expect(src).not.toMatch(/process\.env\.DATABASE_URL/);
  });

  it("the sizing query is a SELECT only, over walk-in INLINE returns whose item source differs from the carrying order", () => {
    const sql = /export const SIZING_SQL = `([\s\S]*?)`;/.exec(src)?.[1] ?? "";
    expect(sql).toMatch(/c\."isWalkIn" = true/);
    expect(sql).toMatch(/r\.kind = 'INLINE'/);
    expect(sql).toMatch(/ri\."sourceOrderId" IS DISTINCT FROM r\."orderId"/);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/i);
  });

  it("--include-live refuses without an exclusion list, before any database is resolved", () => {
    const r = run(["--include-live"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/needs a non-empty exclusion list/);
  });
});
