import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// REG-G8c / R10 — the RLS arming pre-flight.
//
// R10 is a P0 requirement whose entire deliverable is a script; on the untouched branch
// `scripts/rls-preflight.mjs` does not exist and every assertion here is red.
//
// Why it exists at all: a NULL "tenantId" never equals the session's
// current_setting('app.current_tenant_id'), so the instant FORCE ROW LEVEL SECURITY is armed,
// every NULL-tenantId row becomes invisible AND unwritable to every role — the app's own
// connection included. Arming without this count is a self-inflicted outage on production data.
//
// The script is ESM (`.mjs`) and this project's Jest runs CommonJS with a `.ts`-only transform,
// so it cannot be `require`d here. Rather than weaken the proof to a grep, the counter is driven
// for real in a child Node process (native ESM) and its results are read back as JSON — the
// assertions stay in this file.

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const PREFLIGHT = path.join(REPO_ROOT, "scripts", "rls-preflight.mjs");

function driveCounter(): {
  dirty: { exitCode: number; report: string; results: { table: string; count: unknown }[] };
  clean: { exitCode: number; results: { table: string; count: unknown }[] };
  errored: { exitCode: number; report: string };
  policiedTables: string[];
} {
  const moduleUrl = pathToFileURL(PREFLIGHT).href;
  const driver = `
import { countNullTenantRows, formatReport, loadPoliciedTables } from ${JSON.stringify(moduleUrl)};
const TABLES = ["User", "Invoice", "Order"];
// One dirty table among clean ones — the counter must single it out, not just
// report a global boolean.
const dirty = await countNullTenantRows(
  async (sql) => ({ rows: [{ n: sql.includes('"Invoice"') ? 3 : 0 }] }),
  TABLES,
);
const clean = await countNullTenantRows(async () => ({ rows: [{ n: 0 }] }), TABLES);
// A table whose tenantId column is missing entirely: the migration swallows that
// as a NOTICE, so the pre-flight has to treat "cannot check" as blocking.
const errored = await countNullTenantRows(async () => {
  throw new Error('column "tenantId" does not exist');
}, ["Widget"]);
console.log(
  "__RESULT__" +
    JSON.stringify({
      dirty: { exitCode: dirty.exitCode, results: dirty.results, report: formatReport(dirty.results) },
      clean: { exitCode: clean.exitCode, results: clean.results },
      errored: { exitCode: errored.exitCode, report: formatReport(errored.results) },
      policiedTables: loadPoliciedTables(),
    }),
);
`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  const marker = res.stdout.indexOf("__RESULT__");
  if (res.status !== 0 || marker === -1) {
    throw new Error(
      `driving rls-preflight.mjs failed (status ${res.status}):\n${res.stdout}\n${res.stderr}`,
    );
  }
  return JSON.parse(res.stdout.slice(marker + "__RESULT__".length));
}

describe("REG-G8c RLS arming pre-flight (R10 / T-G8c)", () => {
  it("REG-G8c: scripts/rls-preflight.mjs exists and is read-only", () => {
    expect(fs.existsSync(PREFLIGHT)).toBe(true);
    const src = fs.readFileSync(PREFLIGHT, "utf8");
    // Comments stripped first: the header legitimately *describes* `ALTER TABLE … FORCE ROW
    // LEVEL SECURITY`, and prose about a write is not a write.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    // This runs against PRODUCTION. Not one statement it can issue may write.
    expect(code).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|DROP\s+(TABLE|POLICY|INDEX))\b/i,
    );
    // …and it asks the server to enforce that too, before any check runs.
    expect(code).toMatch(/default_transaction_read_only\s*=\s*on/i);
  });

  it("REG-G8c: it counts NULL-tenantId rows per table and blocks when any policied table is dirty", () => {
    const { dirty, clean } = driveCounter();

    expect(dirty.exitCode).not.toBe(0);
    expect(dirty.results).toEqual([
      { table: "User", count: 0 },
      { table: "Invoice", count: 3 },
      { table: "Order", count: 0 },
    ]);
    // The report has to NAME the offending table — "something is dirty" is not
    // actionable at 2am in a merge window.
    expect(dirty.report).toContain("Invoice");
    expect(dirty.report).toContain("BLOCKS ARMING");

    // …and a clean database must not block, or the gate is just a permanent stop sign.
    expect(clean.exitCode).toBe(0);
    expect(clean.results.every((r) => r.count === 0)).toBe(true);
  });

  it("REG-G8c: a table it cannot check blocks arming, exactly like a dirty one", () => {
    const { errored } = driveCounter();
    expect(errored.exitCode).not.toBe(0);
    expect(errored.report).toContain("Widget");
    expect(errored.report).toContain("ERR");
  });

  it("REG-G8c: the table list comes from the migration itself, so it cannot drift from what is armed", () => {
    const { policiedTables } = driveCounter();
    const migrationSql = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "apps",
        "api",
        "prisma",
        "deferred-rls",
        "20260909000000_rls",
        "migration.sql",
      ),
      "utf8",
    );
    const armed = [
      ...migrationSql
        .match(/tables\s+TEXT\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]\s*;/)![1]
        .matchAll(/'([^']+)'/g),
    ].map((m) => m[1]);

    expect(policiedTables).toEqual(armed);
    expect(policiedTables.length).toBeGreaterThan(40);
  });
});
