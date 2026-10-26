import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * SA-984 section 2 (D4) + SA-983 C1: the owner-run units fold-in readiness census. Script lane, no database.
 * Pinned by running the real script as a child process: its pure self-test, the argument and target guards (they must
 * refuse BEFORE a connection is attempted), the dist-missing refusal, and by source (read-only, ids and counts only).
 * The census SQL against real Postgres is units/report-units-fold-readiness.db.spec.ts.
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-units-fold-readiness.mjs");
const CLASSIFIER = path.resolve(API_DIR, "scripts/lib/pack-size-classifier.mjs");
const PROPOSE = path.resolve(API_DIR, "scripts/propose-pack-sizes.mjs");

// An unroutable host: if a guard ever fails to refuse first, the run errors loudly instead of reading anything.
const URL_FOR_GUARD = "postgresql://census:s3cret-pw@db.guard.invalid:5432/rf_census";

const cleanEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: "" };
  for (const k of [
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "RAILWAY_TCP_PROXY_DOMAIN",
    "RAILWAY_TCP_PROXY_PORT",
    "PROTECTED_TENANT_SLUGS",
  ])
    delete env[k];
  return { ...env, ...extra } as NodeJS.ProcessEnv;
};

const run = (args: string[], env: NodeJS.ProcessEnv = cleanEnv()) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: API_DIR, env });

