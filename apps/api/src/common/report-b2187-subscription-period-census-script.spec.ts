import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// #2187 / SA-387 — apps/api/scripts/report-b2187-subscription-period-census.mjs contract.
// Read-only, counts only: fails closed without a DB url, carries no write SQL, buckets period
// lengths exactly as specified, and never lets a tenant id or slug reach its output.

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-b2187-subscription-period-census.mjs");
const source = fs.readFileSync(SCRIPT, "utf8");

function codeLines(): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== "" && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"),
    );
}

function node(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, args, {
    cwd: API_DIR,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}

/** Runs `expr` against the script's exports and returns its JSON-parsed result. */
function evalExports(expr: string) {
  const r = node(
    [
      "--input-type=module",
      "-e",
      `import * as m from ${JSON.stringify(SCRIPT)}; console.log(JSON.stringify(${expr}));`,
    ],
    process.env,
  );
  expect(r.status).toBe(0);
  return { stdout: r.stdout, value: JSON.parse(r.stdout) };
}

describe("report-b2187-subscription-period-census.mjs", () => {
  it("fails closed with no database url, before connecting", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;
    delete env.DATABASE_PUBLIC_URL;
    expect(node([SCRIPT], env).status).toBe(2);
  });

  it("sets the session read-only, caps statements, and carries no write-capable SQL", () => {
    expect(source).toContain("SET default_transaction_read_only = on");
    expect(source).toContain("SET statement_timeout");
    const sql = codeLines().join("\n");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b/);
  });

  it("buckets period lengths at the specified inclusive edges", () => {
    const days = [1, 35, 35.5, 45, 46, 75, 76, 135, 136, 225, 226, 400];
    const { value } = evalExports(`${JSON.stringify(days)}.map(m.bucketOf)`);
    expect(value).toEqual([
      "<=35",
      "<=35",
      "36-45",
      "36-45",
      "46-75",
      "46-75",
      "76-135",
      "76-135",
      "136-225",
      "136-225",
      ">225",
      ">225",
    ]);
  });

  it("summarize counts bucket × cycle and labels only out-of-month rows, anonymously", () => {
    const rows = [
      { tenantId: "33333333-cccc", slug: "initech", cycle: "MONTHLY", days: 30 },
      { tenantId: "11111111-aaaa", slug: "acme", cycle: "MONTHLY", days: 90 },
      { tenantId: "22222222-bbbb", slug: "globex", cycle: "MONTHLY", days: 180 },
      { tenantId: "44444444-dddd", slug: "umbrella", cycle: "ANNUAL", days: 365 },
    ];
    const { stdout, value } = evalExports(`m.summarize(${JSON.stringify(rows)})`);
    expect(stdout).not.toMatch(/1111|2222|3333|4444|acme|globex|initech|umbrella/);
    expect(value).toEqual({
      tenants: 4,
      counts: {
        "<=35": { MONTHLY: 1 },
        "36-45": {},
        "46-75": {},
        "76-135": { MONTHLY: 1 },
        "136-225": { MONTHLY: 1 },
        ">225": { ANNUAL: 1 },
      },
      outside: [
        { tenant: "tenant A", bucket: "76-135", cycle: "MONTHLY" },
        { tenant: "tenant B", bucket: "136-225", cycle: "MONTHLY" },
        { tenant: "tenant C", bucket: ">225", cycle: "ANNUAL" },
      ],
    });
  });
});
