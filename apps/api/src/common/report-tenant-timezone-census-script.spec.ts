import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isValidTimeZone } from "./tenant-time-zone";

// SA-738 rule 5 — apps/api/scripts/report-tenant-timezone-census.mjs contract. Read-only, counts
// only: fails closed without a DB url, runs its one SELECT in a READ ONLY transaction, carries no
// write SQL, counts "no TenantConfig row" and "zone fails the resolver's Intl check", and never
// lets a slug or id reach its output.

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-tenant-timezone-census.mjs");
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
      `import * as m from ${JSON.stringify(pathToFileURL(SCRIPT).href)}; console.log(JSON.stringify(${expr}));`,
    ],
    process.env,
  );
  expect(r.status).toBe(0);
  return { stdout: r.stdout, value: JSON.parse(r.stdout) };
}

describe("report-tenant-timezone-census.mjs", () => {
  it("fails closed with no database url, before connecting", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;
    delete env.DATABASE_PUBLIC_URL;
    expect(node([SCRIPT], env).status).toBe(2);
  });

  it("is read-only: session read-only, READ ONLY transaction rolled back, capped, no write SQL", () => {
    expect(source).toContain("SET default_transaction_read_only = on");
    expect(source).toContain("BEGIN READ ONLY");
    expect(source).toContain("ROLLBACK");
    expect(source).toContain("SET statement_timeout");
    expect(source).toContain("SET lock_timeout");
    expect(source).not.toMatch(/\bCOMMIT\b/);
    const sql = codeLines().join("\n");
    expect(sql).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|COPY|VACUUM)\b/,
    );
  });

  it("LEFT JOINs TenantConfig so a tenant with no row is counted", () => {
    expect(source).toMatch(/LEFT JOIN "TenantConfig" c ON c\."tenantId" = t\.id/);
    expect(source).toContain(`c.id IS NOT NULL AS "hasConfig"`);
  });

  it("--self-test runs when spawned by its real path", () => {
    const r = node([SCRIPT, "--self-test"], process.env);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("self-test ok");
  });

  it("its zone check equals the resolver's read-side predicate over a sample set", () => {
    const samples = [
      "America/Chicago",
      "UTC",
      "Europe/London",
      "america/chicago",
      "EST",
      "Etc/GMT+5",
      "",
      "Mars/Phobos",
      "+01:00",
      "-05:00",
      " America/Chicago",
      "America/Chicago ",
      "123",
    ];
    const { value } = evalExports(`${JSON.stringify(samples)}.map(m.isUsableZone)`);
    expect(value).toEqual(samples.map((s) => isValidTimeZone(s)));
    const { value: nonStrings } = evalExports("[null, 42, undefined].map(m.isUsableZone)");
    expect(nonStrings).toEqual([false, false, false]);
  });

  it("countZones: no row and invalid zone are counted apart; a good zone is neither", () => {
    const rows = [
      { slug: "a", hasConfig: true, timezone: "America/Chicago" },
      { slug: "b", hasConfig: false, timezone: null },
      { slug: "c", hasConfig: true, timezone: "Mars/Phobos" },
      { slug: "d", hasConfig: true, timezone: "" },
      { slug: "e", hasConfig: true, timezone: "+01:00" },
    ];
    const { value } = evalExports(`m.countZones(${JSON.stringify(rows)})`);
    expect(value).toEqual({ tenants: 5, noConfigRow: 1, invalidZone: 3 });
    const { value: none } = evalExports("m.countZones([])");
    expect(none).toEqual({ tenants: 0, noConfigRow: 0, invalidZone: 0 });
  });

  it("summarize: live and test tenants apart, and no slug reaches the output", () => {
    const rows = [
      { slug: "acme-wholesale", hasConfig: false, timezone: null },
      { slug: "globex-foods", hasConfig: true, timezone: "Mars/Phobos" },
      { slug: "qa-smoke-1", hasConfig: false, timezone: null },
      { slug: "e2e-routeflow", hasConfig: true, timezone: "America/Chicago" },
    ];
    const { stdout, value } = evalExports(`m.summarize(${JSON.stringify(rows)})`);
    expect(stdout).not.toMatch(/acme|globex|qa-smoke|e2e-routeflow/);
    expect(value.live).toEqual({ tenants: 2, noConfigRow: 1, invalidZone: 1 });
    expect(value.test).toEqual({ tenants: 2, noConfigRow: 1, invalidZone: 0 });
  });
});
