import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * SA-619 PR-2a (case 9): apps/api/scripts/report-619-superadmin-creates.mjs, the READ-ONLY, COUNT-ONLY
 * blast-radius report for the enforce flip: how many rows each nullable-tenant model holds with a NULL
 * tenantId (the rows a SUPER_ADMIN / context-less create wrote), and how many of those are recent. No ids,
 * no tenant names, no values. The model list is derived from the Prisma schema, never hand-typed.
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-619-superadmin-creates.mjs");
const SCHEMA_DIR = path.resolve(API_DIR, "prisma/schema");

/**
 * The script is an ES module and ts-jest compiles CommonJS, so its exports are exercised the way the other
 * report specs exercise their scripts: in a spawned node process (args in, JSON out; a throw is a non-zero exit).
 */
// The arguments travel on STDIN, never argv: the schema text is ~hundreds of KB, and Linux caps ONE argv
// string at 128 KiB (MAX_ARG_STRLEN), so a CI runner fails the spawn with E2BIG, status null and an EMPTY
// stderr, while macOS (a far larger limit) passes.
function callExport(fn: string, ...args: unknown[]): unknown {
  const code = `import { readFileSync } from "node:fs";
  import(${JSON.stringify(pathToFileURL(SCRIPT).href)}).then((m) => {
    const out = m[${JSON.stringify(fn)}](...JSON.parse(readFileSync(0, "utf8")));
    process.stdout.write(JSON.stringify(out === undefined ? null : out));
  }).catch((e) => { process.stderr.write(String(e.message)); process.exit(3); });`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: API_DIR,
    input: JSON.stringify(args),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0)
    throw new Error(
      `export ${fn} failed: status=${res.status} signal=${res.signal} error=${res.error?.message ?? "none"}\n` +
        `stderr: ${res.stderr}\nstdout: ${String(res.stdout).slice(0, 500)}`,
    );
  return JSON.parse(res.stdout);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod: Record<string, (...a: any[]) => any> = {
  nullableTenantModels: (t: string) => callExport("nullableTenantModels", t),
  loadSchemaText: (d: string) => callExport("loadSchemaText", d),
  buildReportSql: (m: unknown) => callExport("buildReportSql", m),
  assertReadOnlySql: (q: string) => callExport("assertReadOnlySql", q),
  formatReport: (r: unknown) => callExport("formatReport", r),
  buildModelSql: (m: unknown) => callExport("buildModelSql", m),
};

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.DATABASE_URL;
  for (const k of Object.keys(e)) if (k.startsWith("RAILWAY_")) delete e[k];
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    env: { ...e, ...env } as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
}

describe("nullableTenantModels (derived from the schema)", () => {
  it("finds models whose tenantId is nullable, with whether they have a createdAt", () => {
    const text = `
model A {
  id        String   @id
  tenantId  String?
  createdAt DateTime @default(now())
}
model B {
  id       String @id
  tenantId String
}
model C {
  id       String  @id
  tenantId String?
}
model D {
  id String @id
}
`;
    expect(mod.nullableTenantModels(text)).toEqual([
      { model: "A", hasCreatedAt: true },
      { model: "C", hasCreatedAt: false },
    ]);
  });

  it("on the real schema it includes the platform-capable models the flip must not break", () => {
    const names = mod.nullableTenantModels(mod.loadSchemaText(SCHEMA_DIR)).map((m: any) => m.model);
    for (const m of ["User", "AuditLog", "RefreshToken", "DeviceToken", "Customer", "Invoice"])
      expect(names).toContain(m);
    expect(names).not.toContain("Tenant");
    expect(names.length).toBeGreaterThan(40);
  });
});

