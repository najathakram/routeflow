import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// T1 (R2, R3) — scripts/lint-migrations.mjs contract (item 3B, destructive-migration lint).
//
// The script does not exist yet on this branch, so every case here drives a real spawnSync
// and fails on the process's own observable contract (exit status, stdout/stderr content)
// rather than on an import. Mirrors the schema-drift-script.spec.ts pattern: node launches
// fine even when the entry module is missing — it exits 1 with MODULE_NOT_FOUND on stderr
// (verified: status 1, not null, on this tree) — so content oracles are asserted before the
// exit status wherever a bare status check could be satisfied by the script simply not
// existing yet.

const SCRIPT = path.resolve(__dirname, "../../../../scripts/lint-migrations.mjs");
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function run(args: string[], cwd?: string) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd });
}

describe("lint-migrations.mjs contract (T1 / R2, R3)", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-migrations-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeFixture(name: string, sql: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, sql);
    return file;
  }

  it("T1(a): a clean, non-destructive migration file exits 0", () => {
    const file = writeFixture("clean.sql", 'ALTER TABLE "T" ADD COLUMN "c" TEXT;\n');

    const res = run(["--files", file]);

    // The contract oracle comes first so the red gate fails on it (exit 0 is not a status a
    // missing script can produce); the guard below still forbids a crashing script from ever
    // masquerading as "the linter correctly found nothing wrong".
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain("Cannot find module");
  });

  it("T1(b): a drop-column + not-null-add migration exits 1, names both destructive rules, and stays silent on an excluded lock-hygiene rule the same file would also trigger", () => {
    const file = writeFixture(
      "bad.sql",
      [
        'ALTER TABLE "T" DROP COLUMN "c";',
        'ALTER TABLE "T" ADD COLUMN y text NOT NULL;',
        'CREATE INDEX i ON "T"(a);',
        "",
      ].join("\n"),
    );

    const res = run(["--files", file]);

    // Anti-masking guard first — without it every oracle below could be satisfied by the
    // empty stdout of a missing or crashing script rather than by the linter's own output.
    expect(res.stderr).not.toContain("Cannot find module");
    // Content oracles next — the exit status alone cannot distinguish "the exclusion list
    // works" from "nothing ran at all".
    expect(res.stdout).toContain("ban-drop-column");
    expect(res.stdout).toContain("adding-required-field");
    expect(res.stdout).not.toContain("require-concurrent-index-creation");
    expect(res.status).toBe(1);
  });

  it("T1(c): a reasoned squawk-ignore above the destructive line silences that rule and exits 0", () => {
    const file = writeFixture(
      "reasoned.sql",
      [
        "-- reason: column unused since #123",
        "-- squawk-ignore ban-drop-column",
        'ALTER TABLE "T" DROP COLUMN "c";',
        "",
      ].join("\n"),
    );

    const res = run(["--files", file]);

    // Status first (the real oracle: the reasoned ignore makes this file clean), then the
    // anti-masking guard — without it the `not.toContain` below would pass vacuously on the
    // empty stdout of a missing or crashing script.
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.stdout).not.toContain("ban-drop-column");
  });

  it("T1(d): a squawk-ignore with no reason line above it exits 1 with the reason-rule message naming the file and line", () => {
    const file = writeFixture(
      "unreasoned.sql",
      ["-- squawk-ignore ban-drop-column", 'ALTER TABLE "T" DROP COLUMN "c";', ""].join("\n"),
    );

    const res = run(["--files", file]);

    // Anti-masking guard first: `combined` folds in stderr, so a MODULE_NOT_FOUND trace
    // could otherwise be the string these content oracles are read against.
    expect(res.stderr).not.toContain("Cannot find module");
    const combined = res.stdout + res.stderr;
    expect(combined).toContain(`${file}:1`);
    expect(combined).toContain('squawk-ignore without a "-- reason:" line above it');
    expect(res.status).toBe(1);
  });

  it("T1(e): --files with no paths prints the no-migrations message and exits 0", () => {
    const res = run(["--files"]);

    // Anti-masking guard first — an absent script also produces empty stdout.
    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.stdout).toContain("no migrations");
    expect(res.status).toBe(0);
  });

  it("T1(f): --base with an unresolvable ref fails closed — exit 2, names the ref, never claims a clean range", () => {
    const res = run(["--base", "does-not-exist-ref"]);

    // Content oracles first: the whole point is that this must NOT be mistakable for the
    // healthy "this PR adds no migrations" run that T1(e) pins.
    expect(res.stderr).toContain("could not resolve range");
    expect(res.stderr).toContain("does-not-exist-ref");
    expect(res.stdout).not.toContain("no migrations in range");
    expect(res.status).toBe(2);
  });

  it("T1(g): --all is cwd-independent — run from apps/api it still finds the migrations", () => {
    const res = run(["--all"], path.join(REPO_ROOT, "apps/api"));

    expect(res.stdout).not.toContain("no migrations in range");
    expect(res.stdout).toContain("lint:migrations --all:");
    expect(res.status).toBe(0);
  });
});
