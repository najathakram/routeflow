import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// TP1 — apps/api/scripts/report-train4-damage.mjs structural + CLI contract (T1-T5, R2 + R5).
//
// Read-only forensic report for the train-4 fixes (B134 B135 B214 B215 B216 B131 B141). Its
// source must carry no write-capable SQL keyword and no write-mode flag, its FIRST query must
// force a read-only session, and its CLI must reject any unknown flag before it ever resolves a
// connection string. Modeled on report-addon-gate-blast-radius-script.spec.ts's codeLines()/
// spawnSync pattern and prod-migrate-script.spec.ts's scrubbed-env CLI-contract style.

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-train4-damage.mjs");

function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DATABASE_URL;
  for (const key of Object.keys(env)) {
    if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

/**
 * The script's non-comment lines — a claim in a comment must never satisfy a source pin.
 *
 * Only lines that START with `//`, `*` or `/*` are dropped, so prose INSIDE a string or template
 * literal (a usage banner mentioning `--execute`, a printed caveat containing the word DELETE)
 * still counts as code and will fail T1/T3. That errs strict — it can never produce a false pass
 * — so a red here may be wording in help text rather than a real write path: reword the banner.
 */
function codeLines(): string[] {
  // A missing script must fail as an assertion, not as a thrown ENOENT.
  expect(fs.existsSync(SCRIPT)).toBe(true);
  return fs
    .readFileSync(SCRIPT, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== "" && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"),
    );
}

function run(env: NodeJS.ProcessEnv, args: string[] = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}

describe("report-train4-damage.mjs contract (TP1)", () => {
  it("TDR-T1 no write-capable SQL keyword appears in any non-comment line", () => {
    const code = codeLines().join("\n");

    const found = code.match(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
    expect(found).toBeNull();
  });

  it("TDR-T2 read-only session is set as the FIRST query, before every other query", () => {
    const code = codeLines().join("\n");

    expect(code).toContain("SET default_transaction_read_only = on");

    const queryIndices: number[] = [];
    const pattern = /\.query\(/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      queryIndices.push(match.index);
    }

    // At least the read-only SET itself, plus one more real query, must exist as `.query(`
    // calls — otherwise this assertion would vacuously pass on a file with a single query.
    expect(queryIndices.length).toBeGreaterThan(1);

    const readOnlySetIndex = code.indexOf("SET default_transaction_read_only = on");
    // The `.query(` call that carries the read-only SET is the one closest to it, scanning
    // backwards from the SET text to the nearest preceding `.query(`.
    const precedingQueryIndices = queryIndices.filter((idx) => idx <= readOnlySetIndex);
    // The read-only SET must sit inside a `.query(` call, not in a constant declared above them:
    // with no preceding `.query(`, `Math.max(...[])` is `-Infinity` and every `toBeLessThan`
    // below would pass without proving anything about ordering.
    expect(precedingQueryIndices.length).toBeGreaterThan(0);
    const ownQueryIndex = Math.max(...precedingQueryIndices);
    const otherQueryIndices = queryIndices.filter((idx) => idx !== ownQueryIndex);

    // NOTE: this pins SOURCE order of `.query(` occurrences, not execution order — a helper
    // defined lower in the file but invoked first would still satisfy it. TDR-T14 (DB-side
    // snapshot equality over every seeded table) is the real read-only proof; T2 is a cheap
    // structural guard on top of it.

    expect(otherQueryIndices.length).toBeGreaterThan(0);
    for (const idx of otherQueryIndices) {
      expect(ownQueryIndex).toBeLessThan(idx);
    }
  });

  it("TDR-T3 no write-mode flag is declared in source", () => {
    const code = codeLines().join("\n");

    for (const flag of ["--execute", "--live", "--apply", "--fix", "--repair"]) {
      expect(code).not.toContain(flag);
    }
  });

  it("TDR-T4 an unknown flag exits 2 before any connection is attempted", () => {
    // A reachable-shaped but unusable connection string: if the script connected before
    // validating flags, it would fail with ECONNREFUSED and exit 1 instead of exiting 2 for
    // the unknown flag.
    const res = run(scrubbedEnv({ DATABASE_URL: "postgresql://x:y@127.0.0.1:1/none" }), [
      "--execute",
    ]);

    // The script's OWN unknown-flag message first: no other failure mode (a missing module, a
    // connection error) can print it, so a red here always names the flag-parsing oracle.
    expect(res.stderr).toContain("Unknown flag: --execute");
    expect(res.status).toBe(2);
    expect(res.stderr).not.toMatch(/ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i);
  });

  it("TDR-T5 no connection string exits 1 naming the failure", () => {
    const res = run(scrubbedEnv());

    // The oracle first, the "did the script even load" guard after it, so a red reports the
    // missing-connection-string contract rather than the guard.
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/No usable connection string/i);
    expect(res.stderr).not.toContain("Cannot find module");
  });
});