/** Source with block and line comments blanked, so prose never counts. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

describe("report-units-fold-readiness (script lane)", () => {
  it("--self-test passes with no database and no dist", () => {
    const res = run(["--self-test"], cleanEnv({ UFR_DIST_DIR: "/nonexistent-dist-dir" }));
    expect(res.stderr).toBe("");
    expect(res.stdout.trim()).toBe("self-test ok");
    expect(res.status).toBe(0);
  });

  it.each(["--apply", "--fix", "--repair"])("refuses %s with exit 2 (no write mode)", (flag) => {
    const res = run([flag], cleanEnv({ DATABASE_URL: URL_FOR_GUARD }));
    expect(res.status).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toMatch(/read-only/);
  });

  it("exits 2 without connecting when no database url is configured", () => {
    const res = run([]);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("prints the host (never the password) and exits 64 when --target-host is missing", () => {
    const res = run([], cleanEnv({ DATABASE_URL: URL_FOR_GUARD }));
    expect(res.status).toBe(64);
    expect(res.stderr).toContain("db.guard.invalid");
    expect(res.stderr).not.toContain("s3cret-pw");
    expect(res.stdout).toBe("");
  });

  it("exits 65 when --target-host names another host", () => {
    const res = run(["--target-host=other.host"], cleanEnv({ DATABASE_URL: URL_FOR_GUARD }));
    expect(res.status).toBe(65);
    expect(res.stdout).toBe("");
  });

  it("exits 2 with a build instruction when dist is missing, before any connection", () => {
    const res = run(
      ["--target-host=db.guard.invalid"],
      cleanEnv({ DATABASE_URL: URL_FOR_GUARD, UFR_DIST_DIR: "/nonexistent-dist-dir" }),
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("npm run build -w apps/api");
    expect(res.stdout).toBe("");
    // never reached the connect: a refused connection would have said ENOTFOUND
    expect(res.stderr).not.toMatch(/ENOTFOUND|ECONNREFUSED/);
  });

  it("rejects an unknown argument and a malformed --tenant with exit 2", () => {
    expect(run(["--bogus"], cleanEnv({ DATABASE_URL: URL_FOR_GUARD })).status).toBe(2);
    expect(run(["--tenant"], cleanEnv({ DATABASE_URL: URL_FOR_GUARD })).status).toBe(2);
  });

  describe("source", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    const c = code(src);

    it("reads through the SA-839 read-only wrapper and the live-target guard helpers", () => {
      expect(c).toContain("withReadOnlyTx");
      expect(c).toContain("guardTarget");
      expect(c).toContain("targetOf");
      expect(c).toContain("resolveReportDbUrl");
      expect(c).toContain("protectedTenantIds");
      expect(c).toContain("loadProtectedSlugs");
    });

    it("main() itself calls the target guard and runs buildReport inside the read-only wrapper (not just selfTest)", () => {
      const main = c.slice(c.indexOf("async function main()"));
      expect(main).toMatch(/const guard = g\.guardTarget\(/);
      expect(main).toMatch(/await g\.withReadOnlyTx\(client, async \(\) => \{[\s\S]*buildReport\(/);
    });

    it("contains no write statement", () => {
      expect(c).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/);
      expect(c).not.toMatch(/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(/);
    });

    it("never re-derives the shared rules: it imports them", () => {
      expect(c).toMatch(/planTenantUnits/);
      expect(c).toMatch(/pack-size-classifier\.mjs/);
      expect(c).toMatch(/isOddTier/);
      expect(c).toMatch(/planBarcodeRows/);
      // no copy of the planner's, the classifier's or the odd-tier predicate's bodies
      expect(c).not.toMatch(/PACKISH_UNIT\s*=/);
      expect(c).not.toMatch(/Number\.isInteger\(n\) && n >= 1 && n <= 5/);
      expect(c).not.toMatch(/MAX_ACTIVE_TENANT_UNITS\s*=/);
    });

    it("prints no slug, name, product or document number", () => {
      expect(c).not.toMatch(/\.slug\b/);
      for (const m of c.matchAll(/console\.log\(([^;]*)\);/g)) {
        expect(m[1]).not.toMatch(/\.slug|\.name|businessName|orderNumber|invoiceNumber/);
      }
    });
  });
});

describe("pack-size-classifier (extracted from propose-pack-sizes.mjs)", () => {
  const probe = (expr: string) => {
    const res = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import * as m from ${JSON.stringify(CLASSIFIER)}; console.log(JSON.stringify(${expr}));`,
      ],
      { encoding: "utf8", cwd: API_DIR },
    );
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    return JSON.parse(res.stdout);
  };

  it("rates a counted name on a pack-ish unit HIGH and a counted name on a bare unit MEDIUM", () => {
    expect(probe(`m.classify({ name: "Cola 12CT", unit: "box" })`)).toMatchObject({
      confidence: "HIGH",
      packSize: 12,
    });
    expect(probe(`m.classify({ name: "Cola 12CT", unit: "" })`)).toMatchObject({
      confidence: "MEDIUM",
      packSize: 12,
    });
  });

  it("keeps the refusals: piece units, nested counts, uncounted pack-ish names, plain names", () => {
    expect(probe(`m.classify({ name: "Cola 12CT", unit: "each" })`).confidence).toBe("PIECE_UNIT");
    expect(probe(`m.classify({ name: "Gum 5CT - 12Pack", unit: "box" })`).confidence).toBe(
      "AMBIGUOUS",
    );
    expect(probe(`m.classify({ name: "Cola", unit: "box" })`).confidence).toBe("LOW");
    expect(probe(`m.classify({ name: "Cola", unit: "" })`)).toBeNull();
  });

  it("parsePackSizeDetailed is exported from the lib", () => {
    expect(probe(`m.parsePackSizeDetailed("24 PK")`)).toEqual({ packSize: 24, counts: [24] });
  });

  it("propose-pack-sizes.mjs imports the lib and carries no copy of the classifier", () => {
    const c = code(fs.readFileSync(PROPOSE, "utf8"));
    expect(c).toMatch(/pack-size-classifier\.mjs/);
    expect(c).not.toMatch(/function classify\s*\(/);
    expect(c).not.toMatch(/function parsePackSizeDetailed\s*\(/);
    expect(c).not.toMatch(/PACKISH_UNIT\s*=/);
    expect(c).not.toMatch(/PIECE_UNIT\s*=/);
  });
});
