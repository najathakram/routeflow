import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

  // #4393 read A M-1: the cron applies every downgrade due at or before now (billing-cron.service.ts
  // `downgradeEffectiveAt: { not: null, lte: now }`), so item 1 must not drop the overdue, unswept ones.
  it("item 1 reads every scheduled downgrade, overdue ones included (the cron's own filter)", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/"downgradeEffectiveAt"\s*>\s*now\(\)/);
    expect(src).toContain(
      `s."downgradeEffectiveAt" IS NOT NULL AND s."downgradeToPlanKey" IS NOT NULL`,
    );
  });

  it("item 1 counts an over-seat downgrade already due as overdue, and its date is the earliest", () => {
    const probe = [
      `import(${JSON.stringify(pathToFileURL(SCRIPT).href)}).then((m) => {`,
      `  const s = m.summarizeItem1([`,
      `    { tenantId: "t-1", effectiveAt: "2026-12-01T00:00:00Z", team: 5, cap: 3, nonAdminNotRetained: 2 },`,
      `    { tenantId: "t-2", effectiveAt: "2026-11-19T00:00:00Z", team: 6, cap: 3, nonAdminNotRetained: 3 },`,
      `  ], new Date("2026-11-20T12:00:00Z"));`,
      `  console.log(JSON.stringify(s));`,
      `});`,
    ].join("\n");
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
      timeout: 60_000,
    });
    const s = JSON.parse(res.stdout.trim());
    expect([s.overSeats, s.overdue, s.wouldDeactivate]).toEqual([2, 1, 5]);
    expect(s.earliestEffectiveAt).toBe("2026-11-19T00:00:00.000Z");
    expect(s.detail.map((d: { overdue: boolean }) => d.overdue)).toEqual([false, true]);
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
