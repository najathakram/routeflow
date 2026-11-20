import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * B1371 (SA-1175 R1 M1): the owner-run, READ-ONLY seat counts before the cut-off is deleted
 * (apps/api/scripts/report-b1371-seat-counts.mjs). Its summaries and labels are checked by its own `--self-test`
 * (no database); the argument gates refuse before any connection; and the source carries no write statement.
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/report-b1371-seat-counts.mjs");

function run(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env))
    if (
      k === "DATABASE_URL" ||
      k.startsWith("RAILWAY_") ||
      k.startsWith("POSTGRES_") ||
      k.startsWith("PG")
    )
      delete env[k];
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

describe("report-b1371-seat-counts.mjs (B1371 M1)", () => {
  it("--self-test passes with no database", () => {
    const r = run(["--self-test"]);
    expect(r.out).toContain("self-test ok");
    expect(r.status).toBe(0);
  });

  it.each([
    [[], "--item 1|2|3 is required"],
    [["--item", "4"], "--item 1|2|3 is required"],
    [["--item", "1", "--out", "relative.json"], "--out needs an absolute path"],
    [["--item", "1", "--apply"], "unexpected argument --apply"],
  ])("refuses %j before any connection", (args, msg) => {
    const r = run(args as string[]);
    expect(r.status).toBe(2);
    expect(r.out).toContain(msg);
  });

  it("is read-only: the session is read-only and the SQL never writes", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain("SET default_transaction_read_only = on");
    expect(src).toContain("SET statement_timeout");
    expect(src).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|ALTER\s+TABLE|TRUNCATE|DROP\s)/i,
    );
  });
});