describe("buildReportSql / assertReadOnlySql", () => {
  const models = [
    { model: "User", hasCreatedAt: true },
    { model: "PaymentCounter", hasCreatedAt: false },
  ];

  it("is ONE read-only statement: SELECT ... UNION ALL, quoted identifiers, counts only", () => {
    const sql: string = mod.buildReportSql(models);
    expect(() => mod.assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain('FROM "User"');
    expect(sql).toContain('FROM "PaymentCounter"');
    expect(sql.match(/UNION ALL/g)).toHaveLength(1);
    expect(sql).toMatch(/"tenantId" IS NULL/);
    // a model with no createdAt reports NULL for the recent column instead of referencing a column that is not there
    const pc = sql.split("UNION ALL")[1];
    expect(pc).not.toContain('"createdAt"');
    // never selects row data
    expect(sql).not.toMatch(/SELECT\s+(\*|"id"|id\b)/i);
    expect(sql).not.toMatch(/\$\d/); // no parameters: nothing user-supplied reaches the SQL
  });

  it.each([
    'INSERT INTO "User" VALUES (1)',
    'UPDATE "User" SET x = 1',
    'DELETE FROM "User"',
    'TRUNCATE "User"',
    'DROP TABLE "User"',
    'ALTER TABLE "User" ADD COLUMN x int',
    "CREATE TABLE t (a int)",
    "GRANT ALL ON x TO y",
    "COPY x TO '/tmp/y'",
    "SELECT 1; SELECT 2",
  ])("assertReadOnlySql refuses: %s", (sql) => {
    expect(() => mod.assertReadOnlySql(sql)).toThrow();
  });

  it("every model name is checked as a plain identifier before it reaches SQL", () => {
    expect(() =>
      mod.buildReportSql([{ model: 'X"; DROP TABLE "User', hasCreatedAt: false }]),
    ).toThrow(/identifier/i);
  });
});

describe("the script (spawned)", () => {
  it("--print-sql prints the SQL without connecting and exits 0", () => {
    const res = run(["--print-sql"]);
    expect(res.status).toBe(0);
    expect(() => mod.assertReadOnlySql(res.stdout.trim().replace(/;\s*$/, ""))).not.toThrow();
    expect(res.stdout).toContain('"tenantId" IS NULL');
  });

  it("--self-test exits 0", () => {
    const res = run(["--self-test"]);
    expect(res.stderr + res.stdout).toMatch(/self-test/i);
    expect(res.status).toBe(0);
  });

  it("fails closed (non-zero, names DATABASE_URL) when no database is configured, before any connection", () => {
    const res = run([]);
    expect(res.status).not.toBe(0);
    expect(res.stdout + res.stderr).toContain("DATABASE_URL");
  });

  it("opens a READ ONLY session and never carries a write keyword in its executable source", () => {
    const code = fs
      .readFileSync(SCRIPT, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"))
      .join("\n");
    expect(code).toContain("default_transaction_read_only = on");
    expect(code).toContain("ROLLBACK");
    // the only write keywords allowed are inside the refusal list's regex, never as a statement
    // (the refusal list and the self-test's deliberately bad examples are strings fed to the guard, never run)
    const withoutGuard = code
      .replace(/export function assertReadOnlySql[\s\S]*?\n}\n/, "")
      .replace(/function selfTest\(\)[\s\S]*?\n}\n/, "");
    expect(withoutGuard).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|TRUNCATE\s)/i);
  });

  it("each model is queried on its own inside a savepoint with its own timeout, so one slow table never loses the report", () => {
    const sql: string = mod.buildModelSql({ model: "User", hasCreatedAt: true });
    expect(() => mod.assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain('FROM "User"');
    expect(sql).not.toContain("UNION");
    const code = fs.readFileSync(SCRIPT, "utf8");
    expect(code).toContain("SAVEPOINT");
    expect(code).toContain("ROLLBACK TO SAVEPOINT");
    expect(code).toMatch(/statement_timeout/);
  });

  it("the report says NULL includes deliberate platform rows (explicit tenantId: null is not refused by the flip)", () => {
    const text: string = mod.formatReport([
      { model: "User", null_tenant: 3, null_30d: 1, total: 10 },
    ]);
    expect(text).toMatch(/deliberate platform rows/i);
  });

  it("formatReport shows model names and numbers only", () => {
    const text: string = mod.formatReport([
      { model: "User", null_tenant: 3, null_30d: 1, total: 10 },
      { model: "Customer", null_tenant: 0, null_30d: 0, total: 5 },
    ]);
    expect(text).toContain("User");
    expect(text).toContain("3");
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // never an id
  });
});
