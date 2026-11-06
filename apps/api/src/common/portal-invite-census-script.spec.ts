import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Row 633 / SA-820 S1 — contract for the read-only portal-invite census
 * (`apps/api/scripts/report-portal-invite-census.mjs`) and the owner-run rotation
 * (`apps/api/scripts/rotate-portal-invites.mjs`), both built on `scripts/lib/portal-invite-census.mjs`.
 *
 * No database is touched here: the scripts' own `--self-test` runs, the refusals that happen before any
 * connection are exercised, and the source is pinned for the properties that must never regress (the census
 * only reads, neither script ever selects, prints or stores the invite code, and the rotation has no
 * "every tenant" mode). The sibling `portal-invite-census.db.spec.ts` runs both against a real Postgres.
 */

const API_DIR = path.resolve(__dirname, "../..");
const CENSUS = path.resolve(API_DIR, "scripts/report-portal-invite-census.mjs");
const ROTATE = path.resolve(API_DIR, "scripts/rotate-portal-invites.mjs");
const LIB = path.resolve(API_DIR, "scripts/lib/portal-invite-census.mjs");
const TENANT = "11111111-1111-4111-8111-111111111111";

function run(script: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

/** The ambient environment with every database setting removed: nothing to connect to. */
function noDbEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(DATABASE_|PG|RAILWAY_)/i.test(k)) delete env[k];
  }
  return env;
}

/** The file with its comments removed, so a sentence about a statement is not mistaken for one. */
const read = (p: string) =>
  readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("report-portal-invite-census.mjs", () => {
  it("self-test passes", () => {
    const r = run(CENSUS, ["--self-test"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/self-test ok/);
  });

  it("with no database configured it exits 2 without connecting", () => {
    const r = run(CENSUS, ["--json"], noDbEnv());
    expect(r.code).toBe(2);
  });

  it("only reads: SELECT statements, a read-only session, and no write verb in its source", () => {
    const src = read(CENSUS) + read(LIB);
    expect(src).toMatch(/SET default_transaction_read_only = on/);
    expect(src).not.toMatch(
      /(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE|ALTER\s+TABLE|DROP\s+TABLE) "/,
    );
  });
});

describe("rotate-portal-invites.mjs", () => {
  it("self-test passes", () => {
    const r = run(ROTATE, ["--self-test"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/self-test: all passed/);
  });

  it("refuses to run with no tenant named (there is no all-tenants mode)", () => {
    for (const args of [[], ["--apply"], ["--local"]]) {
      const r = run(ROTATE, args, noDbEnv());
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/name at least one tenant/);
    }
  });

  it("the dry run is a READ ONLY transaction that never calls the write", () => {
    const src = read(ROTATE);
    const start = src.indexOf("async function dryRun(");
    const body = src.slice(start, src.indexOf("\nfunction verifyGuardSha", start));
    expect(body.length).toBeGreaterThan(200); // not vacuous: the function was found
    expect(body).toMatch(/BEGIN TRANSACTION READ ONLY/);
    expect(body).not.toMatch(/ROTATE_SQL|UPDATE "|COMMIT/);
  });

  it("refuses two tenants in one run: one tenant, one yes (SA-820 A-2)", () => {
    const OTHER = "22222222-2222-4222-8222-222222222222";
    for (const args of [
      ["--tenant", TENANT, "--tenant", OTHER],
      ["--apply", "--tenant", TENANT, "--tenant", OTHER],
    ]) {
      const r = run(ROTATE, args, noDbEnv());
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/one tenant per run/);
    }
  });

  it("the same tenant named twice is still one tenant", () => {
    const r = run(ROTATE, ["--tenant", TENANT, "--tenant", TENANT.toUpperCase()], noDbEnv());
    expect(r.out).not.toMatch(/one tenant per run/);
  });

  it("refuses a slug where a tenant UUID is needed", () => {
    const r = run(ROTATE, ["--tenant", "acme"], noDbEnv());
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/needs a tenant UUID/);
  });

  it("an apply without its plan, hash, guard sha and backup attestation is refused before any connection", () => {
    const base = ["--apply", "--tenant", TENANT];
    for (const extra of [
      [],
      ["--plan", "p.json"],
      ["--plan", "p.json", "--confirm-plan", "abc"],
      ["--plan", "p.json", "--confirm-plan", "abc", "--guard-sha", "abc"],
    ]) {
      const r = run(ROTATE, [...base, ...extra], noDbEnv());
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/--apply needs --plan, --confirm-plan, --guard-sha and --backup-taken/);
    }
  });
});

describe("the invite code never leaves the database", () => {
  const sources = { census: read(CENSUS), rotate: read(ROTATE), lib: read(LIB) };

  it("neither script prints, logs or saves the stored code", () => {
    for (const [name, src] of Object.entries(sources)) {
      expect({
        name,
        hit: /console\.(log|error|warn)\([^;]*inviteToken(?!Hash)/.test(src),
      }).toEqual({
        name,
        hit: false,
      });
    }
  });

  it("the census SQL returns the code only as its SHA-256", () => {
    const sql = /RECORDED_INVITES_SQL = `([\s\S]*?)`;/.exec(sources.lib)?.[1] ?? "";
    expect(sql).toMatch(/sha256\(convert_to\(l\."inviteToken"/);
    const list = sql.slice(sql.indexOf("SELECT l.id"), sql.indexOf("FROM"));
    expect(
      list.replace(/encode\(sha256\(convert_to\(l\."inviteToken", 'UTF8'\)\), 'hex'\)/, ""),
    ).not.toMatch(/inviteToken/);
  });

  it("the rotation reads its candidates from the census's own query, so the two always agree", () => {
    expect(sources.rotate).toMatch(
      /RECORDED_INVITES_SQL[\s\S]*from "\.\/lib\/portal-invite-census\.mjs"/,
    );
    expect(sources.rotate).toMatch(/client\.query\(RECORDED_INVITES_SQL\)/);
  });

  it("the rotation's only write clears the code and expiry, and nothing else", () => {
    const writes = sources.rotate.match(/\bUPDATE "[A-Za-z]+"/g) ?? [];
    expect([...new Set(writes)]).toEqual(['UPDATE "CustomerLink"']);
    expect(sources.rotate).not.toMatch(/(DELETE FROM|INSERT INTO|TRUNCATE|DROP\s+TABLE) "/);
    expect(sources.rotate).not.toMatch(/UPDATE "AuditLog"/);
  });
});
