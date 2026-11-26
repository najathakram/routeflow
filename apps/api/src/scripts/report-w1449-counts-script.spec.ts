import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * W-1449: the two owner-run READ-ONLY production count reports. Static pins on the script text (no
 * write or DDL statement, a READ ONLY transaction), spawned refusals that never connect, and the
 * output formatter fed fake rows to prove nothing identifying can reach stdout.
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPTS_DIR = path.join(API_DIR, "scripts");
const SCRIPTS = ["report-b1461-stale-draft-tax.mjs", "report-import-orphan-tenant-link.mjs"];
const SHARED = path.join(SCRIPTS_DIR, "lib", "count-report-shared.mjs");
const DEAD_URL = "postgresql://u:pw@127.0.0.1:1/nodb";

/** The script with comments removed, so prose cannot hide (or fake) a statement. */
function code(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function run(script: string, args: string[], databaseUrl: string | null) {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
  };
  if (databaseUrl) env.DATABASE_URL = databaseUrl;
  return spawnSync(process.execPath, [path.join(SCRIPTS_DIR, script), ...args], {
    encoding: "utf8",
    cwd: API_DIR,
    env: env as NodeJS.ProcessEnv,
  });
}

describe.each(SCRIPTS)("%s", (script) => {
  const files = [path.join(SCRIPTS_DIR, script), SHARED];

  it("contains no INSERT / UPDATE / DELETE / ALTER / CREATE / DROP / TRUNCATE statement text", () => {
    for (const f of files) {
      expect(code(f)).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|COPY)\b/i,
      );
    }
  });

  it("runs every query inside BEGIN READ ONLY, rolled back, and never COMMITs", () => {
    const src = code(path.join(SCRIPTS_DIR, script));
    const begin = src.indexOf('"BEGIN READ ONLY"');
    expect(begin).toBeGreaterThan(-1);
    expect(src).toContain("SET LOCAL statement_timeout");
    expect(src).toContain('"ROLLBACK"');
    expect(src).not.toMatch(/COMMIT/i);
    expect(src).not.toMatch(/default_transaction_read_only\s*=\s*off/i);
    // No query text runs before the transaction opens.
    expect(
      src.slice(src.indexOf("client.query(")).startsWith('client.query("BEGIN READ ONLY")'),
    ).toBe(true);
  });

  it("creates no temp table and reads no env other than the database settings", () => {
    const src = code(path.join(SCRIPTS_DIR, script));
    expect(src).not.toMatch(/\bINTO\b/i);
    expect(src).not.toMatch(/process\.env/);
  });

  it("--help explains what it counts, exits 0, and does not connect", () => {
    const res = run(script, ["--help"], DEAD_URL);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/READ ONLY, counts only/);
    expect(res.stdout).toMatch(/Counts/);
    expect(res.stderr).not.toMatch(/ECONNREFUSED/);
  });

  it("refuses with exit 2 when DATABASE_URL is missing, printing nothing on stdout", () => {
    const res = run(script, [], null);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("DATABASE_URL");
  });

  it("refuses unknown arguments with exit 2 before connecting", () => {
    const res = run(script, ["--apply"], DEAD_URL);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).not.toMatch(/ECONNREFUSED/);
  });
});

describe("count-report-shared output", () => {
  function shared(expr: string): string {
    const res = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import * as s from ${JSON.stringify("file:///" + SHARED.replace(/\\/g, "/"))}; ${expr}`,
      ],
      { encoding: "utf8", cwd: API_DIR },
    );
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    return res.stdout;
  }

  it("masks the host and drops user, password and database name", () => {
    const out = shared(
      `console.log(s.maskHost("postgresql://admin:s3cretpw@roundhouse.proxy.rlwy.net:12345/railway"))`,
    ).trim();
    expect(out).toBe("r***e.p***y.r***y.n***t:12345");
    expect(out).not.toMatch(/admin|s3cretpw|railway|roundhouse/);
  });

  it("buckets fake rows by opaque rank: no tenant id, slug or name can appear", () => {
    const fake = [
      { tenantId: "9f1c2e7a-0000-4000-8000-acme-slug-aaaa", n: 3 },
      { tenantId: "11111111-2222-4333-8444-globex-name-b", n: 7 },
      { tenantId: null, n: 2 },
      { tenantId: "5d5d5d5d-1111-4222-8333-initech-ccccc", n: 3 },
    ];
    const out = shared(
      `const b = s.toOpaqueBuckets(${JSON.stringify(fake)});` +
        `console.log(s.formatBuckets("per business", b)); console.log(JSON.stringify(b));`,
    );
    expect(out).toContain("no business link: 2");
    expect(out).toContain("business #1: 7");
    expect(out).toContain("business #2: 3");
    expect(out).toContain("business #3: 3");
    for (const leak of ["9f1c", "acme", "globex", "initech", "1111", "5d5d", "slug", "name"]) {
      expect(out).not.toContain(leak);
    }
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("prints 'none' for no rows", () => {
    const out = shared(`console.log(s.formatBuckets("x", s.toOpaqueBuckets([])))`);
    expect(out).toContain("none");
  });
});
